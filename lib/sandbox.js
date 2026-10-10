'use strict';
// Sandboxes: a clean machine on every open, with the agent's memory kept.
//
//   template — `smolvm machine checkpoint` of a machine whose agents are
//              installed (RAM + disks). Every sandbox is created from it through
//              the HTTP API (so `smolvm serve` knows it) and started like any
//              machine (CLI when the filter/gateway on the host must be reachable).
//              It gets fresh agent ports and passwords, its own filter and
//              gateway tokens, and the template's filter rules and secrets.
//   profile  — files on the host: agent memory, instructions, skills, MCP
//              servers and settings (PROFILE_PATHS). Written into the sandbox
//              on open, read back on close. Tokens and sign-ins are never kept.
//   pending  — what changed in the profile while the sandbox ran. Nothing
//              reaches the profile before it is approved (diff per file), unless
//              the profile has «сохранять без ревью» on: a poisoned skill or MCP
//              entry would otherwise come back in every next clean sandbox.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');
const up = require('./upstream');
const diff = require('./diff');

const ROOT = path.join(cfg.DIR, 'sandbox');
const TPL_DIR = path.join(ROOT, 'templates');
const PROF_DIR = path.join(ROOT, 'profiles');
const PEND_DIR = path.join(ROOT, 'pending');
const store = cfg.doc('sandbox.json', { templates: {}, profiles: {}, sandboxes: {} });
const S = () => store.get();
const save = () => store.save(S());
const enc = encodeURIComponent;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const fail = (status, msg) => Object.assign(new Error(msg), { status });

// Home-relative paths kept in a profile (directories are walked).
const PROFILE_PATHS = [
  // Claude Code: global instructions, settings, skills, subagents, commands, hooks, auto memory.
  '.claude/CLAUDE.md', '.claude/settings.json', '.claude/skills', '.claude/agents', '.claude/commands',
  '.claude/output-styles', '.claude/hooks', '.claude/projects/*/memory',
  // OpenCode: opencode.json (mcp, agents), AGENTS.md, agent/, command/, plugin/.
  '.config/opencode',
  // Codex: config.toml (mcp_servers), AGENTS.md, skills, prompts.
  '.codex/config.toml', '.codex/AGENTS.md', '.codex/skills', '.codex/prompts',
  // Pi
  '.pi/agent/settings.json', '.pi/agent/models.json', '.pi/agent/AGENTS.md', '.pi/agent/SYSTEM.md',
  '.pi/agent/skills', '.pi/agent/prompts', '.pi/agent/extensions', '.pi/agent/themes',
  // Hermes: config, persona, memories, skills.
  '.hermes/config.yaml', '.hermes/SOUL.md', '.hermes/memories', '.hermes/skills',
];
// Never kept: credentials, sessions, caches, installed packages.
const SKIP_NAMES = ['node_modules', '.git', '__pycache__', '.cache', 'cache', 'sessions', 'logs', 'log', 'tmp',
  'auth.json', '.credentials.json', '.env', '.DS_Store', 'bun.lock', 'package-lock.json'];
// ~/.claude.json holds sign-in and history too: only its mcpServers go into the profile.
const CLAUDE_MCP = '.smolvm-profile/claude-mcp.json';
const FILE_MAX = 2 * 1024 * 1024;
const TOTAL_MAX = 30 * 1024 * 1024;

