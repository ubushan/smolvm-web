'use strict';
// Windows host checks for smolvm's agent rootfs.
//
// The Windows release ships the agent rootfs as a tarball that smolvm extracts
// on first use into %LOCALAPPDATA%\smolvm\rootfs\<key>\. Without the right to
// create symlinks (Developer Mode or an elevated session) tar drops the busybox
// symlinks, /sbin/init among them, yet smolvm still marks the extraction
// complete (.extracted). Every boot then fails with
// "Couldn't execute '/sbin/init': ENOENT" / "boot process exited (code 127)",
// and keeps failing after the right is granted, because the broken extraction
// is reused. Repair = delete the broken extraction once symlinks work.

const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';
const SYMLINK_FIX = 'включите «Режим разработчика» (Параметры → Система → Для разработчиков), или пусть администратор выдаст вашей учётной записи право «Создание символических ссылок», или один раз запустите smolvm от администратора (см. документацию)';
const BOOT_ERROR_RE = /sbin\/init'?:? ?ENOENT|boot process exited \(code 127\)/i;

function rootfsCache() {
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'smolvm', 'rootfs');
}

// Can this process create a file symlink? true / false / null (unknown).
function symlinkCapable() {
  if (!IS_WIN) return true;
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smolvm-web-ln-'));
    const target = path.join(dir, 't');
    fs.writeFileSync(target, '');
    fs.symlinkSync(target, path.join(dir, 'l'), 'file');
    return true;
  } catch (e) {
    return e.code === 'EPERM' ? false : null;
  } finally {
    if (dir) try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

// Complete extractions with /sbin/init in place: once one exists, smolvm runs
// without the symlink right (until a smolvm update needs a new extraction).
function readyRootfs() {
  if (!IS_WIN) return [];
  const base = rootfsCache();
  let names = [];
  try { names = fs.readdirSync(base); } catch { return []; }
  return names.filter((n) => {
    if (n.startsWith('.')) return false;
    try { return fs.existsSync(path.join(base, n, '.extracted')) && !!fs.lstatSync(path.join(base, n, 'sbin', 'init')); } catch { return false; }
  }).map((n) => path.join(base, n));
}

// Extractions smolvm considers complete but whose /sbin/init symlink is missing.
function brokenRootfs() {
  if (!IS_WIN) return [];
  const base = rootfsCache();
  let names = [];
  try { names = fs.readdirSync(base); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (n.startsWith('.')) continue;
    const dir = path.join(base, n);
    try {
      if (!fs.statSync(dir).isDirectory() || !fs.existsSync(path.join(dir, '.extracted'))) continue;
      fs.lstatSync(path.join(dir, 'sbin', 'init'));
    } catch (e) {
      if (e.code === 'ENOENT') out.push(dir);
    }
  }
  return out;
}

function status() {
  if (!IS_WIN) return { windows: false };
  return { windows: true, symlinks: symlinkCapable(), broken: brokenRootfs(), ready: readyRootfs().length > 0, cache: rootfsCache() };
}

function repair() {
  if (!IS_WIN) return { removed: [] };
  if (symlinkCapable() === false) {
    const e = new Error(`У smolvm-web нет права создавать символические ссылки: ${SYMLINK_FIX}, затем повторите. Иначе rootfs снова распакуется без ссылок.`);
    e.status = 409;
    throw e;
  }
  const removed = [];
  for (const dir of brokenRootfs()) {
    // Only directories inside smolvm's rootfs cache, and only broken ones.
    if (path.dirname(dir) !== rootfsCache()) continue;
    fs.rmSync(dir, { recursive: true, force: true });
    removed.push(dir);
  }
  return { removed };
}

// A human explanation for the boot failure, or null if it is something else.
function explainBootError(message) {
  if (!IS_WIN || !BOOT_ERROR_RE.test(String(message || ''))) return null;
  const st = status();
  const steps = [];
  if (st.symlinks === false) steps.push(`${SYMLINK_FIX} и перезапустите smolvm-web`);
  steps.push(st.broken.length ? 'нажмите «Починить» — испорченная распаковка rootfs будет удалена, smolvm распакует её заново' : `удалите папку ${st.cache} — smolvm распакует rootfs заново`);
  steps.push('запустите машину снова');
  return {
    code: 'ROOTFS_BROKEN',
    hint: `Агентский rootfs smolvm распакован без символических ссылок (нет /sbin/init) — так бывает на Windows без права на symlink. Что сделать: ${steps.map((s, i) => `${i + 1}) ${s}`).join('; ')}.`,
    repairable: st.broken.length > 0,
  };
}

module.exports = { IS_WIN, SYMLINK_FIX, status, repair, explainBootError, symlinkCapable, brokenRootfs, rootfsCache };
