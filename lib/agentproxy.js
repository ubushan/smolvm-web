'use strict';
// Per-agent host proxies: 127.0.0.1:<port> -> 127.0.0.1:<published guest port>.
// They add the agent's credential (ttyd / opencode basic auth) so the browser
// never sees a password prompt, pass WebSockets through, and refuse foreign
// Host/Origin headers (DNS rebinding, cross-site WebSocket hijacking).
// The Host header is forwarded as-is: Harness checks it.

const http = require('http');
const net = require('net');

const proxies = new Map(); // key -> { server, port, opts }
const LOOP = new Set(['127.0.0.1', 'localhost']);

function hostOk(req, port) {
  const h = String(req.headers.host || '');
  const m = h.match(/^(.+?)(?::(\d+))?$/);
  return !!m && LOOP.has(m[1]) && Number(m[2] || 80) === port;
}

function originOk(req, port) {
  const o = req.headers.origin;
  if (!o) return true;
  try {
    const u = new URL(o);
    return LOOP.has(u.hostname) && Number(u.port || 80) === port;
  } catch { return false; }
}

// Let the agent UI live in an iframe of smolvm-web (same host, other port).
function frameable(headers) {
  const h = { ...headers };
  delete h['x-frame-options'];
  const csp = h['content-security-policy'];
  if (csp) {
    h['content-security-policy'] = String(csp).split(';').map((d) => d.trim())
      .filter((d) => d && !/^frame-ancestors\b/i.test(d)).join('; ');
  }
  return h;
}

function create(key, opts, port) {
  return new Promise((resolve, reject) => {
    const entry = { opts, port: 0, server: null };
    const server = http.createServer((req, res) => {
      if (!hostOk(req, entry.port) || !originOk(req, entry.port)) { res.writeHead(403); return res.end('forbidden'); }
      const headers = { ...req.headers };
      if (entry.opts.auth) headers.authorization = entry.opts.auth;
      const upReq = http.request({ host: '127.0.0.1', port: entry.opts.target, method: req.method, path: req.url, headers }, (upRes) => {
        res.writeHead(upRes.statusCode, frameable(upRes.headers));
        upRes.pipe(res);
      });
      upReq.on('error', () => {
        if (!res.headersSent) { res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Агент не отвечает. Запустите его заново во вкладке «Агенты».'); } else res.destroy();
      });
      res.on('close', () => upReq.destroy());
      req.pipe(upReq);
    });
    server.on('upgrade', (req, socket, head) => {
      if (!hostOk(req, entry.port) || !originOk(req, entry.port)) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
      const upSock = net.connect(entry.opts.target, '127.0.0.1', () => {
        const headers = { ...req.headers };
        if (entry.opts.auth) headers.authorization = entry.opts.auth;
        let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
        for (const [k, v] of Object.entries(headers)) for (const vv of [].concat(v)) raw += `${k}: ${vv}\r\n`;
        upSock.write(`${raw}\r\n`);
        if (head?.length) upSock.write(head);
        upSock.pipe(socket); socket.pipe(upSock);
      });
      upSock.on('error', () => socket.destroy());
      socket.on('error', () => upSock.destroy());
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      entry.server = server;
      entry.port = server.address().port;
      proxies.set(key, entry);
      resolve(entry);
    });
  });
}

async function ensure(key, opts) {
  const cur = proxies.get(key);
  if (cur) {
    if (cur.opts.target === opts.target) { cur.opts = opts; return cur; }
    cur.server.close(); proxies.delete(key);
  }
  // A stable port keeps browser cookies (dsh) valid across smolvm-web restarts.
  try { return await create(key, opts, opts.preferPort || 0); } catch { return create(key, opts, 0); }
}

function closeFor(prefix) {
  for (const [k, v] of proxies) if (k.startsWith(prefix)) { v.server.close(); proxies.delete(k); }
}

module.exports = { ensure, closeFor };
