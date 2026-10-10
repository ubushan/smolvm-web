'use strict';

// ---------- helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const enc = encodeURIComponent;

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// replaceChildren that skips null/false like h() does.
// "?" button that opens the help dialog with the given content.
function helpButton(title, ...content) {
  return h('button', { type: 'button', class: 'btn ghost icon help-btn', title: `Справка: ${title}`, 'aria-label': `Справка: ${title}`, onclick: () => {
    $('#help-title').replaceChildren(ic('help'), title);
    $('#help-body').replaceChildren(...content.flat().filter(Boolean).map((c) => (c instanceof Node ? c.cloneNode(true) : document.createTextNode(String(c)))));
    $('#dlg-help').showModal();
  } }, ic('help'));
}

// Inline icon from the sprite in index.html.
function ic(name) {
  const t = document.createElement('template');
  t.innerHTML = `<svg class="ic"><use href="#i-${name}"/></svg>`;
  return t.content.firstChild;
}

function fill(el, ...children) {
  el.replaceChildren(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

function fmtMb(mb) {
  if (mb == null) return '—';
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 ? 1 : 0)} GiB` : `${mb} MiB`;
}
function fmtBytes(b) {
  if (b == null) return '—';
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i && b < 10 ? 1 : 0)} ${u[i]}`;
}
function fmtAgo(sec) {
  if (!sec) return '—';
  const d = Date.now() / 1000 - sec;
  if (d < 60) return 'только что';
  if (d < 3600) return `${Math.floor(d / 60)} мин назад`;
  if (d < 86400) return `${Math.floor(d / 3600)} ч назад`;
  return new Date(sec * 1000).toLocaleString();
}
function fmtDuration(s) {
  if (s == null) return '—';
  const d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}д ${hh}ч` : hh ? `${hh}ч ${m}м` : `${m}м ${s % 60}с`;
}

// Shell-like split: handles 'single', "double" quotes and backslash escapes.
function shellSplit(str) {
  const out = []; let cur = ''; let q = null; let any = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (q) {
      if (c === q) q = null;
      else if (c === '\\' && q === '"' && i + 1 < str.length) cur += str[++i];
      else cur += c;
    } else if (c === '"' || c === "'") { q = c; any = true; }
    else if (c === '\\' && i + 1 < str.length) { cur += str[++i]; any = true; }
    else if (/\s/.test(c)) { if (cur || any) out.push(cur); cur = ''; any = false; }
    else cur += c;
  }
  if (cur || any) out.push(cur);
  return out;
}

function toast(msg, kind = '', ms) {
  const t = h('div', { class: `toast ${kind}` }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), ms || (kind === 'err' ? 8000 : 4000));
}

// ---------- API ----------
class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `HTTP ${status}`);
    this.status = status; this.code = body?.code; this.repairable = body?.repairable;
  }
}

async function api(method, path, body, opts = {}) {
  const headers = { 'X-Smolvm-UI': '1' };
  let payload = body;
  if (body !== undefined && !(body instanceof Blob) && !(body instanceof ArrayBuffer)) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(path, { method, headers, body: payload, signal: opts.signal });
  if (opts.raw) {
    if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => ({})));
    return res;
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

// Minimal SSE reader over fetch (supports POST bodies, unlike EventSource).
async function readSSE(res, onEvent) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '');
      let event = 'message'; const data = [];
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith(':')) continue;
        const c = line.indexOf(':');
        const field = c === -1 ? line : line.slice(0, c);
        let val = c === -1 ? '' : line.slice(c + 1);
        if (val.startsWith(' ')) val = val.slice(1);
        if (field === 'event') event = val;
        else if (field === 'data') data.push(val);
      }
      if (data.length || event !== 'message') onEvent(event, data.join('\n'));
    }
  }
}

// ---------- state ----------
const state = {
  machines: [],
  selected: localStorage.getItem('smolvm.selected') || null,
  tab: localStorage.getItem('smolvm.tab') || 'overview',
  busy: new Map(), // name -> label of in-flight action
  preparing: {},   // name -> { label, step } from the server (first start, init, agent install)
  healthy: false,
  info: null, // /ui/info: platform, upstream, proxy status
  filter: '',
};

// Per-tab teardown (abort streams etc.)
let tabCleanup = null;
function cleanupTab() { if (tabCleanup) { try { tabCleanup(); } catch {} tabCleanup = null; } }

// ---------- health / capacity ----------
async function refreshHealth() {
  const el = $('#health');
  try {
    const hres = await api('GET', '/health');
    state.healthy = true;
    el.className = 'health ok';
    const m = hres.machines;
    el.innerHTML = '<span class="dot"></span>';
    el.title = `smolvm ${hres.version}: smolvm serve подключён`;
    $('#list-status').textContent = `${m ? `${m.running}/${m.total} запущено` : ''}${hres.uptime_seconds != null ? ` · uptime ${fmtDuration(hres.uptime_seconds)}` : ''}`;
  } catch (e) {
    state.healthy = false;
    el.className = 'health bad';
    el.innerHTML = `<span class="dot"></span><span>API недоступен</span>`;
    el.title = 'smolvm serve не отвечает';
    $('#capacity').innerHTML = '';
    $('#list-status').textContent = '';
    return false;
  }
  try {
    const c = await api('GET', '/capacity');
    const memTotal = c.host_memory_total_mb;
    const used = c.used_memory_pss_mb ?? c.used_memory_mb;
    const cpuPct = navigator.hardwareConcurrency ? Math.min(100, (c.used_cpus / navigator.hardwareConcurrency) * 100) : null;
    $('#capacity').innerHTML = [
      stat('CPU', `${c.used_cpus.toFixed(2)}<small>/${c.allocated_cpus}</small>`, cpuPct),
      stat('Память', `${fmtMb(used)}<small>/${fmtMb(c.allocated_memory_mb)}</small>`, memTotal ? (used / memTotal) * 100 : null),
      stat('Диск', `${c.used_disk_gb}<small> GiB</small>`, null),
    ].join('');
  } catch { /* capacity is optional */ }
  return true;
}
function stat(label, value, pct) {
  return `<div class="stat"><div class="label">${esc(label)}</div><div class="value">${value}</div>${pct != null ? `<div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div>` : ''}</div>`;
}

// ---------- machines list ----------
async function refreshMachines() {
  if (!state.healthy) { renderList(); return; }
  try {
    const [res, prep, marks] = await Promise.all([api('GET', '/api/v1/machines'), api('GET', '/ui/preparing').catch(() => ({})), api('GET', '/ui/machines/marks').catch(() => state.marks || {})]);
    state.machines = (res.machines || []).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    state.preparing = prep || {};
    state.marks = marks || {};
  } catch (e) {
    state.machines = [];
  }
  renderList();
  // Keep the header of the detail view in sync with the list.
  if (state.selected) {
    const m = state.machines.find((x) => x.name === state.selected);
    if (m) updateDetailHead(m);
    else if ($('#detail').dataset.name === state.selected) renderDetail();
  }
}

function stateBadge(m) {
  const busy = state.busy.get(m.name);
  const prep = state.preparing?.[m.name];
  // Preparing (first start, Smolfile init, agent install) wins over a plain "запуск…".
  if (prep && (!busy || /запуск/.test(busy))) {
    return `<span class="badge prep" title="${esc(prep.step || '')}"><i class="spin" aria-hidden="true"></i>${esc(prep.label)}</span>`;
  }
  if (busy) return `<span class="badge busy"><i class="spin" aria-hidden="true"></i>${esc(busy.replace(/…$/, ''))}</span>`;
  return `<span class="badge ${esc(m.state)}">${esc(stateLabel(m.state))}</span>`;
}
function stateLabel(s) {
  return { running: 'работает', stopped: 'остановлена', created: 'создана', paused: 'на паузе', failed: 'сбой', missing: 'машины нет' }[s] || s;
}

function renderList() {
  const box = $('#machines');
  const set = (html) => { box.innerHTML = html; box.dataset.html = ''; };
  if (!state.healthy) {
    set(`<div class="list-empty">
      <p>Не удаётся подключиться к <b>smolvm serve</b>.</p>
      <p class="small">Запустите API-сервер:<br><code class="mono">smolvm serve start --listen ${esc(state.info?.listen || 'unix:///tmp/smolvm.sock')}</code><br>или перезапустите веб-сервер с <code class="mono">--autostart</code>.</p>
    </div>`);
    return;
  }
  const f = state.filter.toLowerCase();
  const list = state.machines.filter((m) => !f || m.name.toLowerCase().includes(f) || (m.image || '').toLowerCase().includes(f));
  if (!list.length) {
    set(`<div class="list-empty">${state.machines.length ? 'Ничего не найдено' : 'Машин пока нет.<br><br><button class="btn primary" onclick="openCreate()">Создать первую</button>'}</div>`);
    return;
  }
  const html = list.map((m) => `
    <div class="machine ${m.name === state.selected ? 'active' : ''} ${state.preparing?.[m.name] ? 'preparing' : m.state === 'running' ? 'running' : ''}" data-name="${esc(m.name)}">
      ${machineMark(m)}
      <div class="name">${esc(m.name)}</div>
      <div>${state.isolated?.[m.name] ? '<span class="badge failed" title="Kill switch: машина изолирована">изолирована</span>' : stateBadge(m)}</div>
      <div class="meta">${state.marks?.[m.name]?.sandbox ? '<span class="tag sbx">песочница</span> ' : ''}${m.cpus} vCPU · ${fmtMb(m.memoryMb)}${m.network ? ' · net' : ''}${m.branchable ? ' · branchable' : ''}${m.parentMachine ? ` · ⑂ ${esc(m.parentMachine)}` : ''}</div>
    </div>`).join('');
  if (box.dataset.html !== html) { box.innerHTML = html; box.dataset.html = html; }
}

// Preset icon of a machine in the list: its agent profile, else a plain VM.
function machineMark(m) {
  const x = state.marks?.[m.name];
  const el = mark(x?.mark || 'vm', true);
  el.title = x?.title ? `Пресет: ${x.title}` : 'Машина без пресета';
  el.classList.add('m-list');
  return el.outerHTML;
}

$('#machines').addEventListener('click', (e) => {
  const row = e.target.closest('.machine');
  if (row) select(row.dataset.name);
});
$('#filter').addEventListener('input', (e) => { state.filter = e.target.value; renderList(); });
// Search: a magnifier that expands into the filter field.
{
  const box = $('#search');
  const input = $('#filter');
  const setOpen = (open) => {
    box.classList.toggle('open', open);
    input.tabIndex = open ? 0 : -1;
    if (open) input.focus();
  };
  $('#btn-search').addEventListener('click', () => {
    if (!box.classList.contains('open')) return setOpen(true);
    if (input.value) { input.value = ''; state.filter = ''; renderList(); input.focus(); } else setOpen(false);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { input.value = ''; state.filter = ''; renderList(); setOpen(false); $('#btn-search').focus(); }
  });
  input.addEventListener('blur', () => { if (!input.value) setTimeout(() => { if (document.activeElement !== input) setOpen(false); }, 120); });
  // "/" focuses search when not typing elsewhere.
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) && !document.querySelector('dialog[open]') && state.page === 'machines') { e.preventDefault(); setOpen(true); }
  });
}
$('#btn-refresh').addEventListener('click', () => tick());

function select(name) {
  if (state.selected === name && $('#detail').dataset.name === name) return;
  state.selected = name;
  localStorage.setItem('smolvm.selected', name || '');
  renderList();
  renderDetail();
}

// ---------- actions ----------
async function action(name, label, fn, okMsg) {
  state.busy.set(name, label);
  renderList();
  const m = state.machines.find((x) => x.name === name);
  if (m) updateDetailHead(m);
  try {
    const r = await fn();
    if (okMsg) toast(okMsg, 'ok');
    return r;
  } catch (e) {
    if (e.code === 'ROOTFS_BROKEN') rootfsToast(name, e);
    else if (e.code === 'PULL_CERT') {
      toast(h('div', {}, h('div', { style: 'white-space:pre-wrap' }, `${name}: ${e.message}`),
        h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'btn primary', onclick: () => openSettings('ca') }, 'Открыть настройки сертификатов'))), 'err', 60000);
    } else if (e.code === 'PULL_DOCKERHUB') {
      toast(h('div', {}, h('div', { style: 'white-space:pre-wrap' }, `${name}: ${e.message}`),
        h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'btn primary', onclick: () => openCreate() }, 'Создать машину'))), 'err', 60000);
    } else if (e.code === 'PULL_FORBIDDEN') toast(h('div', { style: 'white-space:pre-wrap' }, `${name}: ${e.message}`), 'err', 60000);
    else toast(`${name}: ${e.message}`, 'err');
    throw e;
  } finally {
    state.busy.delete(name);
    await refreshMachines();
    if ($('#detail').dataset.name === name && state.tab === 'overview') renderTab();
  }
}

// Windows: smolvm's agent rootfs was extracted without symlinks. Offer the repair.
async function repairRootfs() {
  try {
    const r = await api('POST', '/ui/host/repair-rootfs', {});
    toast(r.removed.length ? `Испорченная распаковка rootfs удалена (${r.removed.length}). Запустите машину снова — smolvm распакует rootfs заново.` : 'Испорченных распаковок rootfs не найдено.', 'ok', 10000);
  } catch (e) { toast(e.message, 'err', 15000); }
  await refreshInfo();
  renderHostWarning();
}
function rootfsToast(name, e) {
  toast(h('div', {}, h('div', { style: 'white-space:pre-wrap' }, `${name}: ${e.message}`),
    h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'btn primary', onclick: repairRootfs }, 'Починить'))), 'err', 60000);
}
// A banner above the machines while the host cannot boot machines.
function renderHostWarning() {
  const box = $('#host-warning');
  const w = state.info?.winHost;
  if (!box) return;
  // No symlink right is fine once smolvm's rootfs is extracted correctly (e.g. by one elevated run).
  if (!w?.windows || ((w.symlinks !== false || w.ready) && !w.broken?.length)) { box.hidden = true; box.replaceChildren(); return; }
  box.hidden = false;
  box.replaceChildren(
    h('div', {}, h('b', {}, 'smolvm не сможет загрузить машины. '),
      w.broken?.length
        ? `Его агентский rootfs распакован без символических ссылок (нет /sbin/init) — ошибка «boot process exited (code 127)». `
        : 'У smolvm-web нет права создавать символические ссылки, поэтому smolvm распакует свой rootfs без них и машины не загрузятся. ',
      w.symlinks === false ? 'Включите «Режим разработчика» (Параметры → Система → Для разработчиков), или пусть администратор выдаст вашей учётной записи право «Создание символических ссылок», или один раз запустите smolvm от администратора — дальше smolvm-web работает от обычного пользователя' : '',
      w.symlinks === false && w.broken?.length ? ', затем нажмите «Починить».' : w.broken?.length ? 'Нажмите «Починить» — распаковка будет удалена, smolvm сделает её заново.' : '.'),
    w.broken?.length ? h('button', { class: 'btn primary', onclick: repairRootfs }, 'Починить') : null);
}

const actions = {
  start: (m, branchable) => action(m.name, state.info?.proxyActive ? 'запуск (прокси)…' : 'запуск…', async () => {
    const r = await api('POST', `/api/v1/machines/${enc(m.name)}/start${branchable ? '?branchable=true' : ''}`, {});
    reportStart(m.name, r);
    return r;
  }, `${m.name} запущена`),
  restart: (m) => action(m.name, 'перезапуск…', async () => {
    const r = await api('POST', `/ui/machines/${enc(m.name)}/restart`, {});
    reportStart(m.name, r);
    return r;
  }, `${m.name} перезапущена`),
  async provision(m) {
    await action(m.name, 'настройка…', async () => {
      const r = await api('POST', `/ui/machines/${enc(m.name)}/provision`, {});
      reportProvision(m.name, { ok: true, ...r }, true);
    });
  },
  stop: (m) => action(m.name, 'остановка…', () => api('POST', `/api/v1/machines/${enc(m.name)}/stop`, {}), `${m.name} остановлена`),
  isolate: (m) => action(m.name, 'изоляция…', async () => {
    const r = await api('POST', `/ui/machines/${enc(m.name)}/isolate`, { on: true });
    await pollLive(); await refreshMachines();
    toast(`${m.name} изолирована: оборвано соединений — ${r.dropped}, токенов заменено — ${r.rotated}${r.paused ? ', машина на паузе' : r.pauseError ? `; пауза не удалась: ${r.pauseError}` : ''}`, r.pauseError ? 'err' : 'ok', 15000);
    return r;
  }),
  unisolate: (m) => action(m.name, 'снятие изоляции…', async () => {
    await api('POST', `/ui/machines/${enc(m.name)}/isolate`, { on: false });
    await pollLive(); await refreshMachines();
  }, `${m.name}: изоляция снята — возобновите машину и перезапустите агентов (у них новые токены)`),
  pause: (m) => action(m.name, 'пауза…', () => api('POST', `/api/v1/machines/${enc(m.name)}/pause`, {}), `${m.name} на паузе`),
  resume: (m) => action(m.name, 'возобновление…', () => api('POST', `/api/v1/machines/${enc(m.name)}/resume`, {}), `${m.name} возобновлена`),
  async remove(m) {
    const res = await confirmDialog('Удалить машину?', `Машина «${m.name}» и её диски будут удалены без возможности восстановления.`, true);
    if (!res.ok) return;
    const q = new URLSearchParams();
    if (res.force) q.set('force', 'true');
    await action(m.name, 'удаление…', () => api('DELETE', `/api/v1/machines/${enc(m.name)}${q.size ? `?${q}` : ''}`), `${m.name} удалена`);
    if (state.selected === m.name) select(null);
  },
  branch(m) {
    $('#branch-src').textContent = m.name;
    const f = $('#form-branch');
    f.reset();
    f.name.value = `${m.name}-branch-${Math.random().toString(36).slice(2, 6)}`;
    $('#branch-error').hidden = true;
    f.dataset.src = m.name;
    $('#dlg-branch').showModal();
  },
};

function reportStart(name, r) {
  reportProvision(name, r?._webProvision);
  for (const w of r?._webWarnings || []) toast(`${name}: ${w}`, 'err');
  if (r?._webInit) {
    const i = r._webInit;
    const more = h('a', { href: '#', onclick: (e) => { e.preventDefault(); showText(`init — ${name}`, i.log || '(вывода нет)'); } }, 'Показать вывод');
    toast(h('span', {}, i.ok ? `${name}: команды init из Smolfile выполнены (${i.count}). ` : `${name}: ${i.error}. Init повторится при следующем запуске. `, more), i.ok ? 'ok' : 'err', 20000);
  }
  if (r?._webInstall) toast(`${name}: устанавливаются агенты — прогресс во вкладке «Агенты»`, 'ok');
  if (r?._webPrepared?.length) toast(`${name}: применено перед запуском — ${r._webPrepared.join('; ')}`, 'ok');
  reportDirs(name, r?._webDirs);
}

function reportDirs(name, d) {
  if (!d) return;
  for (const e of d.errors || []) toast(`${name}: директории — ${e}`, 'err');
  for (const w of d.warnings || []) toast(`${name}: ${w}`);
  if (d.users?.length) toast(`${name}: созданы пользователи ${d.users.join(', ')}`, 'ok');
  if (d.aclInstalled) toast(`${name}: установлен пакет acl`, 'ok');
  if (d.uid) toast(`${name}: пользователь агента получил uid владельца папки (${d.uid.replace(/^\S+ /, '')}) — теперь он может в неё писать`, 'ok', 8000);
}

function reportProvision(name, p, explicit) {
  if (!p) return;
  if (!p.ok) toast(`${name}: прокси/сертификаты не применены — ${p.error}`, 'err');
  else if (p.skipped) { if (explicit) toast(`${name}: прокси и сертификаты выключены — нечего применять`); }
  else toast(`${name}: настроено (${p.configured || 'ok'})`, 'ok');
}

function confirmDialog(title, text, withForce = false, forceLabel = 'Принудительно (force)', okLabel = 'Удалить') {
  return new Promise((resolve) => {
    const dlg = $('#dlg-confirm');
    $('#confirm-title').textContent = title;
    $('#confirm-text').textContent = text;
    $('#confirm-force-wrap').hidden = !withForce;
    $('#confirm-force-wrap').lastChild.textContent = ` ${forceLabel}`;
    $('#confirm-ok').textContent = okLabel;
    $('#confirm-force').checked = false;
    dlg.returnValue = '';
    dlg.addEventListener('close', () => resolve({ ok: dlg.returnValue === 'ok', force: $('#confirm-force').checked }), { once: true });
    dlg.showModal();
  });
}

$('#form-branch').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const src = f.dataset.src;
  const body = { name: f.name.value.trim() };
  if (f.branchable.checked) body.branchable = true;
  if (f.freezeSource.checked) body.freezeSource = true;
  try {
    await api('POST', `/api/v1/machines/${enc(src)}/branches`, body);
    $('#dlg-branch').close();
    toast(`Ветка ${body.name} создана`, 'ok');
    await refreshMachines();
    select(body.name);
  } catch (err) {
    $('#branch-error').textContent = err.message;
    $('#branch-error').hidden = false;
  }
});

// ---------- detail ----------
const TABS = [
  ['overview', 'Обзор'],
  ['agents', 'Агенты'],
  ['console', 'Консоль'],
  ['details', 'Детали'],
  ['logs', 'Логи'],
  ['files', 'Файлы'],
];

function renderDetail() {
  cleanupTab();
  if (!TABS.some(([id]) => id === state.tab)) state.tab = 'overview'; // a tab that no longer exists
  const box = $('#detail');
  const m = state.machines.find((x) => x.name === state.selected);
  box.dataset.name = m ? m.name : '';
  if (!m) {
    box.innerHTML = `<div class="empty-state"><div class="big"><svg class="ic"><use href="#i-server"/></svg></div><p>Выберите машину слева или создайте новую.</p></div>`;
    return;
  }
  box.innerHTML = '';
  box.append(
    h('div', { class: 'detail-head' }),
    h('nav', { class: 'tabs' }, TABS.map(([id, label]) =>
      h('button', { class: `tab ${state.tab === id ? 'active' : ''}`, 'data-tab': id, onclick: () => switchTab(id) }, label))),
    h('div', { class: 'tab-body', id: 'tab-body' }),
  );
  updateDetailHead(m);
  renderTab();
}

function switchTab(id) {
  state.tab = id;
  localStorage.setItem('smolvm.tab', id);
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === id));
  renderTab();
}

function updateDetailHead(m) {
  const head = $('#detail .detail-head');
  if (!head || $('#detail').dataset.name !== m.name) return;
  const busy = state.busy.has(m.name);
  const iso = state.isolated?.[m.name];
  const sig = JSON.stringify([m.name, m.state, state.busy.get(m.name), state.preparing?.[m.name], m.branchable, m.parentMachine, state.info?.proxyActive, state.info?.caActive, !!iso]);
  if (head.dataset.sig === sig) return;
  head.dataset.sig = sig;
  const running = m.state === 'running';
  const paused = m.state === 'paused';
  const stopped = !running && !paused;
  const btn = (label, fn, opts = {}) => h('button', { class: `btn ${opts.cls || ''}`, disabled: busy || opts.disabled, title: opts.title, onclick: fn }, label);
  head.replaceChildren(...[
    h('h2', {}, m.name),
    h('span', { html: stateBadge(m) }),
    m.parentMachine ? h('span', { class: 'tag' }, `⑂ от ${m.parentMachine}`) : null,
    iso ? h('span', { class: 'tag bad', title: `с ${new Date(iso.since).toLocaleString()}` }, 'изолирована') : null,
    h('div', { class: 'actions' },
      iso ? btn([ic('shield'), 'Снять изоляцию'], () => actions.unisolate(m), { title: 'Вернуть машине сеть и токены шлюза. Машина останется на паузе — возобновите её, агентов перезапустите' }) : null,
      !iso && (running || paused) ? btn([ic('shield'), 'Изолировать'], () => actions.isolate(m), { cls: 'danger', title: 'Kill switch: мгновенно оборвать все соединения машины, отозвать токены шлюза, отклонить ожидающие подтверждения и поставить машину на паузу' }) : null,
      !iso && stopped ? btn([ic('play'), 'Старт'], () => actions.start(m), { cls: 'primary' }) : null,
      !iso && running ? btn([ic('refresh'), 'Перезапуск'], () => actions.restart(m), { title: 'Остановить и снова запустить через smolvm-web: подключатся новые папки, применятся фильтр «Сеть», прокси и uid агента. Запущенные агенты остановятся' }) : null,
      running ? btn([ic('pause'), 'Пауза'], () => actions.pause(m), { title: 'Сохранить RAM, CPU и диски и остановить' }) : null,
      paused && !iso ? btn([ic('play'), 'Возобновить'], () => actions.resume(m), { cls: 'primary' }) : null,
      running ? btn([ic('branch'), 'Ветка'], () => actions.branch(m), { disabled: !m.branchable, title: m.branchable ? 'Copy-on-write клон работающей машины' : 'Машина должна быть запущена как branchable' }) : null,
      running && (state.info?.proxyActive || state.info?.caActive) ? btn([ic('globe'), 'Применить прокси'], () => actions.provision(m), { title: 'Записать настройки прокси и сертификаты в работающую машину' }) : null,
      running ? btn([ic('stop'), 'Стоп'], () => actions.stop(m)) : null,
      stopped ? h('details', { class: 'menu' },
        h('summary', { class: 'btn ghost icon', title: 'Ещё' }, '⋯'),
        h('div', { class: 'menu-pop' },
          h('button', { class: 'menu-item', disabled: busy, onclick: (e) => { e.target.closest('details').open = false; actions.start(m, true); } },
            h('b', {}, 'Запустить с ветвлением'),
            h('span', { class: 'muted small' }, 'Режим branchable: от работающей машины можно делать «Ветки» — мгновенные копии вместе с процессами и памятью, например чтобы параллельно опробовать несколько решений. Для обычной работы не нужен.')))) : null,
      btn([ic('trash')], () => actions.remove(m), { cls: 'ghost danger icon', title: 'Удалить машину' }),
    ),
  ].filter(Boolean));
}

function current() { return state.machines.find((x) => x.name === state.selected); }

function renderTab() {
  cleanupTab();
  const body = $('#tab-body');
  const m = current();
  if (!body || !m) return;
  body.innerHTML = '';
  ({ overview: tabOverview, agents: tabAgents, console: tabConsole, logs: tabLogs, files: tabFiles, details: tabDetails }[state.tab] || tabOverview)(body, m);
}

function needsRunning(body, m, what) {
  if (m.state === 'running') return false;
  body.append(h('div', { class: 'notice' }, `${what} доступны только для запущенной машины. `,
    m.state !== 'paused' ? h('button', { class: 'btn', onclick: () => actions.start(m) }, '▶ Запустить') : null));
  return true;
}

// --- overview
// A card in the same style as the agents: icon, title, status badge, content.
function block({ icon, title, sub, badge, on, items = [], empty, footer }) {
  return h('section', { class: `block ${on ? 'on' : ''}` },
    h('div', { class: 'agent-head' },
      h('span', { class: 'mark m-icon' }, ic(icon)),
      h('div', {}, h('div', { class: 'a-title' }, title), sub ? h('div', { class: 'a-sub' }, sub) : null),
      h('span', { class: 'spacer' }),
      badge ? h('span', { class: `badge ${on ? 'running' : 'stopped'}` }, badge) : null),
    items.length ? h('div', { class: 'blist' }, items) : empty ? h('div', { class: 'muted small' }, empty) : null,
    footer ? h('div', { class: 'row block-foot' }, footer) : null);
}
const bitem = (main, side) => h('div', { class: 'bitem' }, h('div', { class: 'bmain' }, main), side ? h('div', { class: 'bside' }, side) : null);
const plural = (n, one, few, many) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many}`;

