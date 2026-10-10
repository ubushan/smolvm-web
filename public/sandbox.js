'use strict';
// Page «Песочницы»: a clean machine from a template on every open, with the
// agent profile (memory, skills, MCP, settings) carried over and reviewed.

(() => {
  let root = null;
  let data = null;   // GET /ui/sandbox
  let timer = null;
  let lastSig = '';
  const openPending = new Set(); // pending ids expanded

  const KIND = { added: ['ok', 'A', 'добавлен'], modified: ['warn', 'M', 'изменён'], deleted: ['bad', 'D', 'удалён'] };
  const ago = (ms) => fmtAgo(Math.floor(ms / 1000));
  const tplTitle = (id) => data.templates.find((t) => t.id === id)?.title || id;
  const profName = (id) => (id ? data.profiles.find((p) => p.id === id)?.name || id : 'без профиля');
  const card = (id, title, extra, ...children) => h('section', { class: 'card', id },
    h('div', { class: 'card-head' }, h('h3', {}, title), h('span', { class: 'spacer' }), ...[].concat(extra || [])), ...children);
  // Paths inside the profile, as the user knows them.
  const showPath = (p) => (p === '.smolvm-profile/claude-mcp.json' ? '~/.claude.json → mcpServers' : `~/${p}`);

  async function load() { data = await api('GET', '/ui/sandbox'); }

  // ---------- intro ----------
  // Sections of the page: a bar on top, like «Сеть» and «Директории».
  const SECTIONS = [
    ['open', 'box', 'Песочницы', 'Открыть чистую машину из шаблона и работать с агентом; закрыть — и изменения профиля уйдут на ревью.'],
    ['review', 'list', 'Ревью', 'Что агент поменял в профиле, пока работал. В профиль попадёт только то, что вы сохраните.'],
    ['profiles', 'users', 'Профили', 'Память, инструкции, skills, MCP-серверы и настройки агентов — то, что переезжает из песочницы в песочницу.'],
    ['templates', 'server', 'Шаблоны', 'Чекпоинты машин с установленными агентами: из них открываются песочницы.'],
  ];
  let section = 'open';
  let params = new URLSearchParams();
  let editing = null; // 'new-profile' | 'new-template' | profile id (files)
  const goSection = (id) => {
    section = id; editing = null;
    const q = new URLSearchParams(params); q.set('tab', id);
    history.replaceState(null, '', `#/sandbox?${q}`);
    render();
  };

  function intro() {
    const counts = { open: data.sandboxes.length, review: data.pending.length, profiles: data.profiles.length, templates: data.templates.length };
    return h('section', { class: 'card intro' },
      h('div', { class: 'row' }, h('h2', { class: 'h-ic' }, ic('box'), 'Песочницы'),
        helpButton('Как работают песочницы',
          h('p', {}, 'Песочница — одноразовая машина: каждое открытие начинается с чистого состояния шаблона, а при закрытии машина удаляется. Сохраняется только профиль агента: память, инструкции, skills, MCP-серверы и настройки.'),
          h('ul', {},
            h('li', {}, h('b', {}, 'Шаблон'), ' — чекпоинт машины с установленными агентами (smolvm checkpoint). Песочница создаётся из него за секунды, со своими портами, паролями агентов, токенами фильтра «Сеть» и шлюза секретов, но с правилами и секретами исходной машины.'),
            h('li', {}, h('b', {}, 'Профиль'), ' — файлы на этом компьютере. При открытии они записываются в домашнюю папку агента поверх шаблона, при закрытии — забираются обратно.'),
            h('li', {}, h('b', {}, 'Ревью'), ' — изменения профиля попадают в него только после вашего подтверждения (diff по каждому файлу). Иначе одна prompt-инъекция могла бы записать вредный skill или MCP-сервер, и он запускался бы в каждой следующей «чистой» песочнице. Для доверенного профиля ревью можно выключить.'),
            h('li', {}, 'Не сохраняются: входы и токены (auth.json, .credentials.json, .env), сессии, кэши, node_modules. Ключи моделей приходят из «Секретов» через шлюз, как обычно.'),
            h('li', {}, 'Рабочая папка /work каждый раз пустая. Нужен проект — кнопка «Папка» у открытой песочницы (лучше рабочей копией).'),
            h('li', {}, 'MCP-серверы, которые ставятся через npx/uvx, скачиваются при каждом открытии; с фильтром «Сеть» их источники (registry.npmjs.org, pypi.org) должны быть разрешены.')),
          h('p', { class: 'small muted' }, 'Что входит в профиль:'), h('pre', { class: 'small' }, (data?.paths || []).map((p) => `~/${p}`).join('\n') + '\n~/.claude.json → только mcpServers'))),
      h('nav', { class: 'section-nav' }, SECTIONS.map(([id, icon, title]) => h('button', { type: 'button', class: id === section ? 'active' : '', onclick: () => goSection(id) },
        ic(icon), title, counts[id] ? h('span', { class: `nav-count${id === 'review' ? ' attn' : ''}` }, String(counts[id])) : null))),
      h('p', { class: 'muted small section-about' }, SECTIONS.find(([id]) => id === section)[3]));
  }

  // ---------- «Песочницы»: launch, then the open ones ----------
  function openCard() {
    const ready = data.templates.filter((t) => !t.creating && !t.missing);
    if (!ready.length) {
      return h('section', { class: 'card sbx-launch' },
        h('div', { class: 'log-empty' }, ic('server'), h('div', {}, h('div', {}, 'Сначала нужен шаблон'), h('div', { class: 'small' }, 'Это чекпоинт машины с установленными агентами, из него открываются песочницы.')),
          h('button', { class: 'btn primary small-btn', onclick: () => goSection('templates') }, 'К шаблонам →')));
    }
    const tpl = h('select', { class: 'input' }, ready.map((t) => h('option', { value: t.id }, t.title)));
    const prof = h('select', { class: 'input' }, h('option', { value: '' }, 'без профиля — ничего не сохранять'),
      data.profiles.map((p) => h('option', { value: p.id }, p.name)));
    if (data.profiles.length) prof.value = data.profiles[0].id;
    const agent = h('select', { class: 'input' });
    const tplMark = h('span', {});
    const fillAgents = () => {
      const t = ready.find((x) => x.id === tpl.value);
      tplMark.replaceChildren(t?.agents ? mark(markOf(t)) : mark('vm'));
      const list = (t?.agents?.agents || []).map((id) => ({ id, title: AGENT_TITLES[id] || id }));
      agent.replaceChildren(h('option', { value: '' }, 'не запускать'), ...list.map((a) => h('option', { value: a.id }, a.title)));
      const main = list.find((a) => a.id !== 'terminal');
      if (main) agent.value = main.id;
    };
    tpl.addEventListener('change', fillAgents);
    fillAgents();
    const btn = h('button', { class: 'btn primary sbx-go' }, ic('play'), 'Открыть песочницу');
    btn.addEventListener('click', async () => {
      const w = agent.value ? agentTab() : null;
      btn.disabled = true;
      btn.replaceChildren(h('i', { class: 'spin' }), 'Открывается…');
      try {
        const r = await api('POST', '/ui/sandbox/open', { template: tpl.value, profile: prof.value || null, agent: agent.value || null });
        toast(`Песочница ${r.name} открыта`, 'ok');
        if (r.url) goAgent(w, r.url); else if (w) w.close();
        refreshMachines();
      } catch (e) { if (w) w.close(); toast(e.message, 'err', 12000); }
      await load(); render();
    });
    return h('section', { class: 'card sbx-launch' },
      h('div', { class: 'sbx-launch-row' }, tplMark,
        h('label', {}, 'Шаблон', tpl), h('label', {}, 'Профиль агента', prof), h('label', {}, 'Сразу запустить', agent), btn),
      h('div', { class: 'muted small' }, 'Каждый раз — чистая машина. Агент откроется в новой вкладке.'));
  }

  function sandboxesCard() {
    if (!data.sandboxes.length) {
      return h('div', { class: 'log-empty' }, ic('box'), h('div', {}, 'Открытых песочниц нет.'));
    }
    return h('div', { class: 'lst-grid sbx-grid' }, ...data.sandboxes.map((x) => {
      const busy = x.opening || null;
      const t = data.templates.find((y) => y.id === x.template);
      const close = async (keep) => {
        if (!keep) {
          const c = await confirmDialog('Закрыть без сохранения?', `Машина ${x.name} будет удалена, изменения профиля «${profName(x.profile)}» будут потеряны.`, false, '', 'Закрыть');
          if (!c.ok) return;
        }
        try {
          const r = await api('POST', `/ui/sandbox/machines/${enc(x.name)}/close`, { save: keep });
          refreshMachines();
          if (r.pending) { openPending.add(r.pending); toast(`Песочница закрыта. Изменений профиля: ${r.changes} — проверьте их`, 'ok', 8000); await load(); goSection('review'); return; }
          if (r.applied) toast(`Песочница закрыта, в профиль сохранено изменений: ${r.applied}`, 'ok');
          else toast(keep && x.profile ? 'Песочница закрыта, профиль не изменился' : 'Песочница закрыта', 'ok');
        } catch (e) { toast(e.message, 'err', 12000); }
        await load(); render();
      };
      const agentBtns = x.agents.map((a) => h('button', { class: 'btn small-btn', disabled: x.state !== 'running' || !!busy, title: `Открыть ${a.title} в новой вкладке`, onclick: async () => {
        const w = agentTab();
        try { const r = await api('POST', `/ui/machines/${enc(x.name)}/agents/${enc(a.id)}/start`, {}); goAgent(w, r.url); }
        catch (e) { if (w) w.close(); toast(e.message, 'err'); }
      } }, mark(a.mark, true), a.title));
      return h('div', { class: 'lst-card sbx-card' },
        h('div', { class: 'lst-head' }, t?.agents ? mark(markOf(t), true) : mark('vm', true),
          h('div', { class: 'lst-title' },
            h('a', { href: '#/', class: 'mono', onclick: (e) => { e.preventDefault(); location.hash = '#/'; setTimeout(() => select(x.name), 0); } }, x.name),
            h('div', { class: 'muted small' }, `открыта ${ago(x.createdAt)}`)),
          h('span', { class: 'spacer' }),
          busy ? h('span', { class: 'badge prep' }, h('i', { class: 'spin' }), busy) : h('span', { class: `badge ${x.state}` }, stateLabel(x.state))),
        h('div', { class: 'sbx-facts' },
          h('div', {}, h('span', { class: 'muted small' }, 'Шаблон'), h('div', {}, tplTitle(x.template))),
          h('div', {}, h('span', { class: 'muted small' }, 'Профиль'), h('div', {}, x.profile ? profName(x.profile) : h('span', { class: 'muted' }, 'без профиля')))),
        agentBtns.length ? h('div', { class: 'sbx-agents' }, ...agentBtns) : null,
        h('div', { class: 'lst-foot' },
          h('button', { class: 'btn ghost small-btn', disabled: !!busy || x.state === 'missing', title: 'Дать агенту папку этого компьютера (лучше рабочей копией)', onclick: () => openFolderDialog({ machine: x.name, mode: 'review' }) }, ic('folder'), 'Папка'),
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn ghost small-btn', disabled: !!busy, onclick: () => (x.profile ? close(false) : close(true)), title: 'Удалить машину, профиль не трогать' }, x.profile ? 'Без сохранения' : 'Закрыть'),
          x.profile ? h('button', { class: 'btn primary small-btn', disabled: !!busy, onclick: () => close(true), title: 'Забрать изменения профиля на ревью и удалить машину' }, 'Закрыть') : null));
    }));
  }

  // ---------- pending review ----------
  function pendingCard() {
    if (!data.pending.length) {
      return h('div', { class: 'log-empty' }, ic('list'), h('div', {}, h('div', {}, 'Ждать нечего.'), h('div', { class: 'small' }, 'Когда вы закроете песочницу с профилем, изменения агента появятся здесь.')));
    }
    return h('div', { class: 'sbx-review' }, ...data.pending.map(pendingBox));
  }

  function pendingBox(x) {
    const box = h('div', { class: 'card sbx-pending' });
    const sel = new Set();
    const diffBox = h('div', { class: 'diff-box pf-view' });
    const act = async (op, paths) => {
      try {
        if (op === 'apply') {
          const r = await api('POST', `/ui/sandbox/pending/${enc(x.id)}/apply`, { paths });
          toast(`Сохранено в профиль: ${r.applied.length}`, 'ok');
        } else {
          await api('DELETE', `/ui/sandbox/pending/${enc(x.id)}${paths.length ? `?${paths.map((p) => `path=${enc(p)}`).join('&')}` : ''}`);
          toast(paths.length ? `Отклонено: ${paths.length}` : 'Изменения отклонены', 'ok');
        }
      } catch (e) { toast(e.message, 'err'); }
      await load(); render();
    };
    const showDiff = async (c, row) => {
      box.querySelectorAll('.pf-file.active').forEach((y) => y.classList.remove('active'));
      (row || box.querySelector(`.pf-file[data-path="${CSS.escape(c.path)}"]`))?.classList.add('active');
      diffBox.replaceChildren(h('p', { class: 'muted small' }, 'Загрузка diff…'));
      let df;
      try { df = await api('GET', `/ui/sandbox/pending/${enc(x.id)}/diff?path=${enc(c.path)}`); } catch (e) { diffBox.replaceChildren(h('div', { class: 'error' }, e.message)); return; }
      const head = h('div', { class: 'row' }, h('b', { class: 'mono' }, showPath(c.path)),
        h('span', { class: 'muted small' }, `${fmtBytes(df.oldSize)} → ${fmtBytes(df.newSize)}`), h('span', { class: 'spacer' }),
        h('button', { class: 'btn small-btn', onclick: () => act('drop', [c.path]) }, ic('x'), 'Отклонить'),
        h('button', { class: 'btn small-btn primary', onclick: () => act('apply', [c.path]) }, ic('download'), 'Сохранить'));
      if (df.binary || df.tooBig) { diffBox.replaceChildren(head, h('p', { class: 'muted' }, df.binary ? 'Бинарный файл — построчный diff не показывается.' : 'Файл слишком большой для diff.')); return; }
      const pre = h('pre', { class: 'diff' });
      for (const hk of df.hunks) {
        pre.append(h('span', { class: 'd-h' }, `${hk.header}\n`));
        for (const l of hk.lines) pre.append(h('span', { class: l[0] === '+' ? 'd-a' : l[0] === '-' ? 'd-r' : 'd-c' }, `${l}\n`));
      }
      diffBox.replaceChildren(head, pre);
    };
    const risky = (p) => /claude-mcp\.json$|settings\.json$|opencode\.json$|config\.toml$|config\.yaml$|\/(skills|hooks|agents|commands|plugin|extensions)\//.test(p);
    const rows = x.changes.map((c) => {
      const [cls, letter, word] = KIND[c.kind];
      const cb = h('input', { type: 'checkbox' });
      cb.addEventListener('change', () => { if (cb.checked) sel.add(c.path); else sel.delete(c.path); });
      const row = h('div', { class: 'pf-file', 'data-path': c.path, onclick: (e) => { if (e.target !== cb) showDiff(c, row); } },
        cb, h('span', { class: `tag ${cls}`, title: word }, letter),
        h('span', { class: 'mono small ellipsis path-tail', title: showPath(c.path) }, `\u200e${showPath(c.path)}\u200e`), h('span', { class: 'spacer' }),
        risky(c.path) && c.kind !== 'deleted' ? h('span', { class: 'tag warn', title: 'Исполняемая конфигурация: skill, хук, MCP-сервер или настройки агента — проверьте перед сохранением' }, 'проверьте') : null);
      return row;
    });
    box.append(...[
      h('div', { class: 'lst-head' }, h('span', { class: 'mark m-icon' }, ic('users')),
        h('div', { class: 'lst-title' }, h('b', {}, `Профиль «${x.profileName}»`), h('div', { class: 'muted small mono' }, `из ${x.sandbox} · ${ago(x.at)}`)),
        h('span', { class: 'spacer' }), h('span', { class: 'badge running' }, `${x.changes.length} изм.`)),
      x.skipped.length ? h('div', { class: 'notice small' }, `Не забраны (слишком большие): ${x.skipped.join(', ')}`) : null,
      h('div', { class: 'pf-files' }, h('div', { class: 'pf-list' }, ...rows), diffBox),
      h('div', { class: 'lst-foot' },
        h('span', { class: 'muted small' }, 'Отметьте файлы галочками — или действие применится ко всем.'), h('span', { class: 'spacer' }),
        h('button', { class: 'btn', onclick: async () => {
          if (!sel.size && !(await confirmDialog('Отклонить все изменения?', 'Профиль останется как был.', false, '', 'Отклонить')).ok) return;
          act('drop', [...sel]);
        } }, ic('x'), 'Отклонить'),
        h('button', { class: 'btn primary', onclick: () => act('apply', [...sel]) }, ic('download'), 'Сохранить в профиль'))].filter(Boolean));
    // Show the first change right away (a risky one first).
    const first = x.changes.find((c) => risky(c.path) && c.kind !== 'deleted') || x.changes[0];
    openPending.delete(x.id);
    if (first) requestAnimationFrame(() => showDiff(first));
    return box;
  }

  // ---------- «Профили»: a grid of profile cards; files open full width ----------
  function profilesCard() {
    const cards = data.profiles.map((p) => {
      const auto = h('input', { type: 'checkbox', checked: !!p.autoSave });
      auto.addEventListener('change', async () => {
        if (auto.checked && !(await confirmDialog('Сохранять без ревью?', 'Изменения профиля будут попадать в него сразу при закрытии песочницы, без просмотра diff. Включайте только для профиля, которому доверяете: skill или MCP-сервер, записанный агентом, запустится в каждой следующей песочнице.', false, '', 'Включить')).ok) { auto.checked = false; return; }
        try { await api('PUT', `/ui/sandbox/profiles/${enc(p.id)}`, { autoSave: auto.checked }); } catch (e) { toast(e.message, 'err'); }
        await load(); render();
      });
      const remove = async () => {
        if (!(await confirmDialog('Удалить профиль?', `Профиль «${p.name}» и все его файлы (память, skills, MCP) будут удалены.`, false, '', 'Удалить')).ok) return;
        try { await api('DELETE', `/ui/sandbox/profiles/${enc(p.id)}`); } catch (e) { toast(e.message, 'err'); }
        editing = null; await load(); render();
      };
      if (editing === p.id) {
        const box = h('div', { class: 'pf-files' });
        drawFiles(p, box);
        return h('div', { class: 'lst-card lst-edit' },
          h('div', { class: 'lst-head' }, h('span', { class: 'mark m-icon' }, ic('users')), h('b', {}, `Профиль «${p.name}»`),
            h('span', { class: 'muted small' }, `${p.files} файл. · ${fmtBytes(p.size)}`), h('span', { class: 'spacer' }),
            h('button', { class: 'btn ghost icon', title: 'Закрыть', onclick: () => { editing = null; render(); } }, ic('x'))),
          box);
      }
      return h('div', { class: 'lst-card' },
        h('div', { class: 'lst-head' }, h('span', { class: 'mark m-icon' }, ic('users')),
          h('div', { class: 'lst-title' }, h('b', {}, p.name), h('div', { class: 'muted small' }, p.from ? `взят из машины ${p.from}` : `изменён ${ago(p.updatedAt)}`)),
          h('span', { class: 'spacer' }), p.autoSave ? h('span', { class: 'tag warn', title: 'Изменения сохраняются без ревью' }, 'без ревью') : null),
        h('div', { class: 'sbx-facts' },
          h('div', {}, h('span', { class: 'muted small' }, 'Файлов'), h('div', { class: 'net-big' }, String(p.files))),
          h('div', {}, h('span', { class: 'muted small' }, 'Размер'), h('div', {}, fmtBytes(p.size))),
          h('div', {}, h('span', { class: 'muted small' }, 'Изменён'), h('div', { class: 'small' }, ago(p.updatedAt)))),
        h('div', { class: 'lst-foot' },
          h('label', { class: 'check small', title: 'Сохранять изменения из песочницы сразу, без ревью' }, auto, ' без ревью'),
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn small-btn', onclick: () => { editing = p.id; render(); } }, ic('file'), 'Файлы'),
          h('button', { class: 'btn ghost icon danger', title: 'Удалить профиль', onclick: remove }, ic('trash'))));
    });
    const add = editing === 'new-profile' ? newProfileForm() : h('button', { type: 'button', class: 'lst-card lst-add', onclick: () => { editing = 'new-profile'; render(); } },
      h('span', { class: 'lst-add-ic' }, ic('plus')), h('b', {}, 'Новый профиль'), h('span', { class: 'muted small' }, 'пустой или с настройками агента из запущенной машины'));
    return h('div', { class: 'lst-grid' }, ...cards, add);
  }

  function newProfileForm() {
    const name = h('input', { class: 'input', placeholder: 'например, «Работа»', maxlength: 60 });
    const from = h('select', { class: 'input' }, h('option', { value: '' }, 'пустой — наполнится после первой песочницы'),
      state.machines.filter((m) => m.state === 'running' && state.marks?.[m.name] && !state.marks[m.name].sandbox)
        .map((m) => h('option', { value: m.name }, `настройки агентов из машины ${m.name}`)));
    const add = h('button', { class: 'btn primary' }, 'Создать');
    add.addEventListener('click', async () => {
      add.disabled = true;
      try {
        const r = await api('POST', '/ui/sandbox/profiles', { name: name.value || 'Профиль', from: from.value || null });
        toast(from.value ? 'Профиль создан из настроек агентов машины' : 'Профиль создан', 'ok');
        if (r.skipped?.length) toast(`Не взяты (слишком большие): ${r.skipped.join(', ')}`, 'err', 10000);
        editing = from.value ? r.id : null;
      } catch (e) { toast(e.message, 'err'); add.disabled = false; return; }
      await load(); render();
    });
    requestAnimationFrame(() => name.focus());
    return h('div', { class: 'lst-card lst-edit' },
      h('div', { class: 'lst-head' }, h('span', { class: 'mark m-icon' }, ic('plus')), h('b', {}, 'Новый профиль'), h('span', { class: 'spacer' }),
        h('button', { class: 'btn ghost icon', title: 'Закрыть', onclick: () => { editing = null; render(); } }, ic('x'))),
      h('div', { class: 'grid2' }, h('label', {}, 'Название', name), h('label', {}, 'Начать с', from)),
      h('p', { class: 'muted small' }, '«Настройки агентов из машины» берёт текущие память, skills, MCP и настройки из запущенной машины — удобно, если агент уже настроен.'),
      h('div', { class: 'row' }, h('span', { class: 'spacer' }), add));
  }

  async function drawFiles(p, box) {
    box.replaceChildren(h('p', { class: 'muted small' }, 'Загрузка…'));
    let files;
    try { files = (await api('GET', `/ui/sandbox/profiles/${enc(p.id)}/files`)).files; } catch (e) { box.replaceChildren(h('div', { class: 'error' }, e.message)); return; }
    const view = h('div', { class: 'pf-view' }, h('div', { class: 'muted small pf-hint' }, files.length ? 'Выберите файл слева, чтобы посмотреть или поправить.' : ''));
    const show = async (f, row) => {
      box.querySelectorAll('.pf-file.active').forEach((x) => x.classList.remove('active'));
      row?.classList.add('active');
      let r;
      try { r = await api('GET', `/ui/sandbox/profiles/${enc(p.id)}/file?path=${enc(f.path)}`); } catch (e) { view.replaceChildren(h('div', { class: 'error' }, e.message)); return; }
      if (r.binary) { view.replaceChildren(h('p', { class: 'muted small' }, `${showPath(f.path)}: бинарный файл, ${fmtBytes(r.size)}`)); return; }
      const ta = h('textarea', { class: 'input mono', rows: Math.min(24, Math.max(8, r.text.split('\n').length + 1)), spellcheck: false });
      ta.value = r.text;
      view.replaceChildren(h('div', { class: 'row' }, h('b', { class: 'mono small' }, showPath(f.path)), h('span', { class: 'spacer' }),
        h('button', { class: 'btn primary small-btn', onclick: async () => {
          try { await api('PUT', `/ui/sandbox/profiles/${enc(p.id)}/file?path=${enc(f.path)}`, { text: ta.value }); toast('Файл сохранён', 'ok'); } catch (e) { toast(e.message, 'err'); }
        } }, 'Сохранить')), ta);
    };
    box.replaceChildren(
      files.length ? h('div', { class: 'pf-list' }, ...files.map((f) => {
        const row = h('div', { class: 'pf-file', onclick: (e) => { if (!e.target.closest('button')) show(f, row); } },
          ic('file'), h('span', { class: 'mono small ellipsis path-tail', title: showPath(f.path) }, `\u200e${showPath(f.path)}\u200e`), h('span', { class: 'spacer' }), h('span', { class: 'muted small' }, fmtBytes(f.size)),
          h('button', { class: 'btn ghost icon', title: 'Удалить из профиля', onclick: async () => {
            try { await api('DELETE', `/ui/sandbox/profiles/${enc(p.id)}/file?path=${enc(f.path)}`); } catch (e) { toast(e.message, 'err'); }
            await load(); render();
          } }, ic('trash')));
        return row;
      })) : h('div', { class: 'log-empty' }, ic('file'), h('div', {}, 'Профиль пуст — он наполнится после первой песочницы.')),
      view);
  }

  // ---------- «Шаблоны»: a grid of template cards ----------
  function templatesCard() {
    const start = async (body, label) => {
      const m = state.machines.find((x) => x.name === body.source);
      if (m?.state === 'running' && !(await confirmDialog(label, `Машина ${body.source} будет перезапущена: smolvm делает чекпоинт только машины, запущенной с поддержкой ветвления. Запущенные в ней агенты остановятся.`, false, '', 'Продолжить')).ok) return;
      try { await api('POST', '/ui/sandbox/templates', body); toast('Шаблон готовится…', 'ok'); } catch (e) { toast(e.message, 'err', 12000); }
      editing = null; await load(); render();
    };
    const cards = data.templates.map((t) => {
      const job = t.job;
      const running = job?.status === 'running';
      const status = running ? h('span', { class: 'badge prep' }, h('i', { class: 'spin' }), job.step)
        : job?.status === 'error' ? h('span', { class: 'tag bad', title: job.error }, 'ошибка')
          : t.missing ? h('span', { class: 'tag bad' }, 'нет файла чекпоинта') : h('span', { class: 'tag ok' }, 'готов');
      return h('div', { class: 'lst-card' },
        h('div', { class: 'lst-head' }, t.agents ? mark(markOf(t)) : mark('vm'),
          h('div', { class: 'lst-title' }, h('b', {}, t.title), h('div', { class: 'muted small mono' }, `из ${t.source}`)),
          h('span', { class: 'spacer' }), status),
        job?.status === 'error' ? h('div', { class: 'error small' }, job.error) : null,
        t.agents ? h('div', { class: 'lst-hosts' }, ...t.agents.agents.map((id) => h('span', { class: 'lst-host' }, AGENT_TITLES[id] || id))) : null,
        t.cpus ? h('div', { class: 'sbx-facts' },
          h('div', {}, h('span', { class: 'muted small' }, 'Ресурсы'), h('div', {}, `${t.cpus} vCPU · ${fmtMb(t.memoryMb)}`)),
          h('div', {}, h('span', { class: 'muted small' }, 'Чекпоинт'), h('div', {}, t.size ? fmtBytes(t.size) : '—')),
          h('div', {}, h('span', { class: 'muted small' }, 'Обновлён'), h('div', { class: 'small' }, t.updatedAt ? ago(t.updatedAt) : '—'))) : null,
        t.creating ? null : h('div', { class: 'lst-foot' },
          h('span', { class: 'muted small' }, `${data.sandboxes.filter((x) => x.template === t.id).length || 'нет'} открытых`),
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn small-btn', disabled: running, title: 'Сделать чекпоинт исходной машины заново (например, после обновления агентов)', onclick: () => start({ source: t.source, id: t.id }, 'Обновить шаблон?') }, ic('refresh'), 'Обновить'),
          h('button', { class: 'btn ghost icon danger', disabled: running, title: 'Удалить шаблон', onclick: async () => {
            if (!(await confirmDialog('Удалить шаблон?', `Чекпоинт «${t.title}» будет удалён. Исходная машина ${t.source} останется.`, false, '', 'Удалить')).ok) return;
            try { await api('DELETE', `/ui/sandbox/templates/${enc(t.id)}`); } catch (e) { toast(e.message, 'err'); }
            await load(); render();
          } }, ic('trash'))));
    });
    const add = editing === 'new-template' ? newTemplateForm(start) : h('button', { type: 'button', class: 'lst-card lst-add', onclick: () => { editing = 'new-template'; render(); } },
      h('span', { class: 'lst-add-ic' }, ic('plus')), h('b', {}, 'Новый шаблон'), h('span', { class: 'muted small' }, 'из машины с установленными агентами'));
    return [h('div', { class: 'lst-grid' }, ...cards, add),
      h('details', { class: 'card' }, h('summary', {}, h('b', {}, 'Как подготовить шаблон')),
        h('ul', { class: 'small' },
          h('li', {}, 'Создайте обычную машину с пресетом агента: секреты, фильтр «Сеть», нужные пакеты, MCP-серверы через npx. Запустите и дождитесь установки агентов.'),
          h('li', {}, 'Машина перезапускается с поддержкой ветвления — на macOS smolvm иначе не делает чекпоинт.'),
          h('li', {}, 'Нельзя: подключённые папки компьютера, GPU/CUDA, том корпоративных сертификатов для скачивания образа.'),
          h('li', {}, 'Песочницы получают правила «Сети» и секреты исходной машины на момент создания шаблона, но со своими токенами.'),
          h('li', {}, 'Обновили агентов или пакеты в исходной машине — нажмите «Обновить».')))];
  }

  function newTemplateForm(start) {
    const candidates = state.machines.filter((m) => state.marks?.[m.name] && !state.marks[m.name].sandbox);
    const close = h('button', { class: 'btn ghost icon', title: 'Закрыть', onclick: () => { editing = null; render(); } }, ic('x'));
    if (!candidates.length) {
      return h('div', { class: 'lst-card lst-edit' }, h('div', { class: 'lst-head' }, h('span', { class: 'mark m-icon' }, ic('plus')), h('b', {}, 'Новый шаблон'), h('span', { class: 'spacer' }), close),
        h('p', { class: 'muted' }, 'Нет машин с агентами. Создайте машину с пресетом агента («Создать»), запустите её и дождитесь установки.'));
    }
    const src = h('select', { class: 'input' }, candidates.map((m) => h('option', { value: m.name }, `${m.name} — ${state.marks[m.name].title}`)));
    const title = h('input', { class: 'input', placeholder: state.marks[candidates[0].name]?.title || 'Claude Code', maxlength: 60 });
    src.addEventListener('change', () => { title.placeholder = state.marks[src.value]?.title || ''; });
    return h('div', { class: 'lst-card lst-edit' },
      h('div', { class: 'lst-head' }, h('span', { class: 'mark m-icon' }, ic('plus')), h('b', {}, 'Новый шаблон'), h('span', { class: 'spacer' }), close),
      h('div', { class: 'grid2' }, h('label', {}, 'Машина с агентами', src), h('label', {}, 'Название', title)),
      h('div', { class: 'row' }, h('span', { class: 'muted small' }, 'Машина будет перезапущена.'), h('span', { class: 'spacer' }),
        h('button', { class: 'btn primary', onclick: () => start({ source: src.value, title: title.value || state.marks[src.value]?.title }, 'Создать шаблон?') }, 'Создать шаблон')));
  }

  const AGENT_TITLES = { terminal: 'Терминал', claude: 'Claude Code', opencode: 'OpenCode', 'opencode-tui': 'OpenCode TUI', dsh: 'Harness', codex: 'Codex', pi: 'Pi', hermes: 'Hermes' };
  const AGENT_MARKS = { claude: 'claude', opencode: 'opencode', 'opencode-tui': 'opencode', dsh: 'dsh', codex: 'codex', pi: 'pi', hermes: 'hermes' };
  function markOf(t) {
    const ids = t.agents.agents.filter((id) => id !== 'terminal');
    return ids.length > 2 ? 'all' : AGENT_MARKS[ids[0]] || 'term';
  }

  // ---------- render ----------
  function render() {
    if (!root || !data) return;
    const y = root.scrollTop;
    const body = section === 'open' ? [openCard(), sandboxesCard()] : section === 'review' ? [pendingCard()] : section === 'profiles' ? [profilesCard()] : [templatesCard()];
    fill(root, intro(), ...body.flat());
    root.scrollTop = y;
  }

  // Live states (opening, template jobs, machine state) without wiping what the user is doing.
  async function poll() {
    if (!root || document.hidden) return;
    try { await load(); } catch { return; }
    const sig = JSON.stringify([data.sandboxes.map((x) => [x.name, x.state, x.opening]), data.templates.map((t) => [t.id, t.job?.status, t.job?.step, t.updatedAt]), data.pending.map((x) => [x.id, x.changes.length]), data.profiles.length]);
    if (sig === lastSig) return;
    if (editing || root.querySelector('input:focus, textarea:focus, select:focus')) return; // the next tick re-renders
    lastSig = sig;
    render();
  }

  pages.sandbox = {
    render(el, p) {
      root = el; params = p; editing = null;
      section = SECTIONS.some(([id]) => id === p.get('tab')) ? p.get('tab') : 'open';
      if (section === 'profiles' && p.get('profile')) editing = p.get('profile'); // from «Рабочие места»
      fill(el, h('p', { class: 'muted' }, 'Загрузка…'));
      load().then(() => { lastSig = ''; render(); }).catch((e) => fill(el, h('div', { class: 'error' }, e.message)));
      timer = setInterval(poll, 3000);
      return () => { clearInterval(timer); root = null; };
    },
  };
})();
