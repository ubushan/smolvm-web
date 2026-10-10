'use strict';
// Audit log: who did what to which machine, when, and with what result.
//
// Sources (wired in server.js): every mutating API/UI call, exec commands with
// their exit codes, agent launches, review apply/reject, and file changes in
// host folders mounted read-write into a running machine (fs.watch; it cannot
// tell whether the machine or someone on the host wrote — the event names the
// machines that have write access).
//
// Storage: audit.log (JSON lines, rotated) + an in-memory ring for the UI.
// Tamper evidence: every record carries `prev` (the previous record's hash) and
// `hash` = HMAC-SHA256(key, prev + record). The key lives in audit.key, apart
// from the log; editing, deleting or inserting a line breaks the chain, which
// verify() reports (and SIEM keeps its own copy of the hashes).
// Export: syslog (RFC 5424 over UDP/TCP, JSON message) and/or HTTP POST of
// JSON batches. Alerts: a burst of blocked network attempts per machine.

const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const https = require('https');
const dgram = require('dgram');
const crypto = require('crypto');
const cfg = require('./config');

const FILE = `${cfg.DIR}/audit.log`;
const FILE_MAX = 10 * 1024 * 1024;
const RING_MAX = 5000;
const store = cfg.doc('audit.json', {
  siem: {
    syslog: { enabled: false, host: '', port: 514, proto: 'udp', facility: 16 },
    http: { enabled: false, url: '', authorization: '' },
    net: 'deny', // which network decisions to forward: none | deny | all
  },
  alerts: { enabled: true, threshold: 20, windowSec: 60, cooldownSec: 300, webhook: '' },
});

const ring = [];
const alertRing = [];
let seq = 0;
let alertSeq = 0;

const SEV = { emerg: 0, alert: 1, crit: 2, error: 3, warning: 4, notice: 5, info: 6, debug: 7 };

