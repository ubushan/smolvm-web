'use strict';
// Policies: named sets of restrictions a task works under — the network, host folders,
// the agent's account inside the machine, processes and time. An agent or a project
// names its policy; a task may pick another; the task keeps the snapshot it opened with,
// so a later change of the policy touches only new tasks.
//
// Three built-in policies are the former trust levels (same ids: careful, normal,
// trusted); they cannot be changed, only copied. The administrator's policy (access.js)
// stays the ceiling over all of them.
//
// Inside the machine (applied by sandbox.open as root, before the agent starts):
//   account.sudo   — false: no sudo for the agent user; true: passwordless sudo.
//   processes.deny — programs the agent user may not run: their files lose the
//                    execute bit for anyone but root; procwatch.js kills what still
//                    appears (a copied binary, another path).

const crypto = require('crypto');
const cfg = require('./config');

const store = cfg.doc('policies.json', { policies: {} });
const S = () => store.get();
const save = () => store.save(S());
const fail = (status, msg) => Object.assign(new Error(msg), { status });

// The colour of a policy's icon.
const COLORS = ['green', 'blue', 'red', 'yellow', 'gray', 'purple'];
const DEFAULT_DENY = ['ssh', 'scp', 'sftp', 'nc', 'ncat', 'netcat', 'socat', 'telnet', 'nmap'];
// Never denied: the agent and the machine itself run on them.
const NEVER_DENY = new Set(['sh', 'bash', 'dash', 'ash', 'busybox', 'env', 'node', 'npm', 'npx', 'python', 'python3', 'git', 'ttyd', 'ps', 'kill', 'su', 'sudo', 'id']);

const BUILTIN = {
  careful: {
    id: 'careful', builtin: true, color: 'green', name: 'Осторожно', about: 'Для незнакомого кода и экспериментов: только разрешённое, без вопросов, короткая жизнь.',
    net: { mode: 'strict', lists: [], unknown: 'deny' },
    files: { modes: ['review', 'ro'], roots: [] },
    account: { sudo: false },
    processes: { deny: DEFAULT_DENY, journal: true, pids: 256, agentMinutes: 0 },
    time: { ttlHours: 2, idleMinutes: 0, apiPerDay: 0 },
  },
  normal: {
    id: 'normal', builtin: true, color: 'blue', name: 'Обычно', about: 'Для работы над своими проектами: белые списки для новых машин, о незнакомых адресах спросит вас.',
    net: { mode: 'strict', lists: 'default', unknown: 'ask' },
    files: { modes: ['review', 'ro'], roots: [] },
    account: { sudo: false },
    processes: { deny: DEFAULT_DENY, journal: true, pids: 0, agentMinutes: 0 },
    time: { ttlHours: 0, idleMinutes: 0, apiPerDay: 0 },
  },
  trusted: {
    id: 'trusted', builtin: true, color: 'yellow', name: 'Доверяю', about: 'Только для агентов, которым вы полностью доверяете: сеть без ограничений, ничего не спрашивает.',
    net: { mode: 'off', lists: [], unknown: 'allow' },
    files: { modes: ['review', 'ro'], roots: [] },
    account: { sudo: false },
    processes: { deny: [], journal: false, pids: 0, agentMinutes: 0 },
    time: { ttlHours: 0, idleMinutes: 0, apiPerDay: 0 },
  },
};

const int = (v, max, what) => {
  const n = Math.floor(Number(v) || 0);
  if (n < 0 || n > max) throw fail(400, `${what}: от 0 до ${max}`);
  return n;
};

