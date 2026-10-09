'use strict';
// Egress filter: an HTTP(S) forward proxy on the host that machines use as
// HTTP(S)_PROXY. Every machine authenticates with its own token (Basic proxy
// auth, user = machine name), and each CONNECT / plain-HTTP request is checked
// against the allow lists bound to that machine before it goes out — directly
// or through the corporate proxy. Decisions are logged, so a denied host can be
// allowed from the UI in one click. Rules change live: no machine restart.
//
// Like the secret gateway it serves only connections from this host's own
// addresses (machines started by the CLI reach the host through it). Targets on
// loopback, link-local, private ranges or the host itself need an explicit
// IP/CIDR rule: an allowed hostname must not become a path to host services.
//
// The filter only sees programs that honour HTTP(S)_PROXY. "Strict" machines
// additionally get a smolvm egress policy that allows nothing but the host's
// address, so the proxy is the only way out.

const http = require('http');
const net = require('net');
const dns = require('dns');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const cfg = require('./config');
const px = require('./proxy');

const PORT = Number(process.env.SMOLVM_WEB_EGRESS_PORT || 7791);
const PULL_SUFFIX = '~pull';
const LOG_MAX = 3000;
const LOG_FILE_MAX = 5 * 1024 * 1024;
const IDLE_MS = 15 * 60 * 1000;
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const LIST_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const HOST_RE = /^(?=.{1,253}$)[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)*$/;

// Registries the in-guest image pull needs (CLI start with --proxy). The pull
// credential gets these on top of the machine's own rules.
const DEFAULT_PULL_HOSTS = [
  'registry-1.docker.io', 'auth.docker.io', 'production.cloudflare.docker.com', 'index.docker.io',
  'ghcr.io', 'pkg-containers.githubusercontent.com', 'quay.io', '*.quay.io', 'gcr.io', '*.gcr.io',
  'registry.k8s.io', '*.pkg.dev', 'mcr.microsoft.com', '*.data.mcr.microsoft.com', 'public.ecr.aws',
];

const T = (host, ports = '443', note = '') => ({ host, ports, note });
const TEMPLATES = {
  pypi: { name: 'Python (PyPI)', rules: [T('pypi.org'), T('files.pythonhosted.org')] },
  npm: { name: 'Node.js (npm, yarn)', rules: [T('registry.npmjs.org'), T('registry.yarnpkg.com')] },
  github: { name: 'GitHub', rules: [T('.github.com'), T('.githubusercontent.com'), T('ghcr.io')] },
  gitlab: { name: 'GitLab.com', rules: [T('.gitlab.com'), T('registry.gitlab.com')] },
  docker: { name: 'Docker Hub', rules: [T('registry-1.docker.io'), T('auth.docker.io'), T('production.cloudflare.docker.com')] },
  alpine: { name: 'Alpine (apk)', rules: [T('dl-cdn.alpinelinux.org', '443,80')] },
  debian: { name: 'Debian (apt)', rules: [T('deb.debian.org', '443,80'), T('security.debian.org', '443,80')] },
  ubuntu: { name: 'Ubuntu (apt)', rules: [T('archive.ubuntu.com', '443,80'), T('security.ubuntu.com', '443,80'), T('ports.ubuntu.com', '443,80')] },
  golang: { name: 'Go modules', rules: [T('proxy.golang.org'), T('sum.golang.org')] },
  rust: { name: 'Rust (crates.io)', rules: [T('crates.io'), T('index.crates.io'), T('static.crates.io')] },
  huggingface: { name: 'Hugging Face', rules: [T('.huggingface.co'), T('.hf.co')] },
  openai: { name: 'OpenAI API', rules: [T('api.openai.com')] },
  anthropic: { name: 'Anthropic API', rules: [T('api.anthropic.com')] },
  deepseek: { name: 'DeepSeek API', rules: [T('api.deepseek.com')] },
  openrouter: { name: 'OpenRouter', rules: [T('openrouter.ai')] },
  gemini: { name: 'Google Gemini', rules: [T('generativelanguage.googleapis.com')] },
};