// One node program for both directions, run in the guest as the agent user.
// collect: prints {files:{rel:b64}, skipped:[...]}. apply: reads the same shape
// on stdin and writes it over the template's files (an empty profile keeps the
// template's agent config as is).
const GUEST = String.raw`
const fs=require("fs"),p=require("path"),H=process.env.HOME,S=JSON.parse(process.env.SBX_SPEC);
const skip=new Set(S.skip);
function expand(rel){const parts=rel.split("/");let cur=[""];for(const seg of parts){const nx=[];for(const c of cur){if(seg==="*"){let es=[];try{es=fs.readdirSync(p.join(H,c),{withFileTypes:true})}catch{}for(const e of es)if(e.isDirectory())nx.push(c?c+"/"+e.name:e.name)}else nx.push(c?c+"/"+seg:seg)}cur=nx}return cur}
function walk(rel,out){let st;try{st=fs.lstatSync(p.join(H,rel))}catch{return}
 if(st.isSymbolicLink())return;
 if(st.isDirectory()){for(const e of fs.readdirSync(p.join(H,rel)))if(!skip.has(e))walk(rel+"/"+e,out);return}
 if(st.isFile()&&!skip.has(p.basename(rel)))out.push([rel,st.size])}
function list(){const out=[];for(const r of S.paths)for(const x of expand(r))walk(x,out);return out}
const CJ=p.join(H,".claude.json");
if(process.argv[1]==="collect"){
 const files={},skipped=[];let total=0;
 for(const [rel,size] of list()){if(size>S.fileMax||total+size>S.totalMax){skipped.push(rel+" ("+size+" B)");continue}
  files[rel]=fs.readFileSync(p.join(H,rel)).toString("base64");total+=size}
 try{const c=JSON.parse(fs.readFileSync(CJ,"utf8"));if(c.mcpServers&&Object.keys(c.mcpServers).length)files[S.claudeMcp]=Buffer.from(JSON.stringify(c.mcpServers,null,2)+"\n").toString("base64")}catch{}
 process.stdout.write(JSON.stringify({files,skipped}));
}else{
 const inp=JSON.parse(fs.readFileSync(0,"utf8")).files;
 for(const [rel,b64] of Object.entries(inp)){if(rel===S.claudeMcp)continue;const f=p.join(H,rel);
  if(!f.startsWith(H+"/")||rel.split("/").includes(".."))continue;
  fs.mkdirSync(p.dirname(f),{recursive:true});fs.writeFileSync(f,Buffer.from(b64,"base64"))}
 let c={};try{c=JSON.parse(fs.readFileSync(CJ,"utf8"))}catch{}
 if(inp[S.claudeMcp]){try{c.mcpServers=JSON.parse(Buffer.from(inp[S.claudeMcp],"base64").toString())}catch{}}
 fs.writeFileSync(CJ,JSON.stringify(c,null,2));
 process.stdout.write("ok "+Object.keys(inp).length);
}`;
const SPEC = JSON.stringify({ paths: PROFILE_PATHS, skip: SKIP_NAMES, claudeMcp: CLAUDE_MCP, fileMax: FILE_MAX, totalMax: TOTAL_MAX });
const HOME = '/home/node';

async function guest(name, mode, stdin) {
  const body = { command: ['node', '-e', GUEST, mode], user: 'node', env: [{ name: 'HOME', value: HOME }, { name: 'SBX_SPEC', value: SPEC }], timeoutSecs: 120 };
  if (stdin != null) body.stdin = stdin;
  const r = await up.exec(name, body, 150000);
  if (r.exitCode !== 0) throw new Error(`профиль в машине (${mode}): ${(r.stderr || r.stdout || '').trim().slice(-400) || `код ${r.exitCode}`}`);
  return r.stdout;
}
async function collectFrom(name) {
  const out = JSON.parse(await guest(name, 'collect'));
  return { files: Object.fromEntries(Object.entries(out.files).map(([k, v]) => [k, Buffer.from(v, 'base64')])), skipped: out.skipped || [] };
}