// A policy from a request (or a copy), every field checked.
function normalize(b, base = BUILTIN.normal) {
  const egress = require('./egress');
  const p = JSON.parse(JSON.stringify(base));
  delete p.builtin;
  if (b.name !== undefined) p.name = String(b.name || '').trim().slice(0, 60);
  if (!p.name) throw fail(400, 'укажите название политики');
  if (b.about !== undefined) p.about = String(b.about || '').trim().slice(0, 300);
  if (b.color !== undefined) { if (!COLORS.includes(b.color)) throw fail(400, `цвет: ${COLORS.join(', ')}`); p.color = b.color; }
  if (!COLORS.includes(p.color)) p.color = 'gray';
  const n = b.net || {};
  if (n.mode !== undefined) { if (!['strict', 'soft', 'off'].includes(n.mode)) throw fail(400, 'режим сети: strict, soft или off'); p.net.mode = n.mode; }
  if (n.unknown !== undefined) { if (!['deny', 'ask', 'allow'].includes(n.unknown)) throw fail(400, 'незнакомые адреса: deny, ask или allow'); p.net.unknown = n.unknown; }
  if (n.lists !== undefined) {
    const known = new Set((egress.view?.()?.lists || []).map((l) => l.id));
    p.net.lists = n.lists === 'default' ? 'default' : (Array.isArray(n.lists) ? n.lists.map(String) : []).filter((id) => !known.size || known.has(id)).slice(0, 50);
  }
  if (p.net.mode === 'off') p.net.unknown = 'allow';
  const f = b.files || {};
  if (f.modes !== undefined) {
    const modes = (Array.isArray(f.modes) ? f.modes : []).filter((m) => ['review', 'ro'].includes(m));
    p.files.modes = [...new Set(modes)];
  }
  if (f.roots !== undefined) p.files.roots = (Array.isArray(f.roots) ? f.roots : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 30);
  const a = b.account || {};
  if (a.sudo !== undefined) p.account.sudo = !!a.sudo;
  const pr = b.processes || {};
  if (pr.deny !== undefined) {
    const list = (Array.isArray(pr.deny) ? pr.deny : String(pr.deny).split(/[\s,]+/)).map((x) => String(x).trim()).filter(Boolean);
    for (const x of list) {
      if (!/^[A-Za-z0-9._+-]{1,40}$/.test(x)) throw fail(400, `запрещённая программа «${x}»: только имя файла`);
      if (NEVER_DENY.has(x)) throw fail(400, `«${x}» запретить нельзя: на нём работают агент и сама машина`);
    }
    p.processes.deny = [...new Set(list)].slice(0, 100);
  }
  if (pr.journal !== undefined) p.processes.journal = !!pr.journal;
  if (pr.pids !== undefined) { p.processes.pids = int(pr.pids, 100000, 'Процессов'); if (p.processes.pids && p.processes.pids < 32) throw fail(400, 'Лимит процессов меньше 32 не даст агенту запуститься'); }
  if (pr.agentMinutes !== undefined) p.processes.agentMinutes = int(pr.agentMinutes, 7 * 24 * 60, 'Время работы агента, мин');
  const t = b.time || {};
  if (t.ttlHours !== undefined) p.time.ttlHours = int(t.ttlHours, 24 * 30, 'Срок жизни, ч');
  if (t.idleMinutes !== undefined) p.time.idleMinutes = int(t.idleMinutes, 24 * 60, 'Простой, мин');
  if (t.apiPerDay !== undefined) p.time.apiPerDay = int(t.apiPerDay, 10000000, 'Запросов API в день');
  return p;
}

const all = () => ({ ...BUILTIN, ...S().policies });
function get(id) {
  const p = all()[id];
  if (!p) throw fail(404, 'политика не найдена');
  return p;
}

// Who names a policy: agents and projects.
function usersOf(id) {
  const sb = require('./sandbox');
  const agents = (sb.profilesList?.() || []).filter((p) => (p.policy || p.trust) === id).map((p) => ({ id: p.id, name: p.name }));
  let projects = [];
  try { projects = require('./projects').list().filter((p) => (p.policy || p.trust) === id).map((p) => ({ id: p.id, name: p.name })); } catch {}
  return { agents, projects };
}

function list() {
  return Object.values(all()).map((p) => ({ ...p, users: usersOf(p.id) }))
    .sort((a, b) => (b.builtin ? 1 : 0) - (a.builtin ? 1 : 0) || a.name.localeCompare(b.name));
}

function create(b) {
  const base = b.from ? get(b.from) : BUILTIN.normal;
  const p = normalize({ ...b, name: b.name || `${base.name} — копия` }, base);
  let id;
  do id = `pl-${crypto.randomBytes(3).toString('hex')}`; while (all()[id]);
  Object.assign(p, { id, createdAt: Date.now(), updatedAt: Date.now() });
  S().policies[id] = p;
  save();
  return p;
}

function update(id, b) {
  const cur = get(id);
  if (cur.builtin) throw fail(409, 'встроенную политику менять нельзя — сделайте копию');
  const p = normalize(b, cur);
  Object.assign(p, { id, createdAt: cur.createdAt, updatedAt: Date.now() });
  S().policies[id] = p;
  save();
  return p;
}

function remove(id) {
  const cur = get(id);
  if (cur.builtin) throw fail(409, 'встроенную политику удалить нельзя');
  const u = usersOf(id);
  if (u.agents.length || u.projects.length) throw fail(409, `политикой пользуются: ${[...u.agents, ...u.projects].map((x) => x.name).join(', ')}`);
  delete S().policies[id];
  save();
}

