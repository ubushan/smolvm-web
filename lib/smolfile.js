'use strict';
// Create machines from a Smolfile.
//
// The Smolfile is parsed here (strictly, like smolvm: unknown keys are errors)
// and turned into a regular HTTP API create request, so the machine is a normal
// `smolvm serve` machine: exec, files, logs, agents, the «Доступ в сеть» filter and
// secrets all work. (`smolvm machine create -s` would put it outside the
// server's in-memory registry until the server restarts.)
//
// `init` runs once as root on the first start, after smolvm-web has written
// the proxy/CA configuration, with the Smolfile's env.

const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const up = require('./upstream');
const { parse } = require('./toml');

const store = cfg.doc('smolfile.json', { machines: {} });
const MAX = 256 * 1024;
const KEEPALIVE = ['sh', '-c', 'while true; do sleep 3600; done'];

const KNOWN = new Set(['image', 'entrypoint', 'cmd', 'env', 'secrets', 'workdir', 'user', 'cpus', 'memory', 'net',
  'net_backend', 'gpu', 'gpu_vram', 'rosetta', 'cuda', 'auto_graph', 'docker_socket', 'storage', 'overlay', 'block_io',
  'disk_durability', 'ports', 'volumes', 'init', 'artifact', 'pack', 'dev', 'network', 'branch', 'fork', 'health',
  'restart', 'stop_on_exit', 'auth', 'service']);
// Keys smolvm applies only through its own CLI paths; the HTTP API has no field for them.
const CLI_ONLY = {
  user: 'пользователь workload', gpu_vram: 'объём VRAM', rosetta: 'Rosetta', disk_durability: 'режим записи диска',
  artifact: 'настройки упаковки', pack: 'настройки упаковки', dev: 'раздел [dev] (smolvm dev)', branch: 'раздел [branch]',
  fork: 'раздел [fork]', health: 'проверки здоровья [health]', auth: 'раздел [auth] (SSH-агент)', service: 'раздел [service]',
};

const get = (name) => store.get().machines[name] || null;
function set(name, value) {
  const s = store.get();
  s.machines[name] = value;
  store.save(s);
}
function forget(name) {
  const s = store.get();
  if (s.machines[name]) { delete s.machines[name]; store.save(s); }
}

const err = (msg) => Object.assign(new Error(msg), { status: 400 });
const strArr = (v, key) => {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw err(`«${key}» должен быть массивом строк`);
  return v;
};
const posInt = (v, key, max = 1e9) => {
  if (!Number.isInteger(v) || v <= 0 || v > max) throw err(`«${key}» должен быть положительным целым`);
  return v;
};

function parsePorts(list) {
  const out = [];
  const range = (s) => {
    const m = /^(\d+)(?:-(\d+))?$/.exec(s.trim());
    if (!m) return null;
    const a = Number(m[1]); const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b > 65535 || b < a) return null;
    return [a, b];
  };
  for (const p of strArr(list, 'ports')) {
    const [l, r] = p.split(':');
    const host = range(l); const guest = r === undefined ? host : range(r);
    if (!host || !guest || p.split(':').length > 2) throw err(`порт «${p}»: ожидается "8080", "8080:80" или "5173-5180:5173-5180"`);
    if (host[1] - host[0] !== guest[1] - guest[0]) throw err(`порт «${p}»: диапазоны разной длины`);
    for (let k = 0; k <= host[1] - host[0]; k++) out.push({ host: host[0] + k, guest: guest[0] + k });
  }
  if (out.length > 64) throw err('не больше 64 портов');
  return out;
}

function parseVolumes(list, baseDir) {
  return strArr(list, 'volumes').map((v) => {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) throw err(`том «${v}»: удалённые тома (s3:// и т.п.) через API smolvm не поддерживаются`);
    let rest = v; let readonly = false; let staged = false;
    const mode = /:(ro|rw|staged)$/.exec(rest);
    if (mode) { readonly = mode[1] === 'ro'; staged = mode[1] === 'staged'; rest = rest.slice(0, -mode[0].length); }
    const drive = /^([A-Za-z]:[\\/])/.exec(rest);
    const at = rest.indexOf(':', drive ? drive[1].length : 0);
    if (at < 1) throw err(`том «${v}»: ожидается "папка_хоста:/путь_в_машине[:ro|rw|staged]"`);
    let source = rest.slice(0, at);
    const target = rest.slice(at + 1);
    if (!target.startsWith('/')) throw err(`том «${v}»: путь в машине должен быть абсолютным`);
    if (!path.isAbsolute(source)) {
      if (!baseDir) throw err(`том «${v}»: относительный путь — укажите «Папку проекта»`);
      source = path.resolve(baseDir, source);
    }
    if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) throw err(`том «${v}»: нет такой папки ${source}`);
    return { source, target, readonly, ...(staged ? { staged: true } : {}) };
  });
}

