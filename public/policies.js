'use strict';
// ⚙ → «Политики» (#/policies): named sets of restrictions a task works under — network,
// folders, the agent's account in the machine, processes, time. The list on the left,
// the chosen one on the right; the built-in ones (the former trust levels) are read-only.

(() => {
  let root = null;
  let list = [];
  let summaries = {};
  let lists = [];         // white lists of «Сеть»
  let selected = '';
  let dirty = false;

  const NET = [
    ['strict', 'Только разрешённое', 'Только адреса из белых списков. Всё остальное блокирует сама smolvm — обойти нельзя.'],
    ['soft', 'Без изоляции', 'Белые списки действуют только для программ, которые идут через прокси. Напрямую можно выйти в обход фильтра.'],
    ['off', 'Без ограничений', 'Фильтра нет: агент ходит куда угодно.'],
  ];
  const UNKNOWN = [['deny', 'Запрещать'], ['ask', 'Спрашивать вас'], ['allow', 'Пропускать']];
  const DEFAULT_DENY = ['ssh', 'scp', 'sftp', 'nc', 'ncat', 'netcat', 'socat', 'telnet', 'nmap'];
  const cur = () => list.find((p) => p.id === selected) || null;

  async function load() {
    const [r, eg] = await Promise.all([api('GET', '/ui/policies'), api('GET', '/ui/egress').catch(() => ({ lists: [] }))]);
    list = r.policies || []; summaries = r.summaries || {}; lists = eg.lists || [];
    if (selected !== 'new' && !cur()) selected = list[0]?.id || '';
  }

  const seg = (opts, value, onChange, disabled) => h('div', { class: 'seg' }, opts.map(([v, label]) =>
    h('button', { type: 'button', class: v === value ? 'active' : '', disabled: !!disabled, onclick: () => { if (v !== value) onChange(v); } }, label)));
  const row = (title, note, ctl) => h('div', { class: 'pol-row' }, h('div', { class: 'pol-text' }, h('b', {}, title), note ? h('div', { class: 'muted small' }, note) : null), ctl);
  const toggle = (on, onChange, disabled) => {
    const cb = h('input', { type: 'checkbox', checked: !!on, disabled: !!disabled });
    cb.addEventListener('change', () => onChange(cb.checked));
    return h('label', { class: 'switch' }, cb, h('span', {}));
  };
  const num = (value, onChange, ph, disabled) => {
    const x = h('input', { class: 'input', type: 'number', min: 0, value: value || '', placeholder: ph, disabled: !!disabled });
    x.addEventListener('input', () => onChange(Math.max(0, Math.floor(Number(x.value) || 0))));
    return x;
  };
  const section = (title, ...rows) => h('section', { class: 'pol-card pl-sec' }, h('div', { class: 'pl-sec-head' }, h('b', {}, title)), ...rows.filter(Boolean));

  // The form: a policy being edited (a copy of the chosen one; builtin ones read-only).
  function form(p) {
    const ro = !!p.builtin;
    const v = JSON.parse(JSON.stringify(p));
    const mark_ = () => { dirty = true; };
    const redraw = () => { const y = root.querySelector('.tab-body')?.scrollTop || 0; fill(body, ...parts()); root.querySelector('.tab-body').scrollTop = y; };
    const body = h('div', { class: 'pl-form' });
    const parts = () => {
      const listChecks = v.net.lists === 'default'
        ? h('div', { class: 'small muted' }, 'Списки «для новых машин» из ⚙ → «Сеть». ', ro ? null : h('a', { href: '#', onclick: (e) => { e.preventDefault(); v.net.lists = lists.filter((l) => l.default).map((l) => l.id); mark_(); redraw(); } }, 'Выбрать вручную'))
        : h('div', { class: 'chips' }, ...lists.map((l) => {
          const cb = h('input', { type: 'checkbox', checked: v.net.lists.includes(l.id), disabled: ro });
          cb.addEventListener('change', () => { v.net.lists = cb.checked ? [...new Set([...v.net.lists, l.id])] : v.net.lists.filter((x) => x !== l.id); mark_(); });
          return h('label', { class: `check chip-check${v.net.lists.includes(l.id) ? ' on' : ''}` }, cb, ` ${l.name}`);
        }), lists.length ? null : h('span', { class: 'muted small' }, 'Белых списков нет — ⚙ → «Сеть»'));
      const denyIn = h('textarea', { class: 'input mono', rows: 2, disabled: ro, placeholder: 'ssh scp nc socat' });
      denyIn.value = (v.processes.deny || []).join(' ');
      denyIn.addEventListener('input', () => { v.processes.deny = denyIn.value.split(/[\s,]+/).filter(Boolean); mark_(); });
      const rootsIn = h('textarea', { class: 'input mono', rows: 2, disabled: ro, placeholder: 'пусто — любые директории, которые можно давать (⚙ → «Директории»)' });
      rootsIn.value = (v.files.roots || []).join('\n');
      rootsIn.addEventListener('input', () => { v.files.roots = rootsIn.value.split('\n').map((x) => x.trim()).filter(Boolean); mark_(); });
      const modeCheck = (m, label) => {
        const cb = h('input', { type: 'checkbox', checked: v.files.modes.includes(m), disabled: ro });
        cb.addEventListener('change', () => { v.files.modes = cb.checked ? [...new Set([...v.files.modes, m])] : v.files.modes.filter((x) => x !== m); mark_(); });
        return h('label', { class: 'check' }, cb, ` ${label}`);
      };
      return [
        section('Сеть',
          row('Режим', NET.find(([k]) => k === v.net.mode)?.[2], seg(NET.map(([k, t]) => [k, t]), v.net.mode, (x) => { v.net.mode = x; if (x === 'off') v.net.unknown = 'allow'; else if (v.net.unknown === 'allow') v.net.unknown = 'deny'; mark_(); redraw(); }, ro)),
          v.net.mode === 'off' ? null : row('Незнакомые адреса', 'Что делать с адресом, которого нет в белых списках.', seg(UNKNOWN, v.net.unknown, (x) => { v.net.unknown = x; mark_(); redraw(); }, ro)),
          v.net.mode === 'off' ? null : h('div', { class: 'pol-row pl-col' }, h('div', { class: 'pol-text' }, h('b', {}, 'Белые списки'), h('div', { class: 'muted small' }, 'Серверы самого агента (API модели, вход по подписке) разрешаются всегда.')), listChecks)),
        section('Файлы',
          h('div', { class: 'pol-row pl-col' }, h('div', { class: 'pol-text' }, h('b', {}, 'Как агент может получать директории'), h('div', { class: 'muted small' }, 'Изменять — git-репозиторий веткой, директорию без git — копией с проверкой. Ничего не отмечено — задачи только без директорий.')),
            h('div', { class: 'row' }, modeCheck('review', 'Изменять (ветка или копия с проверкой)'), modeCheck('ro', 'Только чтение'))),
          h('div', { class: 'pol-row pl-col' }, h('div', { class: 'pol-text' }, h('b', {}, 'Только эти директории'), h('div', { class: 'muted small' }, 'По одной на строку; поддиректории тоже можно.')), rootsIn)),
        section('Учётная запись в машине',
          row('Права root (sudo)', 'Агент работает от пользователя node. С sudo он сможет ставить системные пакеты — но и обойти запреты программ ниже.', toggle(v.account.sudo, (x) => { v.account.sudo = x; mark_(); redraw(); }, ro)),
          v.account.sudo ? h('div', { class: 'pol-row' }, h('div', { class: 'small warnc' }, 'С sudo запреты программ работают только как журнал: агент может вернуть себе права. Для недоверенного кода не включайте.')) : null),
        section('Процессы',
          h('div', { class: 'pol-row pl-col' }, h('div', { class: 'pol-text' }, h('b', {}, 'Запрещённые программы'),
            h('div', { class: 'muted small' }, 'Агент не может их запустить; если запустит копию — процесс остановится и попадёт в «Журнал».')),
            denyIn, ro ? null : h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn ghost small-btn', onclick: () => { v.processes.deny = [...new Set([...(v.processes.deny || []), ...DEFAULT_DENY])]; mark_(); redraw(); } }, '+ сетевые утилиты'))),
          row('Журнал процессов', 'Каждый новый процесс машины — в «Журнал» (раздел «Процессы»), раз в несколько секунд.', toggle(v.processes.journal, (x) => { v.processes.journal = x; mark_(); }, ro)),
          row('Процессов у агента', 'ulimit -u: защита от бесконечного порождения процессов. Не меньше 32.', num(v.processes.pids, (x) => { v.processes.pids = x; mark_(); }, 'без лимита', ro)),
          row('Время работы агента, минут', 'Потом агент останавливается.', num(v.processes.agentMinutes, (x) => { v.processes.agentMinutes = x; mark_(); }, 'без лимита', ro))),
        section('Время и лимиты',
          row('Срок жизни задачи, часов', 'Потом задача закрывается сама; результат забирается в ветку.', num(v.time.ttlHours, (x) => { v.time.ttlHours = x; mark_(); }, 'без срока', ro)),
          row('Закрывать при простое, минут', 'Если агент столько не ходит в сеть и к модели.', num(v.time.idleMinutes, (x) => { v.time.idleMinutes = x; mark_(); }, 'не закрывать', ro)),
          row('Запросов к API в день', 'Через шлюз секретов; сверх лимита агент получает отказ.', num(v.time.apiPerDay, (x) => { v.time.apiPerDay = x; mark_(); }, 'без лимита', ro))),
      ];
    };
    fill(body, ...parts());
    const name = h('input', { class: 'input', value: v.name, maxlength: 60, disabled: ro });
    name.addEventListener('input', () => { v.name = name.value; mark_(); });
    const about = h('input', { class: 'input', value: v.about || '', maxlength: 300, disabled: ro, placeholder: 'для чего эта политика' });
    about.addEventListener('input', () => { v.about = about.value; mark_(); });
    const swatches = h('div', { class: 'pc-swatches', role: 'radiogroup', 'aria-label': 'Цвет иконки' });
    const drawSwatches = () => swatches.replaceChildren(...POLICY_COLORS.map(([c, label]) => h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(v.color === c), class: `pc-swatch pc-${c}${v.color === c ? ' on' : ''}`, disabled: ro,
      onclick: () => { v.color = c; mark_(); drawSwatches(); if (headIcon) headIcon.className = `mark m-icon pc pc-${c}`; },
    }, h('span', { class: 'pc-dot' }), label)));
    drawSwatches();
    const save = async () => {
      try {
        const r = p.id ? await api('PUT', `/ui/policies/${enc(p.id)}`, v) : await api('POST', '/ui/policies', v);
        dirty = false; selected = r.id; toast('Политика сохранена — действует для новых задач', 'ok');
        await refresh();
      } catch (e) { toast(e.message, 'err', 10000); }
    };
    return [
      ro ? h('div', { class: 'notice small' }, 'Встроенная политика — её нельзя изменить. Сделайте копию и поправьте её.') : h('section', { class: 'pol-card pl-sec' },
        h('div', { class: 'pol-row pl-col' }, h('label', { class: 'ws-field' }, 'Название', name), h('label', { class: 'ws-field' }, 'Описание', about),
          h('div', { class: 'ws-field' }, h('div', { class: 'label-like' }, 'Цвет иконки'), swatches))),
      body,
      ro ? null : h('div', { class: 'row pl-actions' }, h('span', { class: 'muted small' }, 'Открытые задачи не меняются: они работают по политике, с которой открылись.'), h('span', { class: 'spacer' }),
        h('button', { class: 'btn primary', onclick: save }, p.id ? 'Сохранить политику' : 'Создать политику')),
    ];
  }

  function usersCard(p) {
    const u = p.users || { agents: [] };
    const chips = [...u.agents.map((a) => h('a', { class: 'lst-host', href: `#/agents?id=${enc(a.id)}` }, `агент «${a.name}»`))];
    return h('section', { class: 'pol-card pl-sec' }, h('div', { class: 'pl-sec-head' }, h('b', {}, 'Кто использует')),
      h('div', { class: 'pol-row' }, chips.length ? h('div', { class: 'chips' }, ...chips) : h('span', { class: 'muted small' }, 'Ни один агент. В задаче политику можно выбрать и вручную.')));
  }

  let headIcon = null; // the head's icon: its colour follows the form
  function detail() {
    const p = selected === 'new' ? { name: 'Новая политика', about: '', ...JSON.parse(JSON.stringify(list.find((x) => x.id === 'normal') || {})), id: null, builtin: false, users: null } : cur();
    if (!p) return h('section', { class: 'panel detail-panel' }, h('div', { class: 'empty-state' }, h('p', {}, 'Политик нет.')));
    if (selected === 'new') p.name = 'Новая политика';
    const copy = async () => {
      try { const r = await api('POST', '/ui/policies', { from: p.id }); selected = r.id; toast('Копия создана — поправьте её', 'ok'); await refresh(); } catch (e) { toast(e.message, 'err'); }
    };
    const del = async () => {
      if (!(await confirmDialog('Удалить политику?', `«${p.name}» будет удалена. Открытые задачи продолжат работать по ней.`, false, '', 'Удалить')).ok) return;
      try { await api('DELETE', `/ui/policies/${enc(p.id)}`); selected = ''; toast('Политика удалена', 'ok'); await refresh(); } catch (e) { toast(e.message, 'err', 10000); }
    };
    return h('section', { class: 'panel detail-panel' },
      h('div', { class: 'detail-head' }, headIcon = policyIcon(p),
        h('div', { class: 'ag-title' }, h('h2', {}, p.name), h('span', { class: 'muted small' }, p.about || summaries[p.id] || '')),
        h('div', { class: 'actions' },
          p.id ? h('button', { class: 'btn needs-admin', onclick: copy }, 'Сделать копию') : null,
          p.id && !p.builtin ? h('button', { class: 'btn ghost icon danger needs-admin', title: 'Удалить', 'aria-label': 'Удалить политику', onclick: del }, ic('trash')) : null)),
      h('div', { class: 'tab-body' }, p.id ? usersCard(p) : null, ...form(p)));
  }

  function side() {
    const item = (p) => h('a', { class: `machine ag-item sb-item${p.id === selected ? ' active' : ''}`, href: `#/policies?id=${enc(p.id)}` },
      policyIcon(p, true), h('div', { class: 'name' }, p.name),
      p.builtin ? h('span', { class: 'ag-pill neutral' }, 'встроенная') : h('span'), h('div', { class: 'meta' }, summaries[p.id] || ''));
    return h('section', { class: 'panel list-panel' },
      h('div', { class: 'panel-head' }, h('h2', { class: 'h-ic' }, ic('policy'), 'Политики'),
        helpButton('Что такое политика',
          h('p', {}, 'Политика — набор ограничений, с которыми агент работает в задаче: куда ходить в сети, какие директории компьютера получать, какие права у его учётной записи в машине, какие программы запускать, сколько живёт задача.'),
          h('ul', {},
            h('li', {}, 'Агент указывает свою политику; в «Новой задаче» её можно выбрать другую.'),
            h('li', {}, 'Задача запоминает политику, с которой открылась: изменения действуют только на новые задачи.'),
            h('li', {}, '«Осторожно», «Обычно», «Доверяю» — встроенные; сделайте копию, чтобы поправить.'),
            h('li', {}, 'Политика администратора (⚙ → «Настройки…» → «Доступ») — потолок над всеми: мягче её задача не откроется.')))),
      h('div', { class: 'machines' }, ...list.map(item),
        h('a', { class: `machine ag-item sb-item sb-add needs-admin${selected === 'new' ? ' active' : ''}`, href: '#/policies?new=1' },
          h('span', { class: 'mark m-icon m-list' }, ic('plus')), h('div', { class: 'name' }, 'Новая политика'), h('span'), h('div', { class: 'meta' }, 'на основе «Обычно»'))));
  }

  function render() {
    if (!root) return;
    const p = cur();
    if (p && selected !== 'new' && location.hash !== `#/policies?id=${enc(p.id)}`) history.replaceState(null, '', `#/policies?id=${enc(p.id)}`);
    fill(root, h('div', { class: 'layout ag-layout' }, side(), detail()));
  }

  async function refresh() {
    try { await load(); } catch (e) { toast(e.message, 'err'); return; }
    render();
  }

  window.policiesList = async () => (await api('GET', '/ui/policies'));

  pages.policies = {
    render(el, params) {
      root = el; dirty = false;
      selected = params.get('new') ? 'new' : params.get('id') || selected;
      el.classList.add('page-agents');
      fill(el, h('p', { class: 'muted' }, 'Загрузка…'));
      load().then(render).catch((e) => fill(el, h('div', { class: 'error' }, e.message)));
      return () => { el.classList.remove('page-agents'); root = null; };
    },
  };
})();