// ---------- profiles (host) ----------
const profDir = (id) => path.join(PROF_DIR, id, 'files');
const safeRel = (rel) => {
  const r = String(rel || '').replace(/\\/g, '/');
  if (!r || r.startsWith('/') || r.split('/').some((x) => x === '..' || x === '')) throw fail(400, 'некорректный путь');
  return r;
};
function readProfile(id) {
  const root = profDir(id);
  const out = {};
  const walk = (rel) => {
    const abs = path.join(root, rel);
    let st; try { st = fs.lstatSync(abs); } catch { return; }
    if (st.isDirectory()) { for (const e of fs.readdirSync(abs)) walk(rel ? `${rel}/${e}` : e); return; }
    if (st.isFile()) out[rel] = fs.readFileSync(abs);
  };
  walk('');
  return out;
}
function writeProfileFile(id, rel, buf) {
  const f = path.join(profDir(id), safeRel(rel));
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  fs.writeFileSync(f, buf, { mode: 0o600 });
}
function removeProfileFile(id, rel) {
  const root = profDir(id);
  let f = path.join(root, safeRel(rel));
  fs.rmSync(f, { force: true });
  // Drop directories left empty.
  for (f = path.dirname(f); f.startsWith(root) && f !== root; f = path.dirname(f)) {
    try { fs.rmdirSync(f); } catch { break; }
  }
}
function profileStats(id) {
  const files = readProfile(id);
  return { files: Object.keys(files).length, size: Object.values(files).reduce((a, b) => a + b.length, 0), summary: summarize(files) };
}
// What a profile holds, as a person counts it: MCP servers, skills, memory, instruction files.
function summarize(files) {
  const mcp = new Set();
  const skills = new Set();
  let memory = 0;
  const instructions = [];
  const json = (b) => { try { return JSON.parse(b.toString('utf8')); } catch { return null; } };
  for (const [rel, buf] of Object.entries(files)) {
    const base = rel.split('/').pop();
    if (rel === CLAUDE_MCP) Object.keys(json(buf)?.mcpServers || json(buf) || {}).forEach((k) => mcp.add(k));
    else if (rel === '.config/opencode/opencode.json') Object.keys(json(buf)?.mcp || {}).forEach((k) => mcp.add(k));
    else if (rel === '.codex/config.toml') for (const m of buf.toString('utf8').matchAll(/^\[mcp_servers\.([^\]]+)\]/gm)) mcp.add(m[1]);
    else if (rel === '.hermes/config.yaml' && /^mcp_servers:/m.test(buf.toString('utf8'))) mcp.add('hermes');
    const sk = rel.match(/(?:^|\/)skills\/([^/]+)/);
    if (sk) skills.add(sk[1]);
    if (/(?:^|\/)(memory|memories)\//.test(rel)) memory += 1;
    if (['CLAUDE.md', 'AGENTS.md', 'SOUL.md', 'SYSTEM.md'].includes(base) && !/\//.test(rel.split('/').slice(2).join('/'))) instructions.push(base);
  }
  return { mcp: [...mcp], skills: skills.size, memory, instructions: [...new Set(instructions)] };
}
function getProfile(id) {
  const p = S().profiles[id];
  if (!p) throw fail(404, 'профиль не найден');
  return p;
}
function newId(prefix, taken) {
  let id;
  do id = `${prefix}-${crypto.randomBytes(3).toString('hex')}`; while (taken[id]);
  return id;
}

// A profile is also a «рабочее место»: which template and agent it opens with.
function workspaceDefaults(patch, p) {
  if (patch.template !== undefined) {
    if (patch.template && !S().templates[patch.template]) throw fail(400, 'шаблон не найден');
    p.template = patch.template || null;
  }
  if (patch.agent !== undefined) p.agent = patch.agent ? String(patch.agent).slice(0, 40) : null;
}
async function createProfile({ name, from, template, agent }) {
  const title = String(name || '').trim().slice(0, 60);
  if (!title) throw fail(400, 'Укажите название профиля');
  const id = newId('p', S().profiles);
  let seeded = null;
  if (from) seeded = await collectFrom(from); // a running machine whose agents are already set up
  const rec = { id, name: title, autoSave: false, createdAt: Date.now(), updatedAt: Date.now(), from: from || null, template: null, agent: null };
  workspaceDefaults({ template, agent }, rec);
  S().profiles[id] = rec;
  save();
  fs.mkdirSync(profDir(id), { recursive: true, mode: 0o700 });
  if (seeded) for (const [rel, buf] of Object.entries(seeded.files)) writeProfileFile(id, rel, buf);
  return { id, skipped: seeded?.skipped || [] };
}
function updateProfile(id, patch) {
  const p = getProfile(id);
  if (typeof patch.name === 'string' && patch.name.trim()) p.name = patch.name.trim().slice(0, 60);
  if (typeof patch.autoSave === 'boolean') p.autoSave = patch.autoSave;
  workspaceDefaults(patch, p);
  p.updatedAt = Date.now();
  save();
  return p;
}
function deleteProfile(id) {
  getProfile(id);
  if (Object.values(S().sandboxes).some((x) => x.profile === id)) throw fail(409, 'профиль используется открытой песочницей — сначала закройте её');
  delete S().profiles[id];
  save();
  fs.rmSync(path.join(PROF_DIR, id), { recursive: true, force: true });
  for (const x of listPending()) if (x.profile === id) fs.rmSync(pendFile(x.id), { force: true });
}
function profileFiles(id) {
  getProfile(id);
  return Object.entries(readProfile(id)).map(([p, b]) => ({ path: p, size: b.length, binary: diff.isBinary(b) })).sort((a, b) => a.path.localeCompare(b.path));
}
function profileFile(id, rel) {
  getProfile(id);
  const f = path.join(profDir(id), safeRel(rel));
  let b; try { b = fs.readFileSync(f); } catch { throw fail(404, 'файл не найден'); }
  return diff.isBinary(b) ? { path: rel, binary: true, size: b.length } : { path: rel, size: b.length, text: b.toString('utf8') };
}
function deleteProfileFile(id, rel) { getProfile(id); removeProfileFile(id, rel); touch(id); }
function putProfileFile(id, rel, text) {
  getProfile(id);
  if (typeof text !== 'string' || text.length > FILE_MAX) throw fail(400, 'нужен текст до 2 МБ');
  writeProfileFile(id, rel, Buffer.from(text, 'utf8'));
  touch(id);
}
function touch(id) { const p = S().profiles[id]; if (p) { p.updatedAt = Date.now(); save(); } }

// ---------- pending changes ----------
const pendFile = (id) => path.join(PEND_DIR, `${id}.json`);
function listPending() {
  let names = [];
  try { names = fs.readdirSync(PEND_DIR).filter((f) => f.endsWith('.json')); } catch {}
  return names.map((f) => { try { return JSON.parse(fs.readFileSync(path.join(PEND_DIR, f), 'utf8')); } catch { return null; } }).filter(Boolean)
    .sort((a, b) => b.at - a.at);
}
function getPending(id) {
  if (!/^[\w.-]+$/.test(id)) throw fail(400, 'некорректный id');
  try { return JSON.parse(fs.readFileSync(pendFile(id), 'utf8')); } catch { throw fail(404, 'нет изменений на проверку'); }
}
// Changes between the profile now and what came back from the sandbox.
function changesOf(profileId, back) {
  const cur = readProfile(profileId);
  const out = [];
  for (const [rel, buf] of Object.entries(back)) {
    if (!cur[rel]) out.push({ path: rel, kind: 'added', new: buf.toString('base64') });
    else if (!cur[rel].equals(buf)) out.push({ path: rel, kind: 'modified', old: cur[rel].toString('base64'), new: buf.toString('base64') });
  }
  for (const rel of Object.keys(cur)) if (!back[rel]) out.push({ path: rel, kind: 'deleted', old: cur[rel].toString('base64') });
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
function pendingSummary(x) {
  return { id: x.id, profile: x.profile, profileName: S().profiles[x.profile]?.name || x.profile, sandbox: x.sandbox, template: x.template, at: x.at, skipped: x.skipped || [],
    changes: x.changes.map((c) => ({ path: c.path, kind: c.kind })) };
}
function pendingDiff(id, rel) {
  const c = getPending(id).changes.find((x) => x.path === rel);
  if (!c) throw fail(404, 'файл не найден среди изменений');
  const a = Buffer.from(c.old || '', 'base64'); const b = Buffer.from(c.new || '', 'base64');
  if (diff.isBinary(a) || diff.isBinary(b)) return { path: rel, kind: c.kind, binary: true, oldSize: a.length, newSize: b.length };
  return { path: rel, kind: c.kind, oldSize: a.length, newSize: b.length, ...diff.unified(a.toString('utf8'), b.toString('utf8')) };
}
// Apply the chosen paths (all when empty) to the profile; the rest are dropped.
function applyPending(id, paths) {
  const x = getPending(id);
  getProfile(x.profile);
  const want = paths?.length ? new Set(paths) : null;
  const applied = [];
  for (const c of x.changes) {
    if (want && !want.has(c.path)) continue;
    if (c.kind === 'deleted') removeProfileFile(x.profile, c.path);
    else writeProfileFile(x.profile, c.path, Buffer.from(c.new, 'base64'));
    applied.push(c.path);
  }
  x.changes = want ? x.changes.filter((c) => !want.has(c.path)) : [];
  if (x.changes.length) fs.writeFileSync(pendFile(id), JSON.stringify(x), { mode: 0o600 }); else fs.rmSync(pendFile(id), { force: true });
  touch(x.profile);
  return { applied, left: x.changes.length };
}
function dropPending(id, paths) {
  const x = getPending(id);
  if (paths?.length) {
    x.changes = x.changes.filter((c) => !paths.includes(c.path));
    if (x.changes.length) { fs.writeFileSync(pendFile(id), JSON.stringify(x), { mode: 0o600 }); return { left: x.changes.length }; }
  }
  fs.rmSync(pendFile(id), { force: true });
  return { left: 0 };
}

// ---------- templates ----------
const jobs = new Map(); // template id -> { status, step, error }

// Why smolvm cannot checkpoint this machine (null when it can).
function blocker(m) {
  if (m.mounts?.some((x) => x.target === '/etc/smolvm-host-trust')) {
    return 'к машине подключён том с корпоративными сертификатами для скачивания образа — smolvm не делает чекпоинт машин с томами хоста. Выключите «Настройки» → «Прокси и сертификаты» → «Доверять им при скачивании образа» (образ уже скачан) и повторите';
  }
  if (m.mounts?.length) return `к машине подключены папки хоста (${m.mounts.map((x) => x.target).join(', ')}) — smolvm не делает чекпоинт таких машин. Отключите директории машины (страница «Директории») или используйте рабочие копии`;
  if (m.gpu || m.cuda) return 'smolvm не делает чекпоинт машин с GPU/CUDA';
  if (m.network && !m.networkBackend) return 'у машины не задан сетевой режим явно — из чекпоинта она поднимется с другим сетевым устройством. Создайте машину заново в smolvm-web';
  return null;
}

async function machineInfo(name) {
  const r = await up.request('GET', `/api/v1/machines/${enc(name)}`);
  if (r.status !== 200) throw fail(404, `машина ${name} не найдена`);
  return r.data;
}

// Checkpoint `source` as a template. `startMachine(name, {branchable})` is the server's start.
async function createTemplate({ source, title, id: existing }, startMachine) {
  const agents = require('./agents');
  const egress = require('./egress');
  const vault = require('./vault');
  const am = agents.get(source);
  if (!am?.agents?.length) throw fail(400, 'у машины нет агентов — шаблон делается из машины с пресетом агента');
  if (!am.installed) throw fail(400, 'агенты в машине ещё не установлены — запустите её и дождитесь установки');
  const info0 = await machineInfo(source);
  const why = blocker(info0);
  if (why) throw fail(400, why);
  if (S().sandboxes[source]) throw fail(400, 'это песочница — шаблон делается из обычной машины');
  const id = existing || newId('t', S().templates);
  if (existing && !S().templates[existing]) throw fail(404, 'шаблон не найден');
  if (jobs.get(id)?.status === 'running') throw fail(409, 'шаблон уже готовится');
  const job = { status: 'running', step: 'подготовка', error: null, source };
  jobs.set(id, job);
  (async () => {
    const wasRunning = info0.state === 'running';
    try {
      // macOS: smolvm checkpoints only a machine started branchable.
      if (wasRunning) {
        job.step = 'перезапуск машины с поддержкой чекпоинта';
        const r = await up.request('POST', `/api/v1/machines/${enc(source)}/stop`, {});
        if (r.status !== 200) throw new Error(`остановка: ${r.data?.error || r.status}`);
      } else job.step = 'запуск машины с поддержкой чекпоинта';
      await startMachine(source, { branchable: true });
      const m = await machineInfo(source);
      const why2 = blocker(m);
      if (why2) throw new Error(why2);
      await up.waitReady(source);
      job.step = 'чекпоинт';
      const dir = path.join(TPL_DIR, id);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, 'base.checkpoint');
      const tmp = path.join(dir, `base.${Date.now()}.checkpoint`);
      await require('./machines').runCli(['machine', 'checkpoint', '--name', source, '-o', tmp], { timeoutMs: 20 * 60 * 1000 });
      fs.renameSync(tmp, file);
      const eg = egress.getMachine(source);
      const secrets = (await vault.machineSecrets(source).catch(() => [])).map((x) => x.name);
      const prev = S().templates[id];
      S().templates[id] = {
        id, title: String(title || prev?.title || source).trim().slice(0, 60) || source, source, file, size: fs.statSync(file).size,
        createdAt: prev?.createdAt || Date.now(), updatedAt: Date.now(),
        image: m.image, cpus: m.cpus, memoryMb: m.memoryMb,
        agents: { profile: am.profile, agents: am.agents, revoked: am.revoked || [] },
        egress: eg ? { enabled: eg.enabled, strict: eg.strict, lists: eg.lists, rules: eg.rules, strictApplied: eg.strictApplied || null } : null,
        secrets, useProxy: cfg.machineUsesProxy(source),
      };
      save();
      if (!wasRunning) {
        job.step = 'остановка исходной машины';
        await up.request('POST', `/api/v1/machines/${enc(source)}/stop`, {}).catch(() => {});
      }
      job.status = 'ok'; job.step = 'готово';
      require('./audit').record({ type: 'sandbox', machine: source, actor: 'smolvm-web', action: existing ? 'шаблон песочницы обновлён' : 'шаблон песочницы создан', detail: { template: id } });
    } catch (e) {
      job.status = 'error'; job.error = e.message;
    }
  })();
  return { id, job };
}

function deleteTemplate(id) {
  if (!S().templates[id]) throw fail(404, 'шаблон не найден');
  if (Object.values(S().sandboxes).some((x) => x.template === id)) throw fail(409, 'из шаблона открыты песочницы — сначала закройте их');
  delete S().templates[id];
  save();
  jobs.delete(id);
  fs.rmSync(path.join(TPL_DIR, id), { recursive: true, force: true });
}

// ---------- sandboxes ----------
const opening = new Map(); // name -> step

async function open({ template, profile, agent }, { startMachine, deleteMachine }) {
  const agents = require('./agents');
  const egress = require('./egress');
  const vault = require('./vault');
  const t = S().templates[template];
  if (!t) throw fail(404, 'шаблон не найден');
  if (!fs.existsSync(t.file)) throw fail(410, 'файл чекпоинта шаблона пропал с диска — обновите шаблон');
  if (profile) getProfile(profile);
  if (agent && !t.agents.agents.includes(agent)) throw fail(400, 'в шаблоне нет такого агента');
  const slug = (t.title || t.source).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'sbx';
  const r0 = await up.request('GET', '/api/v1/machines');
  const taken = new Set((r0.data?.machines || []).map((m) => m.name));
  let name;
  do name = `sbx-${slug}-${crypto.randomBytes(2).toString('hex')}`; while (taken.has(name) || S().sandboxes[name]);

  opening.set(name, 'создание из шаблона');
  let created = false;
  try {
    const ports = await agents.adopt(name, t.agents);
    const r = await up.request('POST', '/api/v1/machines', { name, from: t.file, ports });
    if (r.status !== 200) throw new Error(`создание из чекпоинта: ${r.data?.error || `HTTP ${r.status}`}`);
    created = true;
    cfg.setMachineProxy(name, t.useProxy);
    egress.forgetMachine(name);
    if (t.egress) {
      // Own filter tokens; the template's rules. Its strict policy is in the checkpoint already.
      egress.setMachine(name, { enabled: t.egress.enabled, strict: t.egress.strict, lists: t.egress.lists, rules: t.egress.rules });
      egress.setMachine(name, { strictApplied: t.egress.strictApplied });
    }
    const have = new Set((await vault.list().catch(() => [])).map((x) => x.name));
    const secrets = t.secrets.filter((n) => have.has(n));
    if (secrets.length) await vault.bind(name, secrets);
    S().sandboxes[name] = { name, template: t.id, profile: profile || null, agent: agent || null, createdAt: Date.now() };
    if (profile) Object.assign(S().profiles[profile], { template: t.id, agent: agent || S().profiles[profile].agent || null, openedAt: Date.now() });
    save();
    opening.set(name, 'запуск');
    await startMachine(name, {});
    if (profile) {
      opening.set(name, 'профиль агента');
      const files = readProfile(profile);
      await guest(name, 'apply', JSON.stringify({ files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.toString('base64')])) }));
    }
    let url = null;
    if (agent) {
      opening.set(name, 'запуск агента');
      url = (await agents.start(name, agent)).url;
    }
    require('./audit').record({ type: 'sandbox', machine: name, actor: 'smolvm-web', action: 'песочница открыта', detail: { template: t.id, profile: profile || null, agent: agent || null } });
    return { name, url };
  } catch (e) {
    delete S().sandboxes[name];
    save();
    if (created) await deleteMachine(name).catch(() => {});
    else agents.forget(name);
    throw e;
  } finally {
    opening.delete(name);
  }
}

