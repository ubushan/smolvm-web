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

function toast(msg, kind = '') {
  const t = h('div', { class: `toast ${kind}` }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), kind === 'err' ? 8000 : 4000);
}

// ---------- API ----------
class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `HTTP ${status}`);
    this.status = status; this.code = body?.code;
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
    el.innerHTML = `<span class="dot"></span><span>smolvm ${esc(hres.version)}${m ? ` · ${m.running}/${m.total} запущено` : ''}${hres.uptime_seconds != null ? ` · uptime ${fmtDuration(hres.uptime_seconds)}` : ''}</span>`;
  } catch (e) {
    state.healthy = false;
    el.className = 'health bad';
    el.innerHTML = `<span class="dot"></span><span>API недоступен</span>`;
    $('#capacity').innerHTML = '';
    return false;
  }
  try {
    const c = await api('GET', '/capacity');
    const memTotal = c.host_memory_total_mb;
    const used = c.used_memory_pss_mb ?? c.used_memory_mb;
    const cpuPct = navigator.hardwareConcurrency ? Math.min(100, (c.used_cpus / navigator.hardwareConcurrency) * 100) : null;
    $('#capacity').innerHTML = [
      stat('CPU нагрузка', `${c.used_cpus.toFixed(2)} <small>/ выделено ${c.allocated_cpus}</small>`, cpuPct),
      stat('Память (факт.)', `${fmtMb(used)} <small>/ выделено ${fmtMb(c.allocated_memory_mb)}</small>`, memTotal ? (used / memTotal) * 100 : null),
      memTotal ? stat('Память хоста', `${fmtMb(c.host_memory_available_mb)} <small>свободно из ${fmtMb(memTotal)}</small>`, ((memTotal - c.host_memory_available_mb) / memTotal) * 100) : '',
      stat('Диск машин', `${c.used_disk_gb} <small>GiB</small>`, null),
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
    const res = await api('GET', '/api/v1/machines');
    state.machines = (res.machines || []).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
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
  if (busy) return `<span class="badge busy">${esc(busy)}</span>`;
  return `<span class="badge ${esc(m.state)}">${esc(stateLabel(m.state))}</span>`;
}
function stateLabel(s) {
  return { running: 'running', stopped: 'stopped', created: 'created', paused: 'paused' }[s] || s;
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
    set(`<div class="list-empty">${state.machines.length ? 'Ничего не найдено' : 'Машин пока нет.<br><br><button class="btn primary" onclick="openCreate()">+ Создать первую</button>'}</div>`);
    return;
  }
  const html = list.map((m) => `
    <div class="machine ${m.name === state.selected ? 'active' : ''}" data-name="${esc(m.name)}">
      <div class="name">${esc(m.name)}</div>
      <div>${stateBadge(m)}</div>
      <div class="meta">${esc(m.image || '—')} · ${m.cpus} vCPU · ${fmtMb(m.memoryMb)}${m.network ? ' · net' : ''}${m.branchable ? ' · branchable' : ''}${m.parentMachine ? ` · ⑂ ${esc(m.parentMachine)}` : ''}</div>
    </div>`).join('');
  if (box.dataset.html !== html) { box.innerHTML = html; box.dataset.html = html; }
}

$('#machines').addEventListener('click', (e) => {
  const row = e.target.closest('.machine');
  if (row) select(row.dataset.name);
});
$('#filter').addEventListener('input', (e) => { state.filter = e.target.value; renderList(); });
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
    toast(`${name}: ${e.message}`, 'err');
    throw e;
  } finally {
    state.busy.delete(name);
    await refreshMachines();
    if ($('#detail').dataset.name === name && state.tab === 'overview') renderTab();
  }
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
  if (r?._webPrepared?.length) toast(`${name}: применено перед запуском — ${r._webPrepared.join('; ')}`, 'ok');
  reportDirs(name, r?._webDirs);
}

function reportDirs(name, d) {
  if (!d) return;
  for (const e of d.errors || []) toast(`${name}: директории — ${e}`, 'err');
  for (const w of d.warnings || []) toast(`${name}: ${w}`);
  if (d.users?.length) toast(`${name}: созданы пользователи ${d.users.join(', ')}`, 'ok');
  if (d.aclInstalled) toast(`${name}: установлен пакет acl`, 'ok');
}