const store = cfg.doc('egress.json', {
  defaults: { enabled: false, strict: false },
  pullHosts: DEFAULT_PULL_HOSTS,
  lists: [{ id: 'common', name: 'Общий', default: true, rules: [] }],
  machines: {},
});

// ---------- rules ----------
function parsePorts(s) {
  const t = String(s ?? '').trim();
  if (!t || t === '*') return null; // any port
  const out = [];
  for (const part of t.split(/[,;\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d{1,5})(?:-(\d{1,5}))?$/);
    if (!m) throw new Error(`порт «${part}»: ожидается число, диапазон 8000-8100 или *`);
    const a = Number(m[1]); const b = Number(m[2] || m[1]);
    if (!a || a > 65535 || b > 65535 || b < a) throw new Error(`порт «${part}» вне диапазона 1–65535`);
    out.push([a, b]);
  }
  return out;
}

function cidrParts(s) {
  const [ip, bits] = s.split('/');
  const family = net.isIP(ip);
  if (!family) return null;
  const max = family === 4 ? 32 : 128;
  const prefix = bits === undefined ? max : Number(bits);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max || (bits !== undefined && !/^\d+$/.test(bits))) return null;
  return { ip, prefix, type: family === 4 ? 'ipv4' : 'ipv6' };
}

// Host pattern grammar:
//   example.com     exactly this host
//   .example.com    the host and all its subdomains
//   *.example.com   subdomains only
//   10.0.0.0/8, 203.0.113.7, ::1   IP literal targets in the range
//   *               any host (special addresses still need an IP/CIDR rule)
function parseHost(raw) {
  let h = String(raw || '').trim().toLowerCase().replace(/\.$/, '');
  if (!h) throw new Error('пустой хост');
  if (h === '*') return { kind: 'any', value: '*' };
  const c = cidrParts(h.replace(/^\[|\]$/g, ''));
  if (c) {
    const list = new net.BlockList();
    list.addSubnet(c.ip, c.prefix, c.type);
    return { kind: 'cidr', value: `${c.ip}/${c.prefix}`, list };
  }
  let kind = 'exact';
  if (h.startsWith('*.')) { kind = 'sub'; h = h.slice(2); }
  else if (h.startsWith('.')) { kind = 'suffix'; h = h.slice(1); }
  if (!HOST_RE.test(h)) throw new Error(`«${raw}»: некорректное имя хоста`);
  return { kind, value: h };
}

function canonicalHost(p) {
  return p.kind === 'sub' ? `*.${p.value}` : p.kind === 'suffix' ? `.${p.value}` : p.value;
}

// Accepts a host pattern or a pasted URL (https://api.x.com:8443/v1 -> api.x.com, 8443).
function normalizeRule(r) {
  let host = String(r.host || '').trim();
  let ports = String(r.ports ?? '').trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) {
    let u;
    try { u = new URL(host); } catch { throw new Error(`«${host}»: некорректный URL`); }
    host = u.hostname.replace(/^\[|\]$/g, '');
    if (!ports) ports = u.port || (u.protocol === 'http:' ? '80' : '443');
  } else {
    const hp = host.match(/^([^/:\s]+):(\d{1,5})$/);
    if (hp) { host = hp[1]; if (!ports) ports = hp[2]; }
  }
  const p = parseHost(host);
  const pp = parsePorts(ports || '443'); // explicit * for any port
  return {
    id: typeof r.id === 'string' && /^[a-z0-9]{1,16}$/.test(r.id) ? r.id : crypto.randomBytes(5).toString('hex'),
    host: canonicalHost(p),
    ports: pp ? pp.map(([a, b]) => (a === b ? String(a) : `${a}-${b}`)).join(',') : '*',
    note: String(r.note || '').slice(0, 200),
    enabled: r.enabled !== false,
  };
}

function normalizeRules(list) {
  if (!Array.isArray(list)) return [];
  const errors = [];
  const out = list.map((r, i) => {
    try { return normalizeRule(r || {}); } catch (e) { errors.push(`правило ${i + 1}: ${e.message}`); return null; }
  });
  if (errors.length) throw new Error(errors.join('\n'));
  return out;
}

