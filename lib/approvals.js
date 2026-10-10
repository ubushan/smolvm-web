'use strict';
// Human-in-the-loop: a request that needs a person's decision waits here until
// someone clicks in the UI (or it times out = denied). Used by the egress
// filter ("Спрашивать" for unknown destinations) and the secret gateway
// (API calls matching a secret's "подтверждать" rules: DELETE, deploy, …).
//
// Concurrent requests with the same key (one host, one API call) share one
// prompt. Every decision goes to the audit log.

const audit = require('./audit');

const DEFAULT_TIMEOUT_SEC = 120;
const pending = new Map(); // id -> { id, key, kind, machine, title, detail, createdAt, expiresAt, waiters: [] }
const byKey = new Map();   // key -> id
let seq = 0;

function finish(p, decision, actor) {
  if (!pending.has(p.id)) return;
  pending.delete(p.id);
  byKey.delete(p.key);
  clearTimeout(p.timer);
  for (const w of p.waiters) w(decision);
  audit.record({
    type: 'ui', machine: p.machine, actor: actor || 'smolvm-web',
    action: `подтверждение: ${p.kind === 'net' ? 'доступ в сеть' : 'вызов API'} — ${{ once: 'разрешено', always: 'разрешено навсегда', deny: 'запрещено', timeout: 'нет ответа, запрещено' }[decision] || decision}`,
    detail: { title: p.title, ...p.detail }, severity: decision === 'deny' || decision === 'timeout' ? 'notice' : 'info',
  });
}

// Wait for a person. Resolves 'once' | 'always' | 'deny' | 'timeout'.
function request({ key, kind, machine, title, detail = {}, timeoutSec = DEFAULT_TIMEOUT_SEC }) {
  return new Promise((resolve) => {
    const existing = byKey.get(key);
    if (existing && pending.has(existing)) { pending.get(existing).waiters.push(resolve); return; }
    const p = { id: `a${++seq}`, key, kind, machine, title, detail, createdAt: Date.now(), expiresAt: Date.now() + timeoutSec * 1000, waiters: [resolve] };
    p.timer = setTimeout(() => finish(p, 'timeout'), timeoutSec * 1000);
    pending.set(p.id, p);
    byKey.set(key, p.id);
  });
}

function list() {
  return [...pending.values()].map(({ id, kind, machine, title, detail, createdAt, expiresAt, waiters }) => ({ id, kind, machine, title, detail, createdAt, expiresAt, waiting: waiters.length }));
}

function decide(id, decision, actor) {
  const p = pending.get(id);
  if (!p) return false;
  finish(p, ['once', 'always', 'deny'].includes(decision) ? decision : 'deny', actor);
  return true;
}

// Isolation: everything a machine is waiting for is refused at once.
function denyMachine(machine, actor) {
  for (const p of [...pending.values()]) if (p.machine === machine) finish(p, 'deny', actor);
}

module.exports = { request, list, decide, denyMachine };