// «Смертельная триада»: private data + untrusted content + a way out. Breaking one link is enough.
async function breakTrifecta(m) {
  try {
    const r = await api('PUT', `/ui/egress/machines/${enc(m.name)}`, { enabled: true });
    for (const n of r.notes || []) toast(`${m.name}: ${n}`);
    toast(`${m.name}: фильтр «Доступ в сеть» включён — наружу только адреса из allow list (списки по умолчанию, серверы вендоров агентов и корпоративные репозитории)`, 'ok', 12000);
  } catch (e) { toast(e.message, 'err'); }
  renderTab();
}

function trifectaBanner(m, tri) {
  return h('div', { class: 'notice bad-notice trifecta' },
    h('div', {}, h('b', {}, '«Смертельная триада»: '),
      'у агента одновременно есть приватные данные, недоверенный контент из интернета и свободный выход наружу. Через prompt injection в скачанной странице или файле агента можно заставить отправить данные куда угодно.'),
    h('div', { class: 'row' }, h('button', { class: 'btn danger', onclick: () => breakTrifecta(m) }, ic('shield'), 'Разорвать: включить фильтр «Доступ в сеть»'),
      h('span', { class: 'muted small' }, 'или уберите приватные данные: отвяжите секреты и папки')));
}

function trifectaBlock(m, tri) {
  const row = (bad, label, text) => bitem(h('span', {}, h('span', { class: bad ? 'badc' : 'okc' }, bad ? '● ' : '○ '), h('b', {}, label), h('div', { class: 'muted small' }, text)));
  return block({
    icon: 'shield', title: 'Риск утечки', sub: '«смертельная триада»: опасны все три звена сразу', on: !tri.lethal,
    badge: tri.lethal ? 'все три звена' : 'разорвана',
    items: [
      row(tri.privateData.length > 0, 'Приватные данные', tri.privateData.length ? tri.privateData.slice(0, 4).join(', ') + (tri.privateData.length > 4 ? ` и ещё ${tri.privateData.length - 4}` : '') : 'нет секретов и папок компьютера'),
      row(tri.untrusted, 'Недоверенный контент', tri.untrusted ? 'машина читает интернет' : 'сеть выключена'),
      row(tri.exfil, 'Выход наружу', tri.exfilWhy),
    ],
    footer: tri.lethal ? [h('button', { class: 'btn danger', onclick: () => breakTrifecta(m) }, 'Разорвать')] : null,
  });
}

// Risk of a leak in one line when the triad is broken; the three links on demand.
function riskLine(tri) {
  const why = !tri.privateData.length ? 'нет секретов и папок этого компьютера'
    : !tri.untrusted ? `есть ${tri.privateData.length > 1 ? 'приватные данные' : tri.privateData[0]}, но сеть выключена`
    : `есть ${tri.privateData.length > 1 ? 'приватные данные' : tri.privateData[0]}, но ${tri.exfilWhy}`;
  const row = (bad, label, text) => h('div', {}, h('span', { class: bad ? 'badc' : 'okc' }, bad ? '● ' : '○ '), h('b', {}, label), h('span', { class: 'muted' }, ` — ${text}`));
  return h('details', { class: 'risk-line' },
    h('summary', {}, h('b', {}, 'Риск утечки низкий. '), why, h('span', { class: 'risk-more' }, 'Подробнее')),
    h('div', { class: 'risk-rows small' },
      row(tri.privateData.length > 0, 'Приватные данные', tri.privateData.length ? tri.privateData.slice(0, 4).join(', ') : 'нет'),
      row(tri.untrusted, 'Недоверенный контент', tri.untrusted ? 'машина читает интернет' : 'сеть выключена'),
      row(tri.exfil, 'Выход наружу', tri.exfilWhy),
      h('div', { class: 'muted' }, 'Утечка возможна, только когда есть все три звена сразу («смертельная триада»).')));
}

