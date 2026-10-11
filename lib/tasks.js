'use strict';
// Tasks: what a person asked an agent to do, and what came of it. A task outlives its
// machine — the machine is how it runs, the git branch and the profile changes are
// its result. A sandbox opened from anywhere is a task.
//
//   persistent — a session that is not closed by itself (no lifetime, no idle close);
//                «Сбросить» replaces its machine with a clean one from the template,
//                the branch carrying the work over.
//
// Status is computed, never stored:
//   opening · working · waiting (a person must decide) · stopped · lost (machine gone
//   without close) — while open; review (a branch or profile change to decide) · done.

const crypto = require('crypto');
const cfg = require('./config');
const up = require('./upstream');

const store = cfg.doc('tasks.json', { tasks: {} });
const S = () => store.get();
const save = () => store.save(S());
const fail = (status, msg) => Object.assign(new Error(msg), { status });
const KEEP_CLOSED = 300;

function get(id) {
  const t = S().tasks[id];
  if (!t) throw fail(404, 'задача не найдена');
  return t;
}

const titleOf = (text, folders, agent) => {
  const line = String(text || '').split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean);
  if (line) return line.slice(0, 120);
  const dir = folders?.[0]?.hostPath?.split(/[\\/]/).filter(Boolean).pop();
  return `Сессия${agent ? ` ${agent}` : ''}${dir ? ` · ${dir}` : ''}`;
};

// sandbox.open() calls this for every new sandbox.
function record({ machine, text, agent, profile, template, trust, persistent, folders }) {
  let id;
  do id = `t-${crypto.randomBytes(3).toString('hex')}`; while (S().tasks[id]);
  S().tasks[id] = { id, title: titleOf(text, folders, agent), text: text || null, agent: agent || null, profile: profile || null,
    template: template || null, trust: trust || null, persistent: !!persistent,
    folders: (folders || []).map((f) => ({ hostPath: f.hostPath, mode: f.mode, git: f.git || null })),
    machine, machines: [machine], createdAt: Date.now(), closedAt: null, resets: 0 };
  prune();
  save();
  return id;
}

// A reset put the task into a new machine.
function attach(id, machine) {
  const t = get(id);
  Object.assign(t, { machine, closedAt: null, lost: false });
  t.machines = [...(t.machines || []), machine].slice(-20);
  save();
}

function closed(id, { saved }) {
  const t = S().tasks[id];
  if (!t || t.closedAt) return;
  Object.assign(t, { closedAt: Date.now(), saved: !!saved });
  save();
}

// The machine was deleted without «Закрыть» (from «Машины», or it vanished).
function machineGone(id, machine) {
  const t = S().tasks[id];
  if (!t || t.closedAt || t.machine !== machine) return;
  Object.assign(t, { closedAt: Date.now(), lost: true });
  save();
}

function prune() {
  const old = Object.values(S().tasks).filter((t) => t.closedAt).sort((a, b) => b.closedAt - a.closedAt).slice(KEEP_CLOSED);
  for (const t of old) delete S().tasks[t.id];
}

async function machinesNow() {
  const r = await up.request('GET', '/api/v1/machines').catch(() => null);
  return new Map((r?.data?.machines || []).map((m) => [m.name, m]));
}

// Everything about a task the screens need, with its status.
function view(t, machines) {
  const sandbox = require('./sandbox');
  const gitwork = require('./gitwork');
  const approvals = require('./approvals').list().filter((a) => !t.closedAt && a.machine === t.machine);
  const git = t.folders.filter((f) => f.git).map((f) => { try { return gitwork.get(f.git); } catch { return null; } }).filter(Boolean);
  const profilePending = sandbox.pendingList().filter((p) => (t.machines || [t.machine]).includes(p.sandbox));
  const sb = sandbox.record(t.machine);
  const m = machines.get(t.machine);
  const undecided = git.some((g) => g.state === 'ready') || profilePending.length > 0;
  let status;
  if (t.closedAt) status = undecided ? 'review' : t.lost ? 'lost' : 'done';
  else if (sandbox.opening().some((o) => o.name === t.machine)) status = 'opening';
  else if (!m) status = 'lost';
  else if (approvals.length) status = 'waiting';
  else if (m.state === 'running') status = 'working';
  else status = 'stopped';
  return { ...t, status, machineState: m?.state || null,
    expiresAt: sb?.expiresAt || null, idleMinutes: sb?.idleMinutes || 0,
    approvals, git, profilePending: profilePending.map((p) => ({ id: p.id, changes: p.changes?.length ?? p.count ?? 0 })),
    result: { commits: git.reduce((n, g) => n + (g.commits || 0), 0), branches: git.filter((g) => g.tip && !['discarded', 'merged'].includes(g.state)).map((g) => g.branch),
      merged: git.filter((g) => g.state === 'merged').map((g) => g.mergedInto) } };
}

