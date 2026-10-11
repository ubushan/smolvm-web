'use strict';
// «Дать доступ к папке»: one dialog for every place a host folder is given to a
// machine (page «Директории», the overview, the create dialog, sandboxes), and
// the folder rows with a plain status: works / restart needed / why not.

const FOLDER_MODES = {
  ro: { title: 'Только чтение', tag: 'ok', short: 'только чтение',
    desc: 'Агент видит файлы, но не может их менять. Запрет обеспечивает этот компьютер, а не машина.' },
  review: { title: 'Рабочая копия с ревью', tag: 'accent', short: 'рабочая копия', rec: true,
    desc: 'Агент правит копию папки в машине. На компьютер попадает только то, что вы примете после просмотра diff.' },
  rw: { title: 'Чтение и запись', tag: 'warn', short: 'чтение и запись',
    desc: 'Агент меняет файлы на компьютере напрямую, без проверки. Используйте только для папок, которые не жалко.' },
};

const folderBase = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'folder';
const guestDefault = (p) => `/work/${folderBase(p).replace(/[^A-Za-z0-9._@+-]/g, '_')}`;

// «Выбрать…»: walk the folders of this computer, one level at a time. Resolves the chosen path or null.
function pickFolder(start) {
  return new Promise((resolve) => {
    let cur = String(start || '').trim();
    let picked = null;
    const pathEl = h('div', { class: 'mono small fp-path' });
    const list = h('div', { class: 'fp-list' });
    const up = h('button', { type: 'button', class: 'btn small-btn', title: 'На уровень выше' }, '↑ Выше');
    const choose = h('button', { type: 'button', class: 'btn primary' }, 'Выбрать эту папку');
    const dlg = h('dialog', { class: 'dialog fp-dialog' },
      h('header', {}, h('h3', { class: 'h-ic' }, ic('folder'), 'Выбор папки'),
        h('button', { type: 'button', class: 'btn ghost icon', title: 'Закрыть', 'aria-label': 'Закрыть', onclick: () => dlg.close() }, ic('x'))),
      h('div', { class: 'dialog-body' }, h('div', { class: 'row' }, up, pathEl), list),
      h('footer', {}, h('button', { type: 'button', class: 'btn ghost', onclick: () => dlg.close() }, 'Отмена'), choose));
    const sep = state.info?.platform === 'win32' ? '\\' : '/';
    const parent = (p) => { const x = p.replace(/[\\/]+$/, ''); const i = Math.max(x.lastIndexOf('/'), x.lastIndexOf('\\')); return i > 0 ? x.slice(0, i) : i === 0 ? '/' : x; };
    async function open(dir) {
      list.replaceChildren(h('p', { class: 'muted small' }, 'Загрузка…'));
      let r;
      try { r = await api('GET', `/ui/folders/suggest?all=1&q=${enc(dir ? (/[\\/]$/.test(dir) ? dir : dir + sep) : '')}`); } catch (e) { list.replaceChildren(h('div', { class: 'error' }, e.message)); return; }
      // An empty q starts at the home folder: take it from the first child.
      if (!dir) dir = r.paths.length ? parent(r.paths[0]) : (state.info?.home || '/');
      cur = dir.replace(/[\\/]+$/, '') || '/';
      pathEl.textContent = cur;
      list.replaceChildren(...(r.paths.length ? r.paths.map((p) => h('button', { type: 'button', class: 'fp-item', onclick: () => open(p) },
        ic('folder'), h('span', {}, p.split(/[\\/]/).pop()))) : [h('p', { class: 'muted small' }, 'Вложенных папок нет.')]));
    }
    up.addEventListener('click', () => open(parent(cur)));
    choose.addEventListener('click', () => { picked = cur; dlg.close(); });
    dlg.addEventListener('close', () => { dlg.remove(); resolve(picked); });
    document.body.append(dlg);
    dlg.showModal();
    open(cur && cur.replace(/^~/, state.info?.home || '~'));
  });
}