// Limits on what the agent may consume.
function limitsBlock(m, data) {
  const L = data.limits;
  const inp = (v, ph) => h('input', { class: 'input', type: 'number', min: 0, value: v || '', placeholder: ph });
  const f = { pids: inp(L.pids, 'без лимита'), agentMinutes: inp(L.agentMinutes, 'без лимита'), apiPerDay: inp(L.apiPerDay, 'без лимита') };
  const runs = Object.entries(data.runs || {});
  const save = async () => {
    try {
      await api('PUT', `/ui/machines/${enc(m.name)}/limits`, { pids: f.pids.value, agentMinutes: f.agentMinutes.value, apiPerDay: f.apiPerDay.value });
      toast(`${m.name}: лимиты сохранены${f.pids.value ? ' (лимит процессов — со следующего запуска агента)' : ''}`, 'ok');
      renderTab();
    } catch (e) { toast(e.message, 'err'); }
  };
  return block({
    icon: 'sliders', title: 'Лимиты', sub: 'сколько может потратить агент', on: !!(L.pids || L.agentMinutes || L.apiPerDay),
    badge: L.pids || L.agentMinutes || L.apiPerDay ? 'заданы' : 'нет',
    items: [
      h('div', { class: 'limits-grid' },
        h('label', { title: 'ulimit -u для пользователя агента: защищает от fork-бомб и бесконечного порождения процессов' }, 'Процессов агента', f.pids),
        h('label', { title: 'Агент останавливается, проработав столько минут' }, 'Время работы агента, мин', f.agentMinutes),
        h('label', { title: 'Запросы машины через шлюз секретов за сутки; сверх — ответ 429' }, 'Запросов к API в день', f.apiPerDay)),
      h('div', { class: 'muted small' }, `API сегодня: ${data.usage.api}${L.apiPerDay ? ` из ${L.apiPerDay}` : ''}`,
        runs.length ? ` · работают: ${runs.map(([a, t]) => `${a} ${Math.round((Date.now() - t) / 60000)} мин`).join(', ')}` : ''),
    ],
    footer: [h('button', { class: 'btn', onclick: save }, 'Сохранить лимиты')],
  });
}

async function tabOverview(body, m) {
  const [infoR, miR, egR, dvR, , imgR, riskR, limR] = await Promise.allSettled([
    api('GET', `/api/v1/machines/${enc(m.name)}`),
    api('GET', `/ui/machines/${enc(m.name)}`),
    api('GET', '/ui/egress'),
    api('GET', `/ui/machines/${enc(m.name)}/dirs`),
    loadVault(),
    m.state === 'running' ? api('GET', `/api/v1/machines/${enc(m.name)}/images`) : Promise.resolve(null),
    api('GET', `/ui/machines/${enc(m.name)}/risk`),
    api('GET', `/ui/machines/${enc(m.name)}/limits`),
  ]);
  if (!$('#tab-body') || current()?.name !== m.name || state.tab !== 'overview') return;
  const info = infoR.value || m;
  const mi = miR.value || { useProxy: true, provisioned: null, secrets: [], agentPorts: [] };
  const eg = egR.value || null;
  const dv = dvR.value || null;

  const kv = [
    ['Состояние', stateLabel(info.state)],
    ['vCPU', info.cpus],
    ['Память', fmtMb(info.memoryMb)],
    ['CPU время', info.cpuMillis != null ? `${(info.cpuMillis / 1000).toFixed(1)} c` : '—'],
    ['Диск (факт.)', info.diskUsedMb != null ? fmtMb(info.diskUsedMb) : '—'],
    ['Storage / Overlay', `${info.storageGb ?? 20} / ${info.overlayGb ?? 10} GiB`],
    ['Сеть', info.network ? `вкл${info.networkBackend ? ` (${info.networkBackend})` : ''}` : 'выкл'],
    ['Исходящий трафик', info.egressBytes != null ? fmtBytes(info.egressBytes) : '—'],
    ['Создана', fmtAgo(info.createdAt)],
  ];
  body.innerHTML = '';
  const iso = state.isolated?.[m.name];
  if (iso) {
    body.append(h('div', { class: 'notice bad-notice' }, h('b', {}, `Машина изолирована (kill switch) ${fmtAgo(iso.since / 1000)}`),
      ` — ${iso.reason || 'вручную'}, ${iso.by || ''}. Соединения через smolvm-web запрещены, токены шлюза заменены, запуск и возобновление заблокированы. Снимок состояния сохранён на паузе — можно разобраться, что произошло, затем «Снять изоляцию».`));
  }
  const tri = riskR.value?.trifecta;
  if (tri?.lethal) body.append(trifectaBanner(m, tri));
  else if (tri) body.append(riskLine(tri));
  body.append(h('div', { class: 'kv' }, kv.map(([k, v]) => h('div', {}, h('div', { class: 'k' }, k), h('div', { class: 'v' }, String(v))))));

  const blocks = [];
  if (tri?.lethal) blocks.push(trifectaBlock(m, tri));
  if (limR.value) blocks.push(limitsBlock(m, limR.value));

  // Ports
  const ports = info.ports || [];
  blocks.push(block({
    icon: 'plug', title: 'Порты', sub: 'с машины на этот компьютер (localhost)', on: ports.length > 0,
    badge: ports.length ? String(ports.length) : 'нет',
    items: ports.map((p) => {
      const ag = (mi.agentPorts || []).find((a) => a.host === p.host && a.guest === p.guest);
      return bitem(
        [h('span', { class: 'mono' }, `${p.host} → ${p.guest}`), h('span', { class: 'muted small' }, ag ? ` агент: ${ag.title}` : ' ваш порт')],
        ag ? h('a', { href: '#', onclick: (e) => { e.preventDefault(); switchTab('agents'); }, title: 'Порт агента защищён паролем' }, 'Агенты →')
          : h('a', { href: `http://localhost:${p.host}`, target: '_blank', rel: 'noopener' }, 'открыть ↗'));
    }),
    empty: 'Нет опубликованных портов. Добавляются при создании машины (поле «Порты») или профилем с агентами.',
  }));

  // Internet (egress filter + smolvm policy)
  if (eg) {
    const em = eg.machines[m.name];
    const lists = (em?.lists || []).map((id) => eg.lists.find((l) => l.id === id)?.name).filter(Boolean);
    const policy = [...(info.allowedHosts || []), ...(info.allowedCidrs || [])];
    blocks.push(block({
      icon: 'globe', title: 'Сеть', sub: 'куда машине можно ходить', on: !!em?.enabled,
      badge: em?.learn ? 'обучение' : em?.enabled ? (em.strict ? 'allow list · жёстко' : 'allow list') : 'без фильтра',
      items: [
        em?.learn ? bitem('Режим обучения', h('span', { class: 'small warnc' }, `всё разрешено и журналируется, собрано хостов: ${em.learnedCount || 0}`)) : null,
        em?.enabled ? bitem('Списки', h('span', { class: 'small' }, lists.join(', ') || '—')) : null,
        em?.enabled ? bitem('Свои правила', h('span', { class: 'small' }, String(em.rules.length))) : null,
        policy.length ? bitem('Политика smolvm', h('span', { class: 'mono small ellipsis', title: policy.join(', ') }, policy.join(', '))) : null,
        !info.network ? bitem('Сеть машины', h('span', { class: 'tag bad' }, 'выключена')) : null,
      ].filter(Boolean),
      empty: 'Машина ходит в интернет без ограничений smolvm-web.',
      footer: [h('a', { href: `#/egress?machine=${enc(m.name)}`, class: 'small' }, 'Что разрешено →'), h('a', { href: `#/egress?tab=log&machine=${enc(m.name)}`, class: 'small' }, 'Журнал →')],
    }));
  }

  // Folders the agent gets (mounted or review copies), with a plain status.
  {
    const n = (dv?.dirs.length || 0);
    const b = block({
      icon: 'users', title: 'Папки агента', sub: 'что агент видит с этого компьютера', on: true,
      badge: null, items: [],
      footer: [h('button', { class: 'btn', onclick: () => openFolderDialog({ machine: m.name, onDone: () => renderTab() }) }, ic('plus'), 'Дать доступ к папке'),
        h('a', { href: `#/dirs?machine=${enc(m.name)}`, class: 'small' }, 'Подробнее →')],
    });
    b.classList.toggle('on', n > 0);
    b.insertBefore(folderList(m, { compact: true }), b.querySelector('.block-foot'));
    blocks.push(b);
  }

  // Secrets
  {
    const avail = vaultCache.filter((x) => x.mode !== 'substitute' && !mi.secrets.some((b) => b.name === x.name));
    const sel = avail.length ? h('select', { class: 'input small' }, avail.map((x) => h('option', { value: x.name }, `${x.name} (${MODE_LABEL[x.mode]})`))) : null;
    blocks.push(block({
      icon: 'key', title: 'Секреты', sub: 'API-ключи без передачи в машину', on: mi.secrets.length > 0,
      badge: mi.secrets.length ? String(mi.secrets.length) : 'нет',
      items: mi.secrets.map((x) => bitem(
        [h('span', { class: 'with-mark' }, mark(secretMark(vaultCache.find((v) => v.name === x.name) || x), true), h('span', { class: 'mono' }, x.name), h('span', { class: `tag ${MODE_TAG[x.mode]}` }, MODE_LABEL[x.mode])),
          h('div', { class: 'muted small mono' }, `$${x.envVar}${x.baseUrlVar ? `, $${x.baseUrlVar}` : ''}`)],
        x.mode !== 'substitute'
          ? h('button', { class: 'btn ghost small-btn', onclick: () => changeSecrets(m, [], [x.name]) }, 'Отвязать')
          : h('span', { class: 'muted small' }, 'при создании'))),
      empty: vaultCache.length ? 'К машине не привязано секретов.' : 'В хранилище пока нет секретов.',
      footer: sel
        ? [sel, h('button', { class: 'btn', onclick: () => changeSecrets(m, [sel.value], []) }, [ic('plus'), 'Привязать'])]
        : h('a', { href: '#', class: 'small', onclick: (e) => { e.preventDefault(); openVault(); } }, 'Хранилище секретов →'),
    }));
  }

  // Images in the machine (the former «Образы» tab).
  {
    const running = m.state === 'running';
    const images = imgR.value?.images || [];
    blocks.push(block({
      icon: 'server', title: 'Образы', sub: 'OCI-образы внутри машины', on: images.length > 0,
      badge: running ? String(images.length) : 'машина остановлена',
      items: images.map((i) => bitem(
        [h('div', { class: 'mono ellipsis', title: `${i.reference}\n${i.digest}` }, i.reference), h('div', { class: 'muted small' }, `${i.os}/${i.architecture} · слоёв: ${i.layerCount}`)],
        h('span', { class: 'small' }, fmtBytes(i.size)))),
      empty: running ? (imgR.status === 'rejected' ? `Не удалось получить список: ${imgR.reason?.message || ''}` : 'Образов нет.') : 'Список образов доступен у запущенной машины.',
    }));
  }

  // Corporate proxy (only when configured)
  if (state.info?.proxyActive || state.info?.caActive) {
    const toggle = h('input', { type: 'checkbox', checked: mi.useProxy });
    toggle.addEventListener('change', async () => {
      try {
        await api('PUT', `/ui/machines/${enc(m.name)}`, { useProxy: toggle.checked });
        toast(toggle.checked ? 'Прокси включён для машины (со следующего запуска/команды)' : 'Прокси для машины выключен', 'ok');
      } catch (e) { toast(e.message, 'err'); toggle.checked = !toggle.checked; }
    });
    blocks.push(block({
      icon: 'sliders', title: 'Корпоративный прокси', sub: 'прокси и сертификаты для машины', on: mi.useProxy,
      badge: mi.useProxy ? 'включён' : 'выключен',
      items: [bitem('Настройки в машине', h('span', { class: 'small' }, mi.provisioned ? 'записаны' : 'ещё не записаны'))],
      footer: h('label', { class: 'check small' }, toggle, 'Использовать прокси и сертификаты'),
    }));
  }

  body.append(h('div', { class: 'blocks' }, blocks));
}

// --- details: smolvm's full record of the machine, for diagnostics
async function tabDetails(body, m) {
  let info;
  try { info = await api('GET', `/api/v1/machines/${enc(m.name)}`); } catch (e) { info = m; }
  if (!$('#tab-body') || current()?.name !== m.name || state.tab !== 'details') return;
  body.replaceChildren(
    h('p', { class: 'muted small' }, 'Полный ответ smolvm об этой машине (GET /api/v1/machines/…): PID, образ, статистика памяти (RSS/PSS), сетевой режим, GPU/CUDA, политики. Нужен для диагностики.'),
    h('pre', { class: 'json details-json' }, JSON.stringify(info, null, 2)));
}

// --- review copies: the agent works on a copy, you apply its changes
async function tabReview(body, m, rerender = renderTab) {
  let alive = true;
  tabCleanup = () => { alive = false; };
  const head = h('div');
  const list = h('div', { class: 'review-list' });
  body.append(head, list);
  let data;
  try { data = await api('GET', `/ui/machines/${enc(m.name)}/review`); } catch (e) { body.replaceChildren(h('div', { class: 'error' }, e.message)); return; }
  if (!alive) return;

  // Add form
  const hostIn = h('input', { class: 'input mono', placeholder: state.info?.platform === 'win32' ? 'C:\\Users\\me\\project' : '/Users/me/project' });
  const guestIn = h('input', { class: 'input mono', placeholder: '/work/project' });
  const exIn = h('input', { class: 'input mono', value: data.defaultExclude.join(', ') });
  hostIn.addEventListener('input', () => { if (!guestIn.dataset.touched) guestIn.value = hostIn.value ? `/work/${hostIn.value.split(/[\\/]/).filter(Boolean).pop() || 'project'}` : ''; });
  guestIn.addEventListener('input', () => { guestIn.dataset.touched = '1'; });
  const addBtn = h('button', { class: 'btn primary' }, ic('plus'), 'Создать рабочую копию');
  addBtn.addEventListener('click', async () => {
    addBtn.disabled = true; addBtn.textContent = 'Копирование…';
    try {
      await api('POST', `/ui/machines/${enc(m.name)}/review`, { hostPath: hostIn.value.trim(), guestPath: guestIn.value.trim() || undefined, exclude: csv(exIn.value) });
      toast(m.state === 'running' ? 'Рабочая копия создана' : 'Копия создастся при запуске машины', 'ok');
      rerender();
    } catch (e) { toast(e.message, 'err'); addBtn.disabled = false; addBtn.replaceChildren(ic('plus'), 'Создать рабочую копию'); }
  });
  head.append(h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', {}, 'Рабочие копии'),
      helpButton('Как работает ревью изменений',
        h('p', {}, 'Агент получает не саму папку хоста, а её копию внутри машины. Всё, что он меняет, остаётся в машине, пока вы не нажмёте «Применить» — целиком или по файлам. «Отклонить» возвращает в машине версию файла с хоста.'),
        h('ul', {},
          h('li', {}, 'Конфликт — файл изменился и в машине, и на хосте с момента копирования. Применение перезапишет версию на хосте; посмотрите diff.'),
          h('li', {}, '«Подтянуть с хоста» обновляет в машине файлы, которые агент не трогал, а на хосте они поменялись.'),
          h('li', {}, 'Исключения (node_modules, .git и т.п.) не копируются и не попадают в ревью — их агент может пересоздать сам.'),
          h('li', {}, 'Копия не монтируется, а копируется: на хост не попадает ничего без вашего «Применить».'),
          h('li', {}, 'Символические ссылки не применяются на хост автоматически.')))),
    h('p', { class: 'muted small' }, 'Агент работает с копией папки, а на хост попадает только то, что вы одобрите после просмотра diff. Безопаснее, чем подключать папку на запись.'),
    h('div', { class: 'grid2' }, h('label', {}, 'Папка на этом компьютере', hostIn), h('label', {}, 'Путь в машине', guestIn)),
    h('label', {}, 'Исключить (имена папок/файлов через запятую)', exIn),
    h('div', { class: 'row' }, addBtn)));

  for (const d of data.dirs) list.append(await reviewDir(m, d, rerender));
}

