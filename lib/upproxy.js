'use strict';
// How smolvm-web reaches the corporate proxy (egress filter, proxy relay,
// secret gateway, host downloads):
//  - which proxy: the one in the settings, or — with "Системный прокси Windows" —
//    the Windows system proxy / PAC, per destination;
//  - authentication: Basic from the URL. Kerberos / NTLM is not done here (it took a
//    PowerShell helper that antivirus behaviour engines read as credential theft):
//    for such a proxy run proxydetox (or px) and point smolvm-web at it.

const net = require('net');
const cfg = require('./config');
const px = require('./proxy');
const sysproxy = require('./sysproxy');

function settings() { return cfg.getSettings().proxy; }

// Is a corporate proxy in use at all? (p: proxy settings, the saved ones by default)
function active(p = settings()) {
  return !!(p.enabled && (p.url || (p.system && process.platform === 'win32')));
}

function systemMode(p = settings()) {
  return !!(p.enabled && p.system && process.platform === 'win32');
}

// The proxy for a destination URL: "http://proxy:port" (maybe with user:pass@) or null.
async function routeFor(url, p = settings()) {
  if (!p.enabled) return null;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (px.bypassesProxy(host, p.noProxy)) return null;
  if (systemMode(p)) return sysproxy.proxyFor(url);
  return p.url ? px.normalizeUrl(p.url) : null;
}

function basicFor(u) {
  return u.username ? `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')}` : null;
}

// Which integrated scheme a proxy asked for, from its Proxy-Authenticate headers.
function integratedScheme(headers) {
  const list = headers.filter(([k]) => k === 'proxy-authenticate').map(([, v]) => v);
  if (list.some((v) => /^negotiate\b/i.test(v))) return 'Negotiate';
  if (list.some((v) => /^ntlm\b/i.test(v))) return 'NTLM';
  return null;
}

// What to tell the user when a proxy wants Windows sign-in.
const INTEGRATED_HINT = 'войдите в прокси через proxydetox (или px): запустите его на этом компьютере и укажите его адрес, например http://127.0.0.1:3128, в «Настройки» → «Прокси»';

function connectTcp(host, port, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port });
    const t = setTimeout(() => s.destroy(new Error('таймаут соединения с прокси')), timeoutMs);
    s.once('connect', () => { clearTimeout(t); resolve(s); });
    s.once('error', (e) => { clearTimeout(t); reject(e); });
  });
}

// Read one response head (and drain a small body) from a socket.
function readResponse(sock, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let head = null;
    const t = setTimeout(() => done(new Error('прокси не ответил')), timeoutMs);
    function done(err, value) {
      clearTimeout(t);
      sock.off('data', onData); sock.off('error', onErr); sock.off('close', onClose);
      if (err) reject(err); else resolve(value);
    }
    const onErr = (e) => done(e);
    const onClose = () => done(new Error('прокси закрыл соединение'));
    function onData(d) {
      buf = Buffer.concat([buf, d]);
      if (!head) {
        const end = buf.indexOf('\r\n\r\n');
        if (end === -1) { if (buf.length > 65536) done(new Error('слишком длинный ответ прокси')); return; }
        const lines = buf.slice(0, end).toString('latin1').split('\r\n');
        const status = Number((lines[0].match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/) || [])[1]);
        const headers = lines.slice(1).map((l) => { const i = l.indexOf(':'); return [l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim()]; });
        head = { status, line: lines[0], headers, rest: buf.slice(end + 4) };
        buf = head.rest;
      }
      if (head.status === 200) return done(null, head);
      // An error/407 body must be consumed before the connection can be reused.
      const len = Number((head.headers.find(([k]) => k === 'content-length') || [])[1]);
      const keep = !head.headers.some(([k, v]) => (k === 'connection' || k === 'proxy-connection') && /close/i.test(v));
      if (Number.isFinite(len)) {
        if (buf.length >= len) return done(null, { ...head, reusable: keep, rest: buf.slice(len) });
        return;
      }
      done(null, { ...head, reusable: false });
    }
    sock.on('data', onData); sock.once('error', onErr); sock.once('close', onClose);
  });
}

// A TCP tunnel to host:port through proxyUrl (Basic auth from its URL, if any).
// Resolves { socket, rest, auth } — auth: "Basic" | null.
async function tunnel(proxyUrl, host, port) {
  const u = new URL(px.normalizeUrl(proxyUrl));
  const phost = u.hostname.replace(/^\[|\]$/g, '');
  const pport = Number(u.port) || 80;
  const authority = net.isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`;
  const basic = basicFor(u);
  const sock = await connectTcp(phost, pport);
  try {
    sock.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Connection: keep-alive\r\n${basic ? `Proxy-Authorization: ${basic}\r\n` : ''}\r\n`);
    const r = await readResponse(sock);
    if (r.status === 200) return { socket: sock, rest: r.rest, auth: basic ? 'Basic' : null };
    if (r.status !== 407) throw new Error(`прокси: ${r.line}`);
    const offered = integratedScheme(r.headers);
    if (offered) throw new Error(`прокси требует вход под учётной записью Windows (${offered === 'Negotiate' ? 'Kerberos/Negotiate' : 'NTLM'}): ${INTEGRATED_HINT}`);
    throw new Error(basic ? 'прокси отклонил логин и пароль (407)' : 'прокси требует авторизацию (407) — укажите логин:пароль в адресе прокси');
  } catch (e) {
    sock.destroy();
    throw e;
  }
}

// Proxy-Authorization for one plain-HTTP request: Basic from the proxy URL, or none.
async function requestAuth(proxyUrl) {
  return basicFor(new URL(px.normalizeUrl(proxyUrl)));
}

// For the settings page: route, auth method and result for a few destinations.
async function test(targets, p = settings()) {
  const out = [];
  for (const t of targets) {
    const started = Date.now();
    const [host, port] = t.split(':');
    try {
      const route = await routeFor(`https://${host}/`, p);
      if (!route) { out.push({ target: t, ok: true, route: 'напрямую', ms: 0 }); continue; }
      const r = await tunnel(route, host, Number(port) || 443);
      r.socket.destroy();
      out.push({ target: t, ok: true, route: route.replace(/\/\/[^@/]*@/, '//***@'), auth: r.auth, ms: Date.now() - started });
    } catch (e) {
      out.push({ target: t, ok: false, error: e.message, ms: Date.now() - started });
    }
  }
  return out;
}

module.exports = { active, systemMode, routeFor, tunnel, requestAuth, test, INTEGRATED_HINT, _internal: { readResponse, integratedScheme } };
