'use strict';
// «Уведомления» in the header: the latest of «Решения», the network log and the audit
// in one list, so nothing has to be looked for page by page. The counter shows what is
// waiting for a decision plus what appeared since the panel was last opened.

(() => {
  const SEEN_KEY = 'smolvm.notifSeen';
  const SOURCES = { decisions: 'Решение', journal: 'Сеть', audit: 'Аудит' };
  const TABS = [['all', 'Все'], ['decisions', 'Решения'], ['journal', 'Журнал сети'], ['audit', 'Аудит']];
  let items = [];
  let tab = 'all';
  let seenAtOpen = 0;  // what was new when the panel was opened: highlighted until it closes
  let busy = false;
  const btn = $('#btn-notif');
  const panel = $('#notif-panel');
  const count = $('#notif-count');

  const seen = () => { try { return Number(localStorage.getItem(SEEN_KEY)) || 0; } catch { return 0; } };
  const setSeen = (ts) => { try { localStorage.setItem(SEEN_KEY, String(ts)); } catch {} };
  const fresh = (i, since) => i.active || i.ts > since;
  const when = (ts) => {
    const m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return 'только что';
    if (m < 60) return `${m} мин назад`;
    const d = new Date(ts);
    return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  };

  async function load() {
    if (busy) return;
    busy = true;
    try { items = (await api('GET', '/ui/notifications')).items || []; } catch { return; } finally { busy = false; }
    const n = items.filter((i) => fresh(i, seen())).length;
    count.hidden = !n;
    count.textContent = n > 99 ? '99+' : n;
    btn.classList.toggle('has', !!n);
    if (!panel.hidden) draw();
  }

  function draw() {
    const list = items.filter((i) => tab === 'all' || i.source === tab);
    const per = (id) => items.filter((i) => (id === 'all' || i.source === id) && fresh(i, seenAtOpen)).length;
    panel.replaceChildren(
      h('div', { class: 'notif-head' }, h('b', {}, 'Уведомления'), h('span', { class: 'spacer' }),
        h('button', { class: 'btn ghost icon', type: 'button', title: 'Закрыть', 'aria-label': 'Закрыть', onclick: close }, ic('x'))),
      h('div', { class: 'notif-tabs', role: 'tablist' }, ...TABS.map(([id, label]) => {
        const n = per(id);
        return h('button', { type: 'button', role: 'tab', 'aria-selected': String(tab === id), class: `notif-tab${tab === id ? ' on' : ''}`, onclick: () => { tab = id; draw(); } },
          label, n ? h('span', { class: 'notif-tab-n' }, n) : null);
      })),
      h('div', { class: 'notif-list' }, ...(list.length ? list.slice(0, 60).map((i) => h('a', {
        class: `notif-item ${i.level}${fresh(i, seenAtOpen) ? ' new' : ''}`, href: i.href, onclick: close,
      }, h('span', { class: `notif-dot ${i.level}`, 'aria-hidden': 'true' }),
        h('span', { class: 'notif-body' },
          h('span', { class: 'notif-meta' }, h('span', { class: 'notif-src' }, SOURCES[i.source] || i.source), i.machine ? h('span', { class: 'mono' }, i.machine) : null, h('span', {}, when(i.ts))),
          h('span', { class: 'notif-text' }, i.text)))) : [h('div', { class: 'notif-empty muted' }, 'За последние сутки ничего не случилось.')])),
      h('div', { class: 'notif-foot' },
        h('a', { href: '#/decisions', onclick: close }, 'Решения'),
        h('a', { href: '#/log', onclick: close }, 'Журнал сети'),
        h('a', { href: '#/audit', onclick: close }, 'Аудит')));
  }

  function open() {
    seenAtOpen = seen();
    setSeen(Date.now());
    panel.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    draw();
    load();
  }
  function close() {
    panel.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    load();
  }

  btn.addEventListener('click', () => (panel.hidden ? open() : close()));
  // composedPath: a tab click redraws the panel and detaches its own target.
  document.addEventListener('click', (ev) => { if (!panel.hidden && !ev.composedPath().includes($('#notif'))) close(); });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !panel.hidden) close(); });
  load();
  setInterval(() => { if (!document.hidden) load(); }, 5000);
})();
