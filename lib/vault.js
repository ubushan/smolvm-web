'use strict';
// Encrypted secret vault (AES-256-GCM, key in the OS key store).
//
// Three ways a secret reaches a machine:
//   substitute — smolvm credential substitution: the guest gets a placeholder,
//                smolvm's host interceptor swaps in the value on HTTPS requests
//                to the named hosts. Needs direct internet from the host.
//   gateway    — smolvm-web gateway: the guest gets a per-machine token and a
//                base URL on the host; the gateway swaps the token for the value
//                and forwards upstream (through the corporate proxy if set).
//   env        — plaintext env var in exec calls. The workload CAN read it.
// Values never leave this process except toward the upstream (or smolvm's
// in-memory credential-values for `substitute`).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');
const keystore = require('./keystore');

const FILE = path.join(cfg.DIR, 'vault.enc.json');
const MODES = ['substitute', 'gateway', 'env'];
const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

let data = null;    // { secrets: {name: {...}}, machines: {machine: {secrets: [], tokens: {}}} }
let backend = null;
let loadError = null;

function empty() { return { secrets: {}, machines: {} }; }

async function load() {
  if (data) return data;
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const mk = await keystore.masterKey({ create: !raw });
  if (!mk) {
    loadError = 'Хранилище секретов существует, но ключ для него не найден (Keychain/DPAPI/secret-tool/vault.key). Без ключа его нельзя открыть.';
    throw new Error(loadError);
  }
  backend = mk.backend;
  if (!raw) { data = empty(); return data; }
  const decipher = crypto.createDecipheriv('aes-256-gcm', mk.key, Buffer.from(raw.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(raw.tag, 'base64'));
  decipher.setAAD(Buffer.from('smolvm-web-vault-v1'));
  try {
    const plain = Buffer.concat([decipher.update(Buffer.from(raw.data, 'base64')), decipher.final()]);
    data = { ...empty(), ...JSON.parse(plain.toString('utf8')) };
  } catch {
    loadError = 'Не удалось расшифровать хранилище секретов: ключ не подходит.';
    throw new Error(loadError);
  }
  return data;
}

async function save() {
  const mk = await keystore.masterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', mk.key, iv);
  cipher.setAAD(Buffer.from('smolvm-web-vault-v1'));
  const enc = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  fs.mkdirSync(cfg.DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: enc.toString('base64') }), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

// Metadata only — never the value.
function describe(name, s) {
  const machines = Object.entries(data.machines).filter(([, m]) => m.secrets.includes(name)).map(([n]) => n);
  return {
    name, mode: s.mode, envVar: s.envVar, hosts: s.hosts || [], upstream: s.upstream || '',
    baseUrlVar: s.baseUrlVar || '', methods: s.methods || [], allowHttp: !!s.allowHttp, hasValue: !!s.value,
    note: s.note || '', updatedAt: s.updatedAt, machines,
  };
}

function validate(name, s) {
  if (!NAME_RE.test(name)) throw new Error('Имя: латиница, цифры, «_ . -», до 64 символов');
  if (!MODES.includes(s.mode)) throw new Error('Неизвестный режим');
  if (!ENV_RE.test(s.envVar || '')) throw new Error('Некорректное имя переменной окружения');
  if (s.mode === 'substitute') {
    if (!s.hosts.length) throw new Error('Для подстановки нужен хотя бы один хост');
    for (const h of s.hosts) if (!HOST_RE.test(h)) throw new Error(`Хост «${h}»: нужно точное DNS-имя в нижнем регистре, без схемы, порта и *`);
  }
  if (s.mode === 'gateway') {
    let u;
    try { u = new URL(s.upstream); } catch { throw new Error('Некорректный URL API'); }
    if (u.protocol === 'http:' && !s.allowHttp) throw new Error('URL API с http:// — включите «Локальная модель / сервер по HTTP» (или используйте https://)');
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('URL API должен начинаться с https:// (или http:// для локальной модели)');
    if (s.baseUrlVar && !ENV_RE.test(s.baseUrlVar)) throw new Error('Некорректное имя переменной для base URL');
  }
}

module.exports = {
  MODES,
  async status() {
    try { await load(); return { ok: true, backend }; } catch (e) { return { ok: false, error: e.message }; }
  },
  async list() {
    await load();
    return Object.entries(data.secrets).map(([n, s]) => describe(n, s)).sort((a, b) => a.name.localeCompare(b.name));
  },
  async put(name, input) {
    await load();
    const prev = data.secrets[name];
    const s = {
      mode: input.mode,
      envVar: String(input.envVar || '').trim(),
      hosts: [...new Set((input.hosts || []).map((h) => String(h).trim().toLowerCase()).filter(Boolean))],
      upstream: String(input.upstream || '').trim().replace(/\/+$/, ''),
      baseUrlVar: String(input.baseUrlVar || '').trim(),
      methods: (input.methods || []).map((m) => String(m).toUpperCase()).filter(Boolean),
      // Plain HTTP to the upstream: a local model server (Ollama, vLLM, LM Studio, llama.cpp).
      allowHttp: input.mode === 'gateway' && !!input.allowHttp,
      note: String(input.note || '').slice(0, 200),
      value: typeof input.value === 'string' && input.value !== '' ? input.value : prev?.value,
      updatedAt: Date.now(),
    };
    if (!s.value) throw new Error('Укажите значение секрета');
    if (/[\r\n\0]/.test(s.value)) throw new Error('Значение не должно содержать переводов строки');
    validate(name, s);
    // A substitution binding is fixed into the smolvm machine record at create.
    if (prev && prev.mode === 'substitute' && (s.mode !== 'substitute' || s.envVar !== prev.envVar || s.hosts.join() !== prev.hosts.join())) {
      const bound = Object.values(data.machines).some((m) => m.secrets.includes(name));
      if (bound) throw new Error('Секрет в режиме подстановки уже привязан к машинам: режим, переменную и хосты менять нельзя (только значение). Создайте новый секрет.');
    }
    data.secrets[name] = s;
    await save();
    return describe(name, s);
  },
  async remove(name) {
    await load();
    delete data.secrets[name];
    for (const m of Object.values(data.machines)) {
      m.secrets = m.secrets.filter((n) => n !== name);
      delete m.tokens[name];
    }
    await save();
  },
  async get(name) { await load(); return data.secrets[name] || null; },

  // ---- machine bindings ----
  async machineSecrets(machine) {
    await load();
    const m = data.machines[machine];
    if (!m) return [];
    return m.secrets.filter((n) => data.secrets[n]).map((n) => ({ name: n, ...data.secrets[n], token: m.tokens[n] }));
  },
  async bind(machine, names) {
    await load();
    const m = data.machines[machine] || { secrets: [], tokens: {} };
    for (const n of names) {
      if (!data.secrets[n]) throw new Error(`Секрет «${n}» не найден`);
      if (!m.secrets.includes(n)) m.secrets.push(n);
      if (data.secrets[n].mode === 'gateway' && !m.tokens[n]) m.tokens[n] = `smolgw_${crypto.randomBytes(24).toString('hex')}`;
    }
    data.machines[machine] = m;
    await save();
  },
  async unbind(machine, names) {
    await load();
    const m = data.machines[machine];
    if (!m) return;
    m.secrets = m.secrets.filter((n) => !names.includes(n));
    for (const n of names) delete m.tokens[n];
    await save();
  },
  async forgetMachine(machine) {
    await load().catch(() => null);
    if (data?.machines[machine]) { delete data.machines[machine]; await save(); }
  },
  // Gateway lookup: token -> { machine, secret } (constant-time compare).
  async resolveToken(secretName, token) {
    await load();
    const want = Buffer.from(token);
    for (const [machine, m] of Object.entries(data.machines)) {
      const t = m.tokens[secretName];
      if (t && t.length === token.length && crypto.timingSafeEqual(Buffer.from(t), want) && m.secrets.includes(secretName)) {
        return { machine, secret: data.secrets[secretName] };
      }
    }
    return null;
  },
};
