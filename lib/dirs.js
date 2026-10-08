'use strict';
// Allowed host directories and per-user access to them inside machines.
//
// A directory is registered once (host path + ceiling: ro or rw) and then
// attached to machines. Per machine each guest user gets rw / ro / none on it;
// `*` is everybody not listed. Two layers enforce that:
//   1. smolvm mounts, enforced by the host: an rw view only if somebody may
//      write, a readonly view if somebody may only read. Root in the guest can
//      use whatever is mounted, so run agents as ordinary users.
//   2. gates in the guest: each view is mounted at /.smolvm-dirs/<id>/<rw|ro>/data
//      and its parent (guest-local, on the overlay) is root-only with POSIX ACL
//      entries for the users let through. smolvm exec drops supplementary
//      groups, so groups cannot carry access; ACL user entries can.
// <guestPath> links to the widest view, and every listed user gets ~/<name>
// pointing at the view of their own level.
//
// Mounts are fixed while a machine runs: changes to them are applied with
// `smolvm machine update` right before the next start. Per-user changes within
// the mounted views apply at once.

const fs = require('fs');
const os = require('os');
const path = require('path');
const cfg = require('./config');
const up = require('./upstream');

const BASE = '/.smolvm-dirs';
const LEVELS = { none: 0, ro: 1, rw: 2 };
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const GUEST_RE = /^\/[A-Za-z0-9._@+-]+(\/[A-Za-z0-9._@+-]+)*$/;
const GUEST_FORBIDDEN = ['/bin', '/boot', '/dev', '/etc', '/lib', '/lib64', '/proc', '/root', '/run', '/sbin', '/sys', '/usr', '/var', '/tmp', BASE];
const NOBODY = '65534:65534';

const store = cfg.doc('dirs.json', { strict: false, dirs: [], machines: {} });
const S = () => store.get();

// ---------- host paths ----------
const FOLD = process.platform === 'win32' || process.platform === 'darwin';
const norm = (p) => (FOLD ? p.toLowerCase() : p);

