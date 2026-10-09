'use strict';
// Proxy relay for "Системный прокси Windows": machines cannot authenticate as
// the Windows user (Kerberos / NTLM), so in that mode their HTTP(S)_PROXY is
// this relay on the host. It picks the upstream per destination (system proxy /
// PAC) and authenticates there with the user's Windows credentials — what px or
// proxydetox do, built in.
//
// Access: connections from this host's own addresses (machines appear as the
// host) with the relay token; never to the host's own services.

const fs = require('fs');
const net = require('net');
const dns = require('dns');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const cfg = require('./config');
const px = require('./proxy');
const upproxy = require('./upproxy');

const PORT = Number(process.env.SMOLVM_WEB_RELAY_PORT || 7792);
const USER = 'smolvm';
const IDLE_MS = 10 * 60 * 1000;
const HOP = new Set(['connection', 'proxy-connection', 'keep-alive', 'proxy-authorization', 'proxy-authenticate', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

let token = null;
function relayToken() {
  if (token) return token;
  const file = path.join(cfg.DIR, 'relay.token');
  try { token = fs.readFileSync(file, 'utf8').trim(); } catch {}
  if (!/^[0-9a-f]{32,}$/.test(token || '')) {
    token = crypto.randomBytes(24).toString('hex');
    fs.mkdirSync(cfg.DIR, { recursive: true });
    fs.writeFileSync(file, token, { mode: 0o600 });
  }
  return token;
}

function ownAddresses() {
  const set = new Set(['127.0.0.1', '::1']);
  for (const list of Object.values(require('os').networkInterfaces())) for (const a of list || []) set.add(a.address);
  return set;
}
const unmap = (ip) => String(ip || '').replace(/^::ffff:/, '');

function authorized(headers) {
  const m = String(headers['proxy-authorization'] || '').match(/^Basic\s+(.+)$/i);
  if (!m) return false;
  const want = Buffer.from(`${USER}:${relayToken()}`);
  const got = Buffer.from(Buffer.from(m[1], 'base64').toString('utf8'));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

// Direct connections must not reach the host itself (smolvm-web, smolvm serve, ...).
async function directTarget(host, port) {
  const addrs = net.isIP(host) ? [host] : await new Promise((resolve, reject) => dns.lookup(host, { all: true }, (e, a) => (e ? reject(e) : resolve(a.map((x) => x.address)))));
  const own = ownAddresses();
  const ok = addrs.map(unmap).filter((a) => !own.has(a) && !/^127\./.test(a) && a !== '::1' && a !== '0.0.0.0');
  if (!ok.length) throw new Error(`${host}: адрес этого компьютера — через прокси-ретранслятор недоступен`);
  return ok[0];
}

async function open(host, port) {
  const route = await upproxy.routeFor(`${port === 80 ? 'http' : 'https'}://${host}:${port}/`);
  if (!route) {
    const ip = await directTarget(host, port);
    const socket = await new Promise((resolve, reject) => {
      const s = net.connect({ host: ip, port });
      const t = setTimeout(() => s.destroy(new Error('таймаут соединения')), 20000);
      s.once('connect', () => { clearTimeout(t); resolve(s); });
      s.once('error', (e) => { clearTimeout(t); reject(e); });
    });
    return { socket };
  }
  return upproxy.tunnel(route, host, port);
}

function reply(sock, code, text, extra = '') {
  const body = `smolvm-web relay: ${text}\n`;
  try { sock.end(`HTTP/1.1 ${code} ${http.STATUS_CODES[code] || ''}\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n${extra}\r\n${body}`); } catch {}
}

function allowedClient(sock) { return ownAddresses().has(unmap(sock.remoteAddress)); }

async function onConnect(req, client, head) {
  client.on('error', () => {});
  if (!allowedClient(client)) return reply(client, 403, 'доступ только с этого компьютера и его машин');
  if (!authorized(req.headers)) return reply(client, 407, 'нужен токен ретранслятора', 'proxy-authenticate: Basic realm="smolvm-web relay"\r\n');
  const m = String(req.url).match(/^\[([0-9a-f:.]+)\]:(\d{1,5})$/i) || String(req.url).match(/^([^:[\]\s]+):(\d{1,5})$/);
  if (!m) return reply(client, 400, `некорректная цель ${req.url}`);
  let up;
  try { up = await open(m[1].toLowerCase(), Number(m[2])); } catch (e) { return reply(client, 502, e.message); }
  const server = up.socket;
  server.on('error', () => {});
  client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  if (up.rest?.length) client.write(up.rest);
  if (head?.length) server.write(head);
  client.pipe(server); server.pipe(client);
  for (const s of [client, server]) s.setTimeout(IDLE_MS, () => { client.destroy(); server.destroy(); });
  const close = () => { client.destroy(); server.destroy(); };
  client.once('close', close); server.once('close', close);
}

async function onRequest(req, res) {
  const fail = (code, text, h = {}) => { if (!res.headersSent) { res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', ...h }); } res.end(`smolvm-web relay: ${text}\n`); };
  if (!allowedClient(req.socket)) return fail(403, 'доступ только с этого компьютера и его машин');
  if (!authorized(req.headers)) return fail(407, 'нужен токен ретранслятора', { 'proxy-authenticate': 'Basic realm="smolvm-web relay"' });
  let u;
  try { u = new URL(req.url); } catch { return fail(400, 'это прокси-ретранслятор smolvm-web: используйте его как HTTP(S)_PROXY'); }
  if (u.protocol !== 'http:') return fail(400, `схема ${u.protocol} не поддерживается (для HTTPS — CONNECT)`);
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = Number(u.port) || 80;
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
  headers.host = u.host;
  let opts;
  try {
    const route = await upproxy.routeFor(u.href);
    if (route) {
      const r = new URL(route);
      const auth = await upproxy.requestAuth(route);
      if (auth) headers['proxy-authorization'] = auth;
      opts = { host: r.hostname.replace(/^\[|\]$/g, ''), port: Number(r.port) || 80, path: u.href };
    } else {
      opts = { host: await directTarget(host, port), port, path: u.pathname + u.search };
    }
  } catch (e) { return fail(502, e.message); }
  const upReq = http.request({ ...opts, method: req.method, headers }, (upRes) => {
    const h = {};
    for (const [k, v] of Object.entries(upRes.headers)) if (!HOP.has(k)) h[k] = v;
    res.writeHead(upRes.statusCode, h);
    upRes.pipe(res);
  });
  upReq.setTimeout(IDLE_MS, () => upReq.destroy(new Error('таймаут')));
  upReq.on('error', (e) => fail(502, `upstream: ${e.message}`));
  res.on('close', () => upReq.destroy());
  req.pipe(upReq);
}

let server = null;
let status = { listening: false, error: null };

function start() {
  if (server) return Promise.resolve(status);
  relayToken();
  return new Promise((resolve) => {
    server = http.createServer((req, res) => { onRequest(req, res).catch((e) => { try { res.end(String(e.message)); } catch {} }); });
    server.on('connect', (req, sock, head) => { onConnect(req, sock, head).catch((e) => reply(sock, 500, e.message)); });
    server.on('clientError', (e, sock) => { try { sock.destroy(); } catch {} });
    server.on('error', (e) => { status = { listening: false, error: `${e.code || e.message} (порт ${PORT})` }; server = null; resolve(status); });
    // All interfaces: machines reach the host by its outbound address; clients are filtered per connection.
    server.listen(PORT, '0.0.0.0', () => { status = { listening: true, error: null }; resolve(status); });
  });
}

// The proxy URL for machines (host address) or for host processes (loopback).
async function urlFor({ loopback = false } = {}) {
  const st = await start();
  if (!st.listening) throw new Error(`прокси-ретранслятор не запущен: ${st.error}`);
  const host = loopback ? '127.0.0.1' : await px.hostIp();
  if (!host) throw new Error('прокси-ретранслятор: не удалось определить адрес хоста, доступный из машины');
  return `http://${USER}:${relayToken()}@${host}:${PORT}`;
}

module.exports = { PORT, start, urlFor, status: () => ({ ...status, port: PORT }) };