async function reviewDir(m, d, rerender = renderTab) {
  const box = h('section', { class: 'card review' });
  const KIND = { added: ['ok', 'A', 'добавлен'], modified: ['warn', 'M', 'изменён'], deleted: ['bad', 'D', 'удалён'] };
  const draw = async () => {
    let r;
    try { r = await api('GET', `/ui/machines/${enc(m.name)}/review/${enc(d.id)}`); } catch (e) { box.replaceChildren(h('div', { class: 'error' }, e.message)); return; }
    const sel = new Set();
    const diffBox = h('div', { class: 'diff-box' });
    const act = async (op, paths, confirmText) => {
      const okLabel = { apply: 'Применить', reject: 'Отклонить', copy: 'Пересоздать', pull: 'Подтянуть' }[op];
      if (confirmText && !(await confirmDialog('Подтверждение', confirmText, false, '', okLabel)).ok) return;
      try {
        const x = await api('POST', `/ui/machines/${enc(m.name)}/review/${enc(d.id)}/${op}`, { paths });
        const n = (x.applied || x.reverted || []).length;
        if (op === 'apply') toast(`Применено на хост: ${n}${x.skipped?.length ? `, пропущено: ${x.skipped.length} (${x.skipped.map((s) => `${s.path}: ${s.why}`).join('; ')})` : ''}`, x.skipped?.length ? 'err' : 'ok', 10000);
        else if (op === 'reject') toast(`Отклонено, в машине возвращена версия с хоста: ${n}`, 'ok');
        else if (op === 'pull') toast(`Подтянуто с хоста: ${n}`, 'ok');
        else toast('Копия пересоздана', 'ok');
      } catch (e) { toast(e.message, 'err'); }
      draw();
    };
    const showDiff = async (c) => {
      diffBox.replaceChildren(h('p', { class: 'muted small' }, 'Загрузка diff…'));
      let df;
      try { df = await api('GET', `/ui/machines/${enc(m.name)}/review/${enc(d.id)}/diff?path=${enc(c.path)}`); } catch (e) { diffBox.replaceChildren(h('div', { class: 'error' }, e.message)); return; }
      const headRow = h('div', { class: 'row' }, h('b', { class: 'mono' }, c.path), h('span', { class: 'muted small' }, `хост ${fmtBytes(df.hostSize)} → машина ${fmtBytes(df.guestSize)}`),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn', onclick: () => act('reject', [c.path]) }, ic('x'), 'Отклонить'),
        h('button', { class: 'btn primary', onclick: () => act('apply', [c.path], c.conflict ? `Файл ${c.path} изменился и на хосте. Перезаписать версией из машины?` : null) }, ic('download'), 'Применить'));
      if (df.binary || df.tooBig) { diffBox.replaceChildren(headRow, h('p', { class: 'muted' }, df.binary ? 'Бинарный файл — построчный diff не показывается.' : 'Файл слишком большой для diff.')); return; }
      const pre = h('pre', { class: 'diff' });
      for (const hk of df.hunks) {
        pre.append(h('span', { class: 'd-h' }, `${hk.header}\n`));
        for (const l of hk.lines) pre.append(h('span', { class: l[0] === '+' ? 'd-a' : l[0] === '-' ? 'd-r' : 'd-c' }, `${l}\n`));
      }
      if (!df.hunks.length) pre.append(h('span', { class: 'd-c' }, 'Содержимое совпадает (изменились только права или ссылка).\n'));
      diffBox.replaceChildren(headRow, pre);
    };
    const rows = r.changes.map((c) => {
      const [cls, letter, word] = KIND[c.kind];
      const cb = h('input', { type: 'checkbox' });
      cb.addEventListener('change', () => { if (cb.checked) sel.add(c.path); else sel.delete(c.path); });
      return h('tr', { class: 'clickable', onclick: (e) => { if (e.target !== cb) showDiff(c); } },
        h('td', { class: 'center' }, cb),
        h('td', {}, h('span', { class: `tag ${cls}`, title: word }, letter)),
        h('td', { class: 'mono small' }, c.path),
        h('td', {}, c.conflict ? h('span', { class: 'tag bad', title: 'Файл изменился и на хосте с момента копирования' }, 'конфликт') : null, c.link ? h('span', { class: 'tag' }, 'ссылка') : null));
    });
    const st = d.state === 'ready' ? (r.missing ? h('span', { class: 'tag bad' }, 'копии нет в машине') : h('span', { class: `badge ${r.changes.length ? 'running' : 'stopped'}` }, r.changes.length ? `${r.changes.length} изм.` : 'без изменений'))
      : d.state === 'pending' ? h('span', { class: 'tag warn' }, 'скопируется при запуске') : h('span', { class: 'tag bad', title: d.error || '' }, 'ошибка копирования');
    box.replaceChildren(...[
      h('div', { class: 'agent-head' }, h('span', { class: 'mark m-icon' }, ic('folder')),
        h('div', {}, h('div', { class: 'a-title mono' }, `${d.guestPath}`), h('div', { class: 'a-sub mono ellipsis', title: d.hostPath }, `с ${d.hostPath}`)),
        h('span', { class: 'spacer' }), st),
      d.error && d.state === 'error' ? h('div', { class: 'error' }, d.error) : null,
      r.changes.length ? h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('tr', {}, h('th', {}, ''), h('th', {}, ''), h('th', {}, 'Файл'), h('th', {}, '')), rows)) : null,
      r.changes.length ? h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: () => act('apply', sel.size ? [...sel] : [], `${sel.size ? `Применить выбранные (${sel.size})` : `Применить все изменения (${r.changes.length})`} на хост в ${d.hostPath}?${r.changes.some((c) => c.conflict) ? ' Есть конфликты — версии на хосте будут перезаписаны.' : ''}`) }, ic('download'), 'Применить', h('span', { class: 'muted small' }, ' (выбранные или все)')),
        h('button', { class: 'btn', onclick: () => act('reject', sel.size ? [...sel] : [], `${sel.size ? `Отклонить выбранные (${sel.size})` : 'Отклонить все изменения'}? В машине вернутся версии с хоста.`) }, ic('x'), 'Отклонить')) : null,
      diffBox,
      h('div', { class: 'row block-foot' },
        r.hostAhead ? h('button', { class: 'btn', onclick: () => act('pull', []) }, ic('refresh'), `Подтянуть с хоста (${r.hostAhead})`) : null,
        h('button', { class: 'btn ghost', onclick: () => draw() }, ic('refresh'), 'Обновить'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn ghost', onclick: () => act('copy', [], 'Пересоздать копию с хоста? Все непримененные изменения в машине будут потеряны.') }, 'Пересоздать копию'),
        h('button', { class: 'btn ghost danger', onclick: async () => {
          const c = await confirmDialog('Убрать рабочую копию?', `Копия ${d.guestPath} перестанет отслеживаться. Непримененные изменения останутся в машине, если не удалить копию.`, true, 'Удалить копию и из машины', 'Убрать');
          if (!c.ok) return;
          try { await api('DELETE', `/ui/machines/${enc(m.name)}/review/${enc(d.id)}${c.force ? '?deleteCopy=1' : ''}`); rerender(); } catch (e) { toast(e.message, 'err'); }
        } }, ic('trash'))),
    ].filter(Boolean));
  };
  box.append(h('p', { class: 'muted' }, 'Загрузка…'));
  draw();
  return box;
}

// --- console (exec over SSE)
const consoleHistory = JSON.parse(localStorage.getItem('smolvm.history') || '[]');
const consoleBuffers = new Map(); // machine -> DocumentFragment-ish HTML

function tabConsole(body, m) {
  if (needsRunning(body, m, 'Команды')) return;
  const term = h('div', { class: 'term', tabindex: '0' });
  term.innerHTML = consoleBuffers.get(m.name) || `<span class="sys">Каждая команда выполняется через <b>sh -c</b> в машине ${esc(m.name)}. Текущая директория сохраняется между командами. Ctrl+C — прервать, Ctrl+L — очистить.</span>\n`;
  let cwd = term.dataset.cwd || consoleBuffers.get(`${m.name}:cwd`) || '';
  const prompt = h('span', { class: 'prompt' });
  const input = h('input', { class: 'input mono', placeholder: 'ls -la /', autocomplete: 'off', spellcheck: 'false' });
  const userInput = h('input', { class: 'input small mono', placeholder: 'user', title: 'Выполнить от пользователя (опционально)' });
  const runBtn = h('button', { class: 'btn primary' }, 'Выполнить');
  const stopBtn = h('button', { class: 'btn', hidden: true }, 'Прервать');
  body.append(term, h('div', { class: 'term-input' }, prompt, input, userInput, runBtn, stopBtn));
  const setPrompt = () => { prompt.textContent = `${m.name}:${cwd || '~'}$`; };
  setPrompt();
  term.scrollTop = term.scrollHeight;
  input.focus();

  let ctrl = null; let histIdx = consoleHistory.length;
  const save = () => { consoleBuffers.set(m.name, term.innerHTML.slice(-200000)); consoleBuffers.set(`${m.name}:cwd`, cwd); };
  const write = (text, cls) => {
    const atBottom = term.scrollHeight - term.scrollTop - term.clientHeight < 40;
    term.append(cls ? h('span', { class: cls }, text) : document.createTextNode(text));
    if (atBottom) term.scrollTop = term.scrollHeight;
  };

  async function run() {
    const cmd = input.value.trim();
    if (!cmd || ctrl) return;
    if (cmd === 'clear') { term.innerHTML = ''; input.value = ''; save(); return; }
    if (consoleHistory[consoleHistory.length - 1] !== cmd) consoleHistory.push(cmd);
    if (consoleHistory.length > 200) consoleHistory.shift();
    localStorage.setItem('smolvm.history', JSON.stringify(consoleHistory));
    histIdx = consoleHistory.length;
    input.value = '';
    write(`${prompt.textContent} ${cmd}\n`, 'cmd');

    // Track the cwd: run the command in the saved dir, then print the new one on a marker line.
    const marker = `__SMOLVM_CWD_${Math.random().toString(36).slice(2)}__`;
    const script = `${cwd ? `cd '${cwd.replace(/'/g, "'\\''")}' 2>/dev/null; ` : ''}${cmd}\n__rc=$?; printf '${marker}%s\\n' "$(pwd)"; exit $__rc`;
    const req = { command: ['sh', '-c', script] };
    if (userInput.value.trim()) req.user = userInput.value.trim();

    ctrl = new AbortController();
    runBtn.hidden = true; stopBtn.hidden = false;
    // stdout arrives one line per event; a line containing the marker carries the new cwd.
    const onStdout = (data) => {
      for (const line of data.replace(/\n$/, '').split('\n')) {
        const mi = line.indexOf(marker);
        if (mi === -1) { write(`${line}\n`); continue; }
        if (mi > 0) write(`${line.slice(0, mi)}\n`);
        cwd = line.slice(mi + marker.length).trim() || cwd;
        setPrompt();
      }
    };
    try {
      const res = await api('POST', `/api/v1/machines/${enc(m.name)}/exec/stream`, req, { raw: true, signal: ctrl.signal });
      let exited = false;
      await readSSE(res, (ev, data) => {
        if (ev === 'stdout') onStdout(data);
        else if (ev === 'stderr') { write(data.endsWith('\n') ? data : `${data}\n`, 'err'); }
        else if (ev === 'exit') {
          exited = true;
          let code = '?'; try { code = JSON.parse(data).exitCode; } catch {}
          if (code !== 0) write(`[exit ${code}]\n`, 'err');
        } else if (ev === 'error') {
          let msg = data; try { msg = JSON.parse(data).message; } catch {}
          write(`error: ${msg}\n`, 'err');
        }
      });
      if (!exited) write('[поток завершился без кода выхода]\n', 'sys');
    } catch (e) {
      if (e.name === 'AbortError') write('^C (поток прерван; процесс в машине может продолжать работу)\n', 'sys');
      else write(`ошибка: ${e.message}\n`, 'err');
    } finally {
      ctrl = null; runBtn.hidden = false; stopBtn.hidden = true;
      save(); input.focus();
    }
  }

  runBtn.addEventListener('click', run);
  stopBtn.addEventListener('click', () => ctrl?.abort());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); run(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (histIdx > 0) input.value = consoleHistory[--histIdx]; }
    else if (e.key === 'ArrowDown') { e.preventDefault(); histIdx = Math.min(consoleHistory.length, histIdx + 1); input.value = consoleHistory[histIdx] || ''; }
    else if (e.key === 'c' && e.ctrlKey && ctrl) { e.preventDefault(); ctrl.abort(); }
    else if (e.key === 'l' && e.ctrlKey) { e.preventDefault(); term.innerHTML = ''; save(); }
  });
  term.addEventListener('click', () => { if (!getSelection().toString()) input.focus(); });
  tabCleanup = () => { save(); ctrl?.abort(); };
}

// --- logs
function tabLogs(body, m) {
  const term = h('div', { class: 'term' });
  const follow = h('input', { type: 'checkbox', checked: true });
  const tail = h('input', { class: 'input small', type: 'number', min: '0', value: '500', title: 'Последние N строк' });
  const reload = h('button', { class: 'btn' }, '↻ Перезагрузить');
  const clear = h('button', { class: 'btn ghost' }, 'Очистить');
  body.append(h('div', { class: 'row' }, h('label', { class: 'check' }, follow, ' Следить (follow)'), h('label', { class: 'check' }, 'tail ', tail), reload, clear), term);

  let ctrl = null;
  async function load() {
    ctrl?.abort();
    ctrl = new AbortController();
    term.innerHTML = '';
    const q = new URLSearchParams();
    if (follow.checked) q.set('follow', 'true');
    if (tail.value) q.set('tail', tail.value);
    let lines = 0;
    try {
      const res = await api('GET', `/api/v1/machines/${enc(m.name)}/logs?${q}`, undefined, { raw: true, signal: ctrl.signal });
      await readSSE(res, (_ev, data) => {
        const atBottom = term.scrollHeight - term.scrollTop - term.clientHeight < 40;
        term.append(formatLogLine(data));
        if (++lines > 5000) term.firstChild?.remove();
        if (atBottom) term.scrollTop = term.scrollHeight;
      });
      if (!lines) term.append(h('span', { class: 'sys' }, 'Логов нет.\n'));
      else if (!follow.checked) term.append(h('span', { class: 'sys' }, '— конец —\n'));
    } catch (e) {
      if (e.name !== 'AbortError') term.append(h('span', { class: 'err' }, `ошибка: ${e.message}\n`));
    }
  }
  reload.addEventListener('click', load);
  follow.addEventListener('change', load);
  clear.addEventListener('click', () => { term.innerHTML = ''; });
  load();
  tabCleanup = () => ctrl?.abort();
}

// Agent logs are JSON (tracing); render them as "time LEVEL message key=value".
function formatLogLine(line) {
  let j;
  try { j = JSON.parse(line); } catch { return document.createTextNode(`${line}\n`); }
  if (!j || typeof j !== 'object' || !j.fields) return document.createTextNode(`${line}\n`);
  const { message = '', ...rest } = j.fields;
  const time = j.timestamp ? new Date(j.timestamp).toLocaleTimeString() : '';
  const extra = Object.entries(rest).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ');
  const lvl = (j.level || '').padEnd(5);
  const cls = /ERROR/.test(j.level) ? 'err' : /WARN/.test(j.level) ? 'warn' : 'lvl';
  return h('span', {}, h('span', { class: 'sys' }, `${time} `), h('span', { class: cls }, lvl), ` ${message}`, extra ? h('span', { class: 'sys' }, ` ${extra}`) : null, '\n');
}