function reportProvision(name, p, explicit) {
  if (!p) return;
  if (!p.ok) toast(`${name}: прокси/сертификаты не применены — ${p.error}`, 'err');
  else if (p.skipped) { if (explicit) toast(`${name}: прокси и сертификаты выключены — нечего применять`); }
  else toast(`${name}: настроено (${p.configured || 'ok'})`, 'ok');
}

function confirmDialog(title, text, withForce = false) {
  return new Promise((resolve) => {
    const dlg = $('#dlg-confirm');
    $('#confirm-title').textContent = title;
    $('#confirm-text').textContent = text;
    $('#confirm-force-wrap').hidden = !withForce;
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
  ['console', 'Консоль'],
  ['logs', 'Логи'],
  ['files', 'Файлы'],
  ['images', 'Образы'],
  ['egress', 'Egress'],
];

function renderDetail() {
  cleanupTab();
  const box = $('#detail');
  const m = state.machines.find((x) => x.name === state.selected);
  box.dataset.name = m ? m.name : '';
  if (!m) {
    box.innerHTML = `<div class="empty-state"><div class="big">◇</div><p>Выберите машину слева или создайте новую.</p></div>`;
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
  const sig = JSON.stringify([m.name, m.state, state.busy.get(m.name), m.branchable, m.parentMachine, state.info?.proxyActive, state.info?.caActive]);
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
    h('div', { class: 'actions' },
      stopped ? btn('▶ Старт', () => actions.start(m)) : null,
      stopped ? btn('▶ Старт (branchable)', () => actions.start(m, true), { title: 'Запустить как источник веток (нужно для branch и pause на старых версиях macOS)' }) : null,
      running ? btn('⏸ Пауза', () => actions.pause(m), { title: 'Сохранить RAM, CPU и диски и остановить' }) : null,
      paused ? btn('⏵ Возобновить', () => actions.resume(m)) : null,
      running ? btn('⑂ Ветка', () => actions.branch(m), { disabled: !m.branchable, title: m.branchable ? 'Copy-on-write клон работающей машины' : 'Машина должна быть запущена как branchable' }) : null,
      running && (state.info?.proxyActive || state.info?.caActive) ? btn('🌐 Применить прокси', () => actions.provision(m), { title: 'Записать настройки прокси и сертификаты в работающую машину' }) : null,
      running ? btn('■ Стоп', () => actions.stop(m)) : null,
      btn('Удалить', () => actions.remove(m), { cls: 'danger' }),
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
  ({ overview: tabOverview, console: tabConsole, logs: tabLogs, files: tabFiles, images: tabImages, egress: tabEgress }[state.tab] || tabOverview)(body, m);
}

function needsRunning(body, m, what) {
  if (m.state === 'running') return false;
  body.append(h('div', { class: 'notice' }, `${what} доступны только для запущенной машины. `,
    m.state !== 'paused' ? h('button', { class: 'btn', onclick: () => actions.start(m) }, '▶ Запустить') : null));
  return true;
}

// --- overview
async function tabOverview(body, m) {
  let info = m;
  try { info = await api('GET', `/api/v1/machines/${enc(m.name)}`); } catch {}
  const kv = [
    ['Состояние', stateLabel(info.state)],
    ['Образ', info.image || '—'],
    ['vCPU', info.cpus],
    ['Память', fmtMb(info.memoryMb)],
    ['RSS / PSS', info.rssMb != null ? `${fmtMb(info.rssMb)} / ${fmtMb(info.pssMb)}` : '—'],
    ['CPU время', info.cpuMillis != null ? `${(info.cpuMillis / 1000).toFixed(1)} c` : '—'],
    ['Диск (факт.)', info.diskUsedMb != null ? fmtMb(info.diskUsedMb) : '—'],
    ['Storage / Overlay', `${info.storageGb ?? 20} / ${info.overlayGb ?? 10} GiB`],
    ['Сеть', info.network ? `вкл${info.networkBackend ? ` (${info.networkBackend})` : ''}` : 'выкл'],
    ['Egress трафик', info.egressBytes != null ? fmtBytes(info.egressBytes) : '—'],
    ['PID', info.pid ?? '—'],
    ['Branchable', info.branchable ? 'да' : 'нет'],
    ['Создана', fmtAgo(info.createdAt)],
    ['GPU / CUDA', `${info.gpu ? 'GPU' : '—'} / ${info.cuda ? 'CUDA' : '—'}`],
  ];
  if (!$('#tab-body') || current()?.name !== m.name || state.tab !== 'overview') return;
  body.innerHTML = '';
  body.append(h('div', { class: 'kv' }, kv.map(([k, v]) => h('div', {}, h('div', { class: 'k' }, k), h('div', { class: 'v' }, String(v))))));

  if (info.ports?.length) {
    body.append(h('div', { class: 'section-title' }, 'Порты'));
    body.append(h('table', { class: 'tbl' },
      h('tr', {}, h('th', {}, 'Хост'), h('th', {}, 'Гость'), h('th', {}, '')),
      info.ports.map((p) => h('tr', {}, h('td', { class: 'mono' }, p.host), h('td', { class: 'mono' }, p.guest),
        h('td', {}, h('a', { href: `http://localhost:${p.host}`, target: '_blank', rel: 'noopener' }, 'открыть ↗'))))));
  }
  if (info.mounts?.length) {
    body.append(h('div', { class: 'section-title' }, 'Монтирования'));
    body.append(h('table', { class: 'tbl' },
      h('tr', {}, h('th', {}, 'Хост'), h('th', {}, 'Гость'), h('th', {}, 'Режим')),
      info.mounts.map((x) => h('tr', {}, h('td', { class: 'mono' }, x.source), h('td', { class: 'mono' }, x.target), h('td', {}, x.readonly ? 'ro' : 'rw')))));
  }
  if (info.allowedHosts || info.allowedCidrs) {
    body.append(h('div', { class: 'section-title' }, 'Политика egress'));
    body.append(h('div', { class: 'mono small' }, [...(info.allowedHosts || []), ...(info.allowedCidrs || [])].join(', ') || 'всё запрещено'));
  }
  if (state.info?.proxyActive || state.info?.caActive) {
    let mp = { useProxy: true, provisioned: null };
    try { mp = await api('GET', `/ui/machines/${enc(m.name)}`); } catch {}
    const toggle = h('input', { type: 'checkbox', checked: mp.useProxy });
    toggle.addEventListener('change', async () => {
      try {
        await api('PUT', `/ui/machines/${enc(m.name)}`, { useProxy: toggle.checked });
        toast(toggle.checked ? 'Прокси включён для машины (со следующего запуска/команды)' : 'Прокси для машины выключен', 'ok');
      } catch (e) { toast(e.message, 'err'); toggle.checked = !toggle.checked; }
    });
    body.append(h('div', { class: 'section-title' }, 'Корпоративный прокси'));
    body.append(h('div', { class: 'row' },
      h('label', { class: 'check' }, toggle, ' Использовать прокси и корпоративные сертификаты'),
      h('span', { class: 'muted small' }, mp.provisioned ? 'настройки записаны в машину' : 'в машину ещё не записаны')));
  }
  await renderMachineIsolation(body, m);
  await renderMachineSecrets(body, m);
  body.append(h('div', { class: 'section-title' }, 'JSON'));
  body.append(h('pre', { class: 'json' }, JSON.stringify(info, null, 2)));
}

// Egress filter and directories at a glance, with links to their pages.
async function renderMachineIsolation(body, m) {
  let eg = null; let dv = null;
  try { [eg, dv] = await Promise.all([api('GET', '/ui/egress'), api('GET', `/ui/machines/${enc(m.name)}/dirs`)]); } catch { return; }
  if (current()?.name !== m.name || state.tab !== 'overview') return;
  const em = eg.machines[m.name];
  const lists = (em?.lists || []).map((id) => eg.lists.find((l) => l.id === id)?.name).filter(Boolean);
  body.append(h('div', { class: 'section-title' }, 'Изоляция'));
  body.append(h('div', { class: 'iso-grid' },
    h('div', { class: 'iso' },
      h('div', {}, h('b', {}, '🌐 Интернет: '), em?.enabled
        ? h('span', { class: 'tag ok' }, em.strict ? 'только allow list (жёстко)' : 'allow list')
        : h('span', { class: 'tag warn' }, 'без фильтра smolvm-web')),
      em?.enabled ? h('div', { class: 'muted small' }, `Списки: ${lists.join(', ') || '—'}; своих правил: ${em.rules.length}`) : null,
      h('a', { href: `#/egress?machine=${enc(m.name)}`, class: 'small' }, 'Настроить allow list →')),
    h('div', { class: 'iso' },
      h('div', {}, h('b', {}, '📁 Директории: '), dv.dirs.length ? `${dv.dirs.length} (${dv.dirs.map((d) => d.guestPath).join(', ')})` : 'не подключены'),
      dv.users.length ? h('div', { class: 'muted small' }, `Пользователи: ${dv.users.map((u) => u.name).join(', ')}`) : null,
      dv.pending.add.length || dv.pending.remove.length ? h('div', { class: 'small warnc' }, 'Монтирования изменятся при следующем запуске') : null,
      h('a', { href: `#/dirs?machine=${enc(m.name)}`, class: 'small' }, 'Права пользователей →'))));
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
            h('td', { class: 'mono' }, `${isDir ? '📁' : e.kind === 'symlink' ? '🔗' : '📄'} ${e.name}`),
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
function tabImages(body, m) {
  if (needsRunning(body, m, 'Образы')) return;
  const ref = h('input', { class: 'input mono', placeholder: 'python:3.12-alpine' });
  const pull = h('button', { class: 'btn primary' }, '⇩ Pull');
  const list = h('div');
  body.append(h('div', { class: 'files-bar' }, ref, pull), list);

  async function load() {
    list.innerHTML = '<p class="muted">Загрузка…</p>';
    try {
      const { images = [] } = await api('GET', `/api/v1/machines/${enc(m.name)}/images`);
      list.innerHTML = '';
      if (!images.length) { list.append(h('p', { class: 'muted' }, 'Образов нет')); return; }
      list.append(h('table', { class: 'tbl' },
        h('tr', {}, h('th', {}, 'Образ'), h('th', {}, 'Платформа'), h('th', {}, 'Слоёв'), h('th', {}, 'Размер'), h('th', {}, 'Digest')),
        images.map((i) => h('tr', {}, h('td', { class: 'mono' }, i.reference), h('td', {}, `${i.os}/${i.architecture}`), h('td', {}, i.layerCount), h('td', {}, fmtBytes(i.size)), h('td', { class: 'mono small muted', title: i.digest }, i.digest.slice(0, 19))))));
    } catch (e) { list.innerHTML = ''; list.append(h('div', { class: 'error' }, e.message)); }
  }
  async function doPull() {
    const image = ref.value.trim();
    if (!image) return;
    pull.disabled = true; pull.textContent = 'Загрузка…';
    try {
      await api('POST', `/api/v1/machines/${enc(m.name)}/images/pull`, { image });
      toast(`Образ ${image} загружен`, 'ok');
      ref.value = '';
      load();
    } catch (e) { toast(e.message, 'err'); }
    finally { pull.disabled = false; pull.textContent = '⇩ Pull'; }
  }
  pull.addEventListener('click', doPull);
  ref.addEventListener('keydown', (e) => { if (e.key === 'Enter') doPull(); });
  load();
}

// --- egress
async function tabEgress(body, m) {
  body.append(h('p', { class: 'muted small' }, 'Исходящие соединения, заблокированные политикой egress (allowedHosts / allowedCidrs).'));
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
function openCreate() {
  const f = $('#form-create');
  $('#create-error').hidden = true;
  if (!f.name.value) f.name.placeholder = `vm-${Math.random().toString(36).slice(2, 7)}`;
  $('#create-proxy-wrap').hidden = !state.info?.proxyActive;
  fillCreateSecrets();
  fillCreateIsolation();
  $('#dlg-create').showModal();
  f.name.focus();
}
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
  const picked = [...document.querySelectorAll('#create-secrets input:checked')].map((i) => i.value);
  if (picked.length) body._webSecrets = picked;
  if (f.egressOn.checked) {
    body._webEgress = { enabled: true, strict: f.egressStrict.checked, lists: [...document.querySelectorAll('#create-egress-lists input:checked')].map((i) => i.value) };
  }
  const dirsPicked = [...document.querySelectorAll('#create-dirs input:checked')].map((i) => i.value);
  if (dirsPicked.length) body._webDirs = dirsPicked;
  return body;
}

$('#form-create').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const errBox = $('#create-error');
  errBox.hidden = true;
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
    toast(`Машина ${created.name} создана`, 'ok');
    await refreshMachines();
    select(created.name);
    if (startAfter) await actions.start(created, branchable);
  } catch (err) {
    errBox.textContent = err.message;
    errBox.hidden = false;
  } finally {
    submit.disabled = false; submit.textContent = 'Создать';
  }
});

// ---------- platform & proxy settings ----------
async function refreshInfo() {
  try { state.info = await api('GET', '/ui/info'); } catch { return; }
  const chip = $('#proxy-chip');
  const i = state.info;
  chip.hidden = false;
  if (i.proxyActive) {
    const g = i.guestProxy;
    chip.className = `chip ${g?.error ? 'warn' : 'on'}`;
    chip.textContent = `прокси: ${(g?.url || '').replace(/\/\/[^@/]*@/, '//***@').replace(/^https?:\/\//, '')}${i.caActive ? ' + CA' : ''}`;
    chip.title = g?.warning || g?.error || 'Корпоративный прокси включён';
  } else if (i.caActive) {
    chip.className = 'chip on'; chip.textContent = 'корп. сертификаты'; chip.title = '';
  } else {
    chip.className = 'chip'; chip.textContent = 'прямое подключение'; chip.title = 'Прокси не используется — нажмите, чтобы настроить';
  }
  const mounts = $('#mounts-input');
  if (mounts) mounts.placeholder = i.platform === 'win32' ? 'C:\\Users\\me\\project:/work' : '/Users/me/project:/work';
}

async function openSettings() {
  const f = $('#form-settings');
  $('#settings-error').hidden = true;
  $('#proxy-detect-out').hidden = true;
  $('#proxy-test-out').hidden = true;
  let s;
  try { s = await api('GET', '/ui/settings'); } catch (e) { toast(e.message, 'err'); return; }
  f.proxyEnabled.checked = s.proxy.enabled;
  f.proxyUrl.value = s.proxy.url;
  f.noProxy.value = s.proxy.noProxy;
  f.proxyPull.checked = s.proxy.pull;
  f.proxyExec.checked = s.proxy.exec;
  f.proxyProvision.checked = s.proxy.provision;
  f.caEnabled.checked = s.ca.enabled;
  f.caSystem.checked = s.ca.system;
  f.caPem.value = s.ca.pem;
  f.caReplace.checked = s.ca.replaceSystemBundle;
  $('#ca-system-hint').textContent = state.info?.platform === 'win32' ? '(хранилище Windows)' : state.info?.platform === 'darwin' ? '(связка ключей macOS)' : '(системный bundle)';
  syncSettingsForm();
  previewCa();
  $('#dlg-settings').showModal();
}

function syncSettingsForm() {
  const f = $('#form-settings');
  const p = f.proxyEnabled.checked;
  for (const n of ['proxyUrl', 'noProxy', 'proxyPull', 'proxyExec', 'proxyProvision']) f[n].disabled = !p;
  $('#btn-proxy-test').disabled = !f.proxyUrl.value.trim();
  const c = f.caEnabled.checked;
  for (const n of ['caSystem', 'caPem', 'caReplace']) f[n].disabled = !c;
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
      enabled: f.proxyEnabled.checked, url: f.proxyUrl.value.trim(), noProxy: f.noProxy.value.trim(),
      pull: f.proxyPull.checked, exec: f.proxyExec.checked, provision: f.proxyProvision.checked,
    },
    ca: { enabled: f.caEnabled.checked, system: f.caSystem.checked, pem: f.caPem.value.trim(), replaceSystemBundle: f.caReplace.checked },
  };
}

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
    if (d.url) {
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
    const r = await api('POST', '/ui/proxy/test', { url: f.proxyUrl.value.trim() });
    const li = (x) => `<li class="${x.ok ? 'okc' : 'badc'}">${x.ok ? '✓' : '✗'} ${esc(x.target)} — ${esc(x.status || x.error)}${x.ms != null ? ` (${x.ms} мс)` : ''}</li>`;
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
  if (s.proxy.enabled && !s.proxy.url) { err.textContent = 'Укажите адрес прокси'; err.hidden = false; return; }
  try {
    await api('PUT', '/ui/settings', s);
    $('#dlg-settings').close();
    await refreshInfo();
    toast('Настройки сохранены', 'ok');
    const m = current();
    if (m) { updateDetailHead(m); if (state.tab === 'overview') renderTab(); }
  } catch (ex) { err.textContent = ex.message; err.hidden = false; }
});

