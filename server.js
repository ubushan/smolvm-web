#!/usr/bin/env node
// smolvm-web: serves the UI and proxies API calls to `smolvm serve`.
//
// The smolvm API has no authentication, so this proxy is effectively a shell
// on the host. It binds to loopback only and rejects cross-site requests
// (Host/Origin checks + a required custom header on mutating calls), so a
// random web page open in your browser cannot drive your machines.
//
// On top of plain proxying it adds corporate-proxy support: proxy env and CA
// trust for machines, proxy-aware image pulls, and guest provisioning.

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const cfg = require('./lib/config');
const px = require('./lib/proxy');
const up = require('./lib/upstream');
const mc = require('./lib/machines');
const vault = require('./lib/vault');
const gateway = require('./lib/gateway');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 7777);
const AUTOSTART = process.argv.includes('--autostart') || process.env.SMOLVM_AUTOSTART === '1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const VERSION = require('./package.json').version;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const PROXIED = [/^\/api\/v1\//, /^\/health$/, /^\/capacity$/];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function hostAllowed(req) {
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  return LOOPBACK.has(host);
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return LOOPBACK.has(u.hostname === '::1' ? '[::1]' : u.hostname) && Number(u.port || 80) === PORT;
  } catch {
    return false;
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  return JSON.parse(buf.toString('utf8'));
}

// ---------- plain proxy ----------
function forward(req, res, bodyBuf) {
  const headers = { ...req.headers, host: 'localhost' };
  delete headers.origin;
  delete headers.referer;
  delete headers.cookie;
  delete headers['x-smolvm-ui'];
  if (bodyBuf) {
    headers['content-length'] = bodyBuf.length;
    delete headers['transfer-encoding'];
  }

  const upReq = http.request({ ...up.target(), method: req.method, path: req.url, headers }, (upRes) => {
    const h = { ...upRes.headers };
    if ((h['content-type'] || '').includes('text/event-stream')) {
      h['cache-control'] = 'no-cache';
      h['x-accel-buffering'] = 'no';
    }
    res.writeHead(upRes.statusCode, h);
    upRes.pipe(res);
  });

  upReq.on('error', (err) => {
    if (res.headersSent) return res.destroy();
    sendJson(res, 502, {
      error: `smolvm API недоступен (${up.UPSTREAM}): ${err.code || err.message}. Запустите: smolvm serve start --listen ${up.listenArg()}`,
      code: 'UPSTREAM_UNAVAILABLE',
    });
  });

  // Abort long-lived streams (logs, exec) when the browser goes away.
  res.on('close', () => upReq.destroy());
  if (bodyBuf) upReq.end(bodyBuf);
  else req.pipe(upReq);
}