const parsedCache = new Map();
function compiled(rule) {
  const key = `${rule.host} ${rule.ports}`;
  let c = parsedCache.get(key);
  if (!c) {
    c = { host: parseHost(rule.host), ports: parsePorts(rule.ports) };
    if (parsedCache.size > 5000) parsedCache.clear();
    parsedCache.set(key, c);
  }
  return c;
}

function portOk(ports, port) { return !ports || ports.some(([a, b]) => port >= a && port <= b); }

function ipType(ip) { return net.isIP(ip) === 6 ? 'ipv6' : 'ipv4'; }

function hostMatches(h, host) {
  switch (h.kind) {
    case 'any': return true;
    case 'exact': return host === h.value;
    case 'sub': return host.endsWith(`.${h.value}`);
    case 'suffix': return host === h.value || host.endsWith(`.${h.value}`);
    case 'cidr': return net.isIP(host) > 0 && h.list.check(host, ipType(host));
    default: return false;
  }
}

// ---------- special addresses ----------
const SPECIAL = new net.BlockList();
for (const [ip, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]]) SPECIAL.addSubnet(ip, p, 'ipv4');
for (const [ip, p] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96]]) SPECIAL.addSubnet(ip, p, 'ipv6');

function ownAddresses() {
  const set = new Set();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) set.add(a.address.replace(/^::ffff:/, '').replace(/%.*$/, ''));
  }
  return set;
}

function unmap(ip) {
  const m = String(ip).match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return m ? m[1] : String(ip).replace(/^\[|\]$/g, '');
}

function isSpecial(ip) {
  ip = unmap(ip);
  if (!net.isIP(ip)) return false;
  return SPECIAL.check(ip, ipType(ip)) || ownAddresses().has(ip);
}

// ---------- policy ----------
const S = () => store.get();

function listById(id) { return S().lists.find((l) => l.id === id); }

// Rules contributed by other modules (agent vendor servers), computed per call.
let extraRules = () => [];
function setExtraRules(fn) { extraRules = fn; }
function extraFor(name) { try { return extraRules(name) || []; } catch { return []; } }

function machineRules(name, { pull = false } = {}) {
  const m = S().machines[name];
  if (!m) return [];
  const rules = [];
  for (const id of m.lists || []) {
    const l = listById(id);
    if (l) for (const r of l.rules) if (r.enabled) rules.push({ ...r, source: l.name });
  }
  for (const r of m.rules || []) if (r.enabled) rules.push({ ...r, source: 'правила машины' });
  for (const r of extraFor(name)) rules.push({ ...r, enabled: true });
  if (pull) for (const host of S().pullHosts) rules.push({ host, ports: '443,80', source: 'реестры образов' });
  return rules;
}

function normHost(h) { return unmap(String(h || '').trim().toLowerCase().replace(/\.$/, '')); }

// Does the machine's policy let it reach host:port? For IP-literal and resolved
// special addresses only an explicit IP/CIDR rule counts.
function decide(name, host, port, opts = {}) {
  host = normHost(host);
  const special = net.isIP(host) > 0 && isSpecial(host);
  for (const r of machineRules(name, opts)) {
    let c;
    try { c = compiled(r); } catch { continue; }
    if (!portOk(c.ports, port)) continue;
    if (special && c.host.kind !== 'cidr') continue;
    if (hostMatches(c.host, host)) return { allow: true, rule: r.host, source: r.source };
  }
  // Learning mode: let unknown public hosts through and remember them. Host and
  // internal addresses still need an explicit IP/CIDR rule (directAddress vets
  // resolved addresses too), and image-pull tokens are not part of learning.
  const m = S().machines[name];
  if (m?.learn && !special && !opts.pull && !opts.noLearn) {
    if (opts.record) noteLearned(name, host, port); // only real connections are remembered
    return { allow: true, learned: true, rule: 'режим обучения', source: 'обучение' };
  }
  return { allow: false, reason: special ? 'адрес хоста/внутренней сети: нужно явное правило IP/CIDR' : 'нет в allow list' };
}