// Close: read the profile back (unless discarded), then delete the machine.
async function close(name, { save: keep = true } = {}, { deleteMachine }) {
  const sb = S().sandboxes[name];
  if (!sb) throw fail(404, 'песочница не найдена');
  let result = { changes: 0, pending: null, applied: 0 };
  if (keep && sb.profile && S().profiles[sb.profile]) {
    const m = await machineInfo(name).catch(() => null);
    if (m?.state !== 'running') throw fail(409, 'машина песочницы не запущена — запустите её, чтобы забрать профиль, или закройте без сохранения');
    const back = await collectFrom(name);
    const changes = changesOf(sb.profile, back.files);
    result.changes = changes.length;
    if (changes.length) {
      const id = `${sb.profile}--${name}`;
      fs.mkdirSync(PEND_DIR, { recursive: true, mode: 0o700 });
      fs.writeFileSync(pendFile(id), JSON.stringify({ id, profile: sb.profile, sandbox: name, template: sb.template, at: Date.now(), skipped: back.skipped, changes }), { mode: 0o600 });
      if (S().profiles[sb.profile].autoSave) result.applied = applyPending(id, []).applied.length;
      else result.pending = id;
    }
  }
  await deleteMachine(name);
  require('./audit').record({ type: 'sandbox', machine: name, actor: 'smolvm-web', action: keep ? 'песочница закрыта' : 'песочница закрыта без сохранения', detail: { profile: sb.profile, changes: result.changes, pending: result.pending } });
  return result;
}

