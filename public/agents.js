'use strict';
// Section «Агенты» (⚙ → «Агенты», #/agents): agents on the left, the chosen one on the
// right — «Обзор» (network, directories, secrets, program), «Задачи» (its tasks).
// «Создать агента» and the gear open agentwizard.js; «Дать задачу» opens «Новая задача».

(() => {
  let root = null;
  let data = null;       // GET /ui/sandbox
  let tasks = [];        // GET /ui/tasks
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
  const tplOf = (id) => data.templates.find((t) => t.id === id) || null;
  const short = (p) => String(p || '').replace(/^\/(Users|home)\/[^/]+/, '~').replace(/^[A-Z]:\\Users\\[^\\]+/i, '~');

  async function load() {
    const [d, t] = await Promise.all([api('GET', '/ui/sandbox'), api('GET', '/ui/tasks').catch(() => ({ tasks }))]);
    data = d; tasks = t.tasks || [];
    if (!Object.keys(lists).length) {
      try { lists = Object.fromEntries(((await api('GET', '/ui/egress')).lists || []).map((l) => [l.id, l.name])); } catch {}
    }
  }

  // ---------- actions ----------
  async function removeAgent(p) {
    if (data.sandboxes.some((x) => x.profile === p.id)) { toast('Сначала остановите его сессии', 'err'); return; }
    const c = await confirmDialog('Удалить агента?', `«${p.name}» и его память (инструкции, MCP, skills), задача и настройки будут удалены. Образ программы останется.`, false, '', 'Удалить');
    if (!c.ok) return;
    try { await api('DELETE', `/ui/sandbox/profiles/${enc(p.id)}`); toast(`Агент «${p.name}» удалён`, 'ok'); } catch (e) { toast(e.message, 'err'); }
    await refresh();
  }

  // ---------- the trust level (also used by «Новая задача») ----------
  // Levels above the administrator's ceiling are shown, but cannot be chosen.
  function trustPicker(value, onChange) {
    const order = { careful: 1, normal: 2, trusted: 3 };
    const max = window.auth?.policy?.maxTrust || 'trusted';
    if (order[value] > order[max]) { value = max; setTimeout(() => onChange(max), 0); }
    const box = h('div', { class: 'ag-trust', role: 'radiogroup', 'aria-label': 'Насколько вы доверяете агенту' });
    const draw = () => box.replaceChildren(...Object.entries(TRUST).map(([id, t]) => h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(id === value), class: `ag-trust-col ${id}${id === value ? ' on' : ''}`,
      disabled: order[id] > order[max], title: order[id] > order[max] ? 'Запрещено политикой администратора' : '',
      onclick: () => { value = id; draw(); onChange(id); },
    }, h('span', { class: 'ag-trust-title' }, h('i', { class: `ag-dot ${id}` }), t.title),
      h('span', { class: 'ag-trust-hint' }, t.hint),
      h('span', { class: 'ag-trust-lines' }, ...t.lines.map((l) => h('span', {}, l))))));
    draw();
    return box;
  }

  const launch = ({ profile }) => window.newTask({ profile });

  const create = (step) => agentWizard({ step, onDone: () => refresh() });

  // ---------- render: the list on the left, the chosen agent on the right ----------
  let selected = '';     // profile id
  let tab = 'overview';  // overview | tasks
  let vault = [];        // GET /ui/vault — secrets with their modes
  let vaultAt = 0;
  const NET = { strict: 'Только разрешённое — с жёсткой изоляцией: обойти фильтр нельзя', soft: 'Только разрешённое — без изоляции: фильтр через прокси', off: 'Без ограничений — как этот компьютер' };

  async function loadSlow() {
    if (Date.now() - vaultAt > 15000) {
      vaultAt = Date.now();
      try { vault = (await api('GET', '/ui/vault')).secrets || []; } catch {}
    }
  }

  const sessionsOf = (p) => data.sandboxes.filter((x) => x.profile === p.id);
  const tasksOf = (p) => tasks.filter((t) => t.profile === p.id);
  const imageOf = (p) => (p.preset ? data.images?.[p.preset]?.[(p.net || 'strict') === 'strict' ? 'isolated' : 'plain'] : null);
  // The state of an agent in a word or two, for the list and the head.
  function agentState(p) {
    const open = tasksOf(p).filter((t) => !t.closedAt);
    if (open.some((t) => t.status === 'waiting')) return ['warn', 'ждёт ответа'];
    if (open.some((t) => t.status === 'opening')) return ['busy', 'открывается'];
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
        h('button', { class: 'btn primary icon needs-admin', title: 'Создать агента', 'aria-label': 'Создать агента', onclick: () => create() }, ic('plus'))),
      h('div', { class: 'machines' }, ...(items.length ? items : [h('div', { class: 'list-empty' }, 'Агентов пока нет.', h('br'), h('br'),
        h('button', { class: 'btn primary', onclick: () => create() }, 'Создать первого'))])));
  }

  // ---------- «Обзор»: network, directories, secrets ----------
  function overview(p) {
    const t = tplOf(p.template);
    const edit = (step) => h('button', { class: 'btn ghost small-btn needs-admin', onclick: () => agentWizard({ profile: p.id, step, onDone: () => refresh() }) }, 'Изменить');
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

  // ---------- «Задачи»: what this agent was given, each opens on «Задачи» ----------
  function tasksTab(p) {
    const mine = tasksOf(p);
    if (!mine.length) {
      return [h('section', { class: 'card ws-empty' }, ic('play'), h('h3', {}, 'Задач ещё не было'),
        h('p', { class: 'muted' }, 'Дайте агенту задачу — откроется чистая машина, а результат вернётся веткой в репозиторий.'),
        h('button', { class: 'btn primary', onclick: () => launch({ profile: p.id }) }, ic('play'), 'Дать задачу'))];
    }
    const STATUS = { opening: 'открывается', working: 'работает', waiting: 'ждёт вас', stopped: 'остановлена', lost: 'потеряна', review: 'на проверке', done: 'завершена' };
    return [h('section', { class: 'card' }, h('div', { class: 'pj-tasks' }, ...mine.slice(0, 30).map((t) => h('a', { href: `#/tasks?id=${enc(t.id)}`, class: 'pj-task' },
      h('span', { class: 'ellipsis' }, t.title),
      h('span', { class: `small ${['waiting', 'review'].includes(t.status) ? 'warnc' : 'muted'}` }, `${STATUS[t.status] || t.status}${t.result.commits ? ` · ${t.result.commits} комм.` : ''}`)))))];
  }

  function detailPanel() {
    const p = data.profiles.find((x) => x.id === selected);
    if (!p) {
      return h('section', { class: 'panel detail-panel' }, h('div', { class: 'empty-state' }, h('div', { class: 'big' }, ic('bot')),
        h('p', {}, data.profiles.length ? 'Выберите агента слева.' : 'Создайте первого агента: программа, изоляция, директории и секреты — в одном окне.'),
        h('button', { class: 'btn primary', onclick: () => create() }, ic('plus'), 'Создать агента')));
    }
    const [tone, text] = agentState(p);
    const TABS = [['overview', 'Обзор', 0], ['tasks', 'Задачи', tasksOf(p).filter((t) => !t.closedAt).length]];
    const body = { overview, tasks: tasksTab }[tab](p);
    return h('section', { class: 'panel detail-panel' },
      h('div', { class: 'detail-head' },
        mark(MARKS[p.agent] || 'vm'),
        h('div', { class: 'ag-title' }, h('h2', {}, p.name), h('span', { class: 'muted small' }, [programOf(p), TRUST[p.trust] ? `доверие: ${TRUST[p.trust].title.toLowerCase()}` : null].filter(Boolean).join(' · '))),
        h('span', { class: `ag-pill ${tone}` }, tone === 'busy' ? h('i', { class: 'spin' }) : null, text),
        h('div', { class: 'actions' },
          h('button', { class: 'btn primary needs-operator', onclick: () => launch({ profile: p.id }) }, ic('play'), 'Дать задачу'),
          h('button', { class: 'btn ghost icon needs-admin', title: 'Настройки агента', 'aria-label': 'Настройки агента', onclick: () => agentWizard({ profile: p.id, onDone: () => refresh() }) }, ic('gear')),
          h('button', { class: 'btn ghost icon danger needs-admin', title: sessionsOf(p).length ? 'Сначала закончите его сессии' : 'Удалить агента', 'aria-label': 'Удалить агента', disabled: sessionsOf(p).length > 0, onclick: () => removeAgent(p) }, ic('trash')))),
      h('nav', { class: 'tabs' }, ...TABS.map(([id, label, n]) => h('button', { class: `tab${tab === id ? ' active' : ''}`, onclick: () => { tab = id; sync(); refresh(); } },
        label, n ? h('span', { class: 'nav-count' }, String(n)) : null))),
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
    const sig = JSON.stringify([selected, tab, tasks.map((t) => [t.id, t.status, t.profile]), data.profiles.map((p) => [p.id, p.updatedAt, p.files]),
      data.images, vault.map((v) => [v.name, v.mode]), Math.floor(Date.now() / 60000)]);
    if (sig === lastSig) return;
    lastSig = sig;
    render();
  }

  // ---------- «Шаблоны» (⚙ → «Шаблоны»): the list of templates on the left ----------
  // active: { kind: 'template' | 'new-template', id }.
  window.sandboxSide = function sandboxSide(d, active) {
    const item = ({ on, href, icon, name, sub, pill }) => h('a', { class: `machine ag-item sb-item${on ? ' active' : ''}`, href },
      icon, h('div', { class: 'name' }, name), pill || h('span'), h('div', { class: 'meta' }, sub || ''));
    const pillOf = (tone, text) => h('span', { class: `ag-pill ${tone}` }, tone === 'busy' ? h('i', { class: 'spin' }) : null, text);
    const templates = d.templates.map((t) => {
      const running = t.creating || t.job?.status === 'running' || t.upgrade?.status === 'running';
      const tone = running ? ['busy', 'готовится'] : t.missing || t.job?.status === 'error' ? ['bad', 'ошибка'] : t.updates?.length ? ['warn', 'есть обновление'] : ['neutral', 'готов'];
      return item({ on: active.kind === 'template' && active.id === t.id, href: `#/sandbox?id=${enc(t.id)}`,
        icon: h('span', { class: 'mark m-icon m-list' }, ic('box')), name: t.title,
        sub: t.auto?.project ? 'шаблон проекта' : t.auto ? 'образ программы' : `из машины ${t.source}`, pill: pillOf(...tone) });
    });
    return h('section', { class: 'panel list-panel' },
      h('div', { class: 'panel-head' }, h('h2', { class: 'h-ic' }, ic('box'), 'Шаблоны')),
      h('div', { class: 'machines' }, ...templates,
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
        step(6, 'Агент', 'имя агента и его память. «Создать и запустить» открывает первую задачу — сессию с агентом.')),
      h('p', {}, 'Дальше: «Дать задачу» — новая задача в чистой машине (или «Новая задача» на странице «Задачи»); что агент просит — во «Входящих». ⚙ на карточке открывает то же окно для настройки.'),
      h('p', {}, 'Вышла новая версия агента — во вкладке «Шаблоны» появится «Доступна новая версия»; кнопка «Обновить агента» поставит её и обновит образ.'),
      h('p', { class: 'muted small' }, 'Долгие шаги — подготовка образа, обновление — идут на сервере: окно можно закрыть, они продолжатся.'));
  }


  // «Рабочие места» became «Агенты»: the old address leads here.
  pages.work = { render() { location.replace('#/agents'); return null; } };

  window.agentUi = { TRUST, trustPicker };
  window.agentsLaunch = launch;
  pages.agents = {
    render(el, p) {
      root = el;
      el.classList.add('page-agents');
      selected = p?.get('id') || selected;
      tab = p?.get('tab') === 'tasks' ? 'tasks' : 'overview';
      // Links of the guide: #/agents?create=… open «Создать агента» on that step.
      const step = p?.get('create');
      if (step) { history.replaceState(null, '', '#/agents'); setTimeout(() => create(step), 0); }
      fill(el, h('p', { class: 'muted' }, 'Загрузка…'));
      vaultAt = 0;
      refresh().catch((e) => fill(el, h('div', { class: 'error' }, e.message)));
      timer = setInterval(poll, 3000);
      return () => { clearInterval(timer); el.classList.remove('page-agents'); root = null; };
    },
  };
})();
