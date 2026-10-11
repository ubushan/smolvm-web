'use strict';
// «Песочница» → «Шаблоны»: checkpoints of machines with agents installed; every task
// opens a clean copy of one. The other tabs of the section are «Агенты» and «Решения».

(() => {
  let root = null;
  let data = null;   // GET /ui/sandbox
  let timer = null;
  let lastSig = '';
  let editing = null; // 'new-template'

  const ago = (ms) => fmtAgo(Math.floor(ms / 1000));
  async function load() { data = await api('GET', '/ui/sandbox'); }

  // ---------- «Шаблоны»: a grid of template cards ----------
  function templatesCard() {
    const start = async (body, label) => {
      const m = state.machines.find((x) => x.name === body.source);
      if (m?.state === 'running' && !(await confirmDialog(label, `Машина ${body.source} будет перезапущена: smolvm делает чекпоинт только машины, запущенной с поддержкой ветвления. Запущенные в ней агенты остановятся.`, false, '', 'Продолжить')).ok) return;
      try { await api('POST', '/ui/sandbox/templates', body); toast('Шаблон готовится…', 'ok'); } catch (e) { toast(e.message, 'err', 12000); }
      editing = null; await load(); render();
    };
    const upgrade = async (t) => {
      const c = await confirmDialog('Обновить агента?', `В исходной машине ${t.source} установится последняя версия агентов, затем шаблон снимется заново. Машина перезапустится; открытые песочницы работают на старой версии до закрытия.`, false, '', 'Обновить');
      if (!c.ok) return;
      try { await api('POST', `/ui/sandbox/templates/${enc(t.id)}/upgrade`, {}); toast('Обновление началось', 'ok'); } catch (e) { toast(e.message, 'err', 12000); }
      await load(); render();
    };
    const cards = data.templates.map((t) => {
      const job = t.upgrade?.status === 'running' ? t.upgrade : t.job;
      const running = job?.status === 'running';
      const status = running ? h('span', { class: 'badge prep' }, h('i', { class: 'spin' }), job.step)
        : t.upgrade?.status === 'error' ? h('span', { class: 'tag bad', title: t.upgrade.error }, 'обновление не удалось')
        : job?.status === 'error' ? h('span', { class: 'tag bad', title: job.error }, 'ошибка')
          : t.missing ? h('span', { class: 'tag bad' }, 'нет файла чекпоинта') : h('span', { class: 'tag ok' }, 'готов');
      const del = h('button', { class: 'btn ghost icon danger tpl-del', disabled: running, title: 'Удалить шаблон', 'aria-label': `Удалить шаблон «${t.title}»`, onclick: async () => {
        if (!(await confirmDialog('Удалить шаблон?', `Снимок «${t.title}» будет удалён. Исходная машина ${t.source} останется.`, false, '', 'Удалить')).ok) return;
        try { await api('DELETE', `/ui/sandbox/templates/${enc(t.id)}`); } catch (e) { toast(e.message, 'err'); }
        await load(); render();
      } }, ic('trash'));
      // Who uses it: the sandboxes open from it now, the agents that start from it.
      const open = data.sandboxes.filter((x) => x.template === t.id).length;
      const users = data.profiles.filter((p) => p.template === t.id || (p.preset && t.auto?.preset === p.preset && !!t.auto?.isolated === ((p.net || 'strict') === 'strict'))).length;
      const iso = t.egress?.enabled && t.egress?.strict;
      const vers = Object.entries(t.versions || {});
      return h('div', { class: 'lst-card tpl-card' },
        h('div', { class: 'lst-head' }, t.agents ? mark(markOf(t)) : mark('vm'),
          h('div', { class: 'lst-title' }, h('b', {}, t.title), h('div', { class: 'muted small mono' }, t.auto ? 'образ программы · готовится сам' : `из машины ${t.source}`)),
          h('span', { class: 'spacer' }), t.creating ? null : del),
        h('div', { class: 'tpl-status' }, status,
          h('span', { class: 'muted small' }, open ? `Сейчас песочниц: ${open}` : 'Сейчас не используется', users ? ` · агентов: ${users}` : '')),
        job?.status === 'error' ? h('div', { class: 'error small' }, job.error) : null,
        t.updates?.length ? h('div', { class: 'tpl-update' }, ic('refresh'), h('span', {}, 'Доступна новая версия: ', t.updates.map((u) => `${u.cmd} ${u.have} → ${u.latest}`).join(', '))) : null,
        t.cpus ? h('div', { class: 'sbx-facts' },
          h('div', {}, h('span', { class: 'muted small' }, 'Ресурсы'), h('div', {}, `${t.cpus} vCPU · ${fmtMb(t.memoryMb)}`)),
          h('div', {}, h('span', { class: 'muted small' }, 'Снимок'), h('div', {}, t.size ? fmtBytes(t.size) : '—')),
          h('div', {}, h('span', { class: 'muted small' }, 'Обновлён'), h('div', { class: 'small' }, t.updatedAt ? ago(t.updatedAt) : '—'))) : null,
        t.creating ? null : h('div', { class: 'tpl-actions' },
          h('button', { class: `btn small-btn${t.updates?.length ? ' primary' : ''}`, disabled: running, title: 'Установить последнюю версию агентов в исходной машине и снять шаблон заново', onclick: () => upgrade(t) }, ic('download'), 'Обновить агента'),
          h('button', { class: 'btn ghost small-btn', disabled: running, title: 'Снять шаблон заново, ничего не обновляя (например, после ваших изменений в машине)', onclick: () => start({ source: t.source, id: t.id }, 'Снять шаблон заново?') }, ic('refresh'), 'Снять заново')),
        // What is inside: the OCI image, the agents with versions, the isolation.
        h('dl', { class: 'tpl-sum' },
          h('dt', {}, 'Образ OCI'), h('dd', { class: 'mono' }, t.image || '—'),
          h('dt', {}, 'Агенты'), h('dd', {}, vers.length ? vers.map(([c, v]) => `${AGENT_TITLES[c] || c} ${v}`).join(', ') : (t.agents?.agents || []).filter((x) => x !== 'terminal').map((x) => AGENT_TITLES[x] || x).join(', ') || '—'),
          h('dt', {}, 'Изоляция'), h('dd', {}, iso ? 'жёсткая (обойти фильтр нельзя)' : t.egress?.enabled ? 'фильтр без изоляции' : 'без ограничений')));
    });
    const add = editing === 'new-template' ? newTemplateForm(start) : h('button', { type: 'button', class: 'lst-card lst-add tpl-card', onclick: () => { editing = 'new-template'; render(); } },
      h('span', { class: 'lst-add-ic' }, ic('plus')), h('b', {}, 'Новый шаблон'), h('span', { class: 'muted small' }, 'из машины с установленными агентами'));
    const check = h('button', { class: 'btn small-btn', onclick: async () => {
      check.disabled = true;
      try { await api('POST', '/ui/sandbox/updates/check', {}); } catch (e) { toast(e.message, 'err'); }
      await load(); render();
    } }, ic('refresh'), 'Проверить обновления');
    return [h('div', { class: 'row' }, h('span', { class: 'muted small' }, 'Новые версии агентов проверяются раз в сутки.'), h('span', { class: 'spacer' }), check),
      h('div', { class: 'lst-grid' }, ...cards, add),
      h('details', { class: 'card' }, h('summary', {}, h('b', {}, 'Как подготовить шаблон')),
        h('ul', { class: 'small' },
          h('li', {}, 'Создайте обычную машину с пресетом агента: секреты, фильтр «Сеть», нужные пакеты, MCP-серверы через npx. Запустите и дождитесь установки агентов.'),
          h('li', {}, 'Машина перезапускается с поддержкой ветвления — на macOS smolvm иначе не делает чекпоинт.'),
          h('li', {}, 'Нельзя: подключённые папки компьютера, GPU/CUDA, том корпоративных сертификатов для скачивания образа.'),
          h('li', {}, 'Песочницы получают правила «Сети» и секреты исходной машины на момент создания шаблона, но со своими токенами.'),
          h('li', {}, 'Обновили агентов или пакеты в исходной машине — нажмите «Обновить».')))];
  }

  function newTemplateForm(start) {
    const candidates = state.machines.filter((m) => state.marks?.[m.name] && !state.marks[m.name].sandbox);
    const close = h('button', { class: 'btn ghost icon', title: 'Закрыть', onclick: () => { editing = null; render(); } }, ic('x'));
    if (!candidates.length) {
      return h('div', { class: 'lst-card lst-edit' }, h('div', { class: 'lst-head' }, h('span', { class: 'mark m-icon' }, ic('plus')), h('b', {}, 'Новый шаблон'), h('span', { class: 'spacer' }), close),
        h('p', { class: 'muted' }, 'Нет машин с агентами. Создайте машину с пресетом агента («Создать»), запустите её и дождитесь установки.'));
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

  // ---------- render ----------
  function render() {
    if (!root || !data) return;
    const y = root.scrollTop;
    fill(root, sandboxHeader('templates', data), ...templatesCard());
    root.scrollTop = y;
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
      fill(el, h('p', { class: 'muted' }, 'Загрузка…'));
      load().then(() => { lastSig = ''; render(); }).catch((e) => fill(el, h('div', { class: 'error' }, e.message)));
      timer = setInterval(poll, 3000);
      return () => { clearInterval(timer); root = null; };
    },
  };
})();
