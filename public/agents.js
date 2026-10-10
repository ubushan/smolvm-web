'use strict';
// Page «Агенты» (#/agents): the start page of the simple mode. Every workspace is an
// agent «on staff»: what it sees, where it goes, which keys it holds — in plain words.
// «Дать задачу» opens a sandbox with a task, a project folder and one trust level.

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

  const AGENTS = { terminal: 'Терминал', claude: 'Claude Code', opencode: 'OpenCode', 'opencode-tui': 'OpenCode TUI', dsh: 'Harness', codex: 'Codex', pi: 'Pi', hermes: 'Hermes' };
  const MARKS = { claude: 'claude', opencode: 'opencode', 'opencode-tui': 'opencode', dsh: 'dsh', codex: 'codex', pi: 'pi', hermes: 'hermes' };
  const TRUST = {
    careful: { title: 'Осторожно', hint: 'Для незнакомого кода и экспериментов', lines: ['Проект — копия, на диск ничего без вашей проверки', 'Интернет — только API модели и то, что вы разрешите', 'Неизвестные адреса — запрещены', 'Закроется сама через 2 часа'] },
    normal: { title: 'Обычно', hint: 'Для работы над своими проектами', lines: ['Проект — копия, изменения после проверки', 'Интернет — разрешённые сайты шаблона', 'Новые адреса — спросит вас', 'Опасные вызовы API — с подтверждения'] },
    trusted: { title: 'Доверяю', hint: 'Только для агентов, которым вы полностью доверяете', lines: ['Проект — копия, применяете одной кнопкой', 'Интернет — без ограничений', 'Ничего не спрашивает', 'Не давайте вместе с ключами клиентов'] },
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
  function sees(x, t) {
    if (x) {
      const f = folders[x.name] || [];
      if (!f.length) return 'Только свою чистую машину — ваших папок нет';
      return f.slice(0, 3).map((y) => `${short(y.hostPath).length > 36 ? `…/${short(y.hostPath).split(/[\\/]/).filter(Boolean).slice(-2).join('/')}` : short(y.hostPath)} (${{ review: 'копия', rw: 'запись', ro: 'чтение' }[y.level] || y.level})`).join(', ') + (f.length > 3 ? ` +${f.length - 3}` : '');
    }
    return t ? 'Только свою чистую машину, пока вы не дадите папку' : 'Шаблон машины не выбран';
  }
  function goes(x, t) {
    const r = x && risk[x.name];
    if (r) return [{ open: 'bad', limited: 'ok', none: 'ok' }[r.untrustedLevel] || 'neutral', r.untrustedWhy];
    if (x) {
      const trust = TRUST[x.trust];
      if (trust) return [x.trust === 'trusted' ? 'bad' : 'ok', trust.lines[1]];
    }
    const e = t?.egress;
    if (!t) return ['neutral', '—'];
    if (!e || !e.enabled) return ['bad', 'Куда угодно в интернете'];
    const names = (e.lists || []).map((id) => lists[id]).filter(Boolean);
    return ['ok', `Только разрешённое${names.length ? `: ${names.slice(0, 3).join(', ')}` : ''}${e.rules?.length ? ` + ${e.rules.length} адресов` : ''}`];
  }
  function keys(x, t) {
    const r = x && risk[x.name];
    const names = r ? r.privateData.filter((s) => s.startsWith('секрет ')).map((s) => s.slice(7)) : (t?.secrets || []);
    return names.length ? names.slice(0, 4).join(', ') + (names.length > 4 ? ` +${names.length - 4}` : '') : 'Нет';
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
    const tpls = ready();
    if (!tpls.length) { location.hash = expertMode() ? '#/sandbox?tab=templates' : '#/agents'; toast('Сначала нужен шаблон машины', 'err'); return; }
    const prof = data.profiles.find((p) => p.id === preset.profile) || null;
    const tplFor = (p) => (p?.template && tplOf(p.template) && !tplOf(p.template).missing ? p.template : tpls[0].id);
    let profile = prof?.id || '';
    let tpl = tplFor(prof);
    let agent = prof ? agentFor(prof) : agentsOf(tplOf(tpl))[0] || null;
    let trust = 'normal';
    try { trust = TRUST[localStorage.getItem(TRUST_KEY)] ? localStorage.getItem(TRUST_KEY) : 'normal'; } catch {}

    const task = h('textarea', { class: 'input ag-task', id: 'ag-task', rows: 3, maxlength: 4000, placeholder: 'Например: добавь эндпоинт /health и тест к нему' });
    const folder = h('input', { class: 'input mono', id: 'ag-folder', list: 'ag-folder-list', placeholder: 'Необязательно: папка проекта, например ~/projects/api', autocomplete: 'off', spellcheck: 'false' });
    const dl = h('datalist', { id: 'ag-folder-list' });
    const folderNote = h('div', { class: 'muted small' });
    let sugT = null;
    folder.addEventListener('input', () => {
      clearTimeout(sugT);
      sugT = setTimeout(async () => {
        try { dl.replaceChildren(...((await api('GET', `/ui/folders/suggest?q=${enc(folder.value)}`)).paths || []).map((p) => h('option', { value: p }))); } catch {}
      }, 200);
    });
    const who = h('select', { class: 'input', id: 'ag-who' }, h('option', { value: '' }, 'Новый агент — ничего не запоминать'),
      data.profiles.map((p) => h('option', { value: p.id }, p.name)));
    who.value = profile;
    const agentsBox = h('div', { class: 'ws-agents', role: 'radiogroup', 'aria-label': 'Агент' });
    const drawAgents = () => {
      const ids = agentsOf(tplOf(tpl));
      if (!ids.includes(agent)) agent = ids[0] || null;
      agentsBox.replaceChildren(...(ids.length ? ids.map((id) => h('button', {
        type: 'button', role: 'radio', 'aria-checked': String(id === agent), class: `ws-agent${id === agent ? ' on' : ''}`,
        onclick: () => { agent = id; drawAgents(); },
      }, mark(MARKS[id] || 'term', true), h('span', {}, AGENTS[id] || id))) : [h('div', { class: 'muted small' }, 'В шаблоне нет агентов — откроется только машина.')]));
    };
    who.addEventListener('change', () => {
      profile = who.value;
      const p = data.profiles.find((y) => y.id === profile);
      tpl = tplFor(p);
      if (p) agent = agentFor(p);
      drawAgents();
    });
    drawAgents();
    const drawFolderNote = () => {
      folderNote.textContent = 'Агент получит копию папки. Изменения попадут на диск только после вашей проверки в «Решениях».';
    };
    drawFolderNote();
    const trustBox = trustPicker(trust, (id) => { trust = id; drawFolderNote(); });

    let inTab = false;
    try { inTab = localStorage.getItem('smolvm.agentTab') === '1'; } catch {}
    const tabBox = h('input', { type: 'checkbox', id: 'ag-tab', checked: inTab });
    const go = h('button', { class: 'btn primary ag-go' }, ic('play'), 'Запустить');
    const dlg = dialog(prof ? `Задача для «${prof.name}»` : 'Дать задачу агенту', [
      h('label', { class: 'ws-field', for: 'ag-task' }, 'Что сделать', task),
      h('label', { class: 'ws-field', for: 'ag-folder' }, 'Над каким проектом', folder, dl, folderNote),
      h('div', { class: 'ag-two' },
        prof ? null : h('label', { class: 'ws-field', for: 'ag-who' }, 'Кто', who),
        h('div', { class: 'ws-field' }, h('div', { class: 'label-like' }, 'Агент'), agentsBox)),
      h('div', { class: 'ws-field' }, h('div', { class: 'label-like' }, 'Насколько вы ему доверяете'), trustBox),
      h('label', { class: 'ag-check', for: 'ag-tab' }, tabBox, h('span', {}, 'Открыть агента в отдельной вкладке браузера',
        h('span', { class: 'muted small' }, ' — здесь останется контроль: запросы, действия, изменения'))),
      go,
      h('div', { class: 'muted small ws-center' }, 'Каждый раз чистая машина. Тонкая настройка — в «Режиме эксперта».'),
    ], 'ws-dialog ag-dialog');
    go.addEventListener('click', async () => {
      const f = folder.value.trim();
      // The tab is opened right away, while the click still counts: later the browser blocks it.
      const wantTab = tabBox.checked && !!agent;
      const tab = wantTab ? agentTab() : null;
      const cancel = () => { if (tab) tab.close(); };
      if (f) {
        const c = await api('GET', `/ui/folders/check?path=${enc(f)}`).catch((e) => ({ ok: false, error: e.message }));
        if (!c.ok) { cancel(); toast(`${c.real || f}: ${c.error}`, 'err', 10000); folder.focus(); return; }
      }
      if (trust === 'trusted') {
        const c = await confirmDialog('Без ограничений сети?', 'Агент сможет ходить куда угодно в интернете и ничего не будет спрашивать. Всё, что он увидит в проекте, он сможет отправить наружу.', false, '', 'Да, доверяю');
        if (!c.ok) { cancel(); return; }
      }
      try { localStorage.setItem(TRUST_KEY, trust); localStorage.setItem('smolvm.agentTab', tabBox.checked ? '1' : '0'); } catch {}
      go.disabled = true; go.replaceChildren(h('i', { class: 'spin' }), 'Запускается…');
      try {
        const r = await api('POST', '/ui/sandbox/open', { template: tpl, profile: profile || null, agent, trust, task: task.value.trim() || null, folder: f || null });
        dlg.close();
        // A blocked tab: goAgent tries again and, if blocked, shows a link to it.
        if (wantTab && r.url) { agentInTab(r.name, true); goAgent(tab, r.url); } else cancel();
        toast(wantTab ? 'Агент запущен в отдельной вкладке' : 'Агент запущен', 'ok');
        refreshMachines();
        location.hash = `#/session?name=${enc(r.name)}`;
      } catch (e) {
        cancel();
        toast(e.message, 'err', 12000);
        go.disabled = false; go.replaceChildren(ic('play'), 'Запустить');
      }
    });
    setTimeout(() => task.focus(), 0);
  }

  // ---------- render ----------
  function row(label, value, tone) {
    return h('div', { class: 'ag-row' }, h('span', { class: 'ag-row-label' }, label), h('span', { class: `ag-row-value${tone ? ` ${tone}` : ''}` }, value));
  }

  function card({ p, x, t }) {
    const agent = p ? agentFor(p) : x.agent || x.agents?.find((a) => a.id !== 'terminal')?.id;
    const st = status(x);
    const [tone, where] = goes(x, t);
    const r = x && risk[x.name];
    const live = x && x.state === 'running' && !x.opening;
    const title = p ? p.name : 'Разовая задача';
    const sub = [AGENTS[agent] || 'без агента', x?.trust ? `доверие: ${TRUST[x.trust]?.title.toLowerCase()}` : null].filter(Boolean).join(' · ');
    return h('article', { class: `ag-card${x ? ' live' : ''}${st[0] === 'warn' ? ' asks' : ''}` },
      h('div', { class: 'ag-head' },
        mark(MARKS[agent] || 'vm'),
        h('div', { class: 'ag-title' }, h('b', {}, title), h('span', { class: 'muted small' }, sub)),
        h('span', { class: `ag-pill ${st[0]}` }, st[0] === 'busy' ? h('i', { class: 'spin' }) : null, st[1])),
      x?.task ? h('div', { class: 'ag-task-line', title: x.task }, `«${x.task}»`) : null,
      h('div', { class: 'ag-rows' },
        row('Видит', sees(x, t)),
        row('Ходит', where, tone === 'bad' ? 'badc' : ''),
        row('Ключи', keys(x, t))),
      r?.lethal ? h('div', { class: 'ag-warn' }, 'Есть и ваши данные, и выход в интернет — агент может их отправить наружу.') : null,
      h('div', { class: 'ag-actions' },
        x
          ? [h('button', { class: 'btn primary', disabled: !!x.opening, onclick: () => openSession(x) }, 'Открыть'),
            h('button', { class: 'btn ghost icon', disabled: !live || !!isolated[x.name], title: 'Открыть агента в отдельной вкладке браузера', 'aria-label': 'Открыть агента в отдельной вкладке', onclick: () => openTab(x) }, ic('external')),
            h('button', { class: 'btn', disabled: !!x.opening, onclick: () => stop(x) }, 'Остановить'),
            live && r && r.untrustedLevel === 'open' ? h('button', { class: 'btn ghost', title: 'Включить фильтр сети: новые адреса — только с вашего разрешения', onclick: () => safer(x) }, ic('shield'), 'Сделать безопаснее') : null]
          : [h('button', { class: 'btn ink', onclick: () => launch({ profile: p.id }) }, ic('play'), 'Дать задачу'),
            h('a', { class: 'btn ghost', href: `#/profile?id=${enc(p.id)}`, title: 'Инструкции, MCP, skills и память агента' }, 'Что он знает')]));
  }

  function render() {
    if (!root || !data) return;
    const y = root.scrollTop;
    const head = h('div', { class: 'ws-head' },
      h('div', { class: 'ws-head-text' },
        h('h1', {}, 'Агенты'),
        h('p', { class: 'muted' }, 'Каждый агент работает в своей чистой машине. Здесь видно, что он видит, куда ходит и какие ключи у него есть.')),
      h('button', { class: 'btn', onclick: () => launch() }, ic('play'), 'Разовая задача'),
      h('button', { class: 'btn primary', onclick: () => (window.workActions ? window.workActions.newWorkspace(() => refresh()) : (location.hash = '#/work')) }, ic('plus'), 'Нанять агента'));

    const tpls = ready();
    const jobs = data.templates.filter((t) => t.job?.status === 'running');
    if (!tpls.length) {
      fill(root, head, h('section', { class: 'card ws-empty' }, ic('server'),
        h('h3', {}, jobs.length ? 'Готовлю машину для агентов…' : 'Сначала нужна машина для агентов'),
        h('p', { class: 'muted' }, jobs.length ? jobs.map((t) => `${t.title}: ${t.job.step}`).join('; ') : 'Это снимок машины с установленными агентами. Из него за секунды открываются чистые машины для каждой задачи.'),
        jobs.length ? null : h('a', { class: 'btn primary', href: '#/sandbox?tab=templates', onclick: () => { try { localStorage.setItem('smolvm.mode', 'expert'); } catch {} applyMode(); } }, 'Подготовить')));
      root.scrollTop = y;
      return;
    }

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
          h('p', { class: 'muted' }, 'Наймите агента — например «Бэкенд» с Claude Code — или дайте разовую задачу.'),
          h('button', { class: 'btn primary', onclick: () => launch() }, ic('play'), 'Дать задачу')));
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
      data.templates.map((t) => [t.id, t.job?.step]), data.pending.length, approvals.map((a) => a.id), Object.keys(isolated), risk, folders]);
    if (sig === lastSig) return;
    lastSig = sig;
    render();
  }

  window.agentsLaunch = (preset) => (data ? launch(preset) : load().then(() => launch(preset)));
  pages.agents = {
    render(el) {
      root = el;
      fill(el, h('p', { class: 'muted' }, 'Загрузка…'));
      detailsAt = 0;
      load().then(() => { lastSig = ''; render(); }).catch((e) => fill(el, h('div', { class: 'error' }, e.message)));
      timer = setInterval(poll, 3000);
      return () => { clearInterval(timer); root = null; };
    },
  };
})();
