'use strict';
// Page «🌐 Интернет»: allow lists for the egress filter, per-machine policy, live log.

(() => {
  const DECISION = { true: ['ok', 'разрешено'], false: ['bad', 'заблокировано'] };
  let data = null;      // GET /ui/egress
  let root = null;
  let params = null;
  let logTimer = null;
  const logFilter = { machine: '', decision: '', q: '' };

  const machineNames = () => [...new Set([...state.machines.map((m) => m.name), ...Object.keys(data?.machines || {})])].sort();
  const stateOf = (name) => state.machines.find((m) => m.name === name)?.state;

  async function load() { data = await api('GET', '/ui/egress'); }

  function card(title, ...children) {
    return h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, title)), ...children);
  }

  // ---------- rule editor (lists and per-machine rules) ----------
  function ruleRow(r = {}) {
    const tr = h('tr', { class: 'rule' },
      h('td', {}, h('input', { class: 'input mono small-in', name: 'host', value: r.host || '', placeholder: 'api.example.com, .pypi.org, *.github.com, 10.0.0.0/8', spellcheck: 'false' })),
      h('td', {}, h('input', { class: 'input mono ports-in', name: 'ports', value: r.ports || '443', placeholder: '443', title: 'Порты: 443, 80, 8000-8100 или * — любой' })),
      h('td', {}, h('input', { class: 'input small-in', name: 'note', value: r.note || '', placeholder: 'зачем' })),
      h('td', { class: 'center' }, h('input', { type: 'checkbox', name: 'enabled', checked: r.enabled !== false, title: 'Включено' })),
      h('td', {}, h('button', { type: 'button', class: 'btn ghost danger', title: 'Удалить правило', onclick: () => tr.remove() }, '✕')));
    tr.dataset.id = r.id || '';
    return tr;
  }

  function readRules(tbody) {
    return [...tbody.querySelectorAll('tr.rule')].map((tr) => ({
      id: tr.dataset.id || undefined,
      host: tr.querySelector('[name=host]').value.trim(),
      ports: tr.querySelector('[name=ports]').value.trim(),
      note: tr.querySelector('[name=note]').value.trim(),
      enabled: tr.querySelector('[name=enabled]').checked,
    })).filter((r) => r.host);
  }

  function rulesEditor(rules, { onSave, extra = [] }) {
    const tbody = h('tbody', {}, rules.map(ruleRow));
    const err = h('div', { class: 'error', hidden: true });
    const bulk = h('textarea', { class: 'input mono', rows: 3, placeholder: 'По одному на строку: хост, URL или хост:порт\nhttps://api.openai.com\nfiles.pythonhosted.org\n.npmjs.org' });
    const bulkBox = h('div', { class: 'bulk', hidden: true }, bulk,
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', onclick: () => {
        for (const line of bulk.value.split(/\n|,/).map((x) => x.trim()).filter(Boolean)) tbody.append(ruleRow({ host: line, ports: '' }));
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
        h('thead', {}, h('tr', {}, h('th', {}, 'Хост / шаблон / CIDR'), h('th', {}, 'Порты'), h('th', {}, 'Заметка'), h('th', { class: 'center' }, 'Вкл'), h('th', {}, ''))),
        tbody)),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn', onclick: () => { const r = ruleRow(); tbody.append(r); r.querySelector('input').focus(); } }, '+ Правило'),
        h('button', { type: 'button', class: 'btn ghost', onclick: () => { bulkBox.hidden = !bulkBox.hidden; } }, 'Вставить списком'),
        tplSel, h('span', { class: 'spacer' }), ...extra, save),
      bulkBox, err);
  }

  // ---------- sections ----------
  function intro() {
    const st = data.status;
    const statusTag = st.listening ? h('span', { class: 'tag ok' }, `фильтр слушает :${st.port}`)
      : st.error ? h('span', { class: 'tag bad' }, `фильтр не запущен: ${st.error}`) : h('span', { class: 'tag' }, 'фильтр запустится, когда понадобится');
    return h('section', { class: 'card intro' },
      h('div', { class: 'row' }, h('h2', {}, '🌐 Доступ машин в интернет'), statusTag,
        h('span', { class: 'tag' }, data.corporateProxy ? 'выход: через корпоративный прокси' : 'выход: напрямую с хоста'),
        data.hostIp ? h('span', { class: 'tag' }, `адрес хоста для машин: ${data.hostIp}`) : h('span', { class: 'tag bad' }, 'адрес хоста не определён')),
      h('details', {}, h('summary', {}, 'Как это работает'),
        h('p', { class: 'small' }, 'Машине с включённым фильтром в HTTP_PROXY/HTTPS_PROXY подставляется прокси smolvm-web на хосте со своим токеном. Каждое соединение (CONNECT для HTTPS, обычные HTTP-запросы) сверяется с allow list машины: подключёнными списками и её собственными правилами. Разрешённое уходит в интернет хоста — через корпоративный прокси, если он настроен. Всё остальное получает 403 и попадает в журнал, откуда его можно разрешить одной кнопкой. Изменения правил действуют сразу, без перезапуска машины.'),
        h('ul', { class: 'small' },
          h('li', {}, h('code', {}, 'api.example.com'), ' — ровно этот хост; ', h('code', {}, '.example.com'), ' — хост и все поддомены; ', h('code', {}, '*.example.com'), ' — только поддомены; ', h('code', {}, '10.0.0.0/8'), ', ', h('code', {}, '192.0.2.10'), ' — IP-адреса; ', h('code', {}, '*'), ' — любой хост.'),
          h('li', {}, 'Порты: ', h('code', {}, '443'), ', ', h('code', {}, '443,80'), ', ', h('code', {}, '8000-8100'), ', ', h('code', {}, '*'), '. Путь внутри HTTPS не виден (TLS не расшифровывается) — фильтр работает по хосту и порту.'),
          h('li', {}, 'Адреса хоста, loopback, link-local (169.254.x — metadata) и частных сетей доступны только по явному правилу IP/CIDR — даже если разрешённое имя на них резолвится. ', h('code', {}, '*'), ' их не открывает.'),
          h('li', {}, h('b', {}, 'Жёсткая изоляция'), ': smolvm получает egress-политику «только IP хоста», так что программы, игнорирующие HTTP_PROXY, не выйдут в сеть в обход фильтра. Применяется при запуске через smolvm-web (машина должна быть остановлена). Учтите: машине станут доступны и другие сервисы хоста, слушающие внешний интерфейс.'),
          h('li', {}, 'Образы при старте скачиваются отдельным токеном, которому дополнительно разрешены реестры (настройка ниже).'))));
  }

  function machinesCard() {
    const names = machineNames();
    const rows = names.map((name) => {
      const m = data.machines[name] || { enabled: false, strict: false, lists: data.lists.filter((l) => l.default).map((l) => l.id), rules: [] };
      const st = stateOf(name);
      const on = h('input', { type: 'checkbox', checked: m.enabled });
      const strict = h('input', { type: 'checkbox', checked: m.strict, disabled: !m.enabled });
      const lists = h('div', { class: 'chips' }, data.lists.map((l) => h('label', { class: 'check chip-check' },
        h('input', { type: 'checkbox', value: l.id, checked: m.lists.includes(l.id), disabled: !m.enabled }), ` ${l.name}`)));
      const save = async (patch) => {
        try {
          const r = await api('PUT', `/ui/egress/machines/${enc(name)}`, patch);
          for (const n of r.notes || []) toast(`${name}: ${n}`);
          await load(); render();
        } catch (e) { toast(`${name}: ${e.message}`, 'err'); await load(); render(); }
      };
      on.addEventListener('change', () => save({ enabled: on.checked }));
      strict.addEventListener('change', () => save({ strict: strict.checked }));
      lists.addEventListener('change', () => save({ lists: [...lists.querySelectorAll('input:checked')].map((i) => i.value) }));
      const editRow = h('tr', { class: 'expand', hidden: !(params.get('machine') === name && m.enabled) },
        h('td', { colspan: 6 }, h('div', { class: 'small muted' }, `Собственные правила машины ${name} (в дополнение к спискам):`),
          rulesEditor(m.rules, { onSave: async (rules) => { await api('PUT', `/ui/egress/machines/${enc(name)}`, { rules }); toast(`${name}: правила сохранены`, 'ok'); await load(); render(); } })));
      const pending = m.enabled && m.strict !== !!m.strictApplied;
      const tr = h('tr', { class: params.get('machine') === name ? 'hl' : '' },
        h('td', { class: 'mono' }, name, st ? h('div', {}, h('span', { class: `badge ${st}` }, st)) : h('div', { class: 'muted small' }, 'нет в smolvm')),
        h('td', { class: 'center' }, on),
        h('td', { class: 'center' }, strict, pending ? h('div', { class: 'small warnc', title: 'Применится при следующем запуске через smolvm-web' }, 'при запуске') : null),
        h('td', {}, lists),
        h('td', {}, m.enabled ? h('button', { class: 'btn ghost', onclick: () => { editRow.hidden = !editRow.hidden; } }, `Свои правила (${m.rules.length})`) : null),
        h('td', {},
          h('button', { class: 'btn ghost', onclick: () => { logFilter.machine = name; renderLog(); root.querySelector('#eg-log')?.scrollIntoView({ behavior: 'smooth' }); } }, 'Журнал'),
          st === 'running' && m.enabled && pending ? h('button', { class: 'btn', onclick: async () => { await actions.restart(state.machines.find((x) => x.name === name)); await load(); render(); } }, '↻ Перезапустить') : null));
      return [tr, editRow];
    });
    return card('Машины',
      names.length ? h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Машина'), h('th', { class: 'center' }, 'Фильтр'), h('th', { class: 'center', title: 'Только хост в egress-политике smolvm' }, 'Жёстко'), h('th', {}, 'Списки'), h('th', {}, ''), h('th', {}, ''))),
        h('tbody', {}, rows.flat()))) : h('p', { class: 'muted' }, 'Машин пока нет.'),
      h('p', { class: 'muted small' }, 'Включение фильтра действует сразу для консоли, exec и профиля гостя (profile.d, pip, npm, apt, git); основной процесс машины и жёсткая изоляция переключаются при следующем запуске через smolvm-web.'));
  }

  function listsCard() {
    const box = h('div', { class: 'lists' });
    for (const l of data.lists) {
      const name = h('input', { class: 'input', value: l.name, maxlength: 64 });
      const def = h('input', { type: 'checkbox', checked: l.default });
      const users = Object.entries(data.machines).filter(([, m]) => m.lists.includes(l.id)).map(([n]) => n);
      box.append(h('div', { class: 'list-card' },
        h('div', { class: 'row' }, h('span', { class: 'muted small' }, 'Название'), name,
          h('label', { class: 'check small' }, def, ' подключать к новым машинам'),
          h('span', { class: 'muted small' }, users.length ? `используют: ${users.join(', ')}` : 'не используется')),
        rulesEditor(l.rules, {
          extra: [h('button', { type: 'button', class: 'btn ghost danger', onclick: async () => {
            const r = await confirmDialog('Удалить список?', `«${l.name}» будет отключён от машин${users.length ? `: ${users.join(', ')}` : ''}.`);
            if (!r.ok) return;
            await api('DELETE', `/ui/egress/lists/${enc(l.id)}`); await load(); render();
          } }, 'Удалить список')],
          onSave: async (rules) => {
            await api('PUT', `/ui/egress/lists/${enc(l.id)}`, { name: name.value, default: def.checked, rules });
            toast(`Список «${name.value}» сохранён`, 'ok'); await load(); render();
          },
        })));
    }
    const newName = h('input', { class: 'input', placeholder: 'Название нового списка, напр. «LLM API»' });
    const tpl = h('select', { class: 'input small' }, h('option', { value: '' }, 'пустой'), Object.entries(data.templates).map(([id, t]) => h('option', { value: id }, t.name)));
    return card('Списки разрешённых ресурсов', box,
      h('div', { class: 'row new-list' }, newName, h('span', { class: 'muted small' }, 'из шаблона'), tpl,
        h('button', { class: 'btn primary', onclick: async () => {
          const t = data.templates[tpl.value];
          const nm = newName.value.trim() || t?.name;
          if (!nm) { toast('Укажите название списка', 'err'); return; }
          try { await api('PUT', '/ui/egress/lists/new', { name: nm, default: false, rules: t ? t.rules.map((r) => ({ ...r, note: t.name })) : [] }); await load(); render(); }
          catch (e) { toast(e.message, 'err'); }
        } }, '+ Новый список')));
  }

  function logCard() {
    const wrap = h('section', { class: 'card', id: 'eg-log' });
    return wrap;
  }

  async function renderLog() {
    const wrap = root?.querySelector('#eg-log');
    if (!wrap) return;
    let entries = []; let denied = [];
    try {
      const q = new URLSearchParams({ machine: logFilter.machine, decision: logFilter.decision, q: logFilter.q, limit: '300' });
      [{ entries }, { denied }] = await Promise.all([api('GET', `/ui/egress/log?${q}`), api('GET', `/ui/egress/denied?machine=${enc(logFilter.machine)}`)]);
    } catch (e) { fill(wrap, h('div', { class: 'error' }, e.message)); return; }
    if (!root?.contains(wrap)) return;
    const focused = document.activeElement && wrap.contains(document.activeElement) ? document.activeElement.name : null;
    const machineSel = h('select', { class: 'input small', name: 'm' }, h('option', { value: '' }, 'все машины'), machineNames().map((n) => h('option', { value: n, selected: n === logFilter.machine }, n)));
    const decSel = h('select', { class: 'input small', name: 'd' }, [['', 'все'], ['deny', 'заблокированные'], ['allow', 'разрешённые']].map(([v, t]) => h('option', { value: v, selected: v === logFilter.decision }, t)));
    const qIn = h('input', { class: 'input small', name: 'q', placeholder: 'поиск по хосту', value: logFilter.q });
    machineSel.addEventListener('change', () => { logFilter.machine = machineSel.value; renderLog(); });
    decSel.addEventListener('change', () => { logFilter.decision = decSel.value; renderLog(); });
    qIn.addEventListener('input', () => { logFilter.q = qIn.value; clearTimeout(qIn._t); qIn._t = setTimeout(renderLog, 300); });

    const targets = (machine) => [
      ...(data.machines[machine]?.enabled ? [h('option', { value: 'machine' }, `правила машины ${machine}`)] : []),
      ...data.lists.map((l) => h('option', { value: l.id }, `список «${l.name}»`)),
    ];
    const deniedBox = denied.length ? h('div', { class: 'denied' },
      h('div', { class: 'small muted' }, 'Заблокировано недавно — можно разрешить:'),
      h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
        h('tr', {}, h('th', {}, 'Машина'), h('th', {}, 'Хост'), h('th', {}, 'Порт'), h('th', {}, 'Попыток'), h('th', {}, 'Причина'), h('th', {}, 'Разрешить в')),
        denied.map((d) => {
          const into = h('select', { class: 'input small' }, targets(d.machine));
          const isName = !/^[\d.]+$/.test(d.host) && !d.host.includes(':');
          const parent = d.host.split('.').slice(1).join('.');
          const scope = h('select', { class: 'input small', title: '.домен — вместе с поддоменами' }, h('option', { value: d.host }, d.host),
            isName ? h('option', { value: `.${d.host}` }, `.${d.host}`) : null,
            isName && parent.includes('.') ? h('option', { value: `.${parent}` }, `.${parent}`) : null);
          return h('tr', {},
            h('td', { class: 'mono small' }, d.machine), h('td', { class: 'mono' }, d.host), h('td', { class: 'mono' }, d.port),
            h('td', {}, d.count), h('td', { class: 'small muted' }, d.reason || ''),
            h('td', {}, h('div', { class: 'row nowrap' }, scope, into, h('button', { class: 'btn primary', onclick: async () => {
              try {
                await api('POST', '/ui/egress/allow', { machine: d.machine, host: scope.value, ports: String(d.port), into: into.value });
                toast(`${scope.value}:${d.port} разрешён`, 'ok'); await load(); render();
              } catch (e) { toast(e.message, 'err'); }
            } }, 'Разрешить'))));
        })))) : null;

    const fmtTime = (ts) => new Date(ts).toLocaleTimeString();
    const table = entries.length ? h('div', { class: 'tbl-wrap log-wrap' }, h('table', { class: 'tbl log' },
      h('tr', {}, h('th', {}, 'Время'), h('th', {}, 'Машина'), h('th', {}, ''), h('th', {}, 'Запрос'), h('th', {}, 'Правило / причина'), h('th', {}, 'Трафик')),
      entries.map((e) => h('tr', { class: e.allow ? '' : 'denied-row' },
        h('td', { class: 'mono small' }, fmtTime(e.ts)),
        h('td', { class: 'mono small' }, e.machine, e.pull ? h('span', { class: 'muted' }, ' (образы)') : null),
        h('td', {}, h('span', { class: `tag ${DECISION[!!e.allow][0]}` }, DECISION[!!e.allow][1])),
        h('td', { class: 'mono small' }, `${e.method} ${e.host}:${e.port}${e.path ? e.path : ''}`),
        h('td', { class: 'small' }, e.allow ? `${e.rule || ''}${e.source ? ` · ${e.source}` : ''}` : (e.reason || ''), e.error ? h('div', { class: 'badc' }, e.error) : null),
        h('td', { class: 'mono small' }, e.allow ? `↓${fmtBytes(e.bytesIn)} ↑${fmtBytes(e.bytesOut)}${e.open ? ' …' : ''}${e.via ? ` · ${e.via === 'proxy' ? 'корп.' : 'напр.'}` : ''}` : ''))))) : h('p', { class: 'muted' }, 'Записей нет.');
    fill(wrap,
      h('div', { class: 'card-head' }, h('h3', {}, 'Журнал соединений'), h('span', { class: 'spacer' }), machineSel, decSel, qIn),
      deniedBox, table,
      h('p', { class: 'muted small' }, `Последние ${entries.length} записей из памяти; полный журнал — ${state.info?.configDir || '…'}/egress.log`));
    if (focused) wrap.querySelector(`[name=${focused}]`)?.focus();
  }

  function checkCard() {
    const sel = h('select', { class: 'input small' }, machineNames().filter((n) => data.machines[n]?.enabled).map((n) => h('option', { value: n, selected: n === params.get('machine') }, n)));
    const target = h('input', { class: 'input mono', placeholder: 'https://api.openai.com/v1 или pypi.org:443' });
    const out = h('div', { class: 'small' });
    const run = async () => {
      if (!sel.value || !target.value.trim()) return;
      try {
        const r = await api('POST', '/ui/egress/check', { machine: sel.value, target: target.value.trim() });
        fill(out, h('span', { class: `tag ${r.allow ? 'ok' : 'bad'}` }, r.allow ? 'разрешено' : 'заблокировано'), ` ${r.host}:${r.port} — `, r.allow ? `правило ${r.rule} (${r.source})` : r.reason);
      } catch (e) { fill(out, h('span', { class: 'error' }, e.message)); }
    };
    target.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
    return card('Проверить доступ',
      sel.options.length ? h('div', { class: 'row' }, sel, target, h('button', { class: 'btn', onclick: run }, 'Проверить')) : h('p', { class: 'muted small' }, 'Нет машин с включённым фильтром.'),
      out);
  }

  function settingsCard() {
    const en = h('input', { type: 'checkbox', checked: data.defaults.enabled });
    const st = h('input', { type: 'checkbox', checked: data.defaults.strict });
    const pull = h('textarea', { class: 'input mono', rows: 4 }, data.pullHosts.join('\n'));
    const err = h('div', { class: 'error', hidden: true });
    return card('Настройки',
      h('label', { class: 'check' }, en, ' Включать фильтр для новых машин по умолчанию'),
      h('label', { class: 'check' }, st, ' …и жёсткую изоляцию'),
      h('label', {}, 'Реестры образов, доступные при скачивании образа на старте (не машине!)', pull),
      err,
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async () => {
        err.hidden = true;
        try {
          await api('PUT', '/ui/egress/settings', { defaults: { enabled: en.checked, strict: st.checked }, pullHosts: pull.value.split(/[\n,]/).map((x) => x.trim()).filter(Boolean) });
          toast('Настройки egress сохранены', 'ok'); await load(); render();
        } catch (e) { err.textContent = e.message; err.hidden = false; }
      } }, 'Сохранить')));
  }

  function render() {
    if (!root || !data) return;
    const y = root.scrollTop;
    fill(root, intro(), machinesCard(), listsCard(), logCard(), checkCard(), settingsCard());
    renderLog();
    root.scrollTop = y;
  }

  pages.egress = {
    render(el, p) {
      root = el; params = p;
      logFilter.machine = p.get('machine') || '';
      fill(el, h('p', { class: 'muted' }, 'Загрузка…'));
      load().then(render).catch((e) => fill(el, h('div', { class: 'error' }, e.message)));
      logTimer = setInterval(() => { if (!document.hidden && !el.querySelector('#eg-log .denied:hover, #eg-log .denied :focus')) renderLog(); }, 3000);
      return () => { clearInterval(logTimer); root = null; };
    },
  };
})();
