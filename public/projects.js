'use strict';
// «Проекты» (#/projects): a git repository with how its tasks start — the agent, the trust
// level and a setup script. With a setup script the project gets a template: the agent's
// image with the project already set up, so a task starts with dependencies in place.

(() => {
  let root = null;
  let projects = [];
  let tasks = [];
  let profiles = [];
  let selected = '';    // project id, or 'new'
  let timer = null;
  let lastSig = '';
  let dirty = false;    // the form has unsaved changes

  const AGENTS = { terminal: 'Терминал', claude: 'Claude Code', opencode: 'OpenCode', 'opencode-tui': 'OpenCode TUI', dsh: 'DSH', codex: 'Codex', pi: 'Pi', hermes: 'Hermes' };
  const MARKS = { claude: 'claude', opencode: 'opencode', 'opencode-tui': 'opencode', dsh: 'dsh', codex: 'codex', pi: 'pi', hermes: 'hermes' };
  const ago = (ts) => fmtAgo(Math.floor(ts / 1000));
  const plural = (n, one, few, many) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many}`;
  const profOf = (id) => profiles.find((p) => p.id === id) || null;
  const cur = () => projects.find((p) => p.id === selected) || null;
  const SETUP_HINT = 'npm ci\n# pip install -r requirements.txt\n# go mod download';

  async function load() {
    const [p, t, s] = await Promise.all([api('GET', '/ui/projects'), api('GET', '/ui/tasks').catch(() => ({ tasks })), api('GET', '/ui/sandbox').catch(() => ({ profiles }))]);
    projects = p.projects || [];
    tasks = t.tasks || [];
    profiles = s.profiles || [];
    if (selected !== 'new' && !cur()) selected = projects[0]?.id || (projects.length ? '' : 'new');
  }

  function tplState(p) {
    if (p.build?.status === 'running') return ['busy', `собирается: ${p.build.step}`];
    if (!p.setup) return ['neutral', 'без подготовки'];
    if (p.build?.status === 'error' || (p.buildError && !p.templateReady)) return ['bad', 'сборка не удалась'];
    if (p.stale) return ['warn', 'устарел — пересоберите'];
    if (p.templateReady) return ['ok', 'шаблон готов'];
    return ['warn', 'шаблона нет'];
  }
  const pillOf = ([tone, text]) => h('span', { class: `ag-pill ${tone}` }, tone === 'busy' ? h('i', { class: 'spin' }) : null, text);

  // ---------- the form (new and existing project) ----------
  function form(p) {
    const isNew = !p;
    const v = { name: p?.name || '', hostPath: p?.hostPath || '', profile: p?.profile || profiles[0]?.id || '', trust: p?.trust || 'normal', setup: p?.setup || '' };
    const mark_ = () => { dirty = true; };
    const name = h('input', { class: 'input', id: 'pj-name', value: v.name, maxlength: 60, placeholder: 'по имени папки', oninput: (e) => { v.name = e.target.value; mark_(); } });
    const info = h('div', { class: 'small muted tk-dir-info' });
    let seq = 0;
    const check = async () => {
      const my = ++seq;
      if (!v.hostPath.trim()) { info.replaceChildren(); return; }
      let r; try { r = await api('GET', `/ui/git-inspect?path=${enc(v.hostPath.trim())}`); } catch { return; }
      if (my !== seq) return;
      info.className = `small tk-dir-info ${!r.ok || !r.git ? 'badc' : 'muted'}`;
      info.textContent = !r.ok ? r.error : !r.git ? 'не git-репозиторий с коммитами — проектом может быть только он' : `git · ${r.branch || 'detached'} @ ${r.head}${r.dirty ? ' · есть незакоммиченные изменения' : ''}`;
    };
    const sug = h('datalist', { id: 'pj-sug' });
    let sugT = null;
    const path = h('input', { class: 'input mono', id: 'pj-path', value: v.hostPath, list: 'pj-sug', spellcheck: 'false', placeholder: '/путь/к/репозиторию',
      oninput: (e) => {
        v.hostPath = e.target.value; mark_();
        clearTimeout(sugT);
        sugT = setTimeout(async () => { check(); try { sug.replaceChildren(...((await api('GET', `/ui/folders/suggest?q=${enc(v.hostPath)}`)).paths || []).map((x) => h('option', { value: x }))); } catch {} }, 250);
      } });
    check();
    const who = h('select', { class: 'input', id: 'pj-agent', onchange: (e) => { v.profile = e.target.value; mark_(); } },
      profiles.map((x) => h('option', { value: x.id }, `${x.name}${x.agent ? ` — ${AGENTS[x.agent] || x.agent}` : ''}`)));
    who.value = v.profile;
    const trust = window.agentUi.trustPicker(v.trust, (t) => { v.trust = t; mark_(); });
    const setup = h('textarea', { class: 'input mono', id: 'pj-setup', rows: 5, maxlength: 8000, placeholder: SETUP_HINT, oninput: (e) => { v.setup = e.target.value; mark_(); } });
    setup.value = v.setup;
    const saveBtn = h('button', { class: 'btn primary', onclick: async () => {
      saveBtn.disabled = true;
      try {
        const body = { name: v.name, hostPath: v.hostPath, profile: v.profile, trust: v.trust, setup: v.setup };
        const r = isNew ? await api('POST', '/ui/projects', body) : await api('PUT', `/ui/projects/${enc(p.id)}`, body);
        dirty = false;
        toast(isNew ? 'Проект создан' : 'Сохранено', 'ok');
        // A new project with a setup script: build its template right away.
        if (r.setup && (isNew || r.stale || !r.template) && r.build?.status !== 'running') await api('POST', `/ui/projects/${enc(r.id)}/build`, {}).catch((e) => toast(e.message, 'err', 10000));
        selected = r.id;
        location.hash = `#/projects?id=${enc(r.id)}`;
        await refresh();
      } catch (e) { toast(e.message, 'err', 10000); saveBtn.disabled = false; }
    } }, isNew ? 'Создать проект' : 'Сохранить');
    if (!profiles.length) {
      return h('section', { class: 'card ws-empty' }, ic('bot'), h('h3', {}, 'Сначала нужен агент'),
        h('p', { class: 'muted' }, 'Проект открывает задачи для агента: его программа, изоляция и ключи. Создайте агента — потом проект.'),
        h('button', { class: 'btn primary', onclick: () => agentWizard({ onDone: () => refresh() }) }, ic('plus'), 'Создать агента'));
    }
    return h('section', { class: 'card pj-form needs-admin' },
      h('div', { class: 'grid2' },
        h('label', { class: 'ws-field', for: 'pj-path' }, 'Папка репозитория', path, sug, info),
        h('label', { class: 'ws-field', for: 'pj-name' }, 'Название', name)),
      h('label', { class: 'ws-field', for: 'pj-agent' }, 'Агент по умолчанию', who),
      h('div', { class: 'ws-field' }, h('div', { class: 'label-like' }, 'Доверие по умолчанию'), trust),
      h('label', { class: 'ws-field', for: 'pj-setup' }, 'Скрипт подготовки', setup,
        h('span', { class: 'muted small' }, 'Выполняется один раз при сборке шаблона — в папке проекта, от пользователя агента, с его сетью (белыми списками). Например, установка зависимостей. Пусто — шаблон не нужен: задачи открываются из образа агента.')),
      h('div', { class: 'row' }, h('span', { class: 'spacer' }), saveBtn));
  }

  function templateCard(p) {
    const st = tplState(p);
    const running = p.build?.status === 'running';
    const log = p.build?.log || '';
    const err = p.build?.error || (!p.templateReady ? p.buildError : null);
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', {}, 'Шаблон проекта'), h('span', { class: 'spacer' }), pillOf(st)),
      !p.setup ? h('p', { class: 'small muted' }, 'Скрипта подготовки нет — каждая задача открывается из образа агента, проект копируется в машину при открытии.')
        : h('p', { class: 'small' }, p.templateReady
          ? `Собран ${ago(p.builtAt)} из ${p.builtFrom}${p.templateSize ? ` · ${fmtBytes(p.templateSize)}` : ''}. Задачи открываются из него: зависимости уже на месте, код — текущий HEAD репозитория.`
          : p.stale ? 'Агент, папка или скрипт изменились после сборки — задачи открываются из образа агента, пока шаблон не пересобран.'
            : 'Пока шаблона нет, задачи открываются из образа агента без подготовки.'),
      err ? h('div', { class: 'error small' }, err) : null,
      log ? h('details', { open: !!err }, h('summary', { class: 'small' }, 'Вывод скрипта'), h('pre', { class: 'diff rv-pre pj-log' }, log)) : null,
      p.setup ? h('div', { class: 'row' }, h('span', { class: 'spacer' }),
        h('button', { class: 'btn needs-admin', disabled: running, onclick: async () => {
          try { await api('POST', `/ui/projects/${enc(p.id)}/build`, {}); toast('Сборка началась', 'ok'); } catch (e) { toast(e.message, 'err', 10000); }
          await refresh();
        } }, ic('refresh'), p.template ? 'Пересобрать' : 'Собрать')) : null);
  }

  function tasksCard(p) {
    const mine = tasks.filter((t) => t.project === p.id);
    const STATUS = { opening: 'открывается', working: 'работает', waiting: 'ждёт вас', stopped: 'остановлена', lost: 'потеряна', review: 'на проверке', done: 'завершена' };
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', {}, 'Задачи проекта'), h('span', { class: 'spacer' }),
        h('button', { class: 'btn primary small-btn needs-operator', onclick: () => window.newTask({ project: p.id }) }, ic('plus'), 'Новая задача')),
      mine.length ? h('div', { class: 'pj-tasks' }, ...mine.slice(0, 20).map((t) => h('a', { href: `#/tasks?id=${enc(t.id)}`, class: 'pj-task' },
        h('span', { class: 'ellipsis' }, t.title), h('span', { class: 'muted small' }, `${STATUS[t.status] || t.status}${t.result.commits ? ` · ${t.result.commits} комм.` : ''} · ${ago(t.closedAt || t.createdAt)}`))))
        : h('p', { class: 'muted small' }, 'Задач ещё не было.'));
  }

  function detail(p) {
    const prof = profOf(p.profile);
    return h('section', { class: 'panel detail-panel' },
      h('div', { class: 'detail-head' },
        h('span', { class: 'mark m-icon' }, ic('branch')),
        h('div', { class: 'ag-title' }, h('h2', {}, p.name), h('span', { class: 'muted small mono ellipsis', title: p.hostPath }, p.hostPath)),
        h('div', { class: 'actions' },
          h('button', { class: 'btn primary needs-operator', onclick: () => window.newTask({ project: p.id }) }, ic('play'), 'Новая задача'),
          h('button', { class: 'btn ghost icon danger needs-admin', title: 'Удалить проект', 'aria-label': 'Удалить проект', onclick: async () => {
            if (!(await confirmDialog('Удалить проект?', `Проект «${p.name}» и его шаблон будут удалены. Репозиторий, ветки задач и сами задачи останутся.`, false, '', 'Удалить')).ok) return;
            try { await api('DELETE', `/ui/projects/${enc(p.id)}`); toast('Проект удалён', 'ok'); } catch (e) { toast(e.message, 'err'); return; }
            selected = ''; location.hash = '#/projects';
          } }, ic('trash')))),
      h('div', { class: 'tab-body' },
        prof ? null : h('div', { class: 'error small' }, 'Агент проекта удалён — выберите другого и сохраните.'),
        templateCard(p), tasksCard(p), form(p)));
  }

  // «?» of the section: why a project, when it is worth it.
  function help() {
    return helpButton('Зачем раздел «Проекты»',
      h('p', {}, 'Проект — ваш git-репозиторий с настройками задач по умолчанию: какой агент работает, насколько ему доверять и как подготовить окружение.'),
      h('ul', {},
        h('li', {}, h('b', {}, 'Без проекта '), 'каждую задачу настраиваешь заново (агент, папка, доверие), а агент в чистой машине каждый раз заново ставит зависимости.'),
        h('li', {}, h('b', {}, 'С проектом '), '«Новая задача» — это выбрать проект и написать, что сделать. Агент, репозиторий и доверие подставятся сами.'),
        h('li', {}, h('b', {}, 'Скрипт подготовки '), '(npm ci, pip install -r requirements.txt…) выполняется один раз при сборке шаблона проекта. Задачи открываются из шаблона за секунды: зависимости уже установлены, код — текущий HEAD.'),
        h('li', {}, h('b', {}, 'Шаблон устаревает сам, '), 'если поменять агента, папку или скрипт; после обновления зависимостей нажмите «Пересобрать».')),
      h('p', { class: 'muted small' }, 'Проект необязателен: разовую задачу можно дать и без него, выбрав агента и папку.'));
  }

  function side() {
    const item = (p) => h('a', { class: `machine ag-item sb-item${p.id === selected ? ' active' : ''}`, href: `#/projects?id=${enc(p.id)}` },
      mark(MARKS[profOf(p.profile)?.agent] || 'vm', true), h('div', { class: 'name' }, p.name), pillOf(tplState(p)),
      h('div', { class: 'meta' }, [profOf(p.profile)?.name, plural(tasks.filter((t) => t.project === p.id).length, 'задача', 'задачи', 'задач')].filter(Boolean).join(' · ')));
    return h('section', { class: 'panel list-panel' },
      h('div', { class: 'panel-head' }, h('h2', { class: 'h-ic' }, ic('branch'), 'Проекты'), help()),
      h('div', { class: 'machines' }, ...projects.map(item),
        h('a', { class: `machine ag-item sb-item sb-add needs-admin${selected === 'new' ? ' active' : ''}`, href: '#/projects?new=1' },
          h('span', { class: 'mark m-icon m-list' }, ic('plus')), h('div', { class: 'name' }, 'Новый проект'), h('span'), h('div', { class: 'meta' }, 'git-репозиторий на этом компьютере'))));
  }

  function render() {
    if (!root) return;
    const p = cur();
    if (p && location.hash !== `#/projects?id=${enc(p.id)}`) history.replaceState(null, '', `#/projects?id=${enc(p.id)}`);
    const right = p ? detail(p) : h('section', { class: 'panel detail-panel' },
      h('div', { class: 'detail-head' }, h('span', { class: 'mark m-icon' }, ic('plus')),
        h('div', { class: 'ag-title' }, h('h2', {}, 'Новый проект'), h('span', { class: 'muted small' }, 'репозиторий, агент и подготовка — один раз для всех задач'))),
      h('div', { class: 'tab-body' }, form(null)));
    const scroll = root.querySelector('.tab-body')?.scrollTop || 0;
    fill(root, h('div', { class: 'layout ag-layout' }, side(), right));
    const tb = root.querySelector('.tab-body');
    if (tb) tb.scrollTop = scroll;
  }

  async function refresh() {
    try { await load(); } catch (e) { toast(e.message, 'err'); return; }
    lastSig = ''; render();
  }

  async function poll() {
    if (!root || document.hidden) return;
    try { await load(); } catch { return; }
    const sig = JSON.stringify([selected, projects.map((p) => [p.id, p.name, p.build?.status, p.build?.step, p.templateReady, p.stale, p.buildError]), tasks.map((t) => [t.id, t.status])]);
    if (sig === lastSig) return;
    if (dirty || root.querySelector('input:focus, textarea:focus, select:focus')) return;
    lastSig = sig;
    render();
  }

  pages.projects = {
    render(el, params) {
      root = el; dirty = false;
      selected = params.get('new') ? 'new' : params.get('id') || selected;
      el.classList.add('page-agents');
      fill(el, h('p', { class: 'muted' }, 'Загрузка…'));
      load().then(() => { lastSig = ''; render(); }).catch((e) => fill(el, h('div', { class: 'error' }, e.message)));
      timer = setInterval(poll, 3000);
      return () => { clearInterval(timer); el.classList.remove('page-agents'); root = null; };
    },
  };
})();