// --- files
const filesCwd = new Map();
function tabFiles(body, m) {
  if (needsRunning(body, m, 'Файлы')) return;
  let dir = filesCwd.get(m.name) || '/';
  const pathInput = h('input', { class: 'input mono', value: dir });
  const up = h('button', { class: 'btn', title: 'Вверх' }, '↑');
  const go = h('button', { class: 'btn' }, 'Открыть');
  const fileInput = h('input', { type: 'file', multiple: true, hidden: true });
  const upload = h('button', { class: 'btn primary' }, '⇪ Загрузить');
  const list = h('div');
  const drop = h('div', { class: 'dropzone' }, 'Перетащите файлы сюда, чтобы загрузить их в текущую директорию');
  body.append(h('div', { class: 'files-bar' }, up, pathInput, go, upload, fileInput), list, drop);

  const join = (a, b) => (a.endsWith('/') ? a : `${a}/`) + b;
  const fileUrl = (p) => `/api/v1/machines/${enc(m.name)}/files/${enc(p)}`;

  async function open(p) {
    dir = p || '/';
    if (dir.length > 1) dir = dir.replace(/\/+$/, '');
    pathInput.value = dir;
    filesCwd.set(m.name, dir);
    list.innerHTML = '<p class="muted">Загрузка…</p>';
    try {
      const res = await fetch(fileUrl(dir));
      if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => ({})));
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) {
        // It's a file — download it, then show its parent.
        const blob = await res.blob();
        saveBlob(blob, dir.split('/').pop());
        return open(dir.replace(/\/[^/]*$/, '') || '/');
      }
      const { entries = [] } = await res.json();
      entries.sort((a, b) => (a.kind === 'dir' || a.kind === 'directory' ? 0 : 1) - (b.kind === 'dir' || b.kind === 'directory' ? 0 : 1) || a.name.localeCompare(b.name));
      list.innerHTML = '';
      if (!entries.length) { list.append(h('p', { class: 'muted' }, 'Пустая директория')); return; }
      list.append(h('table', { class: 'tbl' },
        h('tr', {}, h('th', {}, 'Имя'), h('th', {}, 'Тип'), h('th', {}, 'Размер'), h('th', {}, '')),
        entries.map((e) => {
          const isDir = /^dir/.test(e.kind);
          const full = join(dir, e.name);
          return h('tr', { class: 'clickable', ondblclick: () => (isDir ? open(full) : download(full)), onclick: (ev) => { if (isDir && !ev.target.closest('button')) open(full); } },
            h('td', { class: 'mono' }, h('span', { class: 'fname' }, ic(isDir ? 'folder' : e.kind === 'symlink' ? 'link' : 'file'), e.name)),
            h('td', { class: 'muted' }, e.kind),
            h('td', { class: 'mono' }, isDir ? '' : fmtBytes(e.size)),
            h('td', {}, !isDir ? h('button', { class: 'btn ghost', onclick: () => download(full) }, '⇩ Скачать') : null));
        })));
    } catch (e) {
      list.innerHTML = '';
      list.append(h('div', { class: 'error' }, e.message));
    }
  }

  async function download(p) {
    try {
      const res = await fetch(fileUrl(p));
      if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => ({})));
      saveBlob(await res.blob(), p.split('/').pop());
    } catch (e) { toast(e.message, 'err'); }
  }

  async function uploadFiles(files) {
    for (const f of files) {
      const target = join(dir, f.name);
      try {
        const r = await api('PUT', fileUrl(target), f);
        toast(`Загружено: ${r.path} (${fmtBytes(r.size)})`, 'ok');
      } catch (e) { toast(`${f.name}: ${e.message}`, 'err'); }
    }
    open(dir);
  }

  up.addEventListener('click', () => open(dir.replace(/\/[^/]*$/, '') || '/'));
  go.addEventListener('click', () => open(pathInput.value.trim()));
  pathInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(pathInput.value.trim()); });
  upload.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { uploadFiles([...fileInput.files]); fileInput.value = ''; });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); uploadFiles([...e.dataTransfer.files]); });
  open(dir);
}

function saveBlob(blob, name) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name || 'file' });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// --- images

// --- egress
async function tabEgress(body, m) {
  body.append(h('p', { class: 'muted small' }, 'Соединения, которые заблокировала сама smolvm (список разрешённых хостов машины или строгий режим smolvm serve: закрыта локальная сеть и хост). Только просмотр. Все запросы через фильтр smolvm-web — в ',
    h('a', { href: `#/egress?tab=log&machine=${enc(m.name)}` }, 'Журнале'), '.'));
  const list = h('div', {}, h('p', { class: 'muted' }, 'Загрузка…'));
  body.append(list);
  try {
    const { events = [] } = await api('GET', `/api/v1/machines/${enc(m.name)}/egress-events?limit=500`);
    list.innerHTML = '';
    if (!events.length) { list.append(h('p', { class: 'muted' }, 'Блокировок нет.')); return; }
    list.append(h('table', { class: 'tbl' },
      h('tr', {}, h('th', {}, 'Время'), h('th', {}, 'Операция'), h('th', {}, 'Назначение')),
      events.slice().reverse().map((e) => h('tr', {}, h('td', { class: 'mono small' }, e.timestamp ? new Date(e.timestamp).toLocaleString() : '—'), h('td', {}, e.operation), h('td', { class: 'mono' }, e.dest)))));
  } catch (e) { list.innerHTML = ''; list.append(h('div', { class: 'error' }, e.message)); }
}

// ---------- create ----------
// Same rule as the server (lib/repos.js): Docker Hub images through the corporate registry.
function effectiveImage(image) {
  const prefix = state.info?.imagePrefix;
  let ref = String(image || '').trim();
  if (!prefix || !ref) return ref;
  const first = ref.includes('/') ? ref.split('/')[0] : '';
  if (first && (first.includes('.') || first.includes(':') || first === 'localhost')) {
    if (!/^(docker\.io|index\.docker\.io|registry-1\.docker\.io)$/i.test(first)) return ref;
    ref = ref.slice(first.length + 1);
  }
  if (!ref.includes('/')) ref = `library/${ref}`;
  return `${prefix}/${ref}`;
}

function syncImageHint() {
  const f = $('#form-create');
  const el = $('#create-image-hint');
  const img = f.image.value.trim();
  const eff = effectiveImage(img);
  // Quiet unless corporate repositories are in use.
  el.hidden = !img || !(state.info?.imagePrefix || state.info?.reposActive);
  if (eff !== img) el.textContent = `Образ будет скачан из корпоративного реестра: ${eff}`;
  else if (state.info?.imagePrefix) el.textContent = 'Образ не из Docker Hub — скачивается как указан.';
  else el.textContent = 'Реестр образов не задан (или выключено «Брать образы Docker Hub из этого реестра»): образ скачивается с Docker Hub напрямую. «Настройки» → «Репозитории».';
}

function openCreate() {
  const f = $('#form-create');
  $('#create-error').hidden = true;
  if (!f.name.value) f.name.placeholder = `vm-${Math.random().toString(36).slice(2, 7)}`;
  $('#create-proxy-wrap').hidden = !state.info?.proxyActive;
  fillCreateProfiles();
  fillCreateSecrets();
  fillCreateIsolation();
  syncImageHint();
  refreshInfo().then(syncImageHint);
  $('#dlg-create').showModal();
  f.name.focus();
}
$('#form-create').image.addEventListener('input', syncImageHint);
window.openCreate = openCreate;
$('#btn-create').addEventListener('click', openCreate);
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

const lines = (s) => s.split('\n').map((x) => x.trim()).filter(Boolean);
const csv = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);

// host:guest[:ro|rw]; the host side may be a Windows path with a drive letter (C:\work:/work).
function parseMount(l) {
  let rest = l;
  let ro = false;
  const mode = rest.match(/:(ro|rw)$/);
  if (mode) { ro = mode[1] === 'ro'; rest = rest.slice(0, -3); }
  const drive = rest.match(/^([A-Za-z]:[\\/])/);
  const from = drive ? drive[1].length : 0;
  const i = rest.indexOf(':', from);
  if (i < 1) throw new Error(`Неверное монтирование: ${l}`);
  const source = rest.slice(0, i);
  const target = rest.slice(i + 1);
  if (!target.startsWith('/')) throw new Error(`Путь в машине должен быть абсолютным: ${l}`);
  return { source, target, readonly: ro };
}

function buildCreateBody(f) {
  const body = {};
  body.name = f.name.value.trim() || f.name.placeholder;
  const image = f.image.value.trim();
  if (image) body.image = image;
  for (const k of ['cpus', 'memoryMb', 'storageGb', 'overlayGb']) if (f[k].value) body[k] = Number(f[k].value);
  body.network = f.network.checked;
  const cmd = f.cmd.value.trim();
  if (cmd) body.cmd = shellSplit(cmd);
  else if (image && /^(python|node|golang|ruby|php|openjdk|eclipse-temurin|rust|perl)\b/.test(image.split('/').pop())) {
    // Interpreter images exit immediately on EOF; keep the machine alive.
    body.cmd = ['sh', '-c', 'while true; do sleep 3600; done'];
  }
  if (f.ports.value.trim()) {
    body.ports = csv(f.ports.value).map((p) => {
      const [host, guest] = p.split(':').map(Number);
      if (!host || !(guest || host)) throw new Error(`Неверный порт: ${p}`);
      return { host, guest: guest || host };
    });
  }
  if (f.env.value.trim()) {
    body.env = lines(f.env.value).map((l) => {
      const i = l.indexOf('=');
      if (i < 1) throw new Error(`Неверная переменная: ${l}`);
      return { name: l.slice(0, i), value: l.slice(i + 1) };
    });
  }
  if (f.mounts.value.trim()) {
    body.mounts = lines(f.mounts.value).map(parseMount);
  }
  if (f.allowedHosts.value.trim()) body.allowedHosts = csv(f.allowedHosts.value);
  if (f.workdir.value.trim()) body.workdir = f.workdir.value.trim();
  if (f.restart.value) body.restart = { policy: f.restart.value };
  if (createProfile) body._webProfile = createProfile;
  const picked = [...document.querySelectorAll('#create-secrets input:checked')].map((i) => i.value);
  if (picked.length) body._webSecrets = picked;
  if (f.egressOn.checked) {
    body._webEgress = { enabled: true, strict: f.egressStrict.checked, lists: [...document.querySelectorAll('#create-egress-lists input:checked')].map((i) => i.value) };
  }
  if (createFolders.length) body._webFolders = createFolders;
  return body;
}

$('#form-create').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const errBox = $('#create-error');
  errBox.hidden = true;
  if (createProfile === SMOLFILE) return createFromSmolfile(f, errBox);
  let body;
  try { body = buildCreateBody(f); } catch (err) { errBox.textContent = err.message; errBox.hidden = false; return; }
  const startAfter = f.startAfter.checked;
  const branchable = f.branchable.checked;
  const submit = $('#btn-create-submit');
  submit.disabled = true; submit.textContent = 'Создание…';
  try {
    const optOut = state.info?.proxyActive && !f.useProxy.checked;
    const created = await api('POST', `/api/v1/machines${optOut ? '?webProxy=0' : ''}`, body);
    $('#dlg-create').close();
    f.reset();
    toast(`Машина ${created.name} создана${created._webImage ? ` — образ из корпоративного реестра: ${created._webImage.to}` : ''}`, 'ok');
    await refreshMachines();
    select(created.name);
    if (body._webProfile) switchTab('agents');
    if (startAfter) await actions.start(created, branchable);
  } catch (err) {
    errBox.textContent = err.message;
    errBox.hidden = false;
  } finally {
    submit.disabled = false; submit.textContent = 'Создать';
  }
});

// ---------- create from Smolfile ----------
async function createFromSmolfile(f, errBox) {
  const content = f.smolfile.value;
  if (!content.trim()) { errBox.textContent = 'Вставьте Smolfile или загрузите файл'; errBox.hidden = false; return; }
  const name = f.name.value.trim() || f.name.placeholder;
  const startAfter = f.startAfter.checked;
  const submit = $('#btn-create-submit');
  submit.disabled = true; submit.textContent = 'Создание…';
  try {
    // 1. Smolfile -> API request (validated server-side, like smolvm does).
    const p = await api('POST', '/ui/smolfile/parse', { content, baseDir: f.smolfileBase.value.trim() || null });
    // 2. A regular create with smolvm-web's extras on top.
    const body = { ...p.request, name, _webSmolfile: { init: p.init, env: p.env, baseDir: p.baseDir } };
    const picked = [...document.querySelectorAll('#create-secrets input:checked')].map((i) => i.value);
    if (picked.length) body._webSecrets = picked;
    if (f.egressOn.checked) body._webEgress = { enabled: true, strict: f.egressStrict.checked, lists: [...document.querySelectorAll('#create-egress-lists input:checked')].map((i) => i.value) };
    if (createFolders.length) body._webFolders = createFolders;
    const optOut = state.info?.proxyActive && !f.useProxy.checked;
    const created = await api('POST', `/api/v1/machines${optOut ? '?webProxy=0' : ''}`, body);
    $('#dlg-create').close();
    f.reset();
    toast(`Машина ${created.name} создана из Smolfile`, 'ok');
    for (const w of p.warnings || []) toast(`${created.name}: ${w}`, '', 10000);
    await refreshMachines();
    select(created.name);
    if (startAfter) {
      if (p.init.length) toast(`${created.name}: после запуска выполнятся команды init (${p.init.length})`);
      await actions.start(created);
    }
  } catch (err) {
    errBox.textContent = err.message;
    errBox.hidden = false;
  } finally {
    submit.disabled = false; submit.textContent = 'Создать';
  }
}

$('#smolfile-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 256 * 1024) { toast('Файл больше 256 КБ', 'err'); return; }
  const f = $('#form-create');
  f.smolfile.value = await file.text();
  e.target.value = '';
  toast(`Загружен ${file.name}`, 'ok');
});

// Read-only text in the help dialog (init output and the like).
function showText(title, text) {
  $('#help-title').replaceChildren(ic('terminal'), title);
  $('#help-body').replaceChildren(h('pre', { class: 'json', style: 'max-height:60vh' }, text));
  $('#dlg-help').showModal();
}

// ---------- version footer ----------
function renderVersion() {
  const b = state.info?.build;
  if (!b) return;
  const short = (c) => (c ? c.slice(0, 7) : '');
  const v = $('#app-version');
  v.replaceChildren(`smolvm-web ${b.version}`,
    ...(b.commit ? [' · коммит ', h('code', { title: b.commit }, short(b.commit))] : [h('span', { title: 'smolvm-web запущен не из git-клона (архив или копия без папки .git) — номер коммита неизвестен' }, ' · коммит неизвестен (копия без .git)')]),
    ...(b.branch ? [` (${b.branch})`] : []));
  const r = $('#app-restart');
  // The code on disk changed (git pull) but the server still runs the old one.
  r.hidden = !(b.commit && b.disk?.commit && b.disk.commit !== b.commit);
  if (!r.hidden) r.textContent = `на диске уже ${short(b.disk.commit)} — перезапустите smolvm-web, чтобы применить обновление`;
}

// ---------- platform & proxy settings ----------
async function refreshInfo() {
  try { state.info = await api('GET', '/ui/info'); } catch { return; }
  renderHostWarning();
  renderVersion();
  const chip = $('#proxy-chip');
  const i = state.info;
  chip.hidden = false;
  if (i.proxyActive && i.proxySystem) {
    chip.className = `chip ${i.relay?.listening === false ? 'warn' : 'on'}`;
    chip.textContent = `прокси: системный Windows${i.caActive ? ' + CA' : ''}`;
    chip.title = i.relay?.listening === false ? `Ретранслятор не запущен: ${i.relay.error}` : 'PAC / Internet Settings, вход под учётной записью Windows; машины — через ретранслятор smolvm-web';
  } else if (i.proxyActive) {
    const g = i.guestProxy;
    chip.className = `chip ${g?.error ? 'warn' : 'on'}`;
    chip.textContent = `прокси: ${(g?.url || '').replace(/\/\/[^@/]*@/, '//***@').replace(/^https?:\/\//, '')}${i.caActive ? ' + CA' : ''}`;
    chip.title = g?.warning || g?.error || 'Корпоративный прокси включён';
  } else if (i.caActive) {
    chip.className = 'chip on'; chip.textContent = 'корп. сертификаты'; chip.title = '';
  } else {
    chip.hidden = true; // direct connection: nothing to show
  }
  const mounts = $('#mounts-input');
  if (mounts) mounts.placeholder = i.platform === 'win32' ? 'C:\\Users\\me\\data:/data:ro' : '/Users/me/data:/data:ro';
}

