'use strict';
// Running an agent from its page: «Запустить» (a program) and «Остановить».
// Every agent runs in a machine made from its template, in one of two modes (profile.mode):
//
//   sandbox    — every launch is a clean machine from the template; «Остановить» closes
//                it: the agent's commits come back as a branch («Входящие»), its memory
//                goes to review, the machine is deleted.
//   persistent — the machine is made from the template once and kept: «Остановить» stops
//                it (the branch is taken first), «Запустить» starts it again with all
//                inside it as it was.
//
// Underneath both is sandbox.open (policy, folders as git branches, the journal); a
// persistent machine is an open one that is never closed by itself.

const up = require('./upstream');

const fail = (status, msg) => Object.assign(new Error(msg), { status });
const modeOf = (prof) => (prof.mode === 'persistent' ? 'persistent' : 'sandbox');

// The agent's machine now: its newest open sandbox record.
function current(profileId) {
  return require('./sandbox').recordsOf(profileId)[0] || null;
}

async function machineState(name) {
  const r = await up.request('GET', `/api/v1/machines/${encodeURIComponent(name)}`).catch(() => null);
  return r?.status === 200 ? r.data.state : 'missing';
}

// What the page needs: the mode, the machine and its state.
async function status(profileId) {
  const sandbox = require('./sandbox');
  const prof = sandbox.profile(profileId);
  if (!prof) throw fail(404, 'агент не найден');
  const sb = current(profileId);
  return { mode: modeOf(prof), machine: sb?.name || null, state: sb ? await machineState(sb.name) : null, taskId: sb?.taskId || null,
    opening: sb ? sandbox.opening().some((o) => o.name === sb.name) : false };
}

// Start a program of the agent: in its machine if there is one (started or resumed as
// needed), else in a new machine from its template. → { name, url }
async function launch(profileId, program, hooks) {
  const sandbox = require('./sandbox');
  const agents = require('./agents');
  const prof = sandbox.profile(profileId);
  if (!prof) throw fail(404, 'агент не найден');
  const sb = current(profileId);
  if (!sb) {
    const r = await require('./tasks').open({ profile: profileId, agent: program || prof.agent || null, persistent: modeOf(prof) === 'persistent' }, hooks);
    return { name: r.name, url: r.url, created: true };
  }
  if (require('./isolation').isIsolated?.(sb.name)) throw fail(409, 'агент изолирован — сначала «Снять изоляцию»');
  const state = await machineState(sb.name);
  if (state === 'missing') { sandbox.forget(sb.name); return launch(profileId, program, hooks); }
  if (state === 'paused') {
    const r = await up.request('POST', `/api/v1/machines/${encodeURIComponent(sb.name)}/resume`, {});
    if (r.status !== 200) throw fail(500, `возобновление: ${r.data?.error || r.status}`);
  } else if (state !== 'running') await hooks.startMachine(sb.name, {});
  if (!program) return { name: sb.name, url: null };
  await up.waitReady(sb.name, 90000);
  return { name: sb.name, url: (await agents.start(sb.name, program, {})).url };
}

// «Остановить»: a sandbox is closed (branch, memory to review); a persistent machine is
// stopped with its branch taken first.
async function stop(profileId, hooks) {
  const sandbox = require('./sandbox');
  const prof = sandbox.profile(profileId);
  if (!prof) throw fail(404, 'агент не найден');
  const sb = current(profileId);
  if (!sb) throw fail(409, 'агент не запущен');
  if (modeOf(prof) === 'sandbox' || !sb.persistent) {
    return { mode: 'sandbox', ...(await require('./tasks').close(sb.taskId, { save: true }, hooks)) };
  }
  const state = await machineState(sb.name);
  const git = state === 'running' ? await require('./gitwork').finishMachine(sb.name) : [];
  if (['running', 'paused'].includes(state)) {
    const r = await up.request('POST', `/api/v1/machines/${encodeURIComponent(sb.name)}/stop`, {});
    if (r.status !== 200) throw fail(500, `остановка: ${r.data?.error || r.status}`);
  }
  require('./audit').record({ type: 'sandbox', machine: sb.name, actor: 'smolvm-web', action: 'агент остановлен (машина сохранена)', detail: { profile: profileId } });
  return { mode: 'persistent', stopped: true, git };
}

// A persistent machine made anew from the template (its branch taken, memory to review).
async function recreate(profileId, hooks) {
  const sb = current(profileId);
  if (!sb) throw fail(409, 'у агента нет машины');
  if (await machineState(sb.name) !== 'running') await hooks.startMachine(sb.name, {}).catch(() => {});
  return require('./tasks').close(sb.taskId, { save: true }, hooks);
}

module.exports = { status, launch, stop, recreate, modeOf };
