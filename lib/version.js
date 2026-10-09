'use strict';
// Which code is this? The git commit of the checkout (read from .git directly,
// no git binary needed), else the package version for an `npm pack` copy.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PKG_VERSION = require('../package.json').version;

function gitDir() {
  const dot = path.join(ROOT, '.git');
  try {
    if (fs.statSync(dot).isDirectory()) return dot;
    // Worktree / submodule: ".git" is a file "gitdir: <path>".
    const m = fs.readFileSync(dot, 'utf8').match(/^gitdir:\s*(.+)$/m);
    if (m) return path.resolve(ROOT, m[1].trim());
  } catch {}
  return null;
}

function readRef(dir, ref) {
  try { return fs.readFileSync(path.join(dir, ref), 'utf8').trim(); } catch {}
  // Packed refs (after git gc); a worktree keeps them in the common dir.
  const dirs = [dir];
  try { dirs.push(path.resolve(dir, fs.readFileSync(path.join(dir, 'commondir'), 'utf8').trim())); } catch {}
  for (const d of dirs) {
    try { fs.statSync(path.join(d, ref)); return fs.readFileSync(path.join(d, ref), 'utf8').trim(); } catch {}
    try {
      const line = fs.readFileSync(path.join(d, 'packed-refs'), 'utf8').split('\n').find((l) => l.endsWith(` ${ref}`));
      if (line) return line.split(' ')[0];
    } catch {}
  }
  return null;
}

// Ask git itself (reftable repositories, unusual layouts); quietly null without git.
// Cached briefly: /ui/info asks on every page refresh.
let cliCache = { at: 0, value: null };
function fromGitCli() {
  if (Date.now() - cliCache.at < 30000) return cliCache.value;
  cliCache = { at: Date.now(), value: gitCliOnce() };
  return cliCache.value;
}

function gitCliOnce() {
  try {
    const run = (args) => execFileSync('git', ['-C', ROOT, ...args], { timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const commit = run(['rev-parse', 'HEAD']);
    let branch = null;
    try { branch = run(['rev-parse', '--abbrev-ref', 'HEAD']); } catch {}
    return /^[0-9a-f]{40}$/.test(commit) ? { commit, branch: branch && branch !== 'HEAD' ? branch : null } : null;
  } catch { return null; }
}

// { version, commit, branch } as on disk right now.
function current() {
  const out = { version: PKG_VERSION, commit: null, branch: null };
  const dir = gitDir();
  if (!dir) return out;
  try { readHead(dir, out); } catch {}
  if (!out.commit) { const g = fromGitCli(); if (g) Object.assign(out, g); }
  return out;
}

function readHead(dir, out) {
  try {
    const head = fs.readFileSync(path.join(dir, 'HEAD'), 'utf8').trim();
    const m = head.match(/^ref:\s*(.+)$/);
    const sha = m ? readRef(dir, m[1]) : head;
    if (sha && /^[0-9a-f]{40}$/.test(sha)) out.commit = sha;
    if (m) out.branch = m[1].replace(/^refs\/heads\//, '');
  } catch {}
  return out;
}

// What this process was started from.
const RUNNING = current();

module.exports = { RUNNING, current };
