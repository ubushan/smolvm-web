'use strict';
// Per-machine limits on what an agent may consume:
//  - pids: processes of the agent user (ulimit -u when an agent starts);
//  - agentMinutes: an agent is stopped after running this long;
//  - apiPerDay: requests through the secret gateway per day (429 beyond).
// 0 / empty = no limit. Usage counters reset at local midnight.

const cfg = require('./config');

const store = cfg.doc('limits.json', { machines: {}, usage: {}, runs: {} });

const FIELDS = { pids: [0, 100000], agentMinutes: [0, 7 * 24 * 60], apiPerDay: [0, 10000000] };

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function get(name) {
  const l = store.get().machines[name] || {};
  return { pids: l.pids || 0, agentMinutes: l.agentMinutes || 0, apiPerDay: l.apiPerDay || 0 };
}

function set(name, body) {
  const s = store.get();
  const next = {};
  for (const [k, [min, max]] of Object.entries(FIELDS)) {
    const v = Math.floor(Number(body[k]) || 0);
    if (v < min || v > max) throw new Error(`${k}: от ${min} до ${max}`);
    next[k] = v;
  }
  if (next.pids && next.pids < 32) throw new Error('Лимит процессов меньше 32 не даст агенту запуститься');
  s.machines[name] = next;
  store.save(s);
  return get(name);
}

function usage(name) {
  const u = store.get().usage[name];
  return { day: today(), api: u && u.day === today() ? u.api : 0 };
}

// Count one gateway request; false when the daily budget is spent.
function consumeApi(name) {
  const limit = get(name).apiPerDay;
  const s = store.get();
  const u = s.usage[name] && s.usage[name].day === today() ? s.usage[name] : { day: today(), api: 0 };
  if (limit && u.api >= limit) return { ok: false, used: u.api, limit };
  u.api += 1;
  s.usage[name] = u;
  // Saved on every request: a counter that a restart resets would not be a budget.
  store.save(s);
  return { ok: true, used: u.api, limit };
}

// Agent run clocks (for agentMinutes).
function startRun(name, agent) {
  const s = store.get();
  s.runs[name] = { ...(s.runs[name] || {}), [agent]: Date.now() };
  store.save(s);
}
function endRun(name, agent) {
  const s = store.get();
  if (s.runs[name]) { delete s.runs[name][agent]; if (!Object.keys(s.runs[name]).length) delete s.runs[name]; store.save(s); }
}
// [{ machine, agent, startedAt, limitMin }] past their time.
function overdue() {
  const out = [];
  for (const [machine, runs] of Object.entries(store.get().runs)) {
    const lim = get(machine).agentMinutes;
    if (!lim) continue;
    for (const [agent, startedAt] of Object.entries(runs)) if (Date.now() - startedAt > lim * 60000) out.push({ machine, agent, startedAt, limitMin: lim });
  }
  return out;
}
function runs(name) { return { ...(store.get().runs[name] || {}) }; }

function forget(name) {
  const s = store.get();
  delete s.machines[name]; delete s.usage[name]; delete s.runs[name];
  store.save(s);
}

module.exports = { get, set, usage, consumeApi, startRun, endRun, overdue, runs, forget };
