'use strict';
// «Создать агента» / настройки агента: one wide window of a fixed height, step by step:
//   Программа → Политика → Директории → Секреты → Агент
// The program is an agent preset. smolvm-web keeps one image per preset (with or without
// hard isolation) and prepares it once, in the background; every task opens a clean copy
// of it. The agent's own network, directories and secrets are applied to each copy.
// A template made from your own machine can be chosen instead of a preset.

(() => {
  const TITLES = { program: 'Программа', policy: 'Политика', dirs: 'Директории', secrets: 'Секреты', task: 'Агент' };
  const STEPS = ['program', 'policy', 'dirs', 'secrets', 'task'];
  const DIR_MODES = { review: 'Копия с проверкой', ro: 'Только чтение' };
  const base = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
  let presetsCache = null;

  // A square choice: a big icon on the left, the text on the right.
  function tile({ on, disabled, title, icon, name, sub, note, mono, onclick, extra }) {
    return h('button', { type: 'button', role: 'radio', 'aria-checked': String(!!on), class: `aw-tile${on ? ' on' : ''}`, disabled: !!disabled, title: title || '', onclick },
      h('span', { class: 'aw-tile-ic' }, icon),
      h('span', { class: 'aw-tile-text' }, h('b', { class: mono ? 'mono' : '' }, name), sub ? h('span', { class: 'muted small' }, sub) : null, note || null),
      extra || null);
  }
  // A titled card, the same as on the pages: title, actions on the right, content.
  function card(title, actions, ...body) {
    return h('section', { class: 'card aw-card-box' }, h('div', { class: 'card-head' }, h('h3', {}, title), h('span', { class: 'spacer' }), ...[].concat(actions || [])), ...body);
  }

  // «+»: make a new one of the kind.
  function plusTile(name, sub, onclick, disabled) {
    return h('button', { type: 'button', class: 'aw-tile aw-plus', disabled: !!disabled, onclick },
      h('span', { class: 'aw-tile-ic' }, ic('plus')), h('span', { class: 'aw-tile-text' }, h('b', {}, name), h('span', { class: 'muted small' }, sub)));
  }

  window.agentWizard = async function agentWizard({ profile = null, step = null, onDone } = {}) {
    const ui = window.agentUi;
    let d; let eg; let vault; let pl;
    try {
      [d, presetsCache, eg, vault, pl] = await Promise.all([
        api('GET', '/ui/sandbox'),
        presetsCache || api('GET', '/ui/profiles').then((r) => r.profiles),
        api('GET', '/ui/egress').catch(() => ({ lists: [], defaults: {} })),
        api('GET', '/ui/vault').catch(() => ({ secrets: [] })),
        api('GET', '/ui/policies').catch(() => ({ policies: [], summaries: {} })),
      ]);
    } catch (e) { toast(e.message, 'err'); return; }
    const presets = presetsCache;
    // The page is newer than the running server (code updated, smolvm-web not restarted).
    const oldServer = !('images' in d);
    const RESTART = 'smolvm-web на этом компьютере работает на старой версии: код обновлён, а сервер не перезапущен. Перезапустите smolvm-web (закройте окно start.cmd / Ctrl+C и запустите снова) — без этого образ программы не подготовится.';
    const prof = profile ? d.profiles.find((p) => p.id === profile) : null;
    const edit = !!prof;
    const tplOf = (id) => d.templates.find((t) => t.id === id) || null;
    const presetOf = (id) => presets.find((p) => p.id === id) || null;
    const agentsOf = (t) => (t?.agents?.agents || []).filter((id) => id !== 'terminal');
    const tplReady = (t) => !!t && !t.creating && !t.missing && t.job?.status !== 'running';

    // ---------- state ----------
    const def = eg.defaults || {};
    const legacyTpl = prof && !prof.preset && tplOf(prof.template) ? prof.template : null;
    const st = {
      step: 'program',
      preset: prof?.preset || (legacyTpl ? null : null), template: legacyTpl, // a preset, or a template of your own machine
      agent: prof?.agent || null,
      net: prof?.net || (legacyTpl ? (tplOf(legacyTpl).egress?.enabled ? (tplOf(legacyTpl).egress?.strict ? 'strict' : 'soft') : 'off') : def.enabled === false ? 'off' : 'strict'),
      lists: prof?.lists || (eg.lists || []).filter((l) => l.default).map((l) => l.id),
      secrets: Array.isArray(prof?.secrets) ? [...prof.secrets] : legacyTpl ? [...(tplOf(legacyTpl).secrets || [])] : [],
      dirs: prof?.folders?.length ? prof.folders.map((f) => ({ ...f })) : prof?.folder ? [{ hostPath: prof.folder, mode: 'review' }] : [],
      name: prof?.name || '', trust: prof?.trust || 'normal',
      idle: prof?.idleMinutes ?? 0, ttl: prof?.ttlHours ?? 0,
      review: prof ? !prof.autoSave : true, from: '', inTab: false,
      // The policy: the agent's, else its former trust level (the built-in policies have its ids).
      policy: prof?.policy || prof?.trust || 'normal',
    };
    try { st.inTab = localStorage.getItem('smolvm.agentTab') === '1'; } catch {}
    // A template of your own machine carries its isolation: the mode is fixed by it.
    const ownTpl = () => (st.template ? tplOf(st.template) : null);
    const polOf = (id) => (pl.policies || []).find((x) => x.id === id) || null;
    // The network of the chosen policy (an agent before policies: its own).
    const netMode = () => polOf(st.policy)?.net?.mode || st.net;
    const isolated = () => netMode() === 'strict';
    const trustOf = (p) => (!p ? st.trust : p.net.mode === 'off' || p.net.unknown === 'allow' ? 'trusted' : p.net.unknown === 'ask' ? 'normal' : 'careful');
    // The image the agent will run from: { ready, template, job } or null.
    const image = () => {
      if (ownTpl()) return { ready: tplReady(ownTpl()), template: st.template };
      if (!st.preset) return null;
      const x = d.images?.[st.preset]?.[isolated() ? 'isolated' : 'plain'];
      return x?.template ? { ready: true, template: x.template } : x?.job ? { ready: false, job: x.job } : { ready: false };
    };
    const programOk = () => !!st.preset || !!ownTpl();
    const canGo = (id) => id === 'program' || programOk();
    const isDone = (id) => STEPS.indexOf(id) < STEPS.indexOf(st.step) && canGo(id);

    // ---------- the window ----------
    const stepper = h('nav', { class: 'aw-steps' });
    const body = h('div', { class: 'aw-body' });
    const foot = h('div', { class: 'aw-foot' });
    const dlg = h('dialog', { class: 'dialog ws-dialog aw-dialog' },
      h('header', {}, h('h3', {}, edit ? `Настройки агента «${prof.name}»` : 'Создать агента'),
        h('button', { type: 'button', class: 'btn ghost icon', title: 'Закрыть', 'aria-label': 'Закрыть', onclick: () => dlg.close() }, ic('x'))),
      stepper, h('div', { class: 'dialog-body' }, body), foot);
    let timer = null;
    dlg.addEventListener('close', () => { clearTimeout(timer); dlg.remove(); onDone?.(); });
    document.body.append(dlg);
    dlg.showModal();

    async function reload() {
      try { d = await api('GET', '/ui/sandbox'); } catch {}
      // Typing in a field: keep it (and its focus); only the steps and the image state catch up.
      const f = document.activeElement;
      if (f && body.contains(f) && /^(INPUT|TEXTAREA|SELECT)$/.test(f.tagName)) { drawSteps(); follow(); return; }
      draw();
    }
    // Follow an image being prepared.
    function follow() {
      clearTimeout(timer);
      const img = image();
      if (img && !img.ready && (img.job?.status === 'running') && dlg.open) timer = setTimeout(reload, 3000);
    }
    // Start preparing the image once the program and its isolation are known.
    let asked = '';
    async function ensureImage() {
      if (!st.preset || ownTpl()) return;
      const key = `${st.preset}:${isolated()}`;
      const img = image();
      if (img?.ready || img?.job?.status === 'running' || asked === key) return;
      asked = key;
      try { await api('POST', '/ui/sandbox/images', { preset: st.preset, isolated: isolated() }); }
      catch (e) { toast(oldServer ? RESTART : e.message, 'err', 15000); }
      await reload();
    }

    function imageNote(img) {
      if (!img) return null;
      if (img.ready) return h('span', { class: 'small okc' }, '✓ готов к запуску');
      if (img.job?.status === 'running') return h('span', { class: 'small muted' }, h('i', { class: 'spin' }), ` готовится: ${img.job.step}`);
      if (img.job?.status === 'error') return h('span', { class: 'small badc', title: img.job.error }, 'подготовка не удалась');
      return h('span', { class: 'small muted' }, 'подготовится один раз, ~3 мин');
    }

    function subOf(id) {
      if (id === 'program') return ownTpl() ? ownTpl().title : presetOf(st.preset)?.title;
      if (id === 'policy') return polOf(st.policy)?.name || '—';
      if (id === 'dirs') return st.dirs.length ? st.dirs.map((f) => base(f.hostPath)).join(', ') : 'нет';
      if (id === 'secrets') return st.secrets.length ? st.secrets.join(', ') : 'нет';
      return st.name;
    }

    function draw() {
      while (!canGo(st.step)) st.step = STEPS[Math.max(0, STEPS.indexOf(st.step) - 1)];
      drawSteps();
      const v = { program: programStep, policy: policyStep, dirs: dirsStep, secrets: secretsStep, task: taskStep }[st.step]();
      body.replaceChildren(...v.body.flat().filter(Boolean));
      foot.replaceChildren(...v.foot.flat().filter(Boolean));
      follow();
    }
    function drawSteps() {
      stepper.style.gridTemplateColumns = `repeat(${STEPS.length}, minmax(0, 1fr))`;
      stepper.replaceChildren(...STEPS.map((id, i) => {
        const done = isDone(id);
        return h('button', { type: 'button', class: `aw-step${st.step === id ? ' on' : ''}${done ? ' done' : ''}`, disabled: !canGo(id), onclick: () => go(id) },
          h('span', { class: 'aw-step-n' }, done ? '✓' : String(i + 1)),
          h('span', { class: 'aw-step-text' }, h('b', {}, TITLES[id]), h('span', { class: 'muted small' }, subOf(id) || '—')));
      }));
    }

    const go = (id) => {
      // Leaving «Программа»/«Изоляция»: the image starts getting ready while the rest is filled in.
      if (['program', 'policy'].includes(st.step) && id !== st.step && STEPS.indexOf(id) > STEPS.indexOf('policy')) ensureImage();
      st.step = id; draw();
    };
    const nextOf = () => STEPS[STEPS.indexOf(st.step) + 1];
    const prevOf = () => STEPS[STEPS.indexOf(st.step) - 1];
    const next = (label = 'Дальше') => { const n = nextOf(); return h('button', { class: 'btn primary', disabled: !n || !canGo(n), onclick: () => go(n) }, label, ' →'); };
    const back = () => { const p = prevOf(); return p ? h('button', { class: 'btn ghost', onclick: () => go(p) }, '← Назад') : null; };
    // Edit mode saves from any step.
    const saveBtns = () => (edit && st.step !== 'task' ? [h('button', { class: 'btn', onclick: () => submit(false) }, 'Сохранить')] : []);

    // ---------- 1. Программа ----------
    function programStep() {
      const tiles = presets.map((p) => {
        const x = d.images?.[p.id]?.[isolated() ? 'isolated' : 'plain'];
        const note = x?.template ? h('span', { class: 'small okc' }, '✓ готов') : x?.job?.status === 'running' ? h('span', { class: 'small muted' }, h('i', { class: 'spin' }), ' готовится') : null;
        return tile({ on: st.preset === p.id && !ownTpl(), title: p.desc, icon: mark(p.mark), name: p.title, sub: p.desc, note,
          onclick: () => { st.preset = p.id; st.template = null; draw(); } });
      });
      // Templates made from your own machines (not the prepared images).
      const own = d.templates.filter((t) => !t.auto && !t.creating).map((t) => tile({
        on: st.template === t.id, disabled: !tplReady(t), icon: ic('box'), name: t.title, sub: `из машины ${t.source}`,
        note: tplReady(t) ? null : h('span', { class: 'small muted' }, t.missing ? 'нет файла' : 'готовится'),
        onclick: () => {
          st.template = t.id; st.preset = null;
          st.net = t.egress?.enabled ? (t.egress?.strict ? 'strict' : 'soft') : 'off';
          if (polOf(st.policy) && (polOf(st.policy).net.mode === 'strict') !== (st.net === 'strict')) st.policy = st.net === 'strict' ? 'normal' : 'trusted';
          draw();
        },
      }));
      const img = image();
      return {
        body: [
          oldServer ? h('div', { class: 'ag-prep bad' }, h('b', {}, 'Нужно перезапустить smolvm-web'), h('span', {}, RESTART)) : null,
          h('p', { class: 'muted' }, 'Какая программа будет агентом. Её образ smolvm-web готовит один раз (несколько минут), дальше каждая задача открывается в чистой копии за секунды. Обновить программу — «Обновить агента» во вкладке «Шаблоны».'),
          h('div', { class: 'aw-tiles', role: 'radiogroup' }, ...tiles),
          own.length ? h('div', { class: 'ws-field' }, h('div', { class: 'label-like' }, 'Или шаблон из вашей машины — если в ней агент уже вошёл по подписке или стоят нужные пакеты'),
            h('div', { class: 'aw-tiles', role: 'radiogroup' }, ...own,
              plusTile('Шаблон из своей машины', 'вкладка «Шаблоны» → «Новый шаблон»', () => { dlg.close(); location.hash = '#/sandbox'; }))) : null,
          img ? h('div', { class: 'aw-summary small' }, h('b', {}, 'Образ: '), imageNote(img)) : null,
        ],
        foot: [h('span', { class: 'spacer' }), ...saveBtns(), next()],
      };
    }

    // ---------- 2. Политика ----------
    function policyStep() {
      const fixed = ownTpl(); // the hard isolation of your template is in its checkpoint
      const tplStrict = !!(fixed?.egress?.enabled && fixed?.egress?.strict);
      const tiles = (pl.policies || []).map((p) => {
        const off = !!fixed && (p.net.mode === 'strict') !== tplStrict;
        return tile({ on: st.policy === p.id, disabled: off, title: off ? 'Изоляция зашита в шаблон вашей машины — эта политика к нему не подходит' : p.about || '',
          icon: policyIcon(p), name: p.name, sub: pl.summaries?.[p.id] || '', onclick: () => { st.policy = p.id; draw(); } });
      });
      const add = plusTile('Новая политика', '⚙ → «Политики»', () => { dlg.close(); location.hash = '#/policies?new=1'; });
      const p = polOf(st.policy);
      const kv = (k, v) => h('div', {}, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));
      const listNames = (ids) => (ids === 'default' ? 'для новых машин' : (ids || []).map((id) => (eg.lists || []).find((l) => l.id === id)?.name || id).join(', ') || 'нет');
      return {
        body: [
          h('p', { class: 'muted' }, 'С какими ограничениями агент работает в каждой задаче: сеть, директории, права в машине, процессы, сроки. В самой задаче политику можно выбрать другую.'),
          h('div', { class: 'aw-tiles', role: 'radiogroup' }, ...tiles, add),
          p ? card(`Что разрешает «${p.name}»`, h('a', { class: 'small', href: `#/policies?id=${enc(p.id)}`, onclick: () => dlg.close() }, 'открыть политику →'),
            h('div', { class: 'kv aw-kv' },
              kv('Сеть', { strict: 'только разрешённое — обойти нельзя', soft: 'только разрешённое, без изоляции', off: 'без ограничений' }[p.net.mode]),
              p.net.mode === 'off' ? null : kv('Незнакомые адреса', { deny: 'запрещать', ask: 'спрашивать вас', allow: 'пропускать' }[p.net.unknown]),
              p.net.mode === 'off' ? null : kv('Белые списки', listNames(p.net.lists)),
              kv('Права в машине', p.account.sudo ? 'sudo (root)' : 'без root'),
              kv('Запрещённые программы', p.processes.deny.length ? p.processes.deny.join(', ') : 'нет'),
              kv('Журнал процессов', p.processes.journal ? 'ведётся' : 'нет'),
              kv('Срок задачи', p.time.ttlHours ? `${p.time.ttlHours} ч` : 'без срока'))) : null,
          st.preset && !fixed ? h('div', { class: 'muted small' }, 'С жёсткой изоляцией и без неё у программы разные образы — нужный подготовится сам.') : null,
        ],
        foot: [back(), h('span', { class: 'spacer' }), ...saveBtns(), next()],
      };
    }

    // ---------- 3. Директории ----------
    function dirsStep() {
      const home = state.info?.home || '\u0000';
      const add = () => openFolderDialog({ fixedMachine: '__new', sandbox: true, mode: 'review',
        onDone: (b) => { st.dirs = st.dirs.filter((x) => x.hostPath !== b.hostPath).concat([{ hostPath: b.hostPath, mode: b.mode === 'ro' ? 'ro' : 'review' }]); draw(); } });
      const rows = st.dirs.map((f) => h('div', { class: 'aw-row' },
        h('span', { class: 'mark m-icon' }, ic('folder')),
        h('div', { class: 'aw-row-text' }, h('b', { class: 'mono ellipsis', title: f.hostPath }, f.hostPath.replace(home, '~')),
          h('span', { class: 'muted small' }, f.mode === 'ro' ? 'агент видит копию; на компьютер ничего не записывается' : 'git-репозиторий — результат веткой; директория без git — копия, изменения после проверки')),
        h('span', { class: `tag ${f.mode === 'ro' ? 'ok' : 'accent'}` }, DIR_MODES[f.mode] || f.mode),
        h('button', { type: 'button', class: 'btn ghost small-btn', onclick: () => openFolderDialog({ fixedMachine: '__new', sandbox: true, hostPath: f.hostPath, mode: f.mode,
          onDone: (b) => { Object.assign(f, { hostPath: b.hostPath, mode: b.mode === 'ro' ? 'ro' : 'review' }); draw(); } }) }, 'Изменить'),
        h('button', { type: 'button', class: 'btn ghost icon danger', title: 'Убрать', 'aria-label': `Убрать ${base(f.hostPath)}`, onclick: () => { st.dirs = st.dirs.filter((x) => x !== f); draw(); } }, ic('x'))));
      return {
        body: [
          h('p', { class: 'muted' }, 'Какие директории компьютера агент получает в каждой задаче. Директорию можно дать и в самой задаче, а для репозитория удобнее «Проекты».'),
          card('Директории агента', h('button', { type: 'button', class: 'btn small-btn', onclick: add }, ic('plus'), 'Дать доступ к директории'),
            rows.length ? h('div', { class: 'aw-rows' }, ...rows) : h('p', { class: 'muted small' }, 'Пока ни одной: агент получит только чистую машину.')),
          card('Как агент получает директорию', null,
            h('ul', { class: 'small aw-hints' },
              h('li', {}, h('b', {}, 'Git-репозиторий'), ' — текущий код без истории; работа агента возвращается веткой, ваша директория не меняется, пока вы не нажмёте «Влить».'),
              h('li', {}, h('b', {}, 'Копия с проверкой'), ' — для директории без git: агент правит копию, на диск попадёт только то, что вы примете.'),
              h('li', {}, h('b', {}, 'Только чтение'), ' — агент видит копию; на компьютер из неё ничего не записывается.'),
              h('li', { class: 'muted' }, 'Прямой доступ «Чтение и запись» в задаче невозможен: smolvm не подключает директории к машине из образа.'))),
        ],
        foot: [back(), h('span', { class: 'spacer' }), ...saveBtns(), next()],
      };
    }

    // ---------- 4. Секреты ----------
    function secretsStep() {
      const p = presetOf(st.preset);
      const tiles = (vault.secrets || []).map((x) => tile({
        on: st.secrets.includes(x.name), icon: ic('key'), name: x.name, mono: true,
        sub: [x.mode === 'gateway' ? `через шлюз → ${x.upstream}` : x.mode === 'substitute' ? `подстановка: ${(x.hosts || []).join(', ')}` : `переменная ${x.envVar}`, x.note].filter(Boolean).join(' · '),
        onclick: () => { st.secrets = st.secrets.includes(x.name) ? st.secrets.filter((n) => n !== x.name) : [...st.secrets, x.name]; draw(); },
      }));
      const add = plusTile('Новый секрет', 'ключ модели или токен', () => newSecret(), vault.ok === false);
      // smolvm's own substitution needs a copy without the filter (strict egress under serve).
      const clash = netMode() !== 'off' ? (vault.secrets || []).filter((x) => st.secrets.includes(x.name) && x.mode === 'substitute').map((x) => x.name) : [];
      return {
        body: [
          h('p', { class: 'muted' }, 'Ключи моделей и токены из «Секретов». Агент пользуется ими через шлюз и не видит значений. Отметьте нужные.'),
          p?.keys?.length ? h('div', { class: 'muted small' }, `Программе ${p.title} нужен ключ модели: ${p.keys.join(', ')}.`) : null,
          vault.ok === false ? h('div', { class: 'error small' }, vault.error) : null,
          h('div', { class: 'aw-tiles' }, ...tiles, add),
          clash.length ? h('div', { class: 'ag-prep bad' }, h('b', {}, `${clash.join(', ')}: режим «Подстановка smolvm» не работает вместе с фильтром «Сеть»`),
            h('span', {}, 'Переведите секрет в режим «Шлюз smolvm-web» на странице «Секреты» («Изменить»), снимите его здесь или выберите политику с сетью «Без ограничений».')) : null,
        ],
        foot: [back(), h('span', { class: 'spacer' }), ...saveBtns(), h('button', { class: 'btn primary', disabled: clash.length > 0, onclick: () => go('task') }, 'Дальше →')],
      };
    }

    // «+ Новый секрет»: the provider, the key — and it is chosen at once.
    function newSecret() {
      const presetsOf = window.SECRET_PRESETS || {};
      const sel = h('select', { class: 'input', id: 'aw-s-preset' }, h('option', { value: '' }, '— свой —'),
        ...Object.entries({ deepseek: 'DeepSeek', anthropic: 'Anthropic', openai: 'OpenAI', openrouter: 'OpenRouter', gemini: 'Google Gemini', github: 'GitHub' })
          .filter(([k]) => presetsOf[k]).map(([k, t]) => h('option', { value: k }, t)));
      const name = h('input', { class: 'input mono', id: 'aw-s-name', placeholder: 'deepseek', maxlength: 64 });
      const envVar = h('input', { class: 'input mono', id: 'aw-s-env', placeholder: 'DEEPSEEK_API_KEY' });
      const value = h('input', { class: 'input mono', id: 'aw-s-value', type: 'password', placeholder: 'sk-…', autocomplete: 'off' });
      const want = presetOf(st.preset)?.keys?.[0];
      sel.addEventListener('change', () => { const x = presetsOf[sel.value]; if (x) { name.value = x.name; envVar.value = x.envVar; } });
      if (want && presetsOf[want]) { sel.value = want; sel.dispatchEvent(new Event('change')); }
      const err = h('div', { class: 'error small', hidden: true });
      const save = h('button', { class: 'btn primary', type: 'button' }, 'Сохранить и выбрать');
      const box = h('dialog', { class: 'dialog small' },
        h('header', {}, h('h3', {}, 'Новый секрет'), h('button', { type: 'button', class: 'btn ghost icon', 'aria-label': 'Закрыть', onclick: () => box.close() }, ic('x'))),
        h('div', { class: 'dialog-body' },
          h('label', { for: 'aw-s-preset' }, 'Шаблон', sel),
          h('label', { for: 'aw-s-name' }, 'Имя секрета', name),
          h('label', { for: 'aw-s-env' }, 'Переменная для ключа', envVar),
          h('label', { for: 'aw-s-value' }, 'Значение', value),
          h('p', { class: 'muted small' }, 'Ключ хранится в зашифрованном хранилище. Ключи моделей передаются через шлюз: машина их не видит. Остальные параметры — на странице «Секреты».'),
          err),
        h('footer', {}, h('button', { class: 'btn ghost', type: 'button', onclick: () => box.close() }, 'Отмена'), save));
      save.addEventListener('click', async () => {
        const n = name.value.trim();
        if (!/^[A-Za-z0-9_.-]{1,64}$/.test(n)) { err.textContent = 'Имя: латиница, цифры, «_», «.», «-»'; err.hidden = false; return; }
        if (!value.value) { err.textContent = 'Укажите значение'; err.hidden = false; return; }
        const x = presetsOf[sel.value] || {};
        // A model key goes through the gateway: it works with the «Сеть» filter and behind a proxy.
        const mode = x.mode || (x.upstream ? 'gateway' : 'env');
        const req = { mode, envVar: envVar.value.trim() || x.envVar, baseUrlVar: x.baseUrlVar || '', upstream: x.upstream || '', allowHttp: !!x.allowHttp, model: x.model || '',
          confirm: x.confirm ? x.confirm.split(',').map((s) => s.trim()).filter(Boolean) : [], hosts: x.hosts ? String(x.hosts).split(',').map((s) => s.trim()).filter(Boolean) : [], methods: [], note: '', value: value.value };
        try { await api('PUT', `/ui/vault/${enc(n)}`, req); } catch (e) { err.textContent = e.message; err.hidden = false; return; }
        value.value = '';
        box.close();
        try { vault = await api('GET', '/ui/vault'); } catch {}
        st.secrets = [...new Set([...st.secrets, n])];
        toast(`Секрет ${n} сохранён`, 'ok');
        draw();
      });
      box.addEventListener('close', () => box.remove());
      document.body.append(box);
      box.showModal();
      setTimeout(() => (sel.value ? value : sel).focus(), 0);
    }

    // ---------- 5. Агент ----------
    function taskStep() {
      const tpl = ownTpl() || tplOf(image()?.template);
      const ids = tpl ? agentsOf(tpl) : (presetOf(st.preset)?.agents || []).map((a) => a.id).filter((id) => id !== 'terminal');
      if (!ids.includes(st.agent)) st.agent = ids[0] || null;
      const name = h('input', { class: 'input', id: 'aw-name', value: st.name, maxlength: 60, placeholder: 'Например: Бэкенд' });
      name.addEventListener('input', () => { st.name = name.value; });
      const program = ids.length > 1 ? h('div', { class: 'ws-agents', role: 'radiogroup', 'aria-label': 'Интерфейс' }, ...ids.map((id) => h('button', {
        type: 'button', role: 'radio', 'aria-checked': String(id === st.agent), class: `ws-agent${id === st.agent ? ' on' : ''}`,
        onclick: () => { st.agent = id; draw(); },
      }, mark(d.agentTitles?.[id]?.mark || 'term', true), h('span', {}, d.agentTitles?.[id]?.title || id)))) : null;

      const review = h('input', { type: 'checkbox', id: 'aw-review', checked: st.review });
      review.addEventListener('change', () => { st.review = review.checked; });
      const inTab = h('input', { type: 'checkbox', id: 'aw-tab', checked: st.inTab });
      inTab.addEventListener('change', () => { st.inTab = inTab.checked; });
      const running = (state.machines || []).filter((m) => m.state === 'running' && !state.marks?.[m.name]?.sandbox);
      const from = edit ? null : h('select', { class: 'input', id: 'aw-from' }, h('option', { value: '' }, 'Начать с чистого листа'),
        running.map((m) => h('option', { value: m.name, selected: st.from === m.name }, `Взять инструкции, MCP и skills из машины ${m.name}`)));
      from?.addEventListener('change', () => { st.from = from.value; });

      const img = image();
      const save = h('button', { class: 'btn', onclick: () => submit(false) }, edit ? 'Сохранить' : 'Создать агента');
      const run = h('button', { class: 'btn primary', disabled: !img?.ready, title: img?.ready ? '' : 'Образ программы ещё готовится — запуск станет доступен сам', onclick: () => submit(true) },
        ic('play'), edit ? 'Сохранить и запустить' : 'Создать и запустить');
      return {
        body: [
          h('p', { class: 'muted' }, 'Как агента зовут, через какой интерфейс он работает и что запоминает между задачами.'),
          h('div', { class: 'aw-grid2' },
            card('Агент', null,
              h('label', { class: 'ws-field', for: 'aw-name' }, 'Имя', name),
              program ? h('div', { class: 'ws-field' }, h('div', { class: 'label-like' }, 'Интерфейс'), program) : null),
            card('Память', edit ? h('a', { class: 'small', href: `#/profile?id=${enc(prof.id)}`, onclick: () => dlg.close() }, 'инструкции, MCP, skills →') : null,
              from ? h('label', { class: 'ws-field', for: 'aw-from' }, 'С чего начать', from) : null,
              h('label', { class: 'ag-check', for: 'aw-review' }, review, h('span', {}, 'Проверять, что агент запоминает', h('span', { class: 'muted small' }, ' — skills, MCP и настройки сохранятся только после вашего «да»'))))),
          card('Запуск', null,
            h('label', { class: 'ag-check', for: 'aw-tab' }, inTab, h('span', {}, 'Открывать агента в отдельной вкладке браузера')),
            img && !img.ready ? h('div', { class: 'ag-prep' }, h('b', {}, 'Образ программы готовится'), imageNote(img),
              h('span', { class: 'small' }, 'Агента можно создать уже сейчас; «Создать и запустить» включится, когда образ будет готов. Окно можно закрыть.')) : null),
        ],
        foot: [back(), edit ? h('button', { class: 'btn ghost danger', onclick: removeAgent }, ic('trash'), 'Удалить агента') : null, h('span', { class: 'spacer' }), save, run],
      };
    }

    async function removeAgent() {
      if (d.sandboxes.some((x) => x.profile === prof.id)) { toast('Сначала закончите его открытые сессии', 'err'); return; }
      const c = await confirmDialog('Удалить агента?', `«${prof.name}» и его память (инструкции, MCP, skills) будут удалены. Образ программы останется.`, false, '', 'Удалить');
      if (!c.ok) return;
      try { await api('DELETE', `/ui/sandbox/profiles/${enc(prof.id)}`); toast('Агент удалён', 'ok'); dlg.close(); } catch (e) { toast(e.message, 'err'); }
    }

    async function submit(start) {
      if (oldServer) { toast(RESTART, 'err', 15000); return; }
      if (!st.name.trim()) { toast('Дайте агенту имя', 'err'); go('task'); $('#aw-name')?.focus(); return; }
      if (!programOk()) { toast('Выберите программу', 'err'); go('program'); return; }
      if (start && trustOf(polOf(st.policy)) === 'trusted') {
        const c = await confirmDialog('Пропускать неизвестные адреса?', 'Агент сможет ходить куда угодно в интернете и ничего не будет спрашивать. Всё, что он увидит в копиях директорий, он сможет отправить наружу.', false, '', 'Да, доверяю');
        if (!c.ok) return;
      }
      ensureImage();
      // The tab opens on the click itself: later the browser would block it.
      const tab = start && st.inTab ? agentTab() : null;
      const fields = {
        name: st.name.trim(), preset: st.preset, template: ownTpl() ? st.template : null, agent: st.agent,
        net: netMode(), lists: st.lists, secrets: st.secrets, folders: st.dirs, folder: null,
        trust: trustOf(polOf(st.policy)), policy: st.policy,
      };
      let id = prof?.id;
      try {
        if (edit) await api('PUT', `/ui/sandbox/profiles/${enc(id)}`, { ...fields, autoSave: !st.review });
        else {
          id = (await api('POST', '/ui/sandbox/profiles', { ...fields, from: st.from || null })).id;
          if (!st.review) await api('PUT', `/ui/sandbox/profiles/${enc(id)}`, { autoSave: true });
        }
        try { localStorage.setItem('smolvm.agentTab', st.inTab ? '1' : '0'); } catch {}
      } catch (e) { if (tab) tab.close(); toast(e.message, 'err', 10000); return; }
      if (!start) {
        toast(edit ? 'Сохранено' : `Агент «${fields.name}» создан${image()?.ready ? '' : ' — образ программы готовится, запуск станет доступен через несколько минут'}`, 'ok', 8000);
        dlg.close(); return;
      }
      foot.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      foot.append(h('span', { class: 'muted small' }, h('i', { class: 'spin' }), ' Запускается…'));
      try {
        const r = await api('POST', '/ui/tasks', { profile: id, agent: st.agent, policy: st.policy, template: ownTpl() ? st.template : null });
        dlg.close();
        if (tab && r.url) { agentInTab(r.name, true); goAgent(tab, r.url); } else if (tab) tab.close();
        toast('Агент запущен', 'ok');
        refreshMachines();
        location.hash = `#/tasks?id=${enc(r.taskId)}`;
      } catch (e) {
        if (tab) tab.close();
        toast(e.message, 'err', 12000);
        draw();
      }
    }

    if (step && STEPS.includes(step)) st.step = step;
    else if (edit) st.step = 'task';
    draw();
  };
})();
