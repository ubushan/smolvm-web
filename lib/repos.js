'use strict';
// Corporate repositories (JFrog Artifactory, Nexus, Harbor, ...).
//
// Images: Docker Hub references (node:22, alpine, docker.io/x/y) are rewritten
// to the corporate registry prefix, and its credentials reach smolvm the way
// `docker login` would: a Docker config.json (the user's own, plus our auth
// entry) in a directory passed as DOCKER_CONFIG to every smolvm process
// smolvm-web starts. smolvm resolves the credential on the host and hands it to
// the in-guest pull.
//
// Packages: pip, npm, apt and Go in the guest are pointed at the corporate
// mirrors (exec env + guest config files). Credentials go into the guest only
// when asked to, since the workload can read them there.
//
// The repository hosts are allowed for machines behind the egress filter,
// including when they resolve to internal addresses.

const fs = require('fs');
const os = require('os');
const path = require('path');
const cfg = require('./config');

const R = () => cfg.getSettings().repos;
const DOCKER_DIR = path.join(cfg.DIR, 'docker');

function cleanUrl(u) { return String(u || '').trim().replace(/\/+$/, ''); }

function registryHost() {
  const prefix = String(R().registry || '').trim().replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, '');
  return prefix ? prefix.split('/')[0].toLowerCase() : '';
}

// Is the first path segment of an image reference a registry host?
function hasRegistry(first) { return first.includes('.') || first.includes(':') || first === 'localhost'; }

// node:22 -> <prefix>/library/node:22; docker.io/x/y -> <prefix>/x/y; other registries untouched.
function rewriteImage(image) {
  const r = R();
  const prefix = String(r.registry || '').trim().replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, '');
  if (!prefix || !r.rewrite || !image) return image;
  let ref = String(image).trim();
  const first = ref.split('/')[0];
  if (hasRegistry(first)) {
    if (!/^(docker\.io|index\.docker\.io|registry-1\.docker\.io)$/i.test(first)) return image;
    ref = ref.slice(first.length + 1);
  }
  if (!ref.includes('/')) ref = `library/${ref}`;
  return `${prefix}/${ref}`;
}

