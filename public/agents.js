'use strict';
// Section «Агенты» (#/agents): agents on the left, the chosen one on the right —
// «Обзор» (policy, directories, secrets, program), «Программы» (its machine and what runs
// in it), «Журнал соединений» (requests waiting for you, what was blocked, the feed).
// «Запустить ▾» starts a program of its machine, «Остановить» ends the run (agentrun.js);
// «Создать агента» and the gear open agentwizard.js (deleting the agent too).

(() => {
  let root = null;
  let data = null;       // GET /ui/sandbox
  let tasks = [];        // GET /ui/tasks
  let policies = [];     // GET /ui/policies
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
    const [d, t, pl] = await Promise.all([api('GET', '/ui/sandbox'), api('GET', '/ui/tasks').catch(() => ({ tasks })), api('GET', '/ui/policies').catch(() => ({ policies }))]);
    data = d; tasks = t.tasks || []; policies = pl.policies || [];
    if (!Object.keys(lists).length) {
      try { lists = Object.fromEntries(((await api('GET', '/ui/egress')).lists || []).map((l) => [l.id, l.name])); } catch {}
    }
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

  const create = (step) => agentWizard({ step, onDone: () => refresh() });

  // ---------- render: the list on the left, the chosen agent on the right ----------
  let selected = '';     // profile id
  let tab = 'overview';  // overview | programs | net
  let vault = [];        // GET /ui/vault — secrets with their modes
  let vaultAt = 0;
  const busy = {};       // profile id -> «Запускается…» | «Останавливается…»
  let net = { key: '', entries: [], denied: [] }; // «Журнал соединений» of the chosen agent

  async function loadSlow() {
    if (Date.now() - vaultAt > 15000) {
      vaultAt = Date.now();
      try { vault = (await api('GET', '/ui/vault')).secrets || []; } catch {}
    }
  }

  const modeOf = (p) => (p.mode === 'persistent' ? 'persistent' : 'sandbox');
  const policyOf = (p) => policies.find((x) => x.id === (p.policy || p.trust)) || null;
  // The agent's machine now (the newest), and the machines it worked in before.
  const sbOf = (p) => data.sandboxes.find((x) => x.profile === p.id) || null;
  const machinesOf = (p) => [...new Set([...data.sandboxes.filter((x) => x.profile === p.id).map((x) => x.name),
    ...tasks.filter((t) => t.profile === p.id).flatMap((t) => [...(t.machines || [t.machine])].reverse())])].filter(Boolean).slice(0, 4);
  const asksOf = (p) => { const sb = sbOf(p); return sb ? (window.liveApprovalsList || []).filter((a) => a.machine === sb.name) : []; };
  const isRunning = (sb) => !!sb && ['running', 'paused'].includes(sb.state);
  const imageOf = (p) => (p.preset ? data.images?.[p.preset]?.[(policyOf(p)?.net.mode || p.net || 'strict') === 'strict' ? 'isolated' : 'plain'] : null);
  // The state of an agent in a word or two, for the list and the head.
  function agentState(p) {
    const sb = sbOf(p);
    if (busy[p.id]) return ['busy', busy[p.id] === 'stop' ? 'останавливается' : 'запускается'];
    if (sb && state.isolated?.[sb.name]) return ['bad', 'изолирован'];
    if (asksOf(p).length) return ['warn', 'ждёт ответа'];
    if (sb?.opening) return ['busy', 'запускается'];
    if (sb?.state === 'running') return ['ok', 'работает'];
    if (sb?.state === 'paused') return ['warn', 'на паузе'];
    const img = imageOf(p);
    if (p.preset && !img?.template) return img?.job?.status === 'running' ? ['busy', 'готовится образ'] : ['neutral', 'образ не готов'];
    if (riskOf(p).lethal) return ['bad', 'риск утечки'];
    if (sb) return ['neutral', 'выключен'];
    return ['neutral', 'не запущен'];
  }

  // The programs of the agent's machine: of its machine if it has one, else of its template.
  const progTitle = (id) => AGENTS[id] || data.agentTitles?.[id]?.title || id;
  const progMark = (id) => data.agentTitles?.[id]?.mark || MARKS[id] || 'term';
  function programsOf(p) {
    const sb = sbOf(p);
    const t = tplOf(p.preset ? imageOf(p)?.template : p.template);
    const ids = sb?.agents?.length ? sb.agents.map((a) => a.id) : (t?.agents?.agents || []);
    // The agent's own program first, the terminal last.
    return [...new Set([p.agent, ...ids])].filter((id) => id && ids.includes(id)).sort((a, b) => (a === p.agent ? -1 : b === p.agent ? 1 : a === 'terminal' ? 1 : b === 'terminal' ? -1 : 0));
  }
  const progNote = (p, id) => (id === 'terminal' ? 'командная строка в машине агента' : id === p.agent ? 'программа агента' : 'ещё одна программа в машине');

  // ---------- actions ----------
  // «Запустить»: the program in the agent's machine (made from the template, or started),
  // in a new browser tab — it is opened on the click itself, later the browser would block it.
  async function runProgram(p, id) {
    if (busy[p.id]) return;
    const w = agentTab();
    busy[p.id] = 'run'; render();
    try {
      const r = await api('POST', `/ui/run/${enc(p.id)}/launch`, { program: id });
      if (r.url) { agentInTab(r.name, true); goAgent(w, r.url); } else if (w) w.close();
      refreshMachines();
    } catch (e) { if (w) w.close(); toast(e.message, 'err', 12000); }
    delete busy[p.id];
    await refresh();
  }

  // «Остановить»: a sandbox is closed with its result saved; a kept machine is switched off.
  async function stopAgent(p) {
    const sb = sbOf(p);
    if (!sb || busy[p.id]) return;
    const keep = modeOf(p) === 'persistent' && sb.persistent;
    if (!keep) {
      const c = await confirmDialog('Остановить агента?', `Машина ${sb.name} удалится. Изменения в git-репозиториях придут веткой во «Входящие», то, что агент запомнил, — на проверку.`, false, '', 'Остановить');
      if (!c.ok) return;
    }
    busy[p.id] = 'stop'; render();
    try {
      const r = await api('POST', `/ui/run/${enc(p.id)}/stop`, {});
      const n = (r.git || []).reduce((sum, g) => sum + (g.commits || 0), 0);
      if (!keep) agentInTab(sb.name, false);
      const inbox = n || r.pending;
      toast(keep ? `Агент остановлен, машина сохранена${n ? ` · ${plural(n, 'коммит', 'коммита', 'коммитов')} — во «Входящих»` : ''}` : inbox ? 'Агент остановлен — результат во «Входящих»' : 'Агент остановлен, машина удалена', 'ok', 8000);
      refreshMachines();
    } catch (e) { toast(e.message, 'err', 12000); }
    delete busy[p.id];
    await refresh();
  }

  // A kept machine made anew: its result is taken, the machine is deleted, the next
  // «Запустить» makes a clean one from the template.
  async function recreate(p) {
    const c = await confirmDialog('Новая машина из шаблона?', 'Изменения в git-репозиториях придут веткой во «Входящие», память агента — на проверку. Машина удалится, следующий «Запустить» создаст чистую из шаблона. Установленное в машине вручную пропадёт.', false, '', 'Пересоздать');
    if (!c.ok) return;
    busy[p.id] = 'stop'; render();
    try { await api('POST', `/ui/run/${enc(p.id)}/recreate`, {}); toast('Машина удалена — следующий запуск будет из шаблона', 'ok'); refreshMachines(); }
    catch (e) { toast(e.message, 'err', 12000); }
    delete busy[p.id];
    await refresh();
  }

  // «Запустить ▾» with the programs of the machine, or «Остановить» while it runs.
  function runButton(p) {
    const sb = sbOf(p);
    if (busy[p.id] || sb?.opening) return h('button', { class: 'btn primary', disabled: true }, h('i', { class: 'spin' }), busy[p.id] === 'stop' ? 'Останавливается…' : 'Запускается…');
    if (isRunning(sb)) {
      return h('button', { class: 'btn needs-operator', title: modeOf(p) === 'persistent' && sb.persistent ? 'Выключить машину агента — всё в ней сохранится' : 'Закрыть машину: результат — во «Входящие», машина удалится', onclick: () => stopAgent(p) }, ic('stop'), 'Остановить');
    }
    const progs = programsOf(p);
    const img = imageOf(p);
    const wait = p.preset && !img?.template;
    return h('details', { class: 'menu needs-operator' },
      h('summary', { class: 'btn primary' }, ic('play'), 'Запустить', h('span', { class: 'ag-caret' }, '▾')),
      h('div', { class: 'menu-pop ag-run-pop' },
        h('div', { class: 'muted small ag-run-note' }, sb ? `Машина ${sb.name} включится, программа откроется в новой вкладке.` : modeOf(p) === 'persistent' ? 'Машина создастся из шаблона один раз и останется у агента.' : 'Чистая машина из шаблона; программа откроется в новой вкладке.'),
        ...(progs.length && !wait ? progs.map((id) => h('button', { class: 'menu-item ag-run-item', onclick: (e) => { e.currentTarget.closest('details').open = false; runProgram(p, id); } },
          mark(progMark(id), true), h('span', {}, h('b', {}, progTitle(id)), h('span', { class: 'muted small' }, progNote(p, id)))))
          : [h('div', { class: 'muted small ag-run-note' }, wait ? (img?.job?.status === 'running' ? `Образ программы готовится: ${img.job.step}` : 'Образ программы не готов — откройте настройки агента') : 'В шаблоне нет программ.')])));
  }

  // Does the agent get a model key: a gateway secret to a model provider (or a local
  // model). The terminal alone needs none.
  const NEEDS_MODEL = new Set(['claude', 'opencode', 'opencode-tui', 'dsh', 'codex', 'pi', 'hermes']);
  const MODEL_HOSTS = /anthropic\.com|deepseek\.com|openai\.com|openrouter\.ai|googleapis\.com|generativelanguage/;
  function modelKeyMissing(p) {
    if (!NEEDS_MODEL.has(p.agent)) return false;
    const t = p.preset ? null : tplOf(p.template);
    const names = Array.isArray(p.secrets) ? p.secrets : (t?.secrets || []);
    return !names.some((n) => {
      const x = vault.find((v) => v.name === n);
      return x && x.mode === 'gateway' && (x.model || MODEL_HOSTS.test(String(x.upstream || '')));
    });
  }

  // The leak risk of an agent («смертельная триада») from what it is given: private data
  // (secrets, directories), untrusted content and a way out (the network of its policy).
  function riskOf(p) {
    const pol = policyOf(p);
    const t = p.preset ? null : tplOf(p.template);
    const secrets = Array.isArray(p.secrets) ? p.secrets : (t?.secrets || []);
    const dirs = p.folders?.length ? p.folders : p.folder ? [{ hostPath: p.folder, mode: 'review' }] : [];
    const privateData = [...secrets.map((n) => `секрет ${n}`),
      ...dirs.map((f) => `директория ${String(f.hostPath).split(/[\\/]/).filter(Boolean).pop()}${f.mode === 'ro' ? ' (чтение)' : ''}`)];
    const mode = pol?.net.mode || p.net || 'strict';
    const unknown = pol?.net.unknown || { careful: 'deny', normal: 'ask', trusted: 'allow' }[p.trust] || 'deny';
    let untrustedLevel; let untrustedWhy;
    if (mode === 'off') { untrustedLevel = 'open'; untrustedWhy = 'сеть без ограничений — агент читает любой сайт'; }
    else if (unknown === 'allow') { untrustedLevel = 'open'; untrustedWhy = 'незнакомые адреса пропускаются'; }
    else { untrustedLevel = 'limited'; untrustedWhy = `только белые списки${unknown === 'ask' ? ', остальное — с вашего подтверждения' : ''}`; }
    let exfilLevel = untrustedLevel;
    let exfilWhy = untrustedLevel === 'open' ? 'может отправить данные на любой адрес' : 'только на адреса из белых списков';
    const tplIsolated = t ? !!(t.egress?.enabled && t.egress?.strict) : true;
    if (exfilLevel === 'limited' && (mode === 'soft' || !tplIsolated)) {
      exfilLevel = 'open';
      exfilWhy = mode === 'soft' ? 'фильтр без изоляции — программа без прокси выйдет напрямую' : 'шаблон машины без жёсткой изоляции — фильтр можно обойти';
    }
    const has = privateData.length > 0;
    const lethal = has && untrustedLevel === 'open' && exfilLevel === 'open';
    return { privateData, untrustedLevel, untrustedWhy, exfilLevel, exfilWhy, lethal, limited: has && !lethal, policy: pol };
  }

  function riskCard(p) {
    const tri = riskOf(p);
    if (!tri.lethal) return riskLine(tri);
    const LV = { open: ['badc', '●'], limited: ['warnc', '◐'], none: ['okc', '○'] };
    const row = (level, label, text) => h('div', {}, h('span', { class: LV[level][0] }, `${LV[level][1]} `), h('b', {}, label), h('span', { class: 'muted' }, ` — ${text}`));
    return h('section', { class: 'card ag-risk' },
      h('div', { class: 'card-head' }, h('h3', { class: 'h-ic badc' }, ic('alert'), 'Риск утечки: все три звена'), h('span', { class: 'spacer' }),
        h('button', { class: 'btn primary needs-admin', onclick: () => agentWizard({ profile: p.id, step: 'policy', onDone: () => refresh() }) }, 'Сменить политику')),
      h('div', { class: 'risk-rows small' },
        row('open', 'Приватные данные', tri.privateData.slice(0, 4).join(', ') + (tri.privateData.length > 4 ? ` и ещё ${tri.privateData.length - 4}` : '')),
        row(tri.untrustedLevel, 'Недоверенный контент', tri.untrustedWhy),
        row(tri.exfilLevel, 'Выход наружу', tri.exfilWhy)),
      h('p', { class: 'muted small' }, `У агента есть приватные данные, он читает недоверенный интернет и может отправить их наружу${tri.policy ? ` — так разрешает политика «${tri.policy.name}»` : ''}. Выберите политику с белыми списками и изоляцией (например, «Обычно») — или уберите секреты и директории.`));
  }
  const programOf = (p) => progTitle(p.agent) || '—';
  const MODE_WORD = { sandbox: 'песочница', persistent: 'постоянная машина' };

  function listPanel() {
    const items = data.profiles.map((p) => {
      const [tone, text] = agentState(p);
      return h('div', { class: `machine ag-item${p.id === selected ? ' active' : ''}${tone === 'ok' ? ' running' : ''}`, role: 'button', tabindex: '0',
        onclick: () => go(p.id), onkeydown: (e) => { if (e.key === 'Enter') go(p.id); } },
        mark(MARKS[p.agent] || 'vm', true),
        h('div', { class: 'name' }, p.name),
        h('span', { class: `ag-pill ${tone}` }, tone === 'busy' ? h('i', { class: 'spin' }) : null, text),
        h('div', { class: 'meta' }, [programOf(p), MODE_WORD[modeOf(p)], policyOf(p)?.name].filter(Boolean).join(' · ')));
    });
    return h('section', { class: 'panel list-panel' },
      h('div', { class: 'panel-head' }, h('h2', { class: 'h-ic' }, ic('bot'), 'Агенты'), guideButton(),
        h('button', { class: 'btn ghost icon danger needs-operator', title: 'Остановить всех агентов: изолировать все работающие машины (kill switch)', 'aria-label': 'Остановить всех агентов', onclick: () => window.isolateAll() }, ic('power')),
        h('button', { class: 'btn primary icon needs-admin', title: 'Создать агента', 'aria-label': 'Создать агента', onclick: () => create() }, ic('plus'))),
      h('div', { class: 'machines' }, ...(items.length ? items : [h('div', { class: 'list-empty' }, 'Агентов пока нет.', h('br'), h('br'),
        h('button', { class: 'btn primary', onclick: () => create() }, 'Создать первого'))])));
  }

  // ---------- «Обзор»: network, directories, secrets ----------
  function overview(p) {
    const t = tplOf(p.template);
    const edit = (step) => h('button', { class: 'btn ghost small-btn needs-admin', onclick: () => agentWizard({ profile: p.id, step, onDone: () => refresh() }) }, 'Изменить');
    const card = (icon, title, step, ...body) => h('section', { class: 'card ag-ov' },
      h('div', { class: 'card-head' }, h('h3', { class: 'h-ic' }, typeof icon === 'string' ? ic(icon) : icon, title), h('span', { class: 'spacer' }), edit(step)), ...body);
    // The policy: the agent's, else its former trust level (the built-in policies have its ids).
    const pol = policyOf(p);
    const kv = kvCell;
    const netCard = card(pol ? h('span', { class: `pc-${pol.color || 'gray'} pc-glyph` }, ic('policy')) : 'policy', pol ? `Политика «${pol.name}»` : 'Политика', 'policy',
      pol ? h('div', { class: 'kv' },
        kv('Сеть', { strict: 'только разрешённое — обойти нельзя', soft: 'только разрешённое, без изоляции', off: 'без ограничений' }[pol.net.mode], 'globe'),
        pol.net.mode === 'off' ? null : kv('Незнакомые адреса', { deny: 'запрещать', ask: 'спрашивать вас', allow: 'пропускать' }[pol.net.unknown], 'compass'),
        pol.net.mode === 'off' ? null : kv('Белые списки', pol.net.lists === 'default' ? 'для новых машин' : (pol.net.lists || []).map((id) => lists[id] || id).join(', ') || 'нет', 'list-check'),
        kv('Права в машине', pol.account.sudo ? 'sudo (root)' : 'без root', 'user'),
        kv('Запрещённые программы', pol.processes.deny.length ? pol.processes.deny.join(', ') : 'нет', 'ban'),
        modeOf(p) === 'sandbox' ? kv('Срок песочницы', pol.time.ttlHours ? `${pol.time.ttlHours} ч` : 'без срока', 'clock') : null)
        : h('p', { class: 'muted small' }, 'Политика не выбрана — «Изменить».'),
      pol ? h('a', { class: 'small', href: `#/policies?id=${enc(pol.id)}` }, 'открыть политику →') : null);
    const dirs = p.folders?.length ? p.folders : p.folder ? [{ hostPath: p.folder, mode: 'review' }] : [];
    const dirCard = card('folder', 'Директории', 'dirs',
      h('div', { class: 'kv' },
        dirs.length ? dirs.map((f) => kv(f.mode === 'ro' ? 'Только чтение' : 'Копия с проверкой', h('span', { class: 'mono ellipsis', title: f.hostPath }, short(f.hostPath)), f.mode === 'ro' ? 'eye' : 'folder'))
          : kv('Директории компьютера', 'не даны — агент получает только чистую машину', 'folder'),
        kv('Git-репозиторий', 'возвращается веткой во «Входящие»', 'branch'),
        kv('Без git', 'копия; на диск — после вашей проверки', 'copy')));
    const names = Array.isArray(p.secrets) ? p.secrets : (t?.secrets || []);
    const noKey = modelKeyMissing(p);
    const secCard = card('key', 'Секреты', 'secrets',
      noKey ? h('div', { class: 'ag-keywarn small' },
        h('b', {}, 'Агенту не выбран ключ модели. '),
        'Добавьте ключ провайдера модели в «Секреты» (режим «Шлюз») и выберите его в настройках агента — он подхватит ключ при следующем запуске. Без ключа агент может войти напрямую через сервер вендора (подписка, OAuth), если сеть его политики это позволяет.',
        h('div', { class: 'row' }, h('button', { class: 'btn small-btn needs-admin', onclick: () => agentWizard({ profile: p.id, step: 'secrets', onDone: () => refresh() }) }, ic('key'), 'Выбрать ключ'))) : null,
      names.length ? h('div', { class: 'ag-rowsl' }, ...names.map((n) => {
        const x = vault.find((v) => v.name === n);
        return h('div', { class: 'ag-dir' }, ic('key'), h('b', { class: 'mono' }, n),
          x ? h('span', { class: 'muted small ellipsis' }, x.mode === 'gateway' ? `через шлюз → ${x.upstream}` : x.mode === 'substitute' ? `подстановка: ${(x.hosts || []).join(', ')}` : `переменная ${x.envVar} — агент видит значение`)
            : h('span', { class: 'small badc' }, 'нет в хранилище'));
      })) : h('p', { class: 'muted small' }, 'Секретов нет.'),
      h('p', { class: 'muted small' }, 'Через шлюз агент пользуется ключом, но не видит его значения.'));
    if (noKey) secCard.classList.add('ag-warn');
    const img = imageOf(p);
    const prog = h('section', { class: 'card ag-ov' },
      h('div', { class: 'card-head' }, h('h3', { class: 'h-ic' }, ic('box'), 'Программа'), h('span', { class: 'spacer' }), edit('program')),
      h('div', { class: 'kv' },
        kv('Агент', programOf(p), 'bot'),
        kv('Как работает', modeOf(p) === 'persistent' ? 'постоянная машина — создаётся один раз, всё в ней сохраняется' : 'песочница — каждый запуск чистая машина из шаблона', 'refresh'),
        kv('Шаблон', p.preset ? (img?.template ? `образ готов · ${tplOf(img.template)?.title || ''}` : img?.job?.status === 'running' ? `образ готовится: ${img.job.step}` : 'образ не готов — подготовится при запуске') : t ? `«${t.title}»` : '—', 'box'),
        kv('Память', h('a', { href: `#/profile?id=${enc(p.id)}` }, `${p.files || 0} файлов — что он знает`), 'file')));
    return [riskCard(p), h('div', { class: 'ag-ov-grid' }, netCard, dirCard, secCard, prog)];
  }

  // ---------- «Программы»: what runs in the agent's machine, and the machine itself ----------
  const STATE_WORD = { running: 'работает', stopped: 'выключена', paused: 'на паузе', missing: 'пропала' };
  function programsTab(p) {
    const sb = sbOf(p);
    const on = sb?.state === 'running' && !sb.opening;
    const keep = modeOf(p) === 'persistent';
    const kv = kvCell;
    const tiles = programsOf(p).map((id) => h('div', { class: 'card ag-prog' },
      mark(progMark(id)),
      h('div', { class: 'ag-prog-text' }, h('b', {}, progTitle(id)), h('span', { class: 'muted small' }, progNote(p, id))),
      h('button', { class: `btn small-btn needs-operator${on ? '' : ' primary'}`, disabled: !!busy[p.id] || !!sb?.opening, onclick: () => runProgram(p, id) },
        ic(on ? 'external' : 'play'), on ? 'Открыть' : 'Запустить')));
    const machine = h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', { class: 'h-ic' }, ic('server'), 'Машина агента'), h('span', { class: 'spacer' }),
        keep && sb ? h('button', { class: 'btn ghost small-btn needs-operator', disabled: !!busy[p.id] || !!sb.opening, title: 'Удалить машину и при следующем запуске создать чистую из шаблона', onclick: () => recreate(p) }, ic('refresh'), 'Новая из шаблона') : null),
      h('div', { class: 'kv' },
        kv('Как работает', keep ? 'постоянная машина' : 'песочница', 'refresh'),
        kv('Машина', sb ? h('a', { class: 'mono', href: `#/?machine=${enc(sb.name)}` }, sb.name) : 'нет — создастся при запуске', 'server'),
        kv('Состояние', sb ? (sb.opening ? `запускается: ${sb.opening}` : STATE_WORD[sb.state] || sb.state) : '—', 'activity'),
        sb && !keep && sb.expiresAt ? kv('Удалится сама', new Date(sb.expiresAt).toLocaleString('ru-RU'), 'clock') : null),
      h('p', { class: 'muted small' }, keep
        ? 'Машина создаётся из шаблона при первом запуске. «Остановить» выключает её — установленное, файлы и память агента остаются; изменения в git-репозиториях при этом приходят веткой во «Входящие».'
        : 'Каждый запуск — чистая машина из шаблона. «Остановить» удаляет её: изменения в git-репозиториях приходят веткой во «Входящие», то, что агент запомнил, — на проверку.'));
    return [machine, tiles.length ? h('div', { class: 'ag-progs' }, ...tiles) : h('p', { class: 'muted' }, 'В шаблоне агента нет программ.')];
  }

  // ---------- «Журнал соединений»: requests waiting for you, what was blocked, the feed ----------
  async function loadNet(p) {
    const names = machinesOf(p);
    const key = `${p.id}|${names.join(',')}`;
    const sb = sbOf(p);
    try {
      const [logs, dn] = await Promise.all([
        Promise.all(names.map((n) => api('GET', `/ui/egress/log?machine=${enc(n)}&limit=200`).then((r) => r.entries || []).catch(() => []))),
        sb ? api('GET', `/ui/egress/denied?machine=${enc(sb.name)}`).then((r) => r.denied || []).catch(() => []) : [],
      ]);
      net = { key, entries: logs.flat().sort((a, b) => b.ts - a.ts).slice(0, 300), denied: dn };
    } catch { net = { key, entries: [], denied: [] }; }
  }

  async function decide(a, decision) {
    try { await api('POST', `/ui/approvals/${enc(a.id)}`, { decision }); } catch (e) { toast(e.message, 'err'); }
    if (typeof pollLive === 'function') await pollLive();
    await refresh();
  }
  async function allow(p, d) {
    try { await api('POST', '/ui/egress/allow', { machine: d.machine, host: d.host, ports: String(d.port), into: 'machine' }); toast(`${d.host}:${d.port} разрешён агенту`, 'ok'); }
    catch (e) { toast(e.message, 'err'); }
    await refresh();
  }

  function netTab(p) {
    const sb = sbOf(p);
    const asks = asksOf(p);
    const btn = (cls, label, a, decision) => h('button', { class: `btn small-btn ${cls} needs-operator`, onclick: () => decide(a, decision) }, label);
    const askBox = asks.length ? h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', { class: 'h-ic warnc' }, ic('bell'), 'Ждут вашего решения')),
      h('div', { class: 'net-asks' }, ...asks.map((a) => {
        const isNet = a.kind === 'net';
        const left = Math.max(0, Math.round((a.expiresAt - Date.now()) / 1000));
        return h('div', { class: 'ws-notice net-ask' },
          h('span', {}, isNet ? 'Хочет подключиться к ' : 'Хочет вызвать API ', h('b', { class: 'mono' }, isNet && a.detail?.host ? `${a.detail.host}:${a.detail.port}` : a.title),
            isNet ? null : h('span', { class: 'muted' }, ` — ключ ${a.detail?.secret || ''}`),
            h('span', { class: 'muted small' }, ` · ждёт ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`)),
          isNet ? [btn('', 'На 10 минут', a, 'once'), btn('primary', 'Всегда', a, 'always')] : btn('primary', 'Разрешить', a, 'once'),
          btn('danger-outline', 'Запретить', a, 'deny'));
      }))) : null;
    const blocked = net.denied.length ? h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', { class: 'h-ic' }, ic('ban'), 'Заблокировано'), h('span', { class: 'spacer' }), h('span', { class: 'muted small' }, 'разрешить — только этому агенту')),
      h('div', { class: 'log-wait-grid' }, ...net.denied.slice(0, 12).map((d) => h('div', { class: 'log-wait' },
        h('div', { class: 'net-block-main' },
          h('div', { class: 'mono' }, `${d.host}:${d.port}`),
          h('div', { class: 'muted small' }, `${d.count} раз · ${new Date(d.last).toLocaleTimeString('ru-RU')}`),
          d.reason ? h('div', { class: 'small badc ellipsis', title: d.reason }, d.reason) : null),
        h('button', { class: 'btn small-btn primary needs-admin', onclick: () => allow(p, d) }, 'Разрешить'))))) : null;
    const many = new Set(net.entries.map((e) => e.machine)).size > 1;
    const fmtTime = (ts) => new Date(ts).toLocaleTimeString('ru-RU');
    const feed = net.entries.length ? h('div', { class: 'log-feed' },
      h('div', { class: 'log-row log-head' }, h('span', {}, 'Время'), h('span', {}, ''), h('span', {}, 'Машина'), h('span', {}, 'Куда'), h('span', {}, 'Правило или причина'), h('span', { class: 'right' }, 'Трафик')),
      ...net.entries.map((e) => h('div', { class: `log-row ${e.allow ? 'ok' : 'bad'}` },
        h('span', { class: 'mono small muted' }, fmtTime(e.ts)),
        h('span', { class: `log-dot ${e.allow ? 'ok' : 'bad'}`, title: e.allow ? 'разрешено' : 'заблокировано' }),
        h('span', { class: `mono small ellipsis${many && e.machine !== sb?.name ? ' muted' : ''}` }, e.machine),
        h('span', { class: 'mono small ellipsis', title: `${e.method} ${e.host}:${e.port}${e.path || ''}` }, h('span', { class: 'muted' }, `${e.method} `), `${e.host}:${e.port}`, e.path ? h('span', { class: 'muted' }, e.path) : null),
        h('span', { class: 'small ellipsis', title: e.error || '' }, e.allow ? h('span', { class: 'muted' }, `${e.rule || ''}${e.source ? ` · ${e.source}` : ''}`) : h('span', { class: 'badc' }, e.reason || 'заблокировано'), e.error ? h('span', { class: 'badc' }, ` · ${e.error}`) : null),
        h('span', { class: 'mono small muted right' }, e.allow ? `↓${fmtBytes(e.bytesIn)} ↑${fmtBytes(e.bytesOut)}${e.open ? ' …' : ''}` : ''))))
      : h('div', { class: 'log-empty' }, ic('list'), h('div', {}, sb || machinesOf(p).length ? 'Соединений пока нет.' : 'Агент ещё не запускался — соединения его машины появятся здесь.'));
    return [askBox, blocked,
      h('div', { class: 'net-col-title' }, 'Соединения', h('span', { class: 'muted small log-count' }, net.entries.length ? `последние ${net.entries.length}${many ? ' — и прошлых машин агента' : ''}` : '')),
      feed,
      h('p', { class: 'muted small' }, 'Обновляется каждые 3 секунды. Все машины — ⚙ → «Сеть» → «Журнал».')];
  }

  // Kill switch for an agent: its machine — connections cut, gateway tokens replaced,
  // pending approvals refused, the machine paused.
  function isolationButton(p) {
    const all = data.sandboxes.filter((x) => x.profile === p.id).map((x) => x.name);
    const iso = all.filter((n) => state.isolated?.[n]);
    const live = all.filter((n) => !state.isolated?.[n] && ['running', 'paused'].includes(data.sandboxes.find((x) => x.name === n)?.state));
    const call = async (names, on) => {
      let done = 0;
      for (const n of names) { try { await api('POST', `/ui/machines/${enc(n)}/isolate`, { on }); done++; } catch (e) { toast(`${n}: ${e.message}`, 'err'); } }
      await pollLive(); await refreshMachines(); await refresh();
      return done;
    };
    if (iso.length) {
      return h('button', { class: 'btn needs-operator', title: 'Вернуть машине агента сеть и токены шлюза; она останется на паузе', onclick: async () => {
        const n = await call(iso, false);
        toast(n ? 'Изоляция снята. Машина на паузе — «Запустить» её возобновит; у программ новые токены' : 'Изоляция не снята', n ? 'ok' : 'err', 10000);
      } }, ic('unlock'), 'Снять изоляцию');
    }
    if (!live.length) return null;
    return h('button', { class: 'btn danger-outline needs-operator', title: 'Kill switch: оборвать все соединения машины агента, заменить токены шлюза, отклонить ожидающие подтверждения и поставить машину на паузу', onclick: async () => {
      const c = await confirmDialog(`Изолировать агента «${p.name}»?`, `Машина ${live.join(', ')}: все соединения оборвутся, токены шлюза заменятся, ожидающие подтверждения будут отклонены, машина встанет на паузу. Снять изоляцию можно здесь же.`, false, '', 'Изолировать');
      if (!c.ok) return;
      const n = await call(live, true);
      toast(`Агент «${p.name}» изолирован: машин — ${n}`, 'ok', 10000);
    } }, ic('lock'), 'Изолировать');
  }

  function detailPanel() {
    const p = data.profiles.find((x) => x.id === selected);
    if (!p) {
      return h('section', { class: 'panel detail-panel' }, h('div', { class: 'empty-state' }, h('div', { class: 'big' }, ic('bot')),
        h('p', {}, data.profiles.length ? 'Выберите агента в списке.' : 'Создайте первого агента: программа, политика, директории и секреты — в одном окне.'),
        h('button', { class: 'btn primary', onclick: () => create() }, ic('plus'), 'Создать агента')));
    }
    const [tone, text] = agentState(p);
    const pol = policyOf(p);
    const TABS = [['overview', 'Обзор', 0], ['programs', 'Программы', 0], ['net', 'Журнал соединений', asksOf(p).length]];
    const body = { overview, programs: programsTab, net: netTab }[tab](p);
    return h('section', { class: 'panel detail-panel' },
      h('div', { class: 'detail-head' },
        mark(MARKS[p.agent] || 'vm'),
        h('div', { class: 'ag-title' }, h('h2', {}, p.name), h('span', { class: 'muted small' }, [programOf(p), MODE_WORD[modeOf(p)], pol ? `политика «${pol.name}»` : null].filter(Boolean).join(' · '))),
        h('span', { class: `ag-pill ${tone}` }, tone === 'busy' ? h('i', { class: 'spin' }) : null, text),
        h('div', { class: 'actions' },
          isolationButton(p),
          runButton(p),
          h('button', { class: 'btn ghost icon needs-admin', title: 'Настройки агента', 'aria-label': 'Настройки агента', onclick: () => agentWizard({ profile: p.id, onDone: () => refresh() }) }, ic('gear')))),
      h('nav', { class: 'tabs' }, ...TABS.map(([id, label, n]) => h('button', { class: `tab${tab === id ? ' active' : ''}`, onclick: () => { tab = id; sync(); refresh(); } },
        label, n ? h('span', { class: 'nav-count' }, String(n)) : null))),
      h('div', { class: 'tab-body' }, ...body));
  }

  function sync() { history.replaceState(null, '', `#/agents?id=${enc(selected)}${tab !== 'overview' ? `&tab=${tab}` : ''}`); }
  function go(id) { selected = id; sync(); refresh(); }

  function render() {
    if (!root || !data) return;
    if (!data.profiles.some((p) => p.id === selected)) selected = data.profiles[0]?.id || '';
    const scroll = root.querySelector('.tab-body')?.scrollTop || 0;
    fill(root, h('div', { class: 'layout ag-layout' }, listPanel(), detailPanel()));
    const tb = root.querySelector('.tab-body');
    if (tb) tb.scrollTop = scroll;
  }

  async function loadAll() {
    await load(); await loadSlow();
    const p = data.profiles.find((x) => x.id === selected) || data.profiles[0];
    if (tab === 'net' && p) await loadNet(p);
  }

  async function refresh() {
    try { await loadAll(); } catch { return; }
    lastSig = ''; render();
  }

  async function poll() {
    // An open menu or dialog is not redrawn under the pointer.
    if (!root || document.hidden || document.querySelector('dialog[open]') || root.querySelector('details[open]')) return;
    try { await loadAll(); } catch { return; }
    const sig = JSON.stringify([selected, tab, Object.keys(state.isolated || {}), data.sandboxes.map((x) => [x.name, x.state, x.opening, x.agents?.length]),
      (window.liveApprovalsList || []).map((a) => a.id), data.profiles.map((p) => [p.id, p.updatedAt, p.files]),
      data.images, vault.map((v) => [v.name, v.mode]), tab === 'net' ? [net.key, net.entries.length, net.entries[0]?.ts, net.entries[0]?.open, net.denied.map((d) => d.count)] : 0,
      // The countdown of a waiting request.
      Math.floor(Date.now() / (tab === 'net' && data.profiles.some((p) => p.id === selected && asksOf(p).length) ? 1000 : 60000))]);
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
        sub: t.auto ? 'образ программы' : `из машины ${t.source}`, pill: pillOf(...tone) });
    });
    return h('section', { class: 'panel list-panel' },
      h('div', { class: 'panel-head' }, h('h2', { class: 'h-ic' }, ic('box'), 'Шаблоны')),
      h('div', { class: 'machines' }, ...templates,
        h('a', { class: `machine ag-item sb-item sb-add${active.kind === 'new-template' ? ' active' : ''}`, href: '#/sandbox?new=1' },
          h('span', { class: 'mark m-icon m-list' }, ic('plus')), h('div', { class: 'name' }, 'Новый шаблон'), h('span'), h('div', { class: 'meta' }, 'из машины с агентами'))));
  };

  // «?» next to «Создать агента»: how an agent is made and run.
  function guideButton() {
    const step = (n, title, text) => h('li', {}, h('b', {}, title), ' — ', text);
    return helpButton('Как работать с агентом',
      h('p', {}, 'Агент создаётся в одном окне «Создать агента», шаг за шагом. Готовое (секрет, белый список, директорию) можно выбрать, недостающее — создать там же: плитка с «+».'),
      h('ol', {},
        step(1, 'Программа', 'Claude Code, Codex, DSH, OpenCode… Её образ (шаблон машины) smolvm-web готовит один раз, несколько минут. Можно выбрать и шаблон своей машины.'),
        step(2, 'Политика', 'куда агент ходит в сеть, что делать с незнакомыми адресами, права в машине и запрещённые программы.'),
        step(3, 'Директории', 'какие директории компьютера получает агент — копией: git-репозиторий возвращается веткой, остальное — после вашей проверки.'),
        step(4, 'Секреты', 'ключи моделей и токены. Агент пользуется ими через шлюз и не видит значений.'),
        step(5, 'Агент', 'имя, память и как работает его машина: «Песочница» — каждый запуск чистая машина из шаблона; «Постоянная машина» — создаётся один раз, всё в ней сохраняется.')),
      h('p', {}, '«Запустить ▾» — выбрать программу машины, она откроется в новой вкладке. Пока агент работает, на месте кнопки — «Остановить»: песочница удаляется, постоянная машина выключается. Изменения в git-репозиториях приходят веткой во «Входящие».'),
      h('p', {}, 'Что агент просит (подключиться к незнакомому адресу, вызвать опасный API) — во вкладке «Журнал соединений» и во «Входящих».'),
      h('p', { class: 'muted small' }, 'Долгие шаги — подготовка образа, обновление — идут на сервере: окно можно закрыть, они продолжатся.'));
  }

  window.agentUi = { TRUST, trustPicker };
  // «Запустить» from elsewhere (the agent's memory page): its programs.
  window.agentsLaunch = ({ profile }) => { location.hash = `#/agents?id=${enc(profile)}&tab=programs`; };
  pages.agents = {
    render(el, p) {
      root = el;
      el.classList.add('page-agents');
      selected = p?.get('id') || selected;
      tab = ['programs', 'net'].includes(p?.get('tab')) ? p.get('tab') : 'overview';
      // Links of the guide: #/agents?create=… open «Создать агента» on that step.
      const step = p?.get('create');
      if (step) { history.replaceState(null, '', '#/agents'); setTimeout(() => create(step), 0); }
      fill(el, h('p', { class: 'muted' }, 'Загрузка…'));
      vaultAt = 0;
      refresh().catch((e) => fill(el, h('div', { class: 'error' }, e.message)));
      timer = setInterval(poll, 3000);
      // «Запустить ▾» closes on a click elsewhere.
      const outside = (e) => { for (const d of el.querySelectorAll('details.menu[open]')) if (!d.contains(e.target)) d.open = false; };
      document.addEventListener('click', outside);
      return () => { clearInterval(timer); document.removeEventListener('click', outside); el.classList.remove('page-agents'); root = null; };
    },
  };
})();