// Smolfile text -> { request (API create body), init, env, warnings }.
function toRequest(content, { baseDir } = {}) {
  if (!String(content || '').trim()) throw err('Smolfile пустой');
  if (content.length > MAX) throw err('Smolfile больше 256 КБ');
  if (baseDir) {
    baseDir = path.resolve(String(baseDir));
    if (!fs.existsSync(baseDir) || !fs.statSync(baseDir).isDirectory()) throw err(`папка проекта не найдена: ${baseDir}`);
  }
  let sf;
  try { sf = parse(content); } catch (e) { throw err(`Smolfile: ${e.message}`); }

  const unknown = Object.keys(sf).filter((k) => !KNOWN.has(k));
  if (unknown.length) throw err(`неизвестные ключи: ${unknown.join(', ')} (Smolfile, как и smolvm, не допускает лишних ключей)`);
  const warnings = [];
  const body = {};

  if (sf.image !== undefined) { if (typeof sf.image !== 'string') throw err('«image» — строка'); body.image = sf.image; }
  if (sf.entrypoint !== undefined) body.entrypoint = strArr(sf.entrypoint, 'entrypoint');
  if (sf.cmd !== undefined) body.cmd = strArr(sf.cmd, 'cmd');
  const env = sf.env === undefined ? [] : strArr(sf.env, 'env').map((kv) => {
    const at = kv.indexOf('=');
    if (at < 1) throw err(`env «${kv}»: ожидается KEY=VALUE`);
    return { name: kv.slice(0, at), value: kv.slice(at + 1) };
  });
  if (env.length) body.env = env;
  if (sf.workdir !== undefined) body.workdir = String(sf.workdir);
  if (sf.cpus !== undefined) body.cpus = posInt(sf.cpus, 'cpus', 255);
  if (sf.memory !== undefined) body.memoryMb = posInt(sf.memory, 'memory');
  if (sf.net !== undefined) body.network = !!sf.net;
  if (sf.net_backend !== undefined) body.networkBackend = String(sf.net_backend);
  for (const [k, api] of [['gpu', 'gpu'], ['cuda', 'cuda'], ['auto_graph', 'autoGraph'], ['docker_socket', 'dockerSocket']]) {
    if (sf[k] !== undefined) body[api] = !!sf[k];
  }
  if (sf.storage !== undefined) body.storageGb = posInt(sf.storage, 'storage');
  if (sf.overlay !== undefined) body.overlayGb = posInt(sf.overlay, 'overlay');
  if (sf.block_io !== undefined) body.blockIo = String(sf.block_io);
  if (sf.ports !== undefined) body.ports = parsePorts(sf.ports);
  if (sf.volumes !== undefined) body.mounts = parseVolumes(sf.volumes, baseDir);
  const init = sf.init === undefined ? [] : strArr(sf.init, 'init');

  if (sf.secrets && Object.keys(sf.secrets).length) {
    throw err('[secrets] (from_env / from_file) HTTP API smolvm не принимает — значения нельзя передать с хоста. Используйте «Секреты» smolvm-web: режим «Шлюз» (ключ не попадает в машину) или «Переменная».');
  }
  if (sf.network !== undefined) {
    const n = sf.network;
    const nk = Object.keys(n).filter((k) => !['allow_hosts', 'allow_host_patterns', 'allow_cidrs', 'credentials'].includes(k));
    if (nk.length) throw err(`[network]: неизвестные ключи ${nk.join(', ')}`);
    if (n.allow_hosts !== undefined) body.allowedHosts = strArr(n.allow_hosts, 'network.allow_hosts');
    if (n.allow_cidrs !== undefined) body.allowedCidrs = strArr(n.allow_cidrs, 'network.allow_cidrs');
    if (n.allow_host_patterns && n.allow_host_patterns.length) {
      throw err('[network] allow_host_patterns через HTTP API не поддерживается, а замена на allow_hosts ослабила бы ограничение (разрешила бы поддомены). Используйте allow_hosts или фильтр «Доступ в сеть» smolvm-web (правила вида api.example.com и *.example.com).');
    }
    if (n.credentials && n.credentials.length) {
      throw err('[[network.credentials]]: значения ключей smolvm берёт из окружения хоста, а через HTTP API их передать нельзя. Создайте секрет в «Секретах» smolvm-web (режим «Шлюз» или «Подстановка smolvm») и отметьте его ниже.');
    }
  }
  if (sf.restart !== undefined) {
    const r = sf.restart;
    body.restart = {};
    if (r.policy !== undefined) body.restart.policy = String(r.policy);
    if (r.max_retries !== undefined) body.restart.maxRetries = Number(r.max_retries);
    if (r.max_backoff !== undefined) warnings.push('restart.max_backoff пропущен — через HTTP API не задаётся');
  }
  if (sf.stop_on_exit) warnings.push('stop_on_exit пропущен — через HTTP API не задаётся');
  for (const [k, what] of Object.entries(CLI_ONLY)) if (sf[k] !== undefined) warnings.push(`${k} (${what}) пропущен — применяется только CLI smolvm`);
  if (!body.cmd && !body.entrypoint) {
    body.cmd = KEEPALIVE;
    warnings.push('cmd не задан — машина держится командой sleep, чтобы workload образа не завершался сразу');
  }
  return { request: body, init, env, warnings, baseDir: baseDir || null };
}

