'use strict';
// Projects: a git repository on this computer with how its tasks start — the agent,
// the trust level and a setup script. With a setup script the project gets its own
// template: the agent's program image with the project in /work/<name> already set up
// (dependencies installed), so a task starts in seconds with everything in place.
//
//   build — a machine from the agent's image (its network and secrets), the current
//           tree of the repository copied in, the setup script run as the agent user
//           in the project folder, then a checkpoint; the build machine is deleted.
//   task  — opened from the project template (or the agent's image while there is
//           none); the repository comes in as for any task: the current HEAD, with
//           tracked files replaced and ignored ones (the prepared dependencies) kept.

const crypto = require('crypto');
const path = require('path');
const cfg = require('./config');
const up = require('./upstream');

const store = cfg.doc('projects.json', { projects: {} });
const S = () => store.get();
const save = () => store.save(S());
const fail = (status, msg) => Object.assign(new Error(msg), { status });
const builds = new Map(); // project id -> { status, step, error, log, machine, startedAt }
const SETUP_TIMEOUT = 30 * 60;

function get(id) {
  const p = S().projects[id];
  if (!p) throw fail(404, 'проект не найден');
  return p;
}

const guestDir = (hostPath) => `/work/${path.basename(hostPath).replace(/[^A-Za-z0-9_.-]/g, '_') || 'project'}`;

async function normalize(body, p = {}) {
  const sandbox = require('./sandbox');
  if (body.name !== undefined) p.name = String(body.name || '').trim().slice(0, 60);
  if (body.hostPath !== undefined) {
    const r = await require('./gitwork').inspect(String(body.hostPath || '').trim());
    if (!r.ok) throw fail(400, r.error);
    if (!r.git) throw fail(400, 'проект — это git-репозиторий с коммитами: результат задач возвращается веткой');
    p.hostPath = r.real;
  }
  if (body.profile !== undefined) {
    if (!sandbox.profile(body.profile)) throw fail(400, 'агент не найден');
    p.profile = body.profile;
  }
  if (body.trust !== undefined) p.trust = ['careful', 'normal', 'trusted'].includes(body.trust) ? body.trust : null;
  if (body.setup !== undefined) p.setup = String(body.setup || '').replace(/\r\n/g, '\n').trim().slice(0, 8000) || null;
  if (!p.name) p.name = p.hostPath ? path.basename(p.hostPath) : '';
  if (!p.name) throw fail(400, 'укажите название проекта');
  if (!p.hostPath) throw fail(400, 'укажите папку проекта');
  if (!p.profile) throw fail(400, 'выберите агента');
  return p;
}

async function create(body) {
  const p = await normalize(body, {});
  if (Object.values(S().projects).some((x) => x.hostPath === p.hostPath)) throw fail(409, 'проект с этой папкой уже есть');
  let id;
  do id = `pr-${crypto.randomBytes(3).toString('hex')}`; while (S().projects[id]);
  Object.assign(p, { id, createdAt: Date.now(), updatedAt: Date.now(), template: null, builtAt: null, builtFrom: null, buildError: null });
  S().projects[id] = p;
  save();
  return view(p);
}

// What a change means for the template: a new agent or setup script makes it stale.
async function update(id, body) {
  const p = get(id);
  const before = JSON.stringify([p.profile, p.setup, p.hostPath]);
  await normalize(body, p);
  p.updatedAt = Date.now();
  if (JSON.stringify([p.profile, p.setup, p.hostPath]) !== before && p.template) p.stale = true;
  save();
  return view(p);
}

function remove(id) {
  const p = get(id);
  if (builds.get(id)?.status === 'running') throw fail(409, 'шаблон проекта собирается — дождитесь');
  if (p.template) { try { require('./sandbox').deleteTemplate(p.template); } catch (e) { throw fail(409, `шаблон проекта: ${e.message}`); } }
  for (const t of p.oldTemplates || []) { try { require('./sandbox').deleteTemplate(t); } catch {} }
  delete S().projects[id];
  save();
}

