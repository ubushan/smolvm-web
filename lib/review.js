'use strict';
// Review copies: the agent works on a copy of a host folder inside the machine;
// nothing reaches the host until you apply it.
//
// No mount is involved (a host mount would also block snapshots, and smolvm's
// `:staged` mounts copy changes back on every graceful stop, i.e. without
// review). The folder is packed with tar, uploaded through the files API and
// unpacked in the machine. A manifest (sha256 per file at copy time) is kept
// here, so a change is: guest != manifest; a conflict: the host also moved
// away from the manifest. Apply writes guest files to the host; reject puts
// the host version back into the machine.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const cfg = require('./config');
const up = require('./upstream');
const { unified, isBinary } = require('./diff');

const store = cfg.doc('review.json', { machines: {} });
const enc = encodeURIComponent;
const DEFAULT_EXCLUDE = ['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.DS_Store', '.idea', '.next', 'dist', 'target'];
const MAX_TAR = 1024 * 1024 * 1024; // 1 GiB
const MAX_DIFF_BYTES = 2 * 1024 * 1024;
const GUEST_FORBIDDEN = ['/', '/bin', '/boot', '/dev', '/etc', '/lib', '/proc', '/root', '/run', '/sbin', '/sys', '/usr', '/var', '/tmp', '/home'];
const busy = new Map(); // name -> what

const S = () => store.get();
const dirsOf = (name) => (S().machines[name]?.dirs || []);
function save(name, list) { const s = S(); s.machines[name] = { dirs: list }; store.save(s); }
const find = (name, id) => {
  const d = dirsOf(name).find((x) => x.id === id);
  if (!d) throw Object.assign(new Error('рабочая копия не найдена'), { status: 404 });
  return d;
};
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });

// ---------- host side ----------
function excluded(rel, exclude) {
  return rel.split('/').some((seg) => exclude.includes(seg));
}

// rel -> sha256 of every regular file (symlinks: "link:<target>").
function hostManifest(root, exclude) {
  const out = {};
  const walk = (dir, prefix) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (excluded(rel, exclude)) continue;
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) { try { out[rel] = `link:${fs.readlinkSync(full)}`; } catch {} continue; }
      if (e.isDirectory()) { walk(full, rel); continue; }
      if (!e.isFile()) continue;
      try { out[rel] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'); } catch {}
    }
  };
  walk(root, '');
  return out;
}

// Safe host path for a manifest-relative path: inside root, no symlinked parents.
function hostTarget(root, rel) {
  if (!rel || rel.includes('\0') || path.isAbsolute(rel) || rel.split('/').some((s) => s === '..' || s === '')) throw fail(`недопустимый путь: ${rel}`);
  const full = path.join(root, ...rel.split('/'));
  const realRoot = fs.realpathSync.native(root);
  let dir = path.dirname(full);
  while (!fs.existsSync(dir)) dir = path.dirname(dir);
  const realDir = fs.realpathSync.native(dir);
  if (realDir !== realRoot && !realDir.startsWith(realRoot + path.sep)) throw fail(`путь выходит за пределы папки: ${rel}`);
  try { if (fs.lstatSync(full).isSymbolicLink()) throw fail(`на хосте это ссылка (symlink), не перезаписываю: ${rel}`); } catch (e) { if (e.status) throw e; }
  return full;
}