// Remember what has to run on the first start.
function remember(name, { init, env, workdir, baseDir }) {
  init = (Array.isArray(init) ? init : []).filter((c) => typeof c === 'string');
  env = (Array.isArray(env) ? env : []).filter((e) => e && typeof e.name === 'string' && typeof e.value === 'string');
  set(name, { init: init || [], env: env || [], workdir: workdir || null, baseDir: baseDir || null, initPending: (init || []).length > 0, createdAt: Date.now() });
}

const running = new Map(); // name -> current init step, while init runs

// Run `init` once, as root, with the Smolfile env on top of smolvm-web's env.
async function runInit(name) {
  const m = get(name);
  if (!m?.initPending) return null;
  running.set(name, 'init: ожидание машины');
  try { return await runInitInner(name, m); } finally { running.delete(name); }
}
async function runInitInner(name, m) {
  const mc = require('./machines');
  await up.waitReady(name, 90000);
  const base = await mc.execEnv(name);
  const envMap = new Map(base.map((e) => [e.name, e.value]));
  for (const e of m.env) envMap.set(e.name, e.value);
  const env = [...envMap].map(([n, v]) => ({ name: n, value: v }));
  let log = '';
  for (const [k, cmd] of m.init.entries()) {
    running.set(name, `init ${k + 1}/${m.init.length}: ${cmd.slice(0, 80)}`);
    log += `$ ${cmd}\n`;
    const r = await up.exec(name, { command: ['sh', '-c', cmd], env, user: '0', ...(m.workdir ? { workdir: m.workdir } : {}), timeoutSecs: 1800 }, 1830 * 1000);
    log += r.stdout + (r.stderr ? r.stderr : '');
    if (!log.endsWith('\n')) log += '\n';
    if (r.exitCode !== 0) {
      log += `[exit ${r.exitCode}]\n`;
      return { ok: false, error: `init #${k + 1} завершилась с кодом ${r.exitCode}: ${cmd}`, log: tidy(log) };
    }
  }
  set(name, { ...m, initPending: false, initAt: Date.now() });
  return { ok: true, count: m.init.length, log: tidy(log) };
}

// Strip ANSI/progress-bar control sequences for display.
function tidy(s) {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b[78]/g, '').replace(/[^\n]*\r(?!\n)/g, '').slice(-60000);
}

module.exports = { toRequest, remember, runInit, forget, get, initPending: (name) => !!get(name)?.initPending, initRunning: (name) => running.get(name) || null, runningInits: () => [...running].map(([n, step]) => ({ name: n, step })) };
