'use strict';
// Downloads made by smolvm-web itself on the host (not by a machine): through the
// corporate proxy when one is configured, trusting the host's certificates
// (TLS inspection, internal CA), following redirects.

const http = require('http');
const https = require('https');
const tls = require('tls');
const cfg = require('./config');
const px = require('./proxy');

// Public roots + the host trust store + the pasted PEM.
function caPem() {
  const s = cfg.getSettings();
  return px.buildBundle({ ...s.ca, system: true }).pem;
}

function proxyFor(host) {
  const p = cfg.getSettings().proxy;
  if (!p.enabled || !p.url || px.bypassesProxy(host, p.noProxy)) return null;
  return new URL(px.normalizeUrl(p.url));
}

// A TLS socket to host:port, through an HTTP CONNECT proxy or direct.
function connect(u, ca, cb) {
  const host = u.hostname;
  const port = Number(u.port) || 443;
  const proxy = proxyFor(host);
  if (!proxy) return cb(null, tls.connect({ host, port, servername: host, ca }));
  const req = http.request({
    host: proxy.hostname.replace(/^\[|\]$/g, ''), port: Number(proxy.port) || 80, method: 'CONNECT', path: `${host}:${port}`,
    headers: {
      host: `${host}:${port}`,
      ...(proxy.username ? { 'proxy-authorization': `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}` } : {}),
    },
  });
  req.setTimeout(20000, () => req.destroy(new Error(`прокси ${proxy.host} не ответил`)));
  req.once('connect', (res, socket) => {
    if (res.statusCode !== 200) { socket.destroy(); return cb(new Error(`прокси ответил ${res.statusCode} на CONNECT ${host}:${port}`)); }
    cb(null, tls.connect({ socket, servername: host, ca }));
  });
  req.once('error', cb);
  req.end();
}

// GET a URL into a Buffer. auth: "user:password" for Basic auth (corporate mirrors).
function get(url, { auth = '', maxBytes = 64 << 20, redirects = 5, timeoutMs = 120000 } = {}) {
  const ca = caPem();
  return new Promise((resolve, reject) => {
    const go = (href, left) => {
      let u;
      try { u = new URL(href); } catch { return reject(new Error(`некорректный URL ${href}`)); }
      const plain = u.protocol === 'http:';
      const headers = { 'user-agent': 'smolvm-web' };
      if (auth && !u.username) headers.authorization = `Basic ${Buffer.from(auth).toString('base64')}`;
      if (u.username) headers.authorization = `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')}`;
      const onRes = (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (!left) return reject(new Error('слишком много перенаправлений'));
          // Credentials stay with the original host.
          const next = new URL(res.headers.location, u);
          if (next.host !== u.host) auth = '';
          return go(next.toString(), left - 1);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`${u.host} ответил HTTP ${res.statusCode}`)); }
        const chunks = []; let size = 0;
        res.on('data', (c) => { size += c.length; if (size > maxBytes) { res.destroy(new Error('файл слишком большой')); return; } chunks.push(c); });
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      };
      let req;
      if (plain) {
        req = http.request({ host: u.hostname, port: Number(u.port) || 80, path: u.pathname + u.search, headers }, onRes);
      } else {
        req = https.request({
          host: u.hostname, port: Number(u.port) || 443, path: u.pathname + u.search, headers, ca, servername: u.hostname,
          agent: false, createConnection: (opts, cb) => { connect(u, ca, cb); },
        }, onRes);
      }
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`${u.host}: нет ответа`)));
      req.on('error', (e) => reject(new Error(`${u.host}: ${e.message}`)));
      req.end();
    };
    go(url, redirects);
  });
}

module.exports = { get };
