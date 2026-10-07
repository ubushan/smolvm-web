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

const SMOLVM_BIN = process.env.SMOLVM_BIN || 'smolvm';
const enc = encodeURIComponent;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The effective proxy for a machine, or null when it should go direct.
async function effectiveProxy(name) {
  const s = cfg.getSettings();
  if (!s.proxy.enabled || !s.proxy.url || (name && !cfg.machineUsesProxy(name))) return null;
  const g = await px.guestUrl(s.proxy.url);
  if (g.error) throw new Error(g.error);
  // The host itself (secret gateway) is always reached directly, never via the proxy.
  const ip = await px.hostIp();
  return { url: g.url, noProxy: px.noProxyList([s.proxy.noProxy, ip].filter(Boolean).join(',')), settings: s.proxy };
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
    warnings.push('Машина с подстановкой smolvm стартует через API: корпоративный прокси и шлюз секретов из неё недоступны.');
  }
  return { viaCli: !native.length && !!(proxy || gw.length), proxy, native, warnings };
}

// Run a smolvm CLI command. stdout/stderr go to a file rather than a pipe:
// on Windows `machine start` never returns to a caller that captures its output
// (the VM process inherits the pipe handles).
function runCli(args, { timeoutMs = 15 * 60 * 1000, until } = {}) {
  return new Promise((resolve, reject) => {
    const logFile = path.join(os.tmpdir(), `smolvm-web-${process.pid}-${Date.now()}.log`);
    const fd = fs.openSync(logFile, 'w');
    let child;
    try {
      child = spawn(SMOLVM_BIN, args, { stdio: ['ignore', fd, fd], windowsHide: true });
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
    child.on('error', (e) => finish(new Error(`не удалось запустить ${SMOLVM_BIN}: ${e.message}`)));
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

async function startViaCli(name, { branchable, proxy } = {}) {
  const args = ['machine', 'start', '--name', name];
  if (proxy && proxy.settings.pull) args.push('--proxy', proxy.url, '--no-proxy', proxy.noProxy);
  if (branchable) args.push('--branchable');
  await runCli(args, {
    until: async () => {
      const r = await up.request('GET', `/api/v1/machines/${enc(name)}`);
      return r.status === 200 && r.data.state === 'running' && r.data.pid;
    },
  });
  const r = await up.request('GET', `/api/v1/machines/${enc(name)}`);
  if (r.status !== 200) throw Object.assign(new Error(r.data?.error || 'machine not found'), { status: r.status });
  return r.data;
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
  return env;
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
{ echo "[global]"; [ -n "$SMOLVM_P" ] && echo "proxy = $SMOLVM_P"; [ "$SMOLVM_CA" = 1 ] && echo "cert = $B"; true; } > /etc/pip.conf && done_="$done_ pip"
# npm (global npmrc)
if command -v npm >/dev/null 2>&1; then
  NPMRC="$(npm prefix -g 2>/dev/null)/etc/npmrc"; mkdir -p "$(dirname "$NPMRC")" 2>/dev/null
  { [ -n "$SMOLVM_P" ] && { echo "proxy=$SMOLVM_P"; echo "https-proxy=$SMOLVM_P"; echo "noproxy=$SMOLVM_NP"; }
    [ "$SMOLVM_CA" = 1 ] && echo "cafile=$B"; true; } > "$NPMRC" && done_="$done_ npm"
fi
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

async function exec(name, body, timeoutMs = 120000) {
  const r = await up.request('POST', `/api/v1/machines/${enc(name)}/exec`, body, { timeoutMs });
  if (r.status !== 200) throw new Error(r.data?.error || `HTTP ${r.status}`);
  return r.data;
}

// Wait until the workload container answers an exec.
async function waitReady(name, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const r = await exec(name, { command: ['true'], timeoutSecs: 10 }, 15000);
      if (r.exitCode === 0) return;
      last = r.stderr;
    } catch (e) { last = e.message; }
    await sleep(1500);
  }
  throw new Error(`машина не готова к exec: ${last || 'таймаут'}`);
}

function provisionFingerprint(proxy, s) {
  return px.fingerprint({ p: proxy?.url || '', np: proxy?.noProxy || '', ca: s.ca.enabled ? [s.ca.pem, s.ca.system, s.ca.replaceSystemBundle] : 0 });
}

// Write proxy + CA config into a running guest. Returns a short summary.
async function provision(name) {
  const s = cfg.getSettings();
  const proxy = await effectiveProxy(name).catch(() => null);
  const useCa = s.ca.enabled && cfg.machineUsesProxy(name);
  if (!(proxy && s.proxy.provision) && !useCa && !cfg.getProvisioned(name)) return { skipped: true };

  await waitReady(name);
  if (useCa) {
    const bundle = px.buildBundle(s.ca);
    const r = await exec(name, {
      command: ['sh', '-c', `mkdir -p ${px.GUEST_TRUST_DIR} && cat > ${px.GUEST_BUNDLE}`],
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
      { name: 'SMOLVM_P', value: proxy && s.proxy.provision ? proxy.url : '' },
      { name: 'SMOLVM_NP', value: proxy ? proxy.noProxy : '' },
      { name: 'SMOLVM_CA', value: useCa ? '1' : '0' },
      { name: 'SMOLVM_REPLACE', value: s.ca.replaceSystemBundle ? '1' : '0' },
    ],
    user: '0', timeoutSecs: 60,
  });
  if (r.exitCode !== 0) throw new Error(`настройка гостя завершилась с кодом ${r.exitCode}: ${(r.stderr || r.stdout).slice(-400)}`);
  const active = proxy || useCa;
  cfg.setProvisioned(name, active ? provisionFingerprint(proxy, s) : null);
  return { configured: (r.stdout.match(/configured:(.*)/) || [])[1]?.trim() || '', ca: useCa };
}

// Env to inject into an exec in this machine.
async function execEnv(name) {
  const s = cfg.getSettings();
  const env = await secretEnv(name);
  if (s.proxy.exec) {
    const p = await effectiveProxy(name).catch(() => null);
    if (p) env.push(...px.proxyEnv(p.url, p.noProxy));
  }
  // Only point tools at the bundle once it exists in the guest.
  if (s.ca.enabled && cfg.getProvisioned(name) && cfg.machineUsesProxy(name)) env.push(...px.trustEnv());
  return env;
}

module.exports = { effectiveProxy, startPlan, startViaCli, pushCredentialValues, secretEnv, provision, execEnv, runCli, SMOLVM_BIN };
