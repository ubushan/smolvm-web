'use strict';
// Page «Рабочие места»: the start page. A workspace is a sandbox profile with
// the template and agent it opens with — open it and get a clean machine with
// the agent's instructions, MCP, skills and memory already in place.

(() => {
  let root = null;
  let data = null;   // GET /ui/sandbox
  let lists = {};    // egress list id -> name
  let timer = null;
  let lastSig = '';

  const AGENTS = { terminal: 'Терминал', claude: 'Claude Code', opencode: 'OpenCode', 'opencode-tui': 'OpenCode TUI', dsh: 'Harness', codex: 'Codex', pi: 'Pi', hermes: 'Hermes' };
  const MARKS = { claude: 'claude', opencode: 'opencode', 'opencode-tui': 'opencode', dsh: 'dsh', codex: 'codex', pi: 'pi', hermes: 'hermes' };
  const ready = () => data.templates.filter((t) => !t.creating && !t.missing);
  const tplOf = (id) => data.templates.find((t) => t.id === id) || null;
  const agentsOf = (t) => (t?.agents?.agents || []).filter((id) => id !== 'terminal');
  const minutes = (ms) => {
    const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
    return m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч ${m % 60} мин`;
  };
  // The agent a workspace starts: its own choice, else the template's first.
  const agentFor = (p) => {
    const t = tplOf(p.template);
    const list = agentsOf(t);
    return p.agent && (list.includes(p.agent) || !t) ? p.agent : list[0] || null;
  };
  const netLine = (t) => {
    const e = t?.egress;
    if (!t) return 'шаблон не выбран';
    if (!e || !e.enabled) return 'Сеть: без ограничений';
    const names = (e.lists || []).map((id) => lists[id]).filter(Boolean);
    const own = e.rules?.length ? ` + ${e.rules.length} своих правил` : '';
    return `Сеть: только разрешённое${names.length ? ` · ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3}` : ''}` : ''}${own}`;
  };

  async function load() {
    data = await api('GET', '/ui/sandbox');
    try { lists = Object.fromEntries(((await api('GET', '/ui/egress')).lists || []).map((l) => [l.id, l.name])); } catch {}
  }

  // ---------- actions ----------
  async function openSandbox({ template, profile, agent }, btn) {
    const w = agent ? agentTab() : null;
    if (btn) { btn.disabled = true; btn.replaceChildren(h('i', { class: 'spin' }), 'Открывается…'); }
    try {
      const r = await api('POST', '/ui/sandbox/open', { template, profile: profile || null, agent: agent || null });
      toast(`Песочница ${r.name} открыта`, 'ok');
      if (r.url) goAgent(w, r.url); else if (w) w.close();
      refreshMachines();
    } catch (e) { if (w) w.close(); toast(e.message, 'err', 12000); }
    await load(); render();
  }

  async function goToAgent(x) {
    const id = x.agent || x.agents.find((a) => a.id !== 'terminal')?.id || x.agents[0]?.id;
    if (!id) { location.hash = '#/'; setTimeout(() => select(x.name), 0); return; }
    const w = agentTab();
    try { goAgent(w, (await api('POST', `/ui/machines/${enc(x.name)}/agents/${enc(id)}/start`, {})).url); }
    catch (e) { if (w) w.close(); toast(e.message, 'err'); }
  }

  async function closeSandbox(x, keep) {
    if (!keep) {
      const c = await confirmDialog('Закрыть без сохранения?', `Машина ${x.name} будет удалена${x.profile ? ', изменения профиля потеряются' : ''}.`, false, '', 'Закрыть');
      if (!c.ok) return;
    }
    try {
      const r = await api('POST', `/ui/sandbox/machines/${enc(x.name)}/close`, { save: keep });
      refreshMachines();
      if (r.pending) toast(h('span', {}, `Песочница закрыта. Изменений профиля: ${r.changes}. `, h('a', { href: '#/sandbox?tab=review' }, 'Проверить')), 'ok', 10000);
      else if (r.applied) toast(`Песочница закрыта, в профиль сохранено изменений: ${r.applied}`, 'ok');
      else toast('Песочница закрыта', 'ok');
    } catch (e) { toast(e.message, 'err', 12000); }
    await load(); render();
  }

  // ---------- dialogs ----------
  function dialog(title, body, footer, cls = '') {
    const dlg = h('dialog', { class: `dialog ${cls}` },
      h('header', {}, h('h3', {}, title), h('button', { type: 'button', class: 'btn ghost icon', title: 'Закрыть', 'aria-label': 'Закрыть', onclick: () => dlg.close() }, ic('x'))),
      h('div', { class: 'dialog-body' }, ...body),
      footer ? h('footer', {}, ...footer) : null);
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
    return dlg;
  }

  // Agent tiles: one choice, big targets.
  function agentPicker(ids, value, onChange) {
    const box = h('div', { class: 'ws-agents', role: 'radiogroup', 'aria-label': 'Агент' });
    const draw = () => box.replaceChildren(...ids.map((id) => h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(id === value), class: `ws-agent${id === value ? ' on' : ''}`,
      onclick: () => { value = id; draw(); onChange(id); },
    }, mark(MARKS[id] || 'term', true), h('span', {}, AGENTS[id] || id))));
    draw();
    return box;
  }

  // «Новая песочница» (A): agent, profile, open. Also the one-off sandbox without a profile.
  function launcher(preset = {}) {
    const tpls = ready();
    if (!tpls.length) { location.hash = '#/sandbox?tab=templates'; return; }
    let tpl = tplOf(preset.template) && !tplOf(preset.template).missing ? preset.template : tpls[0].id;
    let agent = null;
    const tplSel = h('select', { class: 'input', id: 'ws-l-tpl' }, tpls.map((t) => h('option', { value: t.id }, t.title)));
    tplSel.value = tpl;
    const prof = h('select', { class: 'input', id: 'ws-l-prof' }, h('option', { value: '' }, 'Без профиля — ничего не сохранять'),
      data.profiles.map((p) => h('option', { value: p.id }, p.name)));
    prof.value = preset.profile || '';
    const agentsBox = h('div', {});
    const net = h('div', { class: 'muted small ws-center' });
    const drawAgents = () => {
      const ids = agentsOf(tplOf(tpl));
      const p = data.profiles.find((x) => x.id === prof.value);
      agent = ids.includes(preset.agent) ? preset.agent : ids.includes(p?.agent) ? p.agent : ids[0] || null;
      agentsBox.replaceChildren(ids.length ? agentPicker(ids, agent, (id) => { agent = id; }) : h('div', { class: 'muted small' }, 'В шаблоне нет агентов — откроется только машина.'));
      net.textContent = `${netLine(tplOf(tpl))} · каждый раз чистая машина`;
    };
    tplSel.addEventListener('change', () => { tpl = tplSel.value; drawAgents(); });
    prof.addEventListener('change', () => {
      const p = data.profiles.find((x) => x.id === prof.value);
      if (p?.template && tplOf(p.template) && !tplOf(p.template).missing) { tpl = p.template; tplSel.value = tpl; }
      drawAgents();
    });
    drawAgents();
    const go = h('button', { class: 'btn primary ws-go' }, ic('play'), 'Открыть песочницу');
    let dlg = null;
    go.addEventListener('click', async () => { await openSandbox({ template: tpl, profile: prof.value, agent }, go); dlg.close(); });
    dlg = dialog('Новая песочница', [
      h('p', { class: 'muted' }, 'Чистая машина за несколько секунд. Настройки агента подтянутся из профиля.'),
      h('div', { class: 'ws-field' }, h('div', { class: 'label-like' }, 'Агент'), agentsBox),
      h('label', { class: 'ws-field', for: 'ws-l-prof' }, 'Профиль', prof),
      tpls.length > 1 ? h('label', { class: 'ws-field', for: 'ws-l-tpl' }, 'Шаблон машины', tplSel) : null,
      go, net,
    ], null, 'ws-dialog');
  }

  // «Новое место»: a profile with its template and agent.
  function newWorkspace() {
    const tpls = ready();
    if (!tpls.length) { location.hash = '#/sandbox?tab=templates'; return; }
    let tpl = tpls[0].id;
    let agent = null;
    const name = h('input', { class: 'input', id: 'ws-n-name', placeholder: 'Например: Бэкенд-разработка', maxlength: 60 });
    const tplSel = h('select', { class: 'input', id: 'ws-n-tpl' }, tpls.map((t) => h('option', { value: t.id }, t.title)));
    const running = (state.machines || []).filter((m) => m.state === 'running' && !state.marks?.[m.name]?.sandbox);
    const from = h('select', { class: 'input', id: 'ws-n-from' }, h('option', { value: '' }, 'Начать с пустого'),
      running.map((m) => h('option', { value: m.name }, `Взять настройки агента из машины ${m.name}`)));
    const agentsBox = h('div', {});
    const drawAgents = () => {
      const ids = agentsOf(tplOf(tpl));
      agent = ids[0] || null;
      agentsBox.replaceChildren(ids.length ? agentPicker(ids, agent, (id) => { agent = id; }) : h('div', { class: 'muted small' }, 'В шаблоне нет агентов.'));
    };
    tplSel.addEventListener('change', () => { tpl = tplSel.value; drawAgents(); });
    drawAgents();
    const save = h('button', { class: 'btn primary' }, 'Создать');
    const dlg = dialog('Новое рабочее место', [
      h('p', { class: 'muted' }, 'Агент со своими инструкциями, MCP-серверами, skills и памятью. Открывается всегда в чистой машине из шаблона.'),
      h('label', { class: 'ws-field', for: 'ws-n-name' }, 'Название', name),
      h('div', { class: 'ws-field' }, h('div', { class: 'label-like' }, 'Агент'), agentsBox),
      tpls.length > 1 ? h('label', { class: 'ws-field', for: 'ws-n-tpl' }, 'Шаблон машины', tplSel) : null,
      h('label', { class: 'ws-field', for: 'ws-n-from' }, 'Настройки агента', from),
      h('div', { class: 'muted small' }, 'Инструкции, MCP и skills можно будет поправить в профиле. Входы и токены в профиль не попадают.'),
    ], [h('button', { class: 'btn', onclick: () => dlg.close() }, 'Отмена'), save], 'ws-dialog');
    save.addEventListener('click', async () => {
      if (!name.value.trim()) { name.focus(); toast('Укажите название', 'err'); return; }
      save.disabled = true;
      try {
        const r = await api('POST', '/ui/sandbox/profiles', { name: name.value.trim(), template: tpl, agent, from: from.value || null });
        toast(`Рабочее место «${name.value.trim()}» создано${r.skipped?.length ? ` (пропущено файлов: ${r.skipped.length})` : ''}`, 'ok');
        dlg.close();
      } catch (e) { toast(e.message, 'err', 10000); save.disabled = false; return; }
      await load(); render();
    });
    setTimeout(() => name.focus(), 0);
  }

  // ---------- render ----------
  function workspaceCard(p, open) {
    const t = tplOf(p.template);
    const agent = agentFor(p);
    const s = p.summary || { mcp: [], skills: 0, memory: 0, instructions: [] };
    const chips = [
      s.mcp.length ? `MCP: ${s.mcp.slice(0, 3).join(', ')}${s.mcp.length > 3 ? ` +${s.mcp.length - 3}` : ''}` : null,
      s.skills ? `${s.skills} skills` : null,
      ...s.instructions,
      s.memory ? `память: ${s.memory}` : null,
    ].filter(Boolean);
    const sbx = open[0];
    const busy = sbx?.opening;
    const go = h('button', { class: 'btn primary ws-main' }, ic('play'), 'Открыть');
    go.addEventListener('click', () => (t && !t.missing ? openSandbox({ template: t.id, profile: p.id, agent }, go) : launcher({ profile: p.id })));
    return h('article', { class: `ws-card${sbx ? ' live' : ''}` },
      h('div', { class: 'ws-card-head' },
        mark(MARKS[agent] || 'vm'),
        h('div', { class: 'ws-title' }, h('b', {}, p.name), h('span', { class: 'muted small' }, [AGENTS[agent] || 'без агента', t ? t.title : null].filter(Boolean).join(' · '))),
        sbx ? h('span', { class: `ws-live${busy ? ' busy' : ''}` }, busy ? busy : `открыто · ${minutes(sbx.createdAt)}`) : null),
      h('div', { class: 'ws-chips' }, chips.length ? chips.map((c) => h('span', { class: 'ws-chip' }, c)) : h('span', { class: 'muted small' }, 'Профиль пока пустой — агент начнёт с настроек шаблона')),
      h('div', { class: 'muted small' }, netLine(t)),
      h('div', { class: 'ws-actions' },
        sbx
          ? [h('button', { class: 'btn primary ws-main', disabled: !!busy || sbx.state !== 'running', onclick: () => goToAgent(sbx) }, 'Перейти к агенту'),
            h('button', { class: 'btn', disabled: !!busy, title: 'Забрать изменения профиля на проверку и удалить машину', onclick: () => closeSandbox(sbx, true) }, 'Закрыть')]
          : go,
        h('a', { class: 'btn ghost icon', href: `#/sandbox?tab=profiles&profile=${enc(p.id)}`, title: 'Профиль: инструкции, MCP, skills, память', 'aria-label': `Профиль «${p.name}»` }, ic('gear'))),
      open.length > 1 ? h('div', { class: 'muted small' }, `Ещё открыто: ${open.slice(1).map((x) => x.name).join(', ')}`) : null);
  }

  function render() {
    if (!root || !data) return;
    const y = root.scrollTop;
    const head = h('div', { class: 'ws-head' },
      h('div', { class: 'ws-head-text' },
        h('h1', {}, 'Рабочие места'),
        h('p', { class: 'muted' }, 'Каждое место — агент со своими инструкциями, MCP и памятью. Открывается всегда в чистой машине.')),
      h('button', { class: 'btn', onclick: () => launcher() }, ic('box'), 'Разовая песочница'),
      h('button', { class: 'btn primary', onclick: newWorkspace }, ic('plus'), 'Новое место'));

    const tpls = ready();
    const jobs = data.templates.filter((t) => t.job?.status === 'running');
    if (!tpls.length) {
      fill(root, head, h('section', { class: 'card ws-empty' },
        ic('server'),
        h('h3', {}, jobs.length ? 'Шаблон готовится…' : 'Сначала нужен шаблон машины'),
        h('p', { class: 'muted' }, jobs.length ? jobs.map((t) => `${t.title}: ${t.job.step}`).join('; ') : 'Это снимок машины с установленными агентами. Из него за секунды открываются чистые песочницы.'),
        jobs.length ? null : h('a', { class: 'btn primary', href: '#/sandbox?tab=templates' }, 'Подготовить шаблон')));
      root.scrollTop = y;
      return;
    }

    const byProfile = (id) => data.sandboxes.filter((x) => x.profile === id);
    const cards = data.profiles.map((p) => workspaceCard(p, byProfile(p.id)));
    const oneOff = data.sandboxes.filter((x) => !x.profile || !data.profiles.some((p) => p.id === x.profile));
    const grid = cards.length ? h('div', { class: 'ws-grid' }, ...cards)
      : h('section', { class: 'card ws-empty' }, ic('users'), h('h3', {}, 'Рабочих мест пока нет'),
        h('p', { class: 'muted' }, 'Создайте место для задачи — например «Бэкенд-разработка» с Claude Code — или откройте разовую песочницу.'),
        h('button', { class: 'btn primary', onclick: newWorkspace }, ic('plus'), 'Новое место'));

    const pending = data.pending.map((x) => {
      const p = data.profiles.find((y) => y.id === x.profile);
      const exec = x.changes.filter((c) => /skills\/|hooks\/|mcp|settings\.json|config\.(toml|yaml)|opencode\.json/.test(c.path)).length;
      return h('div', { class: 'ws-notice' },
        h('span', {}, h('b', {}, `«${p?.name || x.profile}»: `), `${x.changes.length} ${x.changes.length === 1 ? 'изменение ждёт' : 'изменений ждут'} проверки`, exec ? ` — среди них skills, MCP или настройки` : ''),
        h('a', { href: '#/sandbox?tab=review' }, 'Посмотреть изменения'));
    });

    const oneOffBox = oneOff.length ? h('section', { class: 'ws-oneoff' },
      h('div', { class: 'label-like' }, 'Разовые песочницы'),
      ...oneOff.map((x) => h('div', { class: 'ws-row' },
        h('span', { class: `dot-state ${x.state}`, 'aria-hidden': 'true' }),
        h('div', { class: 'ws-row-main' }, h('b', { class: 'mono' }, x.name), h('span', { class: 'muted small' }, `${tplOf(x.template)?.title || x.template} · ${x.opening || `открыта ${minutes(x.createdAt)}`}`)),
        h('button', { class: 'btn small-btn', disabled: x.state !== 'running' || !!x.opening, onclick: () => goToAgent(x) }, 'Перейти'),
        h('button', { class: 'btn small-btn', disabled: !!x.opening, onclick: () => closeSandbox(x, false) }, 'Закрыть')))) : null;

    fill(root, head, ...pending, grid, oneOffBox,
      h('div', { class: 'ws-foot' }, h('a', { href: '#/sandbox?tab=templates' }, 'Шаблоны машин'), h('a', { href: '#/sandbox?tab=profiles' }, 'Все профили'), h('a', { href: '#/sandbox?tab=review' }, 'Ревью изменений')));
    root.scrollTop = y;
  }

  async function poll() {
    if (!root || document.hidden || document.querySelector('dialog.ws-dialog[open]')) return;
    try { await load(); } catch { return; }
    const sig = JSON.stringify([data.sandboxes.map((x) => [x.name, x.state, x.opening, Math.floor((Date.now() - x.createdAt) / 60000)]), data.templates.map((t) => [t.id, t.job?.status, t.job?.step]), data.pending.map((x) => [x.id, x.changes.length]), data.profiles.map((p) => [p.id, p.updatedAt, p.files])]);
    if (sig === lastSig) return;
    lastSig = sig;
    render();
  }

  pages.work = {
    render(el) {
      root = el;
      fill(el, h('p', { class: 'muted' }, 'Загрузка…'));
      load().then(() => { lastSig = ''; render(); }).catch((e) => fill(el, h('div', { class: 'error' }, e.message)));
      timer = setInterval(poll, 3000);
      return () => { clearInterval(timer); root = null; };
    },
  };
})();