// ---------- proxy-aware intercepts ----------
const M = '/api/v1/machines/([^/?]+)';
const ROUTES = [
  // Create: proxy env into the workload, secrets bound to the machine, per-machine proxy opt-out.
  ['POST', /^\/api\/v1\/machines$/, async (req, res, _m, url) => {
    const body = await readJson(req);
    const useProxy = url.searchParams.get('webProxy') !== '0';
    const secretNames = Array.isArray(body._webSecrets) ? body._webSecrets.map(String) : [];
    delete body._webSecrets;
    if (useProxy) {
      const p = await mc.effectiveProxy(null).catch((e) => ({ error: e.message }));
      if (p?.error) return sendJson(res, 400, { error: p.error, code: 'BAD_PROXY' });
      if (p) {
        body.env = px.mergeEnv(body.env, px.proxyEnv(p.url, p.noProxy));
        body.network = true;
      }
    }
    if (secretNames.length) {
      if (!body.name) return sendJson(res, 400, { error: 'Для машины с секретами укажите имя', code: 'BAD_REQUEST' });
      const exists = await up.request('GET', `/api/v1/machines/${encodeURIComponent(body.name)}`);
      if (exists.status === 200) return sendJson(res, 409, { error: `Машина ${body.name} уже существует`, code: 'CONFLICT' });
      try { await vault.bind(body.name, secretNames); } catch (e) { return sendJson(res, 400, { error: e.message, code: 'BAD_SECRET' }); }
      const bound = await vault.machineSecrets(body.name);
      const native = bound.filter((x) => x.mode === 'substitute');
      if (native.length) {
        body.network = true;
        body.credentials = {
          credentials: native.map((x) => ({
            name: x.name, environment_variable: x.envVar, allowed_hosts: x.hosts,
            ...(x.methods?.length ? { methods: x.methods } : {}),
          })),
        };
        // A credential host must sit inside the machine's own host allow-list, if any.
        if (Array.isArray(body.allowedHosts)) body.allowedHosts = [...new Set([...body.allowedHosts, ...native.flatMap((x) => x.hosts)])];
      }
      // Gateway tokens/base URLs and plaintext env for the workload itself.
      body.env = px.mergeEnv(body.env, await mc.secretEnv(body.name));
      if (bound.some((x) => x.mode === 'gateway')) await gateway.start();
    }
    url.searchParams.delete('webProxy');
    req.url = url.pathname + (url.search || '');
    const r = await up.request('POST', req.url, body);
    if (r.status === 200 && r.data?.name) cfg.setMachineProxy(r.data.name, useProxy);
    else if (secretNames.length) await vault.forgetMachine(body.name);
    sendJson(res, r.status, r.data);
  }],

  // Start: CLI when the proxy/gateway must be reachable, API (with credential
  // values pushed first) for smolvm substitution; then provision the guest.
  ['POST', new RegExp(`^${M}/start$`), async (req, res, m, url) => {
    const name = decodeURIComponent(m[1]);
    const raw = await readBody(req);
    const body = raw.length ? JSON.parse(raw.toString('utf8') || '{}') || {} : {};
    const branchable = url.searchParams.get('branchable') === 'true' || url.searchParams.get('forkable') === 'true';
    let plan;
    try { plan = await mc.startPlan(name); } catch (e) { return sendJson(res, 400, { error: e.message, code: 'BAD_PROXY' }); }
    // The CLI cannot pass registryAuth/egressInterceptor or CUDA pool parameters.
    const viaCli = plan.viaCli && !/[?&](forkPoolSize|branchPoolSize|cudaVramLimitMib)=/.test(req.url) && !Object.keys(body).length;

    let info;
    try {
      await mc.pushCredentialValues(name, plan.native);
      if (viaCli) info = await mc.startViaCli(name, { branchable, proxy: plan.proxy });
      else {
        const r = await up.request('POST', req.url, body);
        if (r.status !== 200) return sendJson(res, r.status, r.data);
        info = r.data;
      }
    } catch (e) {
      return sendJson(res, e.status || 500, { error: `${viaCli ? 'запуск через smolvm CLI' : 'запуск'}: ${e.message}`, code: 'START_FAILED' });
    }
    if (plan.warnings.length) info._webWarnings = plan.warnings;
    try {
      const pr = await mc.provision(name);
      if (!pr.skipped) info._webProvision = { ok: true, ...pr };
    } catch (e) {
      info._webProvision = { ok: false, error: e.message };
    }
    sendJson(res, 200, info);
  }],

  // Exec: inject proxy (and CA, once provisioned) env; explicit env wins.
  ['POST', new RegExp(`^${M}/exec(/stream)?$`), async (req, res, m) => {
    const name = decodeURIComponent(m[1]);
    const buf = await readBody(req);
    let body;
    try { body = JSON.parse(buf.toString('utf8') || '{}'); } catch { return forward(req, res, buf); }
    const extra = await mc.execEnv(name);
    if (extra.length) body.env = px.mergeEnv(body.env, extra);
    forward(req, res, Buffer.from(JSON.stringify(body)));
  }],

  // In-guest image pull: pass the proxy unless the caller set one.
  ['POST', new RegExp(`^${M}/images/pull$`), async (req, res, m) => {
    const name = decodeURIComponent(m[1]);
    const body = await readJson(req);
    const s = cfg.getSettings();
    if (s.proxy.pull && !body.proxy) {
      const p = await mc.effectiveProxy(name).catch(() => null);
      if (p) { body.proxy = p.url; body.noProxy = body.noProxy || p.noProxy; }
    }
    forward(req, res, Buffer.from(JSON.stringify(body)));
  }],

  ['DELETE', new RegExp(`^${M}$`), async (req, res, m) => {
    const name = decodeURIComponent(m[1]);
    const r = await up.request('DELETE', req.url);
    if (r.status === 200) { cfg.forgetMachine(name); await vault.forgetMachine(name); }
    sendJson(res, r.status, r.data);
  }],
];

