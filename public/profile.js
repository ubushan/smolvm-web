'use strict';
// Page «Профиль агента» (#/profile?id=…): what a workspace carries from sandbox
// to sandbox, by kind — instructions, MCP and settings, skills, subagents and
// commands, memory, hooks — with an editor for each file.

(() => {
  let root = null;
  let id = '';
  let prof = null;      // profile from GET /ui/sandbox
  let tpl = null;
  let files = [];       // [{ path, size, binary }]
  let section = 'instructions';
  let open = '';        // path in the editor

  const AGENTS = { claude: 'Claude Code', opencode: 'OpenCode', codex: 'Codex', pi: 'Pi', hermes: 'Hermes', dsh: 'Harness' };
  const MARKS = { claude: 'claude', opencode: 'opencode', codex: 'codex', pi: 'pi', hermes: 'hermes', dsh: 'dsh' };
  const showPath = (p) => (p === '.smolvm-profile/claude-mcp.json' ? '~/.claude.json → mcpServers' : `~/${p}`);
  const SECTIONS = [
    ['instructions', 'Инструкции', (p) => /^(\.claude\/CLAUDE|\.codex\/AGENTS|\.config\/opencode\/AGENTS|\.pi\/agent\/(AGENTS|SYSTEM)|\.hermes\/SOUL)\.md$/.test(p)],
    ['mcp', 'MCP и настройки', (p) => /claude-mcp\.json$|\.claude\/settings\.json$|opencode\.json$|\.codex\/config\.toml$|\.hermes\/config\.yaml$|\.pi\/agent\/(settings|models)\.json$/.test(p)],
    ['skills', 'Skills', (p) => /(^|\/)skills\//.test(p)],
    ['agents', 'Подагенты и команды', (p) => /\/(agents|agent|commands|command|prompts|output-styles)\//.test(p)],
    ['memory', 'Память', (p) => /(^|\/)(memory|memories)\//.test(p)],
    ['hooks', 'Хуки и плагины', (p) => /\/(hooks|plugin|extensions|themes)\//.test(p)],
    ['other', 'Прочее', () => true],
  ];
  const sectionOf = (p) => SECTIONS.find(([, , test]) => test(p))[0];
  const inSection = (sec) => files.filter((f) => sectionOf(f.path) === sec);

  async function load() {
    const d = await api('GET', '/ui/sandbox');
    prof = d.profiles.find((p) => p.id === id) || null;
    if (!prof) return;
    tpl = d.templates.find((t) => t.id === prof.template) || null;
    files = (await api('GET', `/ui/sandbox/profiles/${enc(id)}/files`)).files;
  }

  async function editor(box) {
    if (!open) {
      box.replaceChildren(h('div', { class: 'pf-empty muted' }, inSection(section).length ? 'Выберите файл слева.' : 'В этом разделе пока ничего нет. Агент добавит сюда файлы сам, или создайте файл кнопкой «Новый файл».'));
      return;
    }
    box.replaceChildren(h('p', { class: 'muted small pf-pad' }, 'Загрузка…'));
    let f;
    try { f = await api('GET', `/ui/sandbox/profiles/${enc(id)}/file?path=${enc(open)}`); } catch (e) { box.replaceChildren(h('div', { class: 'error' }, e.message)); return; }
    const head = h('div', { class: 'pf-ed-head' }, h('b', { class: 'mono' }, showPath(open)), h('span', { class: 'muted small' }, fmtBytes(f.size)), h('span', { class: 'spacer' }));
    if (f.binary) { box.replaceChildren(head, h('p', { class: 'muted pf-pad' }, 'Бинарный файл — редактирование недоступно.')); return; }
    const ta = h('textarea', { class: 'pf-text mono', spellcheck: 'false', 'aria-label': `Содержимое ${showPath(open)}` });
    ta.value = f.text;
    const save = h('button', { class: 'btn small-btn primary', disabled: true }, 'Сохранить');
    ta.addEventListener('input', () => { save.disabled = ta.value === f.text; });
    save.addEventListener('click', async () => {
      try { await api('PUT', `/ui/sandbox/profiles/${enc(id)}/file?path=${enc(open)}`, { text: ta.value }); toast('Сохранено', 'ok'); f.text = ta.value; save.disabled = true; await load(); render(true); }
      catch (e) { toast(e.message, 'err'); }
    });
    const del = h('button', { class: 'btn small-btn ghost', title: 'Удалить файл из профиля', onclick: async () => {
      if (!(await confirmDialog('Удалить файл из профиля?', showPath(open), false, '', 'Удалить')).ok) return;
      try { await api('DELETE', `/ui/sandbox/profiles/${enc(id)}/file?path=${enc(open)}`); open = ''; await load(); render(); } catch (e) { toast(e.message, 'err'); }
    } }, ic('trash'));
    head.append(del, save);
    box.replaceChildren(head, ta);
  }

  function newFile() {
    const hint = { instructions: '.claude/CLAUDE.md', mcp: '.smolvm-profile/claude-mcp.json', skills: '.claude/skills/имя/SKILL.md', agents: '.claude/agents/имя.md', memory: '.claude/projects/имя/memory/заметка.md', hooks: '.claude/hooks/имя.sh', other: '' }[section];
    const inp = h('input', { class: 'input mono', id: 'pf-new-path', value: hint, placeholder: 'путь от домашней папки агента' });
    const dlg = h('dialog', { class: 'dialog small' },
      h('header', {}, h('h3', {}, 'Новый файл профиля'), h('button', { type: 'button', class: 'btn ghost icon', 'aria-label': 'Закрыть', onclick: () => dlg.close() }, ic('x'))),
      h('div', { class: 'dialog-body' }, h('label', { for: 'pf-new-path' }, 'Путь (от ~ агента)', inp),
        h('p', { class: 'muted small' }, 'Попадёт в домашнюю папку агента при следующем открытии песочницы. Файл вне стандартных путей профиля обратно не забирается — при закрытии он будет показан как удалённый.')),
      h('footer', {}, h('button', { class: 'btn', onclick: () => dlg.close() }, 'Отмена'), h('button', { class: 'btn primary', onclick: async () => {
        const p = inp.value.trim().replace(/^~\//, '');
        if (!p) return;
        try { await api('PUT', `/ui/sandbox/profiles/${enc(id)}/file?path=${enc(p)}`, { text: '' }); dlg.close(); open = p; section = sectionOf(p); await load(); render(); }
        catch (e) { toast(e.message, 'err'); }
      } }, 'Создать')));
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
  }

  function render(keepEditor) {
    if (!root) return;
    if (!prof) {
      fill(root, h('section', { class: 'card ws-empty' }, ic('users'), h('h3', {}, 'Профиль не найден'), h('a', { class: 'btn primary', href: '#/work' }, 'К рабочим местам')));
      return;
    }
    const s = prof.summary || {};
    const review = h('input', { type: 'checkbox', checked: !prof.autoSave });
    review.addEventListener('change', async () => {
      try { await api('PUT', `/ui/sandbox/profiles/${enc(id)}`, { autoSave: !review.checked }); prof.autoSave = !review.checked; toast(review.checked ? 'Изменения профиля будут идти на проверку' : 'Изменения будут сохраняться без проверки', review.checked ? 'ok' : ''); }
      catch (e) { toast(e.message, 'err'); review.checked = !review.checked; }
    });
    const openBtn = h('button', { class: 'btn primary', disabled: !tpl || tpl.missing }, ic('play'), 'Открыть песочницу');
    openBtn.addEventListener('click', async () => {
      const w = prof.agent ? agentTab() : null;
      openBtn.disabled = true;
      try {
        const r = await api('POST', '/ui/sandbox/open', { template: tpl.id, profile: id, agent: prof.agent || null });
        if (r.url) goAgent(w, r.url); else if (w) w.close();
        refreshMachines();
        location.hash = `#/session?name=${enc(r.name)}`;
      } catch (e) { if (w) w.close(); toast(e.message, 'err', 12000); openBtn.disabled = false; }
    });

    const nav = h('div', { class: 'pf-nav' }, ...SECTIONS.filter(([sec]) => sec !== 'other' || inSection('other').length).map(([sec, title]) => {
      const n = inSection(sec).length;
      return h('button', { type: 'button', class: `pf-sec${sec === section ? ' on' : ''}`, onclick: () => { section = sec; open = inSection(sec)[0]?.path || ''; render(); } },
        h('span', {}, title), h('span', { class: 'muted' }, String(n)));
    }));
    const list = inSection(section);
    if (!keepEditor && open && sectionOf(open) !== section) open = list[0]?.path || '';
    if (!open && list.length && !keepEditor) open = list[0].path;
    const fileList = h('div', { class: 'pf-files-list' }, ...list.map((f) => h('button', { type: 'button', class: `pf-file-btn${f.path === open ? ' on' : ''}`, title: showPath(f.path), onclick: () => { open = f.path; render(); } },
      h('span', { class: 'mono small ellipsis' }, showPath(f.path)), h('span', { class: 'muted small' }, fmtBytes(f.size)))),
      h('button', { type: 'button', class: 'btn ghost small-btn', onclick: newFile }, ic('plus'), 'Новый файл'));
    const edBox = h('div', { class: 'pf-editor' });

    fill(root,
      h('div', { class: 'pf-top' },
        h('a', { href: '#/work' }, '← Рабочие места'), h('span', { class: 'spacer' }),
        h('label', { class: 'check' }, review, ' Проверять изменения перед сохранением'),
        openBtn),
      h('div', { class: 'pf-title' },
        mark(MARKS[prof.agent] || 'vm'),
        h('div', {}, h('h1', {}, prof.name), h('div', { class: 'muted small' }, [AGENTS[prof.agent] || 'агент не выбран', tpl ? `шаблон «${tpl.title}»` : 'шаблон не выбран', `${prof.files} файлов, ${fmtBytes(prof.size)}`].join(' · ')))),
      h('div', { class: 'pf-layout' },
        h('div', { class: 'pf-side' }, nav,
          s.secrets?.length ? h('div', { class: 'ws-notice pf-secret' },
            h('span', {}, h('b', {}, 'Токен открытым текстом. '), `${s.secrets.map((x) => `${showPath(x.file)} → ${x.key}`).join('; ')}. Он попадёт в каждую песочницу, и агент его видит.`),
            h('a', { href: '#', onclick: (e) => { e.preventDefault(); openSettings('secrets'); } }, 'Перенести в «Секреты» (через шлюз)')) : null,
          h('p', { class: 'muted small' }, 'Входы, токены, сессии и кэши в профиль не попадают никогда.')),
        h('div', { class: 'pf-main' }, fileList, edBox)));
    editor(edBox);
  }

  pages.profile = {
    render(el, p) {
      root = el; id = p.get('id') || ''; open = ''; section = 'instructions';
      fill(el, h('p', { class: 'muted' }, 'Загрузка…'));
      load().then(() => {
        if (prof && !inSection('instructions').length) section = SECTIONS.find(([sec]) => inSection(sec).length)?.[0] || 'instructions';
        render();
      }).catch((e) => fill(el, h('div', { class: 'error' }, e.message)));
      return () => { root = null; };
    },
  };
})();
