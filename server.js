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
const upproxy = require('./lib/upproxy');
const sysproxy = require('./lib/sysproxy');
const sspi = require('./lib/sspi');
const relay = require('./lib/relay');
const up = require('./lib/upstream');
const mc = require('./lib/machines');
const vault = require('./lib/vault');
const gateway = require('./lib/gateway');
const agents = require('./lib/agents');
const agentproxy = require('./lib/agentproxy');
const smolfile = require('./lib/smolfile');
const review = require('./lib/review');
const sandbox = require('./lib/sandbox');
const audit = require('./lib/audit');
const egress = require('./lib/egress');
const winhost = require('./lib/winhost');
const repos = require('./lib/repos');
const { execFile } = require('child_process');

// Corporate repository hosts are reachable for machines behind the egress filter (internal addresses too).
egress.setExtraRules(() => repos.hosts().map((host) => ({ host, ports: '*', allowPrivate: true, source: 'корпоративные репозитории' })));
egress.onLog((e) => audit.onNet(e));
const dirs = require('./lib/dirs');
const approvals = require('./lib/approvals');
const isolation = require('./lib/isolation');
const limits = require('./lib/limits');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 7777);
const AUTOSTART = process.argv.includes('--autostart') || process.env.SMOLVM_AUTOSTART === '1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const VERSION = require('./package.json').version;
const buildInfo = require('./lib/version');

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
function forward(req, res, bodyBuf, tap) {
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
    if (tap) {
      upRes.on('data', (c) => { try { tap.data(c, upRes.statusCode); } catch {} });
      upRes.on('end', () => { try { tap.end(upRes.statusCode); } catch {} });
    }
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

// ---------- audit ----------
function actorOf(req) { return `ui@${(req.socket.remoteAddress || '').replace(/^::ffff:/, '')}`; }

const AUDIT_LABELS = [
  [/^POST \/api\/v1\/machines$/, 'создание машины'],
  [/^POST \/api\/v1\/machines\/[^/]+\/start$/, 'запуск машины'],
  [/^POST \/api\/v1\/machines\/[^/]+\/stop$/, 'остановка машины'],
  [/^POST \/api\/v1\/machines\/[^/]+\/pause$/, 'пауза'],
  [/^POST \/api\/v1\/machines\/[^/]+\/resume$/, 'возобновление'],
  [/^DELETE \/api\/v1\/machines\/[^/]+$/, 'удаление машины'],
  [/^POST \/api\/v1\/machines\/[^/]+\/branches$/, 'ветка'],
  [/^PUT \/api\/v1\/machines\/[^/]+\/files\//, 'загрузка файла в машину'],
  [/^POST \/api\/v1\/machines\/[^/]+\/images\/pull$/, 'загрузка образа'],
  [/^POST \/ui\/machines\/[^/]+\/agents\/[\w-]+\/start$/, 'запуск агента'],
  [/^POST \/ui\/machines\/[^/]+\/agents\/[\w-]+\/stop$/, 'остановка агента'],
  [/^POST \/ui\/machines\/[^/]+\/agents(\/install)?$/, 'агенты: подключение/установка'],
  [/^POST \/ui\/machines\/[^/]+\/review$/, 'рабочая копия: создание'],
  [/^POST \/ui\/machines\/[^/]+\/review\/[\w.-]+\/apply$/, 'ревью: применено на хост'],
  [/^POST \/ui\/machines\/[^/]+\/review\/[\w.-]+\/reject$/, 'ревью: отклонено'],
  [/^POST \/ui\/machines\/[^/]+\/review\/[\w.-]+\/(pull|copy)$/, 'рабочая копия: обновление с хоста'],
  [/^DELETE \/ui\/machines\/[^/]+\/review\//, 'рабочая копия: удаление'],
  [/^POST \/ui\/egress\/machines\/[^/]+\/learn\/finish$/, 'обучение: список создан'],
  [/^PUT \/ui\/machines\/[^/]+\/agents\/vendor$/, 'сервер вендора: разрешён/отозван'],
  [/^PUT \/ui\/vault\//, 'секрет: сохранён'],
  [/^DELETE \/ui\/vault\//, 'секрет: удалён'],
  [/^PUT \/ui\/machines\/[^/]+\/secrets$/, 'секреты машины'],
  [/^(PUT|POST|DELETE) \/ui\/egress/, 'сеть: изменение'],
  [/^(PUT|POST|DELETE) \/ui\/dirs/, 'директории: изменение'],
  [/^PUT \/ui\/machines\/[^/]+\/limits$/, 'лимиты машины'],
  [/^POST \/ui\/machines\/[^/]+\/folders$/, 'доступ к папке: выдан'],
  [/^DELETE \/ui\/machines\/[^/]+\/folders\//, 'доступ к папке: отозван'],
  [/^PUT \/ui\/settings$/, 'настройки прокси/сертификатов'],
  [/^POST \/ui\/host\/repair-rootfs$/, 'починка rootfs smolvm (Windows)'],
  [/^PUT \/ui\/audit\/settings$/, 'настройки аудита'],
  [/^(PUT|POST|DELETE) \/ui\/sandbox\/profiles/, 'песочницы: профиль агента'],
  [/^POST \/ui\/sandbox\/pending\/[^/]+\/apply$/, 'песочницы: изменения профиля применены'],
  [/^DELETE \/ui\/sandbox\/pending\//, 'песочницы: изменения профиля отклонены'],
  [/^DELETE \/ui\/sandbox\/templates\//, 'песочницы: шаблон удалён'],
  [/^PUT \/ui\/sandbox\/policy$/, 'песочницы: политика по умолчанию'],
  [/^POST \/ui\/sandbox\/machines\/[^/]+\/extend$/, 'песочница продлена'],
];

function auditRequest(req, res, url) {
  const key = `${req.method} ${url.pathname}`;
  if (/^(GET|HEAD|OPTIONS) /.test(key) || /\/ui\/smolfile\/parse$|\/ui\/audit\/test$|\/ui\/proxy\/test$|\/ui\/ca\/preview$/.test(url.pathname)) return;
  const label = (AUDIT_LABELS.find(([re]) => re.test(key)) || [null, key])[1];
  const mm = url.pathname.match(/^\/(?:api\/v1|ui)\/machines\/([^/]+)/);
  const started = Date.now();
  res.on('finish', () => {
    if (res.auditDone) return;
    audit.record({
      type: url.pathname.startsWith('/ui/') ? 'ui' : 'api', actor: actorOf(req), machine: mm ? decodeURIComponent(mm[1]) : null,
      action: label, status: res.statusCode, ms: Date.now() - started,
      detail: { method: req.method, path: url.pathname, ...(res.auditDetail || {}) },
      severity: res.statusCode >= 400 ? 'notice' : 'info',
    });
  });
}

// Host folders mounted read-write into running machines are watched for changes.
async function syncFsWatches() {
  const r = await up.request('GET', '/api/v1/machines').catch(() => null);
  const rw = [];
  for (const m of r?.data?.machines || []) {
    if (m.state !== 'running') continue;
    for (const mt of m.mounts || []) if (!mt.readonly) rw.push({ source: mt.source, machine: m.name });
  }
  audit.syncWatches(rw);
}
setInterval(() => syncFsWatches().catch(() => {}), 30000).unref();
setTimeout(() => syncFsWatches().catch(() => {}), 3000).unref();

// The in-guest image pull got "Forbidden": Go's wording for a proxy that refused the CONNECT.
function explainPullForbidden(name, message) {
  const m = String(message || '').match(/pull image:[\s\S]*?Get "https?:\/\/([^/:"]+)[^"]*":\s*Forbidden/i);
  if (!m) return null;
  const host = m[1].toLowerCase();
  const filter = egress.pullAllowed(name, host);
  let hint;
  if (filter === false) {
    hint = `Его заблокировал фильтр «Сеть» smolvm-web: ${host} нет среди реестров образов. Добавьте его в «Сеть» → «Списки» → «Реестры образов» (или кнопкой «Разрешить» во вкладке «Журнал») и запустите машину снова.`;
  } else {
    hint = `Его запретил корпоративный прокси (политика доступа к ${host}). Попросите ИТ открыть ${host} (CDN Docker Hub) или возьмите образ из зеркала — в поле «Образ» при создании машины: mirror.gcr.io/library/<образ> или public.ecr.aws/docker/library/<образ>, либо корпоративный Nexus/Artifactory.`;
  }
  return { code: 'PULL_FORBIDDEN', hint: `Скачивание образа остановил прокси: доступ к ${host} запрещён. ${hint}`, repairable: false };
}

// The in-guest pull could not reach Docker Hub (no direct internet, blocked, rate limit).
// An image is fixed when the machine is created, so a machine created before the
// corporate registry was configured keeps pulling from Docker Hub.
function explainPullDockerHub(name, message) {
  const msg = String(message || '');
  if (!/pull image|crane manifest/i.test(msg)) return null;
  const m = msg.match(/fetching manifest ((?:docker\.io|index\.docker\.io|registry-1\.docker\.io)\/\S+?):\s/i)
    || (/(index|registry-1)\.docker\.io/i.test(msg) ? [null, ''] : null);
  if (!m) return null;
  const image = m[1];
  const corp = image ? repos.rewriteImage(image) : '';
  let hint;
  if (corp && corp !== image) {
    hint = `Машина ${name} создана до настройки корпоративного реестра и по-прежнему ссылается на Docker Hub (${image}): образ машины задаётся при создании, а smolvm не умеет менять его у существующей машины. Создайте машину заново (тот же профиль или образ) — образ будет взят из ${corp}. Если ${name} ещё ни разу не запускалась, в ней ничего нет, её можно удалить.`;
  } else if (cfg.getSettings().repos.registry) {
    hint = 'Корпоративный реестр настроен, но галочка «Брать образы Docker Hub из этого реестра» выключена — включите её в «Настройки» → «Репозитории» и создайте машину заново.';
  } else {
    hint = 'Прямого доступа к Docker Hub нет. Включите корпоративный прокси («Настройки» → «Прокси») или укажите корпоративный реестр (JFrog/Nexus) в «Настройки» → «Репозитории» и создайте машину заново.';
  }
  return { code: 'PULL_DOCKERHUB', hint: `Не удалось скачать образ с Docker Hub. ${hint}`, repairable: false };
}

// The in-guest image pull met a TLS-inspecting proxy whose root it does not trust.
function explainPullCert(name, message) {
  if (!/x509: certificate signed by unknown authority|tls: failed to verify certificate/i.test(String(message || ''))) return null;
  const s = cfg.getSettings();
  let hint;
  if (!s.ca.enabled) hint = 'Включите в «Настройки» → «Сертификаты» «Доверять корпоративным сертификатам» — с «Добавить сертификаты, которым доверяет этот компьютер» и/или PEM корневого сертификата — и «Доверять им при скачивании образа», затем запустите машину снова.';
  else if (!s.ca.pullTrust) hint = 'Включите в настройках «Доверять им при скачивании образа» и запустите машину снова.';
  else if (!cfg.machineUsesProxy(name)) hint = 'Для этой машины прокси и корпоративные сертификаты выключены (вкладка «Обзор») — включите их.';
  else hint = 'Сертификаты уже передаются, но нужного корня в bundle нет: в настройках вставьте PEM корневого сертификата вашей TLS-инспекции (или путь к .cer/.crt) — его выдаёт ИТ или можно экспортировать из браузера (замок → сертификат → корневой) — и запустите снова.';
  return { code: 'PULL_CERT', hint: `Скачивание образа упёрлось в TLS-инспекцию: машина не доверяет корневому сертификату корпоративного прокси. ${hint}`, repairable: false };
}

// ---------- start ----------
const starting = new Set(); // machines inside startMachine (any client)

async function startMachine(name, opts) {
  starting.add(name);
  try { return await startMachineInner(name, opts); } finally { starting.delete(name); }
}

// What each machine is busy preparing right now (for the «подготовка» badge).
function preparing() {
  const out = {};
  for (const n of starting) out[n] = { label: 'запуск', step: 'запуск машины и настройка' };
  for (const j of review.running()) out[j.name] = { label: 'подготовка', step: j.step };
  return out;
}

async function startMachineInner(name, { apiPath, body = {}, branchable = false }) {
  const fail = (status, error, code) => Object.assign(new Error(error), { status, code });
  if (branchable && !/[?&](branchable|forkable)=/.test(apiPath)) apiPath += `${apiPath.includes('?') ? '&' : '?'}branchable=true`;
  let prepared;
  try { prepared = await mc.prepareStart(name); } catch (e) { throw fail(400, `подготовка к запуску: ${e.message}`, 'PREPARE_FAILED'); }
  let plan;
  try { plan = await mc.startPlan(name); } catch (e) { throw fail(400, e.message, 'BAD_PROXY'); }
  // The CLI cannot pass registryAuth/egressInterceptor or CUDA pool parameters.
  const viaCli = plan.viaCli && !/[?&](forkPoolSize|branchPoolSize|cudaVramLimitMib)=/.test(apiPath) && !Object.keys(body).length;
  if (plan.proxy?.egress) await egress.start();

  let info;
  try {
    await mc.pushCredentialValues(name, plan.native);
    if (viaCli) { info = await mc.startViaCli(name, { branchable, proxy: plan.proxy }); delete info._cliLog; }
    else {
      const r = await up.request('POST', apiPath, body);
      if (r.status !== 200) throw Object.assign(new Error(r.data?.error || `HTTP ${r.status}`), { status: r.status, body: r.data });
      info = r.data;
    }
  } catch (e) {
    // Windows: a rootfs extracted without symlinks fails every boot; say what to do.
    const why = winhost.explainBootError(e.body?.error || e.message) || explainPullCert(name, e.body?.error || e.message) || explainPullForbidden(name, e.body?.error || e.message) || explainPullDockerHub(name, e.body?.error || e.message);
    if (why) throw Object.assign(fail(e.status || 500, `${viaCli ? 'запуск через smolvm CLI' : 'запуск'}: ${e.body?.error || e.message}\n\n${why.hint}`, why.code), { body: null, repairable: why.repairable });
    if (e.body) throw e;
    throw fail(e.status || 500, `${viaCli ? 'запуск через smolvm CLI' : 'запуск'}: ${e.message}`, 'START_FAILED');
  }
  if (plan.warnings.length) info._webWarnings = plan.warnings;
  if (prepared.length) info._webPrepared = prepared;
  try {
    const pr = await mc.provision(name);
    if (!pr.skipped) info._webProvision = { ok: true, ...pr };
  } catch (e) {
    info._webProvision = { ok: false, error: e.message };
  }
  try {
    const dr = await mc.provisionDirs(name);
    if (!dr.skipped) info._webDirs = dr;
  } catch (e) {
    info._webDirs = { errors: [e.message], warnings: [], users: [] };
  }
  // Review copies waiting for the machine to run.
  try { const rv = await review.provision(name); if (rv.length) info._webReview = rv; } catch (e) { info._webReview = [e.message]; }
  // First start of a Smolfile machine: its `init`, once, after proxy/CA/dirs are in place.
  if (smolfile.initPending(name)) {
    try { info._webInit = await smolfile.runInit(name); } catch (e) { info._webInit = { ok: false, error: e.message, log: '' }; }
    if (info._webInit) audit.record({ type: 'exec', machine: name, actor: 'smolvm-web', action: 'init из Smolfile', exitCode: info._webInit.ok ? 0 : 1, detail: { commands: info._webInit.count, error: info._webInit.error }, severity: info._webInit.ok ? 'info' : 'notice' });
  }
  // First start of a profile machine: install its agents in the background.
  const am = agents.get(name);
  if (am && !am.installed && agents.job(name)?.status !== 'running') {
    agents.startInstall(name);
    audit.record({ type: 'exec', machine: name, actor: 'smolvm-web', action: 'установка агентов', detail: { agents: am.agents } });
    info._webInstall = true;
  }
  return info;
}

// ---------- kill switch ----------
// Isolate: refuse and cut everything that goes through smolvm-web, rotate the
// machine's gateway tokens, then pause the VM (state kept for investigation).
async function isolateMachine(name, actor, reason = 'вручную') {
  isolation.set(name, { by: actor, reason });
  const dropped = egress.dropConnections(name);
  approvals.denyMachine(name, actor);
  const rotated = await vault.rotateTokens(name).catch(() => 0);
  let paused = false; let pauseError = null;
  try {
    const st = await machineState(name);
    if (st === 'running') {
      const r = await up.request('POST', `/api/v1/machines/${encodeURIComponent(name)}/pause`, {}, { timeoutMs: 30000 });
      paused = r.status === 200;
      if (!paused) pauseError = r.data?.error || `HTTP ${r.status}`;
    }
  } catch (e) { pauseError = e.message; }
  audit.notify({ machine: name, severity: 'alert', text: `Машина ${name} изолирована (kill switch): оборвано соединений — ${dropped}, токены шлюза заменены — ${rotated}${paused ? ', машина на паузе' : ''}`, detail: { by: actor, reason, pauseError } });
  return { isolated: true, dropped, rotated, paused, pauseError };
}

// «Смертельная триада»: private data + untrusted content + a way out, all at once.
async function lethalTrifecta(name) {
  const r = await up.request('GET', `/api/v1/machines/${encodeURIComponent(name)}`).catch(() => null);
  if (!r || r.status !== 200) return null;
  const vm = r.data;
  const eg = egress.getMachine(name);
  const secrets = await vault.machineSecrets(name).catch(() => []);
  const dm = dirs.getMachine(name);
  const hostMounts = (vm.mounts || []).filter((x) => !/^\/(etc\/smolvm-host-trust|\.smolvm-dirs)/.test(x.target || x.guest || ''));
  const privateData = [
    ...secrets.map((s) => `секрет ${s.name}`),
    ...(dm?.dirs || []).map((d) => `директория ${d.id}`),
    ...hostMounts.map((x) => `папка ${x.source || x.host || ''}${x.readonly ? ' (чтение)' : ''}`),
  ];
  const network = !!vm.network;
  const guarded = !!(eg?.enabled && !eg.learn);
  return {
    privateData, untrusted: network, exfil: network && !guarded,
    exfilWhy: !network ? 'сеть выключена' : !eg?.enabled ? 'фильтр «Доступ в сеть» выключен — машина может отправить данные куда угодно' : eg.learn ? 'включён режим обучения — фильтр пропускает всё' : eg.ask ? 'неизвестные адреса — только с подтверждения человека' : 'только адреса из allow list',
    lethal: privateData.length > 0 && network && !guarded,
  };
}

// Agents past their time limit are stopped (checked every 30 s).
setInterval(async () => {
  for (const o of limits.overdue()) {
    try { await agents.stop(o.machine, o.agent); } catch { limits.endRun(o.machine, o.agent); }
    audit.notify({ machine: o.machine, text: `Агент ${agents.AGENTS[o.agent]?.title || o.agent} на машине ${o.machine} остановлен: лимит времени работы ${o.limitMin} мин`, detail: { agent: o.agent, startedAt: new Date(o.startedAt).toISOString() } });
  }
}, 30000).unref();

// Sandboxes past their lifetime or idle too long are closed: the profile goes to
// review as with «Закрыть»; a machine that is not running is closed without it.
let closingDue = false;
setInterval(async () => {
  if (closingDue) return;
  closingDue = true;
  try {
    const last = (name) => Math.max(gateway.lastActivity(name), new Date(egress.log({ machine: name, limit: 1 })[0]?.ts || 0).getTime());
    for (const d of sandbox.due(last)) {
      let r = null; let note = '';
      try { r = await sandbox.close(d.name, { save: true }, sandboxHooks); }
      catch (e) {
        if (e.status !== 409) { audit.notify({ machine: d.name, text: `Песочницу ${d.name} не удалось закрыть (${d.why}): ${e.message}` }); continue; }
        r = await sandbox.close(d.name, { save: false }, sandboxHooks).catch(() => null);
        note = ' Машина не была запущена — изменения профиля не забраны.';
      }
      if (r) audit.notify({ machine: d.name, severity: 'notice', text: `Песочница ${d.name} закрыта автоматически: ${d.why}.${r.pending ? ` Изменений профиля на проверку: ${r.changes}.` : ''}${note}` });
    }
  } catch {} finally { closingDue = false; }
}, 60000).unref();

// Host folders for the path field of «Дать доступ к папке»: subfolders of what was typed.
const norm = (p) => (process.platform === 'win32' || process.platform === 'darwin' ? String(p).toLowerCase() : String(p));
function suggestFolders(q) {
  const home = require('os').homedir();
  let input = String(q || '').trim();
  if (!input) input = home + path.sep;
  if (input.startsWith('~')) input = home + input.slice(1);
  if (!path.isAbsolute(input)) return [];
  const dir = /[\\/]$/.test(input) ? input : path.dirname(input);
  const prefix = /[\\/]$/.test(input) ? '' : path.basename(input).toLowerCase();
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name.toLowerCase().startsWith(prefix))
    .map((e) => path.join(dir, e.name)).sort().slice(0, 30);
}

// Everything smolvm-web keeps about a machine that is gone.
async function forgetMachine(name) {
  cfg.forgetMachine(name); await vault.forgetMachine(name); egress.forgetMachine(name); dirs.forgetMachine(name); agents.forget(name);
  agentproxy.closeFor(`${name}/`); smolfile.forget(name); review.forget(name); sandbox.forget(name);
  limits.forget(name); isolation.set(name, null);
}
async function deleteMachine(name) {
  const r = await up.request('DELETE', `/api/v1/machines/${encodeURIComponent(name)}?force=true`);
  if (r.status !== 200 && r.status !== 404) throw new Error(`удаление машины ${name}: ${r.data?.error || `HTTP ${r.status}`}`);
  await forgetMachine(name);
}
// Hooks the sandboxes need from the server.
const sandboxHooks = {
  startMachine: (name, o = {}) => startMachine(name, { apiPath: `/api/v1/machines/${encodeURIComponent(name)}/start`, branchable: !!o.branchable }),
  deleteMachine,
};

async function machineState(name) {
  const r = await up.request('GET', `/api/v1/machines/${encodeURIComponent(name)}`);
  return r.status === 200 ? r.data.state : null;
}

// ---------- proxy-aware intercepts ----------
const M = '/api/v1/machines/([^/?]+)';
const ROUTES = [
  // Create: proxy (or egress-filter) env into the workload, secrets bound to
  // the machine, directory views mounted, per-machine proxy opt-out.
  ['POST', /^\/api\/v1\/machines$/, async (req, res, _m, url) => {
    const body = await readJson(req);
    const useProxy = url.searchParams.get('webProxy') !== '0';
    const secretNames = Array.isArray(body._webSecrets) ? body._webSecrets.map(String) : [];
    const eg = body._webEgress && typeof body._webEgress === 'object' ? body._webEgress : null;
    const dirIds = Array.isArray(body._webDirs) ? body._webDirs.map(String) : [];
    // «Папки» of the create dialog: mounted (ro/rw) or review copies made at first start.
    const folderList = (Array.isArray(body._webFolders) ? body._webFolders : []).map((f) => ({ hostPath: String(f?.hostPath || ''), mode: String(f?.mode || ''), guestPath: f?.guestPath ? String(f.guestPath) : undefined }));
    const mountFolders = folderList.filter((f) => f.mode === 'ro' || f.mode === 'rw').map((f) => ({ ...f, level: f.mode }));
    const reviewFolders = folderList.filter((f) => f.mode === 'review');
    delete body._webFolders;
    const profileId = typeof body._webProfile === 'string' && agents.PROFILES[body._webProfile] ? body._webProfile : null;
    const sfMeta = body._webSmolfile && typeof body._webSmolfile === 'object' ? body._webSmolfile : null;
    delete body._webSecrets; delete body._webEgress; delete body._webDirs; delete body._webProfile; delete body._webSmolfile;
    if (profileId) {
      // An agent profile: Debian + Node image, a long-lived workload, published agent ports.
      const p = agents.PROFILES[profileId];
      if (!body.name) return sendJson(res, 400, { error: 'Для машины с профилем укажите имя', code: 'BAD_REQUEST' });
      const exists = await up.request('GET', `/api/v1/machines/${encodeURIComponent(body.name)}`);
      if (exists.status === 200) return sendJson(res, 409, { error: `Машина ${body.name} уже существует`, code: 'CONFLICT' });
      body.image = body.image || p.image;
      body.cpus = body.cpus || p.cpus;
      body.memoryMb = body.memoryMb || p.memoryMb;
      body.network = true;
      if (!body.cmd) body.cmd = ['sh', '-c', 'while true; do sleep 3600; done'];
      agents.forget(body.name);
      const ports = await agents.declare(body.name, p.agents, profileId);
      body.ports = [...(Array.isArray(body.ports) ? body.ports : []), ...ports];
      if (eg?.enabled) eg.rules = [...(Array.isArray(eg.rules) ? eg.rules : []), ...agents.egressRules(profileId)];
    }
    try { dirs.checkFreeMounts(body.mounts); } catch (e) { return sendJson(res, 400, { error: e.message, code: 'BAD_MOUNT' }); }

    if (secretNames.length || eg?.enabled || dirIds.length || folderList.length) {
      if (!body.name) return sendJson(res, 400, { error: 'Для машины с секретами, директориями или egress-фильтром укажите имя', code: 'BAD_REQUEST' });
      const exists = await up.request('GET', `/api/v1/machines/${encodeURIComponent(body.name)}`);
      if (exists.status === 200) return sendJson(res, 409, { error: `Машина ${body.name} уже существует`, code: 'CONFLICT' });
    }
    const cleanup = async () => {
      if (profileId) agents.forget(body.name);
      if (secretNames.length) await vault.forgetMachine(body.name);
      if (eg?.enabled) egress.forgetMachine(body.name);
      if (dirIds.length || mountFolders.length) dirs.forgetMachine(body.name);
    };

    if (eg?.enabled) {
      egress.forgetMachine(body.name); // stale record of a machine with the same name
      try {
        egress.setMachine(body.name, { enabled: true, strict: !!eg.strict, ...(Array.isArray(eg.lists) ? { lists: eg.lists } : {}), ...(Array.isArray(eg.rules) ? { rules: eg.rules } : {}) });
      } catch (e) { egress.forgetMachine(body.name); return sendJson(res, 400, { error: e.message, code: 'BAD_EGRESS' }); }
      const st = await egress.start();
      if (!st.listening) { egress.forgetMachine(body.name); return sendJson(res, 500, { error: `egress-фильтр не запущен: ${st.error}`, code: 'EGRESS_DOWN' }); }
      let p;
      try { p = await mc.effectiveProxy(body.name); } catch (e) { egress.forgetMachine(body.name); return sendJson(res, 400, { error: e.message, code: 'BAD_EGRESS' }); }
      const env = px.proxyEnv(p.url, p.noProxy);
      body.env = px.mergeEnv(body.env, env);
      body.network = true;
      const patch = { envApplied: px.fingerprint(env) };
      if (eg.strict) {
        const ip = await px.hostIp();
        if (!ip) { egress.forgetMachine(body.name); return sendJson(res, 400, { error: 'Жёсткая изоляция: не удалось определить адрес хоста, доступный из машины', code: 'BAD_EGRESS' }); }
        const cidr = `${ip}/32`;
        body.allowedCidrs = [...new Set([...(Array.isArray(body.allowedCidrs) ? body.allowedCidrs : []), cidr])];
        patch.strictApplied = cidr;
      }
      egress.setMachine(body.name, patch);
    } else if (useProxy) {
      const p = await mc.effectiveProxy(null).catch((e) => ({ error: e.message }));
      if (p?.error) return sendJson(res, 400, { error: p.error, code: 'BAD_PROXY' });
      if (p) {
        body.env = px.mergeEnv(body.env, px.proxyEnv(p.url, p.noProxy));
        body.network = true;
      }
    }
    // Corporate CA for smolvm's in-guest image pull (see machines.stagePullTrust).
    if (body.name && useProxy && mc.wantsPullTrust(body.name)) {
      try { body.mounts = [...(Array.isArray(body.mounts) ? body.mounts : []), mc.stagePullTrust()]; }
      catch (e) { await cleanup(); return sendJson(res, 400, { error: `сертификаты для скачивания образа: ${e.message}`, code: 'BAD_CA' }); }
    }
    let dirMounts = [];
    if (dirIds.length || mountFolders.length) {
      try { dirMounts = dirs.attachFoldersAtCreate(body.name, mountFolders, dirIds); } catch (e) { await cleanup(); return sendJson(res, 400, { error: e.message, code: 'BAD_DIR' }); }
      body.mounts = [...(Array.isArray(body.mounts) ? body.mounts : []), ...dirMounts];
    }
    if (secretNames.length) {
      try { await vault.bind(body.name, secretNames); } catch (e) { await cleanup(); return sendJson(res, 400, { error: e.message, code: 'BAD_SECRET' }); }
      const bound = await vault.machineSecrets(body.name);
      const native = bound.filter((x) => x.mode === 'substitute');
      // Substitution values live in `smolvm serve`, so the machine must start through
      // it — under the strict egress floor, which walls off the host and the LAN:
      // the egress filter, the corporate proxy and the secret gateway all live there.
      const viaHost = [
        eg?.enabled && 'фильтр «Сеть»',
        useProxy && (await mc.effectiveProxy(null).catch(() => null)) && 'корпоративный прокси',
        bound.some((x) => x.mode === 'gateway') && 'секреты в режиме «Шлюз»',
      ].filter(Boolean);
      if (native.length && viaHost.length) {
        await cleanup();
        return sendJson(res, 400, {
          code: 'SECRET_MODE_CONFLICT',
          error: `Секрет ${native.map((x) => `«${x.name}»`).join(', ')} в режиме «Подстановка smolvm» нельзя сочетать с: ${viaHost.join(', ')}. `
            + 'Такую машину запускает smolvm serve в строгом режиме, и хост/LAN из неё недоступны. '
            + 'Переведите секрет в режим «Шлюз smolvm-web» (Секреты → Изменить) или снимите эти опции.',
        });
      }
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
    // Pin the network backend smolvm serve would pick anyway, so the machine
    // behaves the same whether it is started through the API or the CLI.
    if (body.network && !body.networkBackend && !body.from && !body.registryRef) body.networkBackend = 'virtio-net';
    url.searchParams.delete('webProxy');
    req.url = url.pathname + (url.search || '');
    // Docker Hub images through the corporate registry (JFrog/Nexus), when configured.
    const origImage = body.image;
    if (body.image) body.image = repos.rewriteImage(body.image);
    let r;
    try { r = await up.request('POST', req.url, body); } catch (e) { await cleanup(); throw e; }
    if (r.status === 200 && r.data && origImage && body.image !== origImage) r.data._webImage = { from: origImage, to: body.image };
    if (r.status === 200 && r.data?.name) {
      cfg.setMachineProxy(r.data.name, useProxy);
      // Records left by a machine of the same name deleted outside smolvm-web must not apply to this one.
      if (!eg?.enabled) egress.forgetMachine(r.data.name);
      if (dirMounts.length) dirs.markApplied(r.data.name, dirMounts);
      else dirs.forgetMachine(r.data.name);
      smolfile.forget(r.data.name);
      if (sfMeta) smolfile.remember(r.data.name, { init: sfMeta.init, env: sfMeta.env, workdir: body.workdir, baseDir: sfMeta.baseDir });
    } else await cleanup();
    if (r.status === 200 && r.data?.name && reviewFolders.length) {
      review.forget(r.data.name);
      const errors = [];
      for (const f of reviewFolders) { try { await review.add(r.data.name, { hostPath: f.hostPath, guestPath: f.guestPath || `/work/${path.basename(f.hostPath)}` }); } catch (e) { errors.push(`${f.hostPath}: ${e.message}`); } }
      if (errors.length) r.data._webFolderErrors = errors;
    }
    if (r.status !== 200 && profileId && !secretNames.length && !eg?.enabled && !dirIds.length) agents.forget(body.name);
    sendJson(res, r.status, r.data);
  }],

  // Start: CLI when the proxy/gateway/egress filter must be reachable, API
  // (with credential values pushed first) for smolvm substitution; then
  // provision the guest.
  // An isolated machine stays frozen: its own network is not ours to cut once it runs.
  ['POST', new RegExp(`^${M}/resume$`), async (req, res, m) => {
    const name = decodeURIComponent(m[1]);
    if (isolation.isIsolated(name)) return sendJson(res, 409, { error: `машина ${name} изолирована — сначала снимите изоляцию`, code: 'ISOLATED' });
    const r = await up.request('POST', req.url, {});
    sendJson(res, r.status, r.data);
  }],
  ['POST', new RegExp(`^${M}/start$`), async (req, res, m, url) => {
    const name = decodeURIComponent(m[1]);
    if (isolation.isIsolated(name)) return sendJson(res, 409, { error: `машина ${name} изолирована — сначала снимите изоляцию`, code: 'ISOLATED' });
    const raw = await readBody(req);
    const body = raw.length ? JSON.parse(raw.toString('utf8') || '{}') || {} : {};
    const branchable = url.searchParams.get('branchable') === 'true' || url.searchParams.get('forkable') === 'true';
    try { sendJson(res, 200, await startMachine(name, { apiPath: req.url, body, branchable })); }
    catch (e) { sendJson(res, e.status || 500, e.body || { error: e.message, code: e.code || 'START_FAILED', ...(e.repairable != null ? { repairable: e.repairable } : {}) }); }
  }],

  // Exec: inject proxy (and CA, once provisioned) env; explicit env wins.
  ['POST', new RegExp(`^${M}/exec(/stream)?$`), async (req, res, m) => {
    const name = decodeURIComponent(m[1]);
    const buf = await readBody(req);
    let body;
    try { body = JSON.parse(buf.toString('utf8') || '{}'); } catch { return forward(req, res, buf); }
    const extra = await mc.execEnv(name);
    if (extra.length) body.env = px.mergeEnv(body.env, extra);
    // Audit: command, user, exit code (from the JSON body or the SSE `exit` event).
    const stream = !!m[2];
    const ev = { type: 'exec', machine: name, actor: actorOf(req), action: 'exec',
      detail: { command: Array.isArray(body.command) ? body.command.join(' ').slice(0, 2000) : String(body.command || ''), user: body.user || null, workdir: body.workdir || null, background: !!body.background, stream } };
    let acc = '';
    res.auditDone = true;
    forward(req, res, Buffer.from(JSON.stringify(body)), {
      data(c) { if (acc.length < 1e6) acc += c.toString('utf8'); },
      end(status) {
        let exitCode = null;
        if (stream) { const mm = acc.match(/event: exit\ndata: \{"exitCode":(-?\d+)\}/g); if (mm) exitCode = Number(mm.pop().match(/(-?\d+)\}$/)[1]); }
        else { const mm = acc.match(/"exitCode":(-?\d+)/); if (mm) exitCode = Number(mm[1]); }
        audit.record({ ...ev, status, exitCode, severity: status >= 400 || (exitCode !== null && exitCode !== 0) ? 'notice' : 'info' });
      },
    });
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
    if (r.status === 200) await forgetMachine(name);
    sendJson(res, r.status, r.data);
  }],

  // Branch: the clone shares the source's mounts and in-memory env, so it inherits its policies.
  ['POST', new RegExp(`^${M}/branches$`), async (req, res, m) => {
    const name = decodeURIComponent(m[1]);
    const body = await readJson(req);
    const r = await up.request('POST', req.url, body);
    if (r.status === 200) {
      const to = r.data?.name || body.name;
      if (to) { dirs.copyMachine(name, to); egress.copyMachine(name, to); }
    }
    sendJson(res, r.status, r.data);
  }],
];

// ---------- /ui endpoints ----------
// Settings for the browser: the repository token never leaves the server.
function publicSettings() {
  const s = cfg.getSettings();
  const { password, ...r } = s.repos;
  return { ...s, ca: { ...s.ca }, repos: { ...r, hasPassword: !!password }, smolvmBinDefault: process.env.SMOLVM_BIN || 'smolvm' };
}

const AG = '^/ui/machines/([^/]+)/agents';
const RV = '^/ui/machines/([^/]+)/review';
const err = (res, e) => sendJson(res, e.status || 500, { error: e.message });
const UI = [
  // ---- audit ----
  ['GET', /^\/ui\/audit$/, (req, res, _m, url) => {
    const p = url.searchParams;
    sendJson(res, 200, { entries: audit.list({ machine: p.get('machine') || '', type: p.get('type') || '', q: p.get('q') || '', limit: Math.min(2000, Number(p.get('limit')) || 500) }), file: audit.file, watched: audit.watched() });
  }],
  ['GET', /^\/ui\/audit\/export$/, (req, res) => {
    let data = '';
    try { data = fs.readFileSync(audit.file); } catch {}
    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'content-disposition': `attachment; filename="smolvm-web-audit-${new Date().toISOString().slice(0, 10)}.jsonl"` });
    res.end(data);
  }],
  ['GET', /^\/ui\/audit\/settings$/, (req, res) => {
    const st = JSON.parse(JSON.stringify(audit.settings()));
    st.siem.http.hasAuthorization = !!st.siem.http.authorization;
    st.siem.http.authorization = '';
    sendJson(res, 200, st);
  }],
  ['PUT', /^\/ui\/audit\/settings$/, async (req, res) => {
    const body = await readJson(req);
    // Empty authorization = keep the stored one (it is never sent back to the UI).
    if (body.siem?.http && !body.siem.http.authorization) delete body.siem.http.authorization;
    try { audit.saveSettings(body); sendJson(res, 200, { ok: true }); } catch (e) { sendJson(res, 400, { error: e.message }); }
  }],
  ['GET', /^\/ui\/audit\/verify$/, (req, res) => sendJson(res, 200, audit.verify())],
  ['POST', /^\/ui\/audit\/test$/, async (req, res) => sendJson(res, 200, await audit.test())],
  ['GET', /^\/ui\/alerts$/, (req, res, _m, url) => sendJson(res, 200, { alerts: audit.alerts(Number(url.searchParams.get('since')) || 0) })],
  // ---- review copies ----
  ['GET', new RegExp(`${RV}$`), (req, res, m) => sendJson(res, 200, { dirs: review.list(decodeURIComponent(m[1])), defaultExclude: review.DEFAULT_EXCLUDE, busy: review.busy(decodeURIComponent(m[1])) })],
  ['POST', new RegExp(`${RV}$`), async (req, res, m) => {
    try { sendJson(res, 200, await review.add(decodeURIComponent(m[1]), await readJson(req))); } catch (e) { err(res, e); }
  }],
  ['GET', new RegExp(`${RV}/([\\w.-]+)$`), async (req, res, m) => {
    try { sendJson(res, 200, await review.changes(decodeURIComponent(m[1]), m[2])); } catch (e) { err(res, e); }
  }],
  ['DELETE', new RegExp(`${RV}/([\\w.-]+)$`), async (req, res, m, url) => {
    try { await review.remove(decodeURIComponent(m[1]), m[2], { deleteCopy: url.searchParams.get('deleteCopy') === '1' }); sendJson(res, 200, { removed: true }); } catch (e) { err(res, e); }
  }],
  ['GET', new RegExp(`${RV}/([\\w.-]+)/diff$`), async (req, res, m, url) => {
    try { sendJson(res, 200, await review.fileDiff(decodeURIComponent(m[1]), m[2], url.searchParams.get('path') || '')); } catch (e) { err(res, e); }
  }],
  ['POST', new RegExp(`${RV}/([\\w.-]+)/(apply|reject|pull|copy)$`), async (req, res, m) => {
    const name = decodeURIComponent(m[1]); const id = m[2]; const op = m[3];
    const body = await readJson(req);
    try {
      let r;
      if (op === 'apply') { r = await review.apply(name, id, body.paths); res.auditDetail = { copy: id, files: r.applied, skipped: r.skipped.length }; }
      else if (op === 'reject') { r = await review.reject(name, id, body.paths); res.auditDetail = { copy: id, files: r.reverted }; }
      else if (op === 'pull') r = await review.reject(name, id, [], { onlyHostAhead: true });
      else { await review.copyIn(name, id); r = { copied: true }; }
      sendJson(res, 200, r);
    } catch (e) { err(res, e); }
  }],
  ['GET', /^\/ui\/preparing$/, (req, res) => {
    const out = preparing();
    for (const j of smolfile.runningInits()) out[j.name] = { label: 'подготовка', step: j.step };
    for (const j of agents.runningJobs()) out[j.name] = { label: 'подготовка', step: `установка агентов: ${j.step}` };
    for (const j of sandbox.templateJobs()) out[j.name] = { label: 'шаблон', step: `шаблон песочницы: ${j.step}` };
    for (const j of sandbox.opening()) out[j.name] = { label: 'песочница', step: j.step };
    sendJson(res, 200, out);
  }],
  ['GET', /^\/ui\/machines\/marks$/, (req, res) => {
    const out = agents.marks();
    for (const n of Object.keys(out)) if (sandbox.isSandbox(n)) out[n].sandbox = true;
    sendJson(res, 200, out);
  }],

  // ---- sandboxes ----
  ['GET', /^\/ui\/sandbox$/, async (req, res) => sendJson(res, 200, await sandbox.overview())],
  ['POST', /^\/ui\/sandbox\/templates$/, async (req, res) => {
    const b = await readJson(req);
    res.auditDone = true;
    try { const r = await sandbox.createTemplate({ source: String(b.source || ''), title: b.title, id: b.id }, sandboxHooks.startMachine); sendJson(res, 200, r); } catch (e) { err(res, e); }
  }],
  ['DELETE', /^\/ui\/sandbox\/templates\/([\w-]+)$/, (req, res, m) => {
    try { sandbox.deleteTemplate(m[1]); sendJson(res, 200, { ok: true }); } catch (e) { err(res, e); }
  }],
  ['POST', /^\/ui\/sandbox\/open$/, async (req, res) => {
    const b = await readJson(req);
    res.auditDone = true;
    try { sendJson(res, 200, await sandbox.open({ template: String(b.template || ''), profile: b.profile ? String(b.profile) : null, agent: b.agent ? String(b.agent) : null }, sandboxHooks)); } catch (e) { err(res, e); }
  }],
  ['POST', /^\/ui\/sandbox\/machines\/([^/]+)\/close$/, async (req, res, m) => {
    const b = await readJson(req);
    res.auditDone = true;
    try { sendJson(res, 200, await sandbox.close(decodeURIComponent(m[1]), { save: b.save !== false }, sandboxHooks)); } catch (e) { err(res, e); }
  }],
  ['GET', /^\/ui\/sandbox\/policy$/, (req, res) => sendJson(res, 200, sandbox.getPolicy())],
  ['PUT', /^\/ui\/sandbox\/policy$/, async (req, res) => {
    const b = await readJson(req);
    try { sendJson(res, 200, sandbox.setPolicy(b)); } catch (e) { err(res, e); }
  }],
  ['POST', /^\/ui\/sandbox\/machines\/([^/]+)\/extend$/, async (req, res, m) => {
    const b = await readJson(req);
    try { sendJson(res, 200, sandbox.extend(decodeURIComponent(m[1]), b.hours)); } catch (e) { err(res, e); }
  }],
  ['GET', /^\/ui\/sandbox\/machines\/([^/]+)\/changes$/, async (req, res, m) => {
    try { sendJson(res, 200, await sandbox.previewChanges(decodeURIComponent(m[1]))); } catch (e) { err(res, e); }
  }],
  ['POST', /^\/ui\/sandbox\/profiles$/, async (req, res) => {
    const b = await readJson(req);
    try { sendJson(res, 200, await sandbox.createProfile({ name: b.name, from: b.from ? String(b.from) : null, template: b.template ? String(b.template) : null, agent: b.agent ? String(b.agent) : null })); } catch (e) { err(res, e); }
  }],
  ['PUT', /^\/ui\/sandbox\/profiles\/([\w-]+)$/, async (req, res, m) => {
    const b = await readJson(req);
    try { sendJson(res, 200, sandbox.updateProfile(m[1], b)); } catch (e) { err(res, e); }
  }],
  ['DELETE', /^\/ui\/sandbox\/profiles\/([\w-]+)$/, (req, res, m) => {
    try { sandbox.deleteProfile(m[1]); sendJson(res, 200, { ok: true }); } catch (e) { err(res, e); }
  }],
  ['GET', /^\/ui\/sandbox\/profiles\/([\w-]+)\/files$/, (req, res, m) => {
    try { sendJson(res, 200, { files: sandbox.profileFiles(m[1]) }); } catch (e) { err(res, e); }
  }],
  ['GET', /^\/ui\/sandbox\/profiles\/([\w-]+)\/file$/, (req, res, m, url) => {
    try { sendJson(res, 200, sandbox.profileFile(m[1], url.searchParams.get('path'))); } catch (e) { err(res, e); }
  }],
  ['PUT', /^\/ui\/sandbox\/profiles\/([\w-]+)\/file$/, async (req, res, m, url) => {
    const b = await readJson(req);
    try { sandbox.putProfileFile(m[1], url.searchParams.get('path'), b.text); sendJson(res, 200, { ok: true }); } catch (e) { err(res, e); }
  }],
  ['DELETE', /^\/ui\/sandbox\/profiles\/([\w-]+)\/file$/, (req, res, m, url) => {
    try { sandbox.deleteProfileFile(m[1], url.searchParams.get('path')); sendJson(res, 200, { ok: true }); } catch (e) { err(res, e); }
  }],
  ['GET', /^\/ui\/sandbox\/pending\/([\w.-]+)$/, (req, res, m) => {
    try { sendJson(res, 200, sandbox.pendingSummary(m[1])); } catch (e) { err(res, e); }
  }],
  ['GET', /^\/ui\/sandbox\/pending\/([\w.-]+)\/diff$/, (req, res, m, url) => {
    try { sendJson(res, 200, sandbox.pendingDiff(m[1], url.searchParams.get('path'))); } catch (e) { err(res, e); }
  }],
  ['POST', /^\/ui\/sandbox\/pending\/([\w.-]+)\/apply$/, async (req, res, m) => {
    const b = await readJson(req);
    try { sendJson(res, 200, sandbox.applyPending(m[1], Array.isArray(b.paths) ? b.paths.map(String) : [])); } catch (e) { err(res, e); }
  }],
  ['DELETE', /^\/ui\/sandbox\/pending\/([\w.-]+)$/, async (req, res, m, url) => {
    const paths = url.searchParams.getAll('path');
    try { sendJson(res, 200, sandbox.dropPending(m[1], paths)); } catch (e) { err(res, e); }
  }],
  // Smolfile -> API create request (+ init, warnings); see lib/smolfile.js.
  ['POST', /^\/ui\/smolfile\/parse$/, async (req, res) => {
    const body = await readJson(req);
    try { sendJson(res, 200, smolfile.toRequest(body.content, { baseDir: body.baseDir })); }
    catch (e) { sendJson(res, e.status || 500, { error: e.message, code: 'SMOLFILE' }); }
  }],
  ['GET', /^\/ui\/profiles$/, (req, res) => sendJson(res, 200, { profiles: agents.profiles() })],
  ['GET', new RegExp(`${AG}$`), async (req, res, m) => sendJson(res, 200, await agents.status(decodeURIComponent(m[1])))],
  // Attach agents to an existing machine: ports are published on the next start.
  ['POST', new RegExp(`${AG}$`), async (req, res, m) => {
    const name = decodeURIComponent(m[1]);
    const { add = [] } = await readJson(req);
    const ids = add.filter((id) => agents.AGENTS[id]);
    if (!ids.length) return sendJson(res, 400, { error: 'не выбраны агенты' });
    await agents.declare(name, ids);
    const st = await machineState(name);
    sendJson(res, 200, { restartNeeded: st === 'running', ...(await agents.status(name)) });
  }],
  // Vendor servers ("Провайдеры") of every machine with agents — no guest exec, for the «Сеть» page.
  ['GET', /^\/ui\/agents\/vendors$/, async (req, res) => {
    // Only machines that still exist (records can outlive a machine deleted outside smolvm-web).
    const r = await up.request('GET', '/api/v1/machines').catch(() => null);
    const exists = new Set((r?.data?.machines || []).map((m) => m.name));
    sendJson(res, 200, { machines: agents.names().filter((n) => exists.has(n)).map((n) => ({ name: n, vendor: agents.vendorEndpoints(n), filter: { enabled: !!egress.getMachine(n)?.enabled } })).filter((x) => x.vendor.length) });
  }],
  // Allow or revoke a vendor server of the machine's agents (egress filter rule, live).
  ['PUT', new RegExp(`${AG}/vendor$`), async (req, res, m) => {
    const name = decodeURIComponent(m[1]);
    const { host, allowed } = await readJson(req);
    try {
      const vendor = agents.setVendor(name, String(host || ''), !!allowed);
      res.auditDetail = { host, allowed: !!allowed };
      sendJson(res, 200, { vendor, filter: { enabled: !!egress.getMachine(name)?.enabled } });
    } catch (e) { sendJson(res, 400, { error: e.message }); }
  }],
  ['POST', new RegExp(`${AG}/install$`), async (req, res, m) => {
    const name = decodeURIComponent(m[1]);
    if (!agents.get(name)) await agents.declare(name, ['terminal']);
    if ((await machineState(name)) !== 'running') return sendJson(res, 409, { error: 'Запустите машину, чтобы установить агентов' });
    agents.startInstall(name);
    sendJson(res, 200, await agents.status(name));
  }],
  ['POST', new RegExp(`${AG}/([\\w-]+)/start$`), async (req, res, m) => {
    const name = decodeURIComponent(m[1]);
    const body = await readJson(req);
    try { sendJson(res, 200, await agents.start(name, m[2], { autonomous: !!body.autonomous })); }
    catch (e) { sendJson(res, 400, { error: e.message }); }
  }],
  ['POST', new RegExp(`${AG}/([\\w-]+)/stop$`), async (req, res, m) => {
    try { await agents.stop(decodeURIComponent(m[1]), m[2]); sendJson(res, 200, { stopped: true }); }
    catch (e) { sendJson(res, 400, { error: e.message }); }
  }],
  ['GET', new RegExp(`${AG}/([\\w-]+)/open$`), async (req, res, m) => {
    try { sendJson(res, 200, await agents.open(decodeURIComponent(m[1]), m[2])); }
    catch (e) { sendJson(res, 400, { error: e.message }); }
  }],
  ['GET', new RegExp(`${AG}/([\\w-]+)/log$`), async (req, res, m) => {
    try { sendJson(res, 200, { log: await agents.logTail(decodeURIComponent(m[1]), m[2], 20000) }); }
    catch (e) { sendJson(res, 400, { error: e.message }); }
  }],
  // Human approvals and isolation state, polled by the UI.
  ['GET', /^\/ui\/live$/, (req, res) => sendJson(res, 200, { approvals: approvals.list(), isolated: isolation.all() })],
  ['POST', /^\/ui\/approvals\/([\w-]+)$/, async (req, res, m) => {
    const { decision } = await readJson(req);
    res.auditDone = true; // approvals.decide() writes its own audit record
    sendJson(res, approvals.decide(m[1], decision, actorOf(req)) ? 200 : 404, { ok: true });
  }],
  ['POST', /^\/ui\/machines\/([^/]+)\/isolate$/, async (req, res, m) => {
    const name = decodeURIComponent(m[1]);
    const { on = true } = await readJson(req);
    res.auditDone = true;
    if (on) return sendJson(res, 200, await isolateMachine(name, actorOf(req)));
    isolation.set(name, null);
    audit.notify({ machine: name, severity: 'notice', text: `Изоляция машины ${name} снята. Машина остаётся на паузе; агентов перезапустите — у них новые токены шлюза.`, detail: { by: actorOf(req) } });
    sendJson(res, 200, { isolated: false });
  }],
  ['POST', /^\/ui\/isolate-all$/, async (req, res) => {
    res.auditDone = true;
    const list = await up.request('GET', '/api/v1/machines').catch(() => null);
    const names = (list?.data?.machines || []).filter((x) => x.state === 'running').map((x) => x.name);
    const results = {};
    await Promise.all(names.map(async (n) => { results[n] = await isolateMachine(n, actorOf(req), 'остановить всех агентов').catch((e) => ({ error: e.message })); }));
    sendJson(res, 200, { machines: results });
  }],
  ['GET', /^\/ui\/machines\/([^/]+)\/limits$/, (req, res, m) => {
    const name = decodeURIComponent(m[1]);
    sendJson(res, 200, { limits: limits.get(name), usage: limits.usage(name), runs: limits.runs(name) });
  }],
  ['PUT', /^\/ui\/machines\/([^/]+)\/limits$/, async (req, res, m) => {
    const name = decodeURIComponent(m[1]);
    try { sendJson(res, 200, { limits: limits.set(name, await readJson(req)), usage: limits.usage(name) }); } catch (e) { sendJson(res, 400, { error: e.message }); }
  }],
  ['GET', /^\/ui\/machines\/([^/]+)\/risk$/, async (req, res, m) => sendJson(res, 200, { trifecta: await lethalTrifecta(decodeURIComponent(m[1])) })],
  ['GET', /^\/ui\/info$/, async (req, res) => {
    const s = cfg.getSettings();
    const sys = upproxy.systemMode();
    const g = sys ? null : s.proxy.url ? await px.guestUrl(s.proxy.url) : null;
    sendJson(res, 200, {
      version: VERSION,
      build: { ...buildInfo.RUNNING, disk: buildInfo.current() },
      platform: process.platform, home: require("os").homedir(),
      upstream: up.UPSTREAM,
      listen: up.listenArg(),
      configDir: cfg.DIR,
      smolvmBin: mc.smolvmBin(),
      imagePrefix: repos.imagePrefix(),
      reposActive: repos.active() || !!cfg.getSettings().repos.registry,
      proxyActive: upproxy.active(),
      proxySystem: sys,
      relay: sys ? relay.status() : null,
      caActive: !!s.ca.enabled,
      guestProxy: g,
      egress: { ...egress.status(), defaults: egress.defaults() },
      winHost: winhost.status(),
      dirsStrict: dirs.strict(),
    });
  }],
  // Windows: delete agent rootfs extractions smolvm left without symlinks (no /sbin/init).
  ['POST', /^\/ui\/host\/repair-rootfs$/, (req, res) => {
    try { const r = winhost.repair(); res.auditDetail = { removed: r.removed }; sendJson(res, 200, { ...r, status: winhost.status() }); }
    catch (e) { sendJson(res, e.status || 500, { error: e.message }); }
  }],
  ['GET', /^\/ui\/settings$/, (req, res) => sendJson(res, 200, publicSettings())],
  ['PUT', /^\/ui\/settings$/, async (req, res) => {
    const body = await readJson(req);
    if (body.proxy?.url) body.proxy.url = px.normalizeUrl(body.proxy.url);
    if (body.proxy?.enabled && body.proxy.url && !body.proxy.system) {
      try { new URL(body.proxy.url); } catch { return sendJson(res, 400, { error: 'Некорректный URL прокси' }); }
    }
    if (body.ca?.enabled) {
      try { px.buildBundle({ ...cfg.getSettings().ca, ...body.ca }); }
      catch (e) { return sendJson(res, 400, { error: `CA: ${e.message}` }); }
    }
    // Sections and fields the request leaves out keep their current values.
    const cur = cfg.getSettings();
    const next = {};
    for (const k of Object.keys(cur)) next[k] = { ...cur[k], ...(body[k] && typeof body[k] === 'object' ? body[k] : {}) };
    if (body.repos && !body.repos.password) next.repos.password = body.repos.clearPassword ? '' : cur.repos.password;
    delete next.repos.clearPassword; delete next.repos.hasPassword;
    next.smolvm.bin = String(next.smolvm.bin || '').trim().replace(/^"(.*)"$/, '$1');
    try { repos.validate(next.repos); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    if (next.proxy.system && process.platform !== 'win32') next.proxy.system = false;
    cfg.saveSettings(next);
    try { repos.dockerConfigDir(); } catch {}
    sysproxy.reset();
    if (upproxy.systemMode()) await relay.start();
    sendJson(res, 200, publicSettings());
  }],
  // «Виртуализация» in the settings: the installed CLI and the running API.
  ['GET', /^\/ui\/smolvm\/info$/, async (req, res) => {
    const bin = mc.smolvmBin();
    const cli = await new Promise((resolve) => execFile(bin, ['--version'], { timeout: 15000, windowsHide: true }, (err, stdout, stderr) => resolve(err
      ? { ok: false, error: err.code === 'ENOENT' ? 'файл не найден — укажите путь ниже' : (stderr || err.message).trim().slice(0, 200) }
      : { ok: true, version: String(stdout || stderr).trim().split('\n')[0] })));
    let api = { ok: false, upstream: up.UPSTREAM };
    try {
      const r = await up.request('GET', '/health', undefined, { timeoutMs: 2000 });
      api = { ok: r.status === 200, version: r.data?.version || '', upstream: up.UPSTREAM };
    } catch {}
    const hypervisor = { win32: 'Windows Hypervisor Platform', darwin: 'Hypervisor.framework (macOS)', linux: 'KVM (/dev/kvm)' }[process.platform] || process.platform;
    sendJson(res, 200, { bin, cli, api, hypervisor });
  }],
  // Does this smolvm binary run? (`smolvm --version`)
  ['POST', /^\/ui\/smolvm\/check$/, async (req, res) => {
    const { bin } = await readJson(req);
    const exe = String(bin || '').trim().replace(/^"(.*)"$/, '$1') || mc.smolvmBin();
    execFile(exe, ['--version'], { timeout: 15000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return sendJson(res, 200, { ok: false, bin: exe, error: err.code === 'ENOENT' ? 'файл не найден' : (stderr || err.message).trim().slice(0, 300) });
      sendJson(res, 200, { ok: true, bin: exe, version: String(stdout || stderr).trim().split('\n')[0] });
    });
  }],
  ['GET', /^\/ui\/proxy\/detect$/, async (req, res) => {
    const d = await px.detect();
    if (process.platform === 'win32') {
      sysproxy.reset();
      d.system = await sysproxy.describe().catch((e) => ({ available: false, error: e.message }));
      d.sspi = await sspi.status();
    }
    sendJson(res, 200, d);
  }],
  ['POST', /^\/ui\/proxy\/test$/, async (req, res) => {
    const body = await readJson(req);
    const targets = ['registry-1.docker.io:443', 'production.cloudfront.docker.com:443', 'pypi.org:443', 'registry.npmjs.org:443'];
    if (body.system) {
      // Windows system proxy: the route per destination (PAC) and the sign-in used, then the relay as machines see it.
      if (process.platform !== 'win32') return sendJson(res, 400, { error: 'Системный прокси Windows доступен только на Windows' });
      sysproxy.reset();
      const prev = cfg.getSettings().proxy;
      const results = (await upproxy.test(targets, { ...prev, enabled: true, system: true, noProxy: body.noProxy ?? prev.noProxy }))
        .map((x) => ({ ...x, status: x.ok ? `${x.route}${x.auth ? `, вход: ${x.auth === 'Negotiate' ? 'Kerberos/Negotiate' : x.auth}` : ''}` : x.error }));
      // The relay works with the saved settings: checked once they are saved.
      let relayReach = null;
      if (upproxy.systemMode()) {
        try { relayReach = await px.testConnect(await relay.urlFor(), targets[0], 30000); } catch (e) { relayReach = { ok: false, target: targets[0], error: e.message }; }
      }
      return sendJson(res, 200, { results, relay: relayReach, sspi: await sspi.status() });
    }
    const url = body.url || cfg.getSettings().proxy.url;
    if (!url) return sendJson(res, 400, { error: 'Не указан адрес прокси' });
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
    const am = agents.get(name);
    const agentPorts = am ? am.agents.filter((id) => am.ports?.[id]).map((id) => ({ id, title: agents.AGENTS[id].title, host: am.ports[id], guest: agents.AGENTS[id].port })) : [];
    sendJson(res, 200, { useProxy: cfg.machineUsesProxy(name), provisioned: cfg.getProvisioned(name) || null, secrets, agentPorts });
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
  // ---------- egress filter (allow lists) ----------
  ['GET', /^\/ui\/egress$/, async (req, res) => {
    sendJson(res, 200, { ...egress.view(), hostIp: await px.hostIp(), corporateProxy: upproxy.active() });
  }],
  ['PUT', /^\/ui\/egress\/settings$/, async (req, res) => {
    try { sendJson(res, 200, egress.saveSettings(await readJson(req))); } catch (e) { sendJson(res, 400, { error: e.message }); }
  }],
  ['PUT', /^\/ui\/egress\/lists\/([^/]+)$/, async (req, res, m) => {
    try { sendJson(res, 200, egress.saveList(decodeURIComponent(m[1]), await readJson(req))); } catch (e) { sendJson(res, 400, { error: e.message }); }
  }],
  ['DELETE', /^\/ui\/egress\/lists\/([^/]+)$/, async (req, res, m) => {
    egress.deleteList(decodeURIComponent(m[1]));
    sendJson(res, 200, { deleted: true });
  }],
  ['PUT', /^\/ui\/egress\/machines\/([^/]+)$/, async (req, res, m) => {
    const name = decodeURIComponent(m[1]);
    const body = await readJson(req);
    const before = egress.getMachine(name);
    let after;
    try { after = egress.setMachine(name, body); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    const notes = [];
    if (after.enabled) {
      const st = await egress.start();
      if (!st.listening) notes.push(`egress-фильтр не запущен: ${st.error}`);
    }
    const state = await machineState(name).catch(() => null);
    const toggled = !before || before.enabled !== after.enabled || before.strict !== after.strict || !!body.rotate;
    if (state === 'running' && toggled) {
      // Console/exec env follows at once; the guest profile is rewritten now; the workload's own env and the strict policy on the next start.
      try { await mc.provision(name); notes.push('Настройки прокси в машине обновлены (profile.d, pip, npm, apt, git).'); } catch (e) { notes.push(`не удалось обновить настройки в машине: ${e.message}`); }
      notes.push('Основной процесс машины и жёсткая изоляция переключатся при следующем запуске через smolvm-web.');
    }
    sendJson(res, 200, { machine: egress.view().machines[name], notes });
  }],
  ['GET', /^\/ui\/egress\/machines\/([^/]+)\/learned$/, (req, res, m) => sendJson(res, 200, { learned: egress.learned(decodeURIComponent(m[1])) })],
  ['POST', /^\/ui\/egress\/machines\/([^/]+)\/learn\/finish$/, async (req, res, m) => {
    const name = decodeURIComponent(m[1]);
    const body = await readJson(req);
    try { sendJson(res, 200, egress.finishLearning(name, body)); } catch (e) { sendJson(res, 400, { error: e.message }); }
  }],
  ['GET', /^\/ui\/egress\/log$/, (req, res, _m, url) => {
    const p = url.searchParams;
    sendJson(res, 200, { entries: egress.log({ machine: p.get('machine') || '', decision: p.get('decision') || '', q: p.get('q') || '', limit: Math.min(Number(p.get('limit')) || 300, 3000) }) });
  }],
  ['GET', /^\/ui\/egress\/denied$/, (req, res, _m, url) => sendJson(res, 200, { denied: egress.deniedSummary(url.searchParams.get('machine') || '') })],
  // Allow a destination (from the log): into a list or into the machine's own rules.
  ['POST', /^\/ui\/egress\/allow$/, async (req, res) => {
    const { machine, host, ports, into, note } = await readJson(req);
    try {
      const rule = egress.normalizeRule({ host, ports, note: note || (machine ? `разрешено из журнала (${machine})` : '') });
      if (into === 'machine') {
        const mm = egress.getMachine(machine);
        if (!mm) throw new Error(`Машина ${machine} не под egress-фильтром`);
        egress.setMachine(machine, { rules: [...mm.rules, rule] });
      } else {
        const list = egress.view().lists.find((l) => l.id === into);
        if (!list) throw new Error('Нет такого списка');
        egress.saveList(list.id, { ...list, rules: [...list.rules, rule] });
      }
      sendJson(res, 200, { rule });
    } catch (e) { sendJson(res, 400, { error: e.message }); }
  }],
  ['POST', /^\/ui\/egress\/check$/, async (req, res) => {
    const { machine, target } = await readJson(req);
    try { sendJson(res, 200, egress.explain(machine, target)); } catch (e) { sendJson(res, 400, { error: e.message }); }
  }],

  // ---------- allowed directories ----------
  ['GET', /^\/ui\/dirs$/, (req, res) => sendJson(res, 200, { strict: dirs.strict(), dirs: dirs.listDirs(), platform: process.platform })],
  ['PUT', /^\/ui\/dirs-settings$/, async (req, res) => {
    const body = await readJson(req);
    sendJson(res, 200, { strict: dirs.setStrict(!!body.strict) });
  }],
  ['PUT', /^\/ui\/dirs\/([^/]+)$/, async (req, res, m) => {
    try { sendJson(res, 200, dirs.saveDir(decodeURIComponent(m[1]), await readJson(req))); } catch (e) { sendJson(res, 400, { error: e.message }); }
  }],
  ['DELETE', /^\/ui\/dirs\/([^/]+)$/, async (req, res, m) => {
    try { dirs.deleteDir(decodeURIComponent(m[1])); sendJson(res, 200, { deleted: true }); } catch (e) { sendJson(res, 400, { error: e.message }); }
  }],
  // ---- «Дать доступ к папке»: one call registers, attaches and applies ----
  ['GET', /^\/ui\/folders\/check$/, (req, res, _m, url) => sendJson(res, 200, dirs.checkFolder(url.searchParams.get('path')))],
  ['GET', /^\/ui\/folders\/suggest$/, (req, res, _m, url) => sendJson(res, 200, { paths: suggestFolders(url.searchParams.get('q') || '') })],
  ['GET', /^\/ui\/machines\/([^/]+)\/folders$/, async (req, res, m) => {
    const name = decodeURIComponent(m[1]);
    const state = await machineState(name).catch(() => null);
    const copies = review.list(name).map((d) => ({ kind: 'review', id: d.id, hostPath: d.hostPath, guestPath: d.guestPath, level: 'review', state: d.state, error: d.error || null }));
    // smolvm volumes set at create (Smolfile `volumes`, the «Тома smolvm» field): shown, not managed.
    const info = await up.request('GET', `/api/v1/machines/${encodeURIComponent(name)}`).catch(() => null);
    const volumes = (info?.data?.mounts || []).filter((x) => !String(x.target).startsWith(`${dirs.BASE}/`) && x.target !== px.GUEST_TRUST_DIR)
      .map((x) => ({ kind: 'volume', id: x.tag || x.target, hostPath: x.source, guestPath: x.target, level: x.readonly ? 'ro' : 'rw' }));
    sendJson(res, 200, { state, agent: !!agents.get(name), agentUser: dirs.AGENT_USER, folders: [...dirs.folders(name), ...copies, ...volumes] });
  }],
  ['POST', /^\/ui\/machines\/([^/]+)\/folders$/, async (req, res, m) => {
    const name = decodeURIComponent(m[1]);
    const b = await readJson(req);
    const mode = String(b.mode || '');
    const state = await machineState(name).catch(() => null);
    if (!state) return sendJson(res, 404, { error: `машина ${name} не найдена` });
    const c = dirs.checkFolder(b.hostPath);
    if (!c.ok) return sendJson(res, 400, { error: `${c.real || b.hostPath}: ${c.error}` });
    const guestPath = String(b.guestPath || '').trim() || `/work/${path.basename(c.real)}`;
    // One guest path, one folder: mounted folders and review copies must not overlap.
    const clash = (p, q) => p === q || p.startsWith(`${q}/`) || q.startsWith(`${p}/`);
    const others = [...dirs.folders(name).filter((f) => f.guestPath && norm(f.hostPath) !== norm(c.real)), ...review.list(name).filter((d) => norm(d.hostPath) !== norm(c.real))];
    const hit = others.find((f) => clash(f.guestPath, guestPath));
    if (hit) return sendJson(res, 400, { error: `Путь в машине ${guestPath} уже занят папкой ${hit.hostPath}` });
    try {
      // Switching between a mount and a review copy of the same folder: drop the other kind.
      const sameDir = dirs.folders(name).find((f) => f.hostPath && norm(f.hostPath) === norm(c.real) && !f.removed);
      const sameCopy = review.list(name).find((d) => norm(d.hostPath) === norm(c.real));
      let out;
      if (mode === 'review') {
        if (sameDir) {
          dirs.revoke(name, sameDir.id);
          // Close the gate and drop the link before the copy takes its path.
          if (state === 'running') await mc.provisionDirs(name).catch(() => null);
        }
        if (sameCopy) await review.remove(name, sameCopy.id, { deleteCopy: true });
        const d = await review.add(name, { hostPath: c.real, guestPath });
        out = { kind: 'review', id: d.id, guestPath: d.guestPath };
      } else if (mode === 'ro' || mode === 'rw') {
        // The copy (and its unapplied changes — the UI asks first) gives way to the link.
        if (sameCopy) await review.remove(name, sameCopy.id, { deleteCopy: true });
        out = { kind: 'dir', ...dirs.grant(name, { hostPath: c.real, level: mode, guestPath }) };
      } else return sendJson(res, 400, { error: 'Режим: ro, rw или review' });
      let report = null;
      if (out.kind === 'dir' && state === 'running') {
        try { report = await mc.provisionDirs(name); } catch (e) { report = { errors: [e.message], warnings: [], users: [] }; }
      }
      const pending = dirs.mountDiff(name);
      res.auditDetail = { hostPath: c.real, mode, guestPath: out.guestPath };
      sendJson(res, 200, { ...out, state, report, needsRestart: state === 'running' && (pending.add.length + pending.remove.length) > 0 });
    } catch (e) { sendJson(res, 400, { error: e.message }); }
  }],
  ['DELETE', /^\/ui\/machines\/([^/]+)\/folders\/(dir|review)\/([\w.-]+)$/, async (req, res, m) => {
    const name = decodeURIComponent(m[1]);
    try {
      if (m[2] === 'review') await review.remove(name, m[3], {});
      else {
        dirs.revoke(name, m[3]);
        if ((await machineState(name).catch(() => null)) === 'running') await mc.provisionDirs(name).catch(() => null);
      }
      sendJson(res, 200, { ok: true });
    } catch (e) { sendJson(res, 400, { error: e.message }); }
  }],
  ['GET', /^\/ui\/machines\/([^/]+)\/dirs$/, (req, res, m) => sendJson(res, 200, dirs.machineView(decodeURIComponent(m[1])))],
  ['PUT', /^\/ui\/machines\/([^/]+)\/dirs$/, async (req, res, m) => {
    const name = decodeURIComponent(m[1]);
    try { dirs.saveMachine(name, await readJson(req)); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    const view = dirs.machineView(name);
    const state = await machineState(name).catch(() => null);
    let report = null;
    // Per-user changes inside mounted views apply at once.
    if (state === 'running') {
      try { report = await mc.provisionDirs(name); } catch (e) { report = { errors: [e.message], warnings: [], users: [] }; }
    }
    sendJson(res, 200, { ...view, state, report });
  }],
  ['POST', /^\/ui\/machines\/([^/]+)\/dirs\/apply$/, async (req, res, m) => {
    try { sendJson(res, 200, await mc.provisionDirs(decodeURIComponent(m[1]))); } catch (e) { sendJson(res, 500, { error: e.message }); }
  }],
  ['POST', /^\/ui\/machines\/([^/]+)\/dirs\/verify$/, async (req, res, m) => {
    try { sendJson(res, 200, await dirs.verify(decodeURIComponent(m[1]))); } catch (e) { sendJson(res, 500, { error: e.message }); }
  }],
  // Stop and start through smolvm-web, so pending mounts and the strict policy are applied.
  ['POST', /^\/ui\/machines\/([^/]+)\/restart$/, async (req, res, m) => {
    const name = decodeURIComponent(m[1]);
    if (isolation.isIsolated(name)) return sendJson(res, 409, { error: `машина ${name} изолирована — сначала снимите изоляцию`, code: 'ISOLATED' });
    const state = await machineState(name);
    if (state === 'running' || state === 'paused') {
      const r = await up.request('POST', `/api/v1/machines/${encodeURIComponent(name)}/stop`, {});
      if (r.status !== 200) return sendJson(res, r.status, r.data);
    }
    try { sendJson(res, 200, await startMachine(name, { apiPath: `/api/v1/machines/${encodeURIComponent(name)}/start` })); }
    catch (e) { sendJson(res, e.status || 500, e.body || { error: e.message, code: e.code || 'START_FAILED', ...(e.repairable != null ? { repairable: e.repairable } : {}) }); }
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
  if ((isApi || isUi) && mutating) auditRequest(req, res, url);
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
  if (upproxy.active()) {
    // Windows system proxy: smolvm serve goes through the relay (it cannot do Kerberos/NTLM itself).
    let url = s.proxy.url;
    if (upproxy.systemMode()) { try { url = await relay.urlFor({ loopback: true }); } catch (e) { console.error(e.message); } }
    // The settings win over whatever proxy the environment carries.
    for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) env[k] = url;
    const np = px.noProxyList(s.proxy.noProxy);
    env.NO_PROXY = np;
    env.no_proxy = np;
  }
  console.log(`Запуск: ${mc.smolvmBin()} serve start --listen ${listen}`);
  // Log to a file, not a pipe: on Windows smolvm's children inherit pipe handles.
  const logPath = path.join(cfg.DIR, 'smolvm-serve.log');
  fs.mkdirSync(cfg.DIR, { recursive: true });
  const fd = fs.openSync(logPath, 'a');
  const child = spawn(mc.smolvmBin(), ['serve', 'start', '--listen', listen], { stdio: ['ignore', fd, fd], env: repos.cliEnv(env), windowsHide: true });
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
  console.log(`smolvm-web ${VERSION}${buildInfo.RUNNING.commit ? ` (${buildInfo.RUNNING.commit.slice(0, 7)})` : ''}: http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`);
  console.log(`настройки: ${cfg.DIR}`);
  if (winhost.IS_WIN) {
    const wh = winhost.status();
    if (wh.symlinks === false && !wh.ready) console.log(`ВНИМАНИЕ: нет права создавать символические ссылки, а rootfs smolvm ещё не распакован. smolvm распакует его без ссылок, и машины не загрузятся (/sbin/init: ENOENT). Что сделать: ${winhost.SYMLINK_FIX}.`);
    if (wh.broken.length) console.log(`ВНИМАНИЕ: rootfs smolvm распакован без символических ссылок: ${wh.broken.join(', ')}. Машины не загрузятся — нажмите «Починить» в интерфейсе.`);
  }
  if (upproxy.systemMode()) {
    relay.start().then((st) => console.log(st.listening ? `системный прокси Windows: ретранслятор для машин на порту ${relay.PORT}` : `ретранслятор прокси не запущен: ${st.error}`));
  }
  maybeAutostart();
  vault.list().then(async (list) => {
    if (list.some((x) => x.mode === 'gateway')) {
      const st = await gateway.start();
      console.log(st.listening ? `шлюз секретов: порт ${gateway.PORT}` : `шлюз секретов не запущен: ${st.error}`);
    }
  }).catch((e) => console.log(`хранилище секретов: ${e.message}`));
  if (egress.anyEnabled()) {
    egress.start().then((st) => console.log(st.listening ? `egress-фильтр: порт ${egress.PORT}` : `egress-фильтр не запущен: ${st.error}`));
  }
});
