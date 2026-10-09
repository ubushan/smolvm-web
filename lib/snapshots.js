'use strict';
// Snapshots (smolvm checkpoints) and one-click rollback.
//
// A snapshot is `smolvm machine checkpoint` of a running machine: RAM, CPU
// state and disks, taken in well under a second of pause. Rollback deletes the
// machine and creates it again from the checkpoint through the HTTP API (so it
// stays in `smolvm serve`'s registry) under the same name — every smolvm-web
// setting keyed by the name (agents, secrets, filter, review copies) carries
// over. Before a rollback the current state is saved as a safety snapshot, and
// if the restore fails the machine is brought back from it.
//
// smolvm limits: on macOS the machine must run with --branchable; machines
// with host folder mounts (-v), GPU/CUDA, a Docker socket etc. cannot be
// captured.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');
const up = require('./upstream');

const store = cfg.doc('snapshots.json', { keep: 10, machines: {} });
const ROOT = path.join(cfg.DIR, 'checkpoints');
const enc = encodeURIComponent;
const busy = new Map(); // name -> what is running (snapshot / rollback)

const S = () => store.get();
const M = (name) => S().machines[name] || { branchable: false, items: [] };
function setM(name, m) { const s = S(); s.machines[name] = m; store.save(s); }

function dirOf(name) {
  const safe = name.replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(ROOT, safe);
}

async function info(name) {
  const r = await up.request('GET', `/api/v1/machines/${enc(name)}`);
  if (r.status !== 200) throw Object.assign(new Error(r.data?.error || 'машина не найдена'), { status: r.status });
  return r.data;
}

// Why this machine cannot be captured right now (null when it can).
function blocker(m) {
  if (m.state !== 'running') return 'машина не запущена — снимок делается с работающей машины';
  // A CLI start with --branchable does not set the record's flag; we remember the pid we started that way.
  const runBranchable = m.branchable || (m.pid && S().machines[m.name]?.branchablePid === m.pid);
  if (process.platform === 'darwin' && !runBranchable) return 'на macOS снимок требует запуска с ветвлением (branchable) — перезапустите машину кнопкой «Перезапустить с ветвлением»';
  if (m.mounts?.length) {
    const trustOnly = m.mounts.every((x) => x.target === '/etc/smolvm-host-trust');
    if (trustOnly) return 'к машине подключён том с корпоративными сертификатами для скачивания образа (/etc/smolvm-host-trust) — smolvm не снимает машины с томами хоста. Если образ уже скачан, выключите в настройках «Доверять им при скачивании образа» и перезапустите машину через smolvm-web — том отключится';
    return `к машине подключены папки хоста (${m.mounts.map((x) => x.target).join(', ')}) — smolvm не снимает такие машины. Для агентов используйте рабочие копии (вкладка «Изменения»)`;
  }
  if (m.gpu || m.cuda) return 'smolvm не снимает машины с GPU/CUDA';
  if (m.network && !m.networkBackend && !m.ports?.length && !m.allowedHosts && !m.allowedCidrs) {
    return 'у машины не задан сетевой режим явно: smolvm восстановит её с другим сетевым устройством, и откат не запустится. Пересоздайте машину в smolvm-web (новые машины получают virtio-net явно) или используйте машину с портами/агентами';
  }
  return null;
}

function list(name) {
  return M(name).items.slice().sort((a, b) => b.createdAt - a.createdAt).map((x) => ({
    id: x.id, label: x.label, reason: x.reason, createdAt: x.createdAt, size: x.size, safety: !!x.safety,
    exists: fs.existsSync(x.file),
  }));
}

async function status(name) {
  let m = null;
  try { m = await info(name); } catch {}
  return {
    items: list(name),
    keep: S().keep,
    wantsBranchable: !!M(name).branchable,
    branchable: !!(m?.branchable || (m?.pid && M(name).branchablePid === m.pid)),
    running: m?.state === 'running',
    blocker: m ? blocker(m) : 'машина не найдена',
    busy: busy.get(name) || null,
  };
}

async function create(name, { label, reason, safety } = {}) {
  if (busy.get(name) && !safety) throw Object.assign(new Error(`уже выполняется: ${busy.get(name)}`), { status: 409 });
  const m = await info(name);
  const why = blocker(m);
  if (why) throw Object.assign(new Error(why), { status: 400 });
  const mc = require('./machines');
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(2).toString('hex')}`;
  const dir = dirOf(name);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${id}.checkpoint`);
  if (!safety) busy.set(name, 'снимок');
  try {
    await mc.runCli(['machine', 'checkpoint', '--name', name, '-o', file], { timeoutMs: 20 * 60 * 1000 });
  } catch (e) {
    fs.rm(file, { force: true }, () => {});
    throw Object.assign(new Error(`снимок не удался: ${e.message}`), { status: 500 });
  } finally {
    if (!safety) busy.delete(name);
  }
  const size = fs.statSync(file).size;
  // smolvm-web state that lives outside the machine and must roll back with it.
  const extra = { review: require('./review').exportState(name) };
  const cur = M(name);
  cur.items.push({ id, file, label: String(label || '').slice(0, 120) || null, reason: reason || 'вручную', createdAt: Date.now(), size, safety: !!safety, extra });
  setM(name, cur);
  prune(name);
  return list(name).find((x) => x.id === id);
}

