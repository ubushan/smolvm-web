'use strict';
// Git work: the agent gets a git repository of a host project and its result comes
// back as a branch. Nothing in the host working tree changes.
//
//   in     — `git bundle` of the host HEAD. By default only its tree (one parentless
//            commit, «snapshot»): old history may hold secrets and is not needed to
//            work. The guest repo has one branch, agent/<id>.
//   finish — in the machine, as the agent user (the guest .git is the agent's: hooks,
//            fsmonitor or filters there must not run as root): commit what is not
//            committed, bundle <base>..HEAD.
//   back   — the host fetches the bundle with fsckObjects into refs/smolvm/raw/<id>;
//            a snapshot's commits are rebuilt on the real base (same trees, authors,
//            messages), and the result is the branch smolvm/<id>. Only objects and
//            refs move: no checkout, no hooks of the agent.
//
// Entries are kept by id after the machine is gone: the branch is the result.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const cfg = require('./config');
const up = require('./upstream');
const { unified, isBinary } = require('./diff');

const store = cfg.doc('gitwork.json', { items: {} });
const S = () => store.get();
const save = () => store.save(S());
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });
const sq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const MAX_BUNDLE = 1024 * 1024 * 1024; // 1 GiB
const MAX_DIFF_BYTES = 2 * 1024 * 1024;
const AGENT = { name: 'smolvm agent', email: 'agent@smolvm.local' };

// Paths whose change runs code somewhere later (CI, hooks, builds, editors) or changes
// what git itself does: shown first and marked in the review.
const RISKY = [
  [/^\.github\/workflows\/|^\.gitlab-ci\.yml$|^\.circleci\/|(^|\/)Jenkinsfile$|^azure-pipelines\.yml$|^\.drone\.yml$|^bitbucket-pipelines\.yml$/, 'CI'],
  [/^\.husky\/|^\.githooks\/|^\.pre-commit-config\.yaml$|^lefthook\.ya?ml$/, 'git-хуки'],
  [/^\.gitattributes$|(^|\/)\.gitmodules$/, 'настройки git'],
  [/(^|\/)package\.json$|(^|\/)setup\.py$|(^|\/)pyproject\.toml$|(^|\/)build\.gradle(\.kts)?$|(^|\/)pom\.xml$|(^|\/)Cargo\.toml$|(^|\/)build\.rs$|(^|\/)Makefile$|(^|\/)Dockerfile$|(^|\/)docker-compose\.ya?ml$/, 'сборка и зависимости'],
  [/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|uv\.lock|Cargo\.lock|go\.sum|Gemfile\.lock|composer\.lock)$/, 'lock-файл'],
  [/^\.vscode\/|^\.idea\/|^\.devcontainer\/|(^|\/)\.envrc$/, 'настройки редактора и окружения'],
  [/(^|\/)(CLAUDE|AGENTS|GEMINI)\.md$|^\.claude\/|^\.cursor\/|^\.cursorrules$/, 'инструкции агентов'],
];

// ---------- host git ----------
function git(cwd, args, { input, env } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn('git', args, { cwd, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...env } });
    const out = []; let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => reject(fail(`git: ${e.message}`, 500)));
    p.on('close', (code) => {
      const stdout = Buffer.concat(out);
      if (code === 0) resolve(stdout);
      else reject(Object.assign(fail(`git ${args[0]}: ${err.trim().slice(-300) || `код ${code}`}`, 500), { code }));
    });
    p.stdin.end(input ?? '');
  });
}
const gitText = async (cwd, args, o) => (await git(cwd, args, o)).toString('utf8').trim();

