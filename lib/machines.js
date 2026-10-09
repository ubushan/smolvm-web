'use strict';
// Proxy-aware machine operations: starting through the CLI (the only path
// that takes a proxy for the in-guest image pull) and provisioning the guest.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const cfg = require('./config');
const px = require('./proxy');
const up = require('./upstream');
const vault = require('./vault');
const gateway = require('./gateway');
const egress = require('./egress');
const dirs = require('./dirs');

const repos = require('./repos');

// The smolvm binary: the path set in the UI, else SMOLVM_BIN, else `smolvm` on PATH.
function smolvmBin() { return cfg.getSettings().smolvm.bin || process.env.SMOLVM_BIN || 'smolvm'; }
// smolvm's in-guest image pull (crane) trusts /etc/smolvm-host-trust/ca-bundle.pem
// when a read-only volume is mounted there — what `--trust-host-certs` does on
// macOS/Linux. smolvm cannot read the Windows store itself, so smolvm-web
// writes its own bundle (Windows/macOS store + pasted PEM) and mounts it.
const TRUST_DIR = path.join(cfg.DIR, 'host-trust');

function wantsPullTrust(name) {
  const s = cfg.getSettings();
  return !!(s.ca.enabled && s.ca.pullTrust && cfg.machineUsesProxy(name));
}

// Write the current bundle to the host directory that is mounted into machines.
function stagePullTrust() {
  const pem = px.buildBundle(cfg.getSettings().ca).pem;
  fs.mkdirSync(TRUST_DIR, { recursive: true });
  const file = path.join(TRUST_DIR, 'ca-bundle.pem');
  let cur = null;
  try { cur = fs.readFileSync(file, 'utf8'); } catch {}
  if (cur !== pem) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, pem);
    fs.renameSync(tmp, file);
  }
  return { source: TRUST_DIR, target: px.GUEST_TRUST_DIR, readonly: true };
}

const PROXY_VARS = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy'];
const enc = encodeURIComponent;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The effective proxy for a machine, or null when it should go direct. A
// machine behind the egress filter gets smolvm-web's filtering proxy (which
// itself goes out through the corporate proxy); NO_PROXY then holds only the
// guest's loopback and the host (secret gateway), so nothing skips the filter.
async function effectiveProxy(name) {
  const s = cfg.getSettings();
  const e = name ? await egress.machineProxy(name) : null;
  if (e) {
    return { url: e.url, pullUrl: e.pullUrl, noProxy: px.noProxyList(e.hostIp), egress: true, settings: { pull: true, exec: true, provision: true } };
  }
  if (!s.proxy.enabled || !s.proxy.url || (name && !cfg.machineUsesProxy(name))) return null;
  const g = await px.guestUrl(s.proxy.url);
  if (g.error) throw new Error(g.error);
  // The host itself (secret gateway) is always reached directly, never via the proxy.
  const ip = await px.hostIp();
  return { url: g.url, pullUrl: g.url, noProxy: px.noProxyList([s.proxy.noProxy, ip].filter(Boolean).join(',')), settings: s.proxy };
}

// How a machine has to be started, given its proxy and secrets.
//  - smolvm credential substitution resolves values that `smolvm serve` holds
//    in memory, so such machines start through the API;
//  - the corporate proxy and the secret gateway live on the host / LAN, which
//    `smolvm serve` walls off (strict egress floor), so those start via the CLI.
async function startPlan(name) {
  const secrets = await vault.machineSecrets(name).catch(() => []);
  const native = secrets.filter((x) => x.mode === 'substitute');
  const gw = secrets.filter((x) => x.mode === 'gateway');
  const proxy = await effectiveProxy(name);
  const warnings = [];
  if (native.length && (proxy || gw.length)) {
    warnings.push(proxy?.egress
      ? 'Машина с подстановкой smolvm стартует через API: egress-фильтр smolvm-web и шлюз секретов из неё недоступны.'
      : 'Машина с подстановкой smolvm стартует через API: корпоративный прокси и шлюз секретов из неё недоступны.');
  }
  return { viaCli: !native.length && !!(proxy || gw.length), proxy, native, warnings };
}

