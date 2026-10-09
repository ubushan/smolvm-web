'use strict';
// Agent profiles (Claude Code, OpenCode, DeepSeek Harness, Codex, Pi, Hermes)
// and running their UIs from the web interface.
//
// Inside the machine every agent runs as the unprivileged `node` user from a
// pidfile under ~/.smolvm-web, in its own session (setsid) so it can be stopped
// as a group. Terminal agents run behind ttyd (password), OpenCode web behind
// its server password, DeepSeek Harness behind its launch token. Each listens
// on a guest port published to 127.0.0.1 on the host, and the browser reaches
// it through a small host proxy (lib/agentproxy.js) that adds the credential.
//
// Each agent lists its vendor's servers (API, sign-in). Machines behind the
// egress filter may reach them by default; any of them can be revoked per
// machine, and the filter then blocks it at once.

const net = require('net');
const http = require('http');
const crypto = require('crypto');
const cfg = require('./config');
const up = require('./upstream');
const px = require('./proxy');
const providers = require('./providers');
const egress = require('./egress');

const AGENT_USER = 'node';
const WORKDIR = '/work';
const TTYD_VERSION = '1.7.7';
const enc = encodeURIComponent;

const TTYD_THEME = JSON.stringify({ background: '#0b0b0e', foreground: '#e4e4e7', cursor: '#a5b4fc', selectionBackground: '#3f3f46' });

// A vendor server an agent talks to directly (not through the secret gateway).
const V = (host, purpose) => ({ host, ports: '443', purpose });

const AGENTS = {
  terminal: {
    title: 'Терминал', mark: 'term', kind: 'tty', port: 7681, needs: 'ttyd',
    desc: 'Полноценный bash в /work с TTY',
    cmd: 'bash -l', vendor: [],
  },
  claude: {
    title: 'Claude Code', mark: 'claude', kind: 'tty', port: 7682, needs: 'claude', pkg: '@anthropic-ai/claude-code',
    desc: 'Агент Anthropic в терминале', cmd: 'claude', autonomous: 'claude --dangerously-skip-permissions',
    task: (auto) => `claude -p ${auto ? '--dangerously-skip-permissions ' : '--permission-mode acceptEdits '}"$SMOLVM_TASK"`,
    vendor: [V('api.anthropic.com', 'API Anthropic'), V('claude.ai', 'вход по подписке Claude'), V('console.anthropic.com', 'вход через Anthropic Console')],
  },
  opencode: {
    title: 'OpenCode', mark: 'opencode', kind: 'web', port: 4096, needs: 'opencode', pkg: 'opencode-ai',
    desc: 'Веб-интерфейс opencode', auth: 'opencode',
    task: () => 'opencode run "$SMOLVM_TASK"',
    vendor: [V('opencode.ai', 'OpenCode Zen, вход и обновления'), V('models.dev', 'каталог моделей')],
  },
  'opencode-tui': {
    title: 'OpenCode TUI', mark: 'opencode', kind: 'tty', port: 7683, needs: 'opencode', pkg: 'opencode-ai',
    desc: 'opencode в терминале', cmd: 'opencode',
    vendor: [V('opencode.ai', 'OpenCode Zen, вход и обновления'), V('models.dev', 'каталог моделей')],
  },
  dsh: {
    title: 'DeepSeek Harness', mark: 'dsh', kind: 'web', port: 3081, needs: 'dsh', pkg: '@deepseek-ai/dsh',
    desc: 'Веб-интерфейс dsh (порт пробрасывается на хост)', auth: 'token',
    task: () => 'dsh headless "$SMOLVM_TASK"',
    vendor: [V('api.deepseek.com', 'API DeepSeek')],
  },
  codex: {
    title: 'Codex', mark: 'codex', kind: 'tty', port: 7684, needs: 'codex', pkg: '@openai/codex',
    desc: 'Агент OpenAI в терминале', cmd: 'codex', autonomous: 'codex --dangerously-bypass-approvals-and-sandbox',
    task: (auto) => `codex exec --skip-git-repo-check ${auto ? '--dangerously-bypass-approvals-and-sandbox' : '--sandbox workspace-write'} "$SMOLVM_TASK"`,
    vendor: [V('api.openai.com', 'API OpenAI'), V('auth.openai.com', 'вход через аккаунт OpenAI'), V('chatgpt.com', 'вход по подписке ChatGPT')],
  },
  pi: {
    title: 'Pi', mark: 'pi', kind: 'tty', port: 7685, needs: 'pi', pkg: '@earendil-works/pi-coding-agent',
    desc: 'Минималистичный агент pi в терминале', cmd: 'pi',
    task: () => 'pi -p "$SMOLVM_TASK"',
    vendor: [V('pi.dev', 'каталог моделей, вход (/login) и обновления')],
  },
  hermes: {
    title: 'Hermes', mark: 'hermes', kind: 'tty', port: 7686, needs: 'hermes', installer: 'hermes',
    desc: 'Hermes Agent (Nous Research) в терминале', cmd: 'hermes', autonomous: 'hermes --yolo',
    task: () => 'hermes -z "$SMOLVM_TASK"',
    vendor: [V('inference-api.nousresearch.com', 'API Nous Portal'), V('portal.nousresearch.com', 'вход в Nous Portal'), V('hermes-agent.nousresearch.com', 'обновления')],
  },
};
const CLI_BINS = ['ttyd', 'claude', 'opencode', 'dsh', 'codex', 'pi', 'hermes'];

