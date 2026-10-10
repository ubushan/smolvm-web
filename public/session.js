'use strict';
// Page «Сеанс» (#/session?name=…): one open sandbox as a work screen —
// the open sessions on the left, the agent and what it did in the middle,
// what came from the profile and what «Закрыть» would take back on the right.

(() => {
  let root = null;
  let name = '';
  let data = null;      // GET /ui/sandbox
  let isolated = {};    // GET /ui/live
  let net = [];         // egress log of this machine
  let events = [];      // audit of this machine
  let preview = null;   // { changes, skipped } | { error } | 'loading'
  let timer = null;
  let lastSig = '';

  const AGENTS = { terminal: 'Терминал', claude: 'Claude Code', opencode: 'OpenCode', 'opencode-tui': 'OpenCode TUI', dsh: 'Harness', codex: 'Codex', pi: 'Pi', hermes: 'Hermes' };
  const left = (ts) => {
    const m = Math.max(0, Math.round((ts - Date.now()) / 60000));
    return m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч ${m % 60} мин`;
  };
  const minutes = (ms) => {
    const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
    return m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч ${m % 60} мин`;
  };
  const sbx = () => data?.sandboxes.find((x) => x.name === name) || null;
  const tplOf = (id) => data.templates.find((t) => t.id === id) || null;
  const profOf = (id) => data.profiles.find((p) => p.id === id) || null;
  const risky = (p) => /claude-mcp\.json$|settings\.json$|opencode\.json$|config\.toml$|config\.yaml$|\/(skills|hooks|agents|commands|plugin|extensions)\//.test(p);

  async function load() {
    const [d, live] = await Promise.all([api('GET', '/ui/sandbox'), api('GET', '/ui/live').catch(() => ({}))]);
    data = d; isolated = live.isolated || {};
    if (!name || !sbx()) name = data.sandboxes[0]?.name || '';
    if (!name) { net = []; events = []; return; }
    const since = sbx().createdAt;
    const [lg, au] = await Promise.all([
      api('GET', `/ui/egress/log?machine=${enc(name)}&limit=1000`).catch(() => ({ entries: [] })),
      api('GET', `/ui/audit?machine=${enc(name)}&limit=60`).catch(() => ({ entries: [] })),
    ]);
    net = (lg.entries || []).filter((e) => new Date(e.ts).getTime() >= since);
    events = (au.entries || []).filter((e) => new Date(e.ts).getTime() >= since - 60000);
  }

  // ---------- actions ----------
  async function openAgent(x, id) {
    const w = agentTab();
    try { goAgent(w, (await api('POST', `/ui/machines/${enc(x.name)}/agents/${enc(id)}/start`, {})).url); }
    catch (e) { if (w) w.close(); toast(e.message, 'err'); }
  }
  async function close(x, keep) {
    if (!keep) {
      const c = await confirmDialog('Закрыть без сохранения?', `Машина ${x.name} будет удалена${x.profile ? ', изменения профиля потеряются' : ''}.`, false, '', 'Закрыть');
      if (!c.ok) return;
    }
    try {
      const r = await api('POST', `/ui/sandbox/machines/${enc(x.name)}/close`, { save: keep });
      refreshMachines();
      if (r.pending) { toast(`Песочница закрыта. Изменений профиля: ${r.changes} — проверьте их`, 'ok', 8000); location.hash = `#/review?id=${enc(r.pending)}`; return; }
      toast(r.applied ? `Песочница закрыта, в профиль сохранено изменений: ${r.applied}` : 'Песочница закрыта', 'ok');
    } catch (e) { toast(e.message, 'err', 12000); return; }
    name = '';
    await load(); render();
  }
  async function checkChanges() {
    preview = 'loading'; render();
    try { preview = await api('GET', `/ui/sandbox/machines/${enc(name)}/changes`); }
    catch (e) { preview = { error: e.message }; }
    render();
  }

  // ---------- render ----------
  function sidebar() {
    return h('aside', { class: 'ss-side' },
      h('button', { class: 'btn ss-new', onclick: () => { location.hash = '#/work'; } }, ic('plus'), 'Новая песочница'),
      h('div', { class: 'ss-side-title' }, 'Открыто'),
      ...data.sandboxes.map((x) => {
        const p = profOf(x.profile);
        return h('a', { class: `ss-item${x.name === name ? ' on' : ''}`, href: `#/session?name=${enc(x.name)}` },
          h('b', {}, p ? p.name : x.name),
          h('span', {}, [AGENTS[x.agent] || (p ? '' : 'разовая'), x.opening || minutes(x.createdAt)].filter(Boolean).join(' · ')));
      }),
      h('span', { class: 'spacer' }),
      h('a', { class: 'ss-side-link', href: '#/work' }, '← Рабочие места'));
  }

  function topbar(x) {
    const p = profOf(x.profile);
    const t = tplOf(x.template);
    const iso = isolated[x.name];
    const e = t?.egress;
    const mode = iso ? ['bad', 'Изолирована'] : !e?.enabled ? ['warn', 'Сеть: без ограничений'] : ['ok', 'Сеть: только разрешённое'];
    const machine = state.machines.find((m) => m.name === x.name) || { name: x.name };
    const pills = h('div', { class: 'ss-pills' },
      h('span', { class: `ss-pill ${mode[0]}` }, mode[1]),
      x.expiresAt ? h('span', { class: `ss-pill ${x.expiresAt - Date.now() < 30 * 60000 ? 'warn' : 'neutral'}`, title: `Закроется сама ${new Date(x.expiresAt).toLocaleString('ru-RU')}; изменения профиля уйдут на проверку` }, `осталось ${left(x.expiresAt)}`) : null,
      x.expiresAt ? h('button', { class: 'btn ghost small-btn', title: 'Продлить срок жизни песочницы на 2 часа', onclick: async () => {
        try { await api('POST', `/ui/sandbox/machines/${enc(x.name)}/extend`, { hours: 2 }); toast('Продлено на 2 часа', 'ok'); } catch (e) { toast(e.message, 'err'); }
        await load(); render();
      } }, '+2 ч') : null,
      x.idleMinutes ? h('span', { class: 'muted small' }, `закроется после ${x.idleMinutes} мин простоя`) : null);
    return h('div', { class: 'ss-top' },
      h('div', { class: 'ss-top-title' },
        h('b', {}, p ? p.name : x.name),
        h('span', { class: 'muted small' }, [AGENTS[x.agent] || null, `чистая машина из шаблона «${t?.title || x.template}»`, `открыта ${minutes(x.createdAt)} назад`].filter(Boolean).join(' · ')),
        pills),
      h('div', { class: 'ss-top-actions' },
        iso ? null : h('button', { class: 'btn danger-outline', disabled: x.state !== 'running', title: 'Kill switch: оборвать соединения, заменить токены шлюза, поставить машину на паузу', onclick: async () => { await actions.isolate(machine); await load(); render(); } }, ic('shield'), 'Изолировать'),
        x.profile ? h('button', { class: 'btn ghost', title: 'Удалить машину, профиль не трогать', onclick: () => close(x, false) }, 'Без сохранения') : null,
        h('button', { class: 'btn primary', disabled: !!x.opening, title: x.profile ? 'Забрать изменения профиля на проверку и удалить машину' : 'Удалить машину', onclick: () => close(x, !!x.profile) }, x.profile ? 'Сохранить и закрыть' : 'Закрыть')));
  }

  function centre(x) {
    const ids = x.agents.map((a) => a.id);
    const main = x.agent && ids.includes(x.agent) ? x.agent : ids.find((id) => id !== 'terminal') || ids[0];
    const agents = h('section', { class: 'ss-card ss-agent' },
      h('div', { class: 'ss-card-title' }, 'Агент'),
      main ? h('div', { class: 'ss-agent-main' },
        mark(x.agents.find((a) => a.id === main)?.mark || 'term'),
        h('div', { class: 'ss-agent-text' }, h('b', {}, AGENTS[main] || main), h('span', { class: 'muted small' }, 'Откроется в новой вкладке браузера')),
        h('button', { class: 'btn primary', disabled: x.state !== 'running' || !!x.opening || !!isolated[x.name], onclick: () => openAgent(x, main) }, 'Открыть агента'))
        : h('p', { class: 'muted' }, 'В этой машине нет агентов.'),
      ids.length > 1 ? h('div', { class: 'ss-agent-more' }, ...x.agents.filter((a) => a.id !== main).map((a) =>
        h('button', { class: 'btn small-btn', disabled: x.state !== 'running' || !!isolated[x.name], onclick: () => openAgent(x, a.id) }, mark(a.mark, true), a.title))) : null,
      h('div', { class: 'ss-agent-more' },
        h('button', { class: 'btn ghost small-btn', onclick: () => openFolderDialog({ machine: x.name, mode: 'review' }) }, ic('folder'), 'Дать папку'),
        h('a', { class: 'btn ghost small-btn', href: '#/', onclick: (ev) => { ev.preventDefault(); location.hash = '#/'; setTimeout(() => select(x.name), 0); } }, ic('server'), 'Машина: консоль, файлы, логи')));

    const feed = events.slice(0, 14).map((e) => h('div', { class: 'ss-ev' },
      h('span', { class: 'mono small muted' }, new Date(e.ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })),
      h('span', { class: e.type === 'alert' ? 'badc' : '' }, e.action, e.detail?.command ? h('code', {}, ` ${String(e.detail.command).slice(0, 80)}`) : null)));
    const activity = h('section', { class: 'ss-card ss-feed' },
      h('div', { class: 'ss-card-title' }, 'Что происходило', h('a', { class: 'small', href: `#/audit?machine=${enc(x.name)}` }, 'весь журнал')),
      feed.length ? feed : h('p', { class: 'muted small' }, 'Пока ничего. Действия агента внутри машины видны по сети и изменениям файлов.'));
    return h('div', { class: 'ss-centre' }, agents, activity);
  }

  function right(x) {
    const p = profOf(x.profile);
    const s = p?.summary;
    const loaded = h('section', { class: 'ss-card' },
      h('div', { class: 'ss-card-title' }, 'Загружено из профиля'),
      p ? h('div', { class: 'ss-list' },
        h('span', {}, s?.mcp?.length ? `MCP: ${s.mcp.join(', ')}` : 'MCP: нет'),
        h('span', {}, `${s?.skills || 0} skills${s?.instructions?.length ? ` · ${s.instructions.join(', ')}` : ''}`),
        h('span', {}, s?.memory ? `Память: ${s.memory}` : 'Памяти пока нет'))
        : h('p', { class: 'muted small' }, 'Разовая песочница — без профиля, при закрытии ничего не сохраняется.'));

    let changes = null;
    if (p) {
      let body;
      if (preview === 'loading') body = h('p', { class: 'muted small' }, h('i', { class: 'spin' }), ' Смотрю файлы профиля в машине…');
      else if (preview?.error) body = h('p', { class: 'small badc' }, preview.error);
      else if (preview) {
        body = preview.changes.length ? h('div', { class: 'ss-list' }, ...preview.changes.slice(0, 8).map((c) => h('span', { class: 'mono small' },
          { added: '+ ', modified: '~ ', deleted: '− ' }[c.kind], c.path.replace(/^\.smolvm-profile\/claude-mcp\.json$/, '~/.claude.json → mcpServers'),
          risky(c.path) && c.kind !== 'deleted' ? h('b', { class: 'warnc' }, ' · проверьте') : null)),
          preview.changes.length > 8 ? h('span', { class: 'muted small' }, `и ещё ${preview.changes.length - 8}`) : null)
          : h('p', { class: 'muted small' }, 'Профиль не изменился.');
      } else body = h('p', { class: 'muted small' }, 'Что агент поменял в своих настройках, памяти и skills.');
      changes = h('section', { class: 'ss-card' },
        h('div', { class: 'ss-card-title' }, 'Изменится при закрытии'), body,
        h('button', { class: 'btn small-btn', disabled: preview === 'loading' || x.state !== 'running', onclick: checkChanges }, preview && preview !== 'loading' ? 'Проверить снова' : 'Проверить сейчас'),
        h('span', { class: 'muted small' }, p.autoSave ? 'Ревью выключено: изменения сохранятся сразу.' : 'После закрытия — проверка по каждому файлу.'));
    }

    const allowed = net.filter((e) => e.allow).length;
    const denied = net.filter((e) => !e.allow);
    const hosts = [...new Set(denied.map((e) => `${e.host}:${e.port}`))];
    const network = h('section', { class: 'ss-card' },
      h('div', { class: 'ss-card-title' }, 'Сеть за сеанс', h('a', { class: 'small', href: `#/log?machine=${enc(x.name)}` }, 'журнал')),
      h('span', {}, `${allowed} разрешено · `, h('span', { class: denied.length ? 'badc' : '' }, `${denied.length} заблокировано`)),
      hosts.length ? h('div', { class: 'ss-list' }, ...hosts.slice(0, 4).map((hst) => h('span', { class: 'mono small' }, hst))) : null);
    return h('div', { class: 'ss-right' }, loaded, changes, network);
  }

  function render() {
    if (!root || !data) return;
    const x = sbx();
    if (!x) {
      fill(root, h('section', { class: 'card ws-empty' }, ic('box'), h('h3', {}, 'Открытых песочниц нет'),
        h('p', { class: 'muted' }, 'Откройте рабочее место или разовую песочницу.'),
        h('a', { class: 'btn primary', href: '#/work' }, 'К рабочим местам')));
      return;
    }
    if (location.hash !== `#/session?name=${enc(x.name)}`) history.replaceState(null, '', `#/session?name=${enc(x.name)}`);
    fill(root, h('div', { class: 'ss-wrap' }, sidebar(), h('div', { class: 'ss-main' }, topbar(x), h('div', { class: 'ss-body' }, centre(x), right(x)))));
  }

  async function poll() {
    if (!root || document.hidden) return;
    try { await load(); } catch { return; }
    const x = sbx();
    const sig = JSON.stringify([name, data.sandboxes.map((y) => [y.name, y.state, y.opening, Math.floor((Date.now() - y.createdAt) / 60000)]), Object.keys(isolated), net.length, events.length, data.profiles.map((p) => p.updatedAt)]);
    if (sig === lastSig || !x) return;
    lastSig = sig;
    render();
  }

  pages.session = {
    render(el, p) {
      root = el; name = p.get('name') || ''; preview = null;
      el.classList.add('page-wide');
      fill(el, h('p', { class: 'muted' }, 'Загрузка…'));
      load().then(() => { lastSig = ''; render(); }).catch((e) => fill(el, h('div', { class: 'error' }, e.message)));
      timer = setInterval(poll, 3000);
      return () => { clearInterval(timer); el.classList.remove('page-wide'); root = null; };
    },
  };
})();