function makeTar(root, exclude) {
  return new Promise((resolve, reject) => {
    const file = path.join(os.tmpdir(), `smolvm-review-${crypto.randomBytes(6).toString('hex')}.tar`);
    const args = ['-cf', file, '-C', root];
    for (const x of exclude) args.push(`--exclude=${x}`);
    args.push('.');
    // COPYFILE_DISABLE: no AppleDouble ._* files from macOS tar.
    const p = spawn('tar', args, { env: { ...process.env, COPYFILE_DISABLE: '1' }, windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => reject(new Error(`tar: ${e.message}`)));
    p.on('close', (code) => (code === 0 ? resolve(file) : reject(new Error(`tar завершился с кодом ${code}: ${err.slice(-300)}`))));
  });
}

// ---------- guest side ----------
function putFile(name, guestPath, bodyStream, size) {
  return new Promise((resolve, reject) => {
    const req = http.request({ ...up.target(), method: 'PUT', path: `/api/v1/machines/${enc(name)}/files/${enc(guestPath)}`,
      headers: { host: 'localhost', 'content-type': 'application/octet-stream', 'content-length': size } }, (res) => {
      let t = ''; res.on('data', (d) => { t += d; });
      res.on('end', () => (res.statusCode === 200 ? resolve() : reject(new Error(`загрузка в машину: HTTP ${res.statusCode} ${t.slice(0, 200)}`))));
    });
    req.on('error', reject);
    if (Buffer.isBuffer(bodyStream)) req.end(bodyStream); else bodyStream.pipe(req);
  });
}

function getFile(name, guestPath) {
  return new Promise((resolve, reject) => {
    http.get({ ...up.target(), path: `/api/v1/machines/${enc(name)}/files/${enc(guestPath)}`, headers: { host: 'localhost' } }, (res) => {
      const chunks = []; res.on('data', (d) => chunks.push(d));
      res.on('end', () => (res.statusCode === 200 ? resolve(Buffer.concat(chunks)) : reject(new Error(`чтение из машины: HTTP ${res.statusCode}`))));
    }).on('error', reject);
  });
}

const sq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

async function sh(name, script, { timeoutSecs = 300, stdin } = {}) {
  const r = await up.exec(name, { command: ['sh', '-c', script], user: '0', timeoutSecs, ...(stdin != null ? { stdin } : {}) }, (timeoutSecs + 15) * 1000);
  return r;
}

// rel -> sha256 (or link:<target>) and the set of executable files, in the guest copy.
async function guestManifest(name, d) {
  const prune = d.exclude.map((x) => `-name ${sq(x)}`).join(' -o ');
  const script = `cd ${sq(d.guestPath)} 2>/dev/null || { echo NOCOPY; exit 0; }
find . ${prune ? `\\( ${prune} \\) -prune -o` : ''} -type f -print0 | xargs -0 -r sha256sum
echo ::links
find . ${prune ? `\\( ${prune} \\) -prune -o` : ''} -type l -print | while IFS= read -r f; do printf '%s\\t%s\\n' "$f" "$(readlink "$f")"; done
echo ::exec
find . ${prune ? `\\( ${prune} \\) -prune -o` : ''} -type f -perm -u+x -print`;
  const r = await sh(name, script, { timeoutSecs: 600 });
  if (r.exitCode !== 0) throw fail(`не удалось прочитать копию в машине: ${(r.stderr || r.stdout).slice(-300)}`, 500);
  if (r.stdout.startsWith('NOCOPY')) return null;
  const out = {}; const exec = new Set();
  let section = 'files';
  for (const line of r.stdout.split('\n')) {
    if (line === '::links') { section = 'links'; continue; }
    if (line === '::exec') { section = 'exec'; continue; }
    if (!line) continue;
    if (section === 'files') {
      const m = /^([0-9a-f]{64}) [ *]\.\/(.*)$/.exec(line);
      if (m) out[m[2]] = m[1];
    } else if (section === 'links') {
      const [f, target] = line.split('\t');
      if (f?.startsWith('./')) out[f.slice(2)] = `link:${target}`;
    } else if (line.startsWith('./')) exec.add(line.slice(2));
  }
  return { files: out, exec };
}

// ---------- operations ----------
function validate(name, { hostPath, guestPath, exclude }) {
  const dirs = require('./dirs');
  const p = String(hostPath || '').trim();
  if (!p || !path.isAbsolute(p)) throw fail('Путь на хосте должен быть абсолютным');
  let real;
  try { real = fs.realpathSync.native(p); } catch { throw fail(`Нет такой папки: ${p}`); }
  if (!fs.statSync(real).isDirectory()) throw fail(`Это не папка: ${real}`);
  const why = dirs._internal.sensitive(real);
  if (why) throw fail(`Нельзя: ${why}`);
  const inside = (a, b) => a === b || a.startsWith(b + path.sep);
  if (inside(real, fs.realpathSync.native(cfg.DIR)) || inside(fs.realpathSync.native(cfg.DIR), real)) throw fail('Папка содержит настройки и хранилище секретов smolvm-web');
  if (dirs.strict() && !dirs.listDirs().some((d) => inside(real, d.hostPath))) {
    throw fail('Строгий режим «Директорий»: папка должна быть внутри одной из разрешённых директорий');
  }
  const g = String(guestPath || '').trim().replace(/\/+$/, '');
  if (!g.startsWith('/') || g.split('/').includes('..')) throw fail('Путь в машине должен быть абсолютным');
  if (GUEST_FORBIDDEN.includes(g) || ['/proc', '/sys', '/dev', '/etc', '/usr', '/bin', '/sbin', '/lib', '/boot', '/run'].some((x) => g.startsWith(`${x}/`))) throw fail(`Путь в машине ${g} — системный, выберите, например, /work/<имя>`);
  if (dirsOf(name).some((x) => x.guestPath === g || g.startsWith(`${x.guestPath}/`) || x.guestPath.startsWith(`${g}/`))) throw fail(`${g} пересекается с другой рабочей копией`);
  const ex = Array.isArray(exclude) ? exclude.map((x) => String(x).trim()).filter((x) => x && !x.includes('/')) : DEFAULT_EXCLUDE;
  return { hostPath: real, guestPath: g, exclude: ex };
}

async function add(name, body) {
  const v = validate(name, body);
  const base = path.basename(v.hostPath).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 32) || 'dir';
  let id = base; let n = 1;
  while (dirsOf(name).some((x) => x.id === id)) id = `${base}-${++n}`;
  const list = dirsOf(name);
  list.push({ id, ...v, manifest: null, copiedAt: null, state: 'pending' });
  save(name, list);
  const st = await up.request('GET', `/api/v1/machines/${enc(name)}`);
  if (st.data?.state === 'running') await copyIn(name, id);
  return view(find(name, id));
}