// ---------- learning mode ----------
let learnSaveTimer = null;
function noteLearned(name, host, port) {
  const m = S().machines[name];
  if (!m) return;
  m.learned = m.learned || {};
  const k = `${host}:${port}`;
  const cur = m.learned[k] || { host, port, count: 0, first: Date.now() };
  cur.count++; cur.last = Date.now();
  m.learned[k] = cur;
  if (!learnSaveTimer) learnSaveTimer = setTimeout(() => { learnSaveTimer = null; store.save(S()); }, 2000);
}

// Collected hosts, grouped by host with their ports; a suggested rule per host.
function learned(name) {
  const m = S().machines[name];
  const byHost = new Map();
  for (const e of Object.values(m?.learned || {})) {
    const cur = byHost.get(e.host) || { host: e.host, ports: new Set(), count: 0, last: 0 };
    cur.ports.add(e.port); cur.count += e.count; cur.last = Math.max(cur.last, e.last);
    byHost.set(e.host, cur);
  }
  return [...byHost.values()]
    .map((x) => ({ host: x.host, ports: [...x.ports].sort((a, b) => a - b).join(','), count: x.count, last: x.last }))
    // Already covered by a rule added meanwhile? Then it is not a suggestion any more.
    .map((x) => ({ ...x, covered: x.ports.split(',').every((p) => decide(name, x.host, Number(p), { noLearn: true }).allow) }))
    .sort((a, b) => b.count - a.count);
}

// Turn the chosen hosts into a list bound to the machine and leave learning.
function finishLearning(name, { hosts = [], listName } = {}) {
  const m = S().machines[name];
  if (!m) throw new Error('у машины нет настроек фильтра');
  const rules = hosts.filter((x) => x && x.host).map((x) => ({ host: String(x.host), ports: String(x.ports || '443'), note: 'из режима обучения', enabled: true }));
  let list = null;
  if (rules.length) {
    list = saveList('new', { name: listName || `Обучение: ${name}`, default: false, rules });
    m.lists = [...new Set([...(m.lists || []), list.id])];
  }
  m.learn = false;
  m.learned = {};
  m.learnSince = null;
  store.save(S());
  return { list, rules: rules.length };
}

// Of the addresses a hostname resolved to, keep those the policy allows.
function allowedAddresses(name, port, addrs, opts) {
  return addrs.filter((a) => !isSpecial(a) || machineRules(name, opts).some((r) => {
    try {
      const c = compiled(r);
      return c.host.kind === 'cidr' && portOk(c.ports, port) && hostMatches(c.host, unmap(a));
    } catch { return false; }
  }));
}

function newToken() { return crypto.randomBytes(24).toString('hex'); }

function defaultLists() { return S().lists.filter((l) => l.default).map((l) => l.id); }

function getMachine(name) { return S().machines[name] || null; }

function setMachine(name, patch = {}) {
  const s = S();
  const cur = s.machines[name] || { enabled: false, strict: false, lists: defaultLists(), rules: [], token: newToken(), pullToken: newToken(), strictApplied: null };
  const next = { ...cur };
  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
  if (typeof patch.strict === 'boolean') next.strict = patch.strict;
  if (typeof patch.learn === 'boolean') {
    if (patch.learn && !cur.learn) { next.learnSince = Date.now(); next.learned = cur.learned || {}; }
    if (!patch.learn) next.learnSince = null;
    next.learn = patch.learn;
    if (patch.learn) next.enabled = true; // learning works through the filter
  }
  if (Array.isArray(patch.lists)) next.lists = patch.lists.map(String).filter((id) => listById(id));
  if (Array.isArray(patch.rules)) next.rules = normalizeRules(patch.rules);
  if ('strictApplied' in patch) next.strictApplied = patch.strictApplied || null;
  if ('envApplied' in patch) next.envApplied = patch.envApplied || null;
  if (patch.rotate) { next.token = newToken(); next.pullToken = newToken(); }
  s.machines[name] = next;
  store.save(s);
  return next;
}

function forgetMachine(name) {
  const s = S();
  if (!s.machines[name]) return;
  delete s.machines[name];
  store.save(s);
}

function copyMachine(from, to) {
  const m = getMachine(from);
  if (!m) return;
  // Same rules; a branch keeps the source's proxy env in memory, so it keeps its tokens too.
  S().machines[to] = { ...structuredClone(m) };
  store.save(S());
}

