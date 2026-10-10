'use strict';
// Page «Сеть»: allow lists for the egress filter, per-machine policy, live log.

(() => {
  const DECISION = { true: ['ok', 'разрешено'], false: ['bad', 'заблокировано'] };
  let data = null;      // GET /ui/egress
  let root = null;
  let params = null;
  let logTimer = null;
  let logRoot = null;   // element of the «Журнал» page
  const logFilter = { machine: '', decision: '', q: '' };

  const machineNames = () => [...new Set([...state.machines.map((m) => m.name), ...Object.keys(data?.machines || {})])].sort();
  const stateOf = (name) => state.machines.find((m) => m.name === name)?.state;

  // Sections of the page: a bar on top, one section at a time (like «Директории»).
  const SECTIONS = [
    ['machines', 'server', 'Машины', 'Куда может ходить каждая машина: режим, что разрешено, что недавно заблокировано.'],
    ['log', 'list', 'Журнал', 'Все соединения машин: что разрешено, что заблокировано и почему. Заблокированное можно разрешить одной кнопкой.'],
    ['lists', 'shield', 'Списки', 'Наборы разрешённых адресов (PyPI, npm, GitHub…) для машин и реестры, откуда smolvm скачивает образы.'],
    ['settings', 'gear', 'Настройки', 'Что подставляется новым машинам, и как работает сам фильтр.'],
  ];
  let section = 'machines';
  const goSection = (id) => {
    section = id;
    if (id === 'log' && logFilter.machine) params.set('machine', logFilter.machine);
    const q = new URLSearchParams(params); q.set('tab', id); q.delete('focus');
    history.replaceState(null, '', `#/egress?${q}`);
    render();
  };

  let vendors = [];
  let denied = [];     // GET /ui/egress/denied: recent blocks, all machines     // GET /ui/agents/vendors: «Провайдеры» per machine
  let blocksMachine = '';
  async function load() {
    const [d, v, dn] = await Promise.all([api('GET', '/ui/egress'), api('GET', '/ui/agents/vendors').catch(() => ({ machines: [] })), api('GET', '/ui/egress/denied').catch(() => ({ denied: [] }))]);
    data = d; vendors = v.machines || []; denied = dn.denied || [];
  }

  function card(title, ...children) {
    return h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, title)), ...children);
  }

  // ---------- rule editor (lists and per-machine rules) ----------
  function ruleRow(r = {}, hostsOnly = false) {
    const tr = h('tr', { class: 'rule' },
      h('td', {}, h('input', { class: 'input mono small-in', name: 'host', value: r.host || '', placeholder: hostsOnly ? 'registry.example.com, *.example.com' : 'api.example.com, .pypi.org, *.github.com, 10.0.0.0/8', spellcheck: 'false' })),
      hostsOnly ? null : h('td', {}, h('input', { class: 'input mono ports-in', name: 'ports', value: r.ports || '443', placeholder: '443', title: 'Порты: 443, 80, 8000-8100 или * — любой' })),
      hostsOnly ? null : h('td', {}, h('input', { class: 'input small-in', name: 'note', value: r.note || '', placeholder: 'зачем' })),
      hostsOnly ? null : h('td', { class: 'center' }, h('input', { type: 'checkbox', name: 'enabled', checked: r.enabled !== false, title: 'Включено' })),
      h('td', {}, h('button', { type: 'button', class: 'btn ghost danger icon', title: 'Удалить правило', onclick: () => tr.remove() }, ic('x'))));
    tr.dataset.id = r.id || '';
    return tr;
  }

  function readRules(tbody) {
    return [...tbody.querySelectorAll('tr.rule')].map((tr) => ({
      id: tr.dataset.id || undefined,
      host: tr.querySelector('[name=host]').value.trim(),
      ports: tr.querySelector('[name=ports]')?.value.trim() || '',
      note: tr.querySelector('[name=note]')?.value.trim() || '',
      enabled: tr.querySelector('[name=enabled]')?.checked ?? true,
    })).filter((r) => r.host);
  }

  function rulesEditor(rules, { onSave, extra = [], hostsOnly = false }) {
    const tbody = h('tbody', {}, rules.map((r) => ruleRow(r, hostsOnly)));
    const err = h('div', { class: 'error', hidden: true });
    const bulk = h('textarea', { class: 'input mono', rows: 3, placeholder: 'По одному на строку: хост, URL или хост:порт\nhttps://api.openai.com\nfiles.pythonhosted.org\n.npmjs.org' });
    const bulkBox = h('div', { class: 'bulk', hidden: true }, bulk,
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', onclick: () => {
        for (const line of bulk.value.split(/\n|,/).map((x) => x.trim()).filter(Boolean)) tbody.append(ruleRow({ host: line, ports: '' }, hostsOnly));
        bulk.value = ''; bulkBox.hidden = true;
      } }, 'Добавить в таблицу')));
    const tplSel = h('select', { class: 'input small' }, h('option', { value: '' }, '+ из шаблона…'),
      Object.entries(data.templates).map(([id, t]) => h('option', { value: id }, t.name)));
    tplSel.addEventListener('change', () => {
      const t = data.templates[tplSel.value];
      if (t) for (const r of t.rules) tbody.append(ruleRow({ ...r, note: r.note || t.name }));
      tplSel.value = '';
    });
    const save = h('button', { type: 'button', class: 'btn primary' }, 'Сохранить');
    save.addEventListener('click', async () => {
      err.hidden = true; save.disabled = true;
      try { await onSave(readRules(tbody)); } catch (e) { err.textContent = e.message; err.hidden = false; } finally { save.disabled = false; }
    });
    return h('div', { class: 'rules-editor' },
      h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl rules' },
        h('thead', {}, h('tr', {}, hostsOnly ? [h('th', {}, 'Адрес реестра'), h('th', {}, '')] : [h('th', {}, 'Хост / шаблон / CIDR'), h('th', {}, 'Порты'), h('th', {}, 'Заметка'), h('th', { class: 'center' }, 'Вкл'), h('th', {}, '')])),
        tbody)),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn', onclick: () => { const r = ruleRow({}, hostsOnly); tbody.append(r); r.querySelector('input').focus(); } }, [ic('plus'), hostsOnly ? 'Адрес' : 'Правило']),
        h('button', { type: 'button', class: 'btn ghost', onclick: () => { bulkBox.hidden = !bulkBox.hidden; } }, 'Вставить списком'),
        hostsOnly ? null : tplSel, h('span', { class: 'spacer' }), ...extra, save),
      bulkBox, err);
  }

  // ---------- sections ----------
  function intro() {
    return h('section', { class: 'card intro' },
      h('div', { class: 'row' }, h('h2', { class: 'h-ic' }, ic('globe'), 'Доступ машин в сеть'), helpButton('Как работает фильтр «Сеть»',
        h('p', { class: 'small' }, 'Машине с включённым фильтром в HTTP_PROXY/HTTPS_PROXY подставляется прокси smolvm-web на хосте со своим токеном. Каждое соединение (CONNECT для HTTPS, обычные HTTP-запросы) сверяется с allow list машины: подключёнными списками и её собственными правилами. Разрешённое уходит в интернет хоста — через корпоративный прокси, если он настроен. Всё остальное получает 403 и попадает в журнал, откуда его можно разрешить одной кнопкой. Изменения правил действуют сразу, без перезапуска машины.'),
        h('ul', { class: 'small' },
          h('li', {}, h('code', {}, 'api.example.com'), ' — ровно этот хост; ', h('code', {}, '.example.com'), ' — хост и все поддомены; ', h('code', {}, '*.example.com'), ' — только поддомены; ', h('code', {}, '10.0.0.0/8'), ', ', h('code', {}, '192.0.2.10'), ' — IP-адреса; ', h('code', {}, '*'), ' — любой хост.'),
          h('li', {}, 'Порты: ', h('code', {}, '443'), ', ', h('code', {}, '443,80'), ', ', h('code', {}, '8000-8100'), ', ', h('code', {}, '*'), '. Путь внутри HTTPS не виден (TLS не расшифровывается) — фильтр работает по хосту и порту.'),
          h('li', {}, 'Адреса хоста, loopback, link-local (169.254.x — metadata) и частных сетей доступны только по явному правилу IP/CIDR — даже если разрешённое имя на них резолвится. ', h('code', {}, '*'), ' их не открывает.'),
          h('li', {}, h('b', {}, 'Жёсткая изоляция'), ': smolvm получает egress-политику «только IP хоста», так что программы, игнорирующие HTTP_PROXY, не выйдут в сеть в обход фильтра. Применяется при запуске через smolvm-web (машина должна быть остановлена). Учтите: машине станут доступны и другие сервисы хоста, слушающие внешний интерфейс.'),
          h('li', {}, 'Образы при старте скачиваются отдельным токеном, которому дополнительно разрешены реестры (вкладка «Списки» → «Реестры образов»).'))), h('span', { class: 'spacer' })),
      h('nav', { class: 'section-nav' }, SECTIONS.map(([id, icon, title]) => h('button', { type: 'button', class: id === section ? 'active' : '', onclick: () => goSection(id) }, ic(icon), title))),
      h('p', { class: 'muted small section-about' }, SECTIONS.find(([id]) => id === section)[3]));
  }

  // ---------- «Машины»: one card per machine ----------
  // A machine's network mode, from the filter record.
  const MODES = {
    off: ['Без ограничений', 'Машина ходит в интернет как этот компьютер.'],
    strict: ['Только разрешённое', 'Всё, чего нет в разрешённом, блокируется — обойти фильтр нельзя.'],
    record: ['Запись адресов', 'Временно: всё разрешено, адреса запоминаются, потом одной кнопкой станут правилами.'],
    soft: ['Только разрешённое, без изоляции', 'Для программ, которым нужны сервисы этого компьютера: фильтр работает через прокси, программа может его обойти.'],
  };
  const modeOf = (m) => (!m ? 'off' : m.learn ? 'record' : !m.enabled ? 'off' : m.strict ? 'strict' : 'soft');
  const MODE_PATCH = {
    off: { learn: false, enabled: false },
    strict: { learn: false, enabled: true, strict: true },
    soft: { learn: false, enabled: true, strict: false },
    record: { learn: true },
  };
  const openParts = new Set(); // `${machine}:rules|vendors` expanded

  function machinesCard() {
    const names = state.machines.map((m) => m.name);
    if (!names.length) return h('section', { class: 'card' }, h('p', { class: 'muted' }, 'Машин пока нет.'));
    return names.map(machineNetCard);
  }

  // A segmented control: options [[value, label, title]], current value, onChange.
  function segmented(options, value, onChange) {
    return h('div', { class: 'seg', role: 'radiogroup' }, options.map(([v, label, title]) => h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(v === value), class: v === value ? 'active' : '', title: title || '',
      onclick: () => { if (v !== value) onChange(v); },
    }, label)));
  }

  function machineNetCard(name) {
    const m = data.machines[name] || null;
    const mode = modeOf(m);
    const mach = state.machines.find((x) => x.name === name);
    const running = mach?.state === 'running';
    const save = async (patch, quiet) => {
      try {
        const r = await api('PUT', `/ui/egress/machines/${enc(name)}`, patch);
        for (const n of r.notes || []) toast(`${name}: ${n}`);
        if (!quiet) toast(`${name}: сохранено`, 'ok');
      } catch (e) { toast(`${name}: ${e.message}`, 'err'); }
      await load(); render();
    };
    // Three everyday modes; the rare «без изоляции» sits in the ⋯ of the card.
    const seg = segmented([
      ['off', 'Без ограничений', MODES.off[1]],
      ['strict', mode === 'soft' ? 'Только разрешённое*' : 'Только разрешённое', mode === 'soft' ? MODES.soft[1] : MODES.strict[1]],
      ['record', 'Запись адресов', MODES.record[1]],
    ], mode === 'soft' ? 'strict' : mode, (v) => save(MODE_PATCH[v], true));
    const pending = m?.enabled && !!m.strict !== !!m.strictApplied;
    const mk = state.marks?.[name];
    const toggle = (key) => { const k = `${name}:${key}`; if (openParts.has(k)) openParts.delete(k); else openParts.add(k); render(); };
    const isOpen = (key) => openParts.has(`${name}:${key}`);

    const head = h('div', { class: 'net-head' },
      mark(mk?.mark || 'vm', true),
      h('div', { class: 'net-title' },
        h('div', { class: 'row' }, h('b', { class: 'mono' }, name), mach ? h('span', { class: `badge ${mach.state}` }, mach.state) : null),
        h('div', { class: 'muted small' }, MODES[mode][1])),
      h('span', { class: 'spacer' }), seg);
    const parts = [head];
    if (pending) {
      parts.push(h('div', { class: 'notice small net-notice' }, ic('refresh'),
        h('span', {}, m.strict ? 'Изоляция включится при следующем запуске машины.' : 'Изоляция снимется при следующем запуске машины.'),
        h('span', { class: 'spacer' }),
        running && mach ? h('button', { class: 'btn small-btn', onclick: async () => { await actions.restart(mach); await load(); render(); } }, 'Перезапустить') : null));
    }
    if (mode === 'off') return h('section', { class: 'card machine-net off' }, ...parts);

    if (mode === 'record') {
      parts.push(h('div', { class: 'net-record' },
        h('div', {}, h('div', { class: 'net-big' }, String(m.learnedCount || 0)), h('div', { class: 'muted small' }, 'адресов записано')),
        h('div', { class: 'muted small net-record-text' }, 'Поработайте с агентом как обычно. Потом превратите записанное в правила — машина перейдёт в режим «Только разрешённое».'),
        h('button', { class: 'btn primary', disabled: !m.learnedCount, onclick: () => openLearned(name) }, 'Сделать правилами…')));
    }

    // Two columns: what is allowed | what was blocked recently.
    const lists = h('div', { class: 'chips' }, data.lists.map((l) => {
      const cb = h('input', { type: 'checkbox', value: l.id, checked: m.lists.includes(l.id) });
      cb.addEventListener('change', () => save({ lists: [...lists.querySelectorAll('input:checked')].map((i) => i.value) }, true));
      return h('label', { class: `check chip-check${m.lists.includes(l.id) ? ' on' : ''}`, title: l.rules.map((r) => `${r.host}:${r.ports}`).join('\n') }, cb, ` ${l.name}`);
    }));
    const vend = vendors.find((v) => v.name === name)?.vendor || [];
    const allowedV = vend.filter((v) => !v.revoked).length;
    const allowedCol = h('div', { class: 'net-col' },
      h('div', { class: 'net-col-title' }, 'Разрешено'),
      h('div', { class: 'muted small' }, 'Списки'), lists,
      h('div', { class: 'net-facts' },
        h('button', { class: `fact${isOpen('rules') ? ' active' : ''}`, onclick: () => toggle('rules') }, h('b', {}, String(m.rules.length)), h('span', {}, 'своих правил')),
        vend.length ? h('button', { class: `fact${isOpen('vendors') ? ' active' : ''}`, onclick: () => toggle('vendors') }, h('b', {}, `${allowedV}/${vend.length}`), h('span', {}, 'серверов агентов')) : null));
    const blocked = denied.filter((d) => d.machine === name);
    const blockedCol = h('div', { class: 'net-col' },
      h('div', { class: 'net-col-title' }, 'Недавно заблокировано', blocked.length ? h('span', { class: 'badge stopped' }, String(blocked.length)) : null),
      blocked.length ? h('div', { class: 'net-blocked' }, ...blocked.slice(0, 4).map((d) => blockedRow(name, d)),
        blocked.length > 4 ? h('a', { class: 'small', href: '#', onclick: (e) => { e.preventDefault(); logFilter.machine = name; goSection('log'); } }, `ещё ${blocked.length - 4} в журнале →`) : null)
        : h('div', { class: 'muted small net-empty' }, mode === 'record' ? 'В режиме записи ничего не блокируется.' : 'Пока ничего. Если агент упрётся в закрытый адрес, он появится здесь — с кнопкой «Разрешить».'));
    parts.push(h('div', { class: 'net-grid' }, allowedCol, blockedCol));

    if (isOpen('rules')) {
      parts.push(h('div', { class: 'net-panel' }, h('div', { class: 'net-col-title' }, 'Свои правила машины'),
        rulesEditor(m.rules, { onSave: async (rules) => { await api('PUT', `/ui/egress/machines/${enc(name)}`, { rules }); toast(`${name}: правила сохранены`, 'ok'); await load(); render(); } })));
    }
    if (isOpen('vendors') && vend.length) {
      parts.push(h('div', { class: 'net-panel' }, h('div', { class: 'net-col-title' }, 'Серверы агентов'),
        h('p', { class: 'muted small' }, 'Серверы вендоров агентов этой машины: API, вход по подписке, каталоги моделей. Разрешены по умолчанию; отозванный адрес блокируется сразу.'),
        ...vend.map((v) => h('div', { class: 'net-vendor' },
          h('span', { class: 'mono small' }, v.host), h('span', { class: 'muted small' }, `${v.purpose} · ${v.agents.join(', ')}`), h('span', { class: 'spacer' }),
          h('span', { class: `tag ${v.revoked ? 'bad' : 'ok'}` }, v.revoked ? 'отозван' : 'разрешён'),
          h('button', { class: 'btn ghost small-btn', onclick: () => toggleVendor(name, v, v.revoked) }, v.revoked ? 'Вернуть' : 'Отозвать')))));
    }
    if (isOpen('check')) parts.push(checkPanel(name));

    // Unknown destinations: refuse at once, or hold and ask a person.
    const ask = h('input', { type: 'checkbox', checked: !!m.ask });
    ask.addEventListener('change', () => save({ ask: ask.checked }, true));
    const askCtl = mode !== 'record' ? h('label', { class: 'check small', title: 'Неизвестный адрес не блокировать сразу, а спросить человека: «на 10 минут», «всегда» или «запретить»' }, ask, ' Спрашивать о незнакомых адресах') : null;

    // Actions of the card.
    parts.push(h('div', { class: 'net-actions' },
      h('button', { class: `btn small-btn${isOpen('check') ? ' active' : ''}`, onclick: () => toggle('check') }, ic('search'), 'Проверить адрес'),
      h('button', { class: `btn small-btn${isOpen('rules') ? ' active' : ''}`, onclick: () => toggle('rules') }, ic('plus'), 'Своё правило'),
      h('button', { class: 'btn small-btn', onclick: () => { logFilter.machine = name; goSection('log'); } }, ic('list'), 'Журнал'),
      askCtl,
      h('span', { class: 'spacer' }),
      mode !== 'record' ? h('button', { class: 'btn ghost small-btn', title: MODES.soft[1], onclick: () => save(MODE_PATCH[mode === 'soft' ? 'strict' : 'soft'], true) },
        mode === 'soft' ? 'Включить изоляцию' : 'Без изоляции…') : null));
    return h('section', { class: `card machine-net${params.get('machine') === name ? ' hl' : ''}`, id: `net-${name}` }, ...parts);
  }

  // A blocked destination with one-click allow (exact host, or the domain with subdomains).
  function blockedRow(name, d) {
    const isName = !/^[\d.]+$/.test(d.host) && !d.host.includes(':');
    const parent = d.host.split('.').slice(1).join('.');
    const allow = async (host) => {
      try { await api('POST', '/ui/egress/allow', { machine: name, host, ports: String(d.port), into: 'machine' }); toast(`${host}:${d.port} разрешён для ${name}`, 'ok'); }
      catch (e) { toast(e.message, 'err'); }
      await load(); render();
    };
    const more = isName ? h('select', { class: 'input small more-sel', title: 'Разрешить шире' },
      h('option', { value: '' }, '⋯'),
      h('option', { value: `.${d.host}` }, `+ поддомены ${d.host}`),
      parent.includes('.') ? h('option', { value: `.${parent}` }, `весь домен .${parent}`) : null) : null;
    more?.addEventListener('change', () => { if (more.value) allow(more.value); });
    return h('div', { class: 'net-block-row' },
      h('div', { class: 'net-block-main' }, h('div', { class: 'mono' }, d.host), h('div', { class: 'muted small' }, `порт ${d.port} · ${d.count} раз · ${new Date(d.last).toLocaleTimeString()}`)),
      h('button', { class: 'btn small-btn primary', onclick: () => allow(d.host) }, 'Разрешить'), more);
  }

  // «Проверить адрес»: will a request of the machine pass, and by which rule?
  function checkPanel(name) {
    const target = h('input', { class: 'input mono', placeholder: 'api.example.com, pypi.org:443 или https://…', autofocus: true });
    const out = h('div', { class: 'small net-check-out' });
    const run = async () => {
      if (!target.value.trim()) return;
      fill(out, h('span', { class: 'muted' }, 'Проверка…'));
      try {
        const r = await api('POST', '/ui/egress/check', { machine: name, target: target.value.trim() });
        fill(out, h('span', { class: `tag ${r.allow ? 'ok' : 'bad'}` }, r.allow ? '✓ пройдёт' : '✕ заблокируется'), ' ',
          h('span', { class: 'mono' }, `${r.host}:${r.port}`), ' ', h('span', { class: 'muted' }, r.allow ? `— правило ${r.rule} (${r.source})` : `— ${r.reason}`));
      } catch (e) { fill(out, h('span', { class: 'badc' }, e.message)); }
    };
    target.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
    requestAnimationFrame(() => target.focus());
    return h('div', { class: 'net-panel' }, h('div', { class: 'net-col-title' }, 'Проверить адрес'),
      h('div', { class: 'row' }, target, h('button', { class: 'btn primary', onclick: run }, 'Проверить')), out);
  }

  async function toggleVendor(machine, v, allowed) {
    try {
      const r = await api('PUT', `/ui/machines/${enc(machine)}/agents/vendor`, { host: v.host, allowed });
      toast(`${v.host}: ${allowed ? 'доступ возвращён' : 'доступ отозван'}${r.filter.enabled ? '' : ' (подействует, когда включите фильтр)'}`, allowed ? 'ok' : '');
    } catch (e) { toast(e.message, 'err'); }
    await load(); render();
  }

  // Learning mode: review collected hosts and turn them into a list.
  async function openLearned(name) {
    let items = [];
    try { items = (await api('GET', `/ui/egress/machines/${enc(name)}/learned`)).learned; } catch (e) { return toast(e.message, 'err'); }
    const rows = items.map((x) => {
      const cb = h('input', { type: 'checkbox', checked: !x.covered });
      const host = h('input', { class: 'input mono small-in', value: x.host, title: 'Можно заменить на .домен (с поддоменами) или *.домен' });
      const ports = h('input', { class: 'input mono ports-in', value: x.ports });
      return { cb, host, ports, tr: h('tr', {}, h('td', { class: 'center' }, cb), h('td', {}, host), h('td', {}, ports),
        h('td', { class: 'small' }, String(x.count)), h('td', { class: 'small muted' }, x.covered ? 'уже разрешён правилом' : new Date(x.last).toLocaleString())) };
    });
    const listName = h('input', { class: 'input', value: `Обучение: ${name}` });
    const body = [
      h('p', { class: 'muted small' }, `Хосты, к которым машина ${name} обращалась в режиме обучения. Отмеченные станут списком «${listName.value}», он подключится к машине, а обучение выключится — дальше работает обычный allow list.`),
      items.length ? h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
        h('tr', {}, h('th', {}, ''), h('th', {}, 'Хост'), h('th', {}, 'Порты'), h('th', {}, 'Запросов'), h('th', {}, 'Последний')),
        rows.map((r) => r.tr))) : h('p', { class: 'muted' }, 'Пока ничего не собрано — поработайте в машине (установка пакетов, запуск агента), затем вернитесь.'),
      h('label', {}, 'Название списка', listName),
    ];
    const dlg = $('#dlg-help');
    $('#help-title').replaceChildren(ic('globe'), `Режим обучения — ${name}`);
    const finish = h('button', { class: 'btn primary', onclick: async () => {
      const hosts = rows.filter((r) => r.cb.checked).map((r) => ({ host: r.host.value.trim(), ports: r.ports.value.trim() || '443' })).filter((x) => x.host);
      try {
        const r = await api('POST', `/ui/egress/machines/${enc(name)}/learn/finish`, { hosts, listName: listName.value.trim() });
        dlg.close();
        toast(r.list ? `${name}: создан список «${r.list.name}» (${r.rules} правил), обучение выключено` : `${name}: обучение выключено`, 'ok');
        await load(); render();
      } catch (e) { toast(e.message, 'err'); }
    } }, 'Создать список и выключить обучение');
    $('#help-body').replaceChildren(...body, h('div', { class: 'row' }, h('span', { class: 'spacer' }), h('button', { class: 'btn ghost', onclick: () => dlg.close() }, 'Продолжить обучение'), finish));
    dlg.showModal();
  }

  // ---------- «Списки»: a grid of list cards, one opens for editing ----------
  let editingList = null; // list id, 'new' or '__pull'
  const plural3 = (n, one, few, many) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many}`;

  function listsCard() {
    const usersOf = (l) => Object.entries(data.machines).filter(([, m]) => m.lists.includes(l.id)).map(([n]) => n);
    const preview = (hosts) => h('div', { class: 'lst-hosts' },
      ...hosts.slice(0, 6).map((x) => h('span', { class: 'lst-host mono' }, x)),
      hosts.length > 6 ? h('span', { class: 'muted small' }, `+ ещё ${hosts.length - 6}`) : null,
      hosts.length ? null : h('span', { class: 'muted small' }, 'Пока пусто — добавьте адреса.'));
    const edit = (id) => { editingList = editingList === id ? null : id; render(); };

    const cards = data.lists.map((l) => {
      const users = usersOf(l);
      if (editingList === l.id) return listEditor(l, users);
      return h('div', { class: 'lst-card' },
        h('div', { class: 'lst-head' }, h('span', { class: 'mark m-icon' }, ic('shield')),
          h('div', { class: 'lst-title' }, h('b', {}, l.name), h('div', { class: 'muted small' }, plural3(l.rules.length, 'адрес', 'адреса', 'адресов'))),
          h('span', { class: 'spacer' }), l.default ? h('span', { class: 'tag ok', title: 'Подключается к новым машинам' }, 'для новых машин') : null),
        preview(l.rules.map((r) => r.host + (r.ports && r.ports !== '443' ? `:${r.ports}` : ''))),
        h('div', { class: 'lst-foot' },
          h('span', { class: 'muted small' }, users.length ? `Подключён: ${users.join(', ')}` : 'Не подключён к машинам'),
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn small-btn', onclick: () => edit(l.id) }, 'Изменить')));
    });

    // Registries for the image download at start: a list too, but only for that.
    const pullCard = editingList === '__pull' ? pullEditor() : h('div', { class: 'lst-card lst-system' },
      h('div', { class: 'lst-head' }, h('span', { class: 'mark m-icon' }, ic('download')),
        h('div', { class: 'lst-title' }, h('b', {}, 'Реестры образов'), h('div', { class: 'muted small' }, `${plural3(data.pullHosts.length, 'адрес', 'адреса', 'адресов')} · агенту закрыто`)),
        h('span', { class: 'spacer' }), h('span', { class: 'tag', title: 'Действует для всех машин под фильтром, но только на скачивание образа при запуске' }, 'служебный')),
      h('p', { class: 'muted small' }, 'Откуда smolvm скачивает образ машины при запуске (Docker Hub, GitHub, Quay…). Разрешено только самому скачиванию — агенту в машине эти адреса закрыты.'),
      preview(data.pullHosts),
      h('div', { class: 'lst-foot' }, h('span', { class: 'muted small' }, 'Образ из своего реестра — добавьте его адрес'), h('span', { class: 'spacer' }),
        h('button', { class: 'btn small-btn', onclick: () => edit('__pull') }, 'Изменить')));

    const newCard = editingList === 'new' ? newListForm() : h('button', { type: 'button', class: 'lst-card lst-add', onclick: () => edit('new') },
      h('span', { class: 'lst-add-ic' }, ic('plus')), h('b', {}, 'Новый список'), h('span', { class: 'muted small' }, 'пустой или из шаблона: PyPI, npm, GitHub, Hugging Face…'));

    return [
      h('div', { class: 'lst-section' }, h('div', { class: 'net-col-title' }, 'Списки для машин'), h('span', { class: 'muted small' }, 'подключаются к машинам на вкладке «Машины»')),
      h('div', { class: 'lst-grid' }, ...cards, newCard),
      h('div', { class: 'lst-section' }, h('div', { class: 'net-col-title' }, 'Только для скачивания образа'), h('span', { class: 'muted small' }, 'агенту в машине эти адреса закрыты')),
      h('div', { class: 'lst-grid' }, pullCard),
    ];
  }

  function listEditor(l, users) {
    const name = h('input', { class: 'input', value: l.name, maxlength: 64 });
    const def = h('input', { type: 'checkbox', checked: l.default });
    return h('div', { class: 'lst-card lst-edit' },
      h('div', { class: 'lst-head' }, h('span', { class: 'mark m-icon' }, ic('shield')),
        h('label', { class: 'lst-name' }, 'Название', name),
        h('label', { class: 'check small' }, def, ' подключать к новым машинам'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn ghost icon', title: 'Закрыть без сохранения', onclick: () => { editingList = null; render(); } }, ic('x'))),
      users.length ? h('div', { class: 'muted small' }, `Подключён к машинам: ${users.join(', ')} — изменения действуют сразу.`) : null,
      rulesEditor(l.rules, {
        extra: [h('button', { type: 'button', class: 'btn ghost danger', onclick: async () => {
          const r = await confirmDialog('Удалить список?', `«${l.name}» будет отключён от машин${users.length ? `: ${users.join(', ')}` : ''}.`);
          if (!r.ok) return;
          await api('DELETE', `/ui/egress/lists/${enc(l.id)}`); editingList = null; await load(); render();
        } }, 'Удалить список')],
        onSave: async (rules) => {
          await api('PUT', `/ui/egress/lists/${enc(l.id)}`, { name: name.value, default: def.checked, rules });
          toast(`Список «${name.value}» сохранён`, 'ok'); editingList = null; await load(); render();
        },
      }));
  }

  function newListForm() {
    const name = h('input', { class: 'input', placeholder: 'например, «LLM API»', maxlength: 64 });
    const tpl = h('select', { class: 'input' }, h('option', { value: '' }, 'пустой'), Object.entries(data.templates).map(([id, t]) => h('option', { value: id }, t.name)));
    tpl.addEventListener('change', () => { if (data.templates[tpl.value]) name.placeholder = data.templates[tpl.value].name; });
    const create = async () => {
      const t = data.templates[tpl.value];
      const nm = name.value.trim() || t?.name;
      if (!nm) { toast('Укажите название списка', 'err'); return; }
      try {
        const r = await api('PUT', '/ui/egress/lists/new', { name: nm, default: false, rules: t ? t.rules.map((x) => ({ ...x, note: t.name })) : [] });
        editingList = r?.id || null; await load(); render();
      } catch (e) { toast(e.message, 'err'); }
    };
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });
    requestAnimationFrame(() => name.focus());
    return h('div', { class: 'lst-card lst-edit' },
      h('div', { class: 'lst-head' }, h('span', { class: 'mark m-icon' }, ic('plus')), h('b', {}, 'Новый список'), h('span', { class: 'spacer' }),
        h('button', { class: 'btn ghost icon', title: 'Закрыть', onclick: () => { editingList = null; render(); } }, ic('x'))),
      h('div', { class: 'grid2' }, h('label', {}, 'Название', name), h('label', {}, 'Начать с шаблона', tpl)),
      h('div', { class: 'row' }, h('span', { class: 'spacer' }), h('button', { class: 'btn primary', onclick: create }, 'Создать')));
  }

  function pullEditor() {
    return h('div', { class: 'lst-card lst-edit lst-system' },
      h('div', { class: 'lst-head' }, h('span', { class: 'mark m-icon' }, ic('download')), h('b', {}, 'Реестры образов'), h('span', { class: 'spacer' }),
        h('button', { class: 'btn ghost icon', title: 'Закрыть без сохранения', onclick: () => { editingList = null; render(); } }, ic('x'))),
      h('p', { class: 'muted small' }, 'При запуске машины под фильтром smolvm скачивает её образ изнутри машины — через фильтр, отдельным пропуском. Этому пропуску разрешены адреса ниже (порты 443 и 80); агенту в машине они закрыты. Корпоративные реестры из «Настройки» → «Репозитории» разрешены автоматически.'),
      rulesEditor(data.pullHosts.map((x) => ({ host: x })), {
        hostsOnly: true,
        onSave: async (rules) => {
          await api('PUT', '/ui/egress/settings', { pullHosts: rules.map((r) => r.host) });
          toast('Реестры образов сохранены', 'ok'); editingList = null; await load(); render();
        },
      }));
  }


  // ---------- «Журнал»: filters, what waits for a decision, the connection feed ----------
  let logPaused = false;

  async function renderLog() {
    const wrap = logRoot?.querySelector('#eg-log');
    if (!wrap) return;
    if (!data) { try { await load(); } catch {} }
    let entries = []; let waiting = [];
    try {
      const q = new URLSearchParams({ machine: logFilter.machine, decision: logFilter.decision, q: logFilter.q, limit: '300' });
      [{ entries }, { denied: waiting }] = await Promise.all([api('GET', `/ui/egress/log?${q}`), api('GET', `/ui/egress/denied?machine=${enc(logFilter.machine)}`)]);
    } catch (e) { fill(wrap, h('div', { class: 'error' }, e.message)); return; }
    if (!logRoot?.contains(wrap)) return;
    const focused = document.activeElement && wrap.contains(document.activeElement) ? document.activeElement.name : null;

    // Filters
    const decSeg = segmented([['', 'Все'], ['deny', 'Заблокированные'], ['allow', 'Разрешённые']], logFilter.decision, (v) => { logFilter.decision = v; renderLog(); });
    const machineSel = h('select', { class: 'input small', name: 'm' }, h('option', { value: '' }, 'Все машины'), machineNames().map((n) => h('option', { value: n, selected: n === logFilter.machine }, n)));
    machineSel.addEventListener('change', () => { logFilter.machine = machineSel.value; renderLog(); });
    const qIn = h('input', { class: 'input small', name: 'q', placeholder: 'Поиск по адресу', value: logFilter.q });
    qIn.addEventListener('input', () => { logFilter.q = qIn.value; clearTimeout(qIn._t); qIn._t = setTimeout(renderLog, 300); });
    const live = h('button', { class: `btn small-btn log-live${logPaused ? '' : ' on'}`, title: logPaused ? 'Обновление остановлено' : 'Журнал обновляется каждые 3 секунды', onclick: () => { logPaused = !logPaused; renderLog(); } },
      h('span', { class: 'live-dot' }), logPaused ? 'Пауза' : 'Вживую');
    const toolbar = h('div', { class: 'log-toolbar' }, decSeg, machineSel, h('div', { class: 'log-search' }, ic('search'), qIn), h('span', { class: 'spacer' }), live);

    // Waiting for a decision: blocked destinations, one click to allow.
    const waitBox = waiting.length && logFilter.decision !== 'allow' ? h('div', { class: 'log-waiting' },
      h('div', { class: 'net-col-title' }, 'Ждут решения', h('span', { class: 'badge stopped' }, String(waiting.length))),
      h('div', { class: 'log-wait-grid' }, ...waiting.slice(0, 12).map(waitCard)),
      waiting.length > 12 ? h('div', { class: 'muted small' }, `и ещё ${waiting.length - 12} — уточните фильтр`) : null) : null;

    // The feed
    const fmtTime = (ts) => new Date(ts).toLocaleTimeString();
    const feed = entries.length ? h('div', { class: 'log-feed' },
      h('div', { class: 'log-row log-head' }, h('span', {}, 'Время'), h('span', {}, ''), h('span', {}, 'Машина'), h('span', {}, 'Куда'), h('span', {}, 'Правило или причина'), h('span', { class: 'right' }, 'Трафик')),
      ...entries.map((e) => h('div', { class: `log-row ${e.allow ? 'ok' : 'bad'}` },
        h('span', { class: 'mono small muted' }, fmtTime(e.ts)),
        h('span', { class: `log-dot ${e.allow ? 'ok' : 'bad'}`, title: e.allow ? 'разрешено' : 'заблокировано' }),
        h('span', { class: 'mono small ellipsis' }, e.machine, e.pull ? h('span', { class: 'muted' }, ' · образ') : null),
        h('span', { class: 'mono small ellipsis', title: `${e.method} ${e.host}:${e.port}${e.path || ''}` }, h('span', { class: 'muted' }, `${e.method} `), `${e.host}:${e.port}`, e.path ? h('span', { class: 'muted' }, e.path) : null),
        h('span', { class: 'small ellipsis', title: e.error || '' }, e.allow ? h('span', { class: 'muted' }, `${e.rule || ''}${e.source ? ` · ${e.source}` : ''}`) : h('span', { class: 'badc' }, e.reason || 'заблокировано'), e.error ? h('span', { class: 'badc' }, ` · ${e.error}`) : null),
        h('span', { class: 'mono small muted right' }, e.allow ? `↓${fmtBytes(e.bytesIn)} ↑${fmtBytes(e.bytesOut)}${e.open ? ' …' : ''}` : ''))))
      : h('div', { class: 'log-empty' }, ic('list'), h('div', {}, logFilter.machine || logFilter.q || logFilter.decision ? 'Под фильтр ничего не попало.' : 'Соединений пока нет. Они появятся, когда машины под фильтром начнут ходить в сеть.'));

    fill(wrap, toolbar, waitBox,
      h('div', { class: 'net-col-title' }, 'Соединения', h('span', { class: 'muted small log-count' }, entries.length ? `последние ${entries.length}` : '')),
      feed,
      h('p', { class: 'muted small' }, `Полный журнал — в файле ${state.info?.configDir || '…'}/egress.log`));
    if (focused) wrap.querySelector(`[name=${focused}]`)?.focus();
  }

  // A blocked destination in the log: allow it for the machine, wider, or into a list.
  function waitCard(d) {
    const isName = !/^[\d.]+$/.test(d.host) && !d.host.includes(':');
    const parent = d.host.split('.').slice(1).join('.');
    const allow = async (host, into) => {
      try { await api('POST', '/ui/egress/allow', { machine: d.machine, host, ports: String(d.port), into }); toast(`${host}:${d.port} разрешён ${into === 'machine' ? `для ${d.machine}` : `в списке «${data.lists.find((l) => l.id === into)?.name}»`}`, 'ok'); }
      catch (e) { toast(e.message, 'err'); }
      await load(); renderLog();
    };
    const more = h('select', { class: 'input small more-sel', title: 'Разрешить шире или в общий список' },
      h('option', { value: '' }, '⋯'),
      isName ? h('option', { value: `.${d.host}|machine` }, `+ поддомены ${d.host}`) : null,
      isName && parent.includes('.') ? h('option', { value: `.${parent}|machine` }, `весь домен .${parent}`) : null,
      ...data.lists.map((l) => h('option', { value: `${d.host}|${l.id}` }, `в список «${l.name}»`)));
    more.addEventListener('change', () => { if (more.value) { const [host, into] = more.value.split('|'); allow(host, into); } });
    const filtered = !!data.machines[d.machine]?.enabled;
    return h('div', { class: 'log-wait' },
      h('div', { class: 'net-block-main' },
        h('div', { class: 'mono' }, `${d.host}:${d.port}`),
        h('div', { class: 'muted small' }, `${d.machine} · ${d.count} раз · ${new Date(d.last).toLocaleTimeString()}`),
        d.reason ? h('div', { class: 'small badc ellipsis', title: d.reason }, d.reason) : null),
      h('button', { class: 'btn small-btn primary', disabled: !filtered, title: filtered ? `Разрешить ${d.host}:${d.port} машине ${d.machine}` : 'Машина больше не под фильтром', onclick: () => allow(d.host, 'machine') }, 'Разрешить'),
      more);
  }

  // ---------- «Настройки»: defaults for new machines, the filter's own state ----------
  function settingsCard() {
    const d = data.defaults;
    const cur = !d.enabled ? 'off' : d.strict ? 'strict' : 'soft';
    const saveDefaults = async (v) => {
      try { await api('PUT', '/ui/egress/settings', { defaults: { enabled: v !== 'off', strict: v === 'strict' } }); toast('Режим для новых машин сохранён', 'ok'); }
      catch (e) { toast(e.message, 'err'); }
      await load(); render();
    };
    const modeCards = h('div', { class: 'set-modes' }, [['off', 'Без ограничений', MODES.off[1]], ['strict', 'Только разрешённое', `${MODES.strict[1]} Рекомендуется для агентов.`], ['soft', 'Только разрешённое, без изоляции', MODES.soft[1]]]
      .map(([v, t, desc]) => h('button', { type: 'button', class: `set-mode${v === cur ? ' sel' : ''}`, onclick: () => { if (v !== cur) saveDefaults(v); } },
        h('span', { class: 'set-radio' }), h('div', {}, h('div', { class: 'mode-title' }, t), h('div', { class: 'small muted' }, desc)))));
    const listToggles = h('div', { class: 'chips' }, data.lists.map((l) => {
      const cb = h('input', { type: 'checkbox', checked: l.default });
      cb.addEventListener('change', async () => {
        try { await api('PUT', `/ui/egress/lists/${enc(l.id)}`, { name: l.name, default: cb.checked, rules: l.rules }); } catch (e) { toast(e.message, 'err'); }
        await load(); render();
      });
      return h('label', { class: `check chip-check${l.default ? ' on' : ''}` }, cb, ` ${l.name} `, h('span', { class: 'muted small' }, `(${l.rules.length})`));
    }));

    const st = data.status;
    const tile = (icon, title, value, sub, tone) => h('div', { class: `set-tile${tone ? ` ${tone}` : ''}` },
      h('div', { class: 'set-tile-head' }, ic(icon), h('span', {}, title)), h('div', { class: 'set-tile-value' }, value), sub ? h('div', { class: 'small muted' }, sub) : null);

    return [
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h3', {}, 'Новые машины')),
        h('p', { class: 'muted small' }, 'Что подставляется в окно «Создать». При создании каждой машины это можно поменять.'),
        h('div', { class: 'label-like' }, 'Режим сети'), modeCards,
        h('div', { class: 'label-like' }, 'Сразу подключать списки'), listToggles,
        h('p', { class: 'muted small' }, 'Агентам их серверы (API, вход по подписке) и адреса для установки разрешаются автоматически — отдельно добавлять не нужно.')),
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h3', {}, 'Как работает фильтр'), h('span', { class: 'spacer' }),
          h('button', { class: 'btn small-btn ghost', onclick: () => openSettings('proxy') }, ic('gear'), 'Прокси компьютера')),
        h('div', { class: 'set-tiles' },
          tile('shield', 'Фильтр', st.listening ? 'Работает' : st.error ? 'Не запущен' : 'Ожидает',
            st.listening ? `порт ${st.port} на этом компьютере` : st.error || 'запустится, когда понадобится машине', st.listening ? 'ok' : st.error ? 'bad' : ''),
          tile('globe', 'Выход в интернет', data.corporateProxy ? 'Через корпоративный прокси' : 'Напрямую',
            data.corporateProxy ? 'разрешённое уходит через прокси из настроек' : 'разрешённое уходит с этого компьютера'),
          tile('server', 'Адрес компьютера для машин', data.hostIp || 'не определён',
            data.hostIp ? 'по нему машины находят фильтр и шлюз секретов' : 'машины не смогут найти фильтр — проверьте сеть', data.hostIp ? '' : 'bad'))),
    ];
  }



  function blocksCard() {
    const names = machineNames();
    if (!blocksMachine || !names.includes(blocksMachine)) blocksMachine = params.get('machine') || state.machines.find((m) => m.state === 'running')?.name || names[0] || '';
    const sel = h('select', { class: 'input small' }, names.map((n) => h('option', { value: n, selected: n === blocksMachine }, n)));
    const body = h('div');
    const draw = () => { body.replaceChildren(); if (blocksMachine) tabEgress(body, { name: blocksMachine }); };
    sel.addEventListener('change', () => { blocksMachine = sel.value; draw(); });
    draw();
    return h('section', { class: 'card', id: 'blocks' },
      h('div', { class: 'card-head' }, h('h3', {}, 'Заблокировано самой smolvm'), h('span', { class: 'spacer' }), names.length ? sel : null,
        h('button', { class: 'btn ghost icon', title: 'Обновить', onclick: draw }, ic('refresh'))),
      names.length ? body : h('p', { class: 'muted small' }, 'Машин пока нет.'));
  }

  function render() {
    if (!root || !data) return;
    const y = root.scrollTop;
    clearInterval(logTimer); logRoot = null;
    const body = { machines: machinesCard, log: logSection, lists: listsCard, settings: settingsCard }[section]();
    fill(root, intro(), body);
    if (section === 'log') startLog();
    root.scrollTop = y;
  }

  pages.egress = {
    render(el, p) {
      root = el; params = p;
      // Old links: ?focus=providers / tab=providers|check → the machine cards; tab=blocks → the log.
      section = { providers: 'machines', check: 'machines', blocks: 'log' }[p.get('tab') || p.get('focus')] || p.get('tab') || 'machines';
      logFilter.machine = p.get('machine') || '';
      if (p.get('decision')) logFilter.decision = p.get('decision');
      if (p.get('machine') && p.get('tab') !== 'log') {
        const k = p.get('focus') === 'providers' || p.get('tab') === 'providers' ? 'vendors' : null;
        if (k) openParts.add(`${p.get('machine')}:${k}`);
      }
      if (!SECTIONS.some(([id]) => id === section)) section = 'machines';
      fill(el, h('p', { class: 'muted' }, 'Загрузка…'));
      load().then(render).catch((e) => fill(el, h('div', { class: 'error' }, e.message)));
      return () => { clearInterval(logTimer); logRoot = null; root = null; };
    },
  };

  // «Журнал» tab: the connection log, then what smolvm itself blocked.
  function logSection() {
    const det = h('details', { class: 'card log-smolvm' },
      h('summary', {}, h('b', {}, 'Заблокировано самой smolvm'), h('span', { class: 'muted small' }, ' — попытки обойти фильтр в обход прокси (видны при изоляции)')));
    det.addEventListener('toggle', () => { if (det.open && !det.querySelector('#blocks')) det.append(blocksCard()); });
    return [h('section', { class: 'card', id: 'eg-log' }, h('p', { class: 'muted' }, 'Загрузка…')), det];
  }
  function startLog() {
    logRoot = root;
    renderLog();
    logTimer = setInterval(() => { if (logRoot && !logPaused && !document.hidden && !logRoot.querySelector('#eg-log .denied:hover, #eg-log .denied :focus, #eg-log select:focus, #eg-log input:focus')) renderLog(); }, 3000);
  }

  // Page «Журнал»: every request through the egress filter, with one-click allow.
  // The former page «Журнал» lives in «Сеть» now: old links land on its tab.
  pages.log = {
    render(el, p) {
      const q = new URLSearchParams(p); q.set('tab', 'log');
      location.replace(`#/egress?${q}`);
      return null;
    },
  };
})();
