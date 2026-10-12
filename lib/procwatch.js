'use strict';
// Processes in machines working under a policy: every few seconds the process list of
// each such machine is read (as root, `ps`). A new process goes to the audit
// («Журнал» → «Процессы») when the policy keeps a process journal. A denied program
// run by the agent's user is killed at once and reported; run by root (smolvm-web, the
// machine itself, or the agent through sudo when the policy allows it) it is only
// reported — killing root's processes could break the machine.

const path = require('path');
const up = require('./upstream');
const audit = require('./audit');

const INTERVAL = 6000;
const PER_TICK = 40;             // new processes recorded per machine per tick, the rest summed up
const seen = new Map();          // machine -> Set of `${pid} ${args}`
let busy = false;

// Our own reading of the list, and kernel threads: never reported.
const OWN = /^(ps -eo pid,ppid,user,args|sh -c ps -eo)/;
// smolvm's keepalive of the machine (pid 1: «while true; do sleep 3600; done»).
const keepalive = (p) => p.ppid === 1 && p.args === 'sleep 3600';

function parse(text) {
  const out = [];
  for (const line of String(text).split('\n').slice(1)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const args = m[4].trim();
    const p = { pid: Number(m[1]), ppid: Number(m[2]), user: m[3], args };
    if (!args || p.pid === 1 || /^\[.*\]$/.test(args) || OWN.test(args) || keepalive(p)) continue;
    out.push(p);
  }
  return out;
}

// The program a command runs: the first word, without its path.
const programOf = (args) => path.posix.basename(args.split(/\s+/)[0] || '').replace(/:$/, '');

async function check({ name, policy, taskId }) {
  const deny = new Set(policy.processes?.deny || []);
  const journal = !!policy.processes?.journal;
  if (!deny.size && !journal) return;
  let r;
  try { r = await up.exec(name, { command: ['ps', '-eo', 'pid,ppid,user,args'], user: '0', timeoutSecs: 10 }, 15000); } catch { return; }
  if (r.exitCode !== 0) return;
  const now = parse(r.stdout);
  const first = !seen.has(name);
  const prev = seen.get(name) || new Set();
  const next = new Set(now.map((p) => `${p.pid} ${p.args}`));
  seen.set(name, next);
  let recorded = 0; let skipped = 0;
  for (const p of now) {
    const key = `${p.pid} ${p.args}`;
    const fresh = !prev.has(key);
    const prog = programOf(p.args);
    if (deny.has(prog) && p.user === 'root') {
      if (fresh && !first) audit.record({ type: 'proc', machine: name, actor: p.user, action: 'запрещённая программа запущена от root', severity: 'notice',
        detail: { command: p.args.slice(0, 300), program: prog, pid: p.pid, policy: policy.name, task: taskId || undefined } });
      continue;
    }
    if (deny.has(prog)) {
      await up.exec(name, { command: ['kill', '-9', String(p.pid)], user: '0', timeoutSecs: 10 }, 15000).catch(() => null);
      if (fresh) {
        audit.record({ type: 'proc', machine: name, actor: p.user, action: 'запрещённый процесс остановлен', severity: 'notice',
          detail: { command: p.args.slice(0, 300), program: prog, pid: p.pid, policy: policy.name, task: taskId || undefined } });
        audit.notify({ machine: name, text: `${name}: «${prog}» запрещён политикой «${policy.name}» — процесс остановлен (${p.args.slice(0, 120)})` });
      }
      continue;
    }
    // The first look is the starting point: what was already running is not «new».
    if (!fresh || first || !journal) continue;
    if (recorded >= PER_TICK) { skipped++; continue; }
    recorded++;
    audit.record({ type: 'proc', machine: name, actor: p.user, action: 'процесс запущен', detail: { command: p.args.slice(0, 300), pid: p.pid, task: taskId || undefined } });
  }
  if (skipped) audit.record({ type: 'proc', machine: name, actor: 'smolvm-web', action: `ещё ${skipped} новых процессов не записаны (слишком много за раз)`, detail: { task: taskId || undefined } });
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const list = require('./sandbox').policyMachines();
    if (!list.length) return;
    const names = new Set(list.map((x) => x.name));
    for (const n of [...seen.keys()]) if (!names.has(n)) seen.delete(n);
    const r = await up.request('GET', '/api/v1/machines', undefined, { timeoutMs: 5000 }).catch(() => null);
    const running = new Set((r?.data?.machines || []).filter((m) => m.state === 'running').map((m) => m.name));
    for (const x of list) {
      if (!running.has(x.name) || require('./sandbox').opening().some((o) => o.name === x.name)) continue;
      await check(x).catch(() => {});
    }
  } finally { busy = false; }
}

function start() { setInterval(tick, INTERVAL).unref(); }

module.exports = { start, parse, programOf, tick };
