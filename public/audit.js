'use strict';
// Page «Аудит»: who did what to which machine, file changes in rw folders.
// Export to SIEM (syslog / HTTP JSON) and alerts on bursts of blocked attempts
// live in the settings window, section «Аудит и SIEM» (window.auditSettingsCards).

(() => {
  let root = null;
  let timer = null;
  const filter = { machine: '', type: '', q: '' };
  const TYPES = [['', 'все'], ['exec', 'команды'], ['api', 'действия с машинами'], ['ui', 'настройки и ревью'], ['fs', 'файлы'], ['alert', 'оповещения']];
  const TYPE_TAG = { exec: ['', 'команда'], api: ['', 'машина'], ui: ['', 'smolvm-web'], fs: ['warn', 'файл'], alert: ['bad', 'оповещение'], test: ['', 'тест'] };

  function card(title, ...children) {
    return h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, title)), ...children);
  }

  async function renderLog() {
    const wrap = root?.querySelector('#audit-log');
    if (!wrap) return;
    let data;
    try {
      const q = new URLSearchParams({ machine: filter.machine, type: filter.type, q: filter.q, limit: '500' });
      data = await api('GET', `/ui/audit?${q}`);
    } catch (e) { fill(wrap, h('div', { class: 'error' }, e.message)); return; }
    if (!root?.contains(wrap)) return;
    const focused = document.activeElement && wrap.contains(document.activeElement) ? document.activeElement.name : null;
    const names = [...new Set([...state.machines.map((m) => m.name), ...data.entries.map((e) => e.machine).filter(Boolean)])].sort();
    const mSel = h('select', { class: 'input small', name: 'm' }, h('option', { value: '' }, 'все машины'), names.map((n) => h('option', { value: n, selected: n === filter.machine }, n)));
    const tSel = h('select', { class: 'input small', name: 't' }, TYPES.map(([v, t]) => h('option', { value: v, selected: v === filter.type }, t)));
    const qIn = h('input', { class: 'input small', name: 'q', placeholder: 'поиск', value: filter.q });
    mSel.addEventListener('change', () => { filter.machine = mSel.value; renderLog(); });
    tSel.addEventListener('change', () => { filter.type = tSel.value; renderLog(); });
    qIn.addEventListener('input', () => { filter.q = qIn.value; clearTimeout(qIn._t); qIn._t = setTimeout(renderLog, 300); });

    const what = (e) => {
      const d = e.detail || {};
      if (e.type === 'exec') return [h('div', {}, e.action === 'exec' ? '' : `${e.action}: `, h('code', {}, d.command || d.prompt || (d.commands != null ? `${d.commands} команд` : '') || '')),
        d.user ? h('div', { class: 'muted small' }, `пользователь: ${d.user}${d.workdir ? `, ${d.workdir}` : ''}`) : null];
      if (e.type === 'fs') return [h('div', {}, e.action, ': ', h('code', {}, d.path)), h('div', { class: 'muted small mono ellipsis', title: d.root }, d.root)];
      if (e.type === 'alert') return [h('div', { class: 'badc' }, e.action), d.hosts?.length ? h('div', { class: 'muted small mono' }, d.hosts.join(', ')) : null];
      return [h('div', {}, e.action), d.files?.length ? h('div', { class: 'muted small mono' }, d.files.join(', ')) : null];
    };
    const result = (e) => {
      if (e.exitCode != null) return h('span', { class: `tag ${e.exitCode === 0 ? 'ok' : 'bad'}` }, `код ${e.exitCode}`);
      if (e.status) return h('span', { class: `tag ${e.status < 400 ? 'ok' : 'bad'}` }, String(e.status));
      return '';
    };
    const table = data.entries.length ? h('div', { class: 'tbl-wrap log-wrap' }, h('table', { class: 'tbl log' },
      h('tr', {}, h('th', {}, 'Время'), h('th', {}, 'Кто'), h('th', {}, 'Машина'), h('th', {}, ''), h('th', {}, 'Что'), h('th', {}, 'Результат')),
      data.entries.map((e) => {
        const [cls, label] = TYPE_TAG[e.type] || ['', e.type];
        return h('tr', { class: e.type === 'alert' ? 'denied-row' : '' },
          h('td', { class: 'mono small nowrap' }, new Date(e.ts).toLocaleString()),
          h('td', { class: 'small' }, e.actor || '—'),
          h('td', { class: 'mono small' }, e.machine || (e.detail?.machines?.join(', ') || '—')),
          h('td', {}, h('span', { class: `tag ${cls}` }, label)),
          h('td', { class: 'small' }, what(e)),
          h('td', {}, result(e)));
      }))) : h('p', { class: 'muted' }, 'Записей нет.');
    fill(wrap,
      h('div', { class: 'card-head' }, h('h3', {}, 'Журнал действий'), h('span', { class: 'spacer' }), mSel, tSel, qIn,
        h('a', { class: 'btn', href: '/ui/audit/export', download: '' }, ic('download'), 'Экспорт JSONL')),
      table,
      h('p', { class: 'muted small' }, `Файл: ${data.file}. Под наблюдением (rw-папки работающих машин): ${data.watched.length ? data.watched.map((w) => `${w.path} → ${w.machines.join(', ')}`).join('; ') : 'нет'}.`));
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
        h('label', {}, 'Сетевые события фильтра «Доступ в сеть»', f.net),
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
        h('span', { class: 'spacer' }), h('a', { class: 'btn ghost', href: '#/log' }, 'Сетевой журнал →'))),
      h('section', { class: 'card', id: 'audit-log' }, h('p', { class: 'muted' }, 'Загрузка…')),
      h('p', { class: 'muted small' }, 'Экспорт в SIEM и оповещения о всплесках блокировок — в ',
        h('a', { href: '#', onclick: (e) => { e.preventDefault(); openSettings('audit'); } }, '«Настройки» → «Аудит и SIEM»'), '.'));
    renderLog();
  }

  window.auditSettingsCards = settingsCards;

  pages.audit = {
    render(el, p) {
      root = el;
      filter.machine = p.get('machine') || filter.machine;
      render();
      timer = setInterval(() => { if (!document.hidden && !el.querySelector('#audit-log :focus')) renderLog(); }, 4000);
      return () => { clearInterval(timer); root = null; };
    },
  };
})();