// opts: { machine, hostPath, mode, onDone(result), sandbox }
// sandbox: the folder goes to the agent's sandboxes — copies only (smolvm cannot attach a
// folder to a machine restored from a template), «Только чтение» is a copy never written back.
function openFolderDialog(opts = {}) {
  const dlg = h('dialog', { class: 'dialog folder-dialog' });
  const close = () => { dlg.close(); dlg.remove(); };
  let check = null;
  let existing = []; // folders of the chosen machine
  let guestTouched = false;

  const pathIn = h('input', { class: 'input mono', placeholder: state.info?.platform === 'win32' ? 'C:\\Users\\me\\projects\\app' : '/Users/me/projects/app', autocomplete: 'off', spellcheck: false, list: 'folder-suggest' });
  const suggest = h('datalist', { id: 'folder-suggest' });
  const pathNote = h('div', { class: 'small muted' }, 'Начните вводить путь — появятся подсказки.');
  const machines = opts.fixedMachine ? [] : state.machines.filter((m) => !state.marks?.[m.name]?.sandbox || m.name === opts.machine);
  const machineSel = opts.fixedMachine ? null : h('select', { class: 'input' }, machines.map((m) => h('option', { value: m.name, selected: m.name === opts.machine }, `${m.name}${m.state === 'running' ? '' : ` (${m.state})`}`)));
  const guestIn = h('input', { class: 'input mono', placeholder: '/work/app', spellcheck: false });
  const where = h('div', { class: 'folder-where small' });
  const err = h('div', { class: 'error', hidden: true });
  const submit = h('button', { type: 'submit', class: 'btn primary' }, ic('folder'), 'Дать доступ');

  let mode = opts.mode || 'ro';
  const modeBox = h('div', { class: 'mode-cards' });
  const drawModes = () => {
    modeBox.replaceChildren(...Object.entries(FOLDER_MODES).filter(([id]) => !opts.sandbox || id !== 'rw').map(([id, x]) => {
      const warn = id === 'rw' && check?.ok && check.agentCanWrite === false
        ? h('div', { class: 'small warnc' }, 'Папка принадлежит root — агент не сможет в неё писать. Выберите рабочую копию.')
        : id === 'rw' && check?.ok && check.owner > 0 && check.owner !== 1000
          ? h('div', { class: 'small muted' }, `Пользователь агента в машине получит uid ${check.owner} (владелец папки): иначе компьютер не даст ему писать. Новые файлы будут вашими.`)
        : id === 'rw' && check?.ok && check.maxLevel === 'ro' ? h('div', { class: 'small warnc' }, 'Строгий режим разрешает эту папку только для чтения.') : null;
      const r = h('input', { type: 'radio', name: 'folder-mode', value: id, checked: id === mode, disabled: id === 'rw' && check?.ok && check.maxLevel === 'ro' });
      r.addEventListener('change', () => { mode = id; drawModes(); });
      const desc = opts.sandbox && id === 'ro' ? 'Агент получает копию папки и может её читать; на компьютер из неё ничего не записывается.' : x.desc;
      return h('label', { class: `mode-card ${id === mode ? 'sel' : ''}` }, r,
        h('div', {}, h('div', { class: 'mode-title' }, x.title, x.rec ? h('span', { class: 'tag ok' }, 'для кода') : null),
          h('div', { class: 'small muted' }, desc), opts.sandbox ? null : warn));
    }));
    drawWhere();
  };
  const drawWhere = () => {
    const g = guestIn.value.trim() || guestIn.placeholder;
    where.replaceChildren(ic('terminal'), h('span', {}, 'Агент найдёт папку здесь: '), h('code', {}, g),
      h('button', { type: 'button', class: 'btn ghost icon', title: 'Скопировать путь', onclick: () => { navigator.clipboard?.writeText(g); toast('Путь скопирован', 'ok'); } }, ic('file')));
  };

  let tCheck = null; let tSuggest = null;
  const runCheck = async () => {
    const p = pathIn.value.trim();
    if (!p) { check = null; pathNote.className = 'small muted'; pathNote.textContent = 'Начните вводить путь — появятся подсказки.'; drawModes(); return; }
    try { check = await api('GET', `/ui/folders/check?path=${enc(p)}`); } catch (e) { check = { ok: false, error: e.message }; }
    if (pathIn.value.trim() !== p) return;
    if (check.ok) {
      pathNote.className = 'small okc';
      pathNote.textContent = `✓ ${check.real}`;
      if (!guestTouched) { guestIn.value = guestDefault(check.real); }
    } else {
      pathNote.className = 'small badc';
      pathNote.textContent = check.error;
    }
    drawModes();
  };
  pathIn.addEventListener('input', () => {
    clearTimeout(tCheck); clearTimeout(tSuggest);
    tCheck = setTimeout(runCheck, 300);
    tSuggest = setTimeout(async () => {
      try {
        const r = await api('GET', `/ui/folders/suggest?q=${enc(pathIn.value)}`);
        suggest.replaceChildren(...r.paths.map((p) => h('option', { value: p })));
      } catch {}
    }, 150);
  });
  pathIn.addEventListener('focus', () => { if (!pathIn.value) pathIn.dispatchEvent(new Event('input')); });
  guestIn.addEventListener('input', () => { guestTouched = true; drawWhere(); });

  const machineName = () => opts.fixedMachine || machineSel?.value;
  const loadExisting = async () => {
    existing = [];
    if (!machineName() || opts.fixedMachine === '__new') return;
    try { existing = (await api('GET', `/ui/machines/${enc(machineName())}/folders`)).folders; } catch {}
  };
  machineSel?.addEventListener('change', loadExisting);

  const form = h('form', { method: 'dialog' },
    h('header', {}, h('h3', { class: 'h-ic' }, ic('folder'), 'Дать доступ к папке'),
      h('button', { type: 'button', class: 'btn ghost icon', title: 'Закрыть', onclick: close }, ic('x'))),
    h('div', { class: 'dialog-body' },
      h('label', {}, 'Папка на этом компьютере', h('div', { class: 'row fp-row' }, pathIn,
        h('button', { type: 'button', class: 'btn', onclick: async () => {
          const p = await pickFolder(pathIn.value.trim());
          if (p) { pathIn.value = p; runCheck(); }
        } }, ic('folder'), 'Выбрать…')), suggest, pathNote),
      opts.sandbox ? h('div', { class: 'small muted' }, 'В песочнице агент всегда работает с копией: прямой доступ («Чтение и запись») к копии из шаблона smolvm не подключает.') : null,
      machineSel ? h('label', {}, 'Машина', machineSel) : null,
      h('div', {}, h('div', { class: 'label-like' }, 'Как агент работает с папкой'), modeBox),
      opts.sandbox ? null : h('details', { class: 'tech' }, h('summary', {}, 'Путь в машине'),
        h('label', {}, 'Где папка будет в машине', guestIn),
        h('p', { class: 'muted small' }, 'По умолчанию — /work/<имя папки>: рабочая папка агентов.')),
      where, err),
    h('footer', {}, h('button', { type: 'button', class: 'btn ghost', onclick: close }, 'Отмена'), submit));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    if (!check) await runCheck();
    if (!check?.ok) { err.textContent = check?.error || 'Укажите папку'; err.hidden = false; return; }
    const body = { hostPath: check.real, mode, guestPath: guestIn.value.trim() || undefined };
    // Create dialog: just hand the choice back.
    if (opts.fixedMachine === '__new') { close(); opts.onDone?.(body); return; }
    const name = machineName();
    if (!name) { err.textContent = 'Выберите машину'; err.hidden = false; return; }
    const prev = existing.find((f) => f.kind === 'review' && f.hostPath === check.real);
    if (prev && mode !== 'review' && !(await confirmDialog('Убрать рабочую копию?', `Для ${check.real} в машине есть рабочая копия. Она будет удалена вместе с непримененными изменениями, вместо неё агент получит саму папку.`, false, '', 'Продолжить')).ok) return;
    submit.disabled = true; submit.replaceChildren(h('i', { class: 'spin' }), 'Подключение…');
    try {
      const r = await api('POST', `/ui/machines/${enc(name)}/folders`, body);
      reportDirs(name, r.report);
      close();
      const m = state.machines.find((x) => x.name === name);
      if (r.needsRestart && m) {
        const c = await confirmDialog('Нужен перезапуск машины', `Новую папку smolvm подключает только при запуске машины. Перезапустить ${name} сейчас? Запущенные в ней агенты остановятся.`, false, '', 'Перезапустить');
        if (c.ok) await actions.restart(m);
        else toast(`Папка подключится при следующем запуске ${name}`, 'ok', 8000);
      } else if (r.state !== 'running') toast(`Готово: папка подключится при запуске ${name} — ${r.guestPath}`, 'ok', 8000);
      else toast(`Готово: агент найдёт папку в ${r.guestPath}`, 'ok', 8000);
      opts.onDone?.(r);
    } catch (e2) {
      err.textContent = e2.message; err.hidden = false;
      submit.disabled = false; submit.replaceChildren(ic('folder'), 'Дать доступ');
    }
  });

  dlg.append(form);
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  if (opts.hostPath) pathIn.value = opts.hostPath;
  drawModes();
  loadExisting();
  dlg.showModal();
  if (opts.hostPath) runCheck(); else pathIn.focus();
}