$('#btn-settings').addEventListener('click', openSettings);
$('#proxy-chip').addEventListener('click', openSettings);

// ---------- vault ----------
const MODE_LABEL = { gateway: 'шлюз', substitute: 'подстановка smolvm', env: 'переменная (видна машине)' };
const MODE_TAG = { gateway: 'ok', substitute: 'ok', env: 'bad' };
const PRESETS = {
  deepseek: { name: 'deepseek', envVar: 'DEEPSEEK_API_KEY', hosts: 'api.deepseek.com', upstream: 'https://api.deepseek.com', baseUrlVar: 'DEEPSEEK_BASE_URL' },
  openai: { name: 'openai', envVar: 'OPENAI_API_KEY', hosts: 'api.openai.com', upstream: 'https://api.openai.com/v1', baseUrlVar: 'OPENAI_BASE_URL' },
  anthropic: { name: 'anthropic', envVar: 'ANTHROPIC_API_KEY', hosts: 'api.anthropic.com', upstream: 'https://api.anthropic.com', baseUrlVar: 'ANTHROPIC_BASE_URL' },
  openrouter: { name: 'openrouter', envVar: 'OPENROUTER_API_KEY', hosts: 'openrouter.ai', upstream: 'https://openrouter.ai/api/v1', baseUrlVar: 'OPENROUTER_BASE_URL' },
  gemini: { name: 'gemini', envVar: 'GEMINI_API_KEY', hosts: 'generativelanguage.googleapis.com', upstream: 'https://generativelanguage.googleapis.com', baseUrlVar: 'GOOGLE_GEMINI_BASE_URL' },
  github: { name: 'github', envVar: 'GITHUB_TOKEN', hosts: 'api.github.com', upstream: 'https://api.github.com', baseUrlVar: 'GITHUB_API_URL' },
};
let vaultCache = [];

