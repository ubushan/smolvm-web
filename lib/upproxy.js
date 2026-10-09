'use strict';
// How smolvm-web reaches the corporate proxy (egress filter, proxy relay,
// secret gateway, host downloads):
//  - which proxy: the one in the settings, or — with "Системный прокси Windows" —
//    the Windows system proxy / PAC, per destination;
//  - authentication: Basic from the URL, or Windows integrated authentication
//    (Kerberos / NTLM via SSPI) when the proxy answers 407 Negotiate / NTLM.

const net = require('net');
const cfg = require('./config');
const px = require('./proxy');
const sysproxy = require('./sysproxy');
const sspi = require('./sspi');

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

function challengeOf(headers, scheme) {
  for (const [k, v] of headers) {
    if (k !== 'proxy-authenticate') continue;
    const m = v.match(new RegExp(`^${scheme}\\s+([A-Za-z0-9+/=]+)`, 'i'));
    if (m) return m[1];
  }
  return '';
}

// Proxies already seen to want integrated auth: send the first token right away.
const knownScheme = new Map(); // "host:port" -> "Negotiate" | "NTLM"

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

// A TCP tunnel to host:port through proxyUrl, authenticating as needed.
// Resolves { socket, rest, auth } — auth: "Basic" | "Negotiate" | "NTLM" | null.
async function tunnel(proxyUrl, host, port) {
  const u = new URL(px.normalizeUrl(proxyUrl));
  const phost = u.hostname.replace(/^\[|\]$/g, '');
  const pport = Number(u.port) || 80;
  const authority = net.isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`;
  const basic = basicFor(u);
  const key = `${phost}:${pport}`;
  let scheme = basic ? null : knownScheme.get(key) || null;
  let sess = null;
  let sock = await connectTcp(phost, pport);
  const send = (auth) => sock.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Connection: keep-alive\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}\r\n`);
  try {
    let auth = basic;
    let preemptive = false;
    if (scheme && sspi.AVAILABLE) {
      sess = await sspi.session(phost, scheme);
      auth = `${scheme} ${(await sess.next()).token}`;
      preemptive = true;
    }
    for (let round = 0; round < 4; round++) {
      send(auth);
      const r = await readResponse(sock);
      if (r.status === 200) {
        if (sess) knownScheme.set(key, scheme);
        return { socket: sock, rest: r.rest, auth: sess ? scheme : basic ? 'Basic' : null };
      }
      if (r.status !== 407) throw new Error(`прокси: ${r.line}`);
      const offered = integratedScheme(r.headers);
      if (!offered) throw new Error(basic ? 'прокси отклонил логин и пароль (407)' : 'прокси требует авторизацию (407), а способ не поддерживается — укажите логин:пароль в адресе прокси');
      if (!sspi.AVAILABLE) throw new Error(`прокси требует ${offered} (Kerberos/NTLM): это работает только на Windows — используйте px/proxydetox или логин:пароль`);
      const challenge = challengeOf(r.headers, offered);
      if (sess && challenge && offered === scheme) {
        // Handshake continues (NTLM challenge) — on the same connection.
        if (!r.reusable) throw new Error(`${scheme}: прокси закрыл соединение посреди авторизации`);
        const step = await sess.next(challenge);
        if (!step.token) throw new Error('прокси отверг учётные данные Windows');
        auth = `${scheme} ${step.token}`;
        continue;
      }
      // A bare 407 after our token: rejected — unless it was a preemptive token (expired ticket), then start over once.
      if (sess && !preemptive) throw new Error(`прокси отверг учётные данные Windows (${scheme})`);
      if (sess) sess.close();
      preemptive = false;
      scheme = offered;
      sess = await sspi.session(phost, scheme);
      auth = `${scheme} ${(await sess.next()).token}`;
      if (!r.reusable) { sock.destroy(); sock = await connectTcp(phost, pport); }
    }
    throw new Error('прокси не принял авторизацию');
  } catch (e) {
    sock.destroy();
    knownScheme.delete(key);
    throw e;
  } finally {
    if (sess) sess.close();
  }
}

// Proxy-Authorization for one plain-HTTP request (no handshake possible there):
// Basic, or a one-shot Kerberos token for a proxy known to want Negotiate.
async function requestAuth(proxyUrl) {
  const u = new URL(px.normalizeUrl(proxyUrl));
  const basic = basicFor(u);
  if (basic) return basic;
  const phost = u.hostname.replace(/^\[|\]$/g, '');
  const scheme = knownScheme.get(`${phost}:${Number(u.port) || 80}`) || (systemMode() && sspi.AVAILABLE ? 'Negotiate' : null);
  if (scheme !== 'Negotiate' || !sspi.AVAILABLE) return null;
  const sess = await sspi.session(phost, 'Negotiate');
  try { return `Negotiate ${(await sess.next()).token}`; } finally { sess.close(); }
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

module.exports = { active, systemMode, routeFor, tunnel, requestAuth, test, _internal: { readResponse, integratedScheme, challengeOf, knownScheme } };
