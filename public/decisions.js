'use strict';
// «Входящие» (#/decisions): everything the agents cannot do without a person —
// network and API requests waiting right now, task branches waiting for a decision,
// memory and settings an agent wants to keep (profile review), project changes
// waiting in review copies.

(() => {
  let root = null;
  let data = null;       // GET /ui/sandbox
  let approvals = [];    // GET /ui/live
  let tasks = [];        // GET /ui/tasks
  let copies = [];       // [{ machine, dir, changes }]
  let today = [];        // audit entries of the decisions made today
  let slowAt = 0;
  let timer = null;
  let tick = null;
  let lastSig = '';

  const AGENTS = { terminal: 'Терминал', claude: 'Claude Code', opencode: 'OpenCode', 'opencode-tui': 'OpenCode TUI', dsh: 'DSH', codex: 'Codex', pi: 'Pi', hermes: 'Hermes' };
  const risky = (p) => /claude-mcp\.json$|settings\.json$|opencode\.json$|config\.toml$|config\.yaml$|\/(skills|hooks|agents|commands|plugin|extensions)\//.test(p);
  const short = (p) => String(p || '').replace(/^\/(Users|home)\/[^/]+/, '~');
  const base = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || p;
  const plural = (n, one, few, many) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many}`;
  // «Claude · бэкенд»: the agent and the workspace behind a machine.
  const who = (machine) => {
    const x = data?.sandboxes.find((s) => s.name === machine);
    if (!x) return machine;
    const p = data.profiles.find((y) => y.id === x.profile);
    return [AGENTS[x.agent] || null, p ? p.name : 'разовая задача'].filter(Boolean).join(' · ');
  };

  async function load() {
    const [d, live, t] = await Promise.all([api('GET', '/ui/sandbox'), api('GET', '/ui/live').catch(() => ({})), api('GET', '/ui/tasks').catch(() => ({ tasks }))]);
    data = d; approvals = live.approvals || []; tasks = t.tasks || [];
    // Review copies and the audit: every 10 s.
    if (Date.now() - slowAt > 10000) {
      slowAt = Date.now();
      const names = [...new Set([...data.sandboxes.filter((x) => x.state === 'running').map((x) => x.name),
        ...(state.machines || []).filter((m) => m.state === 'running').map((m) => m.name)])];
      const out = [];
      await Promise.all(names.map(async (n) => {
        const r = await api('GET', `/ui/machines/${enc(n)}/review`).catch(() => null);
        for (const dir of (r?.dirs || []).filter((y) => y.state === 'ready')) {
          const c = await api('GET', `/ui/machines/${enc(n)}/review/${enc(dir.id)}`).catch(() => null);
          if (c?.changes?.length) out.push({ machine: n, dir, changes: c.changes });
        }
      }));
      copies = out.sort((a, b) => a.machine.localeCompare(b.machine));
      const start = new Date(); start.setHours(0, 0, 0, 0);
      const au = await api('GET', '/ui/audit?limit=300').catch(() => ({ entries: [] }));
      today = (au.entries || []).filter((e) => new Date(e.ts) >= start && /^(подтверждение:|ревью:|песочницы: изменения профиля)/.test(e.action || ''));
    }
  }

  async function decide(a, decision, btns) {
    btns.forEach((b) => { b.disabled = true; });
    try { await api('POST', `/ui/approvals/${a.id}`, { decision }); } catch (e) { toast(e.message, 'err'); }
    slowAt = 0;
    await refresh();
  }

  // ---------- cards ----------
  function askCard(a) {
    const left = h('span', { 'data-exp': a.expiresAt, 'data-total': a.expiresAt - a.createdAt });
    const btns = [];
    const b = (cls, label, decision) => { const x = h('button', { class: `btn ${cls} needs-operator`, onclick: () => decide(a, decision, btns) }, label); btns.push(x); return x; };
    const net = a.kind === 'net';
    return h('article', { class: 'dc-card' },
      h('div', { class: 'dc-meta' }, h('b', {}, who(a.machine)), h('span', {}, net ? 'хочет зайти на сайт' : 'хочет вызвать API'), h('span', { class: 'spacer' }), left),
      h('div', { class: 'dc-title' }, h('span', { class: 'mono' }, a.title),
        net ? null : h('span', { class: 'muted' }, ` — ключ ${a.detail?.secret || ''}${a.detail?.rule ? `, правило «${a.detail.rule}»` : ''}`)),
      a.waiting > 1 ? h('div', { class: 'muted small' }, `ждут ${plural(a.waiting, 'запрос', 'запроса', 'запросов')}`) : null,
      h('div', { class: 'dc-actions' },
        net ? [b('ink', 'Разрешить всегда', 'always'), b('', 'На 10 минут', 'once')] : b('ink', 'Разрешить', 'once'),
        b('danger-outline', 'Запретить', 'deny')));
  }

  // A run whose branch waits (the agent stopped, or its kept machine goes on): accept or
  // discard on the run's screen.
  function branchCard(t) {
    const g = t.git.filter((x) => x.state === 'ready');
    const n = g.reduce((s, x) => s + (x.commits || 0), 0);
    const prof = data.profiles.find((y) => y.id === t.profile);
    return h('article', { class: 'dc-card row' },
      h('div', { class: 'dc-grow' },
        h('div', { class: 'dc-meta' }, h('b', {}, prof?.name || AGENTS[t.agent] || t.agent || 'агент'), h('span', {}, t.closedAt ? 'закончил работу' : 'прислал изменения')),
        h('div', { class: 'dc-title' }, t.title),
        h('div', { class: 'muted small' }, `${plural(n, 'коммит', 'коммита', 'коммитов')} в ${g.map((x) => `${base(x.hostPath)} (${x.branch})`).join(', ')} · ваша директория не менялась`)),
      h('a', { class: 'btn primary', href: `#/tasks?id=${enc(t.id)}` }, 'Посмотреть и решить'));
  }

  function memoryCard(x) {
    const p = data.profiles.find((y) => y.id === x.profile);
    const exec = x.changes.filter((c) => risky(c.path) && c.kind !== 'deleted');
    return h('article', { class: `dc-card${exec.length ? ' warn' : ''}` },
      h('div', { class: 'dc-meta' }, h('b', {}, p ? p.name : x.profile), h('span', {}, 'хочет запомнить'),
        h('span', { class: 'spacer' }), exec.length ? h('span', { class: 'ag-pill warn' }, 'проверьте') : null),
      h('div', { class: 'dc-title' }, plural(x.changes.length, 'изменение', 'изменения', 'изменений'), ' в памяти и настройках агента'),
      h('div', { class: 'dc-files' }, ...x.changes.slice(0, 5).map((c) => h('div', { class: risky(c.path) && c.kind !== 'deleted' ? 'hot' : '' },
        { added: '+ ', modified: '~ ', deleted: '− ' }[c.kind] || '', c.path.replace(/^\.smolvm-profile\/claude-mcp\.json$/, '~/.claude.json → mcpServers'))),
        x.changes.length > 5 ? h('div', { class: 'muted' }, `и ещё ${x.changes.length - 5}`) : null),
      exec.length ? h('div', { class: 'small badc' }, 'Среди них skills, MCP или настройки — они будут запускаться в каждой следующей сессии. Посмотрите, нет ли там чужих команд.') : null,
      h('div', { class: 'dc-actions' }, h('a', { class: 'btn primary', href: `#/review?id=${enc(x.id)}` }, 'Посмотреть и решить')));
  }

  function projectCard(c) {
    const add = c.changes.filter((y) => y.kind === 'added').length;
    const del = c.changes.filter((y) => y.kind === 'deleted').length;
    const conflict = c.changes.filter((y) => y.conflict).length;
    return h('article', { class: 'dc-card row' },
      h('div', { class: 'dc-grow' },
        h('div', { class: 'dc-meta' }, h('b', {}, who(c.machine)), h('span', {}, 'хочет записать изменения в проект')),
        h('div', { class: 'dc-title', title: c.dir.hostPath }, `${plural(c.changes.length, 'файл', 'файла', 'файлов')} в ${base(c.dir.hostPath)}`,
          h('span', { class: 'muted' }, [add ? ` · новых ${add}` : '', del ? ` · удалено ${del}` : '', conflict ? ` · ${conflict} изменились и у вас` : ''].join(''))),
        h('div', { class: 'muted small' }, 'Пока вы не проверите, на диске ничего не меняется.')),
      h('a', { class: 'btn primary', href: `#/?machine=${enc(c.machine)}&tab=folders` }, 'Посмотреть и применить'));
  }

  function side() {
    const working = tasks.filter((t) => !t.closedAt && ['working', 'waiting', 'opening'].includes(t.status)).map((t) => h('div', { class: 'dc-side-card' },
      h('b', {}, data.profiles.find((y) => y.id === t.profile)?.name || t.title),
      h('span', { class: `small ${t.status === 'waiting' ? 'warnc' : 'muted'}` }, t.status === 'waiting' ? 'ждёт вашего ответа' : t.status === 'opening' ? 'открывается' : AGENTS[t.agent] || 'работает'),
      t.profile ? h('a', { class: 'small', href: `#/agents?id=${enc(t.profile)}` }, 'Открыть агента') : h('a', { class: 'small', href: `#/tasks?id=${enc(t.id)}` }, 'Открыть')));
    const said = today.slice(0, 8).map((e) => h('div', {},
      e.action.replace(/^подтверждение: /, '').replace(/^ревью: /, 'проект: ').replace(/^песочницы: изменения профиля/, 'память агента:'),
      e.detail?.title ? h('span', { class: 'mono' }, ` ${e.detail.title}`) : null,
      e.machine ? h('span', { class: 'muted' }, ` · ${who(e.machine)}`) : null));
    return h('aside', { class: 'dc-side' },
      h('div', { class: 'label-like' }, 'Сейчас работают'),
      ...(working.length ? working : [h('div', { class: 'muted small' }, 'Никто. ', h('a', { href: '#/agents' }, 'Агенты'))]),
      h('div', { class: 'label-like dc-gap' }, 'Решено сегодня'),
      h('div', { class: 'dc-said small' }, ...(said.length ? said : [h('span', { class: 'muted' }, 'Пока ничего')])),
      h('a', { class: 'small', href: '#/audit' }, 'Вся история →'));
  }

  function render() {
    if (!root || !data) return;
    const y = root.querySelector('.tab-body')?.scrollTop || 0;
    const branches = tasks.filter((t) => t.git.some((g) => g.state === 'ready'));
    const cards = [...approvals.map(askCard), ...branches.map(branchCard), ...data.pending.map(memoryCard), ...copies.map(projectCard)];
    fill(root, h('div', { class: 'layout dc-only' },
      h('section', { class: 'panel detail-panel' },
        h('div', { class: 'detail-head' }, h('span', { class: 'mark m-icon' }, ic('bell')),
          h('div', { class: 'ag-title' }, h('h2', {}, 'Входящие'), h('span', { class: 'muted small' }, 'Всё, что агенты не могут сделать сами: запросы, ветки на проверку, память. Ответьте — и они продолжат работу.'))),
        h('div', { class: 'tab-body' }, h('div', { class: 'dc-wrap' },
          h('div', { class: 'dc-main' },
            ...(cards.length ? cards : [h('section', { class: 'card ws-empty' }, ic('check-circle'), h('h3', {}, 'Всё решено'),
              h('p', { class: 'muted' }, 'Когда агент захочет на новый сайт, закончит задачу с изменениями в проекте или захочет запомнить навык, вопрос появится здесь.'))])),
          side())))));
    const tb = root.querySelector('.tab-body');
    if (tb) tb.scrollTop = y;
    countdown();
  }

  function countdown() {
    root?.querySelectorAll('[data-exp]').forEach((el) => {
      const s = Math.max(0, Math.round((Number(el.dataset.exp) - Date.now()) / 1000));
      const t = Math.round(Number(el.dataset.total) / 1000);
      const f = (n) => `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
      el.textContent = `осталось ${f(s)} из ${f(t)}`;
      el.classList.toggle('badc', s < 20);
    });
  }

  async function refresh() {
    try { await load(); } catch { return; }
    lastSig = ''; render();
  }

  async function poll() {
    if (!root || document.hidden) return;
    try { await load(); } catch { return; }
    const sig = JSON.stringify([approvals.map((a) => [a.id, a.waiting]), data.pending.map((x) => [x.id, x.changes.length]), tasks.map((t) => [t.id, t.status, t.git.map((g) => g.state)]),
      copies.map((c) => [c.machine, c.dir.id, c.changes.length]), today.length, data.sandboxes.map((x) => [x.name, x.opening])]);
    if (sig === lastSig) return;
    lastSig = sig;
    render();
  }

  pages.decisions = {
    render(el) {
      root = el; slowAt = 0;
      el.classList.add('page-agents');
      fill(el, h('p', { class: 'muted' }, 'Загрузка…'));
      load().then(() => { lastSig = ''; render(); }).catch((e) => fill(el, h('div', { class: 'error' }, e.message)));
      timer = setInterval(poll, 2000);
      tick = setInterval(countdown, 1000);
      return () => { clearInterval(timer); clearInterval(tick); el.classList.remove('page-agents'); root = null; };
    },
  };
})();
