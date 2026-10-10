'use strict';
// Kill switch state: an isolated machine gets nothing through smolvm-web —
// the egress filter refuses and drops its connections, the secret gateway
// refuses its tokens (which are also rotated), pending approvals are denied.
// Kept on disk, so a restart of smolvm-web does not lift it.

const cfg = require('./config');

const store = cfg.doc('isolation.json', { machines: {} });

function get(name) { return store.get().machines[name] || null; }
function isIsolated(name) { return !!get(name); }
function set(name, info) {
  const s = store.get();
  if (info) s.machines[name] = { since: Date.now(), ...info };
  else delete s.machines[name];
  store.save(s);
}
function all() { return { ...store.get().machines }; }

module.exports = { get, isIsolated, set, all };