function settings() { return store.get(); }
function saveSettings(next) {
  const cur = store.get();
  const merged = {
    siem: {
      syslog: { ...cur.siem.syslog, ...(next.siem?.syslog || {}) },
      http: { ...cur.siem.http, ...(next.siem?.http || {}) },
      net: ['none', 'deny', 'all'].includes(next.siem?.net) ? next.siem.net : cur.siem.net,
    },
    alerts: { ...cur.alerts, ...(next.alerts || {}) },
  };
  const sl = merged.siem.syslog;
  sl.port = Number(sl.port) || 514;
  sl.proto = sl.proto === 'tcp' ? 'tcp' : 'udp';
  sl.facility = Math.min(23, Math.max(0, Number(sl.facility) || 16));
  const a = merged.alerts;
  a.threshold = Math.max(1, Number(a.threshold) || 20);
  a.windowSec = Math.max(5, Number(a.windowSec) || 60);
  a.cooldownSec = Math.max(0, Number(a.cooldownSec) || 300);
  if (merged.siem.http.url && !/^https?:\/\//.test(merged.siem.http.url)) throw new Error('URL для SIEM должен начинаться с http:// или https://');
  if (a.webhook && !/^https?:\/\//.test(a.webhook)) throw new Error('URL веб-хука должен начинаться с http:// или https://');
  store.save(merged);
  resetSyslog();
  return merged;
}

// ---------- hash chain ----------
const KEY_FILE = `${cfg.DIR}/audit.key`;
let chainKey = null;
let lastHash = '';

function key() {
  if (chainKey) return chainKey;
  try { chainKey = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex'); } catch {}
  if (!chainKey || chainKey.length < 32) {
    chainKey = crypto.randomBytes(32);
    fs.mkdirSync(cfg.DIR, { recursive: true });
    fs.writeFileSync(KEY_FILE, chainKey.toString('hex'), { mode: 0o600 });
  }
  return chainKey;
}

// The record as signed: everything but `hash`, in its own key order.
function digest(e) {
  const { hash, ...rest } = e;
  return crypto.createHmac('sha256', key()).update(`${rest.prev || ''}\n${JSON.stringify(rest)}`).digest('hex');
}

// Walk the log (rotated part first) and check every link.
function verify() {
  const files = [`${FILE}.1`, FILE].filter((f) => fs.existsSync(f));
  let prev = null; let total = 0; let signed = 0; let unsigned = 0;
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      total++;
      let e;
      try { e = JSON.parse(lines[i]); } catch { return { ok: false, total, signed, unsigned, broken: { file: f, line: i + 1, reason: 'строка повреждена (не JSON)' } }; }
      if (!e.hash) {
        // Records written before signing was introduced: only allowed before the first signed one.
        if (signed) return { ok: false, total, signed, unsigned, broken: { file: f, line: i + 1, id: e.id, reason: 'запись без подписи посреди подписанных — вставлена или изменена' } };
        unsigned++;
        continue;
      }
      if (digest(e) !== e.hash) return { ok: false, total, signed, unsigned, broken: { file: f, line: i + 1, id: e.id, ts: e.ts, reason: 'подпись не совпадает — запись изменена' } };
      if (prev !== null && e.prev !== prev) return { ok: false, total, signed, unsigned, broken: { file: f, line: i + 1, id: e.id, ts: e.ts, reason: 'разрыв цепочки — перед этой записью удалены или вставлены записи' } };
      prev = e.hash;
      signed++;
    }
  }
  // The tail cut off: the last record this process wrote is no longer at the end.
  if (lastHash && prev !== lastHash) return { ok: false, total, signed, unsigned, broken: { file: FILE, line: total, reason: 'в конце журнала не хватает записей — их удалили' } };
  return { ok: true, total, signed, unsigned, lastHash: prev, files };
}

// ---------- record ----------
function record(ev) {
  const e = { id: ++seq, ts: new Date().toISOString(), severity: 'info', ...ev };
  e.prev = lastHash;
  e.hash = digest(e);
  lastHash = e.hash;
  ring.push(e);
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
  try {
    try { if (fs.statSync(FILE).size > FILE_MAX) fs.renameSync(FILE, `${FILE}.1`); } catch {}
    fs.appendFileSync(FILE, `${JSON.stringify(e)}\n`, { mode: 0o600 });
  } catch {}
  forward(e);
  return e;
}

function list({ machine, type, q, limit = 500 } = {}) {
  const needle = q ? String(q).toLowerCase() : '';
  const out = [];
  for (let i = ring.length - 1; i >= 0 && out.length < limit; i--) {
    const e = ring[i];
    if (machine && e.machine !== machine) continue;
    if (type && e.type !== type) continue;
    if (needle && !JSON.stringify(e).toLowerCase().includes(needle)) continue;
    out.push(e);
  }
  return out;
}

// Load the tail of the file on start, so the UI is not empty after a restart.
function loadTail() {
  try {
    const data = fs.readFileSync(FILE, 'utf8').trim().split('\n').slice(-RING_MAX);
    for (const line of data) { try { const e = JSON.parse(line); ring.push(e); seq = Math.max(seq, e.id || 0); if (e.hash) lastHash = e.hash; } catch {} }
  } catch {}
}

// ---------- SIEM ----------
let udp = null;
let tcp = null;
let tcpQueue = [];
function resetSyslog() {
  try { udp?.close(); } catch {}
  try { tcp?.destroy(); } catch {}
  udp = null; tcp = null; tcpQueue = [];
}

function syslogLine(e) {
  const s = settings().siem.syslog;
  const pri = s.facility * 8 + (SEV[e.severity] ?? 6);
  const msg = JSON.stringify(e);
  return `<${pri}>1 ${e.ts} ${os.hostname()} smolvm-web ${process.pid} ${e.type || '-'} - ${msg}`;
}

function sendSyslog(line) {
  const s = settings().siem.syslog;
  if (s.proto === 'udp') {
    if (!udp) { udp = dgram.createSocket('udp4'); udp.on('error', () => {}); udp.unref(); }
    udp.send(Buffer.from(line), s.port, s.host, () => {});
    return;
  }
  // TCP: newline-delimited (non-transparent framing), reconnect on demand.
  if (!tcp || tcp.destroyed) {
    tcp = net.connect(s.port, s.host);
    tcp.setKeepAlive(true);
    tcp.on('connect', () => { for (const l of tcpQueue.splice(0)) tcp.write(`${l}\n`); });
    tcp.on('error', () => { tcp = null; });
    tcp.on('close', () => { tcp = null; });
  }
  if (tcp.connecting) { if (tcpQueue.length < 1000) tcpQueue.push(line); } else tcp.write(`${line}\n`);
}

let httpBatch = [];
let httpTimer = null;
function sendHttp(e) {
  httpBatch.push(e);
  if (httpBatch.length >= 200) flushHttp();
  else if (!httpTimer) httpTimer = setTimeout(flushHttp, 2000);
}
function flushHttp() {
  clearTimeout(httpTimer); httpTimer = null;
  const batch = httpBatch.splice(0);
  if (!batch.length) return;
  const h = settings().siem.http;
  postJson(h.url, batch, h.authorization).catch(() => {});
}

function postJson(url, body, authorization) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error('неверный URL')); }
    const payload = Buffer.from(JSON.stringify(body));
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method: 'POST', timeout: 10000, headers: { 'content-type': 'application/json', 'content-length': payload.length, ...(authorization ? { authorization } : {}) } }, (res) => {
      res.resume();
      res.on('end', () => (res.statusCode < 300 ? resolve(res.statusCode) : reject(new Error(`HTTP ${res.statusCode}`))));
    });
    req.on('timeout', () => req.destroy(new Error('таймаут')));
    req.on('error', reject);
    req.end(payload);
  });
}

function forward(e) {
  const s = settings().siem;
  if (s.syslog.enabled && s.syslog.host) { try { sendSyslog(syslogLine(e)); } catch {} }
  if (s.http.enabled && s.http.url) sendHttp(e);
}