// One settings window with a sidebar: proxy, certificates, repositories, secrets, smolvm.
const SETTINGS_PANES = ['smolvm', 'policy', 'proxy', 'ca', 'repos', 'secrets', 'audit'];
function showSettingsPane(pane) {
  if (!SETTINGS_PANES.includes(pane)) pane = 'smolvm';
  document.querySelectorAll('#dlg-settings .settings-pane').forEach((el) => { el.hidden = el.dataset.pane !== pane; });
  document.querySelectorAll('#settings-nav button').forEach((b) => b.classList.toggle('active', b.dataset.pane === pane));
  // Secrets are saved one by one in their own form; the footer saves the rest.
  const footer = $('#settings-footer');
  // Secrets and audit/SIEM are saved by their own buttons.
  const own = pane === 'secrets' || pane === 'audit' || pane === 'policy';
  footer.querySelector('[type=submit]').hidden = own;
  footer.querySelector('.footer-note').hidden = own;
  try { localStorage.setItem('smolvm.settingsPane', pane); } catch {}
  if (pane === 'secrets') { $('#form-secret').hidden = true; renderVault(); }
  if (pane === 'smolvm') renderVirtInfo();
  if (pane === 'policy') renderPolicy();
  if (pane === 'audit' && window.auditSettingsCards) window.auditSettingsCards().then((cards) => fill($('#audit-settings'), ...cards));
  $('.settings-main').scrollTop = 0;
}
$('#settings-nav').addEventListener('click', (e) => { const b = e.target.closest('button[data-pane]'); if (b) showSettingsPane(b.dataset.pane); });

// «Песочницы»: what every new sandbox gets — lifetime, idle close, «ask» for unknown addresses, limits.
async function renderPolicy() {
  const box = $('#policy-settings');
  let p;
  try { p = await api('GET', '/ui/sandbox/policy'); } catch (e) { fill(box, h('div', { class: 'error' }, e.message)); return; }
  const num = (v, ph) => h('input', { class: 'input', type: 'number', min: 0, value: v || '', placeholder: ph });
  const f = {
    ttl: num(p.ttlHours, 'без срока'), idle: num(p.idleMinutes, 'не закрывать'),
    ask: h('input', { type: 'checkbox', checked: p.askUnknown }),
    pids: num(p.limits.pids, 'без лимита'), agentMinutes: num(p.limits.agentMinutes, 'без лимита'), apiPerDay: num(p.limits.apiPerDay, 'без лимита'),
  };
  const row = (title, note, ctl) => h('div', { class: 'pol-row' }, h('div', { class: 'pol-text' }, h('b', {}, title), h('div', { class: 'muted small' }, note)), ctl);
  const save = async () => {
    try {
      await api('PUT', '/ui/sandbox/policy', { ttlHours: f.ttl.value, idleMinutes: f.idle.value, askUnknown: f.ask.checked, limits: { pids: f.pids.value, agentMinutes: f.agentMinutes.value, apiPerDay: f.apiPerDay.value } });
      toast('Политика сохранена — действует для новых песочниц', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };
  fill(box,
    h('div', { class: 'pol-card' },
      row('Срок жизни, часов', 'Потом песочница закрывается сама, изменения профиля — на проверку. Открытую можно продлить.', f.ttl),
      row('Закрывать при простое, минут', 'Если агент столько времени не ходит в сеть и в API моделей.', f.idle),
      row('Спрашивать о незнакомых адресах', 'Для песочниц с фильтром «Сеть»: соединение не по правилам ждёт решения человека, а не блокируется сразу.', h('label', { class: 'switch' }, f.ask, h('span', {}))),
      row('Процессов агента', 'ulimit -u: защита от бесконечного порождения процессов. Не меньше 32.', f.pids),
      row('Время работы агента, минут', 'Агент останавливается, проработав столько.', f.agentMinutes),
      row('Запросов к API в день', 'Через шлюз секретов; сверх лимита агент получает отказ (429).', f.apiPerDay)),
    h('p', { class: 'muted small' }, 'Изменения профиля всегда идут на проверку, если у профиля не отмечено «без ревью»; skills, хуки и MCP на проверке не отмечаются заранее.'),
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn primary', onclick: save }, 'Сохранить политику')));
}

async function openSettings(pane) {
  if (typeof pane !== 'string') { try { pane = localStorage.getItem('smolvm.settingsPane'); } catch { pane = null; } }
  const f = $('#form-settings');
  $('#settings-error').hidden = true;
  $('#proxy-detect-out').hidden = true;
  $('#proxy-test-out').hidden = true;
  let s;
  try { s = await api('GET', '/ui/settings'); } catch (e) { toast(e.message, 'err'); return; }
  f.proxyEnabled.checked = s.proxy.enabled;
  f.proxySystem.checked = !!s.proxy.system;
  $('#proxy-system-wrap').hidden = state.info?.platform !== 'win32';
  f.proxyUrl.value = s.proxy.url;
  f.noProxy.value = s.proxy.noProxy;
  f.proxyPull.checked = s.proxy.pull;
  f.proxyExec.checked = s.proxy.exec;
  f.proxyProvision.checked = s.proxy.provision;
  f.caEnabled.checked = s.ca.enabled;
  f.caSystem.checked = s.ca.system;
  f.caPem.value = s.ca.pem;
  f.caReplace.checked = s.ca.replaceSystemBundle;
  f.caPullTrust.checked = s.ca.pullTrust !== false;
  const r = s.repos || {};
  f.repoRegistry.value = r.registry || ''; f.repoRewrite.checked = r.rewrite !== false;
  f.repoUser.value = r.username || ''; f.repoPassword.value = '';
  f.repoPassword.placeholder = r.hasPassword ? 'сохранён — оставьте пустым, чтобы не менять' : '';
  f.repoPip.value = r.pip || ''; f.repoNpm.value = r.npm || ''; f.repoAptDebian.value = r.aptDebian || '';
  f.repoAptSecurity.value = r.aptSecurity || ''; f.repoGoproxy.value = r.goproxy || ''; f.repoGithub.value = r.github || ''; f.repoGuestAuth.checked = !!r.guestAuth;
  f.smolvmBin.value = s.smolvm?.bin || ''; f.smolvmBin.placeholder = s.smolvmBinDefault || 'smolvm';
  $('#smolvm-check-out').hidden = true;
  syncRepoHint();
  $('#ca-system-hint').textContent = state.info?.platform === 'win32' ? '(хранилище Windows)' : state.info?.platform === 'darwin' ? '(связка ключей macOS)' : '(системный bundle)';
  syncSettingsForm();
  previewCa();
  showSettingsPane(pane || 'smolvm');
  if (!$('#dlg-settings').open) $('#dlg-settings').showModal();
}

function syncSettingsForm() {
  const f = $('#form-settings');
  const p = f.proxyEnabled.checked;
  const sys = p && f.proxySystem.checked && state.info?.platform === 'win32';
  for (const n of ['proxySystem', 'noProxy', 'proxyPull', 'proxyExec', 'proxyProvision']) f[n].disabled = !p;
  f.proxyUrl.disabled = !p || sys;
  f.proxyUrl.placeholder = sys ? 'из настроек Windows (PAC / Internet Settings)' : 'http://proxy.corp.local:3128';
  $('#btn-proxy-test').disabled = !(sys || f.proxyUrl.value.trim());
  const c = f.caEnabled.checked;
  for (const n of ['caSystem', 'caPem', 'caReplace', 'caPullTrust']) f[n].disabled = !c;
}

let caTimer = null;
function previewCa() {
  const f = $('#form-settings');
  const out = $('#ca-out');
  if (!f.caEnabled.checked) { out.textContent = ''; return; }
  clearTimeout(caTimer);
  caTimer = setTimeout(async () => {
    try {
      const r = await api('POST', '/ui/ca/preview', { pem: f.caPem.value, system: f.caSystem.checked });
      out.className = 'small muted';
      out.textContent = `Bundle: ${r.count} сертификатов (ваших: ${r.user}, системных: ${r.system}, плюс публичные корневые).`;
    } catch (e) { out.className = 'small error'; out.textContent = e.message; }
  }, 300);
}

function settingsFromForm() {
  const f = $('#form-settings');
  return {
    proxy: {
      enabled: f.proxyEnabled.checked, system: f.proxySystem.checked, url: f.proxyUrl.value.trim(), noProxy: f.noProxy.value.trim(),
      pull: f.proxyPull.checked, exec: f.proxyExec.checked, provision: f.proxyProvision.checked,
    },
    ca: { enabled: f.caEnabled.checked, system: f.caSystem.checked, pem: f.caPem.value.trim(), replaceSystemBundle: f.caReplace.checked, pullTrust: f.caPullTrust.checked },
    repos: {
      registry: f.repoRegistry.value.trim(), rewrite: f.repoRewrite.checked, username: f.repoUser.value.trim(),
      ...(f.repoPassword.value ? { password: f.repoPassword.value } : {}),
      pip: f.repoPip.value.trim(), npm: f.repoNpm.value.trim(), aptDebian: f.repoAptDebian.value.trim(),
      aptSecurity: f.repoAptSecurity.value.trim(), goproxy: f.repoGoproxy.value.trim(), github: f.repoGithub.value.trim(), guestAuth: f.repoGuestAuth.checked,
    },
    smolvm: { bin: f.smolvmBin.value.trim() },
  };
}

// Preview of how a Docker Hub image is rewritten.
function syncRepoHint() {
  const f = $('#form-settings');
  const p = f.repoRegistry.value.trim().replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, '');
  $('#repo-rewrite-hint').textContent = p ? `(node:22-bookworm-slim → ${p}/library/node:22-bookworm-slim)` : '';
}
$('#form-settings').repoRegistry.addEventListener('input', syncRepoHint);
// «Виртуализация»: installed smolvm (CLI) and the running smolvm serve (API).
async function renderVirtInfo() {
  const box = $('#virt-info');
  let r;
  try { r = await api('GET', '/ui/smolvm/info'); } catch (e) { box.replaceChildren(h('dt', {}, 'smolvm'), h('dd', { class: 'error' }, e.message)); return; }
  const row = (k, v, cls) => [h('dt', {}, k), h('dd', cls ? { class: cls } : {}, v)];
  box.replaceChildren(
    ...row('Установлен', r.cli.ok ? r.cli.version : `не найден: ${r.cli.error}`, r.cli.ok ? '' : 'error'),
    ...row('Бинарник', h('code', {}, r.bin)),
    ...row('smolvm serve', r.api.ok ? `работает${r.api.version ? `, версия ${r.api.version}` : ''} — ${r.api.upstream}` : `не отвечает — ${r.api.upstream}`, r.api.ok ? '' : 'error'),
    ...(r.api.ok && r.cli.ok && r.api.version && !r.cli.version.includes(r.api.version)
      ? row('', 'Версии CLI и запущенного smolvm serve различаются — перезапустите smolvm-web (или smolvm serve).', 'notice') : []),
    ...row('Гипервизор', r.hypervisor),
  );
}

$('#btn-smolvm-check').addEventListener('click', async () => {
  const f = $('#form-settings');
  const out = $('#smolvm-check-out');
  out.hidden = false; out.className = 'small muted'; out.textContent = 'Проверка…';
  try {
    const r = await api('POST', '/ui/smolvm/check', { bin: f.smolvmBin.value.trim() });
    out.className = r.ok ? 'small okc' : 'small error';
    out.textContent = r.ok ? `✓ ${r.version} (${r.bin})` : `✗ ${r.bin}: ${r.error}`;
  } catch (e) { out.className = 'small error'; out.textContent = e.message; }
});

$('#form-settings').addEventListener('input', (e) => {
  syncSettingsForm();
  if (['caPem', 'caSystem', 'caEnabled'].includes(e.target.name)) previewCa();
});
$('#form-settings').addEventListener('change', () => { syncSettingsForm(); });

$('#btn-proxy-detect').addEventListener('click', async () => {
  const f = $('#form-settings');
  const out = $('#proxy-detect-out');
  out.hidden = false; out.className = 'small muted'; out.textContent = 'Поиск…';
  try {
    const d = await api('GET', '/ui/proxy/detect');
    const sys = d.system;
    if (sys?.available && (sys.pac || sys.enabled)) {
      // Windows: use the system proxy as browsers do (PAC, Kerberos/NTLM sign-in).
      f.proxyEnabled.checked = true;
      f.proxySystem.checked = true;
      out.className = 'small';
      out.innerHTML = `Windows: ${sys.pac ? `PAC <code>${esc(sys.pac)}</code>` : `прокси <code>${esc(sys.server)}</code>`}`
        + `${sys.sample !== undefined ? ` → для Docker Hub: <code>${esc(sys.sample || 'напрямую')}</code>` : ''}`
        + `${sys.error ? ` <span class="error">(${esc(sys.error)})</span>` : ''}<br>`
        + (d.sspi?.available ? `Вход в прокси: под учётной записью <b>${esc(d.sspi.user || '')}</b> (Kerberos / NTLM).` : `<span class="error">Встроенная авторизация Windows недоступна: ${esc(d.sspi?.error || '')}</span>`)
        + ' Включён «Системный прокси Windows» — нажмите «Проверить», затем «Сохранить».';
    } else if (d.url) {
      f.proxyUrl.value = d.url;
      if (d.noProxy && !f.noProxy.value) f.noProxy.value = d.noProxy;
      f.proxyEnabled.checked = true;
      out.className = 'small';
      out.innerHTML = `Найден: <code>${esc(d.url)}</code> — ${esc(d.source)}`;
    } else {
      out.className = 'small notice';
      out.textContent = d.note || 'Прокси не найден';
    }
    syncSettingsForm();
  } catch (e) { out.className = 'small error'; out.textContent = e.message; }
});

$('#btn-proxy-test').addEventListener('click', async () => {
  const f = $('#form-settings');
  const out = $('#proxy-test-out');
  out.hidden = false; out.className = 'small muted'; out.textContent = 'Проверка…';
  try {
    const sys = f.proxySystem.checked && state.info?.platform === 'win32';
    const r = await api('POST', '/ui/proxy/test', sys ? { system: true, noProxy: f.noProxy.value.trim() } : { url: f.proxyUrl.value.trim() });
    const li = (x) => `<li class="${x.ok ? 'okc' : 'badc'}">${x.ok ? '✓' : '✗'} ${esc(x.target)} — ${esc(x.status || x.error)}${x.ms != null ? ` (${x.ms} мс)` : ''}</li>`;
    if (sys) {
      let html = `<b>С этого компьютера (прокси по настройкам Windows, вход — учётная запись Windows${r.sspi?.user ? ` ${esc(r.sspi.user)}` : ''}):</b><ul class="result-list">${r.results.map(li).join('')}</ul>`;
      html += r.relay ? `<b>Через ретранслятор для машин:</b><ul class="result-list">${li(r.relay)}</ul>` : '<div class="muted">Ретранслятор для машин проверится после сохранения настроек.</div>';
      out.className = 'small';
      out.innerHTML = html;
      return;
    }
    let html = `<b>С этого компьютера:</b><ul class="result-list">${r.results.map(li).join('')}</ul>`;
    if (r.guest?.rewritten) {
      html += `<div class="notice">${esc(r.guest.warning)}</div>`;
      if (r.guestReach) html += `<b>По адресу для машин (${esc(r.guest.url)}):</b><ul class="result-list">${li(r.guestReach)}</ul>`;
    }
    if (r.guest?.error) html += `<div class="error">${esc(r.guest.error)}</div>`;
    out.className = 'small';
    out.innerHTML = html;
  } catch (e) { out.className = 'small error'; out.textContent = e.message; }
});

$('#form-settings').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#settings-error');
  err.hidden = true;
  const s = settingsFromForm();
  if (s.proxy.enabled && !s.proxy.url && !(s.proxy.system && state.info?.platform === 'win32')) { err.textContent = 'Укажите адрес прокси'; err.hidden = false; return; }
  try {
    await api('PUT', '/ui/settings', s);
    $('#dlg-settings').close();
    await refreshInfo();
    toast('Настройки сохранены', 'ok');
    const m = current();
    if (m) { updateDetailHead(m); if (state.tab === 'overview') renderTab(); }
  } catch (ex) { err.textContent = ex.message; err.hidden = false; }
});

