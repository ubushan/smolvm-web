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

// body: a value sent as JSON, or a Buffer sent as raw bytes (file upload).
function request(method, path, body, { timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const raw = Buffer.isBuffer(body);
    const payload = body === undefined ? null : raw ? body : Buffer.from(JSON.stringify(body));
    const headers = { host: 'localhost' };
    if (payload) { headers['content-type'] = raw ? 'application/octet-stream' : 'application/json'; headers['content-length'] = payload.length; }
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Run a command in a machine; throws on transport/API errors, not on a non-zero exit.
async function exec(name, body, timeoutMs = 120000) {
  const r = await request('POST', `/api/v1/machines/${encodeURIComponent(name)}/exec`, body, { timeoutMs });
  if (r.status !== 200) throw new Error(r.data?.error || `HTTP ${r.status}`);
  return r.data;
}

// Wait until the workload container answers an exec.
async function waitReady(name, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const r = await exec(name, { command: ['true'], timeoutSecs: 10 }, 15000);
      if (r.exitCode === 0) return;
      last = r.stderr;
    } catch (e) { last = e.message; }
    await sleep(1500);
  }
  throw new Error(`машина не готова к exec: ${last || 'таймаут'}`);
}

module.exports = { UPSTREAM, target, listenArg, request, healthy, exec, waitReady };
