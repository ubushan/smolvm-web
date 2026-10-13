'use strict';
// Access: accounts with roles (opt-in) and the administrator's policy.
//
//   accounts — none: whoever reaches smolvm-web is the administrator (one person on
//              their own computer, as before). Once the first account exists, every
//              /ui and /api request needs a login. Roles: viewer < operator < admin.
//              A session is a cookie «name.version.expiry.hmac»; changing the password,
//              the role or deleting the account bumps the version and ends its sessions.
//   policy   — rules every task obeys whoever opens it; checked by sandbox.open on the
//              server (see check*), so no screen can loosen them.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');

const store = cfg.doc('access.json', { users: {}, policy: {} });
const S = () => store.get();
const save = () => store.save(S());
const fail = (status, msg, code) => Object.assign(new Error(msg), { status, code });

const ROLES = { viewer: 1, operator: 2, admin: 3 };
const ROLE_TITLES = { viewer: 'наблюдатель', operator: 'оператор', admin: 'администратор' };
const SESSION_HOURS = 12;
const COOKIE = 'smw_session';
// The server's own requests to itself (an image machine is created through the API).
const INTERNAL = crypto.randomBytes(24).toString('hex');

const KEY_FILE = path.join(cfg.DIR, 'access.key');
let key = null;
function hmacKey() {
  if (key) return key;
  try { key = fs.readFileSync(KEY_FILE); } catch {
    key = crypto.randomBytes(32);
    fs.mkdirSync(cfg.DIR, { recursive: true });
    fs.writeFileSync(KEY_FILE, key, { mode: 0o600 });
  }
  return key;
}
const sign = (s) => crypto.createHmac('sha256', hmacKey()).update(s).digest('base64url');
const hashPassword = (password, salt) => crypto.scryptSync(String(password), salt, 64).toString('hex');

// ---------- accounts ----------
const enabled = () => Object.keys(S().users).length > 0;
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/i;
const admins = () => Object.values(S().users).filter((u) => u.role === 'admin' && !u.disabled);

function listUsers() {
  return Object.values(S().users).map(({ name, role, disabled, createdAt, lastLogin }) => ({ name, role, disabled: !!disabled, createdAt, lastLogin: lastLogin || null }))
    .sort((a, b) => ROLES[b.role] - ROLES[a.role] || a.name.localeCompare(b.name));
}

// Create or change an account. The first one must be an administrator: it turns logins on.
function setUser({ name, role, password, disabled }) {
  name = String(name || '').trim();
  if (!NAME_RE.test(name)) throw fail(400, 'имя: латиница, цифры, точка, дефис, подчёркивание, до 32 символов');
  const u = S().users[name];
  if (role !== undefined && !ROLES[role]) throw fail(400, 'роль: viewer, operator или admin');
  if (!u && !enabled() && role !== 'admin') throw fail(400, 'первая учётная запись — администратор: с ней включается вход');
  if (!u && !password) throw fail(400, 'задайте пароль');
  if (password !== undefined && password !== '' && String(password).length < 10) throw fail(400, 'пароль — не короче 10 символов');
  const next = u ? { ...u } : { name, role: role || 'operator', createdAt: Date.now(), ver: 1 };
  if (role) next.role = role;
  if (disabled !== undefined) next.disabled = !!disabled;
  if (password) { next.salt = crypto.randomBytes(16).toString('hex'); next.hash = hashPassword(password, next.salt); }
  // The last administrator stays one: nobody could manage access otherwise.
  if (u?.role === 'admin' && (next.role !== 'admin' || next.disabled) && admins().length <= 1) throw fail(409, 'это последний администратор — сначала назначьте другого');
  if (u && (password || role !== u.role || next.disabled !== !!u.disabled)) next.ver = (u.ver || 1) + 1;
  S().users[name] = next;
  save();
  return listUsers().find((x) => x.name === name);
}

function deleteUser(name) {
  const u = S().users[name];
  if (!u) throw fail(404, 'нет такой учётной записи');
  if (u.role === 'admin' && admins().length <= 1 && Object.keys(S().users).length > 1) throw fail(409, 'это последний администратор — сначала назначьте другого');
  delete S().users[name];
  save();
}