// (Re)create the copy in the machine from the host folder.
async function copyIn(name, id) {
  const d = find(name, id);
  busy.set(name, `копирование ${d.id}`);
  let tar;
  try {
    await up.waitReady(name, 90000);
    const manifest = hostManifest(d.hostPath, d.exclude);
    tar = await makeTar(d.hostPath, d.exclude);
    const size = fs.statSync(tar).size;
    if (size > MAX_TAR) throw fail(`папка больше ${MAX_TAR / 1024 / 1024} МБ после исключений — добавьте исключения`);
    const guestTar = `/tmp/.smolvm-review-${d.id}.tar`;
    await putFile(name, guestTar, fs.createReadStream(tar), size);
    const r = await sh(name, `set -e
rm -rf ${sq(d.guestPath)}; mkdir -p ${sq(d.guestPath)}
tar -xf ${sq(guestTar)} -C ${sq(d.guestPath)}; rm -f ${sq(guestTar)}
if id node >/dev/null 2>&1; then chown -R node:node ${sq(d.guestPath)}; fi`, { timeoutSecs: 900 });
    if (r.exitCode !== 0) throw fail(`распаковка в машине: ${(r.stderr || r.stdout).slice(-300)}`, 500);
    const list = dirsOf(name);
    Object.assign(list.find((x) => x.id === id), { manifest, copiedAt: Date.now(), state: 'ready', error: null, files: Object.keys(manifest).length, bytes: size });
    save(name, list);
  } catch (e) {
    const list = dirsOf(name);
    const x = list.find((y) => y.id === id);
    if (x) { x.state = 'error'; x.error = e.message; save(name, list); }
    throw e;
  } finally {
    busy.delete(name);
    if (tar) fs.rm(tar, { force: true }, () => {});
  }
}

// Changes made in the machine since the copy (or the last apply/reject).
async function changes(name, id) {
  const d = find(name, id);
  if (d.state !== 'ready') return { dir: view(d), changes: [], missing: d.state !== 'pending' };
  const g = await guestManifest(name, d);
  if (!g) return { dir: view(d), changes: [], missing: true };
  const h = hostManifest(d.hostPath, d.exclude);
  const m = d.manifest || {};
  const out = [];
  for (const rel of new Set([...Object.keys(m), ...Object.keys(g.files)])) {
    if (g.files[rel] === m[rel]) continue;
    const kind = !(rel in m) ? 'added' : !(rel in g.files) ? 'deleted' : 'modified';
    out.push({ path: rel, kind, conflict: h[rel] !== m[rel], link: String(g.files[rel] || m[rel] || '').startsWith('link:'), exec: g.exec.has(rel) });
  }
  // Untouched in the machine, changed on the host: can be pulled in.
  const hostAhead = Object.keys({ ...m, ...h }).filter((rel) => h[rel] !== m[rel] && g.files[rel] === m[rel]).length;
  out.sort((a, b) => a.path.localeCompare(b.path));
  return { dir: view(d), changes: out, hostAhead };
}

async function fileDiff(name, id, rel) {
  const d = find(name, id);
  const hostFile = path.join(d.hostPath, ...rel.split('/'));
  let hostBuf = Buffer.alloc(0); let guestBuf = Buffer.alloc(0);
  try { if (fs.lstatSync(hostFile).isFile()) hostBuf = fs.readFileSync(hostFile); } catch {}
  try { guestBuf = await getFile(name, `${d.guestPath}/${rel}`); } catch {}
  if (hostBuf.length > MAX_DIFF_BYTES || guestBuf.length > MAX_DIFF_BYTES) return { tooBig: true, hostSize: hostBuf.length, guestSize: guestBuf.length };
  if (isBinary(hostBuf) || isBinary(guestBuf)) return { binary: true, hostSize: hostBuf.length, guestSize: guestBuf.length };
  return { ...unified(hostBuf.toString('utf8'), guestBuf.toString('utf8')), hostSize: hostBuf.length, guestSize: guestBuf.length };
}

