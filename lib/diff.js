'use strict';
// Line diff (Myers) -> unified hunks. Small and dependency-free.

function myers(a, b) {
  const n = a.length; const m = b.length; const max = n + m;
  const v = new Map([[1, 0]]);
  const trace = [];
  for (let d = 0; d <= max; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1))) ? (v.get(k + 1) ?? 0) : (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v.set(k, x);
      if (x >= n && y >= m) return backtrack(trace, a, b, d);
    }
  }
  return [];
}

function backtrack(trace, a, b, dEnd) {
  const ops = [];
  let x = a.length; let y = b.length;
  for (let d = dEnd; d >= 0; d--) {
    const v = trace[d];
    const k = x - y;
    const prevK = (k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1))) ? k + 1 : k - 1;
    const prevX = v.get(prevK) ?? 0; const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push([' ', a[x - 1]]); x--; y--; }
    if (d > 0) { if (x === prevX) { ops.push(['+', b[y - 1]]); y--; } else { ops.push(['-', a[x - 1]]); x--; } }
  }
  return ops.reverse();
}

// Unified diff text with `context` lines around changes.
function unified(oldText, newText, { context = 3, maxLines = 20000 } = {}) {
  const a = oldText === '' ? [] : oldText.replace(/\n$/, '').split('\n');
  const b = newText === '' ? [] : newText.replace(/\n$/, '').split('\n');
  if (a.length + b.length > maxLines) return { tooBig: true, hunks: [] };
  const ops = myers(a, b);
  const hunks = [];
  let i = 0; let oa = 1; let ob = 1;
  while (i < ops.length) {
    if (ops[i][0] === ' ') { i++; oa++; ob++; continue; }
    // start of a change: back up `context` lines
    let s = i; let sa = oa; let sb = ob;
    for (let c = 0; c < context && s > 0 && ops[s - 1][0] === ' '; c++) { s--; sa--; sb--; }
    let e = i; let lastChange = i;
    while (e < ops.length) {
      if (ops[e][0] !== ' ') lastChange = e;
      else if (e - lastChange > context * 2) break;
      e++;
    }
    const end = Math.min(ops.length, lastChange + context + 1);
    const lines = ops.slice(s, end);
    const la = lines.filter((l) => l[0] !== '+').length;
    const lb = lines.filter((l) => l[0] !== '-').length;
    hunks.push({ header: `@@ -${sa},${la} +${sb},${lb} @@`, lines: lines.map(([t, l]) => t + l) });
    for (let j = i; j < end; j++) { if (ops[j][0] !== '+') oa++; if (ops[j][0] !== '-') ob++; }
    i = end;
  }
  const added = ops.filter((o) => o[0] === '+').length;
  const removed = ops.filter((o) => o[0] === '-').length;
  return { tooBig: false, hunks, added, removed };
}

const isBinary = (buf) => buf.subarray(0, 8000).includes(0);

module.exports = { unified, isBinary };
