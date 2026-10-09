'use strict';
// Secret gateway: a small reverse proxy on the host that machines reach at
// http://<host-ip>:<port>/g/<secret>/... with a per-machine token where the
// API key would go. The token is swapped for the real value and the request is
// forwarded to the secret's upstream over HTTPS — through the corporate proxy
// when one is configured. The machine never holds the value.
//
// Only connections from this host's own addresses are served: machines started
// by the CLI reach the host through it, LAN neighbours do not.

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const os = require('os');
const cfg = require('./config');
const vault = require('./vault');
const px = require('./proxy');

const PORT = Number(process.env.SMOLVM_WEB_GATEWAY_PORT || 7790);
const TOKEN_RE = /smolgw_[0-9a-f]{48}/;
const KEY_HEADERS = ['authorization', 'x-api-key', 'api-key', 'x-goog-api-key', 'x-auth-token', 'private-token'];
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);

let server = null;
let status = { listening: false, error: null };

function ownAddresses() {
  const set = new Set();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) set.add(a.address.replace(/^::ffff:/, ''));
  }
  return set;
}

function send(res, code, msg) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: `smolvm-web gateway: ${msg}`, type: 'gateway_error' } }));
}

// An https.Agent-compatible connection factory going through an HTTP CONNECT proxy.
function viaProxy(proxyUrl, host, port) {
  const u = new URL(proxyUrl);
  return (opts, cb) => {
    const req = http.request({
      host: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port) || 80, method: 'CONNECT', path: `${host}:${port}`,
      headers: {
        host: `${host}:${port}`,
        ...(u.username ? { 'proxy-authorization': `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')}` } : {}),
      },
    });
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); return cb(new Error(`прокси ответил ${res.statusCode} на CONNECT ${host}:${port}`)); }
      cb(null, tls.connect({ socket, servername: host }));
    });
    req.once('error', cb);
    req.end();
  };
}

async function handle(req, res) {
  const remote = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (!ownAddresses().has(remote) || remote.startsWith('127.') || remote === '::1') {
    return send(res, 403, 'доступ только для машин этого хоста');
  }
  const m = req.url.match(/^\/g\/([A-Za-z0-9_.-]{1,64})(\/[^]*)?$/);
  if (!m) return send(res, 404, 'ожидается путь /g/<секрет>/...');
  const secretName = m[1];
  const rest = m[2] || '/';

  // Find the token in a key-carrying header.
  let header = null; let token = null;
  for (const h of KEY_HEADERS) {
    const v = req.headers[h];
    const t = typeof v === 'string' && v.match(TOKEN_RE);
    if (t) { header = h; token = t[0]; break; }
  }
  if (!token) return send(res, 401, 'нет токена машины в заголовке Authorization / x-api-key');
  const hit = await vault.resolveToken(secretName, token).catch(() => null);
  if (!hit || hit.secret.mode !== 'gateway') return send(res, 403, 'токен не подходит для этого секрета');
  const s = hit.secret;
  if (s.methods?.length && !s.methods.includes(req.method)) return send(res, 405, `метод ${req.method} не разрешён для этого секрета`);
  for (const [k, v] of Object.entries(req.headers)) {
    if (k !== header && typeof v === 'string' && TOKEN_RE.test(v)) return send(res, 400, 'токен допускается только в одном заголовке');
  }
  if (TOKEN_RE.test(decodeURIComponent(rest))) return send(res, 400, 'токен в URL не допускается');

  const up = new URL(s.upstream);
  const target = new URL(up.pathname.replace(/\/+$/, '') + rest, up.origin);
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
  headers[header] = req.headers[header].replace(token, s.value);
  headers.host = target.host;

  const settings = cfg.getSettings();
  // A local model over plain HTTP (allowed per secret) is reached directly from the host,
  // never through the corporate proxy: localhost here is the host itself.
  const plain = target.protocol === 'http:' && s.allowHttp;
  const port = Number(target.port) || (plain ? 80 : 443);
  const useProxy = !plain && settings.proxy.enabled && settings.proxy.url && !px.bypassesProxy(target.hostname, settings.proxy.noProxy);
  const agent = useProxy
    ? Object.assign(new https.Agent({ keepAlive: false }), { createConnection: viaProxy(settings.proxy.url, target.hostname, port) })
    : undefined;

  const upReq = (plain ? http : https).request({
    protocol: plain ? 'http:' : 'https:', hostname: target.hostname.replace(/^\[|\]$/g, ''), port, method: req.method, path: target.pathname + target.search,
    headers, agent, ...(plain ? {} : { servername: target.hostname }),
  }, (upRes) => {
    const h = {};
    for (const [k, v] of Object.entries(upRes.headers)) if (!HOP.has(k)) h[k] = v;
    res.writeHead(upRes.statusCode, h);
    upRes.pipe(res);
  });
  upReq.setTimeout(10 * 60 * 1000, () => upReq.destroy(new Error('таймаут')));
  upReq.on('error', (e) => { if (!res.headersSent) send(res, 502, `upstream: ${e.message}`); else res.destroy(); });
  res.on('close', () => upReq.destroy());
  req.pipe(upReq);
}

function start() {
  if (server) return Promise.resolve(status);
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      handle(req, res).catch((e) => { if (!res.headersSent) send(res, 500, e.message); });
    });
    server.on('error', (e) => {
      status = { listening: false, error: `${e.code || e.message} (порт ${PORT})` };
      server = null;
      resolve(status);
    });
    // All interfaces, so a changed host IP keeps working; remote address is filtered in handle().
    server.listen(PORT, '0.0.0.0', () => { status = { listening: true, error: null }; resolve(status); });
  });
}

async function baseUrl(secretName) {
  const ip = await px.hostIp();
  return ip ? `http://${ip}:${PORT}/g/${secretName}` : null;
}

module.exports = { start, status: () => ({ ...status, port: PORT }), baseUrl, PORT };