// ---------- the template ----------
function build(id, hooks) {
  const p = get(id);
  if (!p.setup) throw fail(400, 'у проекта нет скрипта подготовки — шаблон не нужен, задачи открываются из образа агента');
  if (builds.get(id)?.status === 'running') throw fail(409, 'шаблон уже собирается');
  const job = { status: 'running', step: 'подготовка', error: null, log: '', machine: null, startedAt: Date.now() };
  builds.set(id, job);
  (async () => {
    const sandbox = require('./sandbox');
    const gitwork = require('./gitwork');
    const prof = sandbox.profile(p.profile);
    let machine = null;
    let tpl = null;
    try {
      if (!prof) throw new Error('агент проекта удалён');
      const base = sandbox.template(sandbox.baseTemplateOf(prof));
      const slug = path.basename(p.hostPath).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'project';
      machine = `prj-${slug}-${crypto.randomBytes(2).toString('hex')}`;
      job.machine = machine;
      job.step = 'машина из образа агента';
      await sandbox.machineFromTemplate(base, machine, prof);
      // The agent's network: its white lists; unknown addresses are refused (nobody answers here).
      const egress = require('./egress');
      if (prof.net) egress.setMachine(machine, prof.net !== 'off' ? { enabled: true, lists: prof.lists || [], rules: [], ask: false } : { enabled: false, ask: false });
      else egress.setMachine(machine, { ask: false });
      await hooks.startMachine(machine, {});
      await up.waitReady(machine, 120000);
      job.step = 'копия проекта';
      const { head, guestUser } = await gitwork.copyTree(p.hostPath, machine, guestDir(p.hostPath));
      job.step = 'скрипт подготовки';
      // As the agent user, with the proxy and mirrors the agents get; the script on stdin.
      const env = await require('./machines').execEnv(machine).catch(() => []);
      const r = await up.exec(machine, { command: ['bash', '-c', `cd '${guestDir(p.hostPath)}' && exec bash -e`], stdin: `${p.setup}\n`,
        user: guestUser, env, timeoutSecs: SETUP_TIMEOUT }, (SETUP_TIMEOUT + 30) * 1000);
      job.log = `${r.stdout || ''}${r.stderr ? `\n${r.stderr}` : ''}`.slice(-6000);
      if (r.exitCode !== 0) throw new Error(`скрипт подготовки завершился с кодом ${r.exitCode}`);
      // The repository itself comes with each task; what stays is what the script made.
      await up.exec(machine, { command: ['sh', '-c', `rm -rf '${guestDir(p.hostPath)}/.git'`], user: '0', timeoutSecs: 60 });
      job.step = 'снимок';
      const t = await sandbox.createTemplate({ source: machine, title: `Проект ${p.name}`, auto: { project: p.id } }, hooks.startMachine);
      tpl = t.id;
      for (;;) {
        const j = sandbox.templateJob(t.id);
        if (j?.status === 'error') throw new Error(`снимок: ${j.error}`);
        if (j?.status === 'ok') break;
        job.step = `снимок: ${j?.step || '…'}`;
        await new Promise((x) => setTimeout(x, 2000));
      }
      const old = p.template;
      Object.assign(p, { template: t.id, builtAt: Date.now(), builtFrom: head.slice(0, 8), buildError: null, stale: false });
      save();
      // The old template goes now, or once its open tasks are closed (sweep).
      if (old && old !== t.id) { p.oldTemplates = [...(p.oldTemplates || []), old]; save(); sweep(p); }
      job.status = 'ok'; job.step = 'готово';
      require('./audit').record({ type: 'sandbox', machine, actor: 'smolvm-web', action: 'шаблон проекта собран', detail: { project: p.id, template: t.id, from: head } });
    } catch (e) {
      job.status = 'error'; job.error = e.message;
      p.buildError = e.message;
      save();
      if (tpl) { try { require('./sandbox').deleteTemplate(tpl); } catch {} }
    } finally {
      if (machine) await hooks.deleteMachine(machine).catch(() => {});
    }
  })();
  return job;
}

// Templates replaced by a rebuild while tasks were open from them: delete the free ones.
function sweep(p) {
  const sandbox = require('./sandbox');
  const left = (p.oldTemplates || []).filter((t) => {
    if (!sandbox.template(t)) return false;
    try { sandbox.deleteTemplate(t); return false; } catch { return true; }
  });
  if (left.length !== (p.oldTemplates || []).length) { p.oldTemplates = left; save(); }
}

// How a task of the project opens: its agent, folder, trust, template.
function taskDefaults(id, body) {
  const p = get(id);
  const sandbox = require('./sandbox');
  const prof = sandbox.profile(p.profile);
  if (!prof) throw fail(409, 'агент проекта удалён — выберите другого в проекте');
  const tpl = p.template && sandbox.template(p.template) && !p.stale ? p.template : null;
  return {
    ...body,
    profile: p.profile,
    agent: body.agent || prof.agent || null,
    trust: body.trust || p.trust || prof.trust || null,
    folders: [{ hostPath: p.hostPath, mode: 'review' }, ...(Array.isArray(body.folders) ? body.folders.filter((f) => f?.hostPath && f.hostPath !== p.hostPath) : [])],
    template: tpl || '',
  };
}

function view(p) {
  const job = builds.get(p.id) || null;
  const t = p.template ? require('./sandbox').template(p.template) : null;
  return { ...p, build: job && { status: job.status, step: job.step, error: job.error, log: job.log, startedAt: job.startedAt },
    templateReady: !!t && !p.stale, templateSize: t?.size || null };
}

module.exports = {
  list: () => { const all = Object.values(S().projects); all.forEach(sweep); return all.sort((a, b) => a.name.localeCompare(b.name)).map(view); },
  get: (id) => view(get(id)),
  create, update, remove, build, taskDefaults,
  // A build machine is not a sandbox and not a user machine.
  isBuildMachine: (name) => [...builds.values()].some((j) => j.machine === name && j.status === 'running'),
};
