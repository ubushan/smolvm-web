'use strict';
// Page «Проверка изменений» (#/review?id=…): what the agent wants to keep in
// its profile after a sandbox closed. One card per change, a diff on the right;
// executable configuration (skills, hooks, MCP, settings) is never preselected.

(() => {
  let root = null;
  let list = [];        // pending summaries
  let cur = null;       // the shown one
  let shown = '';       // path in the diff view
  const sel = new Set();
  const suspicious = new Set(); // paths whose diff has flagged lines

  const risky = (p) => /claude-mcp\.json$|settings\.json$|opencode\.json$|config\.toml$|config\.yaml$|\/(skills|hooks|agents|commands|plugin|extensions)\//.test(p);
  const showPath = (p) => (p === '.smolvm-profile/claude-mcp.json' ? '~/.claude.json → mcpServers' : `~/${p}`);
  const ago = (ms) => fmtAgo(Math.floor(ms / 1000));
  // A change as a person would name it.
  function title(c) {
    const verb = { added: 'Новый', modified: 'Изменён', deleted: 'Удалён' }[c.kind];
    const sk = c.path.match(/(?:^|\/)skills\/([^/]+)/);
    if (sk) return `${{ added: 'Новый skill', modified: 'Изменён skill', deleted: 'Удалён skill' }[c.kind]} «${sk[1]}»`;
    if (/(?:^|\/)(memory|memories)\//.test(c.path)) return `Память: ${{ added: 'новая запись', modified: 'запись изменена', deleted: 'запись удалена' }[c.kind]}`;
    if (c.path === '.smolvm-profile/claude-mcp.json' || /opencode\.json$|\.codex\/config\.toml$/.test(c.path)) return `MCP-серверы и настройки: ${{ added: 'добавлены', modified: 'изменены', deleted: 'удалены' }[c.kind]}`;
    if (/\/hooks\//.test(c.path)) return `${verb} хук ${c.path.split('/').pop()}`;
    const base = c.path.split('/').pop();
    return `${base} ${{ added: 'добавлен', modified: 'изменён', deleted: 'удалён' }[c.kind]}`;
  }

  // Added lines that deserve a second look: secrets of this computer, piping the
  // internet into a shell, sending files out, disabling checks, prompt injection.
  const SUSPICIOUS = [
    [/~\/\.ssh|\.ssh\/|id_(rsa|ed25519|ecdsa)|authorized_keys/i, 'ключи SSH'],
    [/~\/\.(aws|kube|docker|gnupg|netrc|npmrc|pypirc)|\.git-credentials|\.env\b/i, 'файлы с учётными данными'],
    [/\b(curl|wget)\b[^|\n]*\|\s*(ba|z)?sh\b|\bbash\s+<\(\s*curl/i, 'скачать и выполнить скрипт'],
    [/\b(scp|rsync|sftp|nc|ncat|socat)\b.+[\w.-]+\.[a-z]{2,}|curl\b.*(-d|--data|-F|--upload-file|-T)\b/i, 'отправка данных наружу'],
    [/\b(printenv|env)\b\s*($|[|>])|\$\{?[A-Z_]*(KEY|TOKEN|SECRET|PASSWORD)[A-Z_]*\}?/, 'переменные окружения с ключами'],
    [/base64\s+(-d|--decode)|\beval\b\s*[("$`]|\bexec\s*\(/i, 'скрытое выполнение кода'],
    [/--no-verify|--dangerously|skip[-_ ]?permissions|chmod\s+777|sudo\s/i, 'обход проверок и прав'],
    [/ignore (all |the )?(previous|prior|above) instructions|игнорируй (все )?(предыдущие|прошлые) инструкции|do not (tell|mention|show) the user|не сообщай пользователю/i, 'похоже на prompt injection'],
  ];
  const suspicion = (line) => SUSPICIOUS.find(([re]) => re.test(line))?.[1] || null;

  async function load(id) {
    const data = await api('GET', '/ui/sandbox');
    list = data.pending;
    cur = list.find((x) => x.id === id) || list[0] || null;
    sel.clear();
    if (cur) for (const c of cur.changes) if (!(risky(c.path) && c.kind !== 'deleted')) sel.add(c.path);
    shown = cur ? (cur.changes.find((c) => risky(c.path) && c.kind !== 'deleted') || cur.changes[0])?.path || '' : '';
  }

  async function act(op) {
    const paths = op === 'drop-all' ? [] : [...sel];
    try {
      if (op === 'apply') {
        if (!paths.length) { toast('Отметьте, что сохранить', 'err'); return; }
        const r = await api('POST', `/ui/sandbox/pending/${enc(cur.id)}/apply`, { paths });
        // One decision: what is not checked is rejected, not left for later.
        if (r.left) await api('DELETE', `/ui/sandbox/pending/${enc(cur.id)}`);
        toast(`Сохранено в профиль: ${r.applied.length}${cur.changes.length > paths.length ? `, отклонено: ${cur.changes.length - paths.length}` : ''}`, 'ok');
      } else {
        if (!(await confirmDialog('Отклонить все изменения?', 'Профиль останется как был.', false, '', 'Отклонить всё')).ok) return;
        await api('DELETE', `/ui/sandbox/pending/${enc(cur.id)}`);
        toast('Изменения отклонены', 'ok');
      }
    } catch (e) { toast(e.message, 'err'); return; }
    await load('');
    if (!cur) { location.hash = '#/work'; return; }
    render();
  }

  async function showDiff(box, path) {
    shown = path;
    root.querySelectorAll('.rv-item').forEach((y) => y.classList.toggle('active', y.dataset.path === path));
    const c = cur.changes.find((x) => x.path === path);
    box.replaceChildren(h('p', { class: 'muted small rv-pad' }, 'Загрузка…'));
    let df;
    try { df = await api('GET', `/ui/sandbox/pending/${enc(cur.id)}/diff?path=${enc(path)}`); } catch (e) { box.replaceChildren(h('div', { class: 'error' }, e.message)); return; }
    const head = h('div', { class: 'rv-diff-head' }, h('b', { class: 'mono' }, showPath(path)), h('span', { class: 'spacer' }),
      h('span', { class: `ss-pill ${c.kind === 'deleted' ? 'bad' : c.kind === 'added' ? 'ok' : 'warn'}` }, { added: 'новый файл', modified: `${fmtBytes(df.oldSize)} → ${fmtBytes(df.newSize)}`, deleted: 'удалён' }[c.kind]));
    if (df.binary || df.tooBig) { box.replaceChildren(head, h('p', { class: 'muted rv-pad' }, df.binary ? 'Бинарный файл — построчный diff не показывается.' : 'Файл слишком большой для diff.')); return; }
    const pre = h('pre', { class: 'diff rv-pre' });
    const flagged = [];
    for (const hk of df.hunks) {
      pre.append(h('span', { class: 'd-h' }, `${hk.header}\n`));
      let n = Number((hk.header.match(/\+(\d+)/) || [])[1] || 1);
      for (const l of hk.lines) {
        const why = l[0] === '+' ? suspicion(l.slice(1)) : null;
        if (why) flagged.push(`строка ${n}: ${why}`);
        pre.append(h('span', { class: why ? 'd-a d-sus' : l[0] === '+' ? 'd-a' : l[0] === '-' ? 'd-r' : 'd-c', title: why || '' }, `${l}${why ? `   ← ${why}` : ''}\n`));
        if (l[0] !== '-') n += 1;
      }
    }
    if (flagged.length) suspicious.add(path); else suspicious.delete(path);
    const alarm = flagged.length ? h('div', { class: 'rv-alarm' }, h('b', {}, 'Подозрительно: '), `${flagged.join('; ')}. Это может быть prompt injection — сохранять не рекомендуется.`) : null;
    const warn = risky(path) && c.kind !== 'deleted'
      ? h('div', { class: 'rv-warn' }, 'Исполняемая настройка: она будет работать в каждой следующей песочнице этого профиля. Сохраняйте, только если понимаете, что она делает.') : null;
    box.replaceChildren(head, alarm, pre, warn);
    root.querySelector(`.rv-item[data-path="${CSS.escape(path)}"]`)?.classList.toggle('sus', flagged.length > 0);
  }

  function render() {
    if (!root) return;
    if (!cur) {
      fill(root, h('section', { class: 'card ws-empty' }, ic('list'), h('h3', {}, 'Проверять нечего'),
        h('p', { class: 'muted' }, 'Когда вы закроете песочницу с профилем, изменения агента появятся здесь.'),
        h('a', { class: 'btn primary', href: '#/work' }, 'К рабочим местам')));
      return;
    }
    if (location.hash !== `#/review?id=${enc(cur.id)}`) history.replaceState(null, '', `#/review?id=${enc(cur.id)}`);
    const n = cur.changes.length;
    const saveBtn = h('button', { class: 'btn primary', onclick: () => act('apply') });
    const updateSave = () => { saveBtn.textContent = `Сохранить выбранное (${sel.size})`; saveBtn.disabled = !sel.size; };
    updateSave();
    const diffBox = h('div', { class: 'rv-diff' });
    const items = cur.changes.map((c) => {
      const danger = risky(c.path) && c.kind !== 'deleted';
      const cb = h('input', { type: 'checkbox', checked: sel.has(c.path), 'aria-label': `Сохранить: ${title(c)}` });
      cb.addEventListener('change', () => { if (cb.checked) sel.add(c.path); else sel.delete(c.path); updateSave(); });
      return h('div', { class: `rv-item${danger ? ' danger' : ''}${c.path === shown ? ' active' : ''}`, 'data-path': c.path, onclick: (e) => { if (e.target !== cb) showDiff(diffBox, c.path); } },
        cb,
        h('div', { class: 'rv-item-text' },
          h('b', {}, title(c)),
          h('span', { class: 'mono small muted ellipsis', title: showPath(c.path) }, showPath(c.path)),
          danger ? h('span', { class: 'small warnc' }, 'Исполняемая настройка — будет запускаться в каждой песочнице') : null));
    });
    fill(root,
      h('div', { class: 'ws-head' },
        h('div', { class: 'ws-head-text' },
          h('h1', {}, 'Что агент хочет сохранить'),
          h('p', { class: 'muted' }, `Профиль «${cur.profileName}» · песочница закрыта ${ago(cur.at)} · ${n} ${n === 1 ? 'изменение' : n < 5 ? 'изменения' : 'изменений'}`)),
        h('button', { class: 'btn', onclick: () => act('drop-all') }, 'Отклонить всё'),
        saveBtn),
      list.length > 1 ? h('div', { class: 'rv-tabs' }, ...list.map((x) => h('a', { class: `ws-chip${x.id === cur.id ? ' on' : ''}`, href: `#/review?id=${enc(x.id)}` }, `${x.profileName} · ${x.changes.length}`))) : null,
      cur.skipped.length ? h('div', { class: 'ws-notice' }, `Не забраны (слишком большие): ${cur.skipped.join(', ')}`) : null,
      h('div', { class: 'rv-body' }, h('div', { class: 'rv-list' }, ...items, h('p', { class: 'muted small' }, 'Неотмеченное будет отклонено. Skills, хуки и MCP заранее не отмечены.')), diffBox));
    if (shown) showDiff(diffBox, shown);
  }

  pages.review = {
    render(el, p) {
      root = el;
      fill(el, h('p', { class: 'muted' }, 'Загрузка…'));
      load(p.get('id') || '').then(render).catch((e) => fill(el, h('div', { class: 'error' }, e.message)));
      return () => { root = null; };
    },
  };
})();
