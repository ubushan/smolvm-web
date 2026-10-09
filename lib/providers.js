'use strict';
// Map a machine's secrets onto the env each agent expects, so one DeepSeek
// (or Anthropic/OpenAI) secret serves Claude Code, OpenCode and DeepSeek Harness.
//
// Only gateway and env secrets can be aliased: a gateway secret contributes its
// per-machine token and the gateway base URL (the key itself never enters the
// machine), an env secret its plain value and the provider's public URL.

const vault = require('./vault');
const gateway = require('./gateway');

const PROVIDERS = {
  deepseek: { host: 'api.deepseek.com', env: 'DEEPSEEK_API_KEY', url: 'https://api.deepseek.com' },
  anthropic: { host: 'api.anthropic.com', env: 'ANTHROPIC_API_KEY', url: 'https://api.anthropic.com' },
  openai: { host: 'api.openai.com', env: 'OPENAI_API_KEY', url: 'https://api.openai.com/v1' },
  openrouter: { host: 'openrouter.ai', env: 'OPENROUTER_API_KEY', url: 'https://openrouter.ai/api/v1' },
};

function providerOf(secret) {
  let host = '';
  try { host = new URL(secret.upstream).hostname; } catch {}
  for (const [id, p] of Object.entries(PROVIDERS)) {
    if (host === p.host || secret.envVar === p.env) return id;
  }
  return null;
}

// { deepseek: { key, base }, anthropic: {...}, ... } for the machine's usable secrets.
async function credentials(machine) {
  const out = {};
  for (const s of await vault.machineSecrets(machine).catch(() => [])) {
    const id = providerOf(s);
    if (!id || out[id]) continue;
    if (s.mode === 'gateway' && s.token) {
      const gw = await gateway.baseUrl(s.name);
      // The gateway keeps the upstream path: /g/<secret>/... -> <upstream>/...
      const upPath = (() => { try { return new URL(s.upstream).pathname.replace(/\/+$/, ''); } catch { return ''; } })();
      out[id] = { key: s.token, base: gw, upPath, via: 'gateway', secret: s.name };
    } else if (s.mode === 'env') {
      out[id] = { key: s.value, base: PROVIDERS[id].url, upPath: '', via: 'env', secret: s.name };
    }
  }
  return out;
}

// Env aliases for all agents. Explicit secret env (DEEPSEEK_API_KEY etc.) is
// set elsewhere; this adds what other agents read for the same provider.
async function aliasEnv(machine) {
  const c = await credentials(machine);
  const env = [];
  const put = (name, value) => { if (value) env.push({ name, value }); };
  if (c.deepseek) {
    put('DEEPSEEK_API_KEY', c.deepseek.key);
    put('DEEPSEEK_BASE_URL', c.deepseek.base);
  }
  if (c.openai) { put('OPENAI_API_KEY', c.openai.key); put('OPENAI_BASE_URL', c.openai.base); }
  if (c.openrouter) { put('OPENROUTER_API_KEY', c.openrouter.key); put('OPENROUTER_BASE_URL', c.openrouter.base); }
  // Claude Code: Anthropic if present, otherwise DeepSeek's Anthropic-compatible API.
  if (c.anthropic) {
    put('ANTHROPIC_API_KEY', c.anthropic.key);
    put('ANTHROPIC_BASE_URL', c.anthropic.base);
  } else if (c.deepseek) {
    // Gateway base maps to https://api.deepseek.com, so /anthropic is the compatible endpoint.
    put('ANTHROPIC_BASE_URL', `${c.deepseek.base}${c.deepseek.upPath === '/anthropic' ? '' : '/anthropic'}`);
    put('ANTHROPIC_AUTH_TOKEN', c.deepseek.key);
    // Current DeepSeek ids (deepseek-chat is gone); the same default as dsh.
    put('ANTHROPIC_MODEL', 'deepseek-flash');
    put('ANTHROPIC_SMALL_FAST_MODEL', 'deepseek-flash');
    put('API_TIMEOUT_MS', '600000');
  }
  if (env.length) {
    put('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', '1');
    put('DISABLE_AUTOUPDATER', '1');
  }
  return env;
}

// A short human summary for the UI: which agent talks to which provider.
async function summary(machine) {
  const c = await credentials(machine);
  return {
    claude: c.anthropic ? `Anthropic (${c.anthropic.secret})` : c.deepseek ? `DeepSeek через Anthropic-совместимый API (${c.deepseek.secret})` : null,
    opencode: c.deepseek ? `DeepSeek (${c.deepseek.secret})` : c.anthropic ? `Anthropic (${c.anthropic.secret})` : c.openai ? `OpenAI (${c.openai.secret})` : c.openrouter ? `OpenRouter (${c.openrouter.secret})` : null,
    dsh: c.deepseek ? `DeepSeek (${c.deepseek.secret})` : null,
    providers: Object.keys(c),
  };
}

module.exports = { aliasEnv, credentials, summary, providerOf };