// ---------- what a policy means for one task ----------
// The policy with its lists resolved (a snapshot to keep in the task).
function effective(id) {
  const p = JSON.parse(JSON.stringify(get(id)));
  if (p.net.lists === 'default') p.net.lists = (require('./egress').view?.()?.lists || []).filter((l) => l.default).map((l) => l.id);
  return p;
}
// The trust level a policy amounts to (for the administrator's ceiling).
const trustOf = (p) => (p.net.mode === 'off' || p.net.unknown === 'allow' ? 'trusted' : p.net.unknown === 'ask' ? 'normal' : 'careful');

function checkFolders(p, folders) {
  for (const f of folders) {
    if (!p.files.modes.includes(f.mode)) throw fail(403, `политика «${p.name}»: режим директории «${f.mode === 'ro' ? 'только чтение' : 'изменять'}» не разрешён (${f.hostPath})`);
    if (p.files.roots.length && !p.files.roots.some((r) => f.hostPath === r || f.hostPath.startsWith(r.replace(/[\\/]+$/, '') + require('path').sep))) {
      throw fail(403, `политика «${p.name}»: директория ${f.hostPath} не входит в разрешённые`);
    }
  }
}

function egressPatch(p) {
  if (p.net.mode === 'off') return { enabled: false, ask: false };
  return { enabled: true, lists: p.net.lists, ask: p.net.unknown === 'ask',
    rules: p.net.unknown === 'allow' ? [{ host: '*', ports: '*', note: `политика «${p.name}»: незнакомые адреса пропускаются` }] : [] };
}

const limitsOf = (p) => ({ pids: p.processes.pids || 0, agentMinutes: p.processes.agentMinutes || 0, apiPerDay: p.time.apiPerDay || 0 });

const sq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
// Root's script in the machine: sudo for the agent user, denied programs.
function guestScript(p, user = 'node') {
  const deny = (p.processes.deny || []).filter((x) => /^[A-Za-z0-9._+-]{1,40}$/.test(x) && !NEVER_DENY.has(x));
  return `U=${sq(user)}
id "$U" >/dev/null 2>&1 || { echo "note: нет пользователя $U"; exit 0; }
${p.account.sudo ? `if ! command -v sudo >/dev/null 2>&1; then
  (apt-get install -y -qq --no-install-recommends sudo >/dev/null 2>&1 || { apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq --no-install-recommends sudo >/dev/null 2>&1; } || apk add -q sudo >/dev/null 2>&1) || echo "note: sudo не установился — нет доступа к репозиторию пакетов"
fi
mkdir -p /etc/sudoers.d && echo "$U ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/90-smolvm-agent && chmod 440 /etc/sudoers.d/90-smolvm-agent
echo "sudo: on"` : `rm -f /etc/sudoers.d/90-smolvm-agent
for g in sudo wheel admin; do gpasswd -d "$U" "$g" >/dev/null 2>&1 || delgroup "$U" "$g" >/dev/null 2>&1 || true; done
grep -lsE "^[^#]*\\b$U\\b" /etc/sudoers /etc/sudoers.d/* 2>/dev/null | while read -r f; do echo "note: $U упомянут в $f"; done
echo "sudo: off"`}
for p in ${deny.map(sq).join(' ')}; do
  for f in /usr/local/sbin/$p /usr/local/bin/$p /usr/sbin/$p /usr/bin/$p /sbin/$p /bin/$p; do
    [ -e "$f" ] || continue
    r=$(readlink -f "$f" 2>/dev/null || echo "$f")
    case "$(basename "$r")" in busybox|toybox) echo "note: $p — часть $r, остановит только журнал процессов"; continue;; esac
    chown root:root "$r" 2>/dev/null; chmod 0700 "$r" && echo "denied: $p"
  done
done
true`;
}

// A short line about a policy, for lists and the task screen.
function summary(p) {
  const net = { strict: 'только разрешённое', soft: 'без изоляции', off: 'сеть без ограничений' }[p.net.mode];
  return [net, p.net.mode !== 'off' ? { deny: 'незнакомое запрещено', ask: 'незнакомое — спросить', allow: 'незнакомое пропускается' }[p.net.unknown] : null,
    p.account.sudo ? 'sudo' : 'без root', p.processes.deny.length ? `запрещено программ: ${p.processes.deny.length}` : null,
    p.time.ttlHours ? `живёт ${p.time.ttlHours} ч` : null].filter(Boolean).join(' · ');
}

module.exports = { BUILTIN, COLORS, DEFAULT_DENY, list, get, create, update, remove, effective, trustOf, checkFolders, egressPatch, limitsOf, guestScript, summary };