async function test() {
  const e = { id: 0, ts: new Date().toISOString(), type: 'test', action: 'проверка экспорта из smolvm-web', severity: 'notice' };
  const out = {};
  const s = settings().siem;
  if (s.syslog.enabled && s.syslog.host) { try { sendSyslog(syslogLine(e)); out.syslog = `отправлено на ${s.syslog.proto}://${s.syslog.host}:${s.syslog.port}`; } catch (err) { out.syslog = err.message; } }
  if (s.http.enabled && s.http.url) { try { out.http = `HTTP ${await postJson(s.http.url, [e], s.http.authorization)}`; } catch (err) { out.http = `ошибка: ${err.message}`; } }
  if (!Object.keys(out).length) out.none = 'экспорт выключен';
  return out;
}

// ---------- network events + alerts ----------
const denials = new Map(); // machine -> [ts...]
const lastAlert = new Map();

function onNet(entry) {
  if (!entry.machine) return;
  const mode = settings().siem.net;
  if (mode === 'all' || (mode === 'deny' && !entry.allow)) {
    forward({ id: 0, ts: new Date(entry.ts).toISOString(), type: 'net', machine: entry.machine, severity: entry.allow ? 'info' : 'notice',
      action: entry.allow ? 'разрешено' : 'заблокировано', detail: { method: entry.method, host: entry.host, port: entry.port, rule: entry.rule, reason: entry.reason, learned: entry.learned || undefined } });
  }
  if (entry.allow) return;
  const a = settings().alerts;
  if (!a.enabled) return;
  const now = Date.now();
  const arr = (denials.get(entry.machine) || []).filter((t) => now - t < a.windowSec * 1000);
  arr.push(now);
  denials.set(entry.machine, arr);
  if (arr.length >= a.threshold && now - (lastAlert.get(entry.machine) || 0) > a.cooldownSec * 1000) {
    lastAlert.set(entry.machine, now);
    const hosts = [...new Set(require('./egress').log({ machine: entry.machine, decision: 'deny', limit: 200 }).map((x) => `${x.host}:${x.port}`))].slice(0, 10);
    raise({ machine: entry.machine, count: arr.length, windowSec: a.windowSec, hosts });
  }
}

function raise({ machine, count, windowSec, hosts }) {
  const n = count % 100; const n1 = count % 10;
  const word = n1 === 1 && n !== 11 ? 'попытка' : n1 >= 2 && n1 <= 4 && (n < 10 || n >= 20) ? 'попытки' : 'попыток';
  const text = `Всплеск заблокированных соединений: машина ${machine} — ${count} ${word} за ${windowSec} с`;
  const al = { id: ++alertSeq, ts: new Date().toISOString(), machine, count, windowSec, hosts, text };
  alertRing.push(al);
  if (alertRing.length > 200) alertRing.shift();
  record({ type: 'alert', machine, severity: 'warning', action: text, detail: { hosts } });
  const hook = settings().alerts.webhook;
  if (hook) postJson(hook, { text, ...al }).catch(() => {});
}

// A plain notice for the UI's alert stream (limits, kill switch), also logged and sent to the webhook.
function notify({ machine, text, severity = 'warning', detail = {} }) {
  const al = { id: ++alertSeq, ts: new Date().toISOString(), machine, text };
  alertRing.push(al);
  if (alertRing.length > 200) alertRing.shift();
  record({ type: 'alert', machine, severity, action: text, detail });
  const hook = settings().alerts.webhook;
  if (hook) postJson(hook, { text, ...al }).catch(() => {});
}

// ---------- file changes in rw folders ----------
const watchers = new Map(); // host path -> { w, machines:Set }
const fsPending = new Map(); // key -> timer

function syncWatches(rwMounts) {
  // rwMounts: [{ source, machine }]
  const want = new Map();
  for (const m of rwMounts) {
    if (!want.has(m.source)) want.set(m.source, new Set());
    want.get(m.source).add(m.machine);
  }
  for (const [p, x] of watchers) if (!want.has(p)) { try { x.w.close(); } catch {} watchers.delete(p); }
  for (const [p, machines] of want) {
    const cur = watchers.get(p);
    if (cur) { cur.machines = machines; continue; }
    try {
      const w = fs.watch(p, { recursive: true }, (event, filename) => {
        if (!filename) return;
        const rel = String(filename);
        if (/(^|[\\/])(\.git|node_modules)([\\/]|$)/.test(rel)) return; // noisy internals
        const key = `${p}\n${rel}`;
        clearTimeout(fsPending.get(key));
        fsPending.set(key, setTimeout(() => {
          fsPending.delete(key);
          const exists = fs.existsSync(`${p}/${rel}`);
          const ms = [...(watchers.get(p)?.machines || [])];
          record({ type: 'fs', machine: ms.length === 1 ? ms[0] : null, severity: 'info',
            action: exists ? 'файл изменён' : 'файл удалён', detail: { root: p, path: rel, machines: ms } });
        }, 1000));
      });
      w.on('error', () => { watchers.delete(p); });
      watchers.set(p, { w, machines });
    } catch {}
  }
}

loadTail();

module.exports = {
  record, list, settings, saveSettings, test, onNet, syncWatches, verify, notify,
  alerts: (since = 0) => alertRing.filter((a) => a.id > since),
  watched: () => [...watchers].map(([p, x]) => ({ path: p, machines: [...x.machines] })),
  file: FILE,
};