function saveList(id, body) {
  const s = S();
  const name = String(body.name || '').trim().slice(0, 64);
  if (!name) throw new Error('Укажите название списка');
  const rules = normalizeRules(body.rules || []);
  let l = id === 'new' ? null : listById(id);
  if (!l) {
    let nid = id === 'new' ? name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) : id;
    if (!LIST_ID_RE.test(nid || '')) nid = `list-${crypto.randomBytes(3).toString('hex')}`;
    while (listById(nid)) nid = `${nid.slice(0, 24)}-${crypto.randomBytes(2).toString('hex')}`;
    l = { id: nid };
    s.lists.push(l);
  }
  l.name = name;
  l.default = !!body.default;
  l.rules = rules;
  store.save(s);
  return l;
}

function deleteList(id) {
  const s = S();
  s.lists = s.lists.filter((l) => l.id !== id);
  for (const m of Object.values(s.machines)) m.lists = (m.lists || []).filter((x) => x !== id);
  store.save(s);
}

function saveSettings(body) {
  const s = S();
  if (body.defaults) {
    s.defaults = { enabled: !!body.defaults.enabled, strict: !!body.defaults.strict };
  }
  if (Array.isArray(body.pullHosts)) {
    s.pullHosts = body.pullHosts.map((h) => canonicalHost(parseHost(h)));
  }
  store.save(s);
  return s;
}

// Explain a decision for the "check" tool in the UI.
function explain(name, target) {
  let host = String(target || '').trim(); let port = 443;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) {
    const u = new URL(host);
    host = u.hostname; port = Number(u.port) || (u.protocol === 'http:' ? 80 : 443);
  } else {
    const m = host.match(/^\[?([^\]]+?)\]?(?::(\d{1,5}))?$/);
    if (m && !(net.isIP(host) === 6)) { host = m[1]; if (m[2]) port = Number(m[2]); }
  }
  return { host: normHost(host), port, ...decide(name, host, port) };
}

// ---------- log ----------
const ring = [];
let seq = 0;

const listeners = [];
function onLog(fn) { listeners.push(fn); }

function logStart(e) {
  const entry = { id: ++seq, ts: Date.now(), bytesIn: 0, bytesOut: 0, open: true, ...e };
  for (const fn of listeners) { try { fn(entry); } catch {} }
  ring.push(entry);
  if (ring.length > LOG_MAX) ring.splice(0, ring.length - LOG_MAX);
  if (!entry.allow) logEnd(entry);
  return entry;
}

function logEnd(entry, extra = {}) {
  if (!entry.open) return;
  Object.assign(entry, extra, { open: false, ms: Date.now() - entry.ts });
  try {
    const file = `${cfg.DIR}/egress.log`;
    try { if (fs.statSync(file).size > LOG_FILE_MAX) fs.renameSync(file, `${file}.1`); } catch {}
    const { open, ...rec } = entry;
    fs.appendFileSync(file, `${JSON.stringify({ ...rec, ts: new Date(rec.ts).toISOString() })}\n`, { mode: 0o600 });
  } catch {}
}

function log({ machine, decision, limit = 300, q } = {}) {
  const needle = q ? String(q).toLowerCase() : '';
  const out = [];
  for (let i = ring.length - 1; i >= 0 && out.length < limit; i--) {
    const e = ring[i];
    if (machine && e.machine !== machine) continue;
    if (decision === 'allow' && !e.allow) continue;
    if (decision === 'deny' && e.allow) continue;
    if (needle && !`${e.host}:${e.port} ${e.machine}`.toLowerCase().includes(needle)) continue;
    out.push(e);
  }
  return out;
}

// Denied destinations grouped, for "allow" suggestions.
function deniedSummary(machine) {
  const map = new Map();
  for (const e of ring) {
    if (e.allow || (machine && e.machine !== machine) || !e.machine) continue;
    const k = `${e.machine}\n${e.host}\n${e.port}`;
    const cur = map.get(k) || { machine: e.machine, host: e.host, port: e.port, count: 0, last: 0, reason: e.reason };
    cur.count++; cur.last = e.ts; cur.reason = e.reason;
    map.set(k, cur);
  }
  // Already allowed since (rule added after the denial)? Drop it.
  return [...map.values()].filter((d) => !decide(d.machine, d.host, d.port).allow).sort((a, b) => b.last - a.last).slice(0, 100);
}

