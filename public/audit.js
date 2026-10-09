'use strict';
// Page «Аудит»: who did what to which machine, file changes in rw folders.
// Export to SIEM (syslog / HTTP JSON) and alerts on bursts of blocked attempts
// live in the settings window, section «Аудит и SIEM» (window.auditSettingsCards).

(() => {
  let root = null;
  let timer = null;
  const filter = { machine: '', type: '', q: '' };

  function card(title, ...children) {
    return h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, title)), ...children);
  }

  let paused = false;

  // A segmented control (the same look as on «Сеть»).
  const segmented = (options, value, onChange) => h('div', { class: 'seg' }, options.map(([v, label]) =>
    h('button', { type: 'button', class: v === value ? 'active' : '', onclick: () => { if (v !== value) onChange(v); } }, label)));

  const KIND = {
    exec: { icon: 'terminal', label: 'Команда', cls: '' },
    api: { icon: 'server', label: 'Машина', cls: '' },
    ui: { icon: 'sliders', label: 'smolvm-web', cls: '' },
    fs: { icon: 'file', label: 'Файл', cls: 'warn' },
    alert: { icon: 'shield', label: 'Оповещение', cls: 'bad' },
    sandbox: { icon: 'box', label: 'Песочница', cls: '' },
    test: { icon: 'send', label: 'Тест', cls: '' },
  };

  function dayLabel(ts) {
    const d = new Date(ts); const today = new Date(); const y = new Date(Date.now() - 864e5);
    const same = (a, b) => a.toDateString() === b.toDateString();
    return same(d, today) ? 'Сегодня' : same(d, y) ? 'Вчера' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
  }

  async function renderLog() {
    const wrap = root?.querySelector('#audit-log');
    if (!wrap) return;
    let data; let day;
    try {
      const q = new URLSearchParams({ machine: filter.machine, type: filter.type, q: filter.q, limit: '500' });
      // The counters ignore the type filter: they are the way to set it.
      [data, day] = await Promise.all([api('GET', `/ui/audit?${q}`), api('GET', `/ui/audit?${new URLSearchParams({ machine: filter.machine, limit: '5000' })}`)]);
    } catch (e) { fill(wrap, h('div', { class: 'error' }, e.message)); return; }
    if (!root?.contains(wrap)) return;
    const focused = document.activeElement && wrap.contains(document.activeElement) ? document.activeElement.name : null;

    // Counters for the last 24 hours.
    const since = Date.now() - 864e5;
    const recent = day.entries.filter((e) => new Date(e.ts).getTime() >= since);
    const count = (t) => recent.filter((e) => e.type === t).length;
    const failed = recent.filter((e) => (e.exitCode != null && e.exitCode !== 0) || e.status >= 400).length;
    const tile = (type, icon, title, n, tone) => h('button', { type: 'button', class: `aud-tile${filter.type === type ? ' active' : ''}${tone && n ? ` ${tone}` : ''}`, onclick: () => { filter.type = filter.type === type ? '' : type; renderLog(); } },
      h('div', { class: 'set-tile-head' }, ic(icon), h('span', {}, title)), h('div', { class: 'aud-num' }, String(n)));
    const tiles = h('div', { class: 'aud-tiles' },
      tile('exec', 'terminal', 'Команды', count('exec')),
      tile('api', 'server', 'Действия с машинами', count('api')),
      tile('ui', 'sliders', 'Настройки и ревью', count('ui')),
      tile('fs', 'file', 'Изменения файлов', count('fs'), 'warn'),
      tile('alert', 'shield', 'Оповещения', count('alert'), 'bad'),
      h('div', { class: `aud-tile static${failed ? ' bad' : ''}` }, h('div', { class: 'set-tile-head' }, ic('x'), h('span', {}, 'С ошибкой')), h('div', { class: 'aud-num' }, String(failed))));

    // Filters
    const names = [...new Set([...state.machines.map((m) => m.name), ...data.entries.map((e) => e.machine).filter(Boolean)])].sort();
    const typeSeg = segmented([['', 'Все'], ['exec', 'Команды'], ['api', 'Машины'], ['ui', 'Настройки'], ['fs', 'Файлы'], ['alert', 'Оповещения'], ['sandbox', 'Песочницы']], filter.type, (v) => { filter.type = v; renderLog(); });
    const mSel = h('select', { class: 'input small', name: 'm' }, h('option', { value: '' }, 'Все машины'), names.map((n) => h('option', { value: n, selected: n === filter.machine }, n)));
    mSel.addEventListener('change', () => { filter.machine = mSel.value; renderLog(); });
    const qIn = h('input', { class: 'input small', name: 'q', placeholder: 'Поиск', value: filter.q });
    qIn.addEventListener('input', () => { filter.q = qIn.value; clearTimeout(qIn._t); qIn._t = setTimeout(renderLog, 300); });
    const live = h('button', { class: `btn small-btn log-live${paused ? '' : ' on'}`, title: paused ? 'Обновление остановлено' : 'Журнал обновляется каждые 4 секунды', onclick: () => { paused = !paused; renderLog(); } },
      h('span', { class: 'live-dot' }), paused ? 'Пауза' : 'Вживую');
    const toolbar = h('div', { class: 'log-toolbar' }, typeSeg, mSel, h('div', { class: 'log-search' }, ic('search'), qIn), h('span', { class: 'spacer' }), live,
      h('a', { class: 'btn small-btn', href: '/ui/audit/export', download: '', title: 'Весь журнал в формате JSON Lines' }, ic('download'), 'Экспорт'));

    // The feed, by day.
    const what = (e) => {
      const d = e.detail || {};
      if (e.type === 'exec') return [h('div', { class: 'ellipsis' }, e.action === 'exec' ? '' : `${e.action}: `, h('code', {}, d.command || d.prompt || (d.commands != null ? `${d.commands} команд` : '') || '')),
        d.user ? h('div', { class: 'muted small' }, `от ${d.user}${d.workdir ? ` · ${d.workdir}` : ''}`) : null];
      if (e.type === 'fs') return [h('div', { class: 'ellipsis' }, e.action, ': ', h('code', {}, d.path)), h('div', { class: 'muted small mono ellipsis', title: d.root }, d.root)];
      if (e.type === 'alert') return [h('div', { class: 'badc' }, e.action), d.hosts?.length ? h('div', { class: 'muted small mono ellipsis' }, d.hosts.join(', ')) : null];
      const extra = d.files?.length ? d.files.join(', ') : d.hostPath ? `${d.hostPath}${d.mode ? ` · ${d.mode}` : ''}`  : '';
      return [h('div', { class: 'ellipsis' }, e.action), extra ? h('div', { class: 'muted small mono ellipsis', title: extra }, extra) : null];
    };
    const result = (e) => {
      if (e.exitCode != null) return h('span', { class: `tag ${e.exitCode === 0 ? 'ok' : 'bad'}` }, e.exitCode === 0 ? 'успешно' : `код ${e.exitCode}`);
      if (e.status) return h('span', { class: `tag ${e.status < 400 ? 'ok' : 'bad'}`, title: `HTTP ${e.status}` }, e.status < 400 ? 'успешно' : `ошибка ${e.status}`);
      return null;
    };
    const rows = [];
    let lastDay = '';
    for (const e of data.entries) {
      const dl = dayLabel(e.ts);
      if (dl !== lastDay) { rows.push(h('div', { class: 'aud-day' }, dl)); lastDay = dl; }
      const k = KIND[e.type] || { icon: 'list', label: e.type, cls: '' };
      rows.push(h('div', { class: `aud-row ${e.type === 'alert' ? 'bad' : ''}` },
        h('span', { class: 'mono small muted' }, new Date(e.ts).toLocaleTimeString()),
        h('span', { class: `aud-kind ${k.cls}`, title: k.label }, ic(k.icon)),
        h('div', { class: 'aud-what small' }, ...what(e)),
        h('span', { class: 'mono small ellipsis', title: e.machine || '' }, e.machine || (e.detail?.machines?.join(', ') || h('span', { class: 'muted' }, '—'))),
        h('span', { class: 'small muted ellipsis', title: e.actor || '' }, e.actor || '—'),
        h('span', { class: 'right' }, result(e))));
    }
    const feed = data.entries.length ? h('div', { class: 'aud-feed' },
      h('div', { class: 'aud-row aud-head' }, h('span', {}, 'Время'), h('span', {}, ''), h('span', {}, 'Что произошло'), h('span', {}, 'Машина'), h('span', {}, 'Кто'), h('span', { class: 'right' }, 'Итог')),
      ...rows)
      : h('div', { class: 'log-empty' }, ic('shield'), h('div', {}, filter.type || filter.machine || filter.q ? 'Под фильтр ничего не попало.' : 'Записей пока нет.'));

    fill(wrap, tiles, toolbar, feed,
      h('div', { class: 'aud-foot small muted' },
        h('div', {}, 'Файл журнала: ', h('code', {}, data.file)),
        h('div', {}, 'Под наблюдением (папки на запись у работающих машин): ', data.watched.length
          ? data.watched.map((w) => h('span', { class: 'lst-host mono', title: w.machines.join(', ') }, w.path.replace(state.info?.home || '\u0000', '~'))) : 'нет'),
        h('div', {}, 'Экспорт в SIEM и оповещения — ', h('a', { href: '#', onclick: (ev) => { ev.preventDefault(); openSettings('audit'); } }, '«Настройки» → «Аудит и SIEM»'))));
    if (focused) wrap.querySelector(`[name=${focused}]`)?.focus();
  }

  async function settingsCards() {
    let st;
    try { st = await api('GET', '/ui/audit/settings'); } catch (e) { return [h('div', { class: 'error' }, e.message)]; }
    const sl = st.siem.syslog; const hp = st.siem.http; const al = st.alerts;
    const f = {
      slOn: h('input', { type: 'checkbox', checked: sl.enabled }),
      slHost: h('input', { class: 'input mono', value: sl.host, placeholder: 'siem.corp.local' }),
      slPort: h('input', { class: 'input mono', type: 'number', value: sl.port }),
      slProto: h('select', { class: 'input' }, ['udp', 'tcp'].map((x) => h('option', { value: x, selected: sl.proto === x }, x.toUpperCase()))),
      slFac: h('select', { class: 'input' }, [16, 17, 18, 19, 20, 21, 22, 23, 1, 4, 10, 13].map((x) => h('option', { value: x, selected: sl.facility === x }, x >= 16 ? `local${x - 16}` : String(x)))),
      hpOn: h('input', { type: 'checkbox', checked: hp.enabled }),
      hpUrl: h('input', { class: 'input mono', value: hp.url, placeholder: 'https://siem.corp.local/api/events' }),
      hpAuth: h('input', { class: 'input mono', type: 'password', autocomplete: 'new-password', placeholder: hp.hasAuthorization ? 'задан — оставьте пустым, чтобы не менять' : 'Bearer <token> (необязательно)' }),
      net: h('select', { class: 'input' }, [['none', 'не отправлять'], ['deny', 'только заблокированные'], ['all', 'все решения фильтра']].map(([v, t]) => h('option', { value: v, selected: st.siem.net === v }, t))),
      alOn: h('input', { type: 'checkbox', checked: al.enabled }),
      alN: h('input', { class: 'input', type: 'number', min: 1, value: al.threshold }),
      alW: h('input', { class: 'input', type: 'number', min: 5, value: al.windowSec }),
      alC: h('input', { class: 'input', type: 'number', min: 0, value: al.cooldownSec }),
      alHook: h('input', { class: 'input mono', value: al.webhook, placeholder: 'https://hooks.example.com/… (Slack/Teams/Mattermost-совместимый)' }),
    };
    const out = h('div', { class: 'small' });
    const save = async () => {
      try {
        await api('PUT', '/ui/audit/settings', {
          siem: { syslog: { enabled: f.slOn.checked, host: f.slHost.value.trim(), port: Number(f.slPort.value), proto: f.slProto.value, facility: Number(f.slFac.value) },
            http: { enabled: f.hpOn.checked, url: f.hpUrl.value.trim(), authorization: f.hpAuth.value.trim() }, net: f.net.value },
          alerts: { enabled: f.alOn.checked, threshold: Number(f.alN.value), windowSec: Number(f.alW.value), cooldownSec: Number(f.alC.value), webhook: f.alHook.value.trim() },
        });
        f.hpAuth.value = '';
        toast('Настройки аудита сохранены', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    };
    return [
      card('Экспорт в SIEM',
        h('label', { class: 'check' }, f.slOn, 'Syslog (RFC 5424, сообщение — JSON)'),
        h('div', { class: 'grid-siem' }, h('label', {}, 'Хост', f.slHost), h('label', {}, 'Порт', f.slPort), h('label', {}, 'Протокол', f.slProto), h('label', {}, 'Facility', f.slFac)),
        h('label', { class: 'check' }, f.hpOn, 'HTTP: POST пачки событий в JSON (Splunk HEC, Elastic, Graylog, Loki через прокси и т.п.)'),
        h('div', { class: 'grid2' }, h('label', {}, 'URL', f.hpUrl), h('label', {}, 'Заголовок Authorization', f.hpAuth)),
        h('label', {}, 'Сетевые события фильтра «Сеть»', f.net),
        h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: save }, 'Сохранить'),
          h('button', { class: 'btn', onclick: async () => { await save(); try { const r = await api('POST', '/ui/audit/test', {}); out.textContent = Object.entries(r).map(([k, v]) => `${k}: ${v}`).join(' · '); } catch (e) { out.textContent = e.message; } } }, 'Отправить тестовое событие'), out)),
      card('Оповещения',
        h('label', { class: 'check' }, f.alOn, 'Оповещать о всплеске заблокированных соединений'),
        h('div', { class: 'grid3' }, h('label', {}, 'Порог, попыток', f.alN), h('label', {}, 'Окно, секунд', f.alW), h('label', {}, 'Пауза между оповещениями, с', f.alC)),
        h('label', {}, 'Веб-хук для оповещений (POST JSON с полем text)', f.alHook),
        h('p', { class: 'muted small' }, 'Оповещение появляется в интерфейсе, пишется в журнал действий и уходит в SIEM, если он настроен.'),
        h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: save }, 'Сохранить'))),
    ];
  }

  async function render() {
    if (!root) return;
    fill(root,
      h('section', { class: 'card intro' }, h('div', { class: 'row' }, h('h2', { class: 'h-ic' }, ic('shield'), 'Аудит'),
        helpButton('Что попадает в аудит',
          h('ul', {},
            h('li', {}, 'Команды exec из консоли, init из Smolfile и установка агентов — с кодом выхода.'),
            h('li', {}, 'Действия с машинами: создание, запуск, остановка, удаление, ветки, загрузка файлов и образов.'),
            h('li', {}, 'Ревью (какие файлы применены на хост или отклонены), снимки и откаты, изменения секретов (без значений), доступа в сеть, директорий и настроек.'),
            h('li', {}, 'Изменения файлов в папках хоста, подключённых к работающим машинам на запись. Источник изменения (машина или человек на хосте) по файловой системе не различить — в записи перечислены машины с доступом на запись.'),
            h('li', {}, 'Команды, которые агент выполняет внутри машины сам (без exec через smolvm-web), сюда не попадают: smolvm их не сообщает. Их след — сетевой журнал и изменения файлов.'))),
        h('span', { class: 'spacer' }), h('a', { class: 'btn small-btn ghost', href: '#/egress?tab=log' }, ic('globe'), 'Сетевой журнал →')),
        h('p', { class: 'muted small' }, 'Кто что делал с машинами: команды, запуски и остановки, ревью, изменения настроек и файлов. За последние сутки:')),
      h('section', { class: 'card', id: 'audit-log' }, h('p', { class: 'muted' }, 'Загрузка…')));
    renderLog();
  }

  window.auditSettingsCards = settingsCards;

  pages.audit = {
    render(el, p) {
      root = el;
      filter.machine = p.get('machine') || filter.machine;
      render();
      timer = setInterval(() => { if (!paused && !document.hidden && !el.querySelector('#audit-log :focus')) renderLog(); }, 4000);
      return () => { clearInterval(timer); root = null; };
    },
  };
})();
