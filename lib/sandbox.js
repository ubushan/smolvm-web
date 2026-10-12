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
const store = cfg.doc('sandbox.json', { templates: {}, profiles: {}, sandboxes: {}, policy: {} });
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
  return { mcp: [...mcp], skills: skills.size, memory, instructions: [...new Set(instructions)], secrets: findSecrets(files) };
}

// Tokens written in plain text into MCP / agent configs. Names only, never values:
// such a token is inside every sandbox of the profile and visible to the agent.
const SECRET_KEY = /(token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|auth|credential|\bpat\b)/i;
const SECRET_VALUE = /^(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|glpat-[\w-]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[\w-]{10,}|AKIA[0-9A-Z]{16}|AIza[\w-]{30,}|Bearer\s+\S{16,}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,})$/;
const PLACEHOLDER = /^(\$\{?[A-Za-z_]|<|%|\{\{|env:|op:\/\/|your|changeme|xxx|\*+$)/i;
const CONFIGS = new Set([CLAUDE_MCP, '.config/opencode/opencode.json', '.codex/config.toml', '.hermes/config.yaml', '.claude/settings.json', '.pi/agent/settings.json', '.pi/agent/models.json']);
function looksSecret(key, val) {
  if (typeof val !== 'string') return false;
  const v = val.trim();
  if (PLACEHOLDER.test(v)) return false;
  if (SECRET_VALUE.test(v)) return true;
  return SECRET_KEY.test(key) && v.length >= 16 && !/\s/.test(v) && !/^(https?:|\/|~|\.)/.test(v);
}
function findSecrets(files) {
  const out = [];
  for (const [rel, buf] of Object.entries(files)) {
    if (!CONFIGS.has(rel) && !/opencode\/opencode\.json$/.test(rel)) continue;
    const text = buf.toString('utf8');
    let json = null;
    try { json = JSON.parse(text); } catch {}
    if (json) {
      const walk = (o, trail) => {
        if (!o || typeof o !== 'object') return;
        for (const [k, v] of Object.entries(o)) {
          if (v && typeof v === 'object') walk(v, [...trail, k]);
          else if (looksSecret(k, v) || (typeof v === 'string' && /^authorization$/i.test(k) && /\S{16,}/.test(v) && !PLACEHOLDER.test(v.replace(/^Bearer\s+/i, '')))) out.push({ file: rel, key: [...trail, k].join('.') });
        }
      };
      walk(json, []);
    } else {
      for (const m of text.matchAll(/^\s*["']?([\w.-]+)["']?\s*[:=]\s*["']?([^"'\s#]+)/gm)) if (looksSecret(m[1], m[2])) out.push({ file: rel, key: m[1] });
    }
  }
  return out.slice(0, 20);
}

// ---------- policy for new sandboxes ----------
const POLICY_DEFAULTS = { ttlHours: 0, idleMinutes: 0, askUnknown: false, limits: { pids: 0, agentMinutes: 0, apiPerDay: 0 } };
function getPolicy() {
  const p = S().policy || {};
  return { ...POLICY_DEFAULTS, ...p, limits: { ...POLICY_DEFAULTS.limits, ...(p.limits || {}) } };
}
// A whole number of 0…max, or a 400 naming the field.
function num(v, max, what) {
  const n = Math.floor(Number(v) || 0);
  if (n < 0 || n > max) throw fail(400, `${what}: от 0 до ${max}`);
  return n;
}
function setPolicy(body) {
  const l = body.limits || {};
  const next = {
    ttlHours: num(body.ttlHours, 24 * 30, 'Срок жизни, ч'),
    idleMinutes: num(body.idleMinutes, 24 * 60, 'Простой, мин'),
    askUnknown: !!body.askUnknown,
    limits: { pids: num(l.pids, 100000, 'Процессов'), agentMinutes: num(l.agentMinutes, 7 * 24 * 60, 'Минут агента'), apiPerDay: num(l.apiPerDay, 10000000, 'Запросов API') },
  };
  if (next.limits.pids && next.limits.pids < 32) throw fail(400, 'Лимит процессов меньше 32 не даст агенту запуститься');
  S().policy = next;
  save();
  return getPolicy();
}
// Give a sandbox more time (from now, or from its current end if later).
function extend(name, hours) {
  const sb = S().sandboxes[name];
  if (!sb) throw fail(404, 'песочница не найдена');
  const h = Math.min(Math.max(Number(hours) || 0, 0), 24 * 7);
  if (!h) throw fail(400, 'на сколько часов продлить?');
  let until = Math.max(sb.expiresAt || Date.now(), Date.now()) + h * 3600000;
  const max = require('./access').policy().maxTtlHours;
  if (max) {
    until = Math.min(until, sb.createdAt + max * 3600000);
    if (until <= Date.now() || (sb.expiresAt && until <= sb.expiresAt)) throw fail(403, `политика администратора: задача живёт не дольше ${max} ч`);
  }
  sb.expiresAt = until;
  sb.activeAt = Date.now();
  sb.dueHeld = false;
  save();
  return { expiresAt: sb.expiresAt };
}
// Sandboxes whose time is up: [{ name, why }]. lastActivity(name) → ms of the latest request.
function due(lastActivity) {
  const now = Date.now();
  const out = [];
  for (const sb of Object.values(S().sandboxes)) {
    if (opening.has(sb.name) || sb.persistent || sb.dueHeld) continue;
    if (sb.expiresAt && now >= sb.expiresAt) { out.push({ name: sb.name, why: 'истёк срок жизни' }); continue; }
    if (sb.idleMinutes) {
      const last = Math.max(sb.createdAt, sb.activeAt || 0, lastActivity(sb.name) || 0);
      if (now - last >= sb.idleMinutes * 60000) out.push({ name: sb.name, why: `агент не работал ${sb.idleMinutes} мин` });
    }
  }
  return out;
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

// A profile is an agent of «Агенты»: which template and program it opens with.
function workspaceDefaults(patch, p) {
  if (patch.template !== undefined) {
    if (patch.template && !S().templates[patch.template]) throw fail(400, 'шаблон не найден');
    p.template = patch.template || null;
  }
  if (patch.agent !== undefined) p.agent = patch.agent ? String(patch.agent).slice(0, 40) : null;
  // What «Дать задачу» starts with: the agent's usual task, project folder and trust level.
  if (patch.task !== undefined) p.task = String(patch.task || '').trim().slice(0, 4000) || null;
  if (patch.folder !== undefined) p.folder = String(patch.folder || '').trim().slice(0, 1024) || null;
  // The agent's directories: copies in every sandbox («review» — changes after a review, «ro» — never written back).
  if (patch.folders !== undefined) p.folders = normFolders(patch.folders);
  // The program (an agent preset — its image is prepared once) and the agent's own network and secrets.
  if (patch.preset !== undefined) {
    if (patch.preset && !require('./agents').PROFILES[patch.preset]) throw fail(400, 'нет такого пресета');
    p.preset = patch.preset || null;
  }
  if (patch.net !== undefined) p.net = ['strict', 'soft', 'off'].includes(patch.net) ? patch.net : null;
  if (patch.lists !== undefined) p.lists = Array.isArray(patch.lists) ? patch.lists.map(String).slice(0, 50) : [];
  if (patch.secrets !== undefined) p.secrets = Array.isArray(patch.secrets) ? patch.secrets.map(String).slice(0, 50) : null;
  // When a sandbox of this agent is removed by itself: idle minutes, lifetime hours (0 — never).
  if (patch.idleMinutes !== undefined) p.idleMinutes = num(patch.idleMinutes, 7 * 24 * 60, 'Простой, мин');
  if (patch.ttlHours !== undefined) p.ttlHours = num(patch.ttlHours, 30 * 24, 'Срок жизни, ч');
  if (patch.policy !== undefined) {
    if (patch.policy) require('./policies').get(patch.policy);
    p.policy = patch.policy || null;
  }
  if (patch.trust !== undefined) {
    if (patch.trust && !TRUST[patch.trust]) throw fail(400, 'уровень доверия: careful, normal или trusted');
    p.trust = patch.trust || null;
  }
}
async function createProfile({ name, from, template, agent, task, folder, folders, trust, idleMinutes, ttlHours, preset, net, lists, secrets, policy }) {
  const title = String(name || '').trim().slice(0, 60);
  if (!title) throw fail(400, 'Укажите название профиля');
  const id = newId('p', S().profiles);
  let seeded = null;
  if (from) seeded = await collectFrom(from); // a running machine whose agents are already set up
  const rec = { id, name: title, autoSave: false, createdAt: Date.now(), updatedAt: Date.now(), from: from || null, template: null, agent: null };
  workspaceDefaults({ template, agent, task, folder, folders, trust, idleMinutes, ttlHours, preset, net, lists, secrets, policy }, rec);
  S().profiles[id] = rec;
  save();
  fs.mkdirSync(profDir(id), { recursive: true, mode: 0o700 });
  if (seeded) for (const [rel, buf] of Object.entries(seeded.files)) writeProfileFile(id, rel, buf);
  return { id, skipped: seeded?.skipped || [] };
}
function updateProfile(id, patch) {
  const p = getProfile(id);
  if (typeof patch.name === 'string' && patch.name.trim()) p.name = patch.name.trim().slice(0, 60);
  if (patch.autoSave === true && require('./access').policy().memoryReview) throw fail(403, 'политика администратора: память агента всегда идёт на проверку');
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
  if (m.mounts?.length) return `к машине подключены директории хоста (${m.mounts.map((x) => x.target).join(', ')}) — smolvm не делает чекпоинт таких машин. Отключите директории машины (страница «Директории») или используйте рабочие копии`;
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
async function createTemplate({ source, title, id: existing, auto = null }, startMachine) {
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
  // One checkpoint of a machine at a time: a second one would restart it under the first.
  if ([...jobs.values()].some((j) => j.source === source && j.status === 'running')) throw fail(409, `из машины ${source} шаблон уже готовится — дождитесь его`);
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
      job.step = 'версии агентов';
      const versions = await agents.readVersions(source).catch(() => am.versions || {});
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
        versions, auto: auto || prev?.auto || null,
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

// ---------- images: one prepared template per agent preset ----------
// isolated — the machine is made with smolvm's hard isolation (the «Сеть» filter cannot be bypassed);
// it is part of the checkpoint, so a preset may have two images.
const imageJobs = new Map(); // `${preset}:${iso}` -> { status, step, error, machine, template }
const isReady = (t) => t && fs.existsSync(t.file) && jobs.get(t.id)?.status !== 'running';
function imageFor(preset, isolated) {
  const all = Object.values(S().templates).filter((t) => t.agents?.profile === preset && isReady(t));
  const iso = (t) => !!(t.egress?.enabled && t.egress?.strict);
  // Images made here first, then any template of the preset with the same isolation.
  return all.filter((t) => t.auto && iso(t) === !!isolated)[0] || all.filter((t) => iso(t) === !!isolated)[0] || null;
}
function prepareImage({ preset, isolated }, hooks) {
  const agentsLib = require('./agents');
  if (!agentsLib.PROFILES[preset]) throw fail(400, 'нет такого пресета');
  const key = `${preset}:${isolated ? 1 : 0}`;
  const have = imageFor(preset, isolated);
  if (have) return { ready: true, template: have.id };
  const cur = imageJobs.get(key);
  if (cur?.status === 'running') return { ready: false, job: cur };
  const job = { status: 'running', step: 'создание машины', error: null, machine: `img-${preset}-${crypto.randomBytes(2).toString('hex')}`, template: null, startedAt: Date.now() };
  imageJobs.set(key, job);
  (async () => {
    try {
      const body = { name: job.machine, _webProfile: preset };
      if (isolated) body._webEgress = { enabled: true, strict: true, lists: [] };
      await hooks.createMachine(body);
      job.step = 'скачивание образа и запуск';
      await hooks.startMachine(job.machine, {});
      job.step = 'установка агента';
      const deadline = Date.now() + 30 * 60000;
      while (!agentsLib.get(job.machine)?.installed) {
        const j = agentsLib.job(job.machine);
        if (j?.status === 'error') throw new Error(`установка агента: ${j.error}`);
        if (Date.now() > deadline) throw new Error('установка агента не закончилась за 30 минут');
        await new Promise((r) => setTimeout(r, 3000));
      }
      job.step = 'снимок';
      const title = `${agentsLib.PROFILES[preset].title}${isolated ? '' : ' · без изоляции'}`;
      const r = await createTemplate({ source: job.machine, title, auto: { preset, isolated: !!isolated } }, hooks.startMachine);
      job.template = r.id;
      while (jobs.get(r.id)?.status === 'running') { job.step = `снимок: ${jobs.get(r.id).step}`; await new Promise((x) => setTimeout(x, 2000)); }
      if (jobs.get(r.id)?.status === 'error') throw new Error(jobs.get(r.id).error);
      job.status = 'ok'; job.step = 'готово';
    } catch (e) { job.status = 'error'; job.error = e.message; }
  })();
  return { ready: false, job };
}

// «Обновить агента»: the latest version in the source machine, then a new checkpoint.
const upgrades = new Map(); // template id -> { status, step, error }
function upgradeTemplate(id, hooks) {
  const agentsLib = require('./agents');
  const t = S().templates[id];
  if (!t) throw fail(404, 'шаблон не найден');
  if (upgrades.get(id)?.status === 'running' || jobs.get(id)?.status === 'running') throw fail(409, 'шаблон уже обновляется');
  const job = { status: 'running', step: 'запуск исходной машины', error: null };
  upgrades.set(id, job);
  (async () => {
    try {
      const st = (await machineInfo(t.source)).state;
      if (st !== 'running') await hooks.startMachine(t.source, {});
      await up.waitReady(t.source, 120000);
      job.step = 'установка последней версии';
      agentsLib.startInstall(t.source, null, { upgrade: true });
      for (;;) {
        const j = agentsLib.job(t.source);
        if (j?.status === 'error') throw new Error(`установка: ${j.error}`);
        if (j?.status === 'ok') break;
        if (j?.step) job.step = `установка: ${j.step}`;
        await new Promise((r) => setTimeout(r, 2000));
      }
      job.step = 'новый снимок';
      await createTemplate({ source: t.source, id }, hooks.startMachine);
      while (jobs.get(id)?.status === 'running') { job.step = `снимок: ${jobs.get(id).step}`; await new Promise((x) => setTimeout(x, 2000)); }
      if (jobs.get(id)?.status === 'error') throw new Error(jobs.get(id).error);
      job.status = 'ok'; job.step = 'готово';
      require('./audit').record({ type: 'sandbox', machine: t.source, actor: 'smolvm-web', action: 'агенты шаблона обновлены', detail: { template: id, versions: S().templates[id]?.versions } });
    } catch (e) { job.status = 'error'; job.error = e.message; }
  })();
  return job;
}

// The latest versions in npm (once a day): for «доступна версия X» on templates.
async function checkUpdates() {
  const pkgs = require('./agents').packages();
  const repos = cfg.getSettings().repos || {};
  const base = String(repos.npm || 'https://registry.npmjs.org').replace(/\/+$/, '');
  const auth = repos.npm && repos.username && repos.password ? `${repos.username}:${repos.password}` : '';
  const used = new Set(Object.values(S().templates).flatMap((t) => Object.keys(t.versions || {})));
  const latest = { ...(S().latest || {}) };
  for (const cmd of used) {
    if (!pkgs[cmd]) continue;
    try {
      const j = JSON.parse((await require('./hostfetch').get(`${base}/${pkgs[cmd].replace('/', '%2f')}/latest`, { auth, timeoutMs: 20000 })).toString('utf8'));
      if (j.version) latest[cmd] = j.version;
    } catch {}
  }
  S().latest = latest; S().latestAt = Date.now();
  save();
  return latest;
}
const newer = (a, b) => {
  const p = (v) => String(v).split(/[.+-]/).slice(0, 3).map((x) => parseInt(x, 10) || 0);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};
// [{ cmd, have, latest }] for a template.
function updatesOf(t) {
  const l = S().latest || {};
  return Object.entries(t.versions || {}).filter(([c, v]) => l[c] && newer(l[c], v)).map(([cmd, have]) => ({ cmd, have, latest: l[cmd] }));
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

// Trust levels of the simple mode: one choice instead of the filter and TTL settings.
// The project is always a review copy: a machine restored from a checkpoint does not
// boot with a volume added after the checkpoint, so a direct link is not an option here.
const TRUST = {
  careful: { title: 'Осторожно', filter: true, lists: [], ask: false, ttlHours: 2 },
  normal: { title: 'Обычно', filter: true, lists: null, ask: true, ttlHours: 0 },
  trusted: { title: 'Доверяю', filter: false, lists: null, ask: false, ttlHours: 0 },
};

function normFolders(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 10).map((f) => ({ hostPath: String(f?.hostPath || '').trim().slice(0, 1024), mode: f?.mode === 'ro' ? 'ro' : 'review' })).filter((f) => f.hostPath);
}

// The template an agent opens from: its program's image, or a template of your own machine.
// P — the task's policy (its network decides: an image with hard isolation or without).
function baseTemplateOf(prof, P = null) {
  if (prof.preset) {
    const img = imageFor(prof.preset, P ? P.net.mode === 'strict' : (prof.net || 'strict') === 'strict');
    if (!img) throw fail(409, `образ ${require('./agents').PROFILES[prof.preset]?.title || prof.preset} ещё не готов — он готовится один раз, подождите несколько минут`);
    return img.id;
  }
  if (prof.template && S().templates[prof.template]) return prof.template;
  throw fail(400, `у агента «${prof.name}» не выбрана программа`);
}

// A machine from a template's checkpoint: fresh agent ports and passwords, its own filter
// and gateway tokens, the template's filter rules, the agent's secrets (else the template's).
async function machineFromTemplate(t, name, prof) {
  const egress = require('./egress');
  const vault = require('./vault');
  const ports = await require('./agents').adopt(name, t.agents);
  const r = await up.request('POST', '/api/v1/machines', { name, from: t.file, ports });
  if (r.status !== 200) throw new Error(`создание из чекпоинта: ${r.data?.error || `HTTP ${r.status}`}`);
  cfg.setMachineProxy(name, t.useProxy);
  egress.forgetMachine(name);
  if (t.egress) {
    // Its strict policy is in the checkpoint already.
    egress.setMachine(name, { enabled: t.egress.enabled, strict: t.egress.strict, lists: t.egress.lists, rules: t.egress.rules });
    egress.setMachine(name, { strictApplied: t.egress.strictApplied });
  }
  const have = new Set((await vault.list().catch(() => [])).map((x) => x.name));
  const secrets = (Array.isArray(prof?.secrets) ? prof.secrets : t.secrets).filter((n) => have.has(n));
  if (secrets.length) await vault.bind(name, secrets);
}

// persistent — a session that is not closed by itself; taskId and gitFrom ({hostPath: git id})
// — a reset of that task: the same task in a new machine, its branches carried over.
// policy — a policy id for this task (else the agent's); a policy decides the network,
// folders, the account in the machine, processes and time instead of the trust level.
async function open({ template, profile, agent, trust, task, folder, folders, idleMinutes, ttlHours, persistent = false, taskId = null, gitFrom = {}, policy = null }, { startMachine, deleteMachine }) {
  const agents = require('./agents');
  const tr = trust ? TRUST[trust] : null;
  if (trust && !tr) throw fail(400, 'уровень доверия: careful, normal или trusted');
  task = String(task || '').trim().slice(0, 4000) || null;
  // Project folders: the given ones, else the agent's; a single «folder» is the old form.
  const prof = profile ? S().profiles[profile] : null;
  let want = normFolders(folders);
  if (!want.length && folder) want = [{ hostPath: String(folder), mode: 'review' }];
  if (!want.length && folders === undefined && prof) want = prof.folders?.length ? prof.folders : prof.folder ? [{ hostPath: prof.folder, mode: 'review' }] : [];
  const copies = [];
  for (const f of want) {
    const c = require('./dirs').checkFolder(f.hostPath);
    if (!c.ok) throw fail(400, `${c.real || f.hostPath}: ${c.error}`);
    if (!copies.some((x) => x.hostPath === c.real)) copies.push({ hostPath: c.real, mode: f.mode });
  }
  const realFolder = copies[0]?.hostPath || null;
  const life = (v, def) => (v !== undefined && v !== null && v !== '' ? Number(v) || 0 : def);
  const egress = require('./egress');
  const policies = require('./policies');
  const polId = policy || prof?.policy || null;
  const P = polId ? policies.effective(polId) : null;
  if (P) policies.checkFolders(P, copies);
  if (!template && prof) template = baseTemplateOf(prof, P);
  if (!agent && prof?.agent) agent = prof.agent;
  const access = require('./access');
  access.checkOpen({ trust: P ? policies.trustOf(P) : (trust || prof?.trust || null), persistent });
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
    await machineFromTemplate(t, name, prof);
    created = true;
    const pol = getPolicy();
    // Lifetime: the request, else the agent's, else the trust level, else the policy.
    // 0 in the agent means «not set»: the trust level or the policy decides.
    const ttl = persistent ? 0 : access.capTtl(life(ttlHours, (P ? P.time.ttlHours : prof?.ttlHours || tr?.ttlHours) || pol.ttlHours || 0));
    const idle = persistent ? 0 : life(idleMinutes, (P ? P.time.idleMinutes : prof?.idleMinutes) || pol.idleMinutes || 0);
    S().sandboxes[name] = { name, template: t.id, profile: profile || null, agent: agent || null, createdAt: Date.now(),
      expiresAt: ttl ? Date.now() + ttl * 3600000 : null, idleMinutes: idle,
      trust: P ? policies.trustOf(P) : trust || null, task, folder: realFolder, folders: copies, persistent: !!persistent, taskId, policy: P };
    if (P) egress.setMachine(name, policies.egressPatch(P));
    else if (prof?.net) {
      // The agent's network: its mode and white lists; trust decides unknown addresses —
      // «Обычно» asks, «Осторожно» refuses, «Доверяю» lets them through the filter.
      const on = prof.net !== 'off';
      egress.setMachine(name, on
        ? { enabled: true, lists: prof.lists || [], rules: trust === 'trusted' ? [{ host: '*', ports: '*', note: 'уровень «Доверяю»' }] : [], ask: trust === 'normal' }
        : { enabled: false, ask: false });
    } else if (tr) {
      egress.setMachine(name, tr.filter ? { enabled: true, ask: tr.ask, ...(tr.lists ? { lists: tr.lists } : {}) } : { enabled: false, ask: false });
    } else if (pol.askUnknown && t.egress?.enabled) egress.setMachine(name, { ask: true });
    const guestOf = (p) => `/work/${path.basename(p).replace(/[^A-Za-z0-9_.-]/g, '_') || 'project'}`;
    const guestFolder = realFolder ? guestOf(realFolder) : null;
    const lim = P ? policies.limitsOf(P) : pol.limits;
    if (lim.pids || lim.agentMinutes || lim.apiPerDay) require('./limits').set(name, lim);
    // A project's template stays the project's: the agent keeps its own program.
    if (profile) Object.assign(S().profiles[profile], { ...(prof?.preset || t.auto?.project ? {} : { template: t.id }), agent: agent || S().profiles[profile].agent || null, openedAt: Date.now() });
    save();
    // What the machine really got — network and secrets — against the administrator's policy.
    access.checkMachine({ egress: egress.getMachine(name), secrets: await require('./vault').machineSecrets(name).catch(() => []) });
    opening.set(name, 'запуск');
    await startMachine(name, {});
    if (P) {
      // The account and the programs in the machine, as root, before the agent starts.
      opening.set(name, `политика «${P.name}»`);
      await up.waitReady(name, 90000);
      const r = await up.exec(name, { command: ['sh', '-c', policies.guestScript(P)], user: '0', timeoutSecs: 300 }, 320000).catch((e) => ({ stdout: '', stderr: e.message, exitCode: 1 }));
      const out = `${r.stdout || ''}\n${r.stderr || ''}`;
      S().sandboxes[name].policyApplied = {
        sudo: /sudo: on/.test(out), deny: P.processes.deny, journal: !!P.processes.journal, denied: [...new Set([...out.matchAll(/^denied: (\S+)/gm)].map((m) => m[1]))],
        notes: [...out.matchAll(/^note: (.+)$/gm)].map((m) => m[1]).slice(0, 20),
      };
      // The policy wants hard isolation, the template (your own machine's) has none: say so.
      if (P.net.mode === 'strict' && !(t.egress?.enabled && t.egress?.strict)) {
        S().sandboxes[name].policyApplied.notes.unshift(`шаблон «${t.title}» без жёсткой изоляции — белые списки работают через прокси, агент может выйти в обход`);
      }
      save();
    }
    if (profile) {
      opening.set(name, 'профиль агента');
      const files = readProfile(profile);
      await guest(name, 'apply', JSON.stringify({ files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.toString('base64')])) }));
    }
    // A git repository given for writing comes back as a branch; anything else is a review copy.
    const gitwork = require('./gitwork');
    for (const f of copies) {
      opening.set(name, `копия ${path.basename(f.hostPath)}`);
      if (f.mode !== 'ro' && gitFrom[f.hostPath]) { f.git = (await gitwork.reattach(gitFrom[f.hostPath], name, guestOf(f.hostPath))).id; continue; }
      if (f.mode !== 'ro' && await gitwork.repoOf(f.hostPath)) { f.git = (await gitwork.add(name, { hostPath: f.hostPath, guestPath: guestOf(f.hostPath) })).id; continue; }
      await require('./review').add(name, { hostPath: f.hostPath, guestPath: guestOf(f.hostPath), readonly: f.mode === 'ro' });
    }
    if (copies.some((f) => f.git)) save();
    const folderNote = (f) => guestOf(f.hostPath) + (f.mode === 'ro' ? ' (только чтение)' : f.git ? ' (git-репозиторий: коммить по ходу работы, результат забирается веткой)' : '');
    if (task) {
      opening.set(name, 'задача для агента');
      const text = `# Задача\n\n${task}\n${copies.length ? `\nДиректории:\n${copies.map((f) => `- ${folderNote(f)}`).join('\n')}\n` : ''}`;
      await up.exec(name, { command: ['sh', '-c', 'rm -f /home/*/.smolvm-web/run/task-started; mkdir -p /work && cat > /work/TASK.md && (id node >/dev/null 2>&1 && chown node:node /work/TASK.md || true)'], stdin: text, timeoutSecs: 30 }, 40000).catch(() => null);
    }
    let url = null;
    if (agent) {
      opening.set(name, 'запуск агента');
      url = (await agents.start(name, agent, task ? { task: `${task}${copies.length ? `\n\nДиректории: ${copies.map(folderNote).join(', ')}.` : ''}`, cwd: guestFolder } : {})).url;
    }
    if (task) {
      // The last tasks, for «Прошлые задачи» of the agent dialog.
      const hist = (S().taskHistory || []).filter((x) => x.task !== task);
      hist.unshift({ task, folder: realFolder, at: Date.now() });
      S().taskHistory = hist.slice(0, 30);
      save();
    }
    const tasks = require('./tasks');
    if (taskId) { tasks.attach(taskId, name); tasks.setFolders(taskId, copies.map((f) => ({ hostPath: f.hostPath, mode: f.mode, git: f.git || null }))); }
    else taskId = tasks.record({ machine: name, text: task, agent, profile, template: t.id, trust, persistent, folders: copies, policy: P ? { id: P.id, name: P.name } : null });
    S().sandboxes[name].taskId = taskId;
    save();
    require('./audit').record({ type: 'sandbox', machine: name, actor: 'smolvm-web', action: 'песочница открыта', detail: { template: t.id, profile: profile || null, agent: agent || null, trust: trust || null, folder: realFolder, task: task ? task.slice(0, 200) : null, taskId, persistent: !!persistent,
      policy: P ? { id: P.id, name: P.name, sudo: P.account.sudo, deny: P.processes.deny, net: P.net } : null, applied: S().sandboxes[name].policyApplied || null } });
    return { name, url, taskId };
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
      if (S().profiles[sb.profile].autoSave && !require('./access').policy().memoryReview) result.applied = applyPending(id, []).applied.length;
      else result.pending = id;
    }
  }
  // The agent's commits become branches on the host before the machine goes.
  if (keep) {
    result.git = await require('./gitwork').finishMachine(name);
    const failed = result.git.filter((x) => x.error);
    if (failed.length) throw fail(409, `не удалось забрать ветку из машины (${failed.map((x) => `${path.basename(x.hostPath)}: ${x.error}`).join('; ')}) — исправьте или закройте без сохранения`);
  }
  require('./tasks').closed(sb.taskId, { saved: keep });
  await deleteMachine(name);
  require('./audit').record({ type: 'sandbox', machine: name, actor: 'smolvm-web', action: keep ? 'песочница закрыта' : 'песочница закрыта без сохранения', detail: { profile: sb.profile, changes: result.changes, pending: result.pending, branches: (result.git || []).filter((x) => x.tip).map((x) => x.branch) } });
  return result;
}

// What «Закрыть» would take into the profile right now — nothing is saved.
async function previewChanges(name) {
  const sb = S().sandboxes[name];
  if (!sb) throw fail(404, 'песочница не найдена');
  if (!sb.profile || !S().profiles[sb.profile]) return { profile: null, changes: [], skipped: [] };
  const m = await machineInfo(name).catch(() => null);
  if (m?.state !== 'running') throw fail(409, 'машина песочницы не запущена');
  const back = await collectFrom(name);
  return { profile: sb.profile, changes: changesOf(sb.profile, back.files).map(({ path: p, kind }) => ({ path: p, kind })), skipped: back.skipped };
}

// The machine is gone (deleted from anywhere): drop the record.
function forget(name) {
  const sb = S().sandboxes[name];
  if (!sb) return;
  require('./tasks').machineGone(sb.taskId, name);
  delete S().sandboxes[name];
  save();
}
// Not closed by itself any more (its work could not be taken): a person decides.
function holdDue(name) {
  const sb = S().sandboxes[name];
  if (sb) { sb.dueHeld = true; save(); }
}

async function overview() {
  const r = await up.request('GET', '/api/v1/machines').catch(() => null);
  const machines = new Map((r?.data?.machines || []).map((m) => [m.name, m]));
  const agents = require('./agents');
  return {
    templates: Object.values(S().templates).map((t) => ({ ...t, file: undefined, missing: !fs.existsSync(t.file), job: jobs.get(t.id) || null, upgrade: upgrades.get(t.id) || null, updates: updatesOf(t) }))
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
    taskHistory: S().taskHistory || [],
    // Per preset: is its image (isolated / plain) ready, or being prepared.
    images: Object.fromEntries(Object.keys(require('./agents').PROFILES).map((id) => [id, Object.fromEntries([true, false].map((iso) => {
      const img = imageFor(id, iso);
      const j = imageJobs.get(`${id}:${iso ? 1 : 0}`);
      return [iso ? 'isolated' : 'plain', img ? { template: img.id } : j ? { job: j } : null];
    }))])),
    // Ordinary machines with installed agents: a template can be made from each of them.
    sources: agents.names().filter((n) => !S().sandboxes[n] && machines.has(n)).map((n) => {
      const am = agents.get(n);
      const m = machines.get(n);
      return { name: n, state: m.state, installed: !!am.installed, blocker: blocker(m), profile: am.profile,
        agents: am.agents.filter((id) => id !== 'terminal'),
        job: [...jobs.values()].find((j) => j.source === n && j.status === 'running') || null };
    }),
    agentTitles: Object.fromEntries(Object.entries(agents.AGENTS).map(([id, a]) => [id, { title: a.title, mark: a.mark }])),
    paths: PROFILE_PATHS,
  };
}

module.exports = {
  PROFILE_PATHS, overview, createTemplate, deleteTemplate, prepareImage, upgradeTemplate, checkUpdates, updatesList: () => Object.values(S().templates).map((t) => ({ id: t.id, title: t.title, updates: updatesOf(t) })).filter((x) => x.updates.length), open, close, forget, previewChanges, getPolicy, setPolicy, extend, due,
  createProfile, updateProfile, deleteProfile, profileFiles, profileFile, deleteProfileFile, putProfileFile,
  pendingSummary: (id) => pendingSummary(getPending(id)), pendingDiff, applyPending, dropPending,
  pendingList: () => listPending().map(pendingSummary),
  isSandbox: (name) => !!S().sandboxes[name],
  baseTemplateOf, machineFromTemplate,
  profile: (id) => S().profiles[id] || null,
  template: (id) => S().templates[id] || null,
  templateJob: (id) => jobs.get(id) || null,
  record: (name) => S().sandboxes[name] || null,
  // Open sandboxes working under a policy (procwatch.js watches their processes).
  policyMachines: () => Object.values(S().sandboxes).filter((x) => x.policy).map((x) => ({ name: x.name, policy: x.policy, taskId: x.taskId })),
  profilesList: () => Object.values(S().profiles),
  holdDue,
  // A machine smolvm-web keeps as the source of a program image (or is preparing as one).
  isImageSource: (name) => Object.values(S().templates).some((t) => t.auto && t.source === name) || [...imageJobs.values()].some((j) => j.machine === name && j.status === 'running'),
  opening: () => [...opening].map(([name, step]) => ({ name, step })),
  templateJobs: () => [...jobs].filter(([, j]) => j.status === 'running').map(([, j]) => ({ name: j.source, step: j.step })),
};