const BASE = { image: 'node:22-bookworm-slim', cpus: 2, memoryMb: 4096, storageGb: 20 };
const COMMON_EGRESS = [
  ['deb.debian.org', '443,80'], ['security.debian.org', '443,80'], ['registry.npmjs.org', '443'],
  ['github.com', '443'], ['.githubusercontent.com', '443'],
];
// What the Hermes installer fetches (uv, Python, wheels).
const HERMES_EGRESS = [['hermes-agent.nousresearch.com', '443'], ['hermes-assets.nousresearch.com', '443'], ['pypi.org', '443'], ['files.pythonhosted.org', '443']];
const PROFILES = {
  'claude-code': {
    ...BASE, title: 'Claude Code', mark: 'claude', agents: ['terminal', 'claude'], keys: ['anthropic', 'deepseek'],
    desc: 'Claude Code + веб-терминал. Ключ Anthropic или DeepSeek из «Секретов».', egress: [],
  },
  opencode: {
    ...BASE, title: 'OpenCode', mark: 'opencode', agents: ['terminal', 'opencode', 'opencode-tui'], keys: ['deepseek', 'anthropic', 'openai', 'openrouter'],
    desc: 'opencode: веб-интерфейс и TUI. Провайдер — из «Секретов».', egress: [],
  },
  dsh: {
    ...BASE, title: 'DeepSeek Harness', mark: 'dsh', agents: ['terminal', 'dsh'], keys: ['deepseek'],
    desc: 'dsh web с пробросом порта. Ключ DeepSeek из «Секретов».', egress: [],
  },
  codex: {
    ...BASE, title: 'Codex', mark: 'codex', agents: ['terminal', 'codex'], keys: ['openai'],
    desc: 'Codex CLI + веб-терминал. Ключ OpenAI из «Секретов» или вход через ChatGPT.', egress: [],
  },
  pi: {
    ...BASE, title: 'Pi', mark: 'pi', agents: ['terminal', 'pi'], keys: ['deepseek', 'anthropic', 'openai'],
    desc: 'pi — минималистичный агент. Ключ DeepSeek, Anthropic или OpenAI из «Секретов».', egress: [],
  },
  hermes: {
    ...BASE, title: 'Hermes', mark: 'hermes', agents: ['terminal', 'hermes'], keys: ['deepseek', 'anthropic', 'openrouter', 'openai'],
    desc: 'Hermes Agent от Nous Research. Ключ DeepSeek, Anthropic, OpenRouter или OpenAI из «Секретов».', egress: HERMES_EGRESS,
  },
  all: {
    ...BASE, memoryMb: 8192, title: 'Все агенты', mark: 'all', agents: Object.keys(AGENTS), keys: ['deepseek', 'anthropic', 'openai'],
    desc: 'Claude Code, OpenCode, DeepSeek Harness, Codex, Pi и Hermes в одной машине.', egress: HERMES_EGRESS,
  },
};

