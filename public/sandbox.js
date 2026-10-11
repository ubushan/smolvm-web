'use strict';
// «Песочница» → a template (#/sandbox?id=…, #/sandbox?new=1): the panel of the section on
// the left, the chosen template on the right — what is inside, who uses it, «Обновить агента».

(() => {
  let root = null;
  let data = null;   // GET /ui/sandbox
  let timer = null;
  let lastSig = '';
  let editing = null; // 'new-template'

  const ago = (ms) => fmtAgo(Math.floor(ms / 1000));
  async function load() { data = await api('GET', '/ui/sandbox'); }

  // ---------- actions ----------
  let selected = '';   // template id
  let isNew = false;
  async function start(body, label) {
    const m = state.machines.find((x) => x.name === body.source);
    if (m?.state === 'running' && !(await confirmDialog(label, `Машина ${body.source} будет перезапущена: smolvm делает снимок только машины, запущенной с поддержкой ветвления. Запущенные в ней агенты остановятся.`, false, '', 'Продолжить')).ok) return;
    let r = null;
    try { r = await api('POST', '/ui/sandbox/templates', body); toast('Шаблон готовится…', 'ok'); } catch (e) { toast(e.message, 'err', 12000); }
    editing = null;
    if (r?.id && !body.id) { location.hash = `#/sandbox?id=${enc(r.id)}`; return; }
    await load(); render();
  }
  async function upgrade(t) {
    const c = await confirmDialog('Обновить агента?', `В исходной машине ${t.source} установится последняя версия агентов, затем шаблон снимется заново. Машина перезапустится; открытые песочницы работают на старой версии до закрытия.`, false, '', 'Обновить');
    if (!c.ok) return;
    try { await api('POST', `/ui/sandbox/templates/${enc(t.id)}/upgrade`, {}); toast('Обновление началось', 'ok'); } catch (e) { toast(e.message, 'err', 12000); }
    await load(); render();
  }
  async function remove(t) {
    if (!(await confirmDialog('Удалить шаблон?', `Снимок «${t.title}» будет удалён. Исходная машина ${t.source} останется.`, false, '', 'Удалить')).ok) return;
    try { await api('DELETE', `/ui/sandbox/templates/${enc(t.id)}`); toast('Шаблон удалён', 'ok'); } catch (e) { toast(e.message, 'err'); return; }
    location.hash = '#/sandbox';
  }

  // ---------- the chosen template ----------
  function detail(t) {
    const job = t.upgrade?.status === 'running' ? t.upgrade : t.job;
    const running = job?.status === 'running' || t.creating;
    const status = running ? h('span', { class: 'badge prep' }, h('i', { class: 'spin' }), job?.step || 'готовится')
      : t.upgrade?.status === 'error' ? h('span', { class: 'tag bad', title: t.upgrade.error }, 'обновление не удалось')
      : job?.status === 'error' ? h('span', { class: 'tag bad', title: job.error }, 'ошибка')
        : t.missing ? h('span', { class: 'tag bad' }, 'нет файла снимка') : h('span', { class: 'tag ok' }, 'готов');
    const open = data.sandboxes.filter((x) => x.template === t.id).length;
    const users = data.profiles.filter((p) => p.template === t.id || (p.preset && t.auto?.preset === p.preset && !!t.auto?.isolated === ((p.net || 'strict') === 'strict')));
    const iso = t.egress?.enabled && t.egress?.strict;
    const vers = Object.entries(t.versions || {});
    const kv = (k, v) => h('div', {}, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));
    return h('section', { class: 'panel detail-panel' },
      h('div', { class: 'detail-head' },
        t.agents ? mark(markOf(t)) : mark('vm'),
        h('div', { class: 'ag-title' }, h('h2', {}, t.title), h('span', { class: 'muted small mono' }, t.auto ? 'образ программы · готовится сам' : `из машины ${t.source}`)),
        status,
        t.creating ? null : h('div', { class: 'actions' },
          h('button', { class: `btn${t.updates?.length ? ' primary' : ''}`, disabled: running, title: 'Установить последнюю версию агентов в исходной машине и снять шаблон заново', onclick: () => upgrade(t) }, ic('download'), 'Обновить агента'),
          h('button', { class: 'btn ghost', disabled: running, title: 'Снять шаблон заново, ничего не обновляя (например, после ваших изменений в машине)', onclick: () => start({ source: t.source, id: t.id }, 'Снять шаблон заново?') }, ic('refresh'), 'Снять заново'),
          h('button', { class: 'btn ghost icon danger', disabled: running, title: 'Удалить шаблон', 'aria-label': 'Удалить шаблон', onclick: () => remove(t) }, ic('trash')))),
      h('nav', { class: 'tabs' }, h('button', { class: 'tab active' }, 'Обзор')),
      h('div', { class: 'tab-body' },
        job?.status === 'error' ? h('div', { class: 'error small' }, job.error) : null,
        t.updates?.length ? h('div', { class: 'tpl-update' }, ic('refresh'), h('span', {}, 'Доступна новая версия: ', t.updates.map((u) => `${u.cmd} ${u.have} → ${u.latest}`).join(', '), ' — «Обновить агента».')) : null,
        h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Что внутри')),
          h('div', { class: 'kv' },
            kv('Образ OCI', h('span', { class: 'mono' }, t.image || '—')),
            kv('Агенты', vers.length ? vers.map(([c, v]) => `${AGENT_TITLES[c] || c} ${v}`).join(', ') : (t.agents?.agents || []).filter((x) => x !== 'terminal').map((x) => AGENT_TITLES[x] || x).join(', ') || '—'),
            kv('Изоляция', iso ? 'жёсткая — обойти фильтр нельзя' : t.egress?.enabled ? 'фильтр без изоляции' : 'без ограничений'),
            kv('Ресурсы', t.cpus ? `${t.cpus} vCPU · ${fmtMb(t.memoryMb)}` : '—'),
            kv('Снимок', t.size ? fmtBytes(t.size) : '—'),
            kv('Обновлён', t.updatedAt ? ago(t.updatedAt) : '—'))),
        h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Кто им пользуется')),
          h('p', { class: 'small' }, open ? `Сейчас из него открыто песочниц: ${open}.` : 'Сейчас песочниц из него нет.'),
          users.length ? h('div', { class: 'chips' }, ...users.map((p) => h('a', { class: 'chip', href: `#/agents?id=${enc(p.id)}` }, p.name)))
            : h('p', { class: 'muted small' }, 'Агентов на нём нет.')),
        h('details', { class: 'card' }, h('summary', {}, h('b', {}, 'Как работают шаблоны')),
          h('ul', { class: 'small' },
            h('li', {}, 'Шаблон — снимок машины с установленными агентами. Каждая задача открывается из него в чистой копии за секунды.'),
            h('li', {}, 'Образы программ smolvm-web готовит сам; шаблон своей машины — «Новый шаблон» слева: например, если в ней агент уже вошёл по подписке.'),
            h('li', {}, 'Нельзя: подключённые папки компьютера, GPU/CUDA, том корпоративных сертификатов для скачивания образа.'),
            h('li', {}, 'Новые версии агентов проверяются раз в сутки; «Обновить агента» ставит последнюю и снимает шаблон заново.')))));
  }

  function newTemplateForm(start) {
    const candidates = state.machines.filter((m) => state.marks?.[m.name] && !state.marks[m.name].sandbox);
    const close = h('a', { class: 'btn ghost icon', title: 'Закрыть', 'aria-label': 'Закрыть', href: '#/sandbox' }, ic('x'));
    if (!candidates.length) {
      return h('div', { class: 'lst-card lst-edit' }, h('div', { class: 'lst-head' }, h('span', { class: 'mark m-icon' }, ic('plus')), h('b', {}, 'Новый шаблон'), h('span', { class: 'spacer' }), close),
        h('p', { class: 'muted' }, 'Нет машин с агентами. Создайте машину с пресетом агента («Машины» → «+»), запустите её и дождитесь установки — или просто создайте агента: образ программы smolvm-web подготовит сам.'));
    }
    const src = h('select', { class: 'input' }, candidates.map((m) => h('option', { value: m.name }, `${m.name} — ${state.marks[m.name].title}`)));
    const title = h('input', { class: 'input', placeholder: state.marks[candidates[0].name]?.title || 'Claude Code', maxlength: 60 });
    src.addEventListener('change', () => { title.placeholder = state.marks[src.value]?.title || ''; });
    return h('div', { class: 'lst-card lst-edit' },
      h('div', { class: 'lst-head' }, h('span', { class: 'mark m-icon' }, ic('plus')), h('b', {}, 'Новый шаблон'), h('span', { class: 'spacer' }), close),
      h('div', { class: 'grid2' }, h('label', {}, 'Машина с агентами', src), h('label', {}, 'Название', title)),
      h('div', { class: 'row' }, h('span', { class: 'muted small' }, 'Машина будет перезапущена.'), h('span', { class: 'spacer' }),
        h('button', { class: 'btn primary', onclick: () => start({ source: src.value, title: title.value || state.marks[src.value]?.title }, 'Создать шаблон?') }, 'Создать шаблон')));
  }

  const AGENT_TITLES = { terminal: 'Терминал', claude: 'Claude Code', opencode: 'OpenCode', 'opencode-tui': 'OpenCode TUI', dsh: 'DSH', codex: 'Codex', pi: 'Pi', hermes: 'Hermes' };
  const AGENT_MARKS = { claude: 'claude', opencode: 'opencode', 'opencode-tui': 'opencode', dsh: 'dsh', codex: 'codex', pi: 'pi', hermes: 'hermes' };
  function markOf(t) {
    const ids = t.agents.agents.filter((id) => id !== 'terminal');
    return ids.length > 2 ? 'all' : AGENT_MARKS[ids[0]] || 'term';
  }

  // ---------- render: the panel of the section, the chosen template on the right ----------
  function render() {
    if (!root || !data) return;
    const t = isNew ? null : data.templates.find((x) => x.id === selected) || data.templates[0] || null;
    if (t && !isNew && selected !== t.id) { selected = t.id; history.replaceState(null, '', `#/sandbox?id=${enc(t.id)}`); }
    const side = sandboxSide(data, isNew ? { kind: 'new-template' } : { kind: 'template', id: t?.id });
    const right = isNew
      ? h('section', { class: 'panel detail-panel' }, h('div', { class: 'detail-head' }, mark('vm'), h('div', { class: 'ag-title' }, h('h2', {}, 'Новый шаблон'), h('span', { class: 'muted small' }, 'снимок вашей машины с агентами'))),
        h('div', { class: 'tab-body' }, newTemplateForm(start)))
      : t ? detail(t)
        : h('section', { class: 'panel detail-panel' }, h('div', { class: 'empty-state' }, h('div', { class: 'big' }, ic('box')),
          h('p', {}, 'Шаблонов пока нет. Образ программы появится сам, когда вы создадите агента.'),
          h('a', { class: 'btn primary', href: '#/agents?create=program' }, ic('plus'), 'Создать агента')));
    const scroll = root.querySelector('.tab-body')?.scrollTop || 0;
    fill(root, h('div', { class: 'layout ag-layout' }, side, right));
    const tb = root.querySelector('.tab-body');
    if (tb) tb.scrollTop = scroll;
  }

  // Template jobs and machine states without wiping a form being filled.
  async function poll() {
    if (!root || document.hidden) return;
    try { await load(); } catch { return; }
    const sig = JSON.stringify([data.templates.map((t) => [t.id, t.job?.status, t.job?.step, t.upgrade?.status, t.upgrade?.step, t.updatedAt, t.updates?.length]), data.sandboxes.length, data.profiles.length, data.pending.length]);
    if (sig === lastSig) return;
    if (editing || root.querySelector('input:focus, select:focus')) return; // the next tick re-renders
    lastSig = sig;
    render();
  }

  pages.sandbox = {
    render(el, p) {
      // Former tabs of this page live in «Агенты» and «Решения» now.
      const moved = { open: '#/agents', profiles: '#/agents', review: '#/decisions' }[p.get('tab')];
      if (moved) { location.replace(moved); return null; }
      root = el; editing = null;
      selected = p.get('id') || ''; isNew = !!p.get('new');
      el.classList.add('page-agents');
      fill(el, h('p', { class: 'muted' }, 'Загрузка…'));
      load().then(() => { lastSig = ''; render(); }).catch((e) => fill(el, h('div', { class: 'error' }, e.message)));
      timer = setInterval(poll, 3000);
      return () => { clearInterval(timer); el.classList.remove('page-agents'); root = null; };
    },
  };
})();
