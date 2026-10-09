'use strict';
// The Windows system proxy, as browsers use it: Internet Settings
// (ProxyServer / ProxyOverride) or a PAC file (AutoConfigURL), evaluated per
// destination. Results are cached; the registry is re-read every minute.

const net = require('net');
const vm = require('vm');
const dns = require('dns');
const http = require('http');
const https = require('https');
const { execFile } = require('child_process');
const px = require('./proxy');

const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
let regCache = { at: 0, value: null };
let pacCache = { url: '', at: 0, fn: null, error: null };
const resultCache = new Map(); // "scheme://host" -> { at, value }
const dnsCache = new Map();    // host -> ip

function readRegistry() {
  if (process.platform !== 'win32') return Promise.resolve({ enabled: false });
  if (regCache.value && Date.now() - regCache.at < 60000) return Promise.resolve(regCache.value);
  return new Promise((resolve) => {
    execFile('reg', ['query', REG_KEY], { timeout: 5000, windowsHide: true }, (err, out) => {
      out = String(out || '');
      const val = (name) => (out.match(new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.*)$`, 'mi')) || [])[1]?.trim() || '';
      const value = {
        enabled: /^0x0*1$/i.test(val('ProxyEnable')),
        server: val('ProxyServer'),
        override: val('ProxyOverride'),
        pac: val('AutoConfigURL'),
      };
      regCache = { at: Date.now(), value };
      resolve(value);
    });
  });
}

// "host:port" or "http=a:1;https=b:2;socks=c:3".
function serverFor(server, scheme) {
  if (!server) return '';
  if (!server.includes('=')) return server;
  const map = Object.fromEntries(server.split(';').map((p) => p.split('=').map((x) => x.trim().toLowerCase())).filter((p) => p.length === 2));
  return map[scheme] || map.https || map.http || '';
}

// ProxyOverride: "*.corp;10.*;<local>" — <local> = plain host names (no dot).
function bypassed(override, host) {
  return String(override || '').split(';').map((x) => x.trim().toLowerCase()).filter(Boolean).some((p) => {
    if (p === '<local>') return !host.includes('.') && !net.isIP(host);
    const re = new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
    return re.test(host);
  });
}

// ---------- PAC ----------
function fetchText(url) {
  return new Promise((resolve, reject) => {
    if (/^file:/i.test(url)) {
      try { return resolve(require('fs').readFileSync(new URL(url), 'utf8')); } catch (e) { return reject(e); }
    }
    const mod = /^https:/i.test(url) ? https : http;
    // The PAC file is on the intranet: fetched directly, never through a proxy.
    const req = mod.get(url, { timeout: 10000, ca: px.buildBundle({ system: true, pem: '' }).pem }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`PAC: HTTP ${res.statusCode}`)); }
      let t = ''; res.setEncoding('utf8');
      res.on('data', (d) => { t += d; if (t.length > 2e6) req.destroy(new Error('PAC слишком большой')); });
      res.on('end', () => resolve(t));
    });
    req.on('timeout', () => req.destroy(new Error('PAC: нет ответа')));
    req.on('error', reject);
  });
}

function ip2long(ip) { return ip.split('.').reduce((a, b) => (a * 256) + Number(b), 0); }

// The standard PAC helper functions. dnsResolve is synchronous in PAC, so the
// destination is resolved beforehand and other names come from the cache.
function pacContext(myIp) {
  const resolve = (h) => (net.isIPv4(h) ? h : dnsCache.get(String(h).toLowerCase()) || null);
  const shExpMatch = (s, p) => new RegExp(`^${String(p).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`).test(String(s));
  const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  return {
    isPlainHostName: (h) => !String(h).includes('.'),
    dnsDomainIs: (h, d) => String(h).toLowerCase().endsWith(String(d).toLowerCase()),
    localHostOrDomainIs: (h, d) => { h = String(h).toLowerCase(); d = String(d).toLowerCase(); return h === d || (!h.includes('.') && d.startsWith(`${h}.`)); },
    isResolvable: (h) => !!resolve(h),
    isInNet: (h, pattern, mask) => {
      const ip = resolve(h);
      if (!ip || !net.isIPv4(ip)) return false;
      const m = ip2long(mask);
      return ((ip2long(ip) & m) >>> 0) === ((ip2long(pattern) & m) >>> 0);
    },
    dnsResolve: resolve,
    myIpAddress: () => myIp || '127.0.0.1',
    dnsDomainLevels: (h) => String(h).split('.').length - 1,
    shExpMatch,
    weekdayRange: (a, b) => { const d = new Date().getDay(); const x = DAYS.indexOf(String(a).toUpperCase()); const y = b && DAYS.indexOf(String(b).toUpperCase()) >= 0 ? DAYS.indexOf(String(b).toUpperCase()) : x; return x <= y ? d >= x && d <= y : d >= x || d <= y; },
    dateRange: () => true,
    timeRange: () => true,
    convert_addr: ip2long,
    // Microsoft's IPv6-aware extensions.
    isResolvableEx: (h) => !!resolve(h),
    isInNetEx: () => false,
    dnsResolveEx: (h) => resolve(h) || '',
    myIpAddressEx: () => myIp || '127.0.0.1',
    sortIpAddressList: (s) => s,
  };
}

async function pacFunction(url) {
  if (pacCache.url === url && pacCache.fn && Date.now() - pacCache.at < 10 * 60000) return pacCache.fn;
  const code = await fetchText(url);
  const ctx = vm.createContext(pacContext(await px.hostIp()));
  new vm.Script(code, { filename: 'proxy.pac' }).runInContext(ctx, { timeout: 2000 });
  if (typeof ctx.FindProxyForURL !== 'function' && typeof ctx.FindProxyForURLEx !== 'function') throw new Error('PAC без FindProxyForURL');
  const fn = (u, h) => String((ctx.FindProxyForURLEx || ctx.FindProxyForURL)(u, h) || 'DIRECT');
  pacCache = { url, at: Date.now(), fn, error: null };
  return fn;
}

function lookup(host) {
  if (net.isIP(host) || dnsCache.has(host)) return Promise.resolve();
  return new Promise((resolve) => {
    dns.lookup(host, { family: 4 }, (err, addr) => { if (!err) dnsCache.set(host, addr); resolve(); });
  });
}

// "PROXY a:1; SOCKS b:2; DIRECT" -> first usable: http://a:1, or null for DIRECT.
function parsePacResult(r) {
  for (const part of String(r).split(';').map((x) => x.trim()).filter(Boolean)) {
    const [kind, hp] = part.split(/\s+/);
    const k = kind.toUpperCase();
    if (k === 'DIRECT') return null;
    if ((k === 'PROXY' || k === 'HTTP' || k === 'HTTPS') && hp) return `http://${hp}`;
  }
  return null;
}

// The proxy for a URL ("https://host:port/..."): "http://proxy:port" or null (direct).
async function proxyFor(url) {
  const u = new URL(url);
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const key = `${u.protocol}//${host}`;
  const hit = resultCache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60000) return hit.value;
  const reg = await readRegistry();
  let value = null;
  if (reg.pac) {
    try {
      const fn = await pacFunction(reg.pac);
      await lookup(host);
      value = parsePacResult(fn(url, host));
    } catch (e) {
      pacCache.error = e.message;
      // A broken PAC: fall back to the static proxy, if any.
      if (reg.enabled && reg.server && !bypassed(reg.override, host)) value = px.normalizeUrl(serverFor(reg.server, u.protocol.replace(':', '')));
    }
  } else if (reg.enabled && reg.server && !bypassed(reg.override, host)) {
    value = px.normalizeUrl(serverFor(reg.server, u.protocol.replace(':', '')));
  }
  resultCache.set(key, { at: Date.now(), value });
  return value;
}

// For the settings page: what Windows is configured with, and a sample decision.
async function describe(sampleUrl = 'https://registry-1.docker.io/') {
  if (process.platform !== 'win32') return { available: false };
  const reg = await readRegistry();
  let sample = null; let error = null;
  try { sample = await proxyFor(sampleUrl); } catch (e) { error = e.message; }
  return {
    available: true, enabled: reg.enabled, server: reg.server, override: reg.override, pac: reg.pac,
    sampleUrl, sample, error: error || pacCache.error,
  };
}

// The NO_PROXY list for machines: ProxyOverride without wildcards it cannot express.
async function noProxy() {
  const reg = await readRegistry();
  return String(reg.override || '').split(';').map((x) => x.trim()).filter((x) => x && x !== '<local>')
    .map((x) => x.replace(/^\*\./, '.').replace(/^\*/, '')).filter((x) => !/[*?]/.test(x)).join(',');
}

function reset() { regCache = { at: 0, value: null }; pacCache = { url: '', at: 0, fn: null, error: null }; resultCache.clear(); }

module.exports = { proxyFor, describe, noProxy, reset, _internal: { parsePacResult, bypassed, serverFor, pacContext } };