// The machine is gone (deleted from anywhere): drop the record.
function forget(name) {
  if (S().sandboxes[name]) { delete S().sandboxes[name]; save(); }
}

async function overview() {
  const r = await up.request('GET', '/api/v1/machines').catch(() => null);
  const machines = new Map((r?.data?.machines || []).map((m) => [m.name, m]));
  const agents = require('./agents');
  return {
    templates: Object.values(S().templates).map((t) => ({ ...t, file: undefined, missing: !fs.existsSync(t.file), job: jobs.get(t.id) || null }))
      .concat([...jobs].filter(([id]) => !S().templates[id]).map(([id, job]) => ({ id, title: job.source, source: job.source, job, creating: true })))
      .sort((a, b) => (b.createdAt || Infinity) - (a.createdAt || Infinity)),
    profiles: Object.values(S().profiles).map((p) => ({ ...p, ...profileStats(p.id) })).sort((a, b) => b.updatedAt - a.updatedAt),
    sandboxes: Object.values(S().sandboxes).map((x) => {
      const m = machines.get(x.name);
      const am = agents.get(x.name);
      return { ...x, state: m?.state || 'missing', opening: opening.get(x.name) || null,
        agents: (am?.agents || []).map((id) => ({ id, title: agents.AGENTS[id]?.title, mark: agents.AGENTS[id]?.mark })) };
    }).sort((a, b) => b.createdAt - a.createdAt),
    pending: listPending().map(pendingSummary),
    paths: PROFILE_PATHS,
  };
}

module.exports = {
  PROFILE_PATHS, overview, createTemplate, deleteTemplate, open, close, forget,
  createProfile, updateProfile, deleteProfile, profileFiles, profileFile, deleteProfileFile, putProfileFile,
  pendingSummary: (id) => pendingSummary(getPending(id)), pendingDiff, applyPending, dropPending,
  isSandbox: (name) => !!S().sandboxes[name],
  opening: () => [...opening].map(([name, step]) => ({ name, step })),
  templateJobs: () => [...jobs].filter(([, j]) => j.status === 'running').map(([, j]) => ({ name: j.source, step: j.step })),
};