// ---------- /ui endpoints ----------
function publicSettings() {
  const s = cfg.getSettings();
  return { ...s, ca: { ...s.ca } };
}

const UI = [
  ['GET', /^\/ui\/info$/, async (req, res) => {
    const s = cfg.getSettings();
    const g = s.proxy.url ? await px.guestUrl(s.proxy.url) : null;
    sendJson(res, 200, {
      version: VERSION,
      platform: process.platform,
      upstream: up.UPSTREAM,
      listen: up.listenArg(),
      configDir: cfg.DIR,
      smolvmBin: mc.SMOLVM_BIN,
      proxyActive: !!(s.proxy.enabled && s.proxy.url),
      caActive: !!s.ca.enabled,
      guestProxy: g,
    });
  }],
  ['GET', /^\/ui\/settings$/, (req, res) => sendJson(res, 200, publicSettings())],
  ['PUT', /^\/ui\/settings$/, async (req, res) => {
    const body = await readJson(req);
    if (body.proxy?.url) body.proxy.url = px.normalizeUrl(body.proxy.url);
    if (body.proxy?.enabled && body.proxy.url) {
      try { new URL(body.proxy.url); } catch { return sendJson(res, 400, { error: 'Некорректный URL прокси' }); }
    }
    if (body.ca?.enabled) {
      try { px.buildBundle({ ...cfg.getSettings().ca, ...body.ca }); }
      catch (e) { return sendJson(res, 400, { error: `CA: ${e.message}` }); }
    }
    sendJson(res, 200, cfg.saveSettings(body));
  }],
  ['GET', /^\/ui\/proxy\/detect$/, async (req, res) => sendJson(res, 200, await px.detect())],
  ['POST', /^\/ui\/proxy\/test$/, async (req, res) => {
    const body = await readJson(req);
    const url = body.url || cfg.getSettings().proxy.url;
    if (!url) return sendJson(res, 400, { error: 'Не указан адрес прокси' });
    const targets = ['registry-1.docker.io:443', 'pypi.org:443', 'registry.npmjs.org:443'];
    const results = await Promise.all(targets.map((t) => px.testConnect(url, t)));
    const guest = await px.guestUrl(url);
    let guestReach = null;
    if (guest.rewritten && !guest.error) guestReach = await px.testConnect(guest.url, targets[0]);
    sendJson(res, 200, { results, guest, guestReach });
  }],
  ['POST', /^\/ui\/ca\/preview$/, async (req, res) => {
    const body = await readJson(req);
    try {
      const b = px.buildBundle({ ...cfg.getSettings().ca, ...body });
      sendJson(res, 200, { count: b.count, user: b.user, system: b.system });
    } catch (e) { sendJson(res, 400, { error: e.message }); }
  }],
  ['GET', /^\/ui\/machines\/([^/]+)$/, async (req, res, m) => {
    const name = decodeURIComponent(m[1]);
    const secrets = (await vault.machineSecrets(name).catch(() => [])).map((x) => ({ name: x.name, mode: x.mode, envVar: x.envVar, baseUrlVar: x.baseUrlVar }));
    sendJson(res, 200, { useProxy: cfg.machineUsesProxy(name), provisioned: cfg.getProvisioned(name) || null, secrets });
  }],
  // Attach/detach gateway and env secrets on an existing machine (substitution is fixed at create).
  ['PUT', /^\/ui\/machines\/([^/]+)\/secrets$/, async (req, res, m) => {
    const name = decodeURIComponent(m[1]);
    const { add = [], remove = [] } = await readJson(req);
    for (const n of [...add, ...remove]) {
      const s = await vault.get(n);
      if (s?.mode === 'substitute') return sendJson(res, 400, { error: `«${n}» в режиме подстановки smolvm: он задаётся только при создании машины` });
    }
    try {
      if (add.length) await vault.bind(name, add);
      if (remove.length) await vault.unbind(name, remove);
    } catch (e) { return sendJson(res, 400, { error: e.message }); }
    const bound = await vault.machineSecrets(name);
    if (bound.some((x) => x.mode === 'gateway')) await gateway.start();
    sendJson(res, 200, { secrets: bound.map((x) => ({ name: x.name, mode: x.mode, envVar: x.envVar })) });
  }],
  ['GET', /^\/ui\/vault$/, async (req, res) => {
    const st = await vault.status();
    if (!st.ok) return sendJson(res, 200, { ok: false, error: st.error, secrets: [] });
    sendJson(res, 200, { ok: true, backend: st.backend, gateway: { ...gateway.status(), baseUrl: await gateway.baseUrl('<секрет>') }, secrets: await vault.list() });
  }],
  ['PUT', /^\/ui\/vault\/([^/]+)$/, async (req, res, m) => {
    const name = decodeURIComponent(m[1]);
    const body = await readJson(req);
    try {
      const d = await vault.put(name, body);
      if (d.mode === 'gateway') await gateway.start();
      sendJson(res, 200, d);
    } catch (e) { sendJson(res, 400, { error: e.message }); }
  }],
  ['DELETE', /^\/ui\/vault\/([^/]+)$/, async (req, res, m) => {
    await vault.remove(decodeURIComponent(m[1]));
    sendJson(res, 200, { deleted: true });
  }],
  ['PUT', /^\/ui\/machines\/([^/]+)$/, async (req, res, m) => {
    const name = decodeURIComponent(m[1]);
    const body = await readJson(req);
    if (typeof body.useProxy === 'boolean') cfg.setMachineProxy(name, body.useProxy);
    sendJson(res, 200, { useProxy: cfg.machineUsesProxy(name) });
  }],
  ['POST', /^\/ui\/machines\/([^/]+)\/provision$/, async (req, res, m) => {
    const name = decodeURIComponent(m[1]);
    try { sendJson(res, 200, await mc.provision(name)); }
    catch (e) { sendJson(res, 500, { error: e.message }); }
  }],
];