// Keep the newest `keep` regular snapshots (safety ones: the newest 2).
function prune(name) {
  const cur = M(name);
  const keep = S().keep;
  const sorted = cur.items.slice().sort((a, b) => b.createdAt - a.createdAt);
  const regular = sorted.filter((x) => !x.safety);
  const safety = sorted.filter((x) => x.safety);
  const drop = [...regular.slice(keep), ...safety.slice(2)];
  for (const x of drop) fs.rm(x.file, { force: true }, () => {});
  cur.items = cur.items.filter((x) => !drop.includes(x));
  setM(name, cur);
}

function remove(name, id) {
  const cur = M(name);
  const x = cur.items.find((i) => i.id === id);
  if (!x) throw Object.assign(new Error('снимок не найден'), { status: 404 });
  fs.rm(x.file, { force: true }, () => {});
  cur.items = cur.items.filter((i) => i !== x);
  setM(name, cur);
}

// Recreate the machine from a checkpoint under the same name.
// `startMachine` is the server's start (provisioning, agents, filter).
async function rollback(name, id, startMachine) {
  if (busy.get(name)) throw Object.assign(new Error(`уже выполняется: ${busy.get(name)}`), { status: 409 });
  const cur = M(name);
  const target = cur.items.find((i) => i.id === id);
  if (!target) throw Object.assign(new Error('снимок не найден'), { status: 404 });
  if (!fs.existsSync(target.file)) throw Object.assign(new Error('файл снимка пропал с диска'), { status: 410 });
  busy.set(name, 'откат');
  const notes = [];
  try {
    const m = await info(name).catch(() => null);
    // 1. Safety snapshot of the current state, when the machine can be captured.
    let safety = null;
    if (m && !blocker(m)) {
      try { safety = await create(name, { reason: `перед откатом к ${new Date(target.createdAt).toLocaleString()}`, safety: true }); notes.push('текущее состояние сохранено страховочным снимком'); }
      catch (e) { notes.push(`страховочный снимок не сделан: ${e.message}`); }
    }
    // 2. Replace the machine.
    if (m) {
      const d = await up.request('DELETE', `/api/v1/machines/${enc(name)}?force=true`);
      if (d.status !== 200) throw new Error(`не удалось удалить текущую машину: ${d.data?.error || d.status}`);
    }
    const restore = async (file) => {
      const r = await up.request('POST', '/api/v1/machines', { name, from: file });
      if (r.status !== 200) throw new Error(r.data?.error || `HTTP ${r.status}`);
    };
    try {
      await restore(target.file);
    } catch (e) {
      const back = safety && M(name).items.find((i) => i.id === safety.id);
      if (back) {
        await restore(back.file).catch(() => {});
        throw new Error(`восстановление из снимка не удалось (${e.message}); машина возвращена из страховочного снимка`);
      }
      throw new Error(`восстановление из снимка не удалось: ${e.message}`);
    }
    require('./review').importState(name, target.extra?.review);
    // 3. Start it like any machine (branchable, so it can be captured again).
    const want = M(name);
    want.branchable = true;
    setM(name, want);
    try {
      const started = await startMachine(name);
      return { ok: true, notes, machine: started };
    } catch (e) {
      // The restored machine does not boot: go back to the safety snapshot.
      const back = safety && M(name).items.find((i) => i.id === safety.id);
      if (!back) throw new Error(`восстановленная машина не запустилась: ${e.message}`);
      await up.request('DELETE', `/api/v1/machines/${enc(name)}?force=true`).catch(() => {});
      await restore(back.file);
      require('./review').importState(name, back.extra?.review);
      await startMachine(name).catch(() => {});
      throw new Error(`восстановленная машина не запустилась (${e.message}); возвращено состояние из страховочного снимка`);
    }
  } finally {
    busy.delete(name);
  }
}

module.exports = {
  status, create, remove, rollback, list,
  wantsBranchable: (name) => !!M(name).branchable,
  setWantsBranchable(name, on) { const m = M(name); m.branchable = !!on; setM(name, m); },
  markBranchableRun(name, pid) { if (!pid) return; const m = M(name); m.branchablePid = pid; setM(name, m); },
  busy: (name) => busy.get(name) || null,
  running: () => [...busy].map(([n, what]) => ({ name: n, step: what })),
  forget(name) {
    const m = S().machines[name];
    if (!m) return;
    for (const x of m.items) fs.rm(x.file, { force: true }, () => {});
    fs.rm(dirOf(name), { recursive: true, force: true }, () => {});
    const s = S(); delete s.machines[name]; store.save(s);
  },
  setKeep(n) { const s = S(); s.keep = Math.max(1, Math.min(100, Number(n) || 10)); store.save(s); },
};
