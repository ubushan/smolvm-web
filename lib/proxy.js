'use strict';
// Corporate proxy and CA support: detection, guest-reachable URLs, env, CA bundle.

const fs = require('fs');
const net = require('net');
const tls = require('tls');
const dgram = require('dgram');
const crypto = require('crypto');
const { execFile } = require('child_process');

const GUEST_TRUST_DIR = '/etc/smolvm-host-trust';
const GUEST_BUNDLE = `${GUEST_TRUST_DIR}/ca-bundle.pem`;
const GUEST_NO_PROXY = ['localhost', '127.0.0.1', '::1'];
// Same variables smolvm's own --trust-host-certs sets.
const TRUST_VARS = ['SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS',
  'GIT_SSL_CAINFO', 'PIP_CERT', 'AWS_CA_BUNDLE', 'CARGO_HTTP_CAINFO', 'DENO_CERT'];

const run = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 5000, windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout)));
});

function normalizeUrl(u) {
  u = String(u || '').trim();
  if (!u) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = `http://${u}`;
  return u.replace(/\/+$/, '');
}

function splitList(s) {
  return String(s || '').split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
}

// ---------- detection ----------
async function detect() {
  const env = process.env;
  const fromEnv = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy;
  if (fromEnv) {
    return { url: normalizeUrl(fromEnv), noProxy: env.NO_PROXY || env.no_proxy || '', source: 'переменные окружения (HTTPS_PROXY/HTTP_PROXY)' };
  }
  if (process.platform === 'win32') return detectWindows();
  if (process.platform === 'darwin') return detectMac();
  return { url: '', noProxy: '', source: 'не найден', note: 'Прокси не задан в окружении (HTTPS_PROXY / HTTP_PROXY).' };
}

async function detectWindows() {
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
  const out = await run('reg', ['query', key]);
  const val = (name) => (out.match(new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.*)$`, 'mi')) || [])[1]?.trim();
  const enabled = /^0x0*1$/i.test(val('ProxyEnable') || '');
  const server = val('ProxyServer');
  const pac = val('AutoConfigURL');
  if (enabled && server) {
    // "host:port" or "http=host:port;https=host:port;..."
    let hp = server;
    if (server.includes('=')) {
      const map = Object.fromEntries(server.split(';').map((p) => p.split('=').map((x) => x.trim())));
      hp = map.https || map.http || Object.values(map)[0];
    }
    const noProxy = splitList((val('ProxyOverride') || '').replace(/<local>/gi, '')).join(',');
    return { url: normalizeUrl(hp), noProxy, source: 'системные настройки Windows (Internet Settings)' };
  }
  if (pac) return { url: '', noProxy: '', source: 'PAC', note: `Используется PAC-файл (${pac}); укажите адрес прокси вручную.` };
  return { url: '', noProxy: '', source: 'не найден', note: 'Системный прокси Windows выключен.' };
}

async function detectMac() {
  const out = await run('scutil', ['--proxy']);
  const get = (k) => (out.match(new RegExp(`\\b${k}\\s*:\\s*(\\S+)`)) || [])[1];
  let url = '';
  if (get('HTTPSEnable') === '1' && get('HTTPSProxy')) url = `http://${get('HTTPSProxy')}:${get('HTTPSPort') || 443}`;
  else if (get('HTTPEnable') === '1' && get('HTTPProxy')) url = `http://${get('HTTPProxy')}:${get('HTTPPort') || 80}`;
  const ex = out.match(/ExceptionsList\s*:\s*<array>\s*\{([^}]*)\}/);
  const noProxy = ex ? ex[1].split('\n').map((l) => l.replace(/^\s*\d+\s*:\s*/, '').trim()).filter(Boolean).join(',') : '';
  if (url) return { url, noProxy, source: 'системные настройки macOS' };
  if (get('ProxyAutoConfigEnable') === '1') return { url: '', noProxy: '', source: 'PAC', note: 'Используется PAC-файл; укажите адрес прокси вручную.' };
  return { url: '', noProxy: '', source: 'не найден', note: 'Системный прокси macOS выключен.' };
}

// ---------- guest-reachable URL ----------
function hostOutboundIp() {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.on('error', () => { s.close(); resolve(null); });
    // A connected UDP socket consults the routing table without sending anything.
    s.connect(80, '8.8.8.8', () => {
      let ip = null;
      try { ip = s.address().address; } catch {}
      s.close();
      resolve(ip);
    });
  });
}

function isLoopback(host) {
  host = host.replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || /^127\./.test(host);
}