async function dispatch(table, req, res, url) {
  for (const [method, re, fn] of table) {
    if (req.method !== method) continue;
    const m = url.pathname.match(re);
    if (m) { await fn(req, res, m, url); return true; }
  }
  return false;
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 404, { error: 'not found' });
  fs.readFile(file, (err, data) => {
    if (err) {
      // SPA fallback
      return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
        if (e2) return sendJson(res, 404, { error: 'not found' });
        res.writeHead(200, { 'content-type': MIME['.html'] });
        res.end(html);
      });
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  if (!hostAllowed(req) || !originAllowed(req)) {
    return sendJson(res, 403, { error: 'forbidden host or origin', code: 'FORBIDDEN' });
  }
  const url = new URL(req.url, 'http://localhost');
  const isApi = PROXIED.some((re) => re.test(url.pathname));
  const isUi = url.pathname.startsWith('/ui/');
  const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if ((isApi || isUi) && mutating && req.headers['x-smolvm-ui'] !== '1') {
    return sendJson(res, 403, { error: 'missing X-Smolvm-UI header', code: 'FORBIDDEN' });
  }
  try {
    if (isUi) {
      if (!(await dispatch(UI, req, res, url))) sendJson(res, 404, { error: 'not found' });
      return;
    }
    if (isApi) {
      if (!(await dispatch(ROUTES, req, res, url))) forward(req, res);
      return;
    }
  } catch (e) {
    const unreachable = ['ECONNREFUSED', 'ENOENT', 'ECONNRESET'].includes(e.code);
    if (!res.headersSent) {
      sendJson(res, unreachable ? 502 : (e instanceof SyntaxError ? 400 : 500), {
        error: unreachable ? `smolvm API недоступен (${up.UPSTREAM}): ${e.code}` : e.message,
        code: unreachable ? 'UPSTREAM_UNAVAILABLE' : 'INTERNAL',
      });
    } else res.destroy();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
  serveStatic(req, res);
});