// Run a smolvm CLI command. stdout/stderr go to a file rather than a pipe:
// on Windows `machine start` never returns to a caller that captures its output
// (the VM process inherits the pipe handles).
function runCli(args, { timeoutMs = 15 * 60 * 1000, until, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const logFile = path.join(os.tmpdir(), `smolvm-web-${process.pid}-${Date.now()}.log`);
    const fd = fs.openSync(logFile, 'w');
    let child;
    try {
      child = spawn(smolvmBin(), args, { stdio: ['ignore', fd, fd], windowsHide: true, env: repos.cliEnv(), ...(cwd ? { cwd } : {}) });
    } catch (e) { fs.closeSync(fd); return reject(e); }
    let finished = false;
    const readLog = () => { try { return fs.readFileSync(logFile, 'utf8'); } catch { return ''; } };
    const finish = (err, out) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { fs.closeSync(fd); } catch {}
      const log = readLog();
      setTimeout(() => fs.rm(logFile, { force: true }, () => {}), 1000);
      if (err) { err.log = log; reject(err); } else resolve({ ...out, log });
    };
    const timer = setTimeout(() => finish(new Error(`smolvm ${args[0]} ${args[1] || ''}: таймаут`)), timeoutMs);
    child.on('error', (e) => finish(new Error(`не удалось запустить ${smolvmBin()}: ${e.message}${e.code === 'ENOENT' ? ' — укажите путь к smolvm в настройках («Сеть, прокси и сертификаты» → «smolvm»)' : ''}`)));
    child.on('exit', (code) => {
      if (code === 0) finish(null, { code });
      else {
        const log = readLog().trim().split('\n').slice(-6).join('\n');
        finish(new Error(log || `smolvm завершился с кодом ${code}`));
      }
    });
    // Fallback for a CLI that keeps running after the machine is up.
    if (until) {
      (async () => {
        await sleep(3000);
        while (!finished) {
          if (await until().catch(() => false)) return finish(null, { code: null, detached: true });
          await sleep(2000);
        }
      })();
    }
  });
}

async function startViaCli(name, { branchable, proxy, waitExit } = {}) {
  const args = ['machine', 'start', '--name', name];
  if (proxy && proxy.settings.pull) args.push('--proxy', proxy.pullUrl || proxy.url, '--no-proxy', proxy.noProxy);
  if (branchable) args.push('--branchable');
  // waitExit: the first start of a Smolfile machine runs its `init`, and the CLI
  // returns only when that is done, so don't settle for "running" early.
  const out = await runCli(args, {
    timeoutMs: waitExit ? 45 * 60 * 1000 : undefined,
    until: waitExit ? undefined : async () => {
      const r = await up.request('GET', `/api/v1/machines/${enc(name)}`);
      return r.status === 200 && r.data.state === 'running' && r.data.pid;
    },
  });
  const r = await up.request('GET', `/api/v1/machines/${enc(name)}`);
  if (r.status !== 200) throw Object.assign(new Error(r.data?.error || 'machine not found'), { status: r.status });
  return { ...r.data, _cliLog: out?.log || '' };
}

