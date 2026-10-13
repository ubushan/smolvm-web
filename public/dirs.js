'use strict';
// «Директории» (⚙ → «Директории», #/dirs): which host folders may be given to machines (the mode and
// the list), and per machine what it got and what the agent changed in review copies —
// the list on the left, the chosen one on the right.
// (Per-user access inside a machine is API-only: PUT /ui/machines/:name/dirs.)

(() => {
  const LEVEL = { none: 'нет доступа', ro: 'чтение', rw: 'чтение и запись' };
  const LEVEL_TAG = { none: '', ro: 'ok', rw: 'warn' };
  let reg = null;        // GET /ui/dirs
  let root = null;
  let params = null;

  async function load() { reg = await api('GET', '/ui/dirs'); }

  function card(title, ...children) {
    return h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, title)), ...children);
  }

  // ---------- registry ----------
  function dirForm(d) {
    const f = h('form', { class: 'dir-form', autocomplete: 'off' },
      h('div', { class: 'grid-dir' },
        h('label', {}, 'Имя', h('input', { class: 'input mono', name: 'id', value: d?.id || '', required: true, pattern: '[a-z0-9][a-z0-9_\\-]{0,31}', readonly: !!d, placeholder: 'project' })),
        h('label', {}, 'Путь на хосте', h('input', { class: 'input mono', name: 'hostPath', value: d?.hostPath || '', required: true, placeholder: state.info?.platform === 'win32' ? 'C:\\Users\\me\\projects\\app' : '/Users/me/projects/app' })),
        h('label', {}, 'Путь в машине', h('input', { class: 'input mono', name: 'guestPath', value: d?.guestPath || '', placeholder: '/work' })),
        h('label', {}, 'Не больше, чем', h('select', { class: 'input', name: 'ceiling' },
          h('option', { value: 'ro', selected: d?.ceiling !== 'rw' }, 'только чтение'), h('option', { value: 'rw', selected: d?.ceiling === 'rw' }, 'чтение и запись'))),
        h('input', { type: 'hidden', name: 'defaultAccess', value: 'ro' })),
      h('label', {}, 'Заметка', h('input', { class: 'input', name: 'note', value: d?.note || '', maxlength: 200, placeholder: 'исходники агента' })),
      h('div', { class: 'error', hidden: true }),
      h('div', { class: 'row' },
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', class: 'btn ghost' }, 'Отмена'),
        h('button', { type: 'submit', class: 'btn primary' }, d ? 'Сохранить' : 'Добавить')));
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = f.querySelector('.error'); err.hidden = true;
      const body = Object.fromEntries(['id', 'hostPath', 'guestPath', 'ceiling', 'defaultAccess', 'note'].map((k) => [k, f[k].value.trim()]));
      try {
        await api('PUT', `/ui/dirs/${d ? enc(d.id) : 'new'}`, body);
        toast(`Директория ${body.id} сохранена`, 'ok');
        editingDir = null;
        if (!d) sel = `dir:${body.id}`;
        await load(); render();
      } catch (ex) { err.textContent = ex.message; err.hidden = false; }
    });
    return f;
  }

  // ---------- what may be given: the mode, one folder of the list ----------
  let editingDir = null; // dir id or 'new'

  function modeCard() {
    const setStrict = async (on) => {
      if (on === reg.strict) return;
      try { await api('PUT', '/ui/dirs-settings', { strict: on }); toast(on ? 'Строгий режим включён: машинам — только директории из списка' : 'Строгий режим выключен', 'ok'); }
      catch (e) { toast(e.message, 'err'); }
      await load(); render();
    };
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', {}, 'Какие директории можно давать машинам')),
      h('div', { class: 'set-modes' }, [
        [false, 'Любые директории', 'Доступ можно дать к любой директории, кроме запрещённых всегда: корень диска, домашняя директория целиком, ~/.ssh, ~/.aws и другие места с ключами, системные пути. Директории попадают в список сами.'],
        [true, 'Только из списка', 'Машинам — только директории из списка и их поддиректории, не шире уровня «Не больше, чем». Новые директории добавляются в список вручную.'],
      ].map(([v, t, desc]) => h('button', { type: 'button', class: `set-mode${v === reg.strict ? ' sel' : ''}`, onclick: () => setStrict(v) },
        h('span', { class: 'set-radio' }), h('div', {}, h('div', { class: 'mode-title' }, t), h('div', { class: 'small muted' }, desc))))));
  }

  function dirCard(d) {
    if (editingDir === d.id) return dirEditCard(d);
    const kv = kvCell;
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', {}, 'Директория'), h('span', { class: 'spacer' }),
        h('button', { class: 'btn small-btn', onclick: () => { editingDir = d.id; render(); } }, 'Изменить'),
        h('button', { class: 'btn ghost icon danger', title: 'Убрать из списка', 'aria-label': 'Убрать из списка', onclick: async () => {
          const r = await confirmDialog('Убрать директорию из списка?', `«${d.id}» (${d.hostPath}) больше нельзя будет давать машинам${reg.strict ? '' : ' в строгом режиме'}. Файлы на компьютере не затрагиваются.`, false, '', 'Убрать');
          if (!r.ok) return;
          try { await api('DELETE', `/ui/dirs/${enc(d.id)}`); sel = ''; await load(); render(); } catch (e) { toast(e.message, 'err'); }
        } }, ic('trash'))),
      h('div', { class: 'kv' },
        kv('На компьютере', h('span', { class: 'mono', title: d.hostPath }, d.hostPath.replace(state.info?.home || '\u0000', '~')), 'folder'),
        kv('В машине', h('span', { class: 'mono' }, d.guestPath), 'server'),
        kv('Не больше, чем', LEVEL[d.ceiling], 'lock'),
        kv('Владелец', d.owner != null ? `uid ${d.owner}` : '—', 'user')),
      !d.exists ? h('p', { class: 'small badc' }, 'Директория не найдена на компьютере.') : null,
      d.note ? h('p', { class: 'small muted' }, d.note) : null,
      h('div', { class: 'label-like' }, 'Подключена к машинам'),
      d.machines.length ? h('div', { class: 'chips' }, d.machines.map((n) => h('a', { href: `#/?machine=${enc(n)}&tab=folders`, class: 'lst-host mono' }, n))) : h('p', { class: 'muted small' }, 'Ни к одной.'));
  }

  function dirEditCard(d) {
    const f = dirForm(d);
    f.querySelector('.btn.ghost')?.addEventListener('click', () => { editingDir = null; if (!d) sel = ''; render(); });
    return h('div', { class: 'lst-card lst-edit' },
      h('div', { class: 'lst-head' }, h('span', { class: 'mark m-icon' }, ic(d ? 'folder' : 'plus')), h('b', {}, d ? `Директория ${d.id}` : 'Новая директория в списке'), h('span', { class: 'spacer' }),
        h('button', { class: 'btn ghost icon', title: 'Закрыть', onclick: () => { editingDir = null; render(); } }, ic('x'))),
      f);
  }

  // One machine: its folders in plain terms, «Дать директорию», the agent's changes in review copies.
  function machineFolderCard(m) {
    const changes = h('div', { class: 'mf-changes' });
    const drawChanges = async () => {
      let copies = [];
      try { copies = (await api('GET', `/ui/machines/${enc(m.name)}/review`)).dirs; } catch { copies = []; }
      if (!copies.length) { changes.replaceChildren(); return; }
      changes.replaceChildren(h('div', { class: 'net-col-title' }, 'Изменения агента в рабочих копиях'),
        ...(await Promise.all(copies.map((d) => reviewDir(m, d, drawChanges)))));
    };
    const list = folderList(m, { onChange: drawChanges });
    drawChanges();
    return h('section', { class: 'card machine-folders' },
      h('div', { class: 'card-head' }, h('h3', {}, 'Директории компьютера в машине'), h('span', { class: 'spacer' }),
        h('button', { class: 'btn small-btn', title: 'Дать доступ к директории', onclick: () => openFolderDialog({ machine: m.name, onDone: () => { list.refresh(); drawChanges(); } }) }, ic('plus'), 'Дать директорию')),
      list, changes);
  }

  // ---------- the page ----------
  let sel = ''; // 'mode' | 'dir:<id>' | 'dir:new'
  const validSel = () => sel === 'mode' || sel === 'dir:new' || (sel.startsWith('dir:') && reg.dirs.some((d) => `dir:${d.id}` === sel));
  // A machine's folders are its tab «Директории» on «Машины».
  window.machineFoldersTab = (el, m) => el.append(machineFolderCard(m));
  const choose = (key) => { sel = key; editingDir = key === 'dir:new' ? 'new' : null; render(); };

  function help() {
    return helpButton('Как агент получает доступ к директории',
      h('p', {}, '«Дать доступ к директории» → выберите директорию, машину и режим. Остальное smolvm-web сделает сам: разрешит директорию, подключит её к машине, выдаст права пользователю агента (node), при необходимости предложит перезапустить машину и проверит, что агент действительно видит директорию.'),
      h('ul', {},
        h('li', {}, h('b', {}, 'Только чтение'), ' — директория подключается read-only на уровне компьютера: писать в неё не сможет никто в машине, даже root.'),
        h('li', {}, h('b', {}, 'Рабочая копия с ревью'), ' — в машину копируется содержимое директории; изменения агента попадают на компьютер только после вашего «Применить». Для задач с git-репозиторием вместо копии — ветка (страница «Задачи»).'),
        h('li', {}, h('b', {}, 'Чтение и запись'), ' — агент меняет файлы на компьютере напрямую. Компьютер пускает писать только владельца директории, поэтому пользователь агента при запуске машины получает uid владельца — новые файлы будут вашими.'),
        h('li', {}, 'Новое подключение требует перезапуска машины: smolvm меняет монтирования только при запуске.')),
      h('p', { class: 'small muted' }, 'Технически директория монтируется в /.smolvm-dirs/<имя>/<ro|rw>/data за каталогом-«шлюзом» с POSIX ACL, а путь в машине — ссылка на него.'));
  }

  function side() {
    const item = (key, icon, name, sub, pill, cls = '') => h('a', { class: `machine ag-item sb-item${sel === key ? ' active' : ''} ${cls}`, href: '#', onclick: (e) => { e.preventDefault(); choose(key); } },
      icon, h('div', { class: 'name' }, name), pill || h('span'), h('div', { class: 'meta' }, sub || ''));
    const pill = (tone, text) => h('span', { class: `ag-pill ${tone}` }, text);
    return h('section', { class: 'panel list-panel' },
      h('div', { class: 'panel-head' }, h('h2', { class: 'h-ic' }, ic('folder'), 'Директории'), help(),
        h('button', { class: 'btn primary icon', title: 'Дать доступ к директории', 'aria-label': 'Дать доступ к директории',
          onclick: () => openFolderDialog({ machine: state.machines[0]?.name, onDone: async () => { await load(); render(); } }) }, ic('plus'))),
      h('div', { class: 'machines' },
        item('mode', h('span', { class: 'mark m-icon m-list' }, ic('sliders')), 'Какие директории можно давать', reg.strict ? 'только из списка' : 'любые, кроме опасных', pill(reg.strict ? 'ok' : 'neutral', reg.strict ? 'строго' : 'свободно')),
        h('div', { class: 'sb-group' }, 'Список директорий', h('span', { class: 'muted' }, String(reg.dirs.length))),
        ...reg.dirs.map((d) => item(`dir:${d.id}`, h('span', { class: 'mark m-icon m-list' }, ic('folder')), d.id,
          `${d.hostPath.replace(state.info?.home || '\u0000', '~')}`, d.exists ? pill(LEVEL_TAG[d.ceiling] || 'neutral', LEVEL[d.ceiling]) : pill('bad', 'не найдена'))),
        item('dir:new', h('span', { class: 'mark m-icon m-list' }, ic('plus')), 'Добавить директорию', reg.strict ? 'чтобы её можно было давать' : 'нужно только для строгого режима', null, 'sb-add')),
      h('p', { class: 'muted small dirs-note' }, 'Какие директории у конкретной машины и что агент поменял в рабочих копиях — вкладка «Директории» машины («Машины»).'));
  }

  function detail() {
    const head = (icon, title, sub) => h('div', { class: 'detail-head' }, icon, h('div', { class: 'ag-title' }, h('h2', {}, title), sub ? h('span', { class: 'muted small' }, sub) : null));
    const panel = (hd, ...body) => h('section', { class: 'panel detail-panel' }, hd, h('div', { class: 'tab-body' }, ...body.flat().filter(Boolean)));
    if (sel === 'mode') return panel(head(h('span', { class: 'mark m-icon' }, ic('sliders')), 'Какие директории можно давать', 'Какие директории этого компьютера вообще можно давать машинам и агентам.'), modeCard());
    if (sel === 'dir:new') return panel(head(h('span', { class: 'mark m-icon' }, ic('plus')), 'Новая директория в списке', reg.strict ? 'В строгом режиме машинам можно давать только директории из списка.' : 'Обычно директории попадают в список сами, когда к ним дают доступ.'), dirEditCard(null));
    if (sel.startsWith('dir:')) {
      const d = reg.dirs.find((x) => `dir:${x.id}` === sel);
      return panel(head(h('span', { class: 'mark m-icon' }, ic('folder')), d.id, d.note || 'Директория из списка разрешённых'), dirCard(d));
    }
    return null;
  }

  async function render() {
    if (!root || !reg) return;
    if (!validSel()) sel = 'mode';
    const q = sel === 'mode' ? '' : sel.startsWith('dir:') && sel !== 'dir:new' ? `?dir=${enc(sel.slice(4))}` : '';
    if (location.hash !== `#/dirs${q}`) history.replaceState(null, '', `#/dirs${q}`);
    const scroll = root.querySelector('.tab-body')?.scrollTop || 0;
    fill(root, h('div', { class: 'layout ag-layout' }, side(), detail()));
    const tb = root.querySelector('.tab-body');
    if (tb) tb.scrollTop = scroll;
  }

  pages.dirs = {
    render(el, p) {
      root = el; params = p;
      el.classList.add('page-agents');
      // Old links: ?tab=allowed → the mode; ?tab=folders|changes&machine= → that machine.
      // A machine's folders are its tab now: old links (?machine=, ?tab=folders|changes) lead there.
      if (p.get('machine')) { location.replace(`#/?machine=${enc(p.get('machine'))}&tab=folders`); return null; }
      sel = p.get('dir') ? `dir:${p.get('dir')}` : 'mode';
      fill(el, h('p', { class: 'muted' }, 'Загрузка…'));
      load().then(render).catch((e) => fill(el, h('div', { class: 'error' }, e.message)));
      return () => { root = null; el.classList.remove('page-agents'); };
    },
  };
})();
