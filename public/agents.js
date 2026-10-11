'use strict';
// Section «Агенты» (#/agents, the start page): agents on the left, the chosen one on the
// right — «Обзор» (network, directories, secrets), «Сессии» (its sandboxes; the programs in
// them open in a browser tab), «Решения» (what it waits for). «Создать агента» and the
// gear open agentwizard.js; «Дать задачу» opens a sandbox with a task.

(() => {
  let root = null;
  let data = null;       // GET /ui/sandbox
  let approvals = [];    // GET /ui/live
  let isolated = {};
  let lists = {};        // egress list id -> name
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
  }

  // ---------- actions ----------
  async function stop(x) {
    const c = await confirmDialog('Остановить агента?', x.profile
      ? 'Машина будет удалена. То, что агент запомнил, уйдёт к вам на проверку в «Решения». Изменения в проекте можно проверить там же, пока машина работает — после остановки копия проекта пропадёт.'
      : 'Машина будет удалена вместе со всем, что агент сделал внутри.', false, '', 'Остановить');
    if (!c.ok) return;
    try {
      const r = await api('POST', `/ui/sandbox/machines/${enc(x.name)}/close`, { save: !!x.profile });
      refreshMachines();
      agentInTab(x.name, false);
      if (r.pending) { toast(`Агент остановлен. Изменений на проверку: ${r.changes}`, 'ok', 8000); location.hash = `#/agents?id=${enc(x.profile)}&tab=decisions`; return; }
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

  // ---------- render: the list on the left, the chosen agent on the right ----------
  let selected = '';     // profile id
  let tab = 'overview';  // overview | sessions | decisions
  let vault = [];        // GET /ui/vault — secrets with their modes
  let vaultAt = 0;
  let copies = {};       // sandbox -> [{ dir, changes }] (review copies with changes)
  let copiesAt = 0;
  const NET = { strict: 'Только разрешённое — с жёсткой изоляцией: обойти фильтр нельзя', soft: 'Только разрешённое — без изоляции: фильтр через прокси', off: 'Без ограничений — как этот компьютер' };

  async function loadSlow() {
    if (Date.now() - vaultAt > 15000) {
      vaultAt = Date.now();
      try { vault = (await api('GET', '/ui/vault')).secrets || []; } catch {}
    }
    if (tab === 'decisions' && Date.now() - copiesAt > 10000) {
      copiesAt = Date.now();
      const mine = data.sandboxes.filter((x) => x.profile === selected && x.state === 'running');
      const out = {};
      await Promise.all(mine.map(async (x) => {
        const r = await api('GET', `/ui/machines/${enc(x.name)}/review`).catch(() => null);
        out[x.name] = (await Promise.all((r?.dirs || []).filter((d) => d.state === 'ready').map(async (dir) =>
          ({ dir, changes: (await api('GET', `/ui/machines/${enc(x.name)}/review/${enc(dir.id)}`).catch(() => null))?.changes || [] })))).filter((c) => c.changes.length);
      }));
      copies = out;
    }
  }

  const sessionsOf = (p) => data.sandboxes.filter((x) => x.profile === p.id);
  const asksOf = (p) => {
    const names = new Set(sessionsOf(p).map((x) => x.name));
    return approvals.filter((a) => names.has(a.machine));
  };
  const imageOf = (p) => (p.preset ? data.images?.[p.preset]?.[(p.net || 'strict') === 'strict' ? 'isolated' : 'plain'] : null);
  // The state of an agent in a word or two, for the list and the head.
  function agentState(p) {
    const open = sessionsOf(p);
    if (asksOf(p).length) return ['warn', 'ждёт ответа'];
    if (open.some((x) => x.opening)) return ['busy', open.find((x) => x.opening).opening];
    if (open.length) return ['ok', open.length > 1 ? `работает · ${open.length}` : 'работает'];
    const img = imageOf(p);
    if (p.preset && !img?.template) return img?.job?.status === 'running' ? ['busy', 'готовится образ'] : ['neutral', 'образ не готов'];
    return ['neutral', 'спит'];
  }
  const programOf = (p) => AGENTS[p.agent] || data.agentTitles?.[p.agent]?.title || p.agent || '—';

  function listPanel() {
    const items = data.profiles.map((p) => {
      const [tone, text] = agentState(p);
      return h('div', { class: `machine ag-item${p.id === selected ? ' active' : ''}${tone === 'ok' ? ' running' : ''}`, role: 'button', tabindex: '0',
        onclick: () => go(p.id), onkeydown: (e) => { if (e.key === 'Enter') go(p.id); } },
        mark(MARKS[p.agent] || 'vm', true),
        h('div', { class: 'name' }, p.name),
        h('span', { class: `ag-pill ${tone}` }, tone === 'busy' ? h('i', { class: 'spin' }) : null, text),
        h('div', { class: 'meta' }, [programOf(p), TRUST[p.trust]?.title].filter(Boolean).join(' · ')));
    });
    return h('section', { class: 'panel list-panel' },
      h('div', { class: 'panel-head' }, h('h2', { class: 'h-ic' }, ic('bot'), 'Агенты'), guideButton(),
        h('button', { class: 'btn primary icon', title: 'Создать агента', 'aria-label': 'Создать агента', onclick: () => create() }, ic('plus'))),
      h('div', { class: 'machines' }, ...(items.length ? items : [h('div', { class: 'list-empty' }, 'Агентов пока нет.', h('br'), h('br'),
        h('button', { class: 'btn primary', onclick: () => create() }, 'Создать первого'))])));
  }

  // ---------- «Обзор»: network, directories, secrets ----------
  function overview(p) {
    const t = tplOf(p.template);
    const edit = (step) => h('button', { class: 'btn ghost small-btn', onclick: () => agentWizard({ profile: p.id, step, onDone: () => refresh() }) }, 'Изменить');
    const card = (icon, title, step, ...body) => h('section', { class: 'card ag-ov' },
      h('div', { class: 'card-head' }, h('h3', { class: 'h-ic' }, ic(icon), title), h('span', { class: 'spacer' }), edit(step)), ...body);
    const net = p.net || (t?.egress?.enabled ? (t.egress.strict ? 'strict' : 'soft') : t ? 'off' : null);
    const listIds = p.net ? (p.lists || []) : (t?.egress?.lists || []);
    const unknown = { careful: 'запрещены, без вопросов', normal: 'агент спросит вас', trusted: 'пропускаются без вопросов' }[p.trust] || '—';
    const life = [p.idleMinutes ? `после ${p.idleMinutes} мин простоя` : null, p.ttlHours ? `через ${p.ttlHours} ч` : p.trust === 'careful' ? 'через 2 ч' : null].filter(Boolean).join(', ') || 'только кнопкой «Закончить»';
    const netCard = card('globe', 'Сеть', 'net',
      h('div', { class: 'kv' },
        h('div', {}, h('div', { class: 'k' }, 'Режим'), h('div', { class: 'v' }, NET[net] || '—')),
        h('div', {}, h('div', { class: 'k' }, 'Неизвестные адреса'), h('div', { class: 'v' }, `${TRUST[p.trust]?.title || '—'}: ${unknown}`)),
        h('div', {}, h('div', { class: 'k' }, 'Песочница удаляется'), h('div', { class: 'v' }, life))),
      net === 'off' ? h('p', { class: 'muted small' }, 'Белые списки не нужны: фильтр выключен.')
        : h('div', { class: 'ws-field' }, h('div', { class: 'label-like' }, 'Белые списки'),
          listIds.length ? h('div', { class: 'chips' }, ...listIds.map((id) => h('a', { class: 'chip', href: '#/egress?tab=lists' }, lists[id] || id)))
            : h('span', { class: 'muted small' }, 'Не подключено ни одного — только серверы самого агента.')));
    const dirs = p.folders?.length ? p.folders : p.folder ? [{ hostPath: p.folder, mode: 'review' }] : [];
    const dirCard = card('folder', 'Директории', 'dirs',
      dirs.length ? h('div', { class: 'ag-rowsl' }, ...dirs.map((f) => h('div', { class: 'ag-dir' }, ic('folder'),
        h('span', { class: 'mono ellipsis', title: f.hostPath }, short(f.hostPath)),
        h('span', { class: `tag ${f.mode === 'ro' ? 'ok' : 'accent'}` }, f.mode === 'ro' ? 'только чтение' : 'копия с проверкой'))))
        : h('p', { class: 'muted small' }, 'Агенту не дано ни одной папки компьютера.'),
      h('p', { class: 'muted small' }, 'В каждой сессии — свежая копия папки; на диск изменения попадают только после вашей проверки.'));
    const names = Array.isArray(p.secrets) ? p.secrets : (t?.secrets || []);
    const secCard = card('key', 'Секреты', 'secrets',
      names.length ? h('div', { class: 'ag-rowsl' }, ...names.map((n) => {
        const x = vault.find((v) => v.name === n);
        return h('div', { class: 'ag-dir' }, ic('key'), h('b', { class: 'mono' }, n),
          x ? h('span', { class: 'muted small ellipsis' }, x.mode === 'gateway' ? `через шлюз → ${x.upstream}` : x.mode === 'substitute' ? `подстановка: ${(x.hosts || []).join(', ')}` : `переменная ${x.envVar} — агент видит значение`)
            : h('span', { class: 'small badc' }, 'нет в хранилище'));
      })) : h('p', { class: 'muted small' }, 'Секретов нет.'),
      h('p', { class: 'muted small' }, 'Через шлюз агент пользуется ключом, но не видит его значения.'));
    const img = imageOf(p);
    const prog = h('section', { class: 'card ag-ov' },
      h('div', { class: 'card-head' }, h('h3', { class: 'h-ic' }, ic('box'), 'Программа'), h('span', { class: 'spacer' }), edit('program')),
      h('div', { class: 'kv' },
        h('div', {}, h('div', { class: 'k' }, 'Агент'), h('div', { class: 'v' }, programOf(p))),
        h('div', {}, h('div', { class: 'k' }, 'Образ'), h('div', { class: 'v' }, p.preset ? (img?.template ? `готов · ${tplOf(img.template)?.title || ''}` : img?.job?.status === 'running' ? `готовится: ${img.job.step}` : 'не готов — подготовится при запуске') : t ? `шаблон «${t.title}»` : '—')),
        h('div', {}, h('div', { class: 'k' }, 'Память'), h('div', { class: 'v' }, h('a', { href: `#/profile?id=${enc(p.id)}` }, `${p.files || 0} файлов — что он знает`)))));
    return [h('div', { class: 'ag-ov-grid' }, netCard, dirCard, secCard, prog)];
  }

  // ---------- «Сессии»: open sandboxes, their programs open in a browser tab ----------
  async function openProgram(x, id, btn) {
    const w = agentTab();
    if (btn) btn.disabled = true;
    try { goAgent(w, (await api('POST', `/ui/machines/${enc(x.name)}/agents/${enc(id)}/start`, {})).url); }
    catch (e) { if (w) w.close(); toast(e.message, 'err', 10000); }
    if (btn) btn.disabled = false;
  }
  function sessions(p) {
    const open = sessionsOf(p);
    if (!open.length) {
      return [h('section', { class: 'card ws-empty' }, ic('play'), h('h3', {}, 'Сессий сейчас нет'),
        h('p', { class: 'muted' }, 'Дайте агенту задачу — откроется чистая копия, и программы агента можно будет открыть отсюда.'),
        h('button', { class: 'btn primary', onclick: () => launch({ profile: p.id }) }, ic('play'), 'Дать задачу'))];
    }
    return open.map((x) => {
      const asks = approvals.filter((a) => a.machine === x.name).length;
      const busy = !!x.opening || x.state !== 'running' || !!isolated[x.name];
      const programs = (x.agents || []).map((a) => {
        const b = h('button', { type: 'button', class: 'aw-tile ag-prog', disabled: busy, title: `Открыть ${a.title || a.id} в отдельной вкладке браузера`,
          onclick: () => openProgram(x, a.id, b) },
          h('span', { class: 'aw-tile-ic' }, mark(a.mark || 'term')),
          h('span', { class: 'aw-tile-text' }, h('b', {}, a.title || AGENTS[a.id] || a.id), h('span', { class: 'muted small' }, 'открыть в новой вкладке ↗')));
        return b;
      });
      const [tone, text] = isolated[x.name] ? ['bad', 'остановлена вами'] : x.opening ? ['busy', x.opening] : asks ? ['warn', `ждёт ответа: ${asks}`] : x.state === 'running' ? ['ok', 'работает'] : ['neutral', x.state];
      return h('section', { class: 'card ag-sess' },
        h('div', { class: 'card-head' },
          h('div', { class: 'ag-title' }, h('b', { class: 'mono' }, x.name),
            h('span', { class: 'muted small' }, [`открыта ${ago(x.createdAt)} назад`, x.expiresAt ? `закроется через ${Math.max(0, Math.round((x.expiresAt - Date.now()) / 60000))} мин` : null].filter(Boolean).join(' · '))),
          h('span', { class: 'spacer' }), h('span', { class: `ag-pill ${tone}` }, tone === 'busy' ? h('i', { class: 'spin' }) : null, text)),
        x.task ? h('div', { class: 'ag-task-line', title: x.task }, `«${x.task}»`) : null,
        h('div', { class: 'label-like' }, 'Программы в песочнице'),
        h('div', { class: 'aw-tiles' }, ...programs),
        h('div', { class: 'ag-actions' },
          h('a', { class: 'btn', href: `#/session?name=${enc(x.name)}` }, ic('list'), 'Контроль: что делает, что просит'),
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn primary', disabled: !!x.opening, onclick: () => stop(x) }, 'Закончить и проверить')));
    });
  }

  // ---------- «Решения»: what this agent waits for ----------
  async function decide(a, decision) {
    try { await api('POST', `/ui/approvals/${a.id}`, { decision }); } catch (e) { toast(e.message, 'err'); }
    await refresh();
  }
  function decisions(p) {
    const asks = asksOf(p).map((a) => h('section', { class: 'dc-card' },
      h('div', { class: 'dc-meta' }, h('b', { class: 'mono' }, a.machine), h('span', {}, a.kind === 'net' ? 'хочет зайти на сайт' : 'хочет вызвать API')),
      h('div', { class: 'dc-title' }, h('span', { class: 'mono' }, a.title)),
      h('div', { class: 'dc-actions' },
        a.kind === 'net' ? [h('button', { class: 'btn ink', onclick: () => decide(a, 'always') }, 'Разрешить всегда'), h('button', { class: 'btn', onclick: () => decide(a, 'once') }, 'На 10 минут')]
          : h('button', { class: 'btn ink', onclick: () => decide(a, 'once') }, 'Разрешить'),
        h('button', { class: 'btn danger-outline', onclick: () => decide(a, 'deny') }, 'Запретить'))));
    const mem = data.pending.filter((x) => x.profile === p.id).map((x) => h('section', { class: 'dc-card row' },
      h('div', { class: 'dc-grow' }, h('div', { class: 'dc-meta' }, h('span', {}, 'хочет запомнить')),
        h('div', { class: 'dc-title' }, `${x.changes.length} изменений в памяти и настройках агента`)),
      h('a', { class: 'btn primary', href: `#/review?id=${enc(x.id)}` }, 'Посмотреть и решить')));
    const proj = Object.entries(copies).flatMap(([name, list]) => list.map((c) => h('section', { class: 'dc-card row' },
      h('div', { class: 'dc-grow' }, h('div', { class: 'dc-meta' }, h('b', { class: 'mono' }, name), h('span', {}, 'хочет записать изменения в проект')),
        h('div', { class: 'dc-title', title: c.dir.hostPath }, `${c.changes.length} файлов в ${short(c.dir.hostPath).split(/[\\/]/).pop()}`),
        c.dir.readonly ? h('div', { class: 'muted small' }, 'Папка дана только для чтения — на диск не записывается.') : null),
      c.dir.readonly ? null : h('a', { class: 'btn primary', href: `#/dirs?tab=folders&machine=${enc(name)}` }, 'Посмотреть и применить'))));
    const all = [...asks, ...mem, ...proj];
    return all.length ? all : [h('section', { class: 'card ws-empty' }, ic('shield'), h('h3', {}, 'Всё решено'),
      h('p', { class: 'muted' }, 'Когда агент попросит новый сайт, захочет что-то запомнить или записать в проект, вопрос появится здесь и во вкладке «Решения» песочницы.'))];
  }

  function detailPanel() {
    const p = data.profiles.find((x) => x.id === selected);
    if (!p) {
      return h('section', { class: 'panel detail-panel' }, h('div', { class: 'empty-state' }, h('div', { class: 'big' }, ic('bot')),
        h('p', {}, data.profiles.length ? 'Выберите агента слева.' : 'Создайте первого агента: программа, изоляция, директории и секреты — в одном окне.'),
        h('button', { class: 'btn primary', onclick: () => create() }, ic('plus'), 'Создать агента')));
    }
    const [tone, text] = agentState(p);
    const nAsk = asksOf(p).length + data.pending.filter((x) => x.profile === p.id).length;
    const TABS = [['overview', 'Обзор', 0], ['sessions', 'Сессии', sessionsOf(p).length], ['decisions', 'Решения', nAsk]];
    const body = { overview, sessions, decisions }[tab](p);
    return h('section', { class: 'panel detail-panel' },
      h('div', { class: 'detail-head' },
        mark(MARKS[p.agent] || 'vm'),
        h('div', { class: 'ag-title' }, h('h2', {}, p.name), h('span', { class: 'muted small' }, [programOf(p), TRUST[p.trust] ? `доверие: ${TRUST[p.trust].title.toLowerCase()}` : null].filter(Boolean).join(' · '))),
        h('span', { class: `ag-pill ${tone}` }, tone === 'busy' ? h('i', { class: 'spin' }) : null, text),
        h('div', { class: 'actions' },
          h('button', { class: 'btn primary', onclick: () => launch({ profile: p.id }) }, ic('play'), 'Дать задачу'),
          h('button', { class: 'btn ghost icon', title: 'Настройки агента', 'aria-label': 'Настройки агента', onclick: () => agentWizard({ profile: p.id, onDone: () => refresh() }) }, ic('gear')),
          h('button', { class: 'btn ghost icon danger', title: sessionsOf(p).length ? 'Сначала закончите его сессии' : 'Удалить агента', 'aria-label': 'Удалить агента', disabled: sessionsOf(p).length > 0, onclick: () => removeAgent(p) }, ic('trash')))),
      h('nav', { class: 'tabs' }, ...TABS.map(([id, label, n]) => h('button', { class: `tab${tab === id ? ' active' : ''}`, onclick: () => { tab = id; copiesAt = 0; sync(); refresh(); } },
        label, n ? h('span', { class: `nav-count${id === 'decisions' ? ' attn' : ''}` }, String(n)) : null))),
      h('div', { class: 'tab-body' }, ...body));
  }

  function sync() { history.replaceState(null, '', `#/agents?id=${enc(selected)}${tab !== 'overview' ? `&tab=${tab}` : ''}`); }
  function go(id) { selected = id; sync(); render(); }

  function render() {
    if (!root || !data) return;
    if (!data.profiles.some((p) => p.id === selected)) selected = data.profiles[0]?.id || '';
    const scroll = root.querySelector('.tab-body')?.scrollTop || 0;
    fill(root, h('div', { class: 'layout ag-layout' }, listPanel(), detailPanel()));
    const tb = root.querySelector('.tab-body');
    if (tb) tb.scrollTop = scroll;
  }

  async function refresh() {
    try { await load(); await loadSlow(); } catch { return; }
    lastSig = ''; render();
  }

  async function poll() {
    if (!root || document.hidden || document.querySelector('dialog[open]')) return;
    try { await load(); await loadSlow(); } catch { return; }
    const sig = JSON.stringify([selected, tab, data.sandboxes.map((x) => [x.name, x.state, x.opening, x.profile]), data.profiles.map((p) => [p.id, p.updatedAt, p.files]),
      data.images, data.pending.map((x) => [x.id, x.profile]), approvals.map((a) => a.id), Object.keys(isolated), vault.map((v) => [v.name, v.mode]), copies, Math.floor(Date.now() / 60000)]);
    if (sig === lastSig) return;
    lastSig = sig;
    render();
  }

  // ---------- «Песочница»: the panel on the left, shared by sessions, templates and decisions ----------
  // active: { kind: 'session' | 'template' | 'decisions' | 'new-template', id }. live: approvals (optional).
  window.sandboxSide = function sandboxSide(d, active, live = window.liveApprovalsList || []) {
    const asksAll = (window.liveApprovals || 0) + d.pending.length;
    const item = ({ on, href, icon, name, sub, pill, cls = '' }) => h('a', { class: `machine ag-item sb-item${on ? ' active' : ''} ${cls}`, href },
      icon, h('div', { class: 'name' }, name), pill || h('span'), h('div', { class: 'meta' }, sub || ''));
    const pillOf = (tone, text) => h('span', { class: `ag-pill ${tone}` }, tone === 'busy' ? h('i', { class: 'spin' }) : null, text);
    const sessions = d.sandboxes.map((x) => {
      const prof = d.profiles.find((p) => p.id === x.profile);
      const asks = live.filter((a) => a.machine === x.name).length;
      const tone = x.opening ? ['busy', 'открывается'] : asks ? ['warn', 'ждёт ответа'] : x.state === 'running' ? ['ok', 'работает'] : ['neutral', x.state === 'missing' ? 'пропала' : 'на паузе'];
      const mins = Math.max(0, Math.round((Date.now() - x.createdAt) / 60000));
      return item({ on: active.kind === 'session' && active.id === x.name, href: `#/session?name=${enc(x.name)}`,
        icon: mark(MARKS[x.agent] || 'vm', true), name: prof ? prof.name : 'Разовая задача',
        sub: [AGENTS[x.agent] || x.agent, mins < 60 ? `${mins} мин` : `${Math.floor(mins / 60)} ч`].filter(Boolean).join(' · '), pill: pillOf(...tone), cls: tone[0] === 'ok' ? 'running' : '' });
    });
    const templates = d.templates.map((t) => {
      const running = t.creating || t.job?.status === 'running' || t.upgrade?.status === 'running';
      const tone = running ? ['busy', 'готовится'] : t.missing || t.job?.status === 'error' ? ['bad', 'ошибка'] : t.updates?.length ? ['warn', 'есть обновление'] : ['neutral', 'готов'];
      return item({ on: active.kind === 'template' && active.id === t.id, href: `#/sandbox?id=${enc(t.id)}`,
        icon: h('span', { class: 'mark m-icon m-list' }, ic('box')), name: t.title,
        sub: t.auto ? 'образ программы' : `из машины ${t.source}`, pill: pillOf(...tone) });
    });
    return h('section', { class: 'panel list-panel' },
      h('div', { class: 'panel-head' }, h('h2', { class: 'h-ic' }, ic('box'), 'Песочница')),
      h('div', { class: 'machines' },
        item({ on: active.kind === 'decisions', href: '#/decisions', icon: h('span', { class: 'mark m-icon m-list' }, ic('shield')), name: 'Решения',
          sub: 'что ждёт вашего ответа', pill: asksAll ? h('span', { class: 'nav-count attn' }, String(asksAll)) : null }),
        h('div', { class: 'sb-group' }, 'Сессии', h('span', { class: 'muted' }, String(d.sandboxes.length))),
        ...(sessions.length ? sessions : [h('div', { class: 'sb-empty muted small' }, 'Сейчас никто не работает. «Дать задачу» — в разделе «Агенты».')]),
        h('div', { class: 'sb-group' }, 'Шаблоны', h('span', { class: 'muted' }, String(d.templates.length))),
        ...templates,
        h('a', { class: `machine ag-item sb-item sb-add${active.kind === 'new-template' ? ' active' : ''}`, href: '#/sandbox?new=1' },
          h('span', { class: 'mark m-icon m-list' }, ic('plus')), h('div', { class: 'name' }, 'Новый шаблон'), h('span'), h('div', { class: 'meta' }, 'из машины с агентами'))));
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
      el.classList.add('page-agents');
      selected = p?.get('id') || selected;
      tab = ['overview', 'sessions', 'decisions'].includes(p?.get('tab')) ? p.get('tab') : 'overview';
      // Links of the guide: #/agents?create=… open «Создать агента» on that step.
      const step = p?.get('create');
      if (step) { history.replaceState(null, '', '#/agents'); setTimeout(() => create(step), 0); }
      fill(el, h('p', { class: 'muted' }, 'Загрузка…'));
      vaultAt = 0; copiesAt = 0;
      refresh().catch((e) => fill(el, h('div', { class: 'error' }, e.message)));
      timer = setInterval(poll, 3000);
      return () => { clearInterval(timer); el.classList.remove('page-agents'); root = null; };
    },
  };
})();
