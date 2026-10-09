'use strict';
// Page «Директории»: allowed host directories and per-user access inside machines.

(() => {
  const LEVEL = { none: 'нет доступа', ro: 'чтение', rw: 'чтение и запись' };
  const LEVEL_TAG = { none: '', ro: 'ok', rw: 'warn' };
  let reg = null;        // GET /ui/dirs
  let root = null;
  let params = null;
  let selected = null;   // machine name
  let verifyResult = null;

  async function load() { reg = await api('GET', '/ui/dirs'); }

  function card(title, ...children) {
    return h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, title)), ...children);
  }

  function levelSelect(value, max, name) {
    return h('select', { class: `input small lvl lvl-${value}`, name },
      ['none', 'ro', 'rw'].map((l) => h('option', { value: l, selected: l === value, disabled: l === 'rw' && max !== 'rw' }, LEVEL[l])));
  }

  // ---------- registry ----------
  function dirForm(d) {
    const f = h('form', { class: 'dir-form', autocomplete: 'off' },
      h('div', { class: 'grid-dir' },
        h('label', {}, 'Имя', h('input', { class: 'input mono', name: 'id', value: d?.id || '', required: true, pattern: '[a-z0-9][a-z0-9_\\-]{0,31}', readonly: !!d, placeholder: 'project' })),
        h('label', {}, 'Путь на хосте', h('input', { class: 'input mono', name: 'hostPath', value: d?.hostPath || '', required: true, placeholder: state.info?.platform === 'win32' ? 'C:\\Users\\me\\projects\\app' : '/Users/me/projects/app' })),
        h('label', {}, 'Путь в машине', h('input', { class: 'input mono', name: 'guestPath', value: d?.guestPath || '', placeholder: '/work' })),
        h('label', {}, 'Максимум', h('select', { class: 'input', name: 'ceiling' },
          h('option', { value: 'ro', selected: d?.ceiling !== 'rw' }, 'только чтение'), h('option', { value: 'rw', selected: d?.ceiling === 'rw' }, 'чтение и запись'))),
        h('label', {}, 'По умолчанию для всех', h('select', { class: 'input', name: 'defaultAccess' },
          ['ro', 'rw', 'none'].map((l) => h('option', { value: l, selected: (d?.defaultAccess || 'ro') === l }, LEVEL[l]))))),
      h('label', {}, 'Заметка', h('input', { class: 'input', name: 'note', value: d?.note || '', maxlength: 200, placeholder: 'исходники агента' })),
      h('div', { class: 'error', hidden: true }),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn ghost', onclick: () => f.remove() }, 'Отмена'),
        h('button', { type: 'submit', class: 'btn primary' }, d ? 'Сохранить' : 'Добавить')));
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = f.querySelector('.error'); err.hidden = true;
      const body = Object.fromEntries(['id', 'hostPath', 'guestPath', 'ceiling', 'defaultAccess', 'note'].map((k) => [k, f[k].value.trim()]));
      try {
        await api('PUT', `/ui/dirs/${d ? enc(d.id) : 'new'}`, body);
        toast(`Директория ${body.id} сохранена`, 'ok');
        await load(); render();
      } catch (ex) { err.textContent = ex.message; err.hidden = false; }
    });
    return f;
  }

  function registryCard() {
    const formSlot = h('div');
    const strict = h('input', { type: 'checkbox', checked: reg.strict });
    strict.addEventListener('change', async () => {
      try { await api('PUT', '/ui/dirs-settings', { strict: strict.checked }); toast(strict.checked ? 'Монтировать можно только разрешённые директории' : 'Строгий режим выключен', 'ok'); }
      catch (e) { toast(e.message, 'err'); strict.checked = !strict.checked; }
    });
    const rows = reg.dirs.map((d) => h('tr', {},
      h('td', { class: 'mono' }, d.id, d.note ? h('div', { class: 'muted small' }, d.note) : null),
      h('td', { class: 'mono small' }, d.hostPath, !d.exists ? h('div', { class: 'badc' }, 'директория не найдена') : d.owner != null ? h('div', { class: 'muted' }, `владелец uid ${d.owner}`) : null),
      h('td', { class: 'mono small' }, d.guestPath),
      h('td', {}, h('span', { class: `tag ${LEVEL_TAG[d.ceiling]}` }, LEVEL[d.ceiling])),
      h('td', { class: 'small' }, LEVEL[d.defaultAccess]),
      h('td', { class: 'small' }, d.machines.length ? d.machines.map((n) => h('a', { href: `#/dirs?machine=${enc(n)}`, class: 'mlink' }, n)) : '—'),
      h('td', { class: 'nowrap' },
        h('button', { class: 'btn ghost', onclick: () => { fill(formSlot, dirForm(d)); } }, 'Изменить'),
        h('button', { class: 'btn ghost danger', onclick: async () => {
          const r = await confirmDialog('Удалить директорию из списка?', `«${d.id}» (${d.hostPath}) больше нельзя будет подключать к машинам. Файлы на хосте не затрагиваются.`);
          if (!r.ok) return;
          try { await api('DELETE', `/ui/dirs/${enc(d.id)}`); await load(); render(); } catch (e) { toast(e.message, 'err'); }
        } }, 'Удалить'))));
    return card('Разрешённые директории хоста',
      h('p', { class: 'muted small' }, 'Только эти директории можно подключать к машинам с разграничением прав. Нельзя добавить корень диска, домашнюю директорию целиком, системные пути и места с ключами (~/.ssh, ~/.aws, ~/.kube, настройки smolvm-web и т.п.). «Максимум» ограничивает права для всех машин: директория «только чтение» монтируется read-only на уровне хоста — писать не сможет даже root в машине.'),
      reg.dirs.length ? h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
        h('tr', {}, h('th', {}, 'Имя'), h('th', {}, 'На хосте'), h('th', {}, 'В машине'), h('th', {}, 'Максимум'), h('th', {}, 'По умолчанию'), h('th', {}, 'Машины'), h('th', {}, '')),
        rows)) : h('p', { class: 'muted' }, 'Список пуст.'),
      formSlot,
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: () => { fill(formSlot, dirForm(null)); formSlot.querySelector('input')?.focus(); } }, [ic('plus'), 'Добавить директорию']),
        h('span', { class: 'spacer' }),
        h('label', { class: 'check' }, strict, ' Строгий режим: в форме создания машины монтировать только директории из этого списка')));
  }

  // ---------- machine access ----------
  async function machineCard() {
    const names = state.machines.map((m) => m.name);
    if (!selected || !names.includes(selected)) selected = names[0] || null;
    const sel = h('select', { class: 'input small' }, names.map((n) => h('option', { value: n, selected: n === selected }, n)));
    sel.addEventListener('change', () => { selected = sel.value; verifyResult = null; history.replaceState(null, '', `#/dirs?machine=${enc(selected)}`); renderMachine(); renderReview(); });
    const body = h('div', { id: 'dm-body' });
    const c = card('Доступ в машине', h('div', { class: 'row' }, h('span', { class: 'muted small' }, 'Машина'), sel), body);
    return c;
  }

  // «Изменения агента»: review copies of the selected machine (former «Изменения» tab).
  async function renderReview() {
    const box = root?.querySelector('#dm-review');
    if (!box) return;
    const m = state.machines.find((x) => x.name === selected);
    if (!m) { fill(box, h('p', { class: 'muted' }, 'Машин пока нет.')); return; }
    const body = h('div', { class: 'col', style: 'display:flex;flex-direction:column;gap:12px' });
    fill(box, body);
    await tabReview(body, m, renderReview);
  }

  async function renderMachine() {
    const body = root?.querySelector('#dm-body');
    if (!body) return;
    if (!selected) { fill(body, h('p', { class: 'muted' }, 'Машин пока нет.')); return; }
    let v;
    try { v = await api('GET', `/ui/machines/${enc(selected)}/dirs`); } catch (e) { fill(body, h('div', { class: 'error' }, e.message)); return; }
    const m = state.machines.find((x) => x.name === selected);
    const running = m?.state === 'running';
    // Working copy edited in the UI.
    const work = { users: v.users.map((u) => ({ ...u })), dirs: v.dirs.map((d) => ({ id: d.id, guestPath: d.guestPath, access: { ...d.access } })) };
    const regById = Object.fromEntries(reg.dirs.map((d) => [d.id, d]));
    const draw = () => {
      const cols = [...work.users.map((u) => u.name), '*'];
      const usersBox = h('div', { class: 'chips' },
        work.users.map((u, i) => h('span', { class: 'user-chip' }, h('b', {}, u.name), u.uid ? h('span', { class: 'muted small' }, ` uid ${u.uid}`) : null,
          h('button', { class: 'btn ghost icon', title: 'Убрать', onclick: () => { work.users.splice(i, 1); for (const d of work.dirs) delete d.access[u.name]; draw(); } }, ic('x')))),
        work.users.length ? null : h('span', { class: 'muted small' }, 'Пользователей нет — права заданы только для «остальных».'));
      const uName = h('input', { class: 'input small', placeholder: 'agent', pattern: '[a-z_][a-z0-9_\\-]*' });
      const uUid = h('input', { class: 'input small uid-in', type: 'number', min: 1, max: 60000, placeholder: 'uid' });
      const owners = [...new Set(work.dirs.map((d) => regById[d.id]?.owner).filter((x) => x > 0))];
      const addUser = () => {
        const n = uName.value.trim();
        if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(n)) { toast('Имя пользователя: строчные латинские буквы, цифры, _ и -', 'err'); return; }
        if (work.users.some((u) => u.name === n)) return;
        work.users.push({ name: n, uid: uUid.value ? Number(uUid.value) : null });
        for (const d of work.dirs) d.access[n] = d.access['*'] || 'none';
        draw();
      };
      uName.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addUser(); } });

      const matrix = work.dirs.length ? h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl matrix' },
        h('tr', {}, h('th', {}, 'Директория'), h('th', {}, 'Путь в машине'),
          cols.map((c) => h('th', {}, c === '*' ? h('span', { title: 'Все пользователи, не перечисленные слева (в т.ч. пользователь образа по умолчанию)' }, 'остальные') : c)), h('th', {}, '')),
        work.dirs.map((d, i) => {
          const r = regById[d.id];
          const shown = v.dirs.find((x) => x.id === d.id);
          return h('tr', {},
            h('td', { class: 'mono' }, d.id, r ? h('div', { class: 'muted small' }, r.hostPath) : h('div', { class: 'badc small' }, 'удалена из списка')),
            h('td', {}, h('input', { class: 'input mono small', value: d.guestPath, onchange: (e) => { d.guestPath = e.target.value.trim(); } })),
            cols.map((c) => {
              const s = levelSelect(d.access[c] || (c === '*' ? 'none' : d.access['*'] || 'none'), r?.ceiling, c);
              s.addEventListener('change', () => { d.access[c] = s.value; s.className = `input small lvl lvl-${s.value}`; });
              const paths = shown?.paths?.[c];
              return h('td', {}, s, paths?.length ? h('div', { class: 'muted small mono' }, paths.join(' · ')) : null);
            }),
            h('td', {}, h('button', { class: 'btn ghost danger icon', title: 'Отключить от машины', onclick: () => { work.dirs.splice(i, 1); draw(); } }, ic('x'))));
        }))) : h('p', { class: 'muted' }, 'К машине не подключено директорий.');

      const avail = reg.dirs.filter((d) => !work.dirs.some((x) => x.id === d.id));
      const addSel = h('select', { class: 'input small' }, avail.map((d) => h('option', { value: d.id }, `${d.id} → ${d.guestPath}`)));
      const pending = v.pending.add.length || v.pending.remove.length;
      const err = h('div', { class: 'error', hidden: true });
      const report = h('div');
      const save = h('button', { class: 'btn primary' }, running ? 'Сохранить и применить' : 'Сохранить');
      save.addEventListener('click', async () => {
        err.hidden = true; save.disabled = true;
        try {
          const r = await api('PUT', `/ui/machines/${enc(selected)}/dirs`, work);
          toast(`${selected}: доступ к директориям сохранён`, 'ok');
          if (r.report) reportDirs(selected, r.report);
          verifyResult = null;
          await load(); await renderMachine();
        } catch (e) { err.textContent = e.message; err.hidden = false; } finally { save.disabled = false; }
      });

      fill(body,
        h('div', { class: 'label-like' }, 'Пользователи в машине'),
        h('p', { class: 'muted small' }, 'Запускайте агентов от этих пользователей (в консоли — поле «user», в API exec — "user"). Отсутствующие пользователи создаются при применении. root в машине обходит права гостя и имеет доступ ко всему, что смонтировано, — ограничение для root только «Максимум» директории.'),
        usersBox,
        h('div', { class: 'row' }, uName, uUid, h('button', { class: 'btn', onclick: addUser }, [ic('plus'), 'Пользователь']),
          owners.length ? h('span', { class: 'muted small' }, `Для записи в директории хоста uid пользователя должен совпадать с владельцем на хосте: ${owners.join(', ')}`) : null),
        h('div', { class: 'label-like' }, 'Права на директории'),
        matrix,
        avail.length ? h('div', { class: 'row' }, addSel, h('button', { class: 'btn', onclick: () => {
          const d = regById[addSel.value];
          if (!d) return;
          const access = { '*': d.defaultAccess };
          for (const u of work.users) access[u.name] = d.defaultAccess;
          work.dirs.push({ id: d.id, guestPath: d.guestPath, access });
          draw();
        } }, [ic('plus'), 'Подключить директорию'])) : reg.dirs.length ? null : h('p', { class: 'muted small' }, 'Сначала добавьте директорию в список выше.'),
        pending ? h('div', { class: 'notice' }, `Монтирования изменятся при следующем запуске через smolvm-web: +${v.pending.add.length} −${v.pending.remove.length}. `,
          running ? h('button', { class: 'btn', onclick: async () => { await actions.restart(m); await load(); await renderMachine(); } }, '↻ Перезапустить сейчас') : null) : null,
        err,
        h('div', { class: 'row' }, save,
          running && v.dirs.length ? h('button', { class: 'btn', onclick: async () => {
            try { reportDirs(selected, await api('POST', `/ui/machines/${enc(selected)}/dirs/apply`, {})); toast(`${selected}: права применены`, 'ok'); } catch (e) { toast(e.message, 'err'); }
          } }, 'Применить заново') : null,
          running && v.dirs.length ? h('button', { class: 'btn', onclick: async () => {
            fill(report, h('p', { class: 'muted' }, 'Проверка…'));
            try { verifyResult = await api('POST', `/ui/machines/${enc(selected)}/dirs/verify`, {}); drawVerify(report); } catch (e) { fill(report, h('div', { class: 'error' }, e.message)); }
          } }, '✓ Проверить фактические права') : null,
          !running ? h('span', { class: 'muted small' }, 'Права пользователей применяются в запущенной машине; сейчас она не запущена — применится при старте.') : null),
        report);
      if (verifyResult) drawVerify(report);
    };
    draw();
  }

  function drawVerify(box) {
    const rows = verifyResult?.rows || [];
    fill(box, h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
      h('tr', {}, h('th', {}, 'Пользователь'), h('th', {}, 'Директория'), h('th', {}, 'Задано'), h('th', {}, 'Фактически'), h('th', {}, '')),
      rows.map((r) => h('tr', {},
        h('td', { class: 'mono' }, r.user === '*' ? 'остальные (nobody)' : r.user),
        h('td', { class: 'mono' }, r.dir),
        h('td', {}, LEVEL[r.expected]),
        h('td', {}, r.actual ? h('span', { class: `tag ${r.ok ? 'ok' : 'bad'}` }, LEVEL[r.actual]) : h('span', { class: 'tag bad' }, 'ошибка')),
        h('td', { class: 'small' }, r.ok ? '✓' : (r.error || r.hint || 'не совпадает — нажмите «Применить заново»')))))));
  }

  async function render() {
    if (!root || !reg) return;
    fill(root,
      h('section', { class: 'card intro' }, h('div', { class: 'row' }, h('h2', { class: 'h-ic' }, ic('folder'), 'Директории хоста и права пользователей'), helpButton('Как устроены директории и права',
          h('p', {}, 'Каждая директория монтируется в машину до двух раз: представление «чтение и запись» и представление только для чтения (read-only обеспечивает хост). Оба лежат в ', h('code', {}, '/.smolvm-dirs/<имя>/'), ' за «шлюзами» — каталогами с правами 0700 и POSIX ACL, которые пропускают только нужных пользователей (пакет acl ставится в машину автоматически). Путь в машине — ссылка на самое широкое представление, у каждого пользователя есть ', h('code', {}, '~/<имя>'), ' на его собственное, для режима «только чтение» при наличии записи — ', h('code', {}, '<путь>-ro'), '.'),
          h('p', {}, 'Изменение прав между «чтением», «записью» и «нет доступа» внутри уже смонтированных представлений применяется сразу. Новое представление или новая директория требуют перезапуска: smolvm меняет монтирования только у остановленной машины.')),
        reg.strict ? h('span', { class: 'tag ok' }, 'строгий режим') : h('span', { class: 'tag' }, 'произвольные монтирования разрешены'))),
      registryCard(), await machineCard(),
      h('section', { class: 'card review-host', id: 'dm-review-card' },
        h('div', { class: 'card-head' }, h('h3', {}, 'Изменения агента'), h('span', { class: 'muted small' }, 'рабочие копии папок выбранной машины: агент правит копию, на хост — только после вашего «Применить»')),
        h('div', { id: 'dm-review' })));
    renderMachine();
    renderReview();
  }

  pages.dirs = {
    render(el, p) {
      root = el; params = p;
      selected = p.get('machine') || selected;
      verifyResult = null;
      fill(el, h('p', { class: 'muted' }, 'Загрузка…'));
      load().then(render).catch((e) => fill(el, h('div', { class: 'error' }, e.message)));
      return () => { root = null; };
    },
  };
})();
