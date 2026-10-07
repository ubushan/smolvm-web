'use strict';
// Talking to `smolvm serve` (Unix socket or loopback TCP) from the server side.

const http = require('http');
const { IS_WIN } = require('./config');

// Windows has no Unix-socket listener in smolvm serve: loopback TCP is the only transport.
const DEFAULT_UPSTREAM = IS_WIN ? 'http://127.0.0.1:18899' : 'unix:///tmp/smolvm.sock';
const UPSTREAM = process.env.SMOLVM_API || DEFAULT_UPSTREAM;

function target() {
  if (UPSTREAM.startsWith('unix://')) return { socketPath: UPSTREAM.slice('unix://'.length) };
  if (UPSTREAM.startsWith('/')) return { socketPath: UPSTREAM };
  const u = new URL(/^https?:\/\//.test(UPSTREAM) ? UPSTREAM : `http://${UPSTREAM}`);
  return { hostname: u.hostname, port: u.port || 80 };
}

// The value for `smolvm serve start --listen`.
function listenArg() {
  if (UPSTREAM.startsWith('unix://')) return UPSTREAM;
  if (UPSTREAM.startsWith('/')) return `unix://${UPSTREAM}`;
  const t = target();
  return `${t.hostname}:${t.port}`;
}

function request(method, path, body, { timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { host: 'localhost' };
    if (payload) { headers['content-type'] = 'application/json'; headers['content-length'] = payload.length; }
    const req = http.request({ ...target(), method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
        resolve({ status: res.statusCode, data });
      });
    });
    if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function healthy() {
  try { return (await request('GET', '/health', undefined, { timeoutMs: 1500 })).status === 200; } catch { return false; }
}

module.exports = { UPSTREAM, target, listenArg, request, healthy };