// ---------- upstream ----------
function corporateProxyFor(host) {
  const p = cfg.getSettings().proxy;
  if (!p.enabled || !p.url) return null;
  return px.bypassesProxy(host, p.noProxy) ? null : px.normalizeUrl(p.url);
}

function proxyAuthHeader(u) {
  return u.username ? `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')}` : null;
}

function lookupAll(host) {
  return new Promise((resolve, reject) => {
    dns.lookup(host, { all: true }, (err, addrs) => (err ? reject(err) : resolve(addrs.map((a) => a.address))));
  });
}

class Denied extends Error {}

// Resolve and vet the target when going direct; returns the address to dial.
async function directAddress(name, host, port, opts) {
  const addrs = net.isIP(host) ? [host] : await lookupAll(host);
  const ok = allowedAddresses(name, port, addrs, opts);
  if (!ok.length) throw new Denied(`${host} → ${addrs.join(', ')}: адрес хоста/внутренней сети, нужно явное правило IP/CIDR`);
  return ok[0];
}

function connectSocket(host, port, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port });
    const t = setTimeout(() => s.destroy(new Error('таймаут соединения')), timeoutMs);
    s.once('connect', () => { clearTimeout(t); resolve(s); });
    s.once('error', (e) => { clearTimeout(t); reject(e); });
  });
}

// A TCP tunnel to host:port: through the corporate proxy (CONNECT) or direct.
async function openTunnel(name, host, port, opts) {
  const corp = corporateProxyFor(host);
  if (!corp) {
    const ip = await directAddress(name, host, port, opts);
    return { socket: await connectSocket(ip, port), via: 'direct' };
  }
  const u = new URL(corp);
  const sock = await connectSocket(u.hostname.replace(/^\[|\]$/g, ''), Number(u.port) || 80);
  const auth = proxyAuthHeader(u);
  const authority = net.isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`;
  sock.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}\r\n`);
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const t = setTimeout(() => { sock.destroy(); reject(new Error('корпоративный прокси не ответил на CONNECT')); }, 20000);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) { if (buf.length > 16384) { sock.destroy(); reject(new Error('слишком длинный ответ прокси')); } return; }
      clearTimeout(t);
      sock.off('data', onData);
      const line = buf.slice(0, buf.indexOf('\r\n')).toString('latin1');
      const code = Number((line.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/) || [])[1]);
      if (code !== 200) { sock.destroy(); return reject(new Error(`корпоративный прокси: ${line}`)); }
      resolve({ socket: sock, rest: buf.slice(end + 4), via: 'proxy' });
    };
    sock.on('data', onData);
    sock.once('error', (e) => { clearTimeout(t); reject(e); });
  });
}

// ---------- server ----------
function remoteAllowed(sock) {
  const remote = unmap(sock.remoteAddress || '');
  return ownAddresses().has(remote) && !remote.startsWith('127.') && remote !== '::1';
}

function authenticate(headers) {
  const h = headers['proxy-authorization'];
  const m = typeof h === 'string' && h.match(/^\s*Basic\s+([A-Za-z0-9+/=]+)\s*$/i);
  if (!m) return null;
  const dec = Buffer.from(m[1], 'base64').toString('utf8');
  const i = dec.indexOf(':');
  if (i < 1) return null;
  let user = dec.slice(0, i); const pass = dec.slice(i + 1);
  try { user = decodeURIComponent(user); } catch {}
  const pull = user.endsWith(PULL_SUFFIX);
  const name = pull ? user.slice(0, -PULL_SUFFIX.length) : user;
  const mc = getMachine(name);
  if (!mc || !mc.enabled) return null;
  const want = Buffer.from(pull ? mc.pullToken : mc.token);
  const got = Buffer.from(pass);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  return { name, pull };
}

