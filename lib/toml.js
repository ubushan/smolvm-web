'use strict';
// A small, strict TOML parser (no dependencies) — enough for Smolfiles:
// tables, arrays of tables, dotted and quoted keys, basic/literal/multi-line
// strings, integers, floats, booleans, arrays and inline tables. Dates are
// not supported. Errors carry the line number.

function parse(src) {
  const text = String(src).replace(/\r\n?/g, '\n');
  let i = 0;
  let line = 1;
  const root = {};
  let cur = root;
  const defined = new Set(); // table paths defined with [header]

  const fail = (msg) => { throw new Error(`строка ${line}: ${msg}`); };
  const peek = (n = 0) => text[i + n];
  const eof = () => i >= text.length;
  const next = () => { const c = text[i++]; if (c === '\n') line++; return c; };
  const ws = () => { while (!eof() && (peek() === ' ' || peek() === '\t')) i++; };
  const comment = () => { if (peek() === '#') while (!eof() && peek() !== '\n') i++; };
  const wsNl = () => { for (;;) { ws(); comment(); if (peek() === '\n') next(); else break; } };
  const eol = () => { ws(); comment(); if (!eof() && peek() !== '\n') fail(`лишние символы: «${text.slice(i, i + 20).split('\n')[0]}»`); };

  function bareKey() {
    const m = /^[A-Za-z0-9_-]+/.exec(text.slice(i));
    if (!m) fail('ожидается ключ');
    i += m[0].length;
    return m[0];
  }
  function key() {
    const parts = [];
    for (;;) {
      ws();
      if (peek() === '"') parts.push(basicString());
      else if (peek() === "'") parts.push(literalString());
      else parts.push(bareKey());
      ws();
      if (peek() === '.') { i++; continue; }
      return parts;
    }
  }

  function basicString() {
    if (text.startsWith('"""', i)) {
      i += 3;
      if (peek() === '\n') next();
      let out = '';
      for (;;) {
        if (eof()) fail('незакрытая строка """');
        if (text.startsWith('"""', i)) {
          i += 3;
          while (peek() === '"') { out += '"'; i++; } // up to two quotes before the end
          return out;
        }
        const c = next();
        if (c === '\\') {
          if (peek() === '\n' || peek() === ' ' || peek() === '\t') { // line-ending backslash
            while (!eof() && /\s/.test(peek())) next();
            continue;
          }
          out += escape();
        } else out += c;
      }
    }
    i++;
    let out = '';
    for (;;) {
      if (eof() || peek() === '\n') fail('незакрытая строка');
      const c = next();
      if (c === '"') return out;
      out += c === '\\' ? escape() : c;
    }
  }
  function escape() {
    const c = next();
    const map = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
    if (c in map) return map[c];
    if (c === 'u' || c === 'U') {
      const n = c === 'u' ? 4 : 8;
      const hex = text.slice(i, i + n);
      if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== n) fail('неверная \\u-последовательность');
      i += n;
      return String.fromCodePoint(parseInt(hex, 16));
    }
    return fail(`неизвестная escape-последовательность \\${c}`);
  }
  function literalString() {
    if (text.startsWith("'''", i)) {
      i += 3;
      if (peek() === '\n') next();
      const end = text.indexOf("'''", i);
      if (end < 0) fail("незакрытая строка '''");
      let out = text.slice(i, end);
      for (const ch of out) if (ch === '\n') line++;
      i = end + 3;
      while (peek() === "'") { out += "'"; i++; }
      return out;
    }
    i++;
    const end = text.indexOf("'", i);
    const nl = text.indexOf('\n', i);
    if (end < 0 || (nl >= 0 && nl < end)) fail('незакрытая строка');
    const out = text.slice(i, end);
    i = end + 1;
    return out;
  }

  function value() {
    ws();
    const c = peek();
    if (c === '"') return basicString();
    if (c === "'") return literalString();
    if (c === '[') return array();
    if (c === '{') return inlineTable();
    if (text.startsWith('true', i) && !/[A-Za-z0-9_-]/.test(text[i + 4] || '')) { i += 4; return true; }
    if (text.startsWith('false', i) && !/[A-Za-z0-9_-]/.test(text[i + 5] || '')) { i += 5; return false; }
    const m = /^[+-]?(0x[0-9a-fA-F_]+|0o[0-7_]+|0b[01_]+|inf|nan|[0-9_]+(\.[0-9_]+)?([eE][+-]?[0-9_]+)?)/.exec(text.slice(i));
    if (!m) fail(`неожиданное значение: «${text.slice(i, i + 20).split('\n')[0]}»`);
    i += m[0].length;
    if (/^\d{4}-\d{2}-\d{2}/.test(text.slice(i - m[0].length, i + 6))) fail('даты не поддерживаются');
    const raw = m[0].replace(/_/g, '');
    if (/^[+-]?(inf|nan)$/.test(raw)) return raw.includes('nan') ? NaN : (raw[0] === '-' ? -Infinity : Infinity);
    if (/^[+-]?0x/.test(raw)) return parseInt(raw.replace('0x', ''), 16) * (raw[0] === '-' ? -1 : 1);
    if (/^[+-]?0o/.test(raw)) return parseInt(raw.replace(/^[+-]?0o/, ''), 8);
    if (/^[+-]?0b/.test(raw)) return parseInt(raw.replace(/^[+-]?0b/, ''), 2);
    return Number(raw);
  }
  function array() {
    i++;
    const out = [];
    for (;;) {
      wsNl();
      if (peek() === ']') { i++; return out; }
      out.push(value());
      wsNl();
      if (peek() === ',') { i++; continue; }
      wsNl();
      if (peek() === ']') { i++; return out; }
      fail('в массиве ожидается «,» или «]»');
    }
  }
  function inlineTable() {
    i++;
    const out = {};
    ws();
    if (peek() === '}') { i++; return out; }
    for (;;) {
      const k = key();
      ws();
      if (next() !== '=') fail('ожидается «=»');
      assign(out, k, value());
      ws();
      if (peek() === ',') { i++; continue; }
      if (peek() === '}') { i++; return out; }
      fail('во встроенной таблице ожидается «,» или «}»');
    }
  }

  function assign(obj, parts, val) {
    let o = obj;
    for (const p of parts.slice(0, -1)) {
      if (o[p] === undefined) o[p] = {};
      else if (typeof o[p] !== 'object' || Array.isArray(o[p])) fail(`ключ «${p}» уже задан значением`);
      o = o[p];
    }
    const last = parts[parts.length - 1];
    if (Object.prototype.hasOwnProperty.call(o, last)) fail(`ключ «${parts.join('.')}» задан дважды`);
    o[last] = val;
  }
  function tableAt(parts, isArray) {
    let o = root;
    parts.forEach((p, idx) => {
      const lastPart = idx === parts.length - 1;
      if (lastPart && isArray) {
        if (o[p] === undefined) o[p] = [];
        if (!Array.isArray(o[p])) fail(`«${parts.join('.')}» уже не массив таблиц`);
        const t = {};
        o[p].push(t);
        o = t;
        return;
      }
      if (o[p] === undefined) o[p] = {};
      if (Array.isArray(o[p])) o = o[p][o[p].length - 1];
      else if (typeof o[p] === 'object') o = o[p];
      else fail(`«${p}» уже задан значением`);
    });
    if (!isArray) {
      const path = parts.join('.');
      if (defined.has(path)) fail(`таблица [${path}] задана дважды`);
      defined.add(path);
    }
    return o;
  }

  for (;;) {
    wsNl();
    if (eof()) break;
    if (peek() === '[') {
      const isArray = peek(1) === '[';
      i += isArray ? 2 : 1;
      const parts = key();
      ws();
      if (isArray ? !text.startsWith(']]', i) : peek() !== ']') fail('ожидается «]»');
      i += isArray ? 2 : 1;
      cur = tableAt(parts, isArray);
      eol();
      continue;
    }
    const k = key();
    ws();
    if (next() !== '=') fail('ожидается «=»');
    assign(cur, k, value());
    eol();
  }
  return root;
}

module.exports = { parse };