async function loadVault() {
  const v = await api('GET', '/ui/vault');
  vaultCache = v.secrets || [];
  return v;
}

async function openVault() {
  $('#form-secret').hidden = true;
  $('#dlg-vault').showModal();
  await renderVault();
}

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
      h('td', { class: 'mono' }, x.name, x.note ? h('div', { class: 'muted small' }, x.note) : null),
      h('td', {}, h('span', { class: `tag ${MODE_TAG[x.mode]}` }, MODE_LABEL[x.mode])),
      h('td', { class: 'mono small' }, x.envVar, x.baseUrlVar ? h('div', { class: 'muted' }, x.baseUrlVar) : null),
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
    f.upstream.value = x.upstream; f.hosts.value = x.hosts.join(', '); f.methods.value = x.methods.join(', '); f.note.value = x.note;
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

$('#btn-vault').addEventListener('click', openVault);
$('#btn-secret-add').addEventListener('click', () => editSecret(null));
$('#btn-secret-cancel').addEventListener('click', () => { $('#form-secret').hidden = true; });
$('#form-secret').addEventListener('change', (e) => {
  const f = e.currentTarget;
  if (e.target.name === 'preset' && PRESETS[f.preset.value]) {
    const p = PRESETS[f.preset.value];
    for (const k of ['name', 'envVar', 'hosts', 'upstream', 'baseUrlVar']) f[k].value = p[k];
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
    upstream: f.upstream.value.trim(), hosts: csv(f.hosts.value), methods: csv(f.methods.value),
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
  let eg = { lists: [], defaults: {} }; let dd = { dirs: [] };
  try { [eg, dd] = await Promise.all([api('GET', '/ui/egress'), api('GET', '/ui/dirs')]); } catch {}
  f.egressOn.checked = !!eg.defaults?.enabled;
  f.egressStrict.checked = !!eg.defaults?.strict;
  syncCreateEgress();
  $('#create-egress-lists').replaceChildren(...eg.lists.map((l) => h('label', { class: 'check' },
    h('input', { type: 'checkbox', value: l.id, checked: l.default }), ` ${l.name} `, h('span', { class: 'muted small' }, `(${l.rules.length})`))));
  $('#create-dirs-wrap').hidden = !dd.dirs.length;
  $('#create-dirs').replaceChildren(...dd.dirs.map((d) => h('label', { class: 'check', title: d.hostPath },
    h('input', { type: 'checkbox', value: d.id }), ` ${d.id} → ${d.guestPath} `, h('span', { class: `tag ${d.ceiling === 'rw' ? 'warn' : 'ok'}` }, d.ceiling))));
}
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
      ` ${x.name} `, h('span', { class: `tag ${MODE_TAG[x.mode]}` }, MODE_LABEL[x.mode])));
  }
}