$('#btn-settings').addEventListener('click', () => openSettings());
$('#proxy-chip').addEventListener('click', () => openSettings('proxy'));

// ---------- vault ----------
const MODE_LABEL = { gateway: 'шлюз', substitute: 'подстановка smolvm', env: 'переменная (видна машине)' };
const MODE_TAG = { gateway: 'ok', substitute: 'ok', env: 'bad' };
const PRESETS = {
  deepseek: { name: 'deepseek', envVar: 'DEEPSEEK_API_KEY', hosts: 'api.deepseek.com', upstream: 'https://api.deepseek.com', baseUrlVar: 'DEEPSEEK_BASE_URL' },
  openai: { name: 'openai', envVar: 'OPENAI_API_KEY', hosts: 'api.openai.com', upstream: 'https://api.openai.com/v1', baseUrlVar: 'OPENAI_BASE_URL' },
  anthropic: { name: 'anthropic', envVar: 'ANTHROPIC_API_KEY', hosts: 'api.anthropic.com', upstream: 'https://api.anthropic.com', baseUrlVar: 'ANTHROPIC_BASE_URL' },
  openrouter: { name: 'openrouter', envVar: 'OPENROUTER_API_KEY', hosts: 'openrouter.ai', upstream: 'https://openrouter.ai/api/v1', baseUrlVar: 'OPENROUTER_BASE_URL' },
  gemini: { name: 'gemini', envVar: 'GEMINI_API_KEY', hosts: 'generativelanguage.googleapis.com', upstream: 'https://generativelanguage.googleapis.com', baseUrlVar: 'GOOGLE_GEMINI_BASE_URL' },
  github: { name: 'github', envVar: 'GITHUB_TOKEN', hosts: 'api.github.com', upstream: 'https://api.github.com', baseUrlVar: 'GITHUB_API_URL', confirm: 'DELETE *, PUT /repos/*/merge, POST /repos/*/releases, POST /repos/*/deployments, PATCH /repos/*/branches/*' },
  // Neutral variable names: agents' DeepSeek/OpenAI auto-config does not pick it up by mistake.
  local: { name: 'local-llm', envVar: 'LOCAL_LLM_API_KEY', hosts: '', upstream: 'http://localhost:11434/v1', baseUrlVar: 'LOCAL_LLM_BASE_URL', allowHttp: true, model: 'deepseek-r1:14b', mode: 'gateway' },
};
let vaultCache = [];

async function loadVault() {
  const v = await api('GET', '/ui/vault');
  vaultCache = v.secrets || [];
  return v;
}

function openVault() { return openSettings('secrets'); }

async function renderVault() {
  const st = $('#vault-status');
  const list = $('#vault-list');
  let v;
  try { v = await loadVault(); } catch (e) { st.innerHTML = `<div class="error">${esc(e.message)}</div>`; return; }
  if (!v.ok) { st.innerHTML = `<div class="error">${esc(v.error)}</div>`; list.innerHTML = ''; return; }
  const gw = v.gateway;
  st.innerHTML = `Ключ шифрования: <b>${esc(v.backend)}</b>.${gw?.listening ? ` Шлюз: <code>${esc(gw.baseUrl || '')}</code>` : gw?.error ? ` <span class="error">Шлюз: ${esc(gw.error)}</span>` : ''}`;
  list.innerHTML = '';
  if (!v.secrets.length) { list.append(h('p', { class: 'muted' }, 'Секретов пока нет.')); return; }
  list.append(h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
    h('tr', {}, h('th', {}, 'Имя'), h('th', {}, 'Режим'), h('th', {}, 'Переменная'), h('th', {}, 'Куда'), h('th', {}, 'Машины'), h('th', {}, '')),
    v.secrets.map((x) => h('tr', {},
      h('td', {}, h('span', { class: 'with-mark' }, mark(secretMark(x), true), h('span', { class: 'mono' }, x.name)), x.note ? h('div', { class: 'muted small' }, x.note) : null),
      h('td', {}, h('span', { class: `tag ${MODE_TAG[x.mode]}` }, MODE_LABEL[x.mode])),
      h('td', { class: 'mono small' }, x.envVar, x.baseUrlVar ? h('div', { class: 'muted' }, x.baseUrlVar) : null, x.model ? h('div', { class: 'muted' }, `модель: ${x.model}`) : null, x.confirm?.length ? h('div', { class: 'warnc' }, `подтверждение: ${x.confirm.length}`) : null),
      h('td', { class: 'mono small' }, x.mode === 'gateway' ? x.upstream : x.mode === 'substitute' ? x.hosts.join(', ') : '—'),
      h('td', { class: 'small' }, x.machines.join(', ') || '—'),
      h('td', {},
        h('button', { class: 'btn ghost', onclick: () => editSecret(x) }, 'Изменить'),
        h('button', { class: 'btn ghost danger', onclick: () => deleteSecret(x) }, 'Удалить')))))));
}

function syncSecretForm() {
  const f = $('#form-secret');
  const mode = f.mode.value;
  f.querySelectorAll('[data-mode]').forEach((el) => { el.hidden = !el.dataset.mode.split(' ').includes(mode); });
}

function editSecret(x) {
  const f = $('#form-secret');
  f.reset();
  $('#secret-error').hidden = true;
  f.dataset.editing = x ? x.name : '';
  f.name.readOnly = !!x;
  if (x) {
    f.name.value = x.name; f.mode.value = x.mode; f.envVar.value = x.envVar; f.baseUrlVar.value = x.baseUrlVar;
    f.upstream.value = x.upstream; f.allowHttp.checked = !!x.allowHttp; f.model.value = x.model || ''; f.confirm.value = (x.confirm || []).join(', '); f.hosts.value = x.hosts.join(', '); f.methods.value = x.methods.join(', '); f.note.value = x.note;
    f.value.placeholder = 'оставьте пустым, чтобы не менять';
  } else {
    f.mode.value = state.info?.proxyActive ? 'gateway' : 'substitute';
    f.value.placeholder = 'sk-…';
  }
  f.preset.disabled = !!x;
  syncSecretForm();
  f.hidden = false;
  (x ? f.value : f.preset).focus();
}

async function deleteSecret(x) {
  const res = await confirmDialog('Удалить секрет?', `«${x.name}» будет удалён из хранилища${x.machines.length ? ` и отвязан от машин: ${x.machines.join(', ')}` : ''}.`);
  if (!res.ok) return;
  try { await api('DELETE', `/ui/vault/${enc(x.name)}`); toast(`Секрет ${x.name} удалён`, 'ok'); } catch (e) { toast(e.message, 'err'); }
  renderVault();
}

$('#btn-secret-add').addEventListener('click', () => editSecret(null));
$('#btn-secret-cancel').addEventListener('click', () => { $('#form-secret').hidden = true; });
$('#form-secret').addEventListener('change', (e) => {
  const f = e.currentTarget;
  if (e.target.name === 'preset' && PRESETS[f.preset.value]) {
    const p = PRESETS[f.preset.value];
    for (const k of ['name', 'envVar', 'hosts', 'upstream', 'baseUrlVar']) f[k].value = p[k];
    f.allowHttp.checked = !!p.allowHttp;
    f.model.value = p.model || '';
    f.confirm.value = p.confirm || '';
    if (p.mode) f.mode.value = p.mode;
  }
  syncSecretForm();
});
$('#form-secret').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  const err = $('#secret-error');
  err.hidden = true;
  const name = f.name.value.trim();
  const body = {
    mode: f.mode.value, envVar: f.envVar.value.trim(), baseUrlVar: f.baseUrlVar.value.trim(),
    upstream: f.upstream.value.trim(), allowHttp: f.allowHttp.checked, model: f.model.value.trim(), confirm: csv(f.confirm.value), hosts: csv(f.hosts.value), methods: csv(f.methods.value),
    note: f.note.value.trim(), value: f.value.value,
  };
  try {
    await api('PUT', `/ui/vault/${enc(name)}`, body);
    f.value.value = '';
    f.hidden = true;
    toast(`Секрет ${name} сохранён`, 'ok');
    renderVault();
  } catch (ex) { err.textContent = ex.message; err.hidden = false; }
});

async function fillCreateIsolation() {
  const f = $('#form-create');
  let eg = { lists: [], defaults: {} };
  try { eg = await api('GET', '/ui/egress'); } catch {}
  createFolders = [];
  drawCreateFolders();
  f.egressOn.checked = !!eg.defaults?.enabled;
  f.egressStrict.checked = !!eg.defaults?.strict;
  syncCreateEgress();
  $('#create-egress-lists').replaceChildren(...eg.lists.map((l) => h('label', { class: 'check' },
    h('input', { type: 'checkbox', value: l.id, checked: l.default }), ` ${l.name} `, h('span', { class: 'muted small' }, `(${l.rules.length})`))));
}

// Folders picked in the create dialog; mounted or copied when the machine is created.
let createFolders = [];
function drawCreateFolders() {
  $('#create-folders').replaceChildren(...createFolders.map((x, i) => h('div', { class: 'folder-row' },
    h('div', { class: 'folder-main' }, h('div', { class: 'mono ellipsis path-tail', title: x.hostPath }, `\u200e${x.hostPath}\u200e`), h('div', { class: 'small muted mono' }, `→ ${x.guestPath || guestDefault(x.hostPath)}`)),
    h('span', { class: `tag ${FOLDER_MODES[x.mode].tag}` }, FOLDER_MODES[x.mode].short),
    h('button', { type: 'button', class: 'btn ghost icon', title: 'Убрать', onclick: () => { createFolders.splice(i, 1); drawCreateFolders(); } }, ic('x')))));
}
$('#btn-create-folder').addEventListener('click', () => openFolderDialog({ fixedMachine: '__new', onDone: (x) => {
  createFolders = createFolders.filter((y) => y.hostPath !== x.hostPath).concat([x]);
  drawCreateFolders();
} }));
function syncCreateEgress() {
  const on = $('#form-create').egressOn.checked;
  $('#create-egress').hidden = !on;
  // The filter itself goes out through the corporate proxy.
  $('#create-proxy-wrap').hidden = on || !state.info?.proxyActive;
}
$('#form-create').egressOn.addEventListener('change', syncCreateEgress);

async function fillCreateSecrets() {
  const wrap = $('#create-secrets-wrap');
  const box = $('#create-secrets');
  try { await loadVault(); } catch { vaultCache = []; }
  wrap.hidden = !vaultCache.length;
  box.innerHTML = '';
  for (const x of vaultCache) {
    box.append(h('label', { class: 'check', title: x.note || '' }, h('input', { type: 'checkbox', value: x.name }),
      mark(secretMark(x), true), ` ${x.name} `, h('span', { class: `tag ${MODE_TAG[x.mode]}` }, MODE_LABEL[x.mode])));
  }
}

async function changeSecrets(m, add, remove) {
  try {
    await api('PUT', `/ui/machines/${enc(m.name)}/secrets`, { add, remove });
    toast(add.length ? `Секрет привязан к ${m.name}` : `Секрет отвязан от ${m.name}`, 'ok');
  } catch (e) { toast(e.message, 'err'); }
  if (state.tab === 'overview') renderTab();
}

// ---------- profiles (create) ----------
let createProfile = null;
let profilesCache = null;
// Profile/agent/provider marks: brand glyphs from the sprite, or a text fallback.
const MARK_ICON = { claude: 'b-claude', dsh: 'b-deepseek', deepseek: 'b-deepseek', opencode: 'b-opencode', openai: 'b-openai', codex: 'b-codex', hermes: 'b-nous',
  gemini: 'b-gemini', openrouter: 'b-openrouter', github: 'b-github', term: 'i-terminal', vm: 'i-server', blank: 'i-plus', all: 'i-bot', key: 'i-key' };
const MARK_TEXT = { sf: '{ }',  pi: 'π', hermes: '☤' };
const SMOLFILE = '__smolfile';
function mark(m, small) {
  const el = h('span', { class: `mark m-${m}${small ? ' sm' : ''}` });
  if (MARK_ICON[m]) {
    const t = document.createElement('template');
    t.innerHTML = `<svg class="ic"><use href="#${MARK_ICON[m]}"/></svg>`;
    el.append(t.content.firstChild);
  } else el.textContent = MARK_TEXT[m] || '?';
  return el;
}
// Which provider a secret belongs to (for its mark).
function secretMark(x) {
  const s = `${x.upstream || ''} ${(x.hosts || []).join(' ')} ${x.envVar || ''}`.toLowerCase();
  if (/anthropic/.test(s)) return 'claude';
  if (/deepseek/.test(s)) return 'deepseek';
  if (/openrouter/.test(s)) return 'openrouter';
  if (/openai/.test(s)) return 'openai';
  if (/gemini|generativelanguage|google/.test(s)) return 'gemini';
  if (/github/.test(s)) return 'github';
  return 'key';
}

async function fillCreateProfiles() {
  const box = $('#create-profiles');
  if (!profilesCache) {
    try { profilesCache = (await api('GET', '/ui/profiles')).profiles; } catch { profilesCache = []; }
  }
  const f = $('#form-create');
  const pick = (id) => {
    createProfile = id;
    f.classList.toggle('sf-mode', id === SMOLFILE);
    box.querySelectorAll('.profile').forEach((b) => b.classList.toggle('active', (b.dataset.id || null) === (id || null) || (!id && !b.dataset.id)));
    const p = profilesCache.find((x) => x.id === id);
    if (id === SMOLFILE) {
      const hint = $('#create-profile-hint');
      hint.hidden = false;
      hint.textContent = 'Образ, ресурсы, порты, тома, сеть и init берутся из Smolfile. Ниже можно добавить то, чем управляет smolvm-web: корпоративный прокси, фильтр «Сеть» и секреты.';
      if (!f.name.value) f.name.placeholder = `sf-${Math.random().toString(36).slice(2, 6)}`;
      setTimeout(() => f.smolfile.focus(), 0);
      return;
    }
    f.image.value = p ? p.image : 'alpine';
    syncImageHint();
    f.memoryMb.placeholder = p ? String(p.memoryMb) : '8192';
    f.cpus.placeholder = p ? String(p.cpus) : '4';
    if (p && (!f.name.value || /^vm-/.test(f.name.placeholder))) f.name.placeholder = `${p.id}-${Math.random().toString(36).slice(2, 5)}`;
    const hint = $('#create-profile-hint');
    hint.hidden = !p;
    if (p) hint.textContent = `Агенты: ${p.agents.map((a) => a.title).join(', ')}. Установка — автоматически после первого запуска (~2–3 мин). `
      + 'Для доступа к модели отметьте ниже секрет с ключом провайдера (режим «Шлюз»). '
      + `Серверы вендора (${p.vendor.map((v) => v.host).join(', ')}) с фильтром «Сеть» разрешены по умолчанию — отозвать их можно во вкладке «Агенты».`;
    // Suggest the matching provider secrets.
    if (p && p.keys.length) {
      const re = new RegExp(p.keys.join('|'), 'i');
      document.querySelectorAll('#create-secrets input').forEach((i) => {
        const x = vaultCache.find((v) => v.name === i.value);
        if (x && x.mode !== 'substitute' && re.test(`${x.upstream} ${x.envVar}`)) i.checked = true;
      });
    }
  };
  box.replaceChildren(
    h('button', { type: 'button', class: 'profile', onclick: () => pick(null) }, mark('blank'),
      h('span', { class: 'p-name' }, 'Пустая машина'), h('span', { class: 'p-desc' }, 'Любой OCI-образ, без агентов')),
    h('button', { type: 'button', class: 'profile', 'data-id': SMOLFILE, onclick: () => pick(SMOLFILE) }, mark('sf'),
      h('span', { class: 'p-name' }, 'Из Smolfile'), h('span', { class: 'p-desc' }, 'Вставьте или загрузите Smolfile (TOML)')),
    ...profilesCache.map((p) => h('button', { type: 'button', class: 'profile', 'data-id': p.id, onclick: () => pick(p.id) }, mark(p.mark),
      h('span', { class: 'p-name' }, p.title), h('span', { class: 'p-desc' }, p.desc))),
  );
  pick(null);
}