// ---------- sessions ----------
const failures = new Map(); // name -> { n, until }
function login(name, password) {
  name = String(name || '').trim();
  const f = failures.get(name);
  if (f?.until > Date.now()) throw fail(429, `слишком много попыток — подождите ${Math.ceil((f.until - Date.now()) / 1000)} с`);
  const u = S().users[name];
  if (!u) hashPassword(password, 'no-such-user'); // the same time for a wrong name
  const ok = u && !u.disabled && crypto.timingSafeEqual(Buffer.from(hashPassword(password, u.salt), 'hex'), Buffer.from(u.hash, 'hex'));
  if (!ok) {
    const n = (f?.n || 0) + 1;
    failures.set(name, { n, until: n >= 5 ? Date.now() + Math.min(15 * 60, 30 * 2 ** (n - 5)) * 1000 : 0 });
    throw fail(401, 'неверное имя или пароль', 'AUTH');
  }
  failures.delete(name);
  u.lastLogin = Date.now();
  save();
  const body = `${name}.${u.ver || 1}.${Date.now() + SESSION_HOURS * 3600000}`;
  return `${body}.${sign(body)}`;
}

function cookieOf(req) {
  const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : '';
}

// Who sends this request: { name, role } | null (logins on, no valid session).
function identify(req) {
  if (req.headers['x-smolvm-internal'] === INTERNAL) return { name: 'smolvm-web', role: 'admin', internal: true };
  if (!enabled()) return { name: null, role: 'admin', open: true };
  const v = cookieOf(req);
  const i = v.lastIndexOf('.');
  if (i < 0) return null;
  const body = v.slice(0, i);
  const mac = v.slice(i + 1);
  const good = sign(body);
  if (mac.length !== good.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(good))) return null;
  const [name, ver, exp] = body.split('.');
  const u = S().users[name];
  if (!u || u.disabled || String(u.ver || 1) !== ver || Number(exp) < Date.now()) return null;
  return { name, role: u.role };
}

const sessionCookie = (token) => `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}`;
const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;

// ---------- what a role may do ----------
// Reading is for everyone with a login, except what hands over control or file contents.
const OPERATOR_READ = [
  /^GET \/ui\/machines\/[^/]+\/agents\/[\w-]+\/open$/,
  /^GET \/api\/v1\/machines\/[^/]+\/files\//,
];
// Work with tasks: open, answer the agent, check and decide the result, stop everything.
const OPERATOR_WRITE = [
  /^POST \/ui\/tasks$/,
  /^POST \/ui\/run\/[\w-]+\/(launch|stop|recreate)$/,
  /^POST \/ui\/tasks\/t-[0-9a-f]+\/(finish|close|reset|accept|discard)$/,
  /^DELETE \/ui\/tasks\/t-[0-9a-f]+$/,
  /^POST \/ui\/git\/[\w-]+\/(finish|accept|discard)$/,
  /^POST \/ui\/approvals\/[\w-]+$/,
  /^POST \/ui\/sandbox\/machines\/[^/]+\/(close|extend)$/,
  /^(POST|DELETE) \/ui\/sandbox\/pending\//,
  /^POST \/ui\/machines\/[^/]+\/agents\/[\w-]+\/(start|stop)$/,
  /^POST \/ui\/machines\/[^/]+\/isolate$/,
  /^POST \/ui\/isolate-all$/,
  /^POST \/ui\/machines\/[^/]+\/review\/[\w.-]+\/(apply|reject|pull|copy)$/,
];
const MERGE = [/^POST \/ui\/tasks\/t-[0-9a-f]+\/merge$/, /^POST \/ui\/git\/[\w-]+\/merge$/];

function required(method, pathname) {
  const key = `${method} ${pathname}`;
  if (pathname.startsWith('/ui/access/')) return 'admin';
  if (MERGE.some((re) => re.test(key))) return policy().mergeBy === 'admin' ? 'admin' : 'operator';
  if (method === 'GET' || method === 'HEAD') return OPERATOR_READ.some((re) => re.test(key)) ? 'operator' : 'viewer';
  if (OPERATOR_WRITE.some((re) => re.test(key))) return 'operator';
  return 'admin';
}
const allows = (role, need) => (ROLES[role] || 0) >= ROLES[need];