async function renderMachineSecrets(body, m) {
  let info;
  try { info = await api('GET', `/ui/machines/${enc(m.name)}`); await loadVault(); } catch { return; }
  if (!info.secrets.length && !vaultCache.length) return;
  body.append(h('div', { class: 'section-title' }, 'Секреты'));
  if (info.secrets.length) {
    body.append(h('table', { class: 'tbl' },
      h('tr', {}, h('th', {}, 'Секрет'), h('th', {}, 'Режим'), h('th', {}, 'В машине'), h('th', {}, '')),
      info.secrets.map((x) => h('tr', {},
        h('td', { class: 'mono' }, x.name),
        h('td', {}, h('span', { class: `tag ${MODE_TAG[x.mode]}` }, MODE_LABEL[x.mode])),
        h('td', { class: 'mono small' }, `$${x.envVar}`, x.baseUrlVar ? `, $${x.baseUrlVar}` : ''),
        h('td', {}, x.mode !== 'substitute' ? h('button', { class: 'btn ghost', onclick: () => changeSecrets(m, [], [x.name]) }, 'Отвязать') : h('span', { class: 'muted small' }, 'задан при создании'))))));
  } else body.append(h('p', { class: 'muted small' }, 'К машине не привязано секретов.'));
  const avail = vaultCache.filter((x) => x.mode !== 'substitute' && !info.secrets.some((b) => b.name === x.name));
  if (avail.length) {
    const sel = h('select', { class: 'input small' }, avail.map((x) => h('option', { value: x.name }, `${x.name} (${MODE_LABEL[x.mode]})`)));
    body.append(h('div', { class: 'row' }, sel, h('button', { class: 'btn', onclick: () => changeSecrets(m, [sel.value], []) }, '+ Привязать')));
  }
  if (info.secrets.some((x) => x.mode === 'gateway')) {
    body.append(h('p', { class: 'muted small' }, 'Для шлюза машина должна быть запущена через smolvm-web (перезапустите её после привязки). Пример для OpenAI-совместимого SDK: base_url = $DEEPSEEK_BASE_URL, api_key = $DEEPSEEK_API_KEY.'));
  }
}