// ---------- persistent state ----------
// machines[name] = { profile, agents: [id], ports: {id: hostPort}, pw: {id: secret}, installed, installedAt }
const store = cfg.doc('agents.json', { machines: {} });
const M = (name) => store.get().machines[name];
function setM(name, patch) {
  const s = store.get();
  s.machines[name] = { ...(s.machines[name] || { agents: [], ports: {}, pw: {} }), ...patch };
  store.save(s);
  return s.machines[name];
}
function forget(name) {
  const s = store.get();
  if (s.machines[name]) { delete s.machines[name]; store.save(s); }
  jobs.delete(name);
}

// ---------- ports ----------
function canBind(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

async function usedHostPorts() {
  const used = new Set();
  const r = await up.request('GET', '/api/v1/machines').catch(() => null);
  for (const m of r?.data?.machines || []) for (const p of m.ports || []) used.add(p.host);
  for (const m of Object.values(store.get().machines)) for (const p of Object.values(m.ports || {})) used.add(p);
  return used;
}

async function allocatePorts(ids, start = 20100) {
  const used = await usedHostPorts();
  const out = {};
  let p = start;
  for (const id of ids) {
    while (used.has(p) || !(await canBind(p)) || !(await canBind(p + 10000))) p++;
    out[id] = p; used.add(p); p++;
  }
  return out;
}

// Declare agents for a machine (at create, or later from the Agents tab) and
// return the port mappings smolvm needs.
async function declare(name, agentIds, profile) {
  const cur = M(name) || { agents: [], ports: {}, pw: {} };
  const ids = [...new Set([...(cur.agents || []), ...agentIds])].filter((id) => AGENTS[id]);
  const missing = ids.filter((id) => !cur.ports?.[id]);
  const ports = { ...(cur.ports || {}), ...(await allocatePorts(missing)) };
  const pw = { ...(cur.pw || {}) };
  for (const id of ids) if (!pw[id]) pw[id] = crypto.randomBytes(18).toString('base64url');
  setM(name, { profile: profile || cur.profile || null, agents: ids, ports, pw });
  return ids.map((id) => ({ host: ports[id], guest: AGENTS[id].port }));
}

// Ports the machine still lacks; applied with `machine update` while stopped.
async function missingPorts(name, machineInfo) {
  const m = M(name);
  if (!m) return [];
  const have = new Set((machineInfo?.ports || []).map((p) => `${p.host}:${p.guest}`));
  return m.agents.filter((id) => m.ports[id] && !have.has(`${m.ports[id]}:${AGENTS[id].port}`))
    .map((id) => ({ host: m.ports[id], guest: AGENTS[id].port }));
}

// ---------- guest helpers ----------
async function guestExec(name, script, { user = AGENT_USER, env = [], timeoutSecs = 60, stdin } = {}) {
  const body = { command: ['bash', '-c', script], user, env, timeoutSecs };
  if (stdin != null) body.stdin = stdin;
  return up.exec(name, body, (timeoutSecs + 15) * 1000);
}

const sq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

// ---------- install ----------
const jobs = new Map(); // name -> { status, step, log, startedAt, finishedAt, error }

function installScript(pkgs, { hermes = false } = {}) {
  return `set -e
step() { echo "::step::$1"; }
export DEBIAN_FRONTEND=noninteractive
command -v node >/dev/null || { echo "В образе нет Node.js — выберите образ node:22-bookworm-slim"; exit 3; }
step "Системные пакеты"
need=""
for c in curl git rg ps; do command -v $c >/dev/null || need=1; done
if [ -n "$need" ]; then
  if command -v apt-get >/dev/null; then
    apt-get update -qq && apt-get install -y -qq --no-install-recommends curl ca-certificates git ripgrep procps less xz-utils >/dev/null
  elif command -v apk >/dev/null; then
    apk add -q curl ca-certificates git ripgrep procps bash less ttyd libgcc libstdc++
  fi
fi
step "Пользователь ${AGENT_USER} и ${WORKDIR}"
id ${AGENT_USER} >/dev/null 2>&1 || useradd -m -u 1000 -s /bin/bash ${AGENT_USER} 2>/dev/null || adduser -D -u 1000 -s /bin/bash ${AGENT_USER}
mkdir -p ${WORKDIR} && chown ${AGENT_USER}: ${WORKDIR}
step "Веб-терминал ttyd"
if ! command -v ttyd >/dev/null; then
  curl -fsSL --retry 3 -o /usr/local/bin/ttyd.part "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.$(uname -m)"
  chmod +x /usr/local/bin/ttyd.part && mv /usr/local/bin/ttyd.part /usr/local/bin/ttyd
fi
ttyd --version
${pkgs.length ? `step "npm: ${pkgs.join(' ')}"
npm install -g --no-fund --no-audit --loglevel=error ${pkgs.join(' ')}` : ''}
${hermes ? `step "Hermes Agent"
if [ ! -x /home/${AGENT_USER}/.local/bin/hermes ]; then
  runuser -u ${AGENT_USER} -- env HOME=/home/${AGENT_USER} bash -c 'curl -fsSL --retry 3 https://hermes-agent.nousresearch.com/install.sh | bash -s -- --non-interactive --skip-browser --skip-computer-use'
fi
ln -sf /home/${AGENT_USER}/.local/bin/hermes /usr/local/bin/hermes` : ''}
step "Проверка"
for c in ${CLI_BINS.join(' ')}; do command -v $c >/dev/null && echo "$c: $($c --version 2>/dev/null | head -1)"; done
step "Готово"
`;
}

function startInstall(name, agentIds) {
  const cur = jobs.get(name);
  if (cur?.status === 'running') return cur;
  const m = M(name);
  const ids = agentIds?.length ? agentIds : m?.agents || ['terminal'];
  const pkgs = [...new Set(ids.map((id) => AGENTS[id]?.pkg).filter(Boolean))];
  const hermes = ids.some((id) => AGENTS[id]?.installer === 'hermes');
  const job = { status: 'running', step: 'Подготовка', log: '', startedAt: Date.now(), agents: ids };
  jobs.set(name, job);
  const append = (s) => { job.log = (job.log + s).slice(-200000); };
  (async () => {
    try {
      await up.waitReady(name, 90000);
      const env = await require('./machines').execEnv(name);
      const res = await new Promise((resolve, reject) => {
        const payload = Buffer.from(JSON.stringify({ command: ['bash', '-c', installScript(pkgs, { hermes })], env, user: '0', timeoutSecs: 1800 }));
        const req = http.request({ ...up.target(), method: 'POST', path: `/api/v1/machines/${enc(name)}/exec/stream`,
          headers: { host: 'localhost', 'content-type': 'application/json', 'content-length': payload.length } }, (r) => {
          if (r.statusCode !== 200) {
            let t = ''; r.on('data', (d) => { t += d; }); r.on('end', () => reject(new Error(`exec: HTTP ${r.statusCode} ${t.slice(0, 300)}`)));
            return;
          }
          let buf = ''; let code = null;
          r.setEncoding('utf8');
          r.on('data', (chunk) => {
            buf += chunk;
            let i;
            while ((i = buf.indexOf('\n\n')) !== -1) {
              const raw = buf.slice(0, i); buf = buf.slice(i + 2);
              let ev = 'message'; const data = [];
              for (const line of raw.split('\n')) {
                if (line.startsWith('event:')) ev = line.slice(6).trim();
                else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
              }
              const d = data.join('\n');
              if (ev === 'stdout' || ev === 'stderr') {
                for (const l of d.replace(/\n$/, '').split('\n')) {
                  const st = l.match(/^::step::(.*)$/);
                  if (st) { job.step = st[1]; append(`▸ ${st[1]}\n`); } else append(`${l}\n`);
                }
              } else if (ev === 'exit') { try { code = JSON.parse(d).exitCode; } catch {} }
              else if (ev === 'error') append(`error: ${d}\n`);
            }
          });
          r.on('end', () => resolve(code));
          r.on('error', reject);
        });
        req.on('error', reject);
        req.end(payload);
      });
      if (res !== 0) throw new Error(`установка завершилась с кодом ${res}`);
      job.status = 'ok';
      setM(name, { installed: true, installedAt: Date.now() });
    } catch (e) {
      job.status = 'error'; job.error = e.message; append(`\n✗ ${e.message}\n`);
    } finally {
      job.finishedAt = Date.now();
    }
  })();
  return job;
}

// ---------- status ----------
async function status(name) {
  const m = M(name);
  const job = jobs.get(name) || null;
  const info = await up.request('GET', `/api/v1/machines/${enc(name)}`).catch(() => null);
  const running = info?.data?.state === 'running';
  const ids = m?.agents || [];
  const missing = await missingPorts(name, info?.data);
  let guest = {};
  if (running && ids.length) {
    const script = `D=$HOME/.smolvm-web/run; for a in ${ids.join(' ')}; do
      p=""; [ -f "$D/$a.pid" ] && kill -0 "$(cat "$D/$a.pid")" 2>/dev/null && p=1
      echo "$a ${'$'}{p:-0}"; done
      for c in ${CLI_BINS.join(' ')}; do command -v $c >/dev/null && echo "has $c"; done; true`;
    try {
      const r = await guestExec(name, script, { timeoutSecs: 20 });
      for (const line of r.stdout.split('\n')) {
        const [a, b] = line.trim().split(' ');
        if (a === 'has') guest[`has:${b}`] = true;
        else if (a && b) guest[a] = b === '1';
      }
    } catch (e) { guest.error = e.message; }
  }
  const prov = await providers.summary(name).catch(() => ({}));
  return {
    profile: m?.profile || null,
    profileTitle: PROFILES[m?.profile]?.title || null,
    machineRunning: running,
    installed: !!m?.installed,
    job: job && { status: job.status, step: job.step, log: job.log.slice(-20000), error: job.error, startedAt: job.startedAt, finishedAt: job.finishedAt },
    missingPorts: missing,
    providers: prov,
    error: guest.error,
    agents: ids.map((id) => {
      const a = AGENTS[id];
      return {
        id, title: a.title, mark: a.mark, kind: a.kind, desc: a.desc, guestPort: a.port, hostPort: m.ports[id],
        portReady: !missing.some((p) => p.guest === a.port),
        installed: !!guest[`has:${a.needs}`] && !!guest['has:ttyd'],
        running: !!guest[id],
        task: !!a.task,
        autonomous: !!a.autonomous,
        provider: prov[id === 'opencode-tui' ? 'opencode' : id] || null,
      };
    }),
    available: Object.entries(AGENTS).filter(([id]) => !ids.includes(id)).map(([id, a]) => ({ id, title: a.title, desc: a.desc })),
    vendor: vendorEndpoints(name),
    filter: { enabled: !!egress.getMachine(name)?.enabled },
  };
}

// ---------- vendor servers ----------
// The vendor servers of the machine's agents, one entry per host.
function vendorEndpoints(name) {
  const m = M(name);
  if (!m) return [];
  const revoked = new Set(m.revoked || []);
  const map = new Map();
  for (const id of m.agents || []) {
    for (const v of AGENTS[id]?.vendor || []) {
      const cur = map.get(v.host) || { host: v.host, ports: v.ports, purpose: v.purpose, agents: [], revoked: revoked.has(v.host) };
      if (!cur.agents.includes(AGENTS[id].title.replace(/ TUI$/, ''))) cur.agents.push(AGENTS[id].title.replace(/ TUI$/, ''));
      map.set(v.host, cur);
    }
  }
  return [...map.values()];
}

function setVendor(name, host, allowed) {
  const m = M(name);
  if (!m) throw new Error('к машине не подключены агенты');
  if (!vendorEndpoints(name).some((v) => v.host === host)) throw new Error(`${host} — не сервер вендора агентов этой машины`);
  const revoked = new Set(m.revoked || []);
  if (allowed) revoked.delete(host); else revoked.add(host);
  setM(name, { revoked: [...revoked] });
  return vendorEndpoints(name);
}

// Allowed vendor servers become filter rules of the machine, live.
egress.setExtraRules((name) => vendorEndpoints(name).filter((v) => !v.revoked)
  .map((v) => ({ host: v.host, ports: v.ports, source: `сервер вендора: ${v.agents.join(', ')}` })));

// ---------- launch ----------
async function agentEnv(name, id) {
  const env = await require('./machines').execEnv(name);
  const extra = [{ name: 'SMOLVM_AGENT_PW', value: M(name).pw[id] }, { name: 'HOME', value: `/home/${AGENT_USER}` }, { name: 'TERM', value: 'xterm-256color' },
    { name: 'PATH', value: `/home/${AGENT_USER}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin` },
    { name: 'PI_SKIP_VERSION_CHECK', value: '1' }, { name: 'PI_TELEMETRY', value: '0' }];
  if (id === 'dsh') {
    // dsh speaks DeepSeek's Anthropic-compatible protocol at $DEEPSEEK_BASE_URL.
    const base = env.find((e) => e.name === 'DEEPSEEK_BASE_URL');
    if (base) extra.push({ name: 'DEEPSEEK_BASE_URL', value: `${base.value.replace(/\/+$/, '')}/anthropic` });
  }
  if (id === 'opencode') extra.push({ name: 'OPENCODE_SERVER_PASSWORD', value: M(name).pw[id] }, { name: 'OPENCODE_SERVER_USERNAME', value: 'opencode' });
  // Later entries win.
  const map = new Map(env.map((e) => [e.name, e.value]));
  for (const e of extra) map.set(e.name, e.value);
  return [...map].map(([n, v]) => ({ name: n, value: v }));
}

// First-run config so agents start without interactive onboarding.
function configScript(id, provs) {
  if (id === 'claude' || id === 'terminal') {
    // Merge into ~/.claude.json: skip onboarding, trust /work, approve the gateway token.
    return `node -e '
const fs=require("fs");const f=process.env.HOME+"/.claude.json";let c={};
try{c=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}
c.hasCompletedOnboarding=true;c.theme=c.theme||"dark";
c.projects=c.projects||{};c.projects["${WORKDIR}"]={...(c.projects["${WORKDIR}"]||{}),hasTrustDialogAccepted:true};
const k=process.env.ANTHROPIC_API_KEY||"";
if(k){c.customApiKeyResponses=c.customApiKeyResponses||{approved:[],rejected:[]};if(!c.customApiKeyResponses.approved.includes(k.slice(-20)))c.customApiKeyResponses.approved.push(k.slice(-20))}
fs.writeFileSync(f,JSON.stringify(c,null,2));'`;
  }
  if (id === 'opencode' || id === 'opencode-tui') {
    const prov = {};
    let model = null;
    if (provs.includes('deepseek')) { prov.deepseek = { options: { baseURL: '{env:DEEPSEEK_BASE_URL}' } }; model = 'deepseek/deepseek-flash'; }
    if (provs.includes('anthropic')) { prov.anthropic = { options: { baseURL: '{env:ANTHROPIC_BASE_URL}' } }; model = model || 'anthropic/claude-sonnet-4-5'; }
    if (provs.includes('openai')) { prov.openai = { options: { baseURL: '{env:OPENAI_BASE_URL}' } }; model = model || 'openai/gpt-4.1'; }
    if (provs.includes('openrouter')) { prov.openrouter = { options: { baseURL: '{env:OPENROUTER_BASE_URL}' } }; }
    if (!Object.keys(prov).length) return 'true';
    const conf = JSON.stringify({ $schema: 'https://opencode.ai/config.json', ...(model ? { model } : {}), provider: prov, autoupdate: false }, null, 2);
    // Our own older config pointed at the retired deepseek-chat id: replace it.
    return `mkdir -p ~/.config/opencode; grep -qs '"deepseek/deepseek-chat"' ~/.config/opencode/opencode.json && rm -f ~/.config/opencode/opencode.json; [ -f ~/.config/opencode/opencode.json ] || printf '%s' ${sq(conf)} > ~/.config/opencode/opencode.json`;
  }
  if (id === 'codex') {
    // Codex speaks the Responses API: an OpenAI key through the gateway, else the user signs in (ChatGPT).
    // The file is ours while it carries the marker line; a user-written config is left alone.
    const trust = `[projects."${WORKDIR}"]\ntrust_level = "trusted"\n`;
    return `mkdir -p ~/.codex; f=~/.codex/config.toml
if [ ! -f "$f" ] || grep -qs '^# smolvm-web' "$f"; then
  if [ -n "$OPENAI_API_KEY" ] && [ -n "$OPENAI_BASE_URL" ]; then
    printf '# smolvm-web\nmodel_provider = "smolvm"\n\n[model_providers.smolvm]\nname = "OpenAI (smolvm-web)"\nbase_url = "%s"\nenv_key = "OPENAI_API_KEY"\nwire_api = "responses"\n\n${trust}' "$OPENAI_BASE_URL" > "$f"
  else
    printf '# smolvm-web\n${trust}' > "$f"
  fi
fi`;
  }
  if (id === 'pi') {
    // Point pi's built-in providers at the gateway; pick the default provider once.
    return `mkdir -p ~/.pi/agent; cd ~/.pi/agent
if [ ! -f models.json ] || [ -f .smolvm-models ]; then node -e '
const e=process.env,p={};
if(e.DEEPSEEK_API_KEY&&e.DEEPSEEK_BASE_URL)p.deepseek={baseUrl:e.DEEPSEEK_BASE_URL};
if(e.ANTHROPIC_API_KEY&&e.ANTHROPIC_BASE_URL)p.anthropic={baseUrl:e.ANTHROPIC_BASE_URL};
if(e.OPENAI_API_KEY&&e.OPENAI_BASE_URL)p.openai={baseUrl:e.OPENAI_BASE_URL};
require("fs").writeFileSync("models.json",JSON.stringify({providers:p},null,2));' && touch .smolvm-models; fi
${provs.length ? `[ -f settings.json ] || printf '{"defaultProvider": "%s"}' ${sq(['deepseek', 'anthropic', 'openai'].find((x) => provs.includes(x)) || provs[0])} > settings.json` : 'true'}; cd - >/dev/null`;
  }
  if (id === 'hermes') {
    // Hermes reads provider keys and *_BASE_URL from the environment; choose the provider once.
    const pick = ['deepseek', 'anthropic', 'openrouter', 'openai'].find((x) => provs.includes(x));
    if (!pick) return 'true';
    const hp = pick === 'openai' ? 'openai-api' : pick;
    return `mkdir -p ~/.smolvm-web; [ -f ~/.smolvm-web/hermes-provider ] || { hermes config set model.provider ${hp} >/dev/null 2>&1 && echo ${hp} > ~/.smolvm-web/hermes-provider; }; true`;
  }
  return 'true';
}

function launcher(id, { autonomous } = {}) {
  const a = AGENTS[id];
  if (a.kind === 'tty') {
    const cmd = autonomous && a.autonomous ? a.autonomous : a.cmd;
    return `exec ttyd -W -p ${a.port} -c "web:$SMOLVM_AGENT_PW" -t fontSize=13 -t ${sq(`theme=${TTYD_THEME}`)} -t disableLeaveAlert=true -t ${sq(`titleFixed=${a.title}`)} bash -lc ${sq(`cd ${WORKDIR}; exec ${cmd}`)}`;
  }
  if (id === 'opencode') return `exec opencode web --hostname 0.0.0.0 --port ${a.port}`;
  if (id === 'dsh') {
    // dsh refuses non-loopback binds; relay the guest port to its loopback listener.
    const relay = `const n=require("net");n.createServer(c=>{const u=n.connect(3080,"127.0.0.1");c.pipe(u).pipe(c);u.on("error",()=>c.destroy());c.on("error",()=>u.destroy())}).listen(${a.port},"0.0.0.0")`;
    return `node -e ${sq(relay)} & exec dsh --profile web --host 127.0.0.1 --port 3080 --no-open --trusted-host 127.0.0.1 --trusted-host localhost`;
  }
  throw new Error(`неизвестный агент ${id}`);
}

async function waitHttp(port, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const r = http.get({ host: '127.0.0.1', port, path: '/', timeout: 3000 }, (res) => { res.resume(); resolve(true); });
      r.on('error', () => resolve(false));
      r.on('timeout', () => { r.destroy(); resolve(false); });
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function start(name, id, opts = {}) {
  const m = M(name);
  if (!m || !m.agents.includes(id)) throw new Error('агент не подключён к машине');
  const a = AGENTS[id];
  const env = await agentEnv(name, id);
  const provs = (await providers.summary(name).catch(() => ({}))).providers || [];
  const script = `set -e
D=$HOME/.smolvm-web; mkdir -p "$D/log" "$D/run"
if [ -f "$D/run/${id}.pid" ] && kill -0 "$(cat "$D/run/${id}.pid")" 2>/dev/null; then echo already; exit 0; fi
${configScript(id, provs)}
cd ${WORKDIR} 2>/dev/null || cd
nohup setsid bash -c ${sq(launcher(id, opts))} > "$D/log/${id}.log" 2>&1 < /dev/null &
echo $! > "$D/run/${id}.pid"
echo started`;
  const r = await guestExec(name, script, { env, timeoutSecs: 30 });
  if (r.exitCode !== 0) throw new Error((r.stderr || r.stdout).trim().slice(-400) || `exit ${r.exitCode}`);
  if (!(await waitHttp(m.ports[id]))) {
    const log = await logTail(name, id).catch(() => '');
    throw new Error(`${a.title} не ответил на порту ${m.ports[id]}.\n${log.slice(-600)}`);
  }
  return open(name, id);
}

async function logTail(name, id, bytes = 4000) {
  const r = await guestExec(name, `tail -c ${bytes} "$HOME/.smolvm-web/log/${id}.log" 2>/dev/null || true`, { timeoutSecs: 15 });
  return r.stdout;
}

async function stop(name, id) {
  const r = await guestExec(name, `P=$HOME/.smolvm-web/run/${id}.pid; [ -f "$P" ] || exit 0
pid=$(cat "$P"); kill -TERM -- -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
for i in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep .3; done
kill -KILL -- -"$pid" 2>/dev/null || true; rm -f "$P"`, { timeoutSecs: 20 });
  if (r.exitCode !== 0) throw new Error(r.stderr || `exit ${r.exitCode}`);
}

// Where the browser should go: a host proxy URL with the credential handled.
async function open(name, id) {
  const m = M(name);
  const a = AGENTS[id];
  const proxy = await require('./agentproxy').ensure(`${name}/${id}`, {
    target: m.ports[id],
    preferPort: m.ports[id] + 10000,
    auth: a.auth === 'token' ? null : `Basic ${Buffer.from(`${a.auth === 'opencode' ? 'opencode' : 'web'}:${m.pw[id]}`).toString('base64')}`,
  });
  let path = '/';
  if (a.auth === 'token') {
    const log = await logTail(name, id, 20000);
    const t = [...log.matchAll(/[?&]token=([A-Za-z0-9_-]+)/g)].pop();
    if (t) path = `/?token=${t[1]}`;
  }
  return { url: `http://127.0.0.1:${proxy.port}${path}`, base: `http://127.0.0.1:${proxy.port}/` };
}

// Body for a headless one-shot task, streamed through exec/stream.
async function taskBody(name, id, prompt, { autonomous } = {}) {
  const a = AGENTS[id];
  if (!a?.task) throw new Error('у агента нет режима задачи');
  const env = await agentEnv(name, id);
  env.push({ name: 'SMOLVM_TASK', value: String(prompt) });
  const provs = (await providers.summary(name).catch(() => ({}))).providers || [];
  return {
    command: ['bash', '-lc', `${configScript(id, provs)}; cd ${WORKDIR} 2>/dev/null || cd; ${a.task(autonomous)} < /dev/null`],
    env, user: AGENT_USER, timeoutSecs: 3600,
  };
}

module.exports = {
  AGENTS, PROFILES, AGENT_USER, WORKDIR,
  profiles: () => Object.entries(PROFILES).map(([id, p]) => ({
    id, title: p.title, mark: p.mark, desc: p.desc, image: p.image, cpus: p.cpus, memoryMb: p.memoryMb,
    agents: p.agents.map((a) => ({ id: a, title: AGENTS[a].title })), keys: p.keys || [],
    vendor: [...new Map(p.agents.flatMap((a) => AGENTS[a].vendor).map((v) => [v.host, v])).values()],
    egress: [...COMMON_EGRESS, ...p.egress].map(([host, ports]) => ({ host, ports })),
  })),
  egressRules: (profile) => [...COMMON_EGRESS, ...(PROFILES[profile]?.egress || [])]
    .map(([host, ports]) => ({ host, ports, note: `профиль ${PROFILES[profile]?.title || ''}`.trim(), enabled: true })),
  get: M, declare, missingPorts, forget, startInstall, status, start, stop, open, taskBody, logTail, vendorEndpoints, setVendor,
  job: (name) => jobs.get(name),
  _internal: { configScript, installScript, launcher },
  runningJobs: () => [...jobs].filter(([, j]) => j.status === 'running').map(([n, j]) => ({ name: n, step: j.step })),
};