// Changes that need a stopped machine, applied right before it starts:
// mounts for the directory views and the strict egress policy (host only).
async function prepareStart(name) {
  const done = [];
  // Corporate CA for the image pull: keep the mounted bundle current, add or drop the mount.
  {
    const info = await up.request('GET', `/api/v1/machines/${enc(name)}`).catch(() => null);
    const mounted = (info?.data?.mounts || []).find((m) => m.target === px.GUEST_TRUST_DIR);
    const want = wantsPullTrust(name);
    if (want) {
      let mt;
      try { mt = stagePullTrust(); } catch (e) { throw new Error(`сертификаты для скачивания образа: ${e.message}`); }
      if (!mounted) {
        try { await runCli(['machine', 'update', '--name', name, '--volume', `${mt.source}:${mt.target}:ro`], { timeoutMs: 120000 }); }
        catch (e) { throw new Error(`сертификаты для скачивания образа: ${e.message}`); }
        done.push('корпоративные сертификаты подключены для скачивания образа');
      }
    } else if (mounted && mounted.source && path.resolve(mounted.source) === path.resolve(TRUST_DIR)) {
      try { await runCli(['machine', 'update', '--name', name, '--remove-volume', `${mounted.source}:${mounted.target}`], { timeoutMs: 120000 }); }
      catch (e) { throw new Error(`сертификаты для скачивания образа: ${e.message}`); }
      done.push('том с сертификатами отключён');
    }
  }
  // Ports of agents declared after create (Agents tab) — published while stopped.
  const agents = require('./agents');
  if (agents.get(name)) {
    const info = await up.request('GET', `/api/v1/machines/${enc(name)}`);
    const add = await agents.missingPorts(name, info.data);
    if (add.length) {
      const args = ['machine', 'update', '--name', name];
      for (const p of add) args.push('--port', `${p.host}:${p.guest}`);
      try { await runCli(args, { timeoutMs: 120000 }); } catch (e) { throw new Error(`порты агентов: ${e.message}`); }
      done.push(`порты агентов: ${add.map((p) => `${p.host}→${p.guest}`).join(', ')}`);
    }
  }
  const diff = dirs.mountDiff(name);
  if (diff.add.length || diff.remove.length) {
    const args = ['machine', 'update', '--name', name];
    for (const m of diff.remove) args.push('--remove-volume', `${m.source}:${m.target}`);
    for (const m of diff.add) args.push('--volume', `${m.source}:${m.target}${m.readonly ? ':ro' : ''}`);
    try { await runCli(args, { timeoutMs: 120000 }); } catch (e) { throw new Error(`монтирования директорий: ${e.message}`); }
    dirs.markApplied(name, dirs.desiredMounts(name));
    done.push(`монтирования: +${diff.add.length} −${diff.remove.length}`);
  }
  const em = egress.getMachine(name);
  if (em) {
    let want = null;
    if (em.enabled && em.strict) {
      const ip = await px.hostIp();
      if (!ip) throw new Error('жёсткая изоляция: не удалось определить адрес хоста, доступный из машины');
      want = `${ip}/32`;
    }
    if (want !== (em.strictApplied || null)) {
      await setStrictPolicy(name, want, em.strictApplied);
      egress.setMachine(name, { strictApplied: want });
      done.push(want ? `egress только к ${want}` : 'egress-политика smolvm снята');
    }
    // The workload's own env (set at create) follows the filter too.
    const p = await effectiveProxy(name).catch(() => null);
    const env = p ? px.proxyEnv(p.url, p.noProxy) : [];
    const fp = px.fingerprint(env);
    if (fp !== (em.envApplied || null)) {
      const args = ['machine', 'update', '--name', name];
      if (env.length) for (const e of env) args.push('--env', `${e.name}=${e.value}`);
      else for (const k of PROXY_VARS) args.push('--remove-env', k);
      try { await runCli(args, { timeoutMs: 120000 }); } catch (e) { throw new Error(`переменные прокси: ${e.message}`); }
      egress.setMachine(name, { envApplied: fp });
    }
  }
  return done;
}

// Point the smolvm egress policy of a stopped machine at the host only (or undo it).
async function setStrictPolicy(name, want, had) {
  const body = { allowCidrs: want ? [want] : [], removeAllowCidrs: had ? [had] : [], allowAll: true };
  const r = await up.request('POST', `/api/v1/machines/${enc(name)}/egress`, body);
  if (r.status === 200 || r.status === 204) return;
  if (![400, 404, 405, 422].includes(r.status)) throw new Error(`egress-политика: ${r.data?.error || `HTTP ${r.status}`}`);
  // Older smolvm: no API route (or no allowAll field), the CLI does the same.
  const args = ['machine', 'update', '--name', name];
  if (want) args.push('--allow-cidr', want);
  if (had) args.push('--remove-allow-cidr', had);
  if (!want) args.push('--net');
  try { await runCli(args, { timeoutMs: 120000 }); } catch (e) { throw new Error(`egress-политика: ${e.message}`); }
}

// smolvm keeps substitution values in memory only: hand them over before every start.
async function pushCredentialValues(name, native) {
  if (!native.length) return;
  const values = Object.fromEntries(native.map((x) => [x.name, x.value]));
  const r = await up.request('PUT', `/api/v1/machines/${enc(name)}/credential-values`, { values });
  if (r.status !== 204 && r.status !== 200) throw new Error(`credential-values: ${r.data?.error || `HTTP ${r.status}`}`);
}

// Env a machine's secrets contribute (gateway tokens + base URLs, plaintext env).
async function secretEnv(name) {
  const env = [];
  for (const x of await vault.machineSecrets(name).catch(() => [])) {
    if (x.mode === 'gateway' && x.token) {
      env.push({ name: x.envVar, value: x.token });
      if (x.baseUrlVar) {
        const url = await gateway.baseUrl(x.name);
        if (url) env.push({ name: x.baseUrlVar, value: url });
      }
    } else if (x.mode === 'env') {
      env.push({ name: x.envVar, value: x.value });
    }
  }
  // The same provider under the names other agents read (Claude Code, opencode, dsh).
  return px.mergeEnv(env, await require('./providers').aliasEnv(name).catch(() => []));
}