// The status of one folder, from the machine state and the access check.
function folderStatus(f, data, verify) {
  if (f.kind === 'volume') return { cls: '', text: 'задан при создании', hint: 'Том smolvm: подключён как есть, без проверки доступа агента. Изменить — только пересозданием машины.' };
  if (f.kind === 'review') {
    if (f.state === 'error') return { cls: 'bad', text: 'ошибка копирования', hint: f.error };
    if (f.state === 'pending') return { cls: '', text: 'скопируется при запуске' };
    return { cls: 'ok', text: 'копия готова', review: true };
  }
  if (f.removed) return { cls: 'warn', text: 'отключится при перезапуске', restart: data.state === 'running' };
  if (f.missing) return { cls: 'bad', text: 'папка удалена из списка разрешённых' };
  if (data.state !== 'running') return { cls: '', text: f.pendingRestart ? 'подключится при запуске' : 'машина остановлена' };
  if (f.pendingRestart) return { cls: 'warn', text: 'нужен перезапуск', restart: true };
  if (!verify) return { cls: '', text: 'проверка…' };
  if (verify.error) return { cls: 'bad', text: 'не проверено', hint: verify.error };
  const rows = verify.rows.filter((r) => r.dir === f.id);
  const row = rows.find((r) => r.agent) || rows.find((r) => r.user === '*');
  if (!row) return { cls: '', text: '—' };
  if (row.ok) return { cls: 'ok', text: '✓ работает' };
  return { cls: 'bad', text: row.actual ? `агенту доступно: ${FOLDER_MODES[row.actual]?.short || 'ничего'}` : 'ошибка', hint: row.error || row.hint || 'права не совпадают — нажмите «Применить права заново» в расширенных настройках' };
}