// ---------- the policy ----------
const TRUST_ORDER = { careful: 1, normal: 2, trusted: 3 };
const TRUST_TITLES = { careful: '«Осторожно»', normal: '«Обычно»', trusted: '«Доверяю»' };
const POLICY_DEFAULTS = {
  maxTrust: 'trusted',      // the highest trust level a task may have
  requireFilter: false,     // a task's machine has the «Сеть» filter on
  requireIsolation: false,  // … with hard isolation (smolvm egress policy)
  allowPersistent: true,    // sessions that are not closed by themselves
  maxTtlHours: 0,           // 0 — no limit; otherwise every task closes by then
  memoryReview: false,      // the agent's memory always goes through review
  allowEnvSecrets: true,    // secrets whose value the agent sees (mode «Переменная»)
  mergeBy: 'operator',      // who merges task branches: operator | admin
};
function policy() { return { ...POLICY_DEFAULTS, ...(S().policy || {}) }; }
function setPolicy(b) {
  const p = policy();
  if (b.maxTrust !== undefined) { if (!TRUST_ORDER[b.maxTrust]) throw fail(400, 'потолок доверия: careful, normal или trusted'); p.maxTrust = b.maxTrust; }
  for (const k of ['requireFilter', 'requireIsolation', 'allowPersistent', 'memoryReview', 'allowEnvSecrets']) if (b[k] !== undefined) p[k] = !!b[k];
  if (b.maxTtlHours !== undefined) {
    const n = Math.floor(Number(b.maxTtlHours) || 0);
    if (n < 0 || n > 24 * 30) throw fail(400, 'максимальный срок: от 0 до 720 часов');
    p.maxTtlHours = n;
  }
  if (b.mergeBy !== undefined) { if (!['operator', 'admin'].includes(b.mergeBy)) throw fail(400, 'кто вливает: operator или admin'); p.mergeBy = b.mergeBy; }
  if (p.requireIsolation) p.requireFilter = true;
  S().policy = p;
  save();
  return p;
}

const breach = (msg) => fail(403, `политика администратора: ${msg}`, 'POLICY');
// Before a machine is made: trust and persistence.
function checkOpen({ trust, persistent }) {
  const p = policy();
  if (trust && TRUST_ORDER[trust] > TRUST_ORDER[p.maxTrust]) throw breach(`доверие не выше ${TRUST_TITLES[p.maxTrust]}`);
  if (persistent && (!p.allowPersistent || p.maxTtlHours)) throw breach(p.allowPersistent ? `задачи живут не дольше ${p.maxTtlHours} ч — постоянная сессия невозможна` : 'постоянные сессии запрещены');
}
// The lifetime a task gets (hours, 0 — none) under the policy's maximum.
function capTtl(hours) {
  const max = policy().maxTtlHours;
  return max ? (hours ? Math.min(hours, max) : max) : hours;
}
// After the machine is set up, before it starts: what it really got.
function checkMachine({ egress, secrets }) {
  const p = policy();
  if (p.requireFilter && !egress?.enabled) throw breach('у машины задачи должен быть включён фильтр «Сеть» — у агента сеть «Без ограничений»');
  if (p.requireIsolation && !(egress?.enabled && egress?.strict)) throw breach('нужна жёсткая изоляция сети — у агента «без изоляции»');
  if (p.requireFilter && (egress?.rules || []).some((r) => r.host === '*' && r.enabled !== false)) throw breach('правило «*» открывает всё — уровень «Доверяю» здесь недопустим');
  const env = (secrets || []).filter((s) => s.mode === 'env').map((s) => s.name);
  if (!p.allowEnvSecrets && env.length) throw breach(`секреты в режиме «Переменная» запрещены (агент видит значение): ${env.join(', ')} — переключите их на шлюз`);
}

module.exports = {
  ROLES, ROLE_TITLES, INTERNAL, COOKIE,
  enabled, listUsers, setUser, deleteUser, login, identify, sessionCookie, clearCookie,
  required, allows, policy, setPolicy, checkOpen, capTtl, checkMachine,
};
