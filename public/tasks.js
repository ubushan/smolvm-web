'use strict';
// «Задачи» (#/tasks, the start page): what agents were asked to do and what came of it.
// Left: tasks — waiting for you, running, history. Right: the chosen task with tabs —
// «Изменения» (the git branch: commits, files with risk marks, diff), «Агент» (programs,
// each in its own browser tab), «Что делал» (network and actions), «Решения».

(() => {
  let root = null;
  let tasks = [];        // GET /ui/tasks
  let sbx = null;        // GET /ui/sandbox: profiles, open sandboxes with their programs
  let projects = [];     // GET /ui/projects
  let policies = [];     // GET /ui/policies (their colours)
  let selected = '';
  let tab = '';          // changes | agent | did | decisions; '' — chosen by status
  let timer = null;
  let lastSig = '';
  let busy = '';         // an action in progress: its label
  const changes = {};    // git id -> { key, data } (GET /ui/git/:id)
  let shown = '';        // `${git id}:${path}` in the diff box
  let did = { key: '', lines: [] };
  let didAt = 0;

  const AGENTS = { terminal: 'Терминал', claude: 'Claude Code', opencode: 'OpenCode', 'opencode-tui': 'OpenCode TUI', dsh: 'DSH', codex: 'Codex', pi: 'Pi', hermes: 'Hermes' };
  const MARKS = { claude: 'claude', opencode: 'opencode', 'opencode-tui': 'opencode', dsh: 'dsh', codex: 'codex', pi: 'pi', hermes: 'hermes' };
  const STATUS = {
    opening: ['busy', 'открывается'], working: ['ok', 'работает'], waiting: ['warn', 'ждёт вас'], stopped: ['neutral', 'остановлена'],
    lost: ['bad', 'потеряна'], review: ['warn', 'на проверке'], done: ['neutral', 'завершена'],
  };
  const OPEN = ['opening', 'working', 'waiting', 'stopped'];
  const plural = (n, one, few, many) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many}`;
  const ago = (ts) => fmtAgo(Math.floor(ts / 1000));
  const time = (ts) => new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const base = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
  const left = (ts) => { const m = Math.max(0, Math.round((ts - Date.now()) / 60000)); return m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч ${m % 60} мин`; };
  const pill = (status) => { const [tone, text] = STATUS[status] || ['neutral', status]; return h('span', { class: `ag-pill ${tone}` }, tone === 'busy' ? h('i', { class: 'spin' }) : null, text); };
  const profOf = (id) => sbx?.profiles.find((p) => p.id === id) || null;
  const cur = () => tasks.find((t) => t.id === selected) || null;
  const isOpen = (t) => OPEN.includes(t.status);

  async function load() {
    const [r, d, pr, pl] = await Promise.all([api('GET', '/ui/tasks'), api('GET', '/ui/sandbox').catch(() => sbx), api('GET', '/ui/projects').catch(() => ({ projects })), api('GET', '/ui/policies').catch(() => ({ policies }))]);
    policies = pl.policies || [];
    tasks = r.tasks || [];
    sbx = d;
    projects = pr.projects || [];
    if (!cur()) selected = tasks[0]?.id || '';
    const t = cur();
    if (!t) return;
    // The branch of each repository, again only when it moved.
    await Promise.all(t.git.filter((g) => g.tip).map(async (g) => {
      const key = `${g.tip}:${g.state}`;
      if (changes[g.id]?.key === key) return;
      try { changes[g.id] = { key, data: await api('GET', `/ui/git/${enc(g.id)}`) }; } catch (e) { changes[g.id] = { key, error: e.message }; }
    }));
    if (tabOf(t) === 'did' && (Date.now() - didAt > 8000 || did.key !== t.id)) { didAt = Date.now(); await loadDid(t); }
  }

  // «Что делал»: the network log and the audit of every machine of the task.
  async function loadDid(t) {
    const lines = [];
    for (const m of t.machines || [t.machine]) {
      const [lg, au] = await Promise.all([
        api('GET', `/ui/egress/log?machine=${enc(m)}&limit=1000`).catch(() => ({ entries: [] })),
        api('GET', `/ui/audit?machine=${enc(m)}&limit=100`).catch(() => ({ entries: [] })),
      ]);
      const hosts = new Map();
      for (const e of lg.entries || []) {
        const ts = new Date(e.ts).getTime();
        if (ts < t.createdAt) continue;
        const k = `${e.allow ? 1 : 0}|${e.host}`;
        const x = hosts.get(k) || { allow: e.allow, host: e.host, n: 0, ts: 0 };
        x.n++; x.ts = Math.max(x.ts, ts);
        hosts.set(k, x);
      }
      for (const x of hosts.values()) lines.push({ ts: x.ts, bad: !x.allow, text: `${x.allow ? 'Ходил на' : 'Не пустили на'} ${x.host}${x.n > 1 ? ` · ${plural(x.n, 'раз', 'раза', 'раз')}` : ''}` });
      for (const e of au.entries || []) {
        const ts = new Date(e.ts).getTime();
        if (ts < t.createdAt - 60000) continue;
        const cmd = e.detail?.command ? ` ${String(e.detail.command).slice(0, 60)}` : '';
        lines.push({ ts, bad: e.type === 'alert' || /запрещено|нет ответа/.test(e.action), text: `${e.action}${cmd}` });
      }
    }
    did = { key: t.id, lines: lines.sort((a, b) => b.ts - a.ts).slice(0, 60) };
  }

  // ---------- actions ----------
  async function act(t, label, fn) {
    if (busy) return;
    busy = label; render();
    try { await fn(); } catch (e) { toast(e.message, 'err', 12000); }
    busy = '';
    await refresh();
  }
  const post = (t, op, body = {}) => api('POST', `/ui/tasks/${enc(t.id)}/${op}`, body);

  function finish(t) {
    return act(t, 'Забираю результат…', async () => {
      const r = await post(t, 'finish');
      const n = r.git.reduce((s, g) => s + (g.commits || 0), 0);
      toast(n ? `Ветка обновлена: ${plural(n, 'коммит', 'коммита', 'коммитов')}` : 'Агент пока ничего не изменил', 'ok');
      tab = 'changes';
    });
  }
  async function close(t, keep) {
    if (!keep) {
      const c = await confirmDialog('Закрыть без сохранения?', `Машина ${t.machine} будет удалена. ${t.git.length ? 'Изменения, которые ещё не забраны в ветку, пропадут. ' : ''}${t.profile ? 'То, что агент запомнил, не сохранится.' : ''}`, false, '', 'Удалить');
      if (!c.ok) return;
    }
    await act(t, 'Закрываю…', async () => {
      const r = await post(t, 'close', { save: keep });
      refreshMachines();
      agentInTab(t.machine, false);
      toast(r.task.status === 'review' ? 'Готово — проверьте результат' : 'Готово, машина удалена', 'ok');
      tab = 'changes';
    });
  }
  async function reset(t) {
    const c = await confirmDialog('Сбросить машину?', 'Результат заберётся в ветку, память агента — на проверку. Машина удалится, и откроется чистая из того же шаблона: проект в ней начнётся с ветки задачи. Установленное вручную в машине пропадёт.', false, '', 'Сбросить');
    if (!c.ok) return;
    await act(t, 'Сбрасываю…', async () => { await post(t, 'reset'); refreshMachines(); toast('Чистая машина готова', 'ok'); });
  }
  function accept(t) {
    return act(t, 'Принимаю…', async () => { await post(t, 'accept'); toast('Принято: ветка осталась в репозитории', 'ok'); });
  }
  // Into the branch each repository's task started from; uncommitted work of yours is never touched.
  async function mergeAll(t) {
    const into = [...new Set(t.git.filter((g) => ['ready', 'accepted'].includes(g.state)).map((g) => g.baseRef || '?'))].join(', ');
    const c = await confirmDialog(`Влить в ${into}?`, 'Ветка задачи вольётся в ветку, с которой задача началась: перемоткой, если там ничего не менялось, иначе merge-коммитом. Если эта ветка открыта в директории, файлы обновятся — незакоммиченных изменений в директории быть не должно. При конфликте ничего не меняется.', false, '', 'Влить');
    if (!c.ok) return;
    await act(t, 'Вливаю…', async () => { await post(t, 'merge', { how: 'merge' }); toast(`Влито в ${into}`, 'ok'); });
  }
  async function mergeOne(t, g, how) {
    const c = await confirmDialog(how === 'squash' ? `Одним коммитом в ${g.baseRef}?` : `Влить в ${g.baseRef}?`,
      `${how === 'squash' ? `Все изменения ветки ${g.branch} станут одним коммитом «${t.title}» в ${g.baseRef}.` : `Ветка ${g.branch} вольётся в ${g.baseRef}: перемоткой или merge-коммитом.`} Если ${g.baseRef} открыта в директории, файлы обновятся — незакоммиченных изменений быть не должно. При конфликте ничего не меняется.`, false, '', how === 'squash' ? 'Одним коммитом' : 'Влить');
    if (!c.ok) return;
    await act(t, 'Вливаю…', async () => {
      await api('POST', `/ui/git/${enc(g.id)}/merge`, { how, title: t.title });
      toast(`Влито в ${g.baseRef}`, 'ok');
    });
  }
  async function discard(t) {
    const c = await confirmDialog('Отбросить результат?', `Ветки задачи (${t.result.branches.join(', ')}) будут удалены из репозитория.`, false, '', 'Отбросить');
    if (!c.ok) return;
    await act(t, 'Отбрасываю…', async () => { await post(t, 'discard'); toast('Результат отброшен', 'ok'); });
  }
  async function forget(t) {
    try { await api('DELETE', `/ui/tasks/${enc(t.id)}`); } catch (e) { toast(e.message, 'err'); return; }
    selected = '';
    location.hash = '#/tasks';
  }
  async function extend(t) {
    try { await api('POST', `/ui/sandbox/machines/${enc(t.machine)}/extend`, { hours: 2 }); toast('Продлено на 2 часа', 'ok'); } catch (e) { toast(e.message, 'err'); }
    await refresh();
  }
  async function decide(a, decision) {
    try { await api('POST', `/ui/approvals/${a.id}`, { decision }); } catch (e) { toast(e.message, 'err'); }
    await refresh();
  }
  async function openProgram(t, id, btn) {
    const w = agentTab();
    btn.disabled = true;
    try { goAgent(w, (await api('POST', `/ui/machines/${enc(t.machine)}/agents/${enc(id)}/start`, {})).url); agentInTab(t.machine, true); }
    catch (e) { if (w) w.close(); toast(e.message, 'err', 10000); }
    btn.disabled = false;
  }

  // ---------- the chosen task ----------
  function head(t) {
    const mins = Math.max(0, Math.round(((t.closedAt || Date.now()) - t.createdAt) / 60000));
    const meta = [AGENTS[t.agent] || t.agent, profOf(t.profile)?.name ? `агент «${profOf(t.profile).name}»` : null, t.policy ? `политика «${t.policy.name}»` : null, t.persistent ? 'постоянная' : null,
      t.closedAt ? `закрыта ${ago(t.closedAt)}` : `${mins < 60 ? `${mins} мин` : `${Math.floor(mins / 60)} ч ${mins % 60} мин`}`].filter(Boolean).join(' · ');
    const dis = !!busy;
    const btn = (label, cls, onclick, title = '', disabled = dis) => h('button', { class: `btn ${cls} needs-operator`, title, disabled, onclick }, label);
    let btns = [];
    if (isOpen(t)) {
      const running = t.status !== 'opening' && t.machineState === 'running';
      btns = [
        t.expiresAt ? h('span', { class: `small ${t.expiresAt - Date.now() < 30 * 60000 ? 'warnc' : 'muted'}`, title: `Закроется сама ${new Date(t.expiresAt).toLocaleString('ru-RU')}` }, `осталось ${left(t.expiresAt)}`) : null,
        t.expiresAt ? btn('+2 ч', 'ghost small-btn', () => extend(t), 'Продлить на 2 часа') : null,
        t.git.length ? btn('Забрать результат', '', () => finish(t), 'Забрать изменения агента в ветку сейчас; машина остаётся, агент может продолжать', dis || !running) : null,
        t.persistent ? btn('Сбросить', 'ghost', () => reset(t), 'Чистая машина из шаблона, работа продолжается с ветки задачи', dis || t.status === 'opening') : null,
        btn('Остановить всё', 'danger-outline', async () => { await actions.isolate(state.machines.find((m) => m.name === t.machine) || { name: t.machine }); await refresh(); },
          'Оборвать все соединения агента, заменить его токены и поставить машину на паузу', dis || !running),
        btn('Без сохранения', 'ghost', () => close(t, false), 'Удалить машину, ничего не забирая'),
        btn('Закончить', 'ink', () => close(t, true), 'Забрать результат и память агента на проверку и удалить машину', dis || t.status === 'opening'),
      ];
    } else if (t.status === 'review') {
      btns = [
        t.profilePending.length ? h('a', { class: 'btn ghost', href: `#/review?id=${enc(t.profilePending[0].id)}` }, 'Память агента') : null,
        t.git.some((g) => g.state === 'ready') ? btn('Отбросить', 'danger-outline', () => discard(t), 'Удалить ветку задачи') : null,
        t.git.some((g) => g.state === 'ready') ? btn('Оставить веткой', 'ghost', () => accept(t), 'Ветка остаётся в репозитории — влить можно позже, здесь или вручную') : null,
        t.git.some((g) => g.state === 'ready') ? btn('Влить', 'ink needs-merge', () => mergeAll(t), 'Влить ветку в ту, с которой задача началась') : null,
      ];
    } else {
      btns = [
        btn('Повторить', 'ghost', () => newTask(t), 'Новая задача с тем же агентом, директориями и текстом'),
        btn('Убрать из истории', 'ghost', () => forget(t)),
      ];
    }
    return h('div', { class: 'detail-head' },
      mark(MARKS[t.agent] || 'vm'),
      h('div', { class: 'ag-title' }, h('h2', { title: t.text || '' }, t.title), h('span', { class: 'muted small' }, meta)),
      busy ? h('span', { class: 'ag-pill busy' }, h('i', { class: 'spin' }), busy) : pill(t.status),
      h('div', { class: 'actions' }, ...btns.filter(Boolean)));
  }

  // «Изменения»: every repository of the task as a branch.
  function changesTab(t) {
    const out = [];
    if (t.text) out.push(h('div', { class: 'ag-task-line', title: t.text }, `Задача: «${t.text}»`));
    for (const g of t.git) out.push(branchCard(t, g));
    const copies = t.folders.filter((f) => !f.git && f.mode !== 'ro');
    if (copies.length) out.push(h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Директории без git')),
      h('p', { class: 'small' }, `${copies.map((f) => base(f.hostPath)).join(', ')} — рабочая копия: изменения проверяются по файлам${isOpen(t) ? '' : ', пока машина была открыта'}.`),
      isOpen(t) ? h('a', { class: 'btn small-btn', href: `#/?machine=${enc(t.machine)}&tab=folders` }, 'Проверить копию') : null));
    if (t.profilePending.length) out.push(h('section', { class: 'card tk-mem' }, h('div', { class: 'card-head' }, h('h3', {}, 'Память агента')),
      h('p', { class: 'small' }, `Агент хочет сохранить ${plural(t.profilePending.reduce((n, p) => n + p.changes, 0), 'изменение', 'изменения', 'изменений')} в свою память (инструкции, skills, MCP).`),
      h('a', { class: 'btn small-btn primary', href: `#/review?id=${enc(t.profilePending[0].id)}` }, 'Проверить')));
    if (!t.git.length && !copies.length && !t.profilePending.length) {
      out.push(h('section', { class: 'card ws-empty' }, ic('folder'), h('h3', {}, 'Без проекта'),
        h('p', { class: 'muted' }, 'Задаче не дано git-репозитория: результат — только то, что агент сказал или запомнил. Чтобы получить изменения кода веткой, дайте задаче директорию с git.')));
    }
    return out;
  }

  function branchCard(t, g) {
    const c = changes[g.id];
    const repo = base(g.hostPath);
    const state = {
      copying: 'копируется в машину', working: g.finishedAt ? 'агент ничего не закоммитил' : 'агент работает — изменений ещё не забирали',
      ready: 'ждёт решения', accepted: 'оставлено веткой', discarded: 'отброшено', merged: `влито в ${g.mergedInto}`, lost: 'машина удалена до того, как результат забрали', empty: 'без изменений', error: g.error || 'ошибка',
    }[g.state] || g.state;
    const headRow = h('div', { class: 'card-head' },
      h('h3', { class: 'h-ic' }, ic('branch'), repo),
      h('span', { class: 'mono small muted', title: g.hostPath }, g.tip ? g.branch : ''),
      h('span', { class: 'spacer' }),
      h('span', { class: `small ${g.state === 'ready' ? 'warnc' : g.state === 'error' || g.state === 'lost' ? 'badc' : 'muted'}` }, state));
    const notes = [
      `от ${g.baseRef || 'HEAD'} @ ${String(g.base).slice(0, 8)}${g.history ? '' : ' · агент видел только текущее дерево, без истории'}`,
      g.dirty ? 'на компьютере были незакоммиченные изменения — агент их не видел' : null,
      g.error && g.state !== 'error' ? `последняя попытка забрать: ${g.error}` : null,
    ].filter(Boolean);
    const body = [headRow, h('div', { class: 'muted small' }, notes.join(' · '))];
    if (['ready', 'accepted'].includes(g.state) && g.tip) {
      const cmd = `git merge ${g.branch}`;
      body.push(h('div', { class: 'tk-merge' },
        g.baseRef ? [h('button', { class: 'btn small-btn primary needs-merge', disabled: !!busy, onclick: () => mergeOne(t, g, 'merge') }, `Влить в ${g.baseRef}`),
          h('button', { class: 'btn small-btn needs-merge', disabled: !!busy, onclick: () => mergeOne(t, g, 'squash') }, 'Одним коммитом')] : null,
        h('span', { class: 'small muted' }, g.baseRef ? 'или вручную:' : 'Задача началась не с ветки — влейте вручную:'), h('code', { class: 'mono' }, cmd),
        h('button', { class: 'btn ghost small-btn', onclick: () => { navigator.clipboard?.writeText(`cd ${g.hostPath} && ${cmd}`); toast('Скопировано', 'ok'); } }, 'Копировать')));
    }
    if (g.state === 'merged') {
      body.push(h('div', { class: 'tk-merge' }, h('span', { class: 'small' }, `Влито в ${g.mergedInto} · `, h('span', { class: 'mono' }, String(g.mergeCommit).slice(0, 8)),
        ` · ${{ ff: 'перемоткой', merge: 'merge-коммитом', squash: 'одним коммитом' }[g.mergeHow] || ''}`)));
    }
    if (!g.tip) {
      if (isOpen(t) && g.state === 'working') body.push(h('p', { class: 'small' }, 'Изменения появятся здесь, когда вы нажмёте «Забрать результат» или закончите задачу.'));
      return h('section', { class: 'card' }, ...body);
    }
    if (g.state === 'discarded') return h('section', { class: 'card' }, ...body);
    if (!c) { body.push(h('p', { class: 'muted small' }, h('i', { class: 'spin' }), ' Загрузка…')); return h('section', { class: 'card' }, ...body); }
    if (c.error) { body.push(h('div', { class: 'error small' }, c.error)); return h('section', { class: 'card' }, ...body); }
    const { commits, files } = c.data;
    const flagged = files.filter((f) => f.flags.length).length;
    body.push(h('div', { class: 'tk-sum small' },
      h('b', {}, plural(commits.length, 'коммит', 'коммита', 'коммитов')), ' · ', plural(files.length, 'файл', 'файла', 'файлов'),
      ` · +${files.reduce((n, f) => n + f.added, 0)} −${files.reduce((n, f) => n + f.removed, 0)}`,
      flagged ? h('span', { class: 'warnc' }, ` · требуют внимания: ${flagged}`) : null));
    body.push(h('details', { class: 'tk-commits' }, h('summary', { class: 'small' }, 'Коммиты'),
      ...commits.map((k) => h('div', { class: 'small' }, h('span', { class: 'mono muted' }, k.sha.slice(0, 8)), ' ', k.subject, h('span', { class: 'muted' }, ` — ${k.author}, ${ago(new Date(k.at).getTime())}`)))));
    const diffBox = h('div', { class: 'rv-diff' }, h('p', { class: 'muted small rv-pad' }, 'Выберите файл слева.'));
    const items = files.map((f) => h('div', { class: `rv-item${f.flags.length ? ' danger' : ''}${shown === `${g.id}:${f.path}` ? ' active' : ''}`, 'data-key': `${g.id}:${f.path}`,
      onclick: () => showDiff(diffBox, g, f) },
      h('div', { class: 'rv-item-text' },
        h('b', { class: 'mono ellipsis', title: f.path }, f.path),
        h('span', { class: 'small muted' }, { added: 'новый', deleted: 'удалён', modified: 'изменён' }[f.kind], f.binary ? '' : ` · +${f.added} −${f.removed}`),
        f.flags.length ? h('span', { class: 'small warnc' }, f.flags.join(', ')) : null)));
    body.push(h('div', { class: 'rv-body tk-files' }, h('div', { class: 'rv-list' }, ...items), diffBox));
    const card = h('section', { class: 'card' }, ...body);
    // The file shown before, or the first one of the first branch.
    const mine = t.git.some((x) => shown.startsWith(`${x.id}:`));
    const target = files.find((f) => shown === `${g.id}:${f.path}`) || (!mine && t.git.find((x) => x.tip)?.id === g.id ? files[0] : null);
    if (target) setTimeout(() => showDiff(diffBox, g, target), 0);
    return card;
  }

  async function showDiff(box, g, f) {
    shown = `${g.id}:${f.path}`;
    root?.querySelectorAll('.tk-files .rv-item').forEach((y) => y.classList.toggle('active', y.dataset.key === shown));
    let df;
    try { df = await api('GET', `/ui/git/${enc(g.id)}/diff?path=${enc(f.path)}`); } catch (e) { box.replaceChildren(h('div', { class: 'error rv-pad' }, e.message)); return; }
    const head = h('div', { class: 'rv-diff-head' }, h('b', { class: 'mono' }, f.path), h('span', { class: 'spacer' }),
      h('span', { class: `ss-pill ${f.kind === 'deleted' ? 'bad' : f.kind === 'added' ? 'ok' : 'warn'}` }, { added: 'новый файл', modified: `${fmtBytes(df.hostSize)} → ${fmtBytes(df.guestSize)}`, deleted: 'удалён' }[f.kind]));
    const warn = f.flags.length ? h('div', { class: 'rv-warn' }, `Внимание: ${f.flags.join(', ')}. Такие изменения запускают код при сборке, в CI, в git или в редакторе — прочитайте их целиком.`) : null;
    if (df.binary || df.tooBig) { box.replaceChildren(head, warn || '', h('p', { class: 'muted rv-pad' }, df.binary ? 'Двоичный файл — построчный diff не показывается.' : 'Файл слишком большой для diff.')); return; }
    const pre = h('pre', { class: 'diff rv-pre' });
    const sus = [];
    for (const hk of df.hunks || []) {
      pre.append(h('span', { class: 'd-h' }, `${hk.header}\n`));
      let n = Number((hk.header.match(/\+(\d+)/) || [])[1] || 1);
      for (const l of hk.lines) {
        const why = l[0] === '+' && window.diffSuspicion ? window.diffSuspicion(l.slice(1)) : null;
        if (why) sus.push(`строка ${n}: ${why}`);
        pre.append(h('span', { class: why ? 'd-a d-sus' : l[0] === '+' ? 'd-a' : l[0] === '-' ? 'd-r' : 'd-c', title: why || '' }, `${l}${why ? `   ← ${why}` : ''}\n`));
        if (l[0] !== '-') n += 1;
      }
    }
    const alarm = sus.length ? h('div', { class: 'rv-alarm' }, h('b', {}, 'Подозрительно: '), `${sus.join('; ')}.`) : null;
    box.replaceChildren(head, alarm || '', warn || '', pre);
    root?.querySelector(`.tk-files .rv-item[data-key="${CSS.escape(shown)}"]`)?.classList.toggle('sus', sus.length > 0);
  }

  // «Агент»: programs of the machine, each in its own browser tab.
  function programsTab(t) {
    const x = sbx?.sandboxes.find((y) => y.name === t.machine);
    if (!isOpen(t)) return [h('p', { class: 'muted' }, 'Задача закрыта, машины больше нет.')];
    const note = t.status === 'opening' ? [h('i', { class: 'spin' }), ' открывается…'] : t.machineState !== 'running' ? `Машина ${t.machineState || 'пропала'}.` : null;
    const tiles = (x?.agents || []).map((a) => {
      const b = h('button', { type: 'button', class: 'aw-tile sx-prog', disabled: t.machineState !== 'running',
        title: `Открыть ${a.title || AGENTS[a.id] || a.id} в отдельной вкладке браузера`, onclick: () => openProgram(t, a.id, b) },
        h('span', { class: 'aw-tile-ic' }, mark(a.mark || 'term')),
        h('span', { class: 'aw-tile-text' }, h('b', {}, a.title || AGENTS[a.id] || a.id), h('span', { class: 'small sx-prog-open' }, 'открыть в новой вкладке ↗')));
      return b;
    });
    return [
      t.text ? h('div', { class: 'ag-task-line', title: t.text }, `Задача: «${t.text}»`) : null,
      note ? h('div', { class: 'muted small' }, ...[].concat(note)) : null,
      tiles.length ? h('div', { class: 'aw-tiles sx-progs' }, ...tiles) : h('p', { class: 'muted' }, 'В этой машине нет программ агента.'),
      t.policy ? h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', { class: 'h-ic' }, h('span', { class: `pc-${policies.find((x) => x.id === t.policy.id)?.color || 'gray'} pc-glyph` }, ic('policy')), `Политика «${t.policy.name}»`), h('span', { class: 'spacer' }),
        h('a', { class: 'small', href: `#/policies?id=${enc(t.policy.id)}` }, 'открыть →')),
        t.policyApplied ? h('div', { class: 'kv' },
          kvCell('Права в машине', t.policyApplied.sudo ? 'sudo (root)' : 'без root', 'user'),
          kvCell('Запрещённые программы', (t.policyApplied.deny || []).length
            ? `${t.policyApplied.deny.join(', ')}${t.policyApplied.denied.length ? ` — закрыты в машине: ${t.policyApplied.denied.join(', ')}` : ' — в машине их нет; появятся — процесс остановится'}` : 'нет', 'ban'),
          kvCell('Журнал процессов', t.policyApplied.journal ? h('a', { href: `#/audit?task=${enc(t.id)}` }, 'ведётся →') : 'нет', 'activity'))
          : h('div', { class: 'small muted' }, 'Применяется при открытии машины…'),
        ...(t.policyApplied?.notes || []).map((n) => h('div', { class: 'small warnc' }, n))) : null,
      h('div', { class: 'muted small' }, `Машина `, h('span', { class: 'mono' }, t.machine), t.resets ? ` · сброшена ${plural(t.resets, 'раз', 'раза', 'раз')}` : '',
        ' · ', h('a', { href: `#/?machine=${enc(t.machine)}` }, 'консоль и файлы')),
    ];
  }

  function didTab(t) {
    const lines = did.key === t.id ? did.lines : null;
    return [h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', {}, 'Что агент делал'), h('span', { class: 'spacer' }), h('a', { class: 'small', href: `#/audit?task=${enc(t.id)}` }, 'вся история')),
      !lines ? h('p', { class: 'muted small' }, h('i', { class: 'spin' }), ' Загрузка…')
        : lines.length ? h('div', { class: 'sx-did' }, ...lines.map((l) => h('div', { class: l.bad ? 'badc' : '' }, h('span', { class: 'mono muted' }, time(l.ts)), h('span', {}, l.text))))
          : h('p', { class: 'muted small' }, 'Пока ничего: здесь появятся сайты, на которые ходил агент, и его действия.'))];
  }

  function decisionsTab(t) {
    if (!t.approvals.length) return [h('section', { class: 'card ws-empty' }, ic('check-circle'), h('h3', {}, 'Всё решено'),
      h('p', { class: 'muted' }, 'Когда агент попросит незнакомый сайт или опасный вызов API, вопрос появится здесь.'))];
    return t.approvals.map((a) => h('section', { class: 'dc-card' },
      h('div', { class: 'dc-meta' }, h('span', {}, a.kind === 'net' ? 'хочет зайти на сайт' : `хочет вызвать API · ключ ${a.detail?.secret || ''}`)),
      h('div', { class: 'dc-title' }, h('span', { class: 'mono' }, a.title)),
      h('div', { class: 'dc-actions' },
        a.kind === 'net' ? [h('button', { class: 'btn primary needs-operator', onclick: () => decide(a, 'always') }, 'Разрешить всегда'), h('button', { class: 'btn needs-operator', onclick: () => decide(a, 'once') }, 'На 10 минут')]
          : h('button', { class: 'btn primary needs-operator', onclick: () => decide(a, 'once') }, 'Разрешить'),
        h('button', { class: 'btn danger-outline needs-operator', onclick: () => decide(a, 'deny') }, 'Запретить'))));
  }

  const tabOf = (t) => tab || (t.status === 'waiting' ? 'decisions' : isOpen(t) && !t.result.commits ? 'agent' : 'changes');

  // «?» of the section: what a task is and why work goes this way.
  function help() {
    return helpButton('Зачем раздел «Задачи»',
      h('p', {}, 'Задача — то, что вы поручили агенту, и её результат. Здесь видно, кто сейчас работает, что ждёт вашего решения и чем закончилось раньше.'),
      h('ul', {},
        h('li', {}, h('b', {}, 'Каждая задача — чистая машина. '), 'Агент не видит ваш компьютер и другие задачи; куда ему можно ходить в сети и какие ключи он получит, задаёт агент (⚙ → «Агенты») и уровень доверия. Поэтому агенту можно разрешить работать без подтверждений на каждый шаг.'),
        h('li', {}, h('b', {}, 'Результат — ветка, а не изменённая директория. '), 'Агент получает текущий код без истории, его работа возвращается веткой smolvm/… в вашем репозитории. Ваша рабочая директория не меняется, пока вы не нажмёте «Влить».'),
        h('li', {}, h('b', {}, 'Проверка перед слиянием. '), 'Во вкладке «Изменения» — коммиты и diff; изменения CI, хуков, зависимостей и подозрительные строки отмечены. «Что делал» — куда агент ходил в сети и что делал.'),
        h('li', {}, h('b', {}, 'Разовая или постоянная. '), 'Разовая: агент делает и отдаёт результат, машина закрывается по сроку. Постоянная: работаете вместе сколько нужно; «Сбросить» даёт чистую машину, работа продолжается с той же ветки.')),
      h('p', { class: 'muted small' }, 'Слева: «Ждут вас» — нужен ваш ответ или проверка, «Работают», «История». Повторяющуюся работу над одним репозиторием удобнее вести через «Проекты».'));
  }

  // ---------- the list on the left ----------
  function side(t0) {
    const groups = [
      ['Ждут вас', tasks.filter((t) => ['waiting', 'review'].includes(t.status))],
      ['Работают', tasks.filter((t) => ['opening', 'working', 'stopped'].includes(t.status))],
      ['История', tasks.filter((t) => ['done', 'lost'].includes(t.status))],
    ];
    const item = (t) => {
      const sub = [projects.find((p) => p.id === t.project)?.name || AGENTS[t.agent] || t.agent, t.persistent ? 'постоянная' : null, t.result.commits ? plural(t.result.commits, 'коммит', 'коммита', 'коммитов') : null,
        ago(t.closedAt || t.createdAt)].filter(Boolean).join(' · ');
      return h('a', { class: `machine ag-item sb-item${t0?.id === t.id ? ' active' : ''}${t.status === 'working' ? ' running' : ''}`, href: `#/tasks?id=${enc(t.id)}` },
        mark(MARKS[t.agent] || 'vm', true), h('div', { class: 'name', title: t.text || '' }, t.title), pill(t.status), h('div', { class: 'meta' }, sub));
    };
    return h('section', { class: 'panel list-panel' },
      h('div', { class: 'panel-head' }, h('h2', { class: 'h-ic' }, ic('list'), 'Задачи'), help(), h('span', { class: 'spacer' }),
        h('button', { class: 'btn primary small-btn needs-operator', onclick: () => newTask() }, ic('plus'), 'Новая задача')),
      h('div', { class: 'machines' }, ...groups.flatMap(([title, list]) => (list.length ? [h('div', { class: 'sb-group' }, title, h('span', { class: 'muted' }, String(list.length))), ...list.map(item)] : [])),
        tasks.length ? null : h('div', { class: 'sb-empty muted small' }, 'Задач пока нет.')));
  }

  function render() {
    if (!root) return;
    const t = cur();
    if (t && location.hash !== `#/tasks?id=${enc(t.id)}`) history.replaceState(null, '', `#/tasks?id=${enc(t.id)}`);
    if (!t) {
      fill(root, h('div', { class: 'layout ag-layout' }, side(null), h('section', { class: 'panel detail-panel' },
        h('div', { class: 'empty-state' }, h('div', { class: 'big' }, ic('list')),
          h('p', {}, 'Дайте агенту задачу: он получит чистую машину и копию проекта, а результат вернётся веткой в вашем репозитории.'),
          h('button', { class: 'btn primary needs-operator', onclick: () => newTask() }, ic('plus'), 'Новая задача')))));
      return;
    }
    const cur_ = tabOf(t);
    const TABS = [['changes', 'Изменения', t.result.commits], ['agent', 'Агент', 0], ['did', 'Что делал', 0], ['decisions', 'Решения', t.approvals.length]];
    const scroll = root.querySelector('.tab-body')?.scrollTop || 0;
    fill(root, h('div', { class: 'layout ag-layout' }, side(t), h('section', { class: 'panel detail-panel' },
      head(t),
      h('nav', { class: 'tabs' }, ...TABS.map(([id, label, n]) => h('button', { class: `tab${cur_ === id ? ' active' : ''}`,
        onclick: async () => { tab = id; if (id === 'did') { didAt = 0; render(); await load().catch(() => {}); } render(); } },
        label, n ? h('span', { class: `nav-count${id === 'decisions' ? ' attn' : ''}` }, String(n)) : null))),
      h('div', { class: 'tab-body' }, ...{ changes: changesTab, agent: programsTab, did: didTab, decisions: decisionsTab }[cur_](t).filter(Boolean)))));
    const tb = root.querySelector('.tab-body');
    if (tb) tb.scrollTop = scroll;
  }

  async function refresh() {
    try { await load(); } catch (e) { toast(e.message, 'err'); return; }
    lastSig = ''; render();
  }

  async function poll() {
    if (!root || document.hidden || busy) return;
    try { await load(); } catch { return; }
    const sig = JSON.stringify([selected, tab, tasks.map((t) => [t.id, t.status, t.machineState, t.result, t.approvals.length, t.profilePending.length, t.git.map((g) => [g.state, g.tip]), t.expiresAt && Math.floor((t.expiresAt - Date.now()) / 60000)]),
      Object.values(changes).map((c) => c.key), did.lines.length, sbx?.sandboxes.map((x) => [x.name, x.agents.length])]);
    if (sig === lastSig) return;
    if (root.querySelector('input:focus, textarea:focus, select:focus')) return;
    lastSig = sig;
    render();
  }

  // ---------- «Новая задача» ----------
  // from: a task to repeat (its agent, folders, text, policy, mode), or { project }.
  async function newTask(from = null) {
    let d; let prs; let pls;
    try {
      [d, prs, pls] = await Promise.all([sbx || api('GET', '/ui/sandbox'), api('GET', '/ui/projects').then((r) => r.projects).catch(() => []),
        api('GET', '/ui/policies').catch(() => ({ policies: [], summaries: {} }))]);
    } catch (e) { toast(e.message, 'err'); return; }
    if (!d.profiles.length) {
      const c = await confirmDialog('Сначала нужен агент', 'Агент — это программа (Claude Code, Codex…), её изоляция, ключи и память. Задачи даются агенту.', false, '', 'Создать агента');
      if (c.ok) agentWizard({ onDone: () => refresh() });
      return;
    }
    let profile = from?.profile && d.profiles.some((p) => p.id === from.profile) ? from.profile : d.profiles[0].id;
    const prof = () => d.profiles.find((p) => p.id === profile);
    let project = from?.project && prs.some((p) => p.id === from.project) ? from.project : '';
    const projOf = () => prs.find((p) => p.id === project) || null;
    // The policy of the task: the one repeated, else the project's, else the agent's (or its former trust level).
    const known = (id) => (pls.policies.some((x) => x.id === id) ? id : null);
    const defaultPolicy = () => known(projOf()?.policy) || known(prof()?.policy) || known(projOf()?.trust) || known(prof()?.trust) || 'normal';
    let policy = known(from?.policy?.id) || defaultPolicy();
    const polSel = h('select', { class: 'input', id: 'tk-policy' });
    const polInfo = h('div', { class: 'small muted' });
    const drawPolicy = () => {
      polSel.replaceChildren(...pls.policies.map((x) => h('option', { value: x.id }, x.builtin ? x.name : `${x.name} (своя)`)));
      polSel.value = policy;
      const cur = pls.policies.find((x) => x.id === policy);
      polInfo.replaceChildren(h('span', { class: `pc-dot pc-${cur?.color || 'gray'}` }), pls.summaries[policy] || '');
    };
    polSel.addEventListener('change', () => { policy = polSel.value; drawPolicy(); });
    drawPolicy();
    const polTrust = () => { const x = pls.policies.find((y) => y.id === policy); return !x ? 'normal' : x.net.mode === 'off' || x.net.unknown === 'allow' ? 'trusted' : x.net.unknown === 'ask' ? 'normal' : 'careful'; };
    let persistent = !!from?.persistent;
    const startFolders = (p) => (p?.folders?.length ? p.folders : p?.folder ? [{ hostPath: p.folder, mode: 'review' }] : []).map((f) => ({ ...f }));
    let folders = from?.folders ? from.folders.map(({ hostPath, mode }) => ({ hostPath, mode })) : startFolders(prof());

    const who = h('select', { class: 'input', id: 'tk-who' }, d.profiles.map((p) => h('option', { value: p.id }, `${p.name}${p.agent ? ` — ${AGENTS[p.agent] || p.agent}` : ''}`)));
    who.value = profile;
    const text = h('textarea', { class: 'input ag-task', id: 'tk-text', rows: 4, maxlength: 4000, placeholder: 'Например: добавь эндпоинт /health и тест к нему' });
    text.value = from?.text || '';
    const dirsBox = h('div', { class: 'tk-dirs' });
    const drawDirs = () => {
      dirsBox.replaceChildren(...folders.map((f, i) => folderRow(f, () => { folders.splice(i, 1); drawDirs(); })),
        h('button', { type: 'button', class: 'btn ghost small-btn', onclick: () => { folders.push({ hostPath: '', mode: 'review' }); drawDirs(); dirsBox.querySelector('.tk-dir:last-of-type input')?.focus(); } }, ic('plus'), 'Директория'));
    };
    drawDirs();
    // A project brings its agent, repository and template: those fields give way to a summary.
    const projSel = h('select', { class: 'input', id: 'tk-project' }, h('option', { value: '' }, 'Без проекта — выбрать агента и директории'),
      prs.map((p) => h('option', { value: p.id }, p.name === base(p.hostPath) ? p.name : `${p.name} — ${base(p.hostPath)}`)));
    projSel.value = project;
    const projInfo = h('div', { class: 'small muted' });
    const whoField = h('label', { class: 'ws-field', for: 'tk-who' }, 'Агент', who);
    const dirsField = h('div', { class: 'ws-field' }, h('div', { class: 'label-like' }, 'Проект'), dirsBox,
      h('div', { class: 'muted small' }, 'Git-репозиторий: агент получает текущий код без истории, результат возвращается веткой — ваша директория не меняется. Директория без git — рабочая копия с проверкой по файлам.'));
    const drawProject = () => {
      const p = projOf();
      whoField.hidden = !!p; dirsField.hidden = !!p;
      if (!p) { projInfo.replaceChildren(); return; }
      const ag = d.profiles.find((x) => x.id === p.profile);
      const tpl = p.build?.status === 'running' ? `шаблон собирается (${p.build.step}) — задача откроется из образа агента, без подготовки`
        : p.templateReady ? 'из шаблона проекта: зависимости уже установлены' : p.setup ? 'шаблона нет — из образа агента, без подготовки' : 'из образа агента';
      projInfo.replaceChildren(`Агент «${ag?.name || '—'}», репозиторий `, h('span', { class: 'mono' }, p.hostPath), `; откроется ${tpl}. Результат — ветка в репозитории.`);
    };
    projSel.addEventListener('change', () => {
      project = projSel.value;
      policy = defaultPolicy(); drawPolicy();
      drawProject();
    });
    who.addEventListener('change', () => { profile = who.value; if (!from) { folders = startFolders(prof()); drawDirs(); } policy = defaultPolicy(); drawPolicy(); });
    const mode = h('div', { class: 'tk-mode', role: 'radiogroup' });
    const pol = window.auth?.policy || {};
    const noPersistent = pol.allowPersistent === false || pol.maxTtlHours > 0;
    if (noPersistent) persistent = false;
    const drawMode = () => mode.replaceChildren(...[[false, 'Разовая', `Агент делает задачу и отдаёт результат; машина закрывается по сроку${pol.maxTtlHours ? ` (не дольше ${pol.maxTtlHours} ч по политике)` : ' из настроек'}.`], [true, 'Постоянная сессия', noPersistent ? 'Запрещено политикой администратора.' : 'Работаете вместе сколько нужно: машина не закрывается сама, её можно сбросить к чистой.']]
      .map(([v, title, hint]) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(persistent === v), class: `tk-mode-opt${persistent === v ? ' on' : ''}`, disabled: v && noPersistent, onclick: () => { persistent = v; drawMode(); } },
        h('b', {}, title), h('span', { class: 'muted small' }, hint))));
    drawMode();
    let inTab = false;
    try { inTab = localStorage.getItem('smolvm.agentTab') === '1'; } catch {}
    const tabBox = h('input', { type: 'checkbox', id: 'tk-tab', checked: inTab });
    const go = h('button', { class: 'btn primary ag-go' }, ic('play'), 'Начать');
    const dlg = h('dialog', { class: 'dialog ws-dialog ag-dialog' },
      h('header', {}, h('h3', {}, from?.id ? 'Повторить задачу' : 'Новая задача'), h('button', { type: 'button', class: 'btn ghost icon', title: 'Закрыть', 'aria-label': 'Закрыть', onclick: () => dlg.close() }, ic('x'))),
      h('div', { class: 'dialog-body' },
        h('label', { class: 'ws-field', for: 'tk-text' }, 'Что сделать', text),
        prs.length ? h('label', { class: 'ws-field', for: 'tk-project' }, 'Проект', projSel, projInfo) : null,
        whoField,
        dirsField,
        h('div', { class: 'ws-field' }, h('div', { class: 'label-like' }, 'Как работаем'), mode),
        h('label', { class: 'ws-field', for: 'tk-policy' }, 'Политика', polSel, polInfo,
          h('span', { class: 'muted small' }, 'Сеть, директории, права в машине, запрещённые программы и сроки — ⚙ → «Политики».')),
        h('label', { class: 'ag-check', for: 'tk-tab' }, tabBox, h('span', {}, 'Сразу открыть агента в отдельной вкладке браузера')),
        go));
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
    drawProject();
    setTimeout(() => text.focus(), 0);

    go.addEventListener('click', async () => {
      const list = folders.filter((f) => f.hostPath.trim()).map((f) => ({ hostPath: f.hostPath.trim(), mode: f.mode }));
      const p = projOf() ? d.profiles.find((x) => x.id === projOf().profile) : prof();
      const wantTab = tabBox.checked && !!p?.agent;
      const w = wantTab ? agentTab() : null;
      if (polTrust() === 'trusted') {
        const c = await confirmDialog('Без ограничений сети?', 'Агент сможет ходить куда угодно в интернете и ничего не будет спрашивать. Всё, что он увидит в проекте, он сможет отправить наружу.', false, '', 'Да, доверяю');
        if (!c.ok) { if (w) w.close(); return; }
      }
      try { localStorage.setItem('smolvm.agentTab', tabBox.checked ? '1' : '0'); } catch {}
      go.disabled = true; go.replaceChildren(h('i', { class: 'spin' }), 'Открываю машину…');
      try {
        const r = await api('POST', '/ui/tasks', projOf() ? { project, policy, task: text.value.trim() || null, persistent }
          : { profile, agent: p?.agent || null, policy, task: text.value.trim() || null, folders: list, persistent });
        dlg.close();
        if (wantTab && r.url) { agentInTab(r.name, true); goAgent(w, r.url); } else if (w) w.close();
        refreshMachines();
        selected = r.taskId; tab = '';
        location.hash = `#/tasks?id=${enc(r.taskId)}`;
        await refresh();
      } catch (e) {
        if (w) w.close();
        toast(e.message, 'err', 12000);
        go.disabled = false; go.replaceChildren(ic('play'), 'Начать');
      }
    });
  }

  // A project folder: the path (with suggestions), how the agent gets it, what it is.
  function folderRow(f, onRemove) {
    const list = h('datalist', { id: `tk-sug-${Math.random().toString(36).slice(2)}` });
    const input = h('input', { class: 'input mono', placeholder: '/путь/к/проекту', value: f.hostPath, list: list.id, spellcheck: 'false' });
    const how = h('select', { class: 'input' }, h('option', { value: 'review' }, 'изменять'), h('option', { value: 'ro' }, 'только чтение'));
    how.value = f.mode === 'ro' ? 'ro' : 'review';
    const info = h('div', { class: 'small muted tk-dir-info' });
    let seq = 0;
    const check = async () => {
      const my = ++seq;
      const p = input.value.trim();
      if (!p) { info.replaceChildren(); return; }
      let r;
      try { r = await api('GET', `/ui/git-inspect?path=${enc(p)}`); } catch { return; }
      if (my !== seq) return;
      if (!r.ok) { info.className = 'small badc tk-dir-info'; info.textContent = r.error; return; }
      info.className = 'small muted tk-dir-info';
      info.textContent = how.value === 'ro' ? 'только чтение — копия, на компьютер ничего не пишется'
        : r.git ? `git · ${r.branch || 'detached'} @ ${r.head} — результат придёт веткой${r.dirty ? ' · есть незакоммиченные изменения: агент их не увидит' : ''}`
          : 'не git — рабочая копия, изменения проверяются по файлам';
    };
    let sugT = null;
    input.addEventListener('input', () => {
      f.hostPath = input.value;
      clearTimeout(sugT);
      sugT = setTimeout(async () => {
        check();
        try { list.replaceChildren(...((await api('GET', `/ui/folders/suggest?q=${enc(input.value)}`)).paths || []).map((x) => h('option', { value: x }))); } catch {}
      }, 250);
    });
    how.addEventListener('change', () => { f.mode = how.value; check(); });
    check();
    return h('div', { class: 'tk-dir' }, h('div', { class: 'tk-dir-row' }, input, list, how,
      h('button', { type: 'button', class: 'btn ghost icon', title: 'Убрать', 'aria-label': 'Убрать директорию', onclick: onRemove }, ic('x'))), info);
  }

  window.newTask = (from) => newTask(from);

  // The former session screen: its address leads to the task of that machine.
  pages.session = {
    render(el, p) {
      const name = p.get('name');
      api('GET', '/ui/tasks').then((r) => {
        const t = (r.tasks || []).find((x) => x.machine === name || (x.machines || []).includes(name));
        location.replace(t ? `#/tasks?id=${enc(t.id)}` : '#/tasks');
      }).catch(() => location.replace('#/tasks'));
      return null;
    },
  };

  pages.tasks = {
    render(el, p) {
      root = el; busy = '';
      selected = p.get('id') || selected;
      tab = ['changes', 'agent', 'did', 'decisions'].includes(p.get('tab')) ? p.get('tab') : '';
      el.classList.add('page-agents');
      fill(el, h('p', { class: 'muted' }, 'Загрузка…'));
      load().then(() => { lastSig = ''; render(); if (p.get('new')) newTask(); }).catch((e) => fill(el, h('div', { class: 'error' }, e.message)));
      timer = setInterval(poll, 3000);
      return () => { clearInterval(timer); el.classList.remove('page-agents'); root = null; };
    },
  };
})();