function isInside(child, parent) {
  const rel = path.relative(norm(parent), norm(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function protectedPaths() {
  const home = os.homedir();
  const list = [cfg.DIR, ...['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.config/gcloud', '.password-store', '.smolvm', '.local/share/smolvm', 'Library/Application Support/smolvm', 'Library/Keychains']
    .map((p) => path.join(home, p))];
  if (process.env.APPDATA) list.push(path.join(process.env.APPDATA, 'smolvm'));
  return list;
}

const SYSTEM_DIRS = process.platform === 'win32'
  ? [process.env.SystemRoot || 'C:\\Windows', process.env.ProgramFiles || 'C:\\Program Files', process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', process.env.ProgramData || 'C:\\ProgramData']
  : ['/etc', '/bin', '/sbin', '/usr', '/lib', '/lib64', '/boot', '/dev', '/proc', '/sys', '/var', '/root', '/System', '/Library', '/private/etc', '/private/var'];

// Why a host directory must not be given to a machine, or null.
function sensitive(real) {
  if (path.parse(real).root === real) return 'корень файловой системы';
  if (norm(real) === norm(os.homedir())) return 'домашняя директория целиком (в ней ключи SSH, облачные токены и т.п.) — выберите поддиректорию';
  for (const p of protectedPaths()) {
    if (isInside(p, real)) return `содержит ${p}`;
    if (isInside(real, p)) return `находится внутри ${p}`;
  }
  for (const p of SYSTEM_DIRS) if (isInside(real, p)) return `системная директория ${p}`;
  return null;
}

function resolveHostDir(raw) {
  const p = String(raw || '').trim();
  if (!p) throw new Error('Укажите путь на хосте');
  if (!path.isAbsolute(p)) throw new Error('Путь на хосте должен быть абсолютным');
  let real;
  try { real = fs.realpathSync.native(p); } catch { throw new Error(`Нет такой директории: ${p}`); }
  if (!fs.statSync(real).isDirectory()) throw new Error(`Это не директория: ${real}`);
  return real;
}

function hostOwner(real) {
  if (process.platform === 'win32') return null;
  try { return fs.statSync(real).uid; } catch { return null; }
}

function checkGuestPath(g) {
  g = String(g || '').trim().replace(/\/+$/, '');
  if (!GUEST_RE.test(g) || g.split('/').some((s) => s === '.' || s === '..')) throw new Error(`Путь в машине «${g}»: абсолютный путь из букв, цифр и ._@+-`);
  for (const f of GUEST_FORBIDDEN) if (g === f || g.startsWith(`${f}/`)) throw new Error(`Путь в машине «${g}» внутри системной директории ${f}`);
  return g;
}

// ---------- registry ----------
function dirById(id) { return S().dirs.find((d) => d.id === id); }

function usedBy(id) {
  return Object.entries(S().machines).filter(([, m]) => m.dirs.some((d) => d.id === id)).map(([n]) => n);
}

function listDirs() {
  return S().dirs.map((d) => {
    let exists = true;
    try { exists = fs.statSync(d.hostPath).isDirectory(); } catch { exists = false; }
    return { ...d, exists, owner: hostOwner(d.hostPath), machines: usedBy(d.id) };
  });
}

function saveDir(id, body) {
  const s = S();
  const isNew = id === 'new';
  const nid = isNew ? String(body.id || '').trim().toLowerCase() : id;
  if (!ID_RE.test(nid)) throw new Error('Имя директории: латиница в нижнем регистре, цифры, - и _ (до 32)');
  const cur = dirById(nid);
  if (isNew && cur) throw new Error(`Директория «${nid}» уже есть`);
  if (!isNew && !cur) throw new Error(`Нет директории «${nid}»`);
  const hostPath = resolveHostDir(body.hostPath);
  const why = sensitive(hostPath);
  if (why) throw new Error(`${hostPath}: нельзя давать машинам — ${why}`);
  const ceiling = body.ceiling === 'rw' ? 'rw' : 'ro';
  const defaultAccess = ['rw', 'ro', 'none'].includes(body.defaultAccess) ? body.defaultAccess : 'ro';
  if (LEVELS[defaultAccess] > LEVELS[ceiling]) throw new Error('Доступ по умолчанию выше максимального');
  const d = { id: nid, hostPath, ceiling, defaultAccess, guestPath: checkGuestPath(body.guestPath || `/${nid}`), note: String(body.note || '').slice(0, 200) };
  if (cur) {
    Object.assign(cur, d);
    // Lowering the ceiling caps what machines already have.
    for (const m of Object.values(s.machines)) {
      for (const a of m.dirs) {
        if (a.id !== nid) continue;
        for (const [u, l] of Object.entries(a.access)) if (LEVELS[l] > LEVELS[ceiling]) a.access[u] = ceiling;
      }
    }
  } else s.dirs.push(d);
  store.save(s);
  return d;
}

function deleteDir(id) {
  const users = usedBy(id);
  if (users.length) throw new Error(`Директория подключена к машинам: ${users.join(', ')}. Сначала отключите её там.`);
  const s = S();
  s.dirs = s.dirs.filter((d) => d.id !== id);
  store.save(s);
}

function setStrict(on) { const s = S(); s.strict = !!on; store.save(s); return s.strict; }

// Mounts typed by hand in the create form. In strict mode they must lie in a
// registered directory within its ceiling; smolvm-web's own config (the vault
// key) is never mountable.
function checkFreeMounts(mounts) {
  for (const m of mounts || []) {
    let real;
    try { real = fs.realpathSync.native(String(m.source)); } catch { if (S().strict) throw new Error(`Монтирование ${m.source}: нет такой директории`); continue; }
    if (isInside(cfg.DIR, real)) throw new Error(`Монтирование ${real}: содержит настройки и хранилище секретов smolvm-web`);
    if (!S().strict) continue;
    const reg = S().dirs.find((d) => isInside(real, d.hostPath));
    if (!reg) throw new Error(`Монтирование ${real}: нет в списке разрешённых директорий (строгий режим, см. «Директории»)`);
    if (reg.ceiling === 'ro' && !m.readonly) throw new Error(`Монтирование ${real}: директория «${reg.id}» разрешена только для чтения — добавьте :ro`);
  }
}

// ---------- machines ----------
function emptyMachine() { return { users: [], dirs: [], applied: [], links: [] }; }
function getMachine(name) { return S().machines[name] || null; }

function levelOf(a, user) { return a.access[user] ?? a.access['*'] ?? 'none'; }

function normalizeMachine(body) {
  const users = [];
  for (const u of Array.isArray(body.users) ? body.users : []) {
    const name = String(u?.name || '').trim();
    if (!USER_RE.test(name)) throw new Error(`Пользователь «${name}»: строчные латинские буквы, цифры, _ и -`);
    if (users.some((x) => x.name === name)) continue;
    let uid = u.uid === '' || u.uid == null ? null : Number(u.uid);
    if (uid !== null && (!Number.isInteger(uid) || uid < 1 || uid > 60000)) throw new Error(`uid пользователя ${name}: 1–60000`);
    if (name === 'root') uid = null;
    users.push({ name, uid });
  }
  const dirs = [];
  for (const a of Array.isArray(body.dirs) ? body.dirs : []) {
    const reg = dirById(a?.id);
    if (!reg) throw new Error(`Нет разрешённой директории «${a?.id}»`);
    if (dirs.some((x) => x.id === reg.id)) continue;
    const access = {};
    for (const [u, l] of Object.entries(a.access || {})) {
      if (u !== '*' && !users.some((x) => x.name === u)) continue;
      if (!(l in LEVELS)) throw new Error(`Уровень доступа «${l}»`);
      if (LEVELS[l] > LEVELS[reg.ceiling]) throw new Error(`«${reg.id}»: для ${u === '*' ? 'остальных' : u} запрошена запись, а директория разрешена только для чтения`);
      access[u] = l;
    }
    if (!access['*']) access['*'] = 'none';
    dirs.push({ id: reg.id, guestPath: checkGuestPath(a.guestPath || reg.guestPath), access });
  }
  const paths = dirs.map((d) => d.guestPath);
  for (const p of paths) {
    if (paths.some((o) => o !== p && (o.startsWith(`${p}/`)))) throw new Error(`Пути в машине пересекаются: ${p}`);
  }
  if (new Set(paths).size !== paths.length) throw new Error('Две директории с одним путём в машине');
  return { users, dirs };
}

function saveMachine(name, body) {
  const s = S();
  const n = normalizeMachine(body);
  const cur = s.machines[name] || emptyMachine();
  s.machines[name] = { ...cur, users: n.users, dirs: n.dirs };
  store.save(s);
  return s.machines[name];
}

// Attach registered directories at create time with their default access.
function attachAtCreate(name, ids) {
  const dirs = ids.map((id) => {
    const reg = dirById(id);
    if (!reg) throw new Error(`Нет разрешённой директории «${id}»`);
    return { id, guestPath: reg.guestPath, access: { '*': reg.defaultAccess } };
  });
  const s = S();
  s.machines[name] = { ...emptyMachine(), dirs: normalizeMachine({ users: [], dirs }).dirs };
  store.save(s);
  return desiredMounts(name);
}

function forgetMachine(name) {
  const s = S();
  if (!s.machines[name]) return;
  delete s.machines[name];
  store.save(s);
}

// A branch is a copy-on-write clone: same mounts, same gates.
function copyMachine(from, to) {
  const m = getMachine(from);
  if (!m) return;
  S().machines[to] = structuredClone(m);
  store.save(S());
}

const viewTarget = (id, v) => `${BASE}/${id}/${v}/data`;
const mountKey = (m) => `${m.source}\n${m.target}\n${!!m.readonly}`;

function desiredMounts(name) {
  const m = getMachine(name);
  if (!m) return [];
  const out = [];
  for (const a of m.dirs) {
    const reg = dirById(a.id);
    if (!reg) continue;
    const levels = new Set([...m.users.map((u) => levelOf(a, u.name)), a.access['*'] || 'none']);
    if (levels.has('rw')) out.push({ source: reg.hostPath, target: viewTarget(a.id, 'rw'), readonly: false });
    if (levels.has('ro')) out.push({ source: reg.hostPath, target: viewTarget(a.id, 'ro'), readonly: true });
  }
  return out;
}

function mountDiff(name) {
  const m = getMachine(name);
  if (!m) return { add: [], remove: [] };
  const want = desiredMounts(name);
  const have = m.applied || [];
  const wk = new Set(want.map(mountKey));
  const hk = new Set(have.map(mountKey));
  return { add: want.filter((x) => !hk.has(mountKey(x))), remove: have.filter((x) => !wk.has(mountKey(x))) };
}

function markApplied(name, mounts) {
  const s = S();
  if (!s.machines[name]) return;
  s.machines[name].applied = mounts;
  store.save(s);
}

// What each user ends up with, for the UI.
function machineView(name) {
  const m = getMachine(name) || emptyMachine();
  const diff = mountDiff(name);
  const applied = new Set((m.applied || []).map((x) => x.target));
  const dirs = m.dirs.map((a) => {
    const reg = dirById(a.id);
    const base = path.posix.basename(a.guestPath);
    const views = ['rw', 'ro'].filter((v) => applied.has(viewTarget(a.id, v)));
    const linked = views[0] || null;
    const where = (lvl) => {
      if (lvl === 'none') return [];
      const p = [`~/${base}`];
      if (linked === lvl) p.unshift(a.guestPath);
      else if (views.length === 2 && lvl === 'ro') p.unshift(`${a.guestPath}-ro`);
      return p;
    };
    return {
      ...a, hostPath: reg?.hostPath, ceiling: reg?.ceiling, owner: reg ? hostOwner(reg.hostPath) : null, missing: !reg,
      paths: Object.fromEntries([...m.users.map((u) => [u.name, where(levelOf(a, u.name))]), ['*', where(a.access['*'] || 'none').filter((p) => !p.startsWith('~'))]]),
    };
  });
  return { users: m.users, dirs, pending: { add: diff.add, remove: diff.remove }, applied: m.applied || [] };
}

// ---------- guest provisioning ----------
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

const SCRIPT_HEAD = String.raw`
out() { printf '%s\n' "$*"; }
HAS_ACL=0; command -v setfacl >/dev/null 2>&1 && HAS_ACL=1
ensure_user() {
  n=$1; u=$2
  if id "$n" >/dev/null 2>&1; then
    [ -n "$u" ] && [ "$(id -u "$n")" != "$u" ] && out "warn:у пользователя $n uid $(id -u "$n"), а не $u"
    return 0
  fi
  set --; [ -n "$u" ] && set -- -u "$u"
  if command -v useradd >/dev/null 2>&1; then useradd -m -s /bin/sh "$@" "$n" >/dev/null 2>&1
  elif command -v adduser >/dev/null 2>&1; then adduser -D -s /bin/sh "$@" "$n" >/dev/null 2>&1
  else out "err:нет useradd/adduser — пользователь $n не создан"; return 1; fi
  if id "$n" >/dev/null 2>&1; then out "user:$n"; else out "err:не удалось создать пользователя $n"; fi
}
gate() {
  g=$1; other=$2; acl=$3; owner=$4
  if [ ! -d "$g/data" ]; then out "err:нет $g/data — монтирование ещё не применено (перезапустите машину)"; return 1; fi
  chown 0:0 "$g"; chmod 0700 "$g"
  [ "$HAS_ACL" = 1 ] && setfacl -b "$g" 2>/dev/null
  [ "$other" = 1 ] && chmod 0711 "$g"
  [ -z "$acl" ] && return 0
  if [ "$HAS_ACL" = 1 ]; then
    setfacl -m "$acl" "$g" 2>/dev/null || { chmod 0700 "$g"; out "err:setfacl не сработал для $g — доступ закрыт для всех, кроме root"; }
  elif [ -n "$owner" ]; then
    chown "$owner" "$g" && chmod 0700 "$g" && out "warn:нет setfacl: $g отдан пользователю $owner (он сможет сам открыть доступ другим)"
  else
    chmod 0700 "$g"; out "err:нужен setfacl (пакет acl), чтобы разделить доступ к $g — пока доступ только у root"
  fi
}
link() {
  t=$1; l=$2
  if [ -L "$l" ]; then ln -sfn "$t" "$l"
  elif [ -d "$l" ] && [ -z "$(ls -A "$l" 2>/dev/null)" ]; then rmdir "$l" && ln -s "$t" "$l"
  elif [ -e "$l" ]; then out "warn:$l уже существует — ссылка на директорию не создана"
  else mkdir -p "$(dirname "$l")" && ln -s "$t" "$l"; fi
}
home_of() { awk -F: -v u="$1" '$1==u{print $6}' /etc/passwd; }
home_link() { h=$(home_of "$1"); [ -n "$h" ] && [ -d "$h" ] && link "$2" "$h/$3"; }
unlink_stale() { [ -L "$1" ] && case "$(readlink "$1")" in @@BASE@@/*) rm -f "$1";; esac; true; }
unhome_link() { h=$(home_of "$1"); [ -n "$h" ] && unlink_stale "$h/$2"; }
`.replace('@@BASE@@', BASE);

const SCRIPT_ACL = String.raw`
if [ "$HAS_ACL" = 0 ]; then
  { apk add --no-cache acl || { apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y acl; } || dnf install -y acl || yum install -y acl; } >/dev/null 2>&1
  command -v setfacl >/dev/null 2>&1 && HAS_ACL=1 && out "acl:installed"
fi
`;

function buildScript(name) {
  const m = getMachine(name);
  const applied = new Set((m.applied || []).map((x) => x.target));
  const users = m.users.filter((u) => u.name !== 'root');
  const body = [];
  const links = [];
  let needAcl = false;
  for (const u of users) body.push(`ensure_user ${q(u.name)} ${q(u.uid ?? '')}`);
  for (const a of m.dirs) {
    const views = ['rw', 'ro'].filter((v) => applied.has(viewTarget(a.id, v)));
    for (const v of views) {
      const others = (a.access['*'] || 'none') === v;
      // Open gate: deny the listed users of another level. Closed gate: allow the listed users of this level.
      const entries = users.filter((u) => (levelOf(a, u.name) === v) !== others).map((u) => `u:${u.name}:${others ? '---' : '--x'}`);
      if (entries.length) needAcl = true;
      const owner = !others && entries.length === 1 ? entries[0].split(':')[1] : '';
      body.push(`gate ${q(`${BASE}/${a.id}/${v}`)} ${others ? 1 : 0} ${q(entries.join(','))} ${q(owner)}`);
    }
    if (!views.length) continue;
    body.push(`link ${q(viewTarget(a.id, views[0]))} ${q(a.guestPath)}`);
    links.push(a.guestPath);
    if (views.length === 2) { body.push(`link ${q(viewTarget(a.id, 'ro'))} ${q(`${a.guestPath}-ro`)}`); links.push(`${a.guestPath}-ro`); }
    const base = path.posix.basename(a.guestPath);
    for (const u of users) {
      const v = levelOf(a, u.name);
      if (v !== 'none' && views.includes(v)) { body.push(`home_link ${q(u.name)} ${q(viewTarget(a.id, v))} ${q(base)}`); links.push(`~${u.name}/${base}`); }
    }
  }
  for (const l of m.links || []) {
    if (links.includes(l)) continue;
    const hm = l.match(/^~([^/]+)\/(.+)$/);
    body.push(hm ? `unhome_link ${q(hm[1])} ${q(hm[2])}` : `unlink_stale ${q(l)}`);
  }
  return { script: [SCRIPT_HEAD, needAcl ? SCRIPT_ACL : '', ...body, 'true'].join('\n'), links };
}

function parseReport(stdout) {
  const r = { users: [], warnings: [], errors: [], aclInstalled: false };
  for (const line of String(stdout || '').split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const k = line.slice(0, i); const v = line.slice(i + 1);
    if (k === 'user') r.users.push(v);
    else if (k === 'warn') r.warnings.push(v);
    else if (k === 'err') r.errors.push(v);
    else if (k === 'acl') r.aclInstalled = true;
  }
  return r;
}

// Create users, set gates and links in a running machine. `env` carries the proxy for `apk add acl`.
async function provision(name, env = []) {
  const m = getMachine(name);
  if (!m || (!m.dirs.length && !(m.links || []).length && !m.users.length)) return { skipped: true };
  await up.waitReady(name);
  const { script, links } = buildScript(name);
  const r = await up.exec(name, { command: ['sh', '-c', script], env, user: '0', timeoutSecs: 300 }, 330000);
  const report = parseReport(r.stdout);
  if (r.exitCode !== 0) report.errors.push(`скрипт завершился с кодом ${r.exitCode}: ${(r.stderr || '').slice(-300)}`);
  const s = S();
  if (s.machines[name]) { s.machines[name].links = links; store.save(s); }
  return report;
}

// Test from inside the machine what each user can actually do.
async function verify(name) {
  const m = getMachine(name);
  if (!m) return { rows: [] };
  const applied = new Set((m.applied || []).map((x) => x.target));
  const probes = [];
  for (const a of m.dirs) for (const v of ['rw', 'ro']) if (applied.has(viewTarget(a.id, v))) probes.push({ id: a.id, v, path: viewTarget(a.id, v) });
  const who = [...m.users.filter((u) => u.name !== 'root').map((u) => ({ key: u.name, user: u.name })), { key: '*', user: NOBODY }];
  const script = 'for p in "$@"; do r=0; w=0; [ -r "$p" ] && [ -x "$p" ] && r=1; [ -w "$p" ] && w=1; echo "$r$w"; done';
  const rows = [];
  for (const w of who) {
    let res = null; let error = null;
    if (probes.length) {
      try {
        const r = await up.exec(name, { command: ['sh', '-c', script, 'probe', ...probes.map((p) => p.path)], user: w.user, timeoutSecs: 30 }, 40000);
        if (r.exitCode !== 0) error = (r.stderr || `код ${r.exitCode}`).trim().slice(0, 200);
        else res = r.stdout.trim().split('\n');
      } catch (e) { error = e.message; }
    }
    for (const a of m.dirs) {
      const expected = w.key === '*' ? (a.access['*'] || 'none') : levelOf(a, w.key);
      let actual = 'none';
      probes.forEach((p, i) => {
        if (p.id !== a.id || !res) return;
        const [rd, wr] = (res[i] || '00').split('');
        if (wr === '1' && rd === '1' && p.v === 'rw') actual = 'rw';
        else if (rd === '1' && actual === 'none') actual = 'ro';
      });
      const reg = dirById(a.id);
      const owner = reg ? hostOwner(reg.hostPath) : null;
      let hint = null;
      if (expected === 'rw' && actual === 'ro') hint = owner > 0 ? `запись запрещена правами на хосте: задайте пользователю uid ${owner} (владелец директории)` : 'запись запрещена правами директории на хосте (владелец — root)';
      rows.push({ user: w.key, dir: a.id, expected, actual: error ? null : actual, ok: !error && actual === expected, error, hint });
    }
  }
  return { rows };
}

module.exports = {
  BASE, LEVELS, listDirs, saveDir, deleteDir, setStrict, strict: () => S().strict, checkFreeMounts,
  getMachine, saveMachine, attachAtCreate, forgetMachine, copyMachine, desiredMounts, mountDiff, markApplied,
  machineView, provision, verify,
  _internal: { sensitive, buildScript, normalizeMachine, isInside },
};