// Inside a machine "localhost" is the machine itself, so a proxy on the host's
// loopback (cntlm, px, ...) is rewritten to the host's outbound address.
async function guestUrl(raw) {
  const url = normalizeUrl(raw);
  if (!url) return { url: '', rewritten: false };
  let u;
  try { u = new URL(url); } catch { return { url, rewritten: false, error: 'Некорректный URL прокси' }; }
  if (!isLoopback(u.hostname)) return { url, rewritten: false };
  const ip = await hostOutboundIp();
  if (!ip) return { url, rewritten: false, error: 'Прокси на localhost хоста, но не удалось определить адрес хоста, доступный из машины' };
  u.hostname = ip;
  return {
    url: u.toString().replace(/\/+$/, ''), rewritten: true,
    warning: `Прокси на localhost хоста переписан на ${ip}. Он должен слушать этот интерфейс (cntlm: "Gateway yes", px: --gateway), иначе машина не подключится.`,
  };
}

function noProxyList(s) {
  const list = splitList(s);
  for (const h of GUEST_NO_PROXY) if (!list.includes(h)) list.push(h);
  return list.join(',');
}

function proxyEnv(url, noProxy) {
  const env = [];
  const both = (k, v) => { env.push({ name: k, value: v }, { name: k.toLowerCase(), value: v }); };
  both('HTTP_PROXY', url);
  both('HTTPS_PROXY', url);
  both('NO_PROXY', noProxyList(noProxy));
  return env;
}

function trustEnv() {
  return TRUST_VARS.map((name) => ({ name, value: GUEST_BUNDLE }));
}

// Merge env entries; existing names (set explicitly by the caller) win.
function mergeEnv(existing, extra) {
  const list = Array.isArray(existing) ? existing.slice() : [];
  const have = new Set(list.map((e) => e && e.name));
  for (const e of extra) if (!have.has(e.name)) list.push(e);
  return list;
}

// ---------- CA bundle ----------
function splitPem(text) {
  return String(text || '').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
}

function userPem(pem) {
  const t = String(pem || '').trim();
  if (!t) return [];
  if (t.includes('-----BEGIN')) return splitPem(t);
  // Treat as a file path on the host.
  const data = fs.readFileSync(t);
  const text = data.toString('utf8');
  if (text.includes('-----BEGIN')) return splitPem(text);
  // DER (.cer/.crt in binary form) -> PEM
  const b64 = data.toString('base64').match(/.{1,64}/g).join('\n');
  return [`-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----`];
}

function systemCerts() {
  try {
    if (typeof tls.getCACertificates === 'function') return tls.getCACertificates('system');
  } catch {}
  return [];
}

// Public roots (Mozilla, bundled with Node) + host system store + user-provided certs.
function buildBundle(ca) {
  const user = userPem(ca.pem);
  const system = ca.system ? systemCerts() : [];
  const seen = new Set();
  const out = [];
  for (const c of [...tls.rootCertificates, ...system, ...user]) {
    const key = c.replace(/\s+/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c.trim());
  }
  return { pem: `${out.join('\n')}\n`, count: out.length, user: user.length, system: system.length };
}

function fingerprint(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 16);
}

// ---------- test ----------
// CONNECT through the proxy from the host and report the status line.
function testConnect(proxyUrl, target = 'pypi.org:443', timeoutMs = 8000) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(normalizeUrl(proxyUrl)); } catch { return resolve({ ok: false, target, error: 'Некорректный URL' }); }
    const started = Date.now();
    const sock = net.connect(Number(u.port) || 80, u.hostname.replace(/^\[|\]$/g, ''));
    const done = (r) => { sock.destroy(); resolve({ target, ms: Date.now() - started, ...r }); };
    sock.setTimeout(timeoutMs, () => done({ ok: false, error: 'таймаут' }));
    sock.on('error', (e) => done({ ok: false, error: e.code || e.message }));
    sock.on('connect', () => {
      let auth = '';
      if (u.username) {
        const cred = Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64');
        auth = `Proxy-Authorization: Basic ${cred}\r\n`;
      }
      sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`);
    });
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      const line = buf.split('\r\n')[0];
      if (buf.includes('\r\n')) {
        const code = Number((line.match(/^HTTP\/\d\.\d\s+(\d+)/) || [])[1]);
        done({ ok: code >= 200 && code < 300, status: line, code });
      }
    });
  });
}

module.exports = {
  hostIp: hostOutboundIp,
  GUEST_TRUST_DIR, GUEST_BUNDLE, detect, guestUrl, proxyEnv, trustEnv, mergeEnv,
  noProxyList, buildBundle, fingerprint, testConnect, normalizeUrl,
};