// ---------- provisioning ----------
// POSIX sh, idempotent. Values come in through env, never interpolated into the script.
const PROVISION_SCRIPT = String.raw`
q() { printf "'%s'" "$(printf %s "$1" | sed "s/'/'\\\\''/g")"; }
B=@@BUNDLE@@
mkdir -p /etc/profile.d 2>/dev/null
done_=""
if [ -n "$SMOLVM_P" ]; then
  { for k in HTTP_PROXY http_proxy HTTPS_PROXY https_proxy; do echo "export $k=$(q "$SMOLVM_P")"; done
    echo "export NO_PROXY=$(q "$SMOLVM_NP")"; echo "export no_proxy=$(q "$SMOLVM_NP")"; } > /etc/profile.d/smolvm-proxy.sh && done_="$done_ profile.d"
  if [ -d /etc/apt/apt.conf.d ]; then
    printf 'Acquire::http::Proxy "%s";\nAcquire::https::Proxy "%s";\n' "$SMOLVM_P" "$SMOLVM_P" > /etc/apt/apt.conf.d/95smolvm-proxy && done_="$done_ apt"
  fi
  if command -v git >/dev/null 2>&1; then git config --system http.proxy "$SMOLVM_P" 2>/dev/null && done_="$done_ git"; fi
else
  rm -f /etc/profile.d/smolvm-proxy.sh /etc/apt/apt.conf.d/95smolvm-proxy
  command -v git >/dev/null 2>&1 && git config --system --unset http.proxy 2>/dev/null
fi
# pip (system-wide config)
{ echo "[global]"; [ -n "$SMOLVM_P" ] && echo "proxy = $SMOLVM_P"; [ "$SMOLVM_CA" = 1 ] && echo "cert = $B"
  [ -n "$SMOLVM_PIP_INDEX" ] && echo "index-url = $SMOLVM_PIP_INDEX"; [ -n "$SMOLVM_PIP_TRUSTED" ] && echo "trusted-host = $SMOLVM_PIP_TRUSTED"; true; } > /etc/pip.conf && done_="$done_ pip"
# npm (global npmrc)
if command -v npm >/dev/null 2>&1; then
  NPMRC="$(npm prefix -g 2>/dev/null)/etc/npmrc"; mkdir -p "$(dirname "$NPMRC")" 2>/dev/null
  { [ -n "$SMOLVM_P" ] && { echo "proxy=$SMOLVM_P"; echo "https-proxy=$SMOLVM_P"; echo "noproxy=$SMOLVM_NP"; }
    [ "$SMOLVM_CA" = 1 ] && echo "cafile=$B"
    [ -n "$SMOLVM_NPM_REGISTRY" ] && echo "registry=$SMOLVM_NPM_REGISTRY"; [ -n "$SMOLVM_NPM_AUTH" ] && echo "$SMOLVM_NPM_AUTH"; true; } > "$NPMRC" && done_="$done_ npm"
fi
# corporate apt mirrors (Artifactory/Nexus debian remotes); originals kept as *.smolvm-orig
for f in /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources; do
  [ -f "$f" ] || continue
  [ -f "$f.smolvm-orig" ] || cp "$f" "$f.smolvm-orig"
  cp "$f.smolvm-orig" "$f"
  [ -n "$SMOLVM_APT_SECURITY" ] && sed -i "s#https\?://deb.debian.org/debian-security#$SMOLVM_APT_SECURITY#g; s#https\?://security.debian.org/debian-security#$SMOLVM_APT_SECURITY#g" "$f"
  [ -n "$SMOLVM_APT_DEBIAN" ] && sed -i "s#https\?://deb.debian.org/debian\([ /]\|$\)#$SMOLVM_APT_DEBIAN\1#g" "$f"
  { [ -n "$SMOLVM_APT_DEBIAN" ] || [ -n "$SMOLVM_APT_SECURITY" ]; } && done_="$done_ apt-mirror"
done
if [ -n "$SMOLVM_APT_AUTH" ] && [ -d /etc/apt ]; then mkdir -p /etc/apt/auth.conf.d; printf '%s\n' "$SMOLVM_APT_AUTH" > /etc/apt/auth.conf.d/smolvm.conf; chmod 600 /etc/apt/auth.conf.d/smolvm.conf; else rm -f /etc/apt/auth.conf.d/smolvm.conf 2>/dev/null; fi
# Go modules
if [ -n "$SMOLVM_GOPROXY" ]; then printf 'export GOPROXY=%s\nexport GONOSUMDB=*\n' "$(q "$SMOLVM_GOPROXY")" > /etc/profile.d/smolvm-go.sh && done_="$done_ go"; else rm -f /etc/profile.d/smolvm-go.sh; fi
if [ "$SMOLVM_CA" = 1 ] && [ -s "$B" ]; then
  { for k in @@TRUST_VARS@@; do echo "export $k=$B"; done; } > /etc/profile.d/smolvm-trust.sh
  if [ "$SMOLVM_REPLACE" = 1 ]; then
    for f in /etc/ssl/certs/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt /etc/ssl/cert.pem; do
      if [ -e "$f" ] && ! cmp -s "$B" "$f"; then cp "$B" "$f" && done_="$done_ $f"; fi
    done
  fi
  [ "$(git config --system http.sslCAInfo 2>/dev/null)" = "$B" ] || { command -v git >/dev/null 2>&1 && git config --system http.sslCAInfo "$B"; }
  done_="$done_ ca"
else
  rm -f /etc/profile.d/smolvm-trust.sh
fi
echo "configured:$done_"
`;