// ---------- autostart `smolvm serve` ----------
async function maybeAutostart() {
  if (await up.healthy()) return console.log(`smolvm API: ${up.UPSTREAM} (ok)`);
  if (!AUTOSTART) {
    console.log(`smolvm API: ${up.UPSTREAM} не отвечает. Запустите:\n  smolvm serve start --listen ${up.listenArg()}\nили перезапустите smolvm-web с --autostart.`);
    return;
  }
  const listen = up.listenArg();
  const env = { ...process.env };
  // Host-side registry requests made by the server honour the standard proxy env.
  const s = cfg.getSettings();
  if (s.proxy.enabled && s.proxy.url) {
    for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) env[k] = env[k] || s.proxy.url;
    const np = px.noProxyList(s.proxy.noProxy);
    env.NO_PROXY = env.NO_PROXY || np;
    env.no_proxy = env.no_proxy || np;
  }
  console.log(`Запуск: ${mc.SMOLVM_BIN} serve start --listen ${listen}`);
  // Log to a file, not a pipe: on Windows smolvm's children inherit pipe handles.
  const logPath = path.join(cfg.DIR, 'smolvm-serve.log');
  fs.mkdirSync(cfg.DIR, { recursive: true });
  const fd = fs.openSync(logPath, 'a');
  const child = spawn(mc.SMOLVM_BIN, ['serve', 'start', '--listen', listen], { stdio: ['ignore', fd, fd], env, windowsHide: true });
  child.on('error', (e) => console.error(`не удалось запустить smolvm: ${e.message}`));
  child.on('exit', (code) => console.log(`smolvm serve завершился (код ${code}); лог: ${logPath}`));
  const stop = () => { try { child.kill(); } catch {} process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  if (process.platform === 'win32') process.on('SIGBREAK', stop);
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await up.healthy()) {
      return console.log(`smolvm API запущен (лог: ${logPath}). Машины продолжают работать и после остановки сервера.`);
    }
  }
  console.error(`smolvm API не поднялся за 15 с; см. ${logPath}`);
}

server.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') throw e;
  // Tell an old smolvm-web apart from some other program on the port.
  http.get({ host: HOST, port: PORT, path: '/ui/info', timeout: 1500 }, (r) => {
    const ours = r.statusCode === 200 || r.statusCode === 404;
    r.resume();
    portBusy(ours ? 'там уже работает smolvm-web (возможно, старая версия)' : 'его занимает другая программа');
  }).on('error', () => portBusy('его занимает другая программа'));
});

function portBusy(why) {
  const kill = process.platform === 'win32'
    ? `netstat -ano | findstr :${PORT}   →   taskkill /PID <pid>`
    : `lsof -tiTCP:${PORT} -sTCP:LISTEN | xargs kill`;
  console.error(`\nПорт ${PORT} занят: ${why}.\n` +
    `  • остановите тот экземпляр (Ctrl+C в его терминале или: ${kill}), или\n` +
    `  • запустите на другом порту: ${process.platform === 'win32' ? `set PORT=7800 && start.cmd` : `PORT=7800 ./start.sh`}\n`);
  process.exit(1);
}

server.listen(PORT, HOST, () => {
  console.log(`smolvm-web: http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`);
  console.log(`настройки: ${cfg.DIR}`);
  maybeAutostart();
  vault.list().then(async (list) => {
    if (list.some((x) => x.mode === 'gateway')) {
      const st = await gateway.start();
      console.log(st.listening ? `шлюз секретов: порт ${gateway.PORT}` : `шлюз секретов не запущен: ${st.error}`);
    }
  }).catch((e) => console.log(`хранилище секретов: ${e.message}`));
});
