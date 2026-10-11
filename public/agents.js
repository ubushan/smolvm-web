'use strict';
// «Песочница» → «Агенты» (#/agents, the start page): every agent «on staff» — what it
// sees, where it goes, which keys it holds — in plain words. «Создать агента» and the
// gear of a card open agentwizard.js; «Дать задачу» opens a sandbox with a task.

(() => {
  let root = null;
  let data = null;       // GET /ui/sandbox
  let approvals = [];    // GET /ui/live
  let isolated = {};
  let lists = {};        // egress list id -> name
  const risk = {};       // machine -> trifecta (open sandboxes)
  const folders = {};    // machine -> folders
  let detailsAt = 0;
  let timer = null;
  let lastSig = '';

  const AGENTS = { terminal: 'Терминал', claude: 'Claude Code', opencode: 'OpenCode', 'opencode-tui': 'OpenCode TUI', dsh: 'DSH', codex: 'Codex', pi: 'Pi', hermes: 'Hermes' };
  const MARKS = { claude: 'claude', opencode: 'opencode', 'opencode-tui': 'opencode', dsh: 'dsh', codex: 'codex', pi: 'pi', hermes: 'hermes' };
  // What to do with addresses that are not in the agent's white lists (the network itself is
  // set on «Изоляция»). Agents made before that also get the network of the level.
  const TRUST = {
    careful: { title: 'Осторожно', hint: 'Для незнакомого кода и экспериментов', lines: ['Неизвестные адреса — запрещены, без вопросов', 'Песочница живёт не дольше 2 часов', 'Проект — копия, на диск ничего без проверки'] },
    normal: { title: 'Обычно', hint: 'Для работы над своими проектами', lines: ['Неизвестные адреса — спросит вас', 'Опасные вызовы API — с подтверждения', 'Проект — копия, изменения после проверки'] },
    trusted: { title: 'Доверяю', hint: 'Только для агентов, которым вы полностью доверяете', lines: ['Неизвестные адреса — пропускает без вопросов', 'Ничего не спрашивает', 'Не давайте вместе с ключами клиентов'] },
  };
  const TRUST_KEY = 'smolvm.trust';
  const ready = () => data.templates.filter((t) => !t.creating && !t.missing);
  const tplOf = (id) => data.templates.find((t) => t.id === id) || null;
  const agentsOf = (t) => (t?.agents?.agents || []).filter((id) => id !== 'terminal');
  const ago = (ms) => {
    const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
    return m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч ${m % 60} мин`;
  };
  const agentFor = (p) => {
    const list = agentsOf(tplOf(p.template));
    return p.agent && list.includes(p.agent) ? p.agent : list[0] || p.agent || null;
  };
  const short = (p) => String(p || '').replace(/^\/(Users|home)\/[^/]+/, '~').replace(/^[A-Z]:\\Users\\[^\\]+/i, '~');

  async function load() {
    const [d, live] = await Promise.all([api('GET', '/ui/sandbox'), api('GET', '/ui/live').catch(() => ({}))]);
    data = d; approvals = live.approvals || []; isolated = live.isolated || {};
    if (!Object.keys(lists).length) {
      try { lists = Object.fromEntries(((await api('GET', '/ui/egress')).lists || []).map((l) => [l.id, l.name])); } catch {}
    }
    // What an open agent sees and where it goes: every 10 s, not every poll.
    if (Date.now() - detailsAt > 10000) {
      detailsAt = Date.now();
      await Promise.all(data.sandboxes.filter((x) => x.state === 'running' && !x.opening).map(async (x) => {
        const [r, f] = await Promise.all([
          api('GET', `/ui/machines/${enc(x.name)}/risk`).catch(() => null),
          api('GET', `/ui/machines/${enc(x.name)}/folders`).catch(() => null),
        ]);
        risk[x.name] = r?.trifecta || null;
        folders[x.name] = (f?.folders || []).filter((y) => !y.removed);
      }));
    }
  }

  // ---------- the three rows: sees, goes, keys ----------
  function sees(x, t, p) {
    if (x) {
      const f = folders[x.name] || [];
      if (!f.length) return 'Только свою чистую машину — ваших папок нет';
      return f.slice(0, 3).map((y) => `${short(y.hostPath).length > 36 ? `…/${short(y.hostPath).split(/[\\/]/).filter(Boolean).slice(-2).join('/')}` : short(y.hostPath)} (${{ review: 'копия', rw: 'запись', ro: 'чтение' }[y.level] || y.level})`).join(', ') + (f.length > 3 ? ` +${f.length - 3}` : '');
    }
    const own = p?.folders?.length ? p.folders : p?.folder ? [{ hostPath: p.folder, mode: 'review' }] : [];
    if (own.length) return own.slice(0, 3).map((f) => `${short(f.hostPath).split(/[\\/]/).filter(Boolean).pop()} (${f.mode === 'ro' ? 'только чтение' : 'копия'})`).join(', ') + (own.length > 3 ? ` +${own.length - 3}` : '');
    return 'Только свою чистую машину, пока вы не дадите папку';
  }
  function goes(x, t, p) {
    const r = x && risk[x.name];
    if (!x && p?.net) {
      if (p.net === 'off') return ['bad', 'Куда угодно в интернете'];
      const names = (p.lists || []).map((id) => lists[id]).filter(Boolean);
      return ['ok', `Только разрешённое${names.length ? `: ${names.slice(0, 3).join(', ')}` : ''}${p.trust === 'trusted' ? ', остальное — без вопросов' : p.trust === 'normal' ? ', о новых спросит' : ''}`];
    }
    if (r) return [{ open: 'bad', limited: 'ok', none: 'ok' }[r.untrustedLevel] || 'neutral', r.untrustedWhy];
    if (x) {
      const trust = TRUST[x.trust];
      if (trust) return [x.trust === 'trusted' ? 'bad' : 'ok', trust.lines[1]];
    }
    const e = t?.egress;
    if (!t) return ['neutral', 'Определится при запуске'];
    if (!e || !e.enabled) return ['bad', 'Куда угодно в интернете'];
    const names = (e.lists || []).map((id) => lists[id]).filter(Boolean);
    return ['ok', `Только разрешённое${names.length ? `: ${names.slice(0, 3).join(', ')}` : ''}${e.rules?.length ? ` + ${e.rules.length} адресов` : ''}`];
  }
  function keys(x, t, p) {
    const r = x && risk[x.name];
    const names = r ? r.privateData.filter((s) => s.startsWith('секрет ')).map((s) => s.slice(7)) : Array.isArray(p?.secrets) ? p.secrets : (t?.secrets || []);
    return names.length ? names.slice(0, 4).join(', ') + (names.length > 4 ? ` +${names.length - 4}` : '') : 'Нет';
  }

  // «Осторожно — неизвестные адреса запрещены, не дольше 2 ч».
  function trustText(id) {
    const t = TRUST[id];
    if (!t) return 'Не задано';
    return `${t.title} — ${{ careful: 'неизвестные адреса запрещены, песочница живёт ≤ 2 ч', normal: 'о неизвестных адресах спросит вас', trusted: 'неизвестные адреса пропускает' }[id]}`;
  }

  function status(x) {
    if (!x) return ['neutral', 'спит'];
    if (isolated[x.name]) return ['bad', 'остановлен вами'];
    if (x.opening) return ['busy', x.opening];
    if (approvals.some((a) => a.machine === x.name)) return ['warn', 'ждёт вашего ответа'];
    if (x.state !== 'running') return ['neutral', x.state === 'missing' ? 'машина пропала' : 'на паузе'];
    return ['ok', `работает · ${ago(x.createdAt)}`];
  }

  // ---------- actions ----------
  async function openSession(x) {
    location.hash = `#/session?name=${enc(x.name)}`;
  }
  async function openTab(x) {
    const id = x.agent || x.agents?.find((a) => a.id !== 'terminal')?.id || x.agents?.[0]?.id;
    if (!id) return toast('В этой машине нет агентов', 'err');
    const w = agentTab();
    try {
      goAgent(w, (await api('POST', `/ui/machines/${enc(x.name)}/agents/${enc(id)}/start`, {})).url);
      agentInTab(x.name, true);
    } catch (e) { if (w) w.close(); toast(e.message, 'err'); }
  }
  async function stop(x) {
    const c = await confirmDialog('Остановить агента?', x.profile
      ? 'Машина будет удалена. То, что агент запомнил, уйдёт к вам на проверку в «Решения». Изменения в проекте можно проверить там же, пока машина работает — после остановки копия проекта пропадёт.'
      : 'Машина будет удалена вместе со всем, что агент сделал внутри.', false, '', 'Остановить');
    if (!c.ok) return;
    try {
      const r = await api('POST', `/ui/sandbox/machines/${enc(x.name)}/close`, { save: !!x.profile });
      refreshMachines();
      agentInTab(x.name, false);
      if (r.pending) { toast(`Агент остановлен. Изменений на проверку: ${r.changes}`, 'ok', 8000); location.hash = '#/decisions'; return; }
      toast('Агент остановлен', 'ok');
    } catch (e) { toast(e.message, 'err', 12000); }
    await refresh();
  }
  async function removeAgent(p) {
    if (data.sandboxes.some((x) => x.profile === p.id)) { toast('Сначала остановите его сессии', 'err'); return; }
    const c = await confirmDialog('Удалить агента?', `«${p.name}» и его память (инструкции, MCP, skills), задача и настройки будут удалены. Образ программы останется.`, false, '', 'Удалить');
    if (!c.ok) return;
    try { await api('DELETE', `/ui/sandbox/profiles/${enc(p.id)}`); toast(`Агент «${p.name}» удалён`, 'ok'); } catch (e) { toast(e.message, 'err'); }
    await refresh();
  }

  async function safer(x) {
    try {
      await api('PUT', `/ui/egress/machines/${enc(x.name)}`, { enabled: true, ask: true });
      toast('Теперь новые адреса — только с вашего разрешения', 'ok', 8000);
    } catch (e) { toast(e.message, 'err'); }
    detailsAt = 0; await refresh();
  }

  // ---------- «Дать задачу»: task, folder, agent, trust ----------
  function dialog(title, body, cls = '') {
    const dlg = h('dialog', { class: `dialog ${cls}` },
      h('header', {}, h('h3', {}, title), h('button', { type: 'button', class: 'btn ghost icon', title: 'Закрыть', 'aria-label': 'Закрыть', onclick: () => dlg.close() }, ic('x'))),
      h('div', { class: 'dialog-body' }, ...body));
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
    return dlg;
  }

  function trustPicker(value, onChange) {
    const box = h('div', { class: 'ag-trust', role: 'radiogroup', 'aria-label': 'Насколько вы доверяете агенту' });
    const draw = () => box.replaceChildren(...Object.entries(TRUST).map(([id, t]) => h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(id === value), class: `ag-trust-col ${id}${id === value ? ' on' : ''}`,
      onclick: () => { value = id; draw(); onChange(id); },
    }, h('span', { class: 'ag-trust-title' }, h('i', { class: `ag-dot ${id}` }), t.title),
      h('span', { class: 'ag-trust-hint' }, t.hint),
      h('span', { class: 'ag-trust-lines' }, ...t.lines.map((l) => h('span', {}, l))))));
    draw();
    return box;
  }

  function launch(preset = {}) {
    const prof = data.profiles.find((p) => p.id === preset.profile) || null;
    let profile = prof?.id || '';
    let tpl = null;
    let agent = null;
    let trust = 'normal';
    try { trust = TRUST[localStorage.getItem(TRUST_KEY)] ? localStorage.getItem(TRUST_KEY) : 'normal'; } catch {}
    if (TRUST[prof?.trust]) trust = prof.trust;

    const task = h('textarea', { class: 'input ag-task', id: 'ag-task', rows: 3, maxlength: 4000, placeholder: 'Например: добавь эндпоинт /health и тест к нему' });
    if (prof?.task) task.value = prof.task;
    // The agent's directories (⚙ → «Директории»): a fresh copy of each in every task.
    const dirs = prof?.folders?.length ? prof.folders : prof?.folder ? [{ hostPath: prof.folder, mode: 'review' }] : [];
    const dirsBox = h('div', { class: 'ag-dirs' }, ...(dirs.length ? dirs.map((f) => h('div', { class: 'ag-dir' }, ic('folder'),
      h('span', { class: 'mono ellipsis', title: f.hostPath }, short(f.hostPath)), h('span', { class: 'tag' }, f.mode === 'ro' ? 'только чтение' : 'копия с проверкой')))
      : [h('span', { class: 'muted small' }, 'Агенту не дано ни одной папки.')]),
      prof ? h('a', { href: '#', class: 'small', onclick: (e) => { e.preventDefault(); dlg.close(); agentWizard({ profile: prof.id, step: 'dirs', onDone: () => refresh() }); } }, 'Изменить директории агента') : null);
    const who = h('select', { class: 'input', id: 'ag-who' }, h('option', { value: '' }, 'Новый агент — ничего не запоминать'),
      data.profiles.map((p) => h('option', { value: p.id }, p.name)));
    who.value = profile;
    let go = null;
    // A workspace remembers its template; otherwise any template with the chosen agent.
    const pick = ({ agent: a, template: t }) => {
      agent = a;
      const p = data.profiles.find((y) => y.id === profile);
      const own = p?.template && tplOf(p.template) && !tplOf(p.template).missing && agentsOf(tplOf(p.template)).includes(a) ? p.template : null;
      tpl = own || t;
      if (go && !go.dataset.busy) go.disabled = tpl === null;
    };
    // An agent of a preset runs from the preset's image: nothing to choose here.
    const img = prof?.preset ? data.images?.[prof.preset]?.[(prof.net || 'strict') === 'strict' ? 'isolated' : 'plain'] : null;
    const agentsBox = prof?.preset
      ? h('div', { class: 'ag-dir' }, mark(MARKS[prof.agent] || 'vm', true), h('b', {}, AGENTS[prof.agent] || prof.agent || prof.preset),
        img?.template ? h('span', { class: 'small okc' }, '✓ образ готов') : h('span', { class: 'small muted' }, img?.job ? `образ готовится: ${img.job.step}` : 'образ ещё не готов'))
      : agentChooser({ data, agent: prof ? agentFor(prof) : null, onChange: pick });
    if (prof?.preset) { agent = prof.agent; tpl = img?.template ? '' : null; }
    who.addEventListener('change', () => {
      profile = who.value;
      const p = data.profiles.find((y) => y.id === profile);
      if (p) agentsBox.set(agentFor(p)); else agentsBox.set(agent);
    });
    const trustBox = trustPicker(trust, (id) => { trust = id; });

    let inTab = false;
    try { inTab = localStorage.getItem('smolvm.agentTab') === '1'; } catch {}
    const tabBox = h('input', { type: 'checkbox', id: 'ag-tab', checked: inTab });
    go = h('button', { class: 'btn primary ag-go', disabled: tpl === null }, ic('play'), 'Запустить');
    let dlg = null;
    dlg = dialog(prof ? `Задача для «${prof.name}»` : 'Дать задачу агенту', [
      h('label', { class: 'ws-field', for: 'ag-task' }, 'Что сделать', task),
      h('div', { class: 'ws-field' }, h('div', { class: 'label-like' }, 'Директории'), dirsBox),
      prof ? null : h('label', { class: 'ws-field', for: 'ag-who' }, 'Кто', who),
      h('div', { class: 'ws-field' }, h('div', { class: 'label-like' }, 'Агент'), agentsBox),
      h('div', { class: 'ws-field' }, h('div', { class: 'label-like' }, 'Насколько вы ему доверяете'), trustBox),
      h('label', { class: 'ag-check', for: 'ag-tab' }, tabBox, h('span', {}, 'Открыть агента в отдельной вкладке браузера',
        h('span', { class: 'muted small' }, ' — здесь останется контроль: запросы, действия, изменения'))),
      go,
      h('div', { class: 'muted small ws-center' }, 'Каждый раз чистая машина. Задачу, папку и доверие по умолчанию задают настройки агента (⚙ на карточке).'),
    ], 'ws-dialog ag-dialog');
    go.addEventListener('click', async () => {
      // The tab is opened right away, while the click still counts: later the browser blocks it.
      const wantTab = tabBox.checked && !!agent;
      const tab = wantTab ? agentTab() : null;
      const cancel = () => { if (tab) tab.close(); };
      if (trust === 'trusted') {
        const c = await confirmDialog('Без ограничений сети?', 'Агент сможет ходить куда угодно в интернете и ничего не будет спрашивать. Всё, что он увидит в проекте, он сможет отправить наружу.', false, '', 'Да, доверяю');
        if (!c.ok) { cancel(); return; }
      }
      try { localStorage.setItem(TRUST_KEY, trust); localStorage.setItem('smolvm.agentTab', tabBox.checked ? '1' : '0'); } catch {}
      go.disabled = true; go.dataset.busy = '1'; go.replaceChildren(h('i', { class: 'spin' }), 'Запускается…');
      try {
        const r = await api('POST', '/ui/sandbox/open', { template: tpl || null, profile: profile || null, agent, trust, task: task.value.trim() || null });
        dlg.close();
        // A blocked tab: goAgent tries again and, if blocked, shows a link to it.
        if (wantTab && r.url) { agentInTab(r.name, true); goAgent(tab, r.url); } else cancel();
        toast(wantTab ? 'Агент запущен в отдельной вкладке' : 'Агент запущен', 'ok');
        refreshMachines();
        location.hash = `#/session?name=${enc(r.name)}`;
      } catch (e) {
        cancel();
        toast(e.message, 'err', 12000);
        delete go.dataset.busy; go.disabled = false; go.replaceChildren(ic('play'), 'Запустить');
      }
    });
    setTimeout(() => task.focus(), 0);
  }

  const create = (step) => agentWizard({ step, onDone: () => refresh() });

  // ---------- render ----------
  function row(label, value, tone) {
    return h('div', { class: 'ag-row' }, h('span', { class: 'ag-row-label' }, label), h('span', { class: `ag-row-value${tone ? ` ${tone}` : ''}` }, value));
  }

  function card({ p, x, t }) {
    const agent = p ? agentFor(p) : x.agent || x.agents?.find((a) => a.id !== 'terminal')?.id;
    let st = status(x);
    // A sleeping agent of a preset whose image is still being prepared.
    const img = !x && p?.preset ? data.images?.[p.preset]?.[(p.net || 'strict') === 'strict' ? 'isolated' : 'plain'] : null;
    if (img && !img.template) st = img.job?.status === 'running' ? ['busy', `образ: ${img.job.step}`] : img.job?.status === 'error' ? ['bad', 'образ не подготовлен'] : ['neutral', 'образ не готов'];
    const [tone, where] = goes(x, t, p);
    const r = x && risk[x.name];
    const live = x && x.state === 'running' && !x.opening;
    const title = p ? p.name : 'Разовая задача';
    const sub = [AGENTS[agent] || 'без агента', x?.trust ? `доверие: ${TRUST[x.trust]?.title.toLowerCase()}` : null].filter(Boolean).join(' · ');
    return h('article', { class: `ag-card${x ? ' live' : ''}${st[0] === 'warn' ? ' asks' : ''}` },
      h('div', { class: 'ag-head' },
        mark(MARKS[agent] || 'vm'),
        h('div', { class: 'ag-title' }, h('b', {}, title), h('span', { class: 'muted small' }, sub),
          h('span', { class: `ag-pill ${st[0]}` }, st[0] === 'busy' ? h('i', { class: 'spin' }) : null, st[1])),
        // Settings and removal of the agent, at the top right of its card.
        p ? h('span', { class: 'ag-tools' },
          h('button', { class: 'btn ghost icon', title: 'Настройки агента: программа, изоляция, директории, секреты, доверие, задача', 'aria-label': `Настройки агента «${p.name}»`, onclick: () => agentWizard({ profile: p.id, onDone: () => refresh() }) }, ic('gear')),
          h('button', { class: 'btn ghost icon danger', title: x ? 'Сначала остановите агента' : 'Удалить агента', 'aria-label': `Удалить агента «${p.name}»`, disabled: !!x, onclick: () => removeAgent(p) }, ic('trash'))) : null),
      x?.task ? h('div', { class: 'ag-task-line', title: x.task }, `«${x.task}»`) : null,
      h('div', { class: 'ag-rows' },
        row('Видит', sees(x, t, p)),
        row('Ходит', where, tone === 'bad' ? 'badc' : ''),
        row('Ключи', keys(x, t, p)),
        row('Доверие', trustText(x?.trust || p?.trust), (x?.trust || p?.trust) === 'trusted' ? 'warnc' : '')),
      r?.lethal ? h('div', { class: 'ag-warn' }, 'Есть и ваши данные, и выход в интернет — агент может их отправить наружу.') : null,
      h('div', { class: 'ag-actions' },
        x
          ? [h('button', { class: 'btn primary', disabled: !!x.opening, onclick: () => openSession(x) }, 'Открыть'),
            h('button', { class: 'btn ghost icon', disabled: !live || !!isolated[x.name], title: 'Открыть агента в отдельной вкладке браузера', 'aria-label': 'Открыть агента в отдельной вкладке', onclick: () => openTab(x) }, ic('external')),
            h('button', { class: 'btn', disabled: !!x.opening, onclick: () => stop(x) }, 'Остановить'),
            live && r && r.untrustedLevel === 'open' ? h('button', { class: 'btn ghost', title: 'Включить фильтр сети: новые адреса — только с вашего разрешения', onclick: () => safer(x) }, ic('shield'), 'Сделать безопаснее') : null]
          : [h('button', { class: 'btn ink', onclick: () => launch({ profile: p.id }) }, ic('play'), 'Дать задачу'),
            h('a', { class: 'btn ghost', href: `#/profile?id=${enc(p.id)}`, title: 'Инструкции, MCP, skills и память агента' }, 'Что он знает')],
        null));
  }

  function render() {
    if (!root || !data) return;
    const y = root.scrollTop;
    // «Создать агента» is in the header; here — how it works.
    const head = [sandboxHeader('agents', data), h('div', { class: 'ws-head ag-toolbar' },
      h('span', { class: 'muted small' }, 'Новый агент — кнопка «Создать агента» вверху.'), h('span', { class: 'spacer' }), guideButton())];

    const items = [];
    for (const p of data.profiles) {
      const open = data.sandboxes.filter((x) => x.profile === p.id);
      if (!open.length) items.push({ p, x: null, t: tplOf(p.template) });
      for (const x of open) items.push({ p, x, t: tplOf(x.template) });
    }
    for (const x of data.sandboxes.filter((s) => !s.profile || !data.profiles.some((p) => p.id === s.profile))) items.push({ p: null, x, t: tplOf(x.template) });
    // Working ones first, then the ones asking, then the sleeping ones.
    items.sort((a, b) => (!!b.x - !!a.x) || ((b.x?.createdAt || 0) - (a.x?.createdAt || 0)));

    const asks = approvals.length + data.pending.length;
    const banner = asks ? h('a', { class: 'ag-banner', href: '#/decisions' },
      h('b', {}, asks === 1 ? 'Одно решение ждёт вас' : `${asks} решений ждут вас`),
      h('span', {}, 'Агенты не могут продолжить без вашего ответа'), h('span', { class: 'spacer' }), h('span', {}, 'Открыть →')) : null;

    fill(root, head, banner,
      items.length ? h('div', { class: 'ag-grid' }, ...items.map(card))
        : h('section', { class: 'card ws-empty' }, ic('users'), h('h3', {}, 'Агентов пока нет'),
          h('p', { class: 'muted' }, 'Нажмите «Создать агента»: машина, изоляция, директории, секреты, шаблон и задача — в одном окне. Подробнее — «?» рядом с кнопкой.'),
          h('button', { class: 'btn primary', onclick: () => create() }, ic('plus'), 'Создать агента')));
    root.scrollTop = y;
  }

  async function refresh() {
    try { await load(); } catch { return; }
    lastSig = ''; render();
  }

  async function poll() {
    if (!root || document.hidden || document.querySelector('dialog[open]')) return;
    try { await load(); } catch { return; }
    const sig = JSON.stringify([data.sandboxes.map((x) => [x.name, x.state, x.opening, Math.floor((Date.now() - x.createdAt) / 60000)]), data.profiles.map((p) => [p.id, p.updatedAt]),
      data.templates.map((t) => [t.id, t.job?.step]), data.images, data.pending.length, approvals.map((a) => a.id), Object.keys(isolated), risk, folders]);
    if (sig === lastSig) return;
    lastSig = sig;
    render();
  }

  // ---------- «Песочница»: the head shared by «Агенты», «Решения» and «Шаблоны» ----------
  // The algorithm with what is done already, then the tabs. d = GET /ui/sandbox.
  const GUIDE_KEY = 'smolvm.sandboxGuide';
  window.sandboxHeader = function sandboxHeader(active, d) {
    const asks = (window.liveApprovals || 0) + d.pending.length;
    const tabs = [
      ['agents', 'Агенты', '#/agents', d.profiles.length, false],
      ['sessions', 'Сессии', '#/session', d.sandboxes.length, false],
      ['templates', 'Шаблоны', '#/sandbox', d.templates.length, false],
      ['decisions', 'Решения', '#/decisions', asks, true],
    ];
    return h('div', { class: 'sx-section' },
      h('div', { class: 'ws-head-text' },
        h('h1', {}, 'Песочница'),
        h('p', { class: 'muted' }, 'Агенты работают в чистых машинах: каждая задача — новая копия, ваши файлы меняются только после проверки.')),
      h('nav', { class: 'section-nav sx-tabs-nav' }, ...tabs.map(([id, title, href, n, attn]) => h('a', { class: id === active ? 'active' : '', href },
        title, n ? h('span', { class: `nav-count${attn ? ' attn' : ''}` }, String(n)) : null))));
  };

  // «?» next to «Создать агента»: how an agent is started, and what the window does.
  function guideButton() {
    const step = (n, title, text) => h('li', {}, h('b', {}, title), ' — ', text);
    return helpButton('Как запустить агента',
      h('p', {}, 'Всё делается в одном окне «Создать агента», шаг за шагом. Готовое (секрет, белый список, папку) можно выбрать, недостающее — создать там же: плитка с «+».'),
      h('ol', {},
        step(1, 'Программа', 'Claude Code, Codex, DSH, OpenCode… Её образ smolvm-web готовит один раз (несколько минут) и дальше открывает каждую задачу в чистой копии за секунды. Можно выбрать и шаблон своей машины.'),
        step(2, 'Изоляция', 'куда агент ходит в интернет: только разрешённое (рекомендуется) или без ограничений, и какие белые списки подключить — их можно поправить или создать тут же.'),
        step(3, 'Директории', 'какие папки компьютера получает агент. В каждой задаче — свежая копия: с проверкой (на диск — после вашего «Применить») или только для чтения.'),
        step(4, 'Секреты', 'ключи моделей и токены. Агент пользуется ими через шлюз и не видит значений.'),
        step(5, 'Доверие', 'что делать с адресами вне белых списков: запрещать, спрашивать или пропускать; когда удалять песочницу — после простоя или через заданное время.'),
        step(6, 'Агент', 'имя агента и его память. «Создать и запустить» — сразу во вкладку «Сессии»; что сделать, можно сказать агенту там или через «Дать задачу».')),
      h('p', {}, 'Дальше: «Дать задачу» на карточке — новая задача в чистой копии; «Сессии» — агент рядом с контролем; «Решения» — что агент просит и что хочет записать на диск. ⚙ на карточке открывает то же окно для настройки.'),
      h('p', {}, 'Вышла новая версия агента — во вкладке «Шаблоны» появится «Доступна новая версия»; кнопка «Обновить агента» поставит её и обновит образ.'),
      h('p', { class: 'muted small' }, 'Долгие шаги — подготовка образа, обновление — идут на сервере: окно можно закрыть, они продолжатся.'));
  }


  // ---------- agent chooser: ready templates + machines a template can be made from ----------
  // Used by «Дать задачу». onChange({ agent, template }) — template is
  // null while the agent still needs preparing.
  window.agentChooser = function agentChooser({ data: d0, agent: want, onChange }) {
    let d = d0;
    let agent = null;
    let timer = null;
    const box = h('div', { class: 'ag-chooser' });
    const titles = () => d.agentTitles || {};
    const titleOf = (id) => titles()[id]?.title || AGENTS[id] || id;
    function entries() {
      const out = new Map();
      for (const t of d.templates.filter((x) => !x.creating && !x.missing)) {
        for (const id of (t.agents?.agents || []).filter((x) => x !== 'terminal')) if (!out.has(id)) out.set(id, { id, template: t.id });
      }
      for (const src of d.sources || []) {
        for (const id of src.agents) {
          const e = out.get(id);
          if (e?.template) continue;
          const cand = { id, machine: src.name, state: src.state, preparing: src.job ? src.job.step : null,
            blocker: src.blocker || (!src.installed ? 'агенты в машине ещё устанавливаются' : null) };
          // Prefer a machine that can be used: preparing, then usable, then blocked.
          const rank = (x) => (x.preparing ? 0 : x.blocker ? 2 : 1);
          if (!e || rank(cand) < rank(e)) out.set(id, cand);
        }
      }
      return [...out.values()];
    }
    function draw() {
      const list = entries();
      if (!list.some((e) => e.id === agent)) agent = list.find((e) => e.id === want)?.id || list.find((e) => e.template)?.id || list[0]?.id || null;
      const cur = list.find((e) => e.id === agent) || null;
      onChange({ agent, template: cur?.template || null });
      const tiles = h('div', { class: 'ws-agents', role: 'radiogroup', 'aria-label': 'Агент' }, ...list.map((e) => h('button', {
        type: 'button', role: 'radio', 'aria-checked': String(e.id === agent), class: `ws-agent${e.id === agent ? ' on' : ''}${e.template ? '' : ' prep'}`,
        onclick: () => { agent = e.id; want = e.id; draw(); },
      }, mark(titles()[e.id]?.mark || MARKS[e.id] || 'term', true), h('span', { class: 'ag-tile-text' }, h('span', {}, titleOf(e.id)),
        e.template ? null : h('span', { class: 'ag-tile-sub' }, e.preparing ? 'готовится…' : e.blocker ? 'недоступен' : 'нужна подготовка')))));
      let note = null;
      if (!list.length) {
        note = h('div', { class: 'ag-prep' }, h('b', {}, 'Пока нет ни одного агента'),
          h('span', {}, 'Нажмите «Создать агента» во вкладке «Агенты»: там можно создать машину с агентом из пресета.'));
      } else if (cur && !cur.template) {
        if (cur.preparing) {
          note = h('div', { class: 'ag-prep' }, h('b', {}, h('i', { class: 'spin' }), ` ${titleOf(cur.id)} готовится: ${cur.preparing}`),
            h('span', {}, 'Обычно 1–3 минуты. Можно подождать здесь — кнопка запуска включится сама.'));
        } else if (cur.blocker) {
          note = h('div', { class: 'ag-prep bad' }, h('b', {}, `${titleOf(cur.id)} из машины ${cur.machine} подготовить нельзя`), h('span', {}, cur.blocker));
        } else {
          const btn = h('button', { class: 'btn ink', type: 'button' }, 'Подготовить');
          btn.addEventListener('click', async () => {
            btn.disabled = true; btn.replaceChildren(h('i', { class: 'spin' }), 'Запускаю подготовку…');
            try { await api('POST', '/ui/sandbox/templates', { source: cur.machine, title: titleOf(cur.id) }); }
            catch (e) { toast(e.message, 'err', 12000); btn.disabled = false; btn.replaceChildren('Подготовить'); return; }
            await refresh();
          });
          note = h('div', { class: 'ag-prep' },
            h('b', {}, `${titleOf(cur.id)} ещё не подготовлен для чистых запусков`),
            h('span', {}, `Сделаю снимок вашей машины ${cur.machine}: из него каждая задача будет открываться в чистой копии за секунды. `,
              `Машина ${cur.state === 'running' ? 'перезапустится' : 'ненадолго запустится'} (1–3 минуты). `,
              h('b', {}, 'Всё, что в ней есть — вход в агента, файлы, — попадёт в каждую копию.')),
            btn);
        }
      }
      box.replaceChildren(tiles, note || '');
      clearTimeout(timer);
      if (list.some((e) => e.preparing)) timer = setTimeout(refresh, 3000);
    }
    async function refresh() {
      if (!box.isConnected) return; // the dialog is closed
      try { d = await api('GET', '/ui/sandbox'); } catch { return; }
      draw();
    }
    box.set = (id) => { want = id; agent = id; draw(); };
    draw();
    return box;
  };

  // «Рабочие места» became «Агенты»: the old address leads here.
  pages.work = { render() { location.replace('#/agents'); return null; } };

  window.agentUi = { TRUST, trustPicker };
  window.agentsLaunch = (preset) => (data ? launch(preset) : load().then(() => launch(preset)));
  pages.agents = {
    render(el, p) {
      root = el;
      // Links of the guide: #/agents?create=machine|template|task open «Создать агента» on that step.
      const step = p?.get('create');
      if (step) { history.replaceState(null, '', '#/agents'); setTimeout(() => create(step), 0); }
      fill(el, h('p', { class: 'muted' }, 'Загрузка…'));
      detailsAt = 0;
      load().then(() => { lastSig = ''; render(); }).catch((e) => fill(el, h('div', { class: 'error' }, e.message)));
      timer = setInterval(poll, 3000);
      return () => { clearInterval(timer); root = null; };
    },
  };
})();