function rawReply(sock, code, text, headers = {}) {
  const body = `smolvm-web egress: ${text}\n`;
  const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
  try {
    sock.end(`HTTP/1.1 ${code} ${http.STATUS_CODES[code] || ''}\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\nx-smolvm-egress: ${code === 403 ? 'denied' : 'error'}\r\n${extra}\r\n${body}`);
  } catch {}
}

const AUTH_REQUIRED = { 'proxy-authenticate': 'Basic realm="smolvm-web egress"' };

function parseAuthority(s) {
  const m = String(s || '').match(/^\[([0-9a-f:.]+)\]:(\d{1,5})$/i) || String(s || '').match(/^([^:[\]\s]+):(\d{1,5})$/);
  if (!m) return null;
  const port = Number(m[2]);
  if (!port || port > 65535) return null;
  return { host: normHost(m[1]), port };
}

async function onConnect(req, client, head) {
  client.on('error', () => {});
  if (!remoteAllowed(client)) return rawReply(client, 403, 'доступ только для машин этого хоста');
  const who = authenticate(req.headers);
  if (!who) return rawReply(client, 407, 'нужен токен машины (Proxy-Authorization)', AUTH_REQUIRED);
  const t = parseAuthority(req.url);
  if (!t) return rawReply(client, 400, `некорректная цель CONNECT ${req.url}`);
  const d = decide(who.name, t.host, t.port, { pull: who.pull, record: true });
  const entry = logStart({ machine: who.name, pull: who.pull, method: 'CONNECT', host: t.host, port: t.port, allow: d.allow, learned: !!d.learned, rule: d.rule, source: d.source, reason: d.reason });
  if (!d.allow) return rawReply(client, 403, `${t.host}:${t.port} не разрешён для машины ${who.name} (${d.reason})`);

  let up;
  try { up = await openTunnel(who.name, t.host, t.port, { pull: who.pull }); } catch (e) {
    const denied = e instanceof Denied;
    if (denied) Object.assign(entry, { allow: false, reason: e.message });
    logEnd(entry, { error: e.message });
    return rawReply(client, denied ? 403 : 502, e.message);
  }
  entry.via = up.via;
  const server = up.socket;
  server.on('error', () => {});
  client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  if (up.rest?.length) { client.write(up.rest); entry.bytesIn += up.rest.length; }
  if (head?.length) { server.write(head); entry.bytesOut += head.length; }
  client.on('data', (c) => { entry.bytesOut += c.length; });
  server.on('data', (c) => { entry.bytesIn += c.length; });
  client.pipe(server); server.pipe(client);
  for (const s of [client, server]) s.setTimeout(IDLE_MS, () => { client.destroy(); server.destroy(); });
  const close = () => { client.destroy(); server.destroy(); logEnd(entry); };
  client.once('close', close); server.once('close', close);
}

function plainReply(res, code, text, headers = {}) {
  if (res.headersSent) return res.destroy();
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'x-smolvm-egress': code === 403 ? 'denied' : 'error', ...headers });
  res.end(`smolvm-web egress: ${text}\n`);
}

