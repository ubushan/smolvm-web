'use strict';
// «Песочница» → a session (#/session?name=…): the panel of the section on the left
// (decisions, sessions, templates), the chosen session on the right with tabs —
// «Программы» (each opens in its own browser tab), «Что сделал» (in plain words, from the
// audit and the network log), «Решения» (what it waits for), «Что изменится» on «Закончить».

(() => {
  let root = null;
  let name = '';
  let data = null;      // GET /ui/sandbox
  let isolated = {};
  let approvals = [];
  let net = [];         // egress log of this machine since it opened
  let events = [];      // audit of this machine
  let trif = null;      // GET /ui/machines/:n/risk
  let copies = [];      // review copies with their changes
  let preview = null;   // profile changes: { changes } | { error } | 'loading'
  let slowAt = 0;
  let timer = null;
  let lastSig = '';

  const AGENTS = { terminal: 'Терминал', claude: 'Claude Code', opencode: 'OpenCode', 'opencode-tui': 'OpenCode TUI', dsh: 'DSH', codex: 'Codex', pi: 'Pi', hermes: 'Hermes' };
  const left = (ts) => {
    const m = Math.max(0, Math.round((ts - Date.now()) / 60000));
    return m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч ${m % 60} мин`;
  };
  const time = (ts) => new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const base = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || p;
  const plural = (n, one, few, many) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many}`;
  const sbx = () => data?.sandboxes.find((x) => x.name === name) || null;
  const tplOf = (id) => data.templates.find((t) => t.id === id) || null;
  const profOf = (id) => data.profiles.find((p) => p.id === id) || null;
  const risky = (p) => /claude-mcp\.json$|settings\.json$|opencode\.json$|config\.toml$|config\.yaml$|\/(skills|hooks|agents|commands|plugin|extensions)\//.test(p);
  const mainAgent = (x, agentId = null) => {
    const ids = x.agents.map((a) => a.id);
    return agentId && ids.includes(agentId) ? agentId : x.agent && ids.includes(x.agent) ? x.agent : ids.find((id) => id !== 'terminal') || ids[0] || null;
  };

  async function load() {
    const [d, live] = await Promise.all([api('GET', '/ui/sandbox'), api('GET', '/ui/live').catch(() => ({}))]);
    data = d; isolated = live.isolated || {}; approvals = live.approvals || [];
    if (!name || !sbx()) name = data.sandboxes[0]?.name || '';
    if (!name) { net = []; events = []; return; }
    const x = sbx();
    const since = x.createdAt;
    const [lg, au] = await Promise.all([
      api('GET', `/ui/egress/log?machine=${enc(name)}&limit=1000`).catch(() => ({ entries: [] })),
      api('GET', `/ui/audit?machine=${enc(name)}&limit=80`).catch(() => ({ entries: [] })),
    ]);
    net = (lg.entries || []).filter((e) => new Date(e.ts).getTime() >= since);
    events = (au.entries || []).filter((e) => new Date(e.ts).getTime() >= since - 60000);
    if (Date.now() - slowAt > 10000 && x.state === 'running' && !x.opening) {
      slowAt = Date.now();
      trif = (await api('GET', `/ui/machines/${enc(name)}/risk`).catch(() => null))?.trifecta || null;
      const r = await api('GET', `/ui/machines/${enc(name)}/review`).catch(() => null);
      copies = await Promise.all((r?.dirs || []).filter((y) => y.state === 'ready').map(async (dir) =>
        ({ dir, changes: (await api('GET', `/ui/machines/${enc(name)}/review/${enc(dir.id)}`).catch(() => null))?.changes || [] })));
    }
  }

  // ---------- actions ----------
  // A program of the sandbox opens in its own browser tab (the session screen is the control).
  async function openProgram(x, id, btn) {
    const w = agentTab();
    if (btn) btn.disabled = true;
    try { goAgent(w, (await api('POST', `/ui/machines/${enc(x.name)}/agents/${enc(id)}/start`, {})).url); }
    catch (e) { if (w) w.close(); toast(e.message, 'err', 10000); }
    if (btn) btn.disabled = false;
  }
  async function finish(x, keep) {
    const p = profOf(x.profile);
    const proj = copies.reduce((n, c) => n + c.changes.length, 0);
    if (!keep) {
      const c = await confirmDialog('Закончить без сохранения?', `Машина ${x.name} будет удалена${p ? ', то, что агент запомнил, пропадёт' : ''}${proj ? `, непроверенные изменения проекта (${proj}) — тоже` : ''}.`, false, '', 'Удалить');
      if (!c.ok) return;
    } else if (proj) {
      const c = await confirmDialog('Сначала проверьте проект', `В копии проекта ${plural(proj, 'изменённый файл', 'изменённых файла', 'изменённых файлов')}. После закрытия машины копия пропадёт — примените нужное сейчас.`, false, '', 'Закрыть всё равно');
      if (!c.ok) { location.hash = `#/dirs?tab=folders&machine=${enc(x.name)}`; return; }
    }
    try {
      const r = await api('POST', `/ui/sandbox/machines/${enc(x.name)}/close`, { save: keep && !!p });
      refreshMachines();
      agentInTab(x.name, false);
      if (r.pending) { toast(`Готово. На проверку: ${plural(r.changes, 'изменение', 'изменения', 'изменений')} памяти агента`, 'ok', 8000); location.hash = `#/review?id=${enc(r.pending)}`; return; }
      toast(r.applied ? `Готово, сохранено в память агента: ${r.applied}` : 'Готово, машина удалена', 'ok');
    } catch (e) { toast(e.message, 'err', 12000); return; }
    name = '';
    location.hash = '#/session';
  }
  async function decide(a, decision) {
    try { await api('POST', `/ui/approvals/${a.id}`, { decision }); } catch (e) { toast(e.message, 'err'); }
    await refresh();
  }
  async function checkChanges() {
    preview = 'loading'; render();
    try { preview = await api('GET', `/ui/sandbox/machines/${enc(name)}/changes`); }
    catch (e) { preview = { error: e.message }; }
    render();
  }

  // ---------- the panel on the right: the chosen session ----------
  let tab = 'programs'; // programs | did | decisions | changes
  function head(x) {
    const p = profOf(x.profile);
    const iso = isolated[x.name];
    const pill = iso ? ['bad', 'остановлен вами']
      : !trif ? ['neutral', x.opening || 'проверяю…']
      : trif.lethal ? ['bad', 'риск утечки']
      : trif.untrustedLevel === 'open' ? ['warn', 'интернет открыт']
      : ['ok', 'безопасно'];
    const why = trif ? [trif.untrustedWhy, trif.lethal ? `У агента есть ${trif.privateData.join(', ')} и выход наружу.` : null, trif.note].filter(Boolean).join('\n') : '';
    const mins = Math.max(0, Math.round((Date.now() - x.createdAt) / 60000));
    return h('div', { class: 'detail-head' },
      mark(x.agents.find((a) => a.id === mainAgent(x))?.mark || 'vm'),
      h('div', { class: 'ag-title' },
        h('h2', {}, p ? p.name : 'Разовая задача'),
        h('span', { class: 'muted small' }, [AGENTS[mainAgent(x)] || null, h('span', { class: 'mono' }, x.name), `открыта ${mins < 60 ? `${mins} мин` : `${Math.floor(mins / 60)} ч ${mins % 60} мин`} назад`]
          .filter(Boolean).flatMap((v, i) => (i ? [' · ', v] : [v])))),
      h('span', { class: `ag-pill ${pill[0]}`, title: why }, pill[1]),
      h('div', { class: 'actions' },
        x.expiresAt ? h('span', { class: `small ${x.expiresAt - Date.now() < 30 * 60000 ? 'warnc' : 'muted'}`, title: `Закроется сама ${new Date(x.expiresAt).toLocaleString('ru-RU')}` }, `осталось ${left(x.expiresAt)}`) : null,
        x.expiresAt ? h('button', { class: 'btn ghost small-btn', title: 'Продлить на 2 часа', onclick: async () => {
          try { await api('POST', `/ui/sandbox/machines/${enc(x.name)}/extend`, { hours: 2 }); toast('Продлено на 2 часа', 'ok'); } catch (e) { toast(e.message, 'err'); }
          await refresh();
        } }, '+2 ч') : null,
        iso ? null : h('button', { class: 'btn danger-outline', disabled: x.state !== 'running', title: 'Оборвать все соединения агента, заменить его токены и поставить машину на паузу',
          onclick: async () => { await actions.isolate(state.machines.find((m) => m.name === x.name) || { name: x.name }); await refresh(); } }, 'Остановить всё'),
        p ? h('button', { class: 'btn ghost', title: 'Удалить машину, ничего не сохранять', onclick: () => finish(x, false) }, 'Без сохранения') : null,
        h('button', { class: 'btn ink', disabled: !!x.opening, title: p ? 'Забрать память агента на проверку и удалить машину' : 'Удалить машину', onclick: () => finish(x, true) }, p ? 'Закончить и проверить' : 'Закончить')));
  }

  // «Программы»: each opens in its own browser tab.
  function programsTab(x) {
    const busy = !!x.opening || x.state !== 'running' || !!isolated[x.name];
    const note = x.opening ? [h('i', { class: 'spin' }), ` ${x.opening}…`]
      : isolated[x.name] ? 'Агент остановлен: соединения оборваны, машина на паузе. Снять остановку можно на странице машины («Машины»).'
        : x.state !== 'running' ? `Машина ${x.state === 'missing' ? 'пропала' : 'не работает'}.` : null;
    const tiles = x.agents.map((a) => {
      const b = h('button', { type: 'button', class: 'aw-tile sx-prog', disabled: busy, title: `Открыть ${a.title || AGENTS[a.id] || a.id} в отдельной вкладке браузера`,
        onclick: () => openProgram(x, a.id, b) },
        h('span', { class: 'aw-tile-ic' }, mark(a.mark || 'term')),
        h('span', { class: 'aw-tile-text' }, h('b', {}, a.title || AGENTS[a.id] || a.id), h('span', { class: 'small sx-prog-open' }, 'открыть в новой вкладке ↗')));
      return b;
    });
    return [
      x.task ? h('div', { class: 'ag-task-line', title: x.task }, `Задача: «${x.task}»`) : null,
      note ? h('div', { class: 'muted small' }, ...[].concat(note)) : null,
      tiles.length ? h('div', { class: 'aw-tiles sx-progs' }, ...tiles) : h('p', { class: 'muted' }, 'В этой машине нет программ агента.'),
      h('div', { class: 'row' },
        h('span', { class: 'muted small' }, 'Программа открывается в отдельной вкладке браузера; здесь — контроль: что агент делает, что просит и что изменится.'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn small-btn', title: 'Дать агенту ещё одну папку', onclick: () => openFolderDialog({ machine: x.name, mode: 'review', onDone: () => { slowAt = 0; refresh(); } }) }, ic('folder'), 'Дать папку')),
    ];
  }

  function didLines(x) {
    const out = [];
    const hosts = new Map();
    for (const e of net) {
      const k = `${e.allow ? 'ok' : 'no'}|${e.host}`;
      const cur = hosts.get(k) || { allow: e.allow, host: e.host, n: 0, ts: 0 };
      cur.n++; cur.ts = Math.max(cur.ts, new Date(e.ts).getTime());
      hosts.set(k, cur);
    }
    for (const v of hosts.values()) out.push({ ts: v.ts, bad: !v.allow, text: `${v.allow ? 'Ходил на' : 'Не пустили на'} ${v.host}${v.n > 1 ? ` · ${plural(v.n, 'раз', 'раза', 'раз')}` : ''}` });
    for (const e of events) {
      if (/^песочница открыта$/.test(e.action)) { out.push({ ts: new Date(e.ts).getTime(), text: 'Агент получил чистую машину' }); continue; }
      const cmd = e.detail?.command ? ` ${String(e.detail.command).slice(0, 60)}` : '';
      out.push({ ts: new Date(e.ts).getTime(), bad: e.type === 'alert' || /запрещено|нет ответа/.test(e.action), text: `${e.action}${cmd}` });
    }
    for (const c of copies) if (c.changes.length) out.push({ ts: Date.now(), text: `Изменил ${plural(c.changes.length, 'файл', 'файла', 'файлов')} в копии ${base(c.dir.hostPath)}` });
    return out.sort((a, b) => b.ts - a.ts).slice(0, 40);
  }

  // «Что сделал»: sites, actions, project changes — in plain words.
  function didTab(x) {
    const lines = didLines(x);
    return [h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', {}, 'Что агент сделал'), h('span', { class: 'spacer' }), h('a', { class: 'small', href: `#/audit?machine=${enc(x.name)}` }, 'вся история')),
      lines.length ? h('div', { class: 'sx-did' }, ...lines.map((l) => h('div', { class: l.bad ? 'badc' : '' }, h('span', { class: 'mono muted' }, time(l.ts)), h('span', {}, l.text))))
        : h('p', { class: 'muted small' }, 'Пока ничего. Здесь появятся сайты, на которые ходил агент, и изменения в проекте.'))];
  }

  // «Решения»: what this session waits for.
  function decisionsTab(x) {
    const mine = approvals.filter((a) => a.machine === x.name).map((a) => h('section', { class: 'dc-card' },
      h('div', { class: 'dc-meta' }, h('span', {}, a.kind === 'net' ? 'хочет зайти на сайт' : `хочет вызвать API · ключ ${a.detail?.secret || ''}`)),
      h('div', { class: 'dc-title' }, h('span', { class: 'mono' }, a.title)),
      h('div', { class: 'dc-actions' },
        a.kind === 'net' ? [h('button', { class: 'btn ink', onclick: () => decide(a, 'always') }, 'Разрешить всегда'), h('button', { class: 'btn', onclick: () => decide(a, 'once') }, 'На 10 минут')]
          : h('button', { class: 'btn ink', onclick: () => decide(a, 'once') }, 'Разрешить'),
        h('button', { class: 'btn danger-outline', onclick: () => decide(a, 'deny') }, 'Запретить'))));
    const proj = copies.filter((c) => c.changes.length && !c.dir.readonly).map((c) => h('section', { class: 'dc-card row' },
      h('div', { class: 'dc-grow' }, h('div', { class: 'dc-meta' }, h('span', {}, 'хочет записать изменения в проект')),
        h('div', { class: 'dc-title', title: c.dir.hostPath }, `${plural(c.changes.length, 'файл', 'файла', 'файлов')} в ${base(c.dir.hostPath)}`)),
      h('a', { class: 'btn primary', href: `#/dirs?tab=folders&machine=${enc(x.name)}` }, 'Посмотреть и применить')));
    const all = [...mine, ...proj];
    return all.length ? all : [h('section', { class: 'card ws-empty' }, ic('shield'), h('h3', {}, 'Всё решено'),
      h('p', { class: 'muted' }, 'Когда агент попросит новый сайт или захочет записать изменения в проект, вопрос появится здесь.'))];
  }

  // «Что изменится»: the project copies and the agent's memory, before «Закончить».
  function changesTab(x) {
    const p = profOf(x.profile);
    const proj = copies.map((c) => {
      const add = c.changes.filter((y) => y.kind === 'added').length;
      const del = c.changes.filter((y) => y.kind === 'deleted').length;
      return h('div', { title: c.dir.hostPath }, `Проект ${base(c.dir.hostPath)}: `, c.dir.readonly ? 'только чтение — на диск не записывается'
        : c.changes.length ? `${plural(c.changes.length, 'файл', 'файла', 'файлов')}${add ? `, новых ${add}` : ''}${del ? `, удалено ${del}` : ''} — после вашей проверки` : 'пока без изменений');
    });
    let mem = null;
    if (p) {
      if (preview === 'loading') mem = h('div', { class: 'muted' }, h('i', { class: 'spin' }), ' Смотрю память агента…');
      else if (preview?.error) mem = h('div', { class: 'badc' }, preview.error);
      else if (preview) {
        const hot = preview.changes.filter((c) => risky(c.path) && c.kind !== 'deleted').length;
        mem = h('div', {}, preview.changes.length ? `Память агента: ${plural(preview.changes.length, 'изменение', 'изменения', 'изменений')}` : 'Память агента: без изменений',
          hot ? h('b', { class: 'warnc' }, ` · ${hot} в skills/MCP/настройках`) : null);
      } else mem = h('div', {}, p.autoSave ? 'Память агента сохранится сразу, без проверки' : 'Память агента — после вашей проверки');
    }
    const s = p?.summary;
    return [h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', {}, 'Что изменится, когда закончите')),
      h('div', { class: 'ss-list sx-change' }, ...proj, mem,
        !proj.length && !p ? h('div', { class: 'muted' }, 'Ничего: разовая задача без папок — машина просто удалится.') : null),
      h('div', { class: 'row' },
        p ? h('button', { class: 'btn small-btn', disabled: preview === 'loading' || x.state !== 'running', onclick: checkChanges }, preview && preview !== 'loading' ? 'Проверить снова' : 'Посмотреть заранее') : null,
        copies.some((c) => c.changes.length && !c.dir.readonly) ? h('a', { class: 'btn small-btn', href: `#/dirs?tab=folders&machine=${enc(x.name)}` }, 'Проверить проект') : null),
      p ? h('div', { class: 'muted small' }, `Агент начал с памяти «${p.name}»: ${[s?.mcp?.length ? `MCP ${s.mcp.length}` : null, s?.skills ? `skills ${s.skills}` : null, s?.memory ? `записей ${s.memory}` : null].filter(Boolean).join(', ') || 'пока пусто'}.`) : null)];
  }

  // ---------- page ----------
  function render() {
    if (!root || !data) return;
    const x = sbx();
    const side = sandboxSide(data, { kind: 'session', id: x?.name }, approvals);
    if (!x) {
      fill(root, h('div', { class: 'layout ag-layout' }, side, h('section', { class: 'panel detail-panel' },
        h('div', { class: 'empty-state' }, h('div', { class: 'big' }, ic('box')),
          h('p', {}, 'Сейчас никто не работает. Дайте агенту задачу — его сессия появится слева.'),
          h('a', { class: 'btn primary', href: '#/agents' }, 'К агентам')))));
      return;
    }
    const want = `#/session?name=${enc(x.name)}${tab !== 'programs' ? `&tab=${tab}` : ''}`;
    if (location.hash !== want) history.replaceState(null, '', want);
    const nAsk = approvals.filter((a) => a.machine === x.name).length + copies.filter((c) => c.changes.length && !c.dir.readonly).length;
    const TABS = [['programs', 'Программы', x.agents.length], ['did', 'Что сделал', 0], ['decisions', 'Решения', nAsk], ['changes', 'Что изменится', 0]];
    const scroll = root.querySelector('.tab-body')?.scrollTop || 0;
    fill(root, h('div', { class: 'layout ag-layout' }, side, h('section', { class: 'panel detail-panel' },
      head(x),
      h('nav', { class: 'tabs' }, ...TABS.map(([id, label, n]) => h('button', { class: `tab${tab === id ? ' active' : ''}`, onclick: () => { tab = id; render(); } },
        label, n ? h('span', { class: `nav-count${id === 'decisions' ? ' attn' : ''}` }, String(n)) : null))),
      h('div', { class: 'tab-body' }, ...{ programs: programsTab, did: didTab, decisions: decisionsTab, changes: changesTab }[tab](x).filter(Boolean)))));
    const tb = root.querySelector('.tab-body');
    if (tb) tb.scrollTop = scroll;
  }

  async function refresh() {
    try { await load(); } catch { return; }
    lastSig = ''; render();
  }

  async function poll() {
    if (!root || document.hidden) return;
    try { await load(); } catch { return; }
    const x = sbx();
    const sig = JSON.stringify([name, data.sandboxes.map((y) => [y.name, y.state, y.opening, y.expiresAt, Math.floor((Date.now() - y.createdAt) / 60000)]), Object.keys(isolated),
      approvals.map((a) => a.id), net.length, events.length, trif, copies.map((c) => c.changes.length), data.profiles.map((p) => p.updatedAt)]);
    if (sig === lastSig && x) return;
    lastSig = sig;
    render();
  }

  pages.session = {
    render(el, p) {
      root = el; preview = null; trif = null; copies = []; slowAt = 0;
      name = p.get('name') || '';
      tab = ['programs', 'did', 'decisions', 'changes'].includes(p.get('tab')) ? p.get('tab') : 'programs';
      el.classList.add('page-agents');
      fill(el, h('p', { class: 'muted' }, 'Загрузка…'));
      load().then(() => { lastSig = ''; render(); }).catch((e) => fill(el, h('div', { class: 'error' }, e.message)));
      timer = setInterval(poll, 3000);
      return () => { clearInterval(timer); el.classList.remove('page-agents'); root = null; };
    },
  };
})();
