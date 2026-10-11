'use strict';
// Page «Сеанс» (#/session?name=…): the agent and its controller side by side.
// Left: the agent itself, embedded. Right: what it asks for right now, what it did
// (in plain words, from the audit and the network log) and what «Закончить» changes.
// The agent frame is built once per agent: polls only redraw the header and the right column.

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
  let frame = null;     // { key, el }
  let agentId = null;
  const urls = {};      // `${machine}/${agent}` -> url | { error }

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
  const mainAgent = (x) => {
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
  async function startAgent(x, id) {
    const key = `${x.name}/${id}`;
    urls[key] = 'loading';
    drawLeft();
    try { urls[key] = agentUrl((await api('POST', `/ui/machines/${enc(x.name)}/agents/${enc(id)}/start`, {})).url); }
    catch (e) { urls[key] = { error: e.message }; }
    drawLeft();
  }
  function toTab(x, u) {
    if (!window.open(u, '_blank', 'noopener')) return toast('Браузер заблокировал новую вкладку', 'err');
    agentInTab(x.name, true);
    if (frame?.el) frame.el.src = 'about:blank'; // drop the embedded connection
    frame = null;
    drawLeft();
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
      frame = null;
      agentInTab(x.name, false);
      if (r.pending) { toast(`Готово. На проверку: ${plural(r.changes, 'изменение', 'изменения', 'изменений')} памяти агента`, 'ok', 8000); location.hash = `#/review?id=${enc(r.pending)}`; return; }
      toast(r.applied ? `Готово, сохранено в память агента: ${r.applied}` : 'Готово, машина удалена', 'ok');
    } catch (e) { toast(e.message, 'err', 12000); return; }
    name = '';
    location.hash = '#/agents';
  }
  async function decide(a, decision) {
    try { await api('POST', `/ui/approvals/${a.id}`, { decision }); } catch (e) { toast(e.message, 'err'); }
    await refresh();
  }
  async function checkChanges() {
    preview = 'loading'; drawRight();
    try { preview = await api('GET', `/ui/sandbox/machines/${enc(name)}/changes`); }
    catch (e) { preview = { error: e.message }; }
    drawRight();
  }

  // ---------- header ----------
  function header(x) {
    const p = profOf(x.profile);
    const iso = isolated[x.name];
    const pill = iso ? ['bad', 'остановлен вами']
      : !trif ? ['neutral', x.opening || 'проверяю…']
      : trif.lethal ? ['bad', 'риск утечки']
      : trif.untrustedLevel === 'open' ? ['warn', 'интернет открыт']
      : ['ok', 'безопасно'];
    const why = trif ? [trif.untrustedWhy, trif.lethal ? `У агента есть ${trif.privateData.join(', ')} и выход наружу.` : null, trif.note].filter(Boolean).join('\n') : '';
    const others = data.sandboxes.filter((y) => y.name !== x.name);
    return h('header', { class: 'sx-head' },
      h('div', { class: 'sx-title' },
        h('b', {}, [AGENTS[mainAgent(x)] || null, p ? p.name : 'разовая задача'].filter(Boolean).join(' · ')),
        h('span', { class: `ag-pill ${pill[0]}`, title: why }, pill[1]),
        x.task ? h('span', { class: 'sx-task muted small', title: x.task }, `«${x.task}»`) : null),
      h('span', { class: 'spacer' }),
      others.length ? h('select', { class: 'input sx-switch', 'aria-label': 'Другой агент', onchange: (ev) => { location.hash = `#/session?name=${enc(ev.target.value)}`; } },
        h('option', { value: x.name }, `Ещё работают: ${others.length}`),
        others.map((y) => h('option', { value: y.name }, [AGENTS[y.agent], profOf(y.profile)?.name || 'разовая'].filter(Boolean).join(' · ')))) : null,
      x.expiresAt ? h('span', { class: `small ${x.expiresAt - Date.now() < 30 * 60000 ? 'warnc' : 'muted'}`, title: `Закроется сама ${new Date(x.expiresAt).toLocaleString('ru-RU')}` }, `осталось ${left(x.expiresAt)}`) : null,
      x.expiresAt ? h('button', { class: 'btn ghost small-btn', title: 'Продлить на 2 часа', onclick: async () => {
        try { await api('POST', `/ui/sandbox/machines/${enc(x.name)}/extend`, { hours: 2 }); toast('Продлено на 2 часа', 'ok'); } catch (e) { toast(e.message, 'err'); }
        await refresh();
      } }, '+2 ч') : null,
      iso ? null : h('button', { class: 'btn danger-outline', disabled: x.state !== 'running', title: 'Оборвать все соединения агента, заменить его токены и поставить машину на паузу',
        onclick: async () => { await actions.isolate(state.machines.find((m) => m.name === x.name) || { name: x.name }); await refresh(); } }, 'Остановить всё'),
      p ? h('button', { class: 'btn ghost', title: 'Удалить машину, ничего не сохранять', onclick: () => finish(x, false) }, 'Без сохранения') : null,
      h('button', { class: 'btn ink', disabled: !!x.opening, title: p ? 'Забрать память агента на проверку и удалить машину' : 'Удалить машину', onclick: () => finish(x, true) }, p ? 'Закончить и проверить' : 'Закончить'));
  }

  // ---------- left: the agent ----------
  let leftEl = null;
  function drawLeft() {
    const x = sbx();
    if (!leftEl || !x) return;
    const id = mainAgent(x);
    const key = `${x.name}/${id}`;
    const ids = x.agents.map((a) => a.id);
    const tabs = ids.length > 1 ? h('div', { class: 'sx-tabs' }, ...x.agents.map((a) => h('button', {
      class: `sx-tab${a.id === id ? ' on' : ''}`, onclick: () => { agentId = a.id; drawLeft(); },
    }, mark(a.mark || 'term', true), a.title || AGENTS[a.id] || a.id))) : null;
    const u = urls[key];
    const ext = agentInTab(x.name);
    const bar = h('div', { class: 'sx-bar' }, tabs || h('span', { class: 'sx-bar-title' }, AGENTS[id] || id || 'Агент'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn ghost small-btn', title: 'Дать агенту ещё одну папку', onclick: () => openFolderDialog({ machine: x.name, mode: 'review', onDone: () => { slowAt = 0; refresh(); } }) }, ic('folder'), 'Дать папку'),
      typeof u === 'string' && u !== 'loading' && !ext ? h('button', { class: 'btn ghost small-btn', title: 'Открыть агента в отдельной вкладке браузера, а здесь оставить контроль', onclick: () => toTab(x, u) }, ic('external'), 'В отдельной вкладке') : null,
      typeof u === 'string' && u !== 'loading' && !ext ? h('button', { class: 'btn ghost small-btn icon', title: 'Перезагрузить', 'aria-label': 'Перезагрузить', onclick: () => { if (frame?.el) frame.el.src = u; } }, ic('refresh')) : null);

    let body;
    if (!id) body = h('div', { class: 'sx-empty' }, 'В этой машине нет агентов.');
    else if (x.opening) body = h('div', { class: 'sx-empty' }, h('i', { class: 'spin' }), ` ${x.opening}…`);
    else if (isolated[x.name]) body = h('div', { class: 'sx-empty' }, h('b', {}, 'Агент остановлен'), h('span', {}, 'Все соединения оборваны, машина на паузе. Снять остановку можно на странице машины («Машины»).'));
    else if (x.state !== 'running') body = h('div', { class: 'sx-empty' }, `Машина ${x.state === 'missing' ? 'пропала' : 'не работает'}.`);
    else if (u === undefined) { body = h('div', { class: 'sx-empty' }, h('i', { class: 'spin' }), ' Подключаюсь к агенту…'); setTimeout(() => startAgent(x, id), 0); }
    else if (u === 'loading') body = h('div', { class: 'sx-empty' }, h('i', { class: 'spin' }), ' Подключаюсь к агенту…');
    else if (ext && !u.error) {
      // Not embedded: a second connection would start a second agent.
      frame = null;
      body = h('div', { class: 'sx-empty' }, ic('external'), h('b', {}, 'Агент открыт в отдельной вкладке'),
        h('span', {}, 'Здесь — контроль: что он просит, что сделал и что изменится.'),
        h('div', { class: 'dc-actions' },
          h('a', { class: 'btn primary', href: u, target: '_blank', rel: 'noopener' }, 'Перейти к агенту'),
          h('button', { class: 'btn', onclick: () => { agentInTab(x.name, false); drawLeft(); } }, 'Показать здесь')),
        h('span', { class: 'small' }, 'Перед «Показать здесь» закройте вкладку с агентом.'));
    } else if (u.error) body = h('div', { class: 'sx-empty' }, h('b', { class: 'badc' }, 'Агент не запустился'), h('pre', { class: 'mono small' }, u.error), h('button', { class: 'btn', onclick: () => startAgent(x, id) }, 'Попробовать снова'));
    else {
      if (!frame || frame.key !== key) frame = { key, el: h('iframe', { class: 'sx-frame', src: u, title: AGENTS[id] || id, allow: 'clipboard-read; clipboard-write' }) };
      body = frame.el;
    }
    // Keep the live frame where it is: replacing it would reload the agent.
    const cur = leftEl.querySelector('.sx-frame');
    leftEl.firstChild ? leftEl.firstChild.replaceWith(bar) : leftEl.append(bar);
    if (cur && cur === body) return;
    const rest = [...leftEl.childNodes].slice(1);
    rest.forEach((n) => n.remove());
    leftEl.append(body);
  }

  // ---------- right: asks, did, will change ----------
  let rightEl = null;
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
    return out.sort((a, b) => b.ts - a.ts).slice(0, 12);
  }

  function drawRight() {
    const x = sbx();
    if (!rightEl || !x) return;
    const mine = approvals.filter((a) => a.machine === x.name);
    const asks = mine.length ? mine.map((a) => h('section', { class: 'sx-ask' },
      h('div', { class: 'small' }, 'Агент просит сейчас'),
      h('div', { class: 'sx-ask-title' }, a.kind === 'net' ? ['Зайти на ', h('span', { class: 'mono' }, a.title)] : ['Вызвать ', h('span', { class: 'mono' }, a.title), ` (ключ ${a.detail?.secret || ''})`]),
      h('div', { class: 'dc-actions' },
        a.kind === 'net'
          ? [h('button', { class: 'btn ink', onclick: () => decide(a, 'always') }, 'Разрешить'), h('button', { class: 'btn', onclick: () => decide(a, 'once') }, '10 минут')]
          : h('button', { class: 'btn ink', onclick: () => decide(a, 'once') }, 'Разрешить'),
        h('button', { class: 'btn danger-outline', onclick: () => decide(a, 'deny') }, 'Нет')))) : [];

    const lines = didLines(x);
    const did = h('section', { class: 'ss-card' },
      h('div', { class: 'ss-card-title' }, 'Что агент сделал', h('a', { class: 'small', href: `#/audit?machine=${enc(x.name)}` }, 'вся история')),
      lines.length ? h('div', { class: 'sx-did' }, ...lines.map((l) => h('div', { class: l.bad ? 'badc' : '' }, h('span', { class: 'mono muted' }, time(l.ts)), h('span', {}, l.text))))
        : h('p', { class: 'muted small' }, 'Пока ничего. Здесь появятся сайты, на которые ходил агент, и изменения в проекте.'));

    const p = profOf(x.profile);
    const proj = copies.map((c) => {
      const add = c.changes.filter((y) => y.kind === 'added').length;
      const del = c.changes.filter((y) => y.kind === 'deleted').length;
      return h('div', { title: c.dir.hostPath }, `Проект ${base(c.dir.hostPath)}: `, c.changes.length ? `${plural(c.changes.length, 'файл', 'файла', 'файлов')}${add ? `, новых ${add}` : ''}${del ? `, удалено ${del}` : ''} — после вашей проверки` : 'пока без изменений');
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
    const change = h('section', { class: 'ss-card' },
      h('div', { class: 'ss-card-title' }, 'Что изменится, когда закончите'),
      h('div', { class: 'ss-list sx-change' }, ...proj, mem,
        !proj.length && !p ? h('div', { class: 'muted' }, 'Ничего: разовая задача без папок — машина просто удалится.') : null),
      p ? h('button', { class: 'btn small-btn', disabled: preview === 'loading' || x.state !== 'running', onclick: checkChanges }, preview && preview !== 'loading' ? 'Проверить снова' : 'Посмотреть заранее') : null,
      copies.some((c) => c.changes.length) ? h('a', { class: 'btn small-btn', href: `#/dirs?tab=folders&machine=${enc(x.name)}` }, 'Проверить проект') : null,
      p ? h('div', { class: 'muted small' }, `Агент начал с памяти «${p.name}»: ${[s?.mcp?.length ? `MCP ${s.mcp.length}` : null, s?.skills ? `skills ${s.skills}` : null, s?.memory ? `записей ${s.memory}` : null].filter(Boolean).join(', ') || 'пока пусто'}.`) : null);

    rightEl.replaceChildren(...asks, did, change);
  }

  // ---------- page ----------
  let headEl = null;
  let secEl = null;   // «Песочница» head with its tabs
  let builtFor = '';
  function render() {
    if (!root || !data) return;
    const x = sbx();
    if (!x) {
      builtFor = ''; frame = null;
      fill(root, sandboxHeader('sessions', data, { guide: false }), h('section', { class: 'card ws-empty' }, ic('box'), h('h3', {}, 'Сейчас никто не работает'),
        h('p', { class: 'muted' }, 'Дайте агенту задачу — его сессия появится здесь: сам агент и рядом контроль.'),
        h('a', { class: 'btn primary', href: '#/agents' }, 'К агентам')));
      return;
    }
    if (location.hash !== `#/session?name=${enc(x.name)}`) history.replaceState(null, '', `#/session?name=${enc(x.name)}`);
    if (builtFor !== x.name) {
      builtFor = x.name; frame = null; agentId = null; preview = null; trif = null; copies = []; slowAt = 0;
      secEl = h('div', {});
      headEl = h('div', {});
      leftEl = h('section', { class: 'sx-agent' });
      rightEl = h('aside', { class: 'sx-side' });
      fill(root, h('div', { class: 'sx-wrap' }, secEl, headEl, h('div', { class: 'sx-body' }, leftEl, rightEl)));
    }
    secEl.replaceChildren(sandboxHeader('sessions', data, { guide: false }));
    headEl.replaceChildren(header(x));
    drawLeft();
    drawRight();
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
      root = el; name = p.get('name') || ''; preview = null; builtFor = ''; frame = null;
      el.classList.add('page-wide', 'page-session');
      fill(el, h('p', { class: 'muted' }, 'Загрузка…'));
      load().then(() => { lastSig = ''; render(); }).catch((e) => fill(el, h('div', { class: 'error' }, e.message)));
      timer = setInterval(poll, 3000);
      return () => { clearInterval(timer); el.classList.remove('page-wide', 'page-session'); root = null; frame = null; builtFor = ''; };
    },
  };
})();
