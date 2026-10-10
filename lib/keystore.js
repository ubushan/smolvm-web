'use strict';
// The vault's master key lives in the OS key store, not next to the vault:
//   macOS   — login Keychain (via /usr/bin/security, secret passed on stdin)
//   Windows — the key file below, in %APPDATA%\smolvm-web (the profile's ACLs keep
//             other users out). DPAPI is not used: it took a hidden PowerShell that
//             antivirus behaviour engines (Kaspersky PDM) report as credential theft,
//             and DPAPI CurrentUser opens to any program of the same user anyway.
//   Linux   — Secret Service via secret-tool (libsecret), when available
// Fallback: a 0600 key file in the config dir. SMOLVM_WEB_VAULT_KEY (64 hex) overrides all.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const cfg = require('./config');

const SERVICE = 'smolvm-web';
const ACCOUNT = 'vault-key';

function run(cmd, args, input) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(cmd, args, { windowsHide: true }); } catch { return resolve({ code: -1, out: '' }); }
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', () => resolve({ code: -1, out: '', err }));
    child.on('close', (code) => resolve({ code, out: out.trim(), err }));
    if (input != null) child.stdin.end(input); else child.stdin.end();
  });
}

const isKey = (hex) => /^[0-9a-f]{64}$/i.test(hex || '');

const backends = {
  async macos() {
    if (process.platform !== 'darwin') return null;
    return {
      name: 'macOS Keychain',
      async get() {
        const r = await run('/usr/bin/security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w']);
        return r.code === 0 && isKey(r.out) ? r.out : null;
      },
      async set(hex) {
        // `security -i` reads commands from stdin, keeping the key out of argv.
        const r = await run('/usr/bin/security', ['-i'], `add-generic-password -U -s ${SERVICE} -a ${ACCOUNT} -l "smolvm-web vault" -w ${hex}\n`);
        return r.code === 0;
      },
    };
  },

  async linux() {
    if (process.platform !== 'linux') return null;
    const probe = await run('secret-tool', ['--version']);
    if (probe.code !== 0) return null;
    return {
      name: 'Secret Service (secret-tool)',
      async get() {
        const r = await run('secret-tool', ['lookup', 'service', SERVICE, 'account', ACCOUNT]);
        return r.code === 0 && isKey(r.out) ? r.out : null;
      },
      async set(hex) {
        const r = await run('secret-tool', ['store', '--label=smolvm-web vault', 'service', SERVICE, 'account', ACCOUNT], hex);
        return r.code === 0;
      },
    };
  },
};

function fileBackend() {
  const file = path.join(cfg.DIR, 'vault.key');
  return {
    name: `файл ключа (${file})`,
    async get() {
      try { const k = fs.readFileSync(file, 'utf8').trim(); return isKey(k) ? k : null; } catch { return null; }
    },
    async set(hex) {
      fs.mkdirSync(cfg.DIR, { recursive: true });
      fs.writeFileSync(file, hex, { mode: 0o600 });
      return true;
    },
  };
}

let cached = null;

// Returns { key: Buffer(32), backend: string }. Creates a key on first use.
async function masterKey({ create = true } = {}) {
  if (cached) return cached;
  if (isKey(process.env.SMOLVM_WEB_VAULT_KEY)) {
    cached = { key: Buffer.from(process.env.SMOLVM_WEB_VAULT_KEY, 'hex'), backend: 'переменная SMOLVM_WEB_VAULT_KEY' };
    return cached;
  }
  const candidates = [];
  for (const make of [backends.macos, backends.linux]) {
    const b = await make();
    if (b) candidates.push(b);
  }
  candidates.push(fileBackend());

  for (const b of candidates) {
    const hex = await b.get();
    if (hex) { cached = { key: Buffer.from(hex, 'hex'), backend: b.name }; return cached; }
  }
  if (!create) return null;
  const hex = crypto.randomBytes(32).toString('hex');
  for (const b of candidates) {
    if (await b.set(hex) && (await b.get()) === hex) {
      cached = { key: Buffer.from(hex, 'hex'), backend: b.name };
      return cached;
    }
  }
  throw new Error('не удалось сохранить ключ хранилища ни в одном хранилище ключей');
}

// A vault whose key an earlier version kept with DPAPI (vault.key.dpapi): it cannot be opened now.
const legacyDpapi = () => process.platform === 'win32' && fs.existsSync(path.join(cfg.DIR, 'vault.key.dpapi'));

module.exports = { masterKey, legacyDpapi, forget() { cached = null; } };