async function onRequest(req, res) {
  if (!remoteAllowed(req.socket)) return plainReply(res, 403, 'доступ только для машин этого хоста');
  let u;
  try { u = new URL(req.url); } catch { return plainReply(res, 400, 'это egress-прокси smolvm-web: используйте его как HTTP(S)_PROXY'); }
  const who = authenticate(req.headers);
  if (!who) return plainReply(res, 407, 'нужен токен машины (Proxy-Authorization)', AUTH_REQUIRED);
  if (u.protocol !== 'http:') return plainReply(res, 400, `схема ${u.protocol} не поддерживается: для HTTPS клиент должен использовать CONNECT`);
  const host = normHost(u.hostname);
  const port = Number(u.port) || 80;
  const d = decide(who.name, host, port, { pull: who.pull, record: true });
  const entry = logStart({ machine: who.name, pull: who.pull, method: req.method, host, port, path: u.pathname.slice(0, 200), allow: d.allow, learned: !!d.learned, rule: d.rule, source: d.source, reason: d.reason });
  if (!d.allow) return plainReply(res, 403, `${host}:${port} не разрешён для машины ${who.name} (${d.reason})`);

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
  headers.host = u.host;
  let opts;
  const corp = corporateProxyFor(host);
  try {
    if (corp) {
      const cu = new URL(corp);
      const auth = proxyAuthHeader(cu);
      if (auth) headers['proxy-authorization'] = auth;
      opts = { host: cu.hostname.replace(/^\[|\]$/g, ''), port: Number(cu.port) || 80, path: u.href };
      entry.via = 'proxy';
    } else {
      opts = { host: await directAddress(who.name, host, port, { pull: who.pull }), port, path: u.pathname + u.search };
      entry.via = 'direct';
    }
  } catch (e) {
    const denied = e instanceof Denied;
    if (denied) Object.assign(entry, { allow: false, reason: e.message });
    logEnd(entry, { error: e.message });
    return plainReply(res, denied ? 403 : 502, e.message);
  }
  const upReq = http.request({ ...opts, method: req.method, headers }, (upRes) => {
    const h = {};
    for (const [k, v] of Object.entries(upRes.headers)) if (!HOP.has(k)) h[k] = v;
    entry.status = upRes.statusCode;
    res.writeHead(upRes.statusCode, h);
    upRes.on('data', (c) => { entry.bytesIn += c.length; });
    upRes.pipe(res);
  });
  upReq.setTimeout(IDLE_MS, () => upReq.destroy(new Error('таймаут')));
  upReq.on('error', (e) => { logEnd(entry, { error: e.message }); plainReply(res, 502, `upstream: ${e.message}`); });
  req.on('data', (c) => { entry.bytesOut += c.length; });
  res.on('close', () => { upReq.destroy(); logEnd(entry); });
  req.pipe(upReq);
}

let server = null;
let status = { listening: false, error: null };

function start() {
  if (server) return Promise.resolve(status);
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      onRequest(req, res).catch((e) => plainReply(res, 500, e.message));
    });
    server.on('connect', (req, sock, head) => {
      onConnect(req, sock, head).catch((e) => rawReply(sock, 500, e.message));
    });
    server.on('clientError', (e, sock) => { try { sock.destroy(); } catch {} });
    server.on('error', (e) => {
      status = { listening: false, error: `${e.code || e.message} (порт ${PORT})` };
      server = null;
      resolve(status);
    });
    // All interfaces, so a changed host IP keeps working; remote address is filtered per connection.
    server.listen(PORT, '0.0.0.0', () => { status = { listening: true, error: null }; resolve(status); });
  });
}

function anyEnabled() { return Object.values(S().machines).some((m) => m.enabled); }

// Proxy URLs a machine is given (workload, and the image-pull credential).
async function machineProxy(name) {
  const m = getMachine(name);
  if (!m?.enabled) return null;
  const ip = await px.hostIp();
  if (!ip) throw new Error('egress-фильтр: не удалось определить адрес хоста, доступный из машины');
  const base = (user, token) => `http://${encodeURIComponent(user)}:${token}@${ip}:${PORT}`;
  return { url: base(name, m.token), pullUrl: base(name + PULL_SUFFIX, m.pullToken), hostIp: ip, strict: m.strict };
}

function view() {
  const s = S();
  return {
    port: PORT,
    status: { ...status, port: PORT },
    defaults: s.defaults,
    pullHosts: s.pullHosts,
    lists: s.lists,
    machines: Object.fromEntries(Object.entries(s.machines).map(([n, m]) => [n, {
      enabled: m.enabled, strict: m.strict, lists: m.lists, rules: m.rules, strictApplied: m.strictApplied,
      learn: !!m.learn, learnSince: m.learnSince || null, learnedCount: Object.keys(m.learned || {}).length,
      vendorCount: extraFor(n).length,
    }])),
    templates: TEMPLATES,
  };
}

module.exports = {
  PORT, TEMPLATES, start, status: () => ({ ...status, port: PORT }), anyEnabled, view,
  getMachine, setMachine, forgetMachine, copyMachine, machineProxy, defaultLists, defaults: () => S().defaults,
  learned, finishLearning, onLog, setExtraRules,
  saveList, deleteList, saveSettings, normalizeRule, explain, decide, log, deniedSummary,
  // for tests
  _internal: { parseHost, parsePorts, isSpecial, allowedAddresses, parseAuthority },
};