// ---------- agents tab ----------
// Agents open in a new browser tab. The tab is opened synchronously on click
// (so popup blockers allow it) and pointed at the agent once it is up.
function agentTab() {
  const w = window.open('', '_blank');
  if (w) {
    try { w.opener = null; } catch {}
    try { w.document.title = 'Запуск агента…'; w.document.body.style.cssText = 'font:14px system-ui;color:#71717a;background:#09090b;display:grid;place-items:center;height:100vh;margin:0'; w.document.body.textContent = 'Запуск агента…'; } catch {}
  }
  return w;
}
function agentUrl(url) {
  // Same host name as this page: localhost and 127.0.0.1 are different sites,
  // and agent cookies (dsh) are SameSite=Strict.
  const u = new URL(url);
  if (['127.0.0.1', 'localhost'].includes(location.hostname)) u.hostname = location.hostname;
  return u.toString();
}
function goAgent(w, url) {
  url = agentUrl(url);
  if (w && !w.closed) w.location.replace(url);
  else if (!window.open(url, '_blank', 'noopener')) toast(h('span', {}, 'Браузер заблокировал новую вкладку. ', h('a', { href: url, target: '_blank', rel: 'noopener' }, 'Открыть агента')), 'err');
}

async function tabAgents(body, m) {
  const head = h('div', { class: 'col', style: 'display:flex;flex-direction:column;gap:14px' });
  // What the agents see from this computer — outside `head`, which re-renders on every poll.
  const folders = folderList(m, { compact: true });
  body.append(head, h('section', { class: 'card agent-folders' },
    h('div', { class: 'card-head' }, h('h3', { class: 'h-ic' }, ic('folder'), 'Агенту доступны папки'), h('span', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: () => openFolderDialog({ machine: m.name, onDone: () => folders.refresh() }) }, ic('plus'), 'Дать доступ к папке')),
    folders));
  let alive = true;
  let timer = null;
  let st = null;
  let lastSig = '';
  tabCleanup = () => { alive = false; clearTimeout(timer); };

  const refresh = async () => {
    if (!alive) return;
    clearTimeout(timer);
    try { st = await api('GET', `/ui/machines/${enc(m.name)}/agents`); } catch (e) { head.replaceChildren(h('div', { class: 'error' }, e.message)); return; }
    if (!alive) return;
    // Re-render only on change, so buttons are not replaced under the cursor.
    const sig = JSON.stringify(st);
    if (sig !== lastSig) { lastSig = sig; renderHead(); }
    timer = setTimeout(refresh, st.job?.status === 'running' ? 1500 : 5000);
  };

  function renderHead() {
    const nodes = [];
    const running = st.machineRunning;
    if (!st.agents.length) {
      const picks = st.available.map((a) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: a.id }), ` ${a.title} `, h('span', { class: 'muted small' }, a.desc)));
      nodes.push(h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h3', {}, 'Подключить агентов')),
        h('p', { class: 'muted small' }, 'Агенты ставятся в машину (нужен образ с Node.js на Debian, например node:22-bookworm-slim) и открываются прямо здесь. Для портов машина будет перезапущена.'),
        h('div', { class: 'checks-col' }, picks),
        h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async () => {
          const add = picks.map((l) => l.querySelector('input')).filter((i) => i.checked).map((i) => i.value);
          if (!add.length) return toast('Выберите агентов', 'err');
          try {
            const r = await api('POST', `/ui/machines/${enc(m.name)}/agents`, { add });
            if (r.restartNeeded) {
              toast('Перезапускаю машину, чтобы опубликовать порты агентов…');
              await actions.stop(m);
              await actions.start({ ...m });
            }
            await api('POST', `/ui/machines/${enc(m.name)}/agents/install`, {}).catch((e) => toast(e.message, 'err'));
          } catch (e) { toast(e.message, 'err'); }
          refresh();
        } }, 'Подключить и установить'))));
      head.replaceChildren(...nodes);
      return;
    }

    // Install state
    const job = st.job;
    if (job?.status === 'running' || job?.status === 'error' || !st.installed) {
      const STEPS = ['Системные пакеты', 'Пользователь', 'Веб-терминал ttyd', 'npm', 'Hermes Agent', 'Проверка', 'Готово'].filter((x) => x !== 'Hermes Agent' || st.agents.some((a) => a.id === 'hermes'));
      const cur = STEPS.findIndex((x) => (job?.step || '').startsWith(x));
      const term = h('div', { class: 'term' });
      term.textContent = job?.log || '';
      nodes.push(h('section', { class: 'install' },
        h('div', { class: 'card-head' },
          h('h3', {}, job?.status === 'running' ? 'Установка агентов…' : job?.status === 'error' ? 'Установка не удалась' : 'Агенты не установлены'),
          h('span', { class: 'spacer' }),
          job?.status !== 'running' ? h('button', { class: 'btn primary', disabled: !running, title: running ? '' : 'Сначала запустите машину', onclick: async () => {
            try { await api('POST', `/ui/machines/${enc(m.name)}/agents/install`, {}); } catch (e) { toast(e.message, 'err'); }
            refresh();
          } }, [ic('download'), job?.status === 'error' ? 'Повторить' : 'Установить']) : null),
        job ? h('div', { class: 'steps' }, STEPS.map((x, i) => h('span', { class: i < cur || job.status === 'ok' ? 'done' : i === cur ? 'now' : '' }, x))) : null,
        job?.error ? h('div', { class: 'error' }, job.error) : null,
        job ? term : h('p', { class: 'muted small' }, running ? 'Нажмите «Установить» — займёт 2–3 минуты.' : 'Запустите машину — установка начнётся автоматически.')));
      requestAnimationFrame(() => { term.scrollTop = term.scrollHeight; });
    }
    if (st.missingPorts.length) {
      nodes.push(h('div', { class: 'notice' }, `Порты агентов (${st.missingPorts.map((p) => p.host).join(', ')}) ещё не опубликованы — они применятся при следующем запуске машины. `,
        running ? h('button', { class: 'btn', onclick: async () => { await actions.stop(m); await actions.start({ ...m }); refresh(); } }, 'Перезапустить') : null));
    }
    if (!st.providers?.providers?.length) {
      nodes.push(h('div', { class: 'notice' }, 'К машине не привязан ключ модели. Добавьте ключ провайдера модели в «Секреты» (режим «Шлюз») и привяжите на вкладке «Обзор» — агенты подхватят его при следующем запуске. Без ключа агент может войти напрямую через сервер вендора (подписка, OAuth), если этот сервер не отозван.'));
    }

    nodes.push(h('div', { class: 'agents' }, st.agents.map((a) => {
      const can = running && a.installed && a.portReady;
      const auto = a.autonomous ? h('input', { type: 'checkbox', title: 'Без подтверждений действий агента (машина — песочница)' }) : null;
      const startBtn = h('button', { class: 'btn primary', disabled: !can, title: 'Запустить и открыть в новой вкладке', onclick: async () => {
        const w = agentTab();
        startBtn.disabled = true; startBtn.textContent = 'Запуск…';
        try {
          const r = await api('POST', `/ui/machines/${enc(m.name)}/agents/${a.id}/start`, { autonomous: !!auto?.checked });
          goAgent(w, r.url);
        } catch (e) { if (w) w.close(); toast(`${a.title}: ${e.message}`, 'err'); }
        lastSig = ''; refresh();
      } }, [ic('play'), 'Запустить']);
      return h('div', { class: `agent ${a.running ? 'running' : ''}` },
        h('div', { class: 'agent-head' }, mark(a.mark),
          h('div', {}, h('div', { class: 'a-title' }, a.title), h('div', { class: 'a-sub' }, a.kind === 'tty' ? 'терминал' : 'веб-интерфейс', ` · порт ${a.hostPort}`)),
          h('span', { class: 'spacer' }),
          h('span', { class: `badge ${a.running ? 'running' : 'stopped'}` }, a.running ? 'работает' : !a.installed ? 'не установлен' : 'остановлен')),
        a.provider ? h('div', { class: 'muted small' }, `Модель: ${a.provider}`) : a.id !== 'terminal' ? h('div', { class: 'muted small' }, 'Модель: не задана') : h('div', { class: 'muted small' }, a.desc),
        h('div', { class: 'row' },
          a.running
            ? [h('button', { class: 'btn primary', title: 'Открыть в новой вкладке', onclick: async () => {
                const w = agentTab();
                try { const r = await api('GET', `/ui/machines/${enc(m.name)}/agents/${a.id}/open`); goAgent(w, r.url); } catch (e) { if (w) w.close(); toast(e.message, 'err'); }
              } }, [ic('external'), 'Открыть']),
              h('button', { class: 'btn', onclick: async () => {
                try { await api('POST', `/ui/machines/${enc(m.name)}/agents/${a.id}/stop`, {}); } catch (e) { toast(e.message, 'err'); }
                refresh();
              } }, [ic('stop'), 'Стоп'])]
            : startBtn,
          auto ? h('label', { class: 'check small', title: auto.title }, auto, 'автономно') : null));
    })));
    if (st.vendor?.length) {
      const revoked = st.vendor.filter((v) => v.revoked).length;
      nodes.push(h('p', { class: 'muted small' }, `Серверы провайдеров агентов: ${st.vendor.length}${revoked ? `, отозвано: ${revoked}` : ''} — `,
        h('a', { href: `#/egress?machine=${enc(m.name)}&tab=providers` }, 'настроить в «Сети» →')));
    }
    head.replaceChildren(...nodes);
  }

  refresh();
}

// ---------- theme ----------
function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
}
applyTheme(localStorage.getItem('smolvm.theme'));
$('#btn-theme').addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  localStorage.setItem('smolvm.theme', next);
  applyTheme(next);
});

// ---------- pages ----------
const pages = {}; // id -> { render(el, params), leave() }
let pageCleanup = null;
function routeParams() {
  const m = location.hash.match(/^#\/(\w*)(?:\?(.*))?$/);
  // No hash at all: the start page is «Рабочие места»; «#/» stays the machines list.
  if (!location.hash || location.hash === '#') return { page: 'work', params: new URLSearchParams() };
  return { page: (m && m[1]) || 'machines', params: new URLSearchParams((m && m[2]) || '') };
}
function route() {
  const { page, params } = routeParams();
  const id = pages[page] ? page : 'machines';
  if (pageCleanup) { try { pageCleanup(); } catch {} pageCleanup = null; }
  state.page = id;
  $('#page-machines').hidden = id !== 'machines';
  for (const k of Object.keys(pages)) $(`#page-${k}`).hidden = k !== id;
  // Sandbox templates, profiles and review live under «Рабочие места».
  const navId = ['sandbox', 'session', 'review', 'profile'].includes(id) ? 'work' : id === 'log' ? 'egress' : id;
  document.querySelectorAll('#pagenav a').forEach((a) => a.classList.toggle('active', a.dataset.page === navId));
  if (id !== 'machines') pageCleanup = pages[id].render($(`#page-${id}`), params) || null;
}
window.addEventListener('hashchange', route);

// ---------- alerts (bursts of blocked network attempts) ----------
let lastAlertId = null;
async function pollAlerts() {
  let r;
  try { r = await api('GET', `/ui/alerts?since=${lastAlertId || 0}`); } catch { return; }
  const list = r.alerts || [];
  if (lastAlertId === null) { lastAlertId = list.length ? list[list.length - 1].id : 0; return; } // don't replay old ones
  for (const a of list) {
    lastAlertId = Math.max(lastAlertId, a.id);
    toast(h('span', {}, h('b', {}, 'Оповещение: '), a.text, a.hosts?.length ? h('div', { class: 'small mono' }, a.hosts.slice(0, 5).join(', ')) : null,
      h('a', { href: `#/egress?tab=log&machine=${enc(a.machine)}` }, ' Журнал →')), 'err', 30000);
  }
}

// ---------- human approvals & isolation ----------
// Requests waiting for a person (egress "Спрашивать", gateway "Подтверждать") and isolated machines.
let liveBusy = false;
async function pollLive() {
  if (liveBusy) return;
  liveBusy = true;
  try {
    const r = await api('GET', '/ui/live');
    const isoSig = JSON.stringify(Object.keys(r.isolated || {}).sort());
    const changed = isoSig !== JSON.stringify(Object.keys(state.isolated || {}).sort());
    state.isolated = r.isolated || {};
    renderApprovals(r.approvals || []);
    if (changed) { renderList(); const m = current(); if (m) updateDetailHead(m); }
  } catch {} finally { liveBusy = false; }
}

function renderApprovals(list) {
  const box = $('#approvals');
  const sig = JSON.stringify(list.map((a) => [a.id, a.waiting]));
  if (box.dataset.sig === sig) { box.querySelectorAll('[data-exp]').forEach((el) => { el.textContent = `${Math.max(0, Math.round((Number(el.dataset.exp) - Date.now()) / 1000))} с`; }); return; }
  box.dataset.sig = sig;
  const decide = async (a, decision) => {
    try { await api('POST', `/ui/approvals/${a.id}`, { decision }); } catch (e) { toast(e.message, 'err'); }
    pollLive();
  };
  box.replaceChildren(...list.map((a) => h('section', { class: `approval ${a.kind}` },
    h('div', { class: 'approval-head' }, ic(a.kind === 'net' ? 'globe' : 'key'),
      h('b', {}, a.kind === 'net' ? 'Доступ в сеть' : 'Вызов API'), h('span', { class: 'spacer' }),
      h('span', { class: 'muted small', 'data-exp': a.expiresAt }, `${Math.max(0, Math.round((a.expiresAt - Date.now()) / 1000))} с`)),
    h('div', {}, h('span', { class: 'mono' }, a.machine), a.kind === 'net' ? ' хочет подключиться к ' : ` → ${a.detail?.secret || ''}: `, h('code', {}, a.title)),
    a.kind === 'api' ? h('div', { class: 'muted small' }, `${a.detail?.upstream || ''} · правило «${a.detail?.rule || ''}»`) : null,
    a.waiting > 1 ? h('div', { class: 'muted small' }, `ждут ${a.waiting} запросов`) : null,
    h('div', { class: 'row' },
      a.kind === 'net'
        ? [h('button', { class: 'btn primary', onclick: () => decide(a, 'once') }, 'На 10 минут'), h('button', { class: 'btn', onclick: () => decide(a, 'always') }, 'Всегда')]
        : h('button', { class: 'btn primary', onclick: () => decide(a, 'once') }, 'Разрешить'),
      h('button', { class: 'btn ghost danger', onclick: () => decide(a, 'deny') }, 'Запретить')))));
  document.title = list.length ? `(${list.length}) ждёт подтверждения — smolvm web` : 'smolvm web';
}
setInterval(() => { if (!document.hidden) pollLive(); }, 2000);

$('#btn-isolate-all').addEventListener('click', async () => {
  const running = state.machines.filter((m) => m.state === 'running' && !state.isolated?.[m.name]);
  if (!running.length) return toast('Нет работающих машин');
  const c = await confirmDialog('Остановить всех агентов?', `Изолировать все работающие машины: ${running.map((m) => m.name).join(', ')}. Соединения оборвутся, токены шлюза заменятся, машины встанут на паузу.`, false, '', 'Изолировать все');
  if (!c.ok) return;
  try {
    const r = await api('POST', '/ui/isolate-all', {});
    const n = Object.keys(r.machines || {}).length;
    toast(`Изолировано машин: ${n}`, 'ok', 10000);
  } catch (e) { toast(e.message, 'err'); }
  await pollLive(); await refreshMachines();
});

// ---------- loop ----------
let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const wasHealthy = state.healthy;
    await refreshHealth();
    await refreshMachines();
    pollAlerts();
    if (state.healthy && (!wasHealthy || $('#detail').dataset.name !== (state.selected || '')) && current()) renderDetail();
  } finally { ticking = false; }
}
refreshInfo().then(tick).then(route);
pollLive();
setInterval(() => { if (!document.hidden) tick(); }, 3000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