// Write chosen guest changes to the host.
async function apply(name, id, rels) {
  const d = find(name, id);
  const { changes: list } = await changes(name, id);
  const want = new Set(rels && rels.length ? rels : list.map((c) => c.path));
  const done = []; const skipped = [];
  const manifest = { ...d.manifest };
  for (const c of list) {
    if (!want.has(c.path)) continue;
    try {
      if (c.link) { skipped.push({ path: c.path, why: 'символическая ссылка — перенесите вручную' }); continue; }
      const target = hostTarget(d.hostPath, c.path);
      if (c.kind === 'deleted') {
        fs.rmSync(target, { force: true });
        delete manifest[c.path];
      } else {
        const buf = await getFile(name, `${d.guestPath}/${c.path}`);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const tmp = `${target}.smolvm-${crypto.randomBytes(3).toString('hex')}`;
        let mode = 0o644;
        try { mode = fs.statSync(target).mode & 0o777; } catch { if (c.exec) mode = 0o755; }
        fs.writeFileSync(tmp, buf, { mode });
        fs.renameSync(tmp, target);
        manifest[c.path] = crypto.createHash('sha256').update(buf).digest('hex');
      }
      done.push(c.path);
    } catch (e) { skipped.push({ path: c.path, why: e.message }); }
  }
  const all = dirsOf(name);
  all.find((x) => x.id === id).manifest = manifest;
  save(name, all);
  return { applied: done, skipped };
}

// Put the host version back into the machine (drop the agent's change).
async function reject(name, id, rels, { onlyHostAhead = false } = {}) {
  const d = find(name, id);
  const manifest = { ...d.manifest };
  const h = hostManifest(d.hostPath, d.exclude);
  let targets;
  if (onlyHostAhead) {
    const g = await guestManifest(name, d);
    targets = Object.keys({ ...manifest, ...h }).filter((rel) => h[rel] !== manifest[rel] && g.files[rel] === manifest[rel]);
  } else {
    const { changes: list } = await changes(name, id);
    const want = new Set(rels && rels.length ? rels : list.map((c) => c.path));
    targets = list.filter((c) => want.has(c.path)).map((c) => c.path);
  }
  const done = []; const skipped = [];
  for (const rel of targets) {
    const gpath = `${d.guestPath}/${rel}`;
    try {
      const hv = h[rel];
      if (hv === undefined) {
        const r = await sh(name, `rm -f ${sq(gpath)}`);
        if (r.exitCode !== 0) throw new Error(r.stderr);
        delete manifest[rel];
      } else if (hv.startsWith('link:')) {
        const r = await sh(name, `mkdir -p "$(dirname ${sq(gpath)})" && ln -sfn ${sq(hv.slice(5))} ${sq(gpath)}`);
        if (r.exitCode !== 0) throw new Error(r.stderr);
        manifest[rel] = hv;
      } else {
        const buf = fs.readFileSync(path.join(d.hostPath, ...rel.split('/')));
        await sh(name, `mkdir -p "$(dirname ${sq(gpath)})"`);
        await putFile(name, gpath, buf, buf.length);
        manifest[rel] = hv;
      }
      done.push(rel);
    } catch (e) { skipped.push({ path: rel, why: e.message }); }
  }
  if (done.length) await sh(name, `if id node >/dev/null 2>&1; then chown -R node:node ${sq(d.guestPath)}; fi`).catch(() => {});
  const all = dirsOf(name);
  all.find((x) => x.id === id).manifest = manifest;
  save(name, all);
  return { reverted: done, skipped };
}

async function remove(name, id, { deleteCopy } = {}) {
  const d = find(name, id);
  if (deleteCopy) await sh(name, `rm -rf ${sq(d.guestPath)}`).catch(() => {});
  save(name, dirsOf(name).filter((x) => x.id !== id));
}

// Copy pending dirs after a start.
async function provision(name) {
  const out = [];
  for (const d of dirsOf(name).filter((x) => x.state === 'pending')) {
    try { await copyIn(name, d.id); out.push(d.id); } catch (e) { out.push(`${d.id}: ${e.message}`); }
  }
  return out;
}

function view(d) {
  const { manifest, ...rest } = d;
  return rest;
}

module.exports = {
  DEFAULT_EXCLUDE,
  list: (name) => dirsOf(name).map(view),
  add, copyIn, changes, fileDiff, apply, reject, remove, provision,
  busy: (name) => busy.get(name) || null,
  running: () => [...busy].map(([n, step]) => ({ name: n, step })),
  exportState: (name) => JSON.parse(JSON.stringify(S().machines[name] || null)),
  importState(name, st) { const s = S(); if (st) s.machines[name] = JSON.parse(JSON.stringify(st)); else delete s.machines[name]; store.save(s); },
  forget(name) { const s = S(); if (s.machines[name]) { delete s.machines[name]; store.save(s); } },
};
