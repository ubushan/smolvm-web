'use strict';
// Page «Директории»: host folders given to machines, review copies, the allowed list.
// (Per-user access inside a machine is API-only: PUT /ui/machines/:name/dirs.)

(() => {
  const LEVEL = { none: 'нет доступа', ro: 'чтение', rw: 'чтение и запись' };
  const LEVEL_TAG = { none: '', ro: 'ok', rw: 'warn' };
  let reg = null;        // GET /ui/dirs
  let root = null;
  let params = null;
  let selected = null;   // machine name

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
        toast(`Папка ${body.id} сохранена`, 'ok');
        editingDir = null; await load(); render();
      } catch (ex) { err.textContent = ex.message; err.hidden = false; }
    });
    return f;
  }

  // ---------- «Разрешённые папки»: strict mode, then a grid of folder cards ----------
  let editingDir = null; // dir id or 'new'

  function registryCard() {
    const setStrict = async (on) => {
      if (on === reg.strict) return;
      try { await api('PUT', '/ui/dirs-settings', { strict: on }); toast(on ? 'Строгий режим включён: машинам — только папки из списка' : 'Строгий режим выключен', 'ok'); }
      catch (e) { toast(e.message, 'err'); }
      await load(); render();
    };
    const modes = h('div', { class: 'set-modes' }, [
      [false, 'Любые папки', 'Доступ можно дать к любой папке, кроме запрещённых всегда: корень диска, домашняя папка целиком, ~/.ssh, ~/.aws и другие места с ключами, системные пути. Папки попадают в список сами.'],
      [true, 'Только из списка', 'Машинам — только папки из списка ниже и их подпапки, не шире уровня «Не больше, чем». Новые папки добавляются сюда вручную.'],
    ].map(([v, t, desc]) => h('button', { type: 'button', class: `set-mode${v === reg.strict ? ' sel' : ''}`, onclick: () => setStrict(v) },
      h('span', { class: 'set-radio' }), h('div', {}, h('div', { class: 'mode-title' }, t), h('div', { class: 'small muted' }, desc)))));

    const cards = reg.dirs.map((d) => {
      if (editingDir === d.id) return dirEditCard(d);
      return h('div', { class: 'lst-card' },
        h('div', { class: 'lst-head' }, h('span', { class: 'mark m-icon' }, ic('folder')),
          h('div', { class: 'lst-title' }, h('b', { class: 'mono' }, d.id), d.note ? h('div', { class: 'muted small' }, d.note) : null),
          h('span', { class: 'spacer' }), h('span', { class: `tag ${LEVEL_TAG[d.ceiling]}`, title: 'Не больше, чем' }, LEVEL[d.ceiling])),
        h('div', { class: 'dir-paths' },
          h('div', { class: 'mono small ellipsis path-tail', title: d.hostPath }, `‎${d.hostPath.replace(state.info?.home || '\u0000', '~')}‎`),
          h('div', { class: 'mono small muted' }, `→ ${d.guestPath}`),
          !d.exists ? h('div', { class: 'small badc' }, 'папка не найдена на компьютере') : d.owner != null ? h('div', { class: 'small muted' }, `владелец: uid ${d.owner}`) : null),
        h('div', { class: 'lst-foot' },
          d.machines.length ? h('div', { class: 'chips' }, d.machines.map((n) => h('a', { href: `#/dirs?tab=folders&machine=${enc(n)}`, class: 'lst-host mono' }, n))) : h('span', { class: 'muted small' }, 'Не подключена к машинам'),
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn small-btn', onclick: () => { editingDir = d.id; render(); } }, 'Изменить'),
          h('button', { class: 'btn ghost icon danger', title: 'Убрать из списка', onclick: async () => {
            const r = await confirmDialog('Убрать папку из списка?', `«${d.id}» (${d.hostPath}) больше нельзя будет давать машинам${reg.strict ? '' : ' в строгом режиме'}. Файлы на компьютере не затрагиваются.`, false, '', 'Убрать');
            if (!r.ok) return;
            try { await api('DELETE', `/ui/dirs/${enc(d.id)}`); await load(); render(); } catch (e) { toast(e.message, 'err'); }
          } }, ic('trash'))));
    });
    const add = editingDir === 'new' ? dirEditCard(null) : h('button', { type: 'button', class: 'lst-card lst-add', onclick: () => { editingDir = 'new'; render(); } },
      h('span', { class: 'lst-add-ic' }, ic('plus')), h('b', {}, 'Добавить папку'), h('span', { class: 'muted small' }, reg.strict ? 'чтобы её можно было давать машинам' : 'нужно только для строгого режима — обычно папки попадают сюда сами'));

    return [
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h3', {}, 'Какие папки можно давать машинам')),
        modes),
      h('div', { class: 'lst-section' }, h('div', { class: 'net-col-title' }, 'Список папок'), h('span', { class: 'muted small' }, `${reg.dirs.length} · сюда попадает каждая папка, к которой давали доступ`)),
      h('div', { class: 'lst-grid' }, ...cards, add),
    ];
  }

  function dirEditCard(d) {
    const f = dirForm(d);
    f.querySelector('.btn.ghost')?.addEventListener('click', () => { editingDir = null; render(); });
    return h('div', { class: 'lst-card lst-edit' },
      h('div', { class: 'lst-head' }, h('span', { class: 'mark m-icon' }, ic(d ? 'folder' : 'plus')), h('b', {}, d ? `Папка ${d.id}` : 'Новая папка в списке'), h('span', { class: 'spacer' }),
        h('button', { class: 'btn ghost icon', title: 'Закрыть', onclick: () => { editingDir = null; render(); } }, ic('x'))),
      f);
  }

  // «Изменения агента»: review copies of the selected machine (former «Изменения» tab).
  async function renderReview() {
    const box = root?.querySelector('#dm-review');
    if (!box) return;
    const m = state.machines.find((x) => x.name === selected);
    if (!m) { fill(box, h('p', { class: 'muted' }, 'Машин пока нет.')); return; }
    let copies = [];
    try { copies = (await api('GET', `/ui/machines/${enc(m.name)}/review`)).dirs; } catch (e) { fill(box, h('div', { class: 'error' }, e.message)); return; }
    if (!copies.length) {
      fill(box, h('div', { class: 'log-empty' }, ic('list'), h('div', {}, h('div', {}, `У машины ${m.name} нет рабочих копий.`),
        h('div', { class: 'small' }, 'Чтобы агент правил папку через ревью, дайте к ней доступ в режиме «Рабочая копия с ревью».')),
        h('button', { class: 'btn small-btn', onclick: () => openFolderDialog({ machine: m.name, mode: 'review', onDone: () => renderReview() }) }, ic('plus'), 'Дать доступ к папке')));
      return;
    }
    fill(box, ...(await Promise.all(copies.map((d) => reviewDir(m, d, renderReview)))));
  }

  // One card per machine: its folders in plain terms, and «Дать доступ к папке».
  function machineFolders() {
    if (!state.machines.length) return h('section', { class: 'card' }, h('p', { class: 'muted' }, 'Машин пока нет — создайте машину, затем дайте ей доступ к папкам.'));
    const wanted = params.get('machine');
    return state.machines.map((m) => {
      const list = folderList(m, { onChange: () => renderReview() });
      const mk = state.marks?.[m.name];
      return h('section', { class: `card machine-folders${wanted === m.name ? ' hl' : ''}`, id: `mf-${m.name}` },
        h('div', { class: 'net-head' },
          mark(mk?.mark || 'vm', true),
          h('div', { class: 'net-title' },
            h('div', { class: 'row' }, h('b', { class: 'mono' }, m.name), h('span', { class: `badge ${m.state}` }, stateLabel(m.state)), mk?.sandbox ? h('span', { class: 'tag sbx' }, 'песочница') : null),
            h('div', { class: 'muted small' }, mk?.title ? `пресет ${mk.title}` : 'машина без пресета')),
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn small-btn', onclick: () => openFolderDialog({ machine: m.name, onDone: () => { list.refresh(); renderReview(); } }) }, ic('plus'), 'Дать доступ к папке')),
        list);
    });
  }

  // Sections of the page, like the settings window: a bar on top, one section at a time.
  const SECTIONS = [
    ['folders', 'folder', 'Папки машин', 'Какие папки компьютера видят агенты в каждой машине, в каком режиме и работает ли доступ.'],
    ['changes', 'list', 'Изменения агента', 'Рабочие копии: агент правит копию, на компьютер попадает только то, что вы примените.'],
    ['allowed', 'shield', 'Разрешённые папки', 'Политика: какие папки вообще можно давать машинам (строгий режим).'],
  ];
  let section = 'folders';

  async function render() {
    if (!root || !reg) return;
    const nav = h('nav', { class: 'section-nav' }, SECTIONS.map(([id, icon, title]) => {
      const b = h('button', { type: 'button', class: id === section ? 'active' : '' }, ic(icon), title);
      b.addEventListener('click', () => {
        section = id;
        const q = new URLSearchParams(params); q.set('tab', id); q.delete('focus');
        history.replaceState(null, '', `#/dirs?${q}`);
        render();
      });
      return b;
    }));
    const [, , , about] = SECTIONS.find(([id]) => id === section);
    let content;
    if (section === 'folders') content = machineFolders();
    else if (section === 'changes') {
      content = h('section', { class: 'card review-host', id: 'changes' },
        h('div', { class: 'card-head' }, h('h3', {}, 'Рабочие копии машины'), h('span', { class: 'spacer' }), reviewMachineSel()),
        h('div', { id: 'dm-review' }));
    } else content = registryCard();
    fill(root,
      h('section', { class: 'card intro dirs-head' },
        h('div', { class: 'row' }, h('h2', { class: 'h-ic' }, ic('folder'), 'Папки компьютера для агентов'),
          helpButton('Как агент получает доступ к папке',
            h('p', {}, '«Дать доступ к папке» → выберите папку, машину и режим. Остальное smolvm-web сделает сам: разрешит папку, подключит её к машине, выдаст права пользователю агента (node), при необходимости предложит перезапустить машину и проверит, что агент действительно видит папку.'),
            h('ul', {},
              h('li', {}, h('b', {}, 'Только чтение'), ' — папка подключается read-only на уровне компьютера: писать в неё не сможет никто в машине, даже root.'),
              h('li', {}, h('b', {}, 'Рабочая копия с ревью'), ' — в машину копируется содержимое папки; изменения агента попадают на компьютер только после вашего «Применить» (вкладка «Изменения агента»).'),
              h('li', {}, h('b', {}, 'Чтение и запись'), ' — агент меняет файлы на компьютере напрямую. Компьютер пускает писать только владельца папки, поэтому пользователь агента при запуске машины получает uid владельца — новые файлы будут вашими.'),
              h('li', {}, 'Новое подключение требует перезапуска машины: smolvm меняет монтирования только при запуске.')),
            h('p', { class: 'small muted' }, 'Технически папка монтируется в /.smolvm-dirs/<имя>/<ro|rw>/data за каталогом-«шлюзом» с POSIX ACL, а путь в машине — ссылка на него.')),
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn primary', onclick: () => openFolderDialog({ machine: params.get('machine') || state.selected || state.machines[0]?.name, onDone: render }) }, ic('plus'), 'Дать доступ к папке')),
        nav,
        h('p', { class: 'muted small' }, about)),
      ...[].concat(content));
    if (section === 'changes') renderReview();
    if (section === 'folders' && params.get('machine')) requestAnimationFrame(() => root?.querySelector(`#mf-${CSS.escape(params.get('machine'))}`)?.scrollIntoView({ behavior: 'smooth' }));
  }

  function reviewMachineSel() {
    const names = state.machines.map((m) => m.name);
    if (!names.length) return null;
    if (!selected || !names.includes(selected)) selected = names[0];
    const sel = h('select', { class: 'input small' }, names.map((n) => h('option', { value: n, selected: n === selected }, n)));
    sel.addEventListener('change', () => { selected = sel.value; renderReview(); });
    return sel;
  }

  pages.dirs = {
    render(el, p) {
      root = el; params = p;
      selected = p.get('machine') || selected;
      // Old links: ?focus=changes, ?advanced=1.
      section = p.get('tab') || (p.get('focus') === 'changes' ? 'changes' : p.get('advanced') === '1' ? 'allowed' : 'folders');
      if (!SECTIONS.some(([id]) => id === section)) section = 'folders';
      fill(el, h('p', { class: 'muted' }, 'Загрузка…'));
      load().then(render).catch((e) => fill(el, h('div', { class: 'error' }, e.message)));
      return () => { root = null; };
    },
  };
})();