const exec = up.exec;
const waitReady = up.waitReady;

function provisionFingerprint(proxy, s) {
  return px.fingerprint({ p: proxy?.url || '', np: proxy?.noProxy || '', ca: s.ca.enabled ? [s.ca.pem, s.ca.system, s.ca.replaceSystemBundle] : 0, r: repos.provisionEnv() });
}

// Write proxy + CA config into a running guest. Returns a short summary.
async function provision(name) {
  const s = cfg.getSettings();
  const proxy = await effectiveProxy(name).catch(() => null);
  const useCa = s.ca.enabled && cfg.machineUsesProxy(name);
  if (!(proxy && proxy.settings.provision) && !useCa && !repos.active() && !cfg.getProvisioned(name)) return { skipped: true };

  await waitReady(name);
  if (useCa) {
    const bundle = px.buildBundle(s.ca);
    const r = await exec(name, {
      // With the pull-trust volume the directory is read-only and already holds the same bundle.
      command: ['sh', '-c', `mkdir -p ${px.GUEST_TRUST_DIR} 2>/dev/null; if touch ${px.GUEST_TRUST_DIR}/.w 2>/dev/null; then rm -f ${px.GUEST_TRUST_DIR}/.w; cat > ${px.GUEST_BUNDLE}; else cat > /dev/null; [ -s ${px.GUEST_BUNDLE} ]; fi`],
      stdin: bundle.pem, user: '0', timeoutSecs: 30,
    });
    if (r.exitCode !== 0) throw new Error(`не удалось записать CA bundle: ${r.stderr || r.stdout}`);
  }
  const script = PROVISION_SCRIPT
    .replace('@@BUNDLE@@', px.GUEST_BUNDLE)
    .replace('@@TRUST_VARS@@', px.trustEnv().map((e) => e.name).join(' '));
  const r = await exec(name, {
    command: ['sh', '-c', script],
    env: [
      { name: 'SMOLVM_P', value: proxy && proxy.settings.provision ? proxy.url : '' },
      { name: 'SMOLVM_NP', value: proxy ? proxy.noProxy : '' },
      { name: 'SMOLVM_CA', value: useCa ? '1' : '0' },
      ...repos.provisionEnv(),
      { name: 'SMOLVM_REPLACE', value: s.ca.replaceSystemBundle ? '1' : '0' },
    ],
    user: '0', timeoutSecs: 60,
  });
  if (r.exitCode !== 0) throw new Error(`настройка гостя завершилась с кодом ${r.exitCode}: ${(r.stderr || r.stdout).slice(-400)}`);
  const active = proxy || useCa || repos.active();
  cfg.setProvisioned(name, active ? provisionFingerprint(proxy, s) : null);
  return { configured: (r.stdout.match(/configured:(.*)/) || [])[1]?.trim() || '', ca: useCa };
}

// Env to inject into an exec in this machine.
async function execEnv(name) {
  const s = cfg.getSettings();
  const env = await secretEnv(name);
  const p = await effectiveProxy(name).catch(() => null);
  if (p && p.settings.exec) env.push(...px.proxyEnv(p.url, p.noProxy));
  env.push(...repos.guestEnv());
  // Only point tools at the bundle once it exists in the guest.
  if (s.ca.enabled && cfg.getProvisioned(name) && cfg.machineUsesProxy(name)) env.push(...px.trustEnv());
  return env;
}

// Users, gates and links for the machine's directories (needs a running machine).
async function provisionDirs(name) {
  return dirs.provision(name, await execEnv(name).catch(() => []));
}

module.exports = { wantsPullTrust, stagePullTrust, effectiveProxy, startPlan, startViaCli, prepareStart, pushCredentialValues, secretEnv, provision, provisionDirs, execEnv, runCli, smolvmBin };