async function list() {
  const machines = await machinesNow();
  const order = { waiting: 0, review: 1, opening: 2, working: 3, stopped: 4, lost: 5, done: 6 };
  return Object.values(S().tasks).map((t) => view(t, machines))
    .sort((a, b) => order[a.status] - order[b.status] || (b.closedAt || b.createdAt) - (a.closedAt || a.createdAt));
}

async function detail(id) {
  return view(get(id), await machinesNow());
}

// ---------- actions ----------
// Open a task: a sandbox with the task text, folders and agent.
// With a project: its agent, repository, trust and template (unless given).
async function open(body, hooks) {
  const project = body.project || null;
  if (project) body = require('./projects').taskDefaults(project, body);
  const r = await require('./sandbox').open(body, hooks);
  if (project) { S().tasks[r.taskId].project = project; save(); }
  return { ...r, task: await detail(r.taskId) };
}

function live(t) {
  if (t.closedAt) throw fail(409, 'задача уже закрыта');
  return t;
}

// Take the result now; the machine stays and the agent can go on.
async function finish(id) {
  const t = live(get(id));
  const out = [];
  for (const f of t.folders.filter((x) => x.git)) out.push(await require('./gitwork').finish(f.git));
  return { git: out, task: await detail(id) };
}

async function close(id, { save: keep = true } = {}, hooks) {
  const t = live(get(id));
  const r = await require('./sandbox').close(t.machine, { save: keep }, hooks);
  return { ...r, task: await detail(id) };
}

// A clean machine for the same task: the profile and the branch are taken first,
// then the task opens again from the template with the branch as its starting point.
async function reset(id, hooks) {
  const t = live(get(id));
  const sandbox = require('./sandbox');
  const sb = sandbox.record(t.machine);
  if (!sb) throw fail(409, 'у задачи нет машины');
  await sandbox.close(t.machine, { save: true }, hooks);
  const r = await sandbox.open({ template: sb.template, profile: t.profile, agent: t.agent, trust: t.trust, task: t.text,
    folders: t.folders.map(({ hostPath, mode }) => ({ hostPath, mode })), persistent: t.persistent, taskId: id,
    gitFrom: Object.fromEntries(t.folders.filter((f) => f.git).map((f) => [f.hostPath, f.git])) }, hooks);
  get(id).resets = (get(id).resets || 0) + 1;
  save();
  return { ...r, task: await detail(id) };
}

// Decide the task's branches at once (each one also can be decided by itself in /ui/git).
// how: accept | discard | merge (opts.how: merge | squash — into the branch each one started from).
async function decide(id, how, opts = {}) {
  const t = get(id);
  const gitwork = require('./gitwork');
  const out = [];
  for (const f of t.folders.filter((x) => x.git)) {
    const g = gitwork.get(f.git);
    if (how === 'accept' && g.state === 'ready') out.push(await gitwork.accept(f.git));
    if (how === 'discard' && g.tip && !['accepted', 'discarded', 'merged'].includes(g.state)) out.push(await gitwork.discard(f.git));
    if (how === 'merge' && g.tip && ['ready', 'accepted'].includes(g.state)) out.push(await gitwork.merge(f.git, { how: opts.how, title: t.title }));
  }
  return { git: out, task: await detail(id) };
}

// Forget a closed task (its branches stay in the repository if accepted).
function remove(id) {
  const t = get(id);
  if (!t.closedAt) throw fail(409, 'сначала закройте задачу');
  delete S().tasks[id];
  save();
}

module.exports = {
  raw: (id) => S().tasks[id] || null,
  // The task a git result belongs to.
  byGit: (gitId) => Object.values(S().tasks).find((t) => t.folders.some((f) => f.git === gitId))?.id || null,
  record, attach, closed, machineGone, list, detail, open, finish, close, reset, decide, remove,
  setFolders(id, folders) { const t = S().tasks[id]; if (t) { t.folders = folders; save(); } },
};