// The user's Docker config (credential helpers, other logins) plus our registry login.
// Always written, so a `smolvm serve` started before the login was configured picks
// it up: the file is re-read on each pull and rewritten when the settings change.
function dockerConfigDir() {
  const r = R();
  const host = registryHost();
  const userDir = process.env.DOCKER_CONFIG || path.join(os.homedir(), '.docker');
  let conf = {};
  if (path.resolve(userDir) !== path.resolve(DOCKER_DIR)) {
    try { conf = JSON.parse(fs.readFileSync(path.join(userDir, 'config.json'), 'utf8')) || {}; } catch {}
  }
  if (host && r.username && r.password) conf.auths = { ...(conf.auths || {}), [host]: { auth: Buffer.from(`${r.username}:${r.password}`).toString('base64') } };
  fs.mkdirSync(DOCKER_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(DOCKER_DIR, 'config.json');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(conf, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return DOCKER_DIR;
}

// Environment for smolvm processes (CLI and `smolvm serve`).
function cliEnv(base = process.env) {
  let dir = null;
  try { dir = dockerConfigDir(); } catch {}
  return dir ? { ...base, DOCKER_CONFIG: dir } : base;
}

function withAuth(url) {
  const r = R();
  if (!url || !r.guestAuth || !r.username || !r.password) return url;
  try {
    const u = new URL(url);
    u.username = encodeURIComponent(r.username);
    u.password = encodeURIComponent(r.password);
    return u.toString().replace(/\/+$/, '');
  } catch { return url; }
}

// Env for commands in the guest (console, exec, agent installs) — effective at once.
function guestEnv() {
  const r = R();
  const env = [];
  const put = (name, value) => { if (value) env.push({ name, value }); };
  if (r.pip) {
    put('PIP_INDEX_URL', withAuth(cleanUrl(r.pip)));
    try { const u = new URL(r.pip); if (u.protocol === 'http:') put('PIP_TRUSTED_HOST', u.hostname); } catch {}
  }
  if (r.npm) put('NPM_CONFIG_REGISTRY', `${cleanUrl(r.npm)}/`);
  if (r.goproxy) { put('GOPROXY', withAuth(cleanUrl(r.goproxy))); put('GONOSUMDB', '*'); put('GOFLAGS', '-mod=mod'); }
  return env;
}

// Values for the guest provisioning script (persistent config files).
function provisionEnv() {
  const r = R();
  let npmAuth = '';
  if (r.npm && r.guestAuth && r.username && r.password) {
    try {
      const u = new URL(r.npm);
      npmAuth = `//${u.host}${u.pathname.replace(/\/?$/, '/')}:_auth=${Buffer.from(`${r.username}:${r.password}`).toString('base64')}`;
    } catch {}
  }
  let aptAuth = '';
  if ((r.aptDebian || r.aptSecurity) && r.guestAuth && r.username && r.password) {
    aptAuth = [r.aptDebian, r.aptSecurity].filter(Boolean).map((x) => {
      try { const u = new URL(x); return `machine ${u.host}${u.pathname} login ${r.username} password ${r.password}`; } catch { return ''; }
    }).filter(Boolean).join('\n');
  }
  let pipTrusted = '';
  try { if (r.pip && new URL(r.pip).protocol === 'http:') pipTrusted = new URL(r.pip).hostname; } catch {}
  return [
    { name: 'SMOLVM_PIP_INDEX', value: r.pip ? withAuth(cleanUrl(r.pip)) : '' },
    { name: 'SMOLVM_PIP_TRUSTED', value: pipTrusted },
    { name: 'SMOLVM_NPM_REGISTRY', value: r.npm ? `${cleanUrl(r.npm)}/` : '' },
    { name: 'SMOLVM_NPM_AUTH', value: npmAuth },
    { name: 'SMOLVM_APT_DEBIAN', value: cleanUrl(r.aptDebian) },
    { name: 'SMOLVM_APT_SECURITY', value: cleanUrl(r.aptSecurity) },
    { name: 'SMOLVM_APT_AUTH', value: aptAuth },
    { name: 'SMOLVM_GOPROXY', value: r.goproxy ? withAuth(cleanUrl(r.goproxy)) : '' },
  ];
}

function active() {
  const r = R();
  return !!(r.pip || r.npm || r.aptDebian || r.aptSecurity || r.goproxy);
}

// Hosts machines behind the egress filter may reach (internal addresses included).
function hosts() {
  const r = R();
  const out = new Set();
  const host = registryHost();
  if (host) out.add(host.replace(/:\d+$/, ''));
  for (const u of [r.pip, r.npm, r.aptDebian, r.aptSecurity, r.goproxy]) {
    try { if (u) out.add(new URL(u).hostname.toLowerCase()); } catch {}
  }
  return [...out];
}

function validate(next) {
  const errs = [];
  for (const k of ['pip', 'npm', 'aptDebian', 'aptSecurity', 'goproxy']) {
    const v = String(next[k] || '').trim();
    if (!v) continue;
    try { const u = new URL(v); if (!/^https?:$/.test(u.protocol)) throw new Error(); } catch { errs.push(`${k}: нужен URL http(s)://…`); }
  }
  const reg = String(next.registry || '').trim();
  if (reg && !/^([a-z]+:\/\/)?[a-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._\/-]+)?\/?$/i.test(reg)) errs.push('реестр образов: ожидается host[:port][/путь], например artifactory.corp/docker-remote');
  if (errs.length) throw new Error(`Репозитории: ${errs.join('; ')}`);
}

module.exports = { rewriteImage, registryHost, dockerConfigDir, cliEnv, guestEnv, provisionEnv, active, hosts, validate };