// A list of the machine's folders with statuses and actions. Returns the element; it fills itself.
// opts: { compact, onChange }
function folderList(m, opts = {}) {
  const box = h('div', { class: `folder-list${opts.compact ? ' compact' : ''}` }, h('p', { class: 'muted small' }, 'Загрузка…'));
  const draw = async () => {
    let data;
    try { data = await api('GET', `/ui/machines/${enc(m.name)}/folders`); } catch (e) { box.replaceChildren(h('div', { class: 'error' }, e.message)); return; }
    const live = data.folders.filter((f) => !f.removed || data.state === 'running');
    let verify = null;
    const render = () => {
      if (!live.length) { box.replaceChildren(h('p', { class: 'muted small folder-empty' }, 'Агенту не открыто ни одной папки компьютера.')); return; }
      box.replaceChildren(...live.map((f) => folderRow(m, f, data, verify, { compact: opts.compact, refresh: () => { draw(); opts.onChange?.(); } })));
    };
    render();
    if (data.state === 'running' && live.some((f) => f.kind === 'dir' && !f.pendingRestart && !f.removed)) {
      try { verify = await api('POST', `/ui/machines/${enc(m.name)}/dirs/verify`, {}); } catch (e) { verify = { error: e.message }; }
      if (box.isConnected) render();
    }
  };
  draw();
  box.refresh = draw;
  return box;
}