// A folder is used through git when it is the top of a repository with at least one commit.
async function repoOf(hostPath) {
  try {
    const top = await gitText(hostPath, ['rev-parse', '--show-toplevel']);
    if (fs.realpathSync.native(top) !== fs.realpathSync.native(hostPath)) return null;
    const head = await gitText(hostPath, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
    return head ? { top: hostPath, head } : null;
  } catch { return null; }
}

// For the «Новая задача» window: is the folder a repository, and on what.
async function inspect(hostPath) {
  const c = require('./dirs').checkFolder(hostPath);
  if (!c.ok) return { ok: false, error: c.error };
  const repo = await repoOf(c.real);
  if (!repo) return { ok: true, real: c.real, git: false };
  const branch = await gitText(c.real, ['symbolic-ref', '-q', '--short', 'HEAD']).catch(() => '') || null;
  const dirty = !!(await gitText(c.real, ['status', '--porcelain', '--untracked-files=no']).catch(() => ''));
  return { ok: true, real: c.real, git: true, branch, head: repo.head.slice(0, 8), dirty };
}

// ---------- guest ----------
function putFile(name, guestPath, stream, size) {
  return new Promise((resolve, reject) => {
    const req = require('http').request({ ...up.target(), method: 'PUT', path: `/api/v1/machines/${encodeURIComponent(name)}/files/${encodeURIComponent(guestPath)}`,
      headers: { host: 'localhost', 'content-type': 'application/octet-stream', 'content-length': size } }, (res) => {
      let t = ''; res.on('data', (d) => { t += d; });
      res.on('end', () => (res.statusCode === 200 ? resolve() : reject(fail(`загрузка в машину: HTTP ${res.statusCode} ${t.slice(0, 200)}`, 500))));
    });
    req.on('error', reject);
    stream.pipe(req);
  });
}

function getFile(name, guestPath, file) {
  return new Promise((resolve, reject) => {
    require('http').get({ ...up.target(), path: `/api/v1/machines/${encodeURIComponent(name)}/files/${encodeURIComponent(guestPath)}`, headers: { host: 'localhost' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(fail(`чтение из машины: HTTP ${res.statusCode}`, 500)); return; }
      const w = fs.createWriteStream(file, { mode: 0o600 });
      res.pipe(w);
      w.on('finish', resolve);
      w.on('error', reject);
    }).on('error', reject);
  });
}

async function sh(name, script, { user = '0', timeoutSecs = 300 } = {}) {
  const r = await up.exec(name, { command: ['sh', '-c', script], user, timeoutSecs }, (timeoutSecs + 15) * 1000);
  return r;
}

// git in the guest repo, as the agent user, with nothing of the repo's own config running.
const GG = 'git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c safe.directory=*';

// ---------- operations ----------
function get(id) {
  const x = S().items[id];
  if (!x) throw fail('результат git не найден', 404);
  return x;
}

// Give a machine a git copy of a host repository. Returns the entry.
async function add(name, { hostPath, guestPath, history = false }) {
  const c = require('./dirs').checkFolder(hostPath);
  if (!c.ok) throw fail(`${c.real || hostPath}: ${c.error}`);
  const repo = await repoOf(c.real);
  if (!repo) throw fail(`${c.real}: не корень git-репозитория с коммитами`);
  const slug = path.basename(c.real).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'project';
  let id;
  do id = `${slug}-${crypto.randomBytes(3).toString('hex')}`; while (S().items[id]);
  const baseRef = await gitText(c.real, ['symbolic-ref', '-q', '--short', 'HEAD']).catch(() => '') || null;
  const dirty = !!(await gitText(c.real, ['status', '--porcelain', '--untracked-files=no']).catch(() => ''));
  const entry = { id, machine: name, hostPath: c.real, guestPath, history: !!history, base: repo.head, baseRef,
    branch: `smolvm/${id}`, guestBranch: `agent/${id}`, dirty, state: 'copying', createdAt: Date.now(), finishedAt: null, commits: 0, error: null };
  S().items[id] = entry;
  save();
  await seed(entry, name, guestPath, repo.head);
  return view(entry);
}

// The same work in a new machine (a reset session): the guest starts from the branch
// as it is now, and its next commits continue it.
async function reattach(id, name, guestPath) {
  const x = get(id);
  if (['accepted', 'discarded', 'copying'].includes(x.state)) throw fail(`нельзя продолжить в состоянии «${x.state}»`, 409);
  Object.assign(x, { machine: name, guestPath, machineGone: false, state: 'copying' });
  save();
  await seed(x, name, guestPath, x.tip || x.base);
  return view(x);
}

// Put commit `from` of the host repo into the machine as the guest branch.
// onto — the host commit the guest's next commits are rebuilt on.
async function seed(x, name, guestPath, from) {
  // The commit the guest starts from: `from` itself, or its tree as a parentless commit.
  let guestBase = from;
  if (!x.history) {
    const tree = await gitText(x.hostPath, ['rev-parse', `${from}^{tree}`]);
    guestBase = await gitText(x.hostPath, ['commit-tree', tree, '-m', `Снимок ${path.basename(x.hostPath)} для агента`],
      { env: { GIT_AUTHOR_NAME: 'smolvm-web', GIT_AUTHOR_EMAIL: 'smolvm-web@localhost', GIT_COMMITTER_NAME: 'smolvm-web', GIT_COMMITTER_EMAIL: 'smolvm-web@localhost' } });
  }
  // Keeps the guest base reachable on the host: the result bundle has it as prerequisite.
  await git(x.hostPath, ['update-ref', `refs/smolvm/base/${x.id}`, guestBase]);
  Object.assign(x, { guestBase, onto: from });
  const file = path.join(os.tmpdir(), `smolvm-git-${x.id}-${crypto.randomBytes(3).toString('hex')}.bundle`);
  try {
    await git(x.hostPath, ['bundle', 'create', file, `refs/smolvm/base/${x.id}`]);
    const size = fs.statSync(file).size;
    if (size > MAX_BUNDLE) throw fail(`репозиторий больше ${MAX_BUNDLE / 1024 / 1024} МБ`);
    await up.waitReady(name, 90000);
    const u = await sh(name, 'id -u node 2>/dev/null || echo 0');
    x.guestUser = (u.stdout || '0').trim() || '0';
    const gb = `/tmp/.smolvm-git-${x.id}.bundle`;
    await putFile(name, gb, fs.createReadStream(file), size);
    let r = await sh(name, `set -e; rm -rf ${sq(guestPath)}; mkdir -p ${sq(guestPath)}; chown ${x.guestUser} ${sq(guestPath)} ${sq(gb)}`);
    if (r.exitCode !== 0) throw fail(`папка в машине: ${(r.stderr || r.stdout).slice(-300)}`, 500);
    r = await sh(name, `set -e; cd ${sq(guestPath)}
${GG} init -q
${GG} fetch -q ${sq(gb)} refs/smolvm/base/${x.id}:refs/heads/${x.guestBranch}
${GG} checkout -q ${x.guestBranch}
git config user.name ${sq(AGENT.name)}; git config user.email ${sq(AGENT.email)}
rm -f ${sq(gb)}`, { user: x.guestUser, timeoutSecs: 900 });
    if (r.exitCode !== 0) throw fail(`репозиторий в машине: ${(r.stderr || r.stdout).slice(-300)}`, 500);
    Object.assign(x, { state: x.tip ? 'ready' : 'working', error: null });
  } catch (e) {
    x.state = 'error'; x.error = e.message;
    throw e;
  } finally {
    save();
    fs.rm(file, { force: true }, () => {});
  }
}

// The guest's commits on top of a snapshot, rebuilt on the real base: same trees,
// authors, dates and messages. Deterministic, so a repeated finish gives the same ids.
async function replay(cwd, from, onto, tip) {
  const lines = (await gitText(cwd, ['rev-list', '--reverse', '--topo-order', '--parents', tip, `^${from}`])).split('\n').filter(Boolean);
  const map = new Map([[from, onto]]);
  let last = onto;
  for (const line of lines) {
    const [sha, ...parents] = line.split(' ');
    const raw = (await git(cwd, ['cat-file', 'commit', sha])).toString('utf8');
    const cut = raw.indexOf('\n\n');
    const head = raw.slice(0, cut < 0 ? raw.length : cut).split('\n');
    const msg = cut < 0 ? '' : raw.slice(cut + 2);
    const person = (key) => {
      const m = /^(.*) <(.*)> (\d+ [+-]\d{4})$/.exec((head.find((l) => l.startsWith(`${key} `)) || '').slice(key.length + 1));
      return m ? { name: m[1], email: m[2], date: m[3] } : { name: AGENT.name, email: AGENT.email, date: '' };
    };
    const a = person('author'); const c = person('committer');
    const tree = head.find((l) => l.startsWith('tree ')).slice(5);
    const args = ['commit-tree', tree];
    for (const p of parents) {
      if (!map.has(p)) throw fail(`коммит агента ${sha.slice(0, 8)} ссылается на неизвестного родителя`, 422);
      args.push('-p', map.get(p));
    }
    args.push('-F', '-');
    last = await gitText(cwd, args, { input: msg, env: {
      GIT_AUTHOR_NAME: a.name, GIT_AUTHOR_EMAIL: a.email, GIT_AUTHOR_DATE: a.date,
      GIT_COMMITTER_NAME: c.name, GIT_COMMITTER_EMAIL: c.email, GIT_COMMITTER_DATE: c.date } });
    map.set(sha, last);
  }
  return last;
}

// Take the agent's work from the machine into the branch smolvm/<id>. The machine
// stays: the agent can go on, and a next finish moves the branch.
async function finish(id) {
  const x = get(id);
  if (!['working', 'ready'].includes(x.state)) throw fail(`нельзя забрать результат в состоянии «${x.state}»`, 409);
  const gb = `/tmp/.smolvm-git-out-${id}.bundle`;
  const r = await sh(x.machine, `set -e; cd ${sq(x.guestPath)}
${GG} add -A
${GG} diff --cached --quiet || ${GG} commit -q --no-verify -m 'Незакоммиченные изменения агента'
${GG} merge-base --is-ancestor ${x.guestBase} HEAD || { echo 'HEAD не продолжает базовую ветку: агент переключился на другую историю' >&2; exit 3; }
n=$(${GG} rev-list --count ${x.guestBase}..HEAD)
echo "commits=$n"
rm -f ${sq(gb)}
if [ "$n" != 0 ]; then ${GG} bundle create ${sq(gb)} HEAD ^${x.guestBase} 2>/dev/null; echo "size=$(wc -c < ${sq(gb)})"; fi`, { user: x.guestUser || '0', timeoutSecs: 600 });
  if (r.exitCode !== 0) throw fail(`забрать из машины: ${(r.stderr || r.stdout).trim().slice(-300)}`, r.exitCode === 3 ? 409 : 500);
  const commits = Number(/commits=(\d+)/.exec(r.stdout)?.[1] || 0);
  const size = Number(/size=(\d+)/.exec(r.stdout)?.[1] || 0);
  if (!commits) {
    Object.assign(x, { finishedAt: Date.now(), error: null });
    save();
    return view(x);
  }
  if (size > MAX_BUNDLE) throw fail(`результат больше ${MAX_BUNDLE / 1024 / 1024} МБ`, 413);
  const file = path.join(os.tmpdir(), `smolvm-git-out-${id}-${crypto.randomBytes(3).toString('hex')}.bundle`);
  try {
    await getFile(x.machine, gb, file);
    await git(x.hostPath, ['-c', 'transfer.fsckObjects=true', '-c', 'fetch.fsckObjects=true', 'fetch', '-q', '--no-tags', '--no-write-fetch-head', file, `+HEAD:refs/smolvm/raw/${id}`]);
    const raw = await gitText(x.hostPath, ['rev-parse', `refs/smolvm/raw/${id}`]);
    const onto = x.onto || x.base;
    const tip = x.history ? raw : await replay(x.hostPath, x.guestBase, onto, raw);
    const current = await gitText(x.hostPath, ['symbolic-ref', '-q', 'HEAD']).catch(() => '');
    if (current === `refs/heads/${x.branch}`) throw fail(`ветка ${x.branch} сейчас открыта на компьютере — переключитесь на другую`, 409);
    await git(x.hostPath, ['update-ref', `refs/heads/${x.branch}`, tip]);
    const total = Number(await gitText(x.hostPath, ['rev-list', '--count', `${x.base}..${tip}`]));
    Object.assign(x, { state: 'ready', tip, commits: total, finishedAt: Date.now(), error: null });
  } finally {
    save();
    fs.rm(file, { force: true }, () => {});
    sh(x.machine, `rm -f ${sq(gb)}`).catch(() => {});
  }
  return view(x);
}

// What the branch changes against the base: commits and files with risk marks.
async function changes(id) {
  const x = get(id);
  if (!x.tip) return { item: view(x), commits: [], files: [] };
  const logText = await gitText(x.hostPath, ['log', '--format=%H%x1f%an%x1f%aI%x1f%s', `${x.base}..${x.tip}`]);
  const commits = logText ? logText.split('\n').map((l) => { const [sha, author, at, subject] = l.split('\x1f'); return { sha, author, at, subject }; }) : [];
  const range = [x.base, x.tip];
  const rawOut = (await git(x.hostPath, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--raw', '-z', ...range])).toString('utf8').split('\0');
  const files = new Map();
  for (let i = 0; i + 1 < rawOut.length; i += 2) {
    const m = /^:(\d{6}) (\d{6}) \S+ \S+ (\w)/.exec(rawOut[i]);
    if (!m) continue;
    const p = rawOut[i + 1];
    files.set(p, { path: p, kind: { A: 'added', D: 'deleted' }[m[3]] || 'modified', oldMode: m[1], mode: m[2], added: 0, removed: 0, binary: false, flags: [] });
  }
  const num = (await git(x.hostPath, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--numstat', '-z', ...range])).toString('utf8').split('\0');
  for (const rec of num) {
    const [a, d, p] = rec.split('\t');
    const f = files.get(p);
    if (!f) continue;
    if (a === '-') f.binary = true; else { f.added = Number(a); f.removed = Number(d); }
  }
  for (const f of files.values()) {
    for (const [re, why] of RISKY) if (re.test(f.path)) f.flags.push(why);
    if (f.mode === '120000') f.flags.push('символическая ссылка');
    if (f.mode === '160000') f.flags.push('подмодуль');
    if (f.mode === '100755' && f.oldMode !== '100755') f.flags.push('исполняемый файл');
    if (f.binary && f.kind !== 'deleted') f.flags.push('двоичный файл');
  }
  const list = [...files.values()].sort((a, b) => (b.flags.length > 0) - (a.flags.length > 0) || a.path.localeCompare(b.path));
  return { item: view(x), commits, files: list };
}

async function blob(cwd, sha, rel) {
  try { return await git(cwd, ['cat-file', 'blob', `${sha}:${rel}`]); } catch { return Buffer.alloc(0); }
}

async function fileDiff(id, rel) {
  const x = get(id);
  if (!x.tip) throw fail('результат ещё не забран из машины', 409);
  rel = String(rel || '');
  const { files } = await changes(id);
  if (!files.some((f) => f.path === rel)) throw fail('файл не изменён в этой ветке', 404);
  const a = await blob(x.hostPath, x.base, rel);
  const b = await blob(x.hostPath, x.tip, rel);
  if (a.length > MAX_DIFF_BYTES || b.length > MAX_DIFF_BYTES) return { tooBig: true, hostSize: a.length, guestSize: b.length };
  if (isBinary(a) || isBinary(b)) return { binary: true, hostSize: a.length, guestSize: b.length };
  return { ...unified(a.toString('utf8'), b.toString('utf8')), hostSize: a.length, guestSize: b.length };
}

async function dropRefs(x, { branch }) {
  const refs = [`refs/smolvm/base/${x.id}`, `refs/smolvm/raw/${x.id}`, ...(branch ? [`refs/heads/${x.branch}`] : [])];
  for (const r of refs) await git(x.hostPath, ['update-ref', '-d', r]).catch(() => {});
}

// Accept: the branch stays for merging (by hand or later from the UI); helper refs go.
async function accept(id) {
  const x = get(id);
  if (['accepted', 'discarded'].includes(x.state)) throw fail(`уже ${x.state === 'accepted' ? 'принято' : 'отброшено'}`, 409);
  if (x.state !== 'ready') throw fail('сначала заберите результат из машины', 409);
  await dropRefs(x, { branch: false });
  Object.assign(x, { state: 'accepted', decidedAt: Date.now() });
  save();
  return view(x);
}

async function discard(id) {
  const x = get(id);
  if (['accepted', 'discarded'].includes(x.state)) throw fail(`уже ${x.state === 'accepted' ? 'принято' : 'отброшено'}`, 409);
  const current = await gitText(x.hostPath, ['symbolic-ref', '-q', 'HEAD']).catch(() => '');
  if (current === `refs/heads/${x.branch}`) throw fail(`ветка ${x.branch} сейчас открыта на компьютере — переключитесь на другую`, 409);
  await dropRefs(x, { branch: true });
  Object.assign(x, { state: 'discarded', decidedAt: Date.now() });
  save();
  return view(x);
}

// Before a machine is deleted: take what the agent did, so nothing is lost.
async function finishMachine(name) {
  const out = [];
  for (const x of Object.values(S().items)) {
    if (x.machine !== name || !['working', 'ready'].includes(x.state)) continue;
    try { out.push(await finish(x.id)); } catch (e) { x.error = e.message; save(); out.push(view(x)); }
  }
  return out;
}

// The machine is gone: work never taken back is dropped, results stay.
function forget(name) {
  let changed = false;
  for (const x of Object.values(S().items)) {
    if (x.machine !== name || x.machineGone) continue;
    if (!x.tip && ['working', 'copying', 'error'].includes(x.state)) {
      x.state = x.finishedAt && x.state === 'working' ? 'empty' : 'lost';
      dropRefs(x, { branch: false }).catch(() => {});
    }
    x.machineGone = true;
    changed = true;
  }
  if (changed) save();
}

function view(x) {
  const { guestUser, ...rest } = x;
  return rest;
}

module.exports = {
  repoOf, inspect, add, reattach, finish, changes, fileDiff, accept, discard, finishMachine, forget,
  list: (machine) => Object.values(S().items).filter((x) => !machine || x.machine === machine).sort((a, b) => b.createdAt - a.createdAt).map(view),
  get: (id) => view(get(id)),
};