async function changeSecrets(m, add, remove) {
  try {
    await api('PUT', `/ui/machines/${enc(m.name)}/secrets`, { add, remove });
    toast(add.length ? `Секрет привязан к ${m.name}` : `Секрет отвязан от ${m.name}`, 'ok');
  } catch (e) { toast(e.message, 'err'); }
  if (state.tab === 'overview') renderTab();
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
  return { page: (m && m[1]) || 'machines', params: new URLSearchParams((m && m[2]) || '') };
}
function route() {
  const { page, params } = routeParams();
  const id = pages[page] ? page : 'machines';
  if (pageCleanup) { try { pageCleanup(); } catch {} pageCleanup = null; }
  state.page = id;
  $('#page-machines').hidden = id !== 'machines';
  $('#capacity').hidden = id !== 'machines';
  for (const k of Object.keys(pages)) $(`#page-${k}`).hidden = k !== id;
  document.querySelectorAll('#pagenav a').forEach((a) => a.classList.toggle('active', a.dataset.page === id));
  if (id !== 'machines') pageCleanup = pages[id].render($(`#page-${id}`), params) || null;
}
window.addEventListener('hashchange', route);

// ---------- loop ----------
let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const wasHealthy = state.healthy;
    await refreshHealth();
    await refreshMachines();
    if (state.healthy && (!wasHealthy || $('#detail').dataset.name !== (state.selected || '')) && current()) renderDetail();
  } finally { ticking = false; }
}
refreshInfo().then(tick).then(route);
setInterval(() => { if (!document.hidden) tick(); }, 3000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
