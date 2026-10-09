'use strict';
// Persistent settings for smolvm-web (proxy, CA) and small per-machine state.

const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';

function configDir() {
  if (process.env.SMOLVM_WEB_HOME) return process.env.SMOLVM_WEB_HOME;
  if (IS_WIN) return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'smolvm-web');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'smolvm-web');
}

const DIR = configDir();
const SETTINGS_FILE = path.join(DIR, 'settings.json');
const STATE_FILE = path.join(DIR, 'state.json');

const DEFAULTS = {
  proxy: {
    enabled: false,
    url: '',          // e.g. http://proxy.corp:3128 or http://user:pass@proxy.corp:8080
    noProxy: '',      // comma-separated; guest loopback is always added
    pull: true,       // image pulls (start via CLI with --proxy, images/pull with proxy)
    exec: true,       // inject proxy env into console/API exec calls
    provision: true,  // after start, write proxy config into the guest (profile.d, pip, npm, apt, git)
  },
  ca: {
    enabled: false,
    pem: '',          // pasted PEM certificate(s) or a path to a .pem/.crt file on the host
    system: true,     // also include the certificates this host's OS trusts (corporate roots)
    replaceSystemBundle: true, // overwrite the guest's /etc/ssl bundle so apk/apt/curl/wget trust it
    pullTrust: true,  // mount the bundle at /etc/smolvm-host-trust so smolvm's in-guest image pull (crane) trusts it
  },
};

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    if (!(k in base)) continue;
    if (base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) out[k] = merge(base[k], v);
    else if (typeof v === typeof base[k]) out[k] = v;
  }
  return out;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, data) {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = `${file}.tmp`;
  // Settings may hold proxy credentials: keep them private to the user.
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

let settings = merge(DEFAULTS, readJson(SETTINGS_FILE, {}));
const state = { noProxy: [], provisioned: {}, ...readJson(STATE_FILE, {}) };

// A small JSON document in the config dir (egress policy, directory access).
function doc(name, defaults) {
  const file = path.join(DIR, name);
  let value = { ...structuredClone(defaults), ...readJson(file, {}) };
  return {
    file,
    get: () => value,
    save(next = value) { value = next; writeJson(file, value); return value; },
  };
}

module.exports = {
  IS_WIN,
  DIR,
  doc,
  getSettings: () => settings,
  saveSettings(next) {
    settings = merge(DEFAULTS, next);
    writeJson(SETTINGS_FILE, settings);
    return settings;
  },
  // Per-machine opt-out from the proxy, and which CA/proxy fingerprint was provisioned.
  machineUsesProxy: (name) => !state.noProxy.includes(name),
  setMachineProxy(name, on) {
    state.noProxy = state.noProxy.filter((n) => n !== name);
    if (!on) state.noProxy.push(name);
    writeJson(STATE_FILE, state);
  },
  getProvisioned: (name) => state.provisioned[name],
  setProvisioned(name, fp) {
    if (fp) state.provisioned[name] = fp; else delete state.provisioned[name];
    writeJson(STATE_FILE, state);
  },
  forgetMachine(name) {
    state.noProxy = state.noProxy.filter((n) => n !== name);
    delete state.provisioned[name];
    writeJson(STATE_FILE, state);
  },
};