function folderRow(m, f, data, verify, { compact, refresh }) {
  const st = folderStatus(f, data, verify);
  const base = FOLDER_MODES[f.kind === 'review' ? 'review' : f.level] || { short: 'нет доступа', tag: '' };
  const mode = f.kind === 'volume' ? { ...base, short: `том smolvm · ${f.level === 'ro' ? 'чтение' : 'запись'}`, tag: '' } : base;
  const change = async (to) => {
    if (to === (f.kind === 'review' ? 'review' : f.level)) return;
    if (f.kind === 'review' && !(await confirmDialog('Убрать рабочую копию?', `Копия ${f.guestPath} будет удалена вместе с непримененными изменениями, вместо неё агент получит саму папку.`, false, '', 'Продолжить')).ok) return;
    openFolderDialog({ machine: m.name, hostPath: f.hostPath, mode: to, onDone: refresh });
  };
  const remove = async () => {
    const what = f.kind === 'review' ? `Рабочая копия ${f.guestPath} перестанет отслеживаться (сама копия останется в машине).` : `Агент потеряет доступ к ${f.hostPath}. Папка на компьютере не затрагивается${data.state === 'running' ? '; монтирование уберётся при перезапуске машины' : ''}.`;
    if (!(await confirmDialog('Закрыть доступ к папке?', what, false, '', 'Закрыть доступ')).ok) return;
    try { await api('DELETE', `/ui/machines/${enc(m.name)}/folders/${f.kind}/${enc(f.id)}`); toast('Доступ закрыт', 'ok'); } catch (e) { toast(e.message, 'err'); }
    refresh();
  };
  const menu = h('select', { class: 'input small folder-mode-sel', title: 'Изменить режим доступа' },
    Object.entries(FOLDER_MODES).map(([id, x]) => h('option', { value: id, selected: id === (f.kind === 'review' ? 'review' : f.level) }, x.short)));
  menu.addEventListener('change', () => { const to = menu.value; menu.value = f.kind === 'review' ? 'review' : f.level; change(to); });
  const statusEl = h('span', { class: `tag ${st.cls}`, title: st.hint || '' }, st.text);
  const hostText = f.hostPath ? `\u200e${f.hostPath.replace(state.info?.home || '\u0000', '~')}\u200e` : f.id;
  if (compact) {
    // Two lines: the folder, then where it is and how it works.
    return h('div', { class: 'folder-row' },
      h('div', { class: 'folder-main' },
        h('div', { class: 'mono ellipsis path-tail small', title: f.hostPath || '' }, hostText),
        h('div', { class: 'folder-meta' },
          h('span', { class: 'mono small' }, f.guestPath ? `→ ${f.guestPath}` : '→ отключается'),
          f.removed ? null : h('span', { class: `tag ${mode.tag}` }, mode.short), statusEl,
          st.restart ? h('button', { class: 'btn small-btn', onclick: async () => { await actions.restart(m); refresh(); } }, 'Перезапустить') : null,
          st.review ? h('a', { class: 'small', href: `#/?machine=${enc(m.name)}&tab=folders` }, 'изменения →') : null)));
  }
  return h('div', { class: 'folder-row' },
    h('span', { class: 'mark m-icon' }, ic('folder')),
    h('div', { class: 'folder-main' },
      h('div', { class: 'mono ellipsis path-tail', title: f.hostPath || '' }, hostText),
      h('div', { class: 'small muted mono' }, f.guestPath ? `→ ${f.guestPath}` : '→ отключается'),
      st.hint && !compact ? h('div', { class: 'small badc' }, st.hint) : null),
    f.removed ? null : compact || f.kind === 'volume' ? h('span', { class: `tag ${mode.tag}` }, mode.short) : menu,
    statusEl,
    st.restart ? h('button', { class: 'btn small-btn', onclick: async () => { await actions.restart(m); refresh(); } }, ic('refresh'), 'Перезапустить') : null,
    st.review ? h('a', { class: 'btn small-btn ghost', href: `#/?machine=${enc(m.name)}&tab=folders` }, 'Изменения →') : null,
    compact || f.removed || f.kind === 'volume' ? null : h('button', { class: 'btn ghost icon danger', title: 'Закрыть доступ', onclick: remove }, ic('x')));
}
