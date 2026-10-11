'use strict';
// «Создать агента» / настройки агента: one wide window, step by step:
//   Программа → Изоляция → Директории → Секреты → Доверие → Агент
// The program is an agent preset. smolvm-web keeps one image per preset (with or without
// hard isolation) and prepares it once, in the background; every task opens a clean copy
// of it. The agent's own network, directories and secrets are applied to each copy.
// A template made from your own machine can be chosen instead of a preset.

(() => {
  const TITLES = { program: 'Программа', net: 'Изоляция', dirs: 'Директории', secrets: 'Секреты', trust: 'Доверие', task: 'Агент' };
  const STEPS = ['program', 'net', 'dirs', 'secrets', 'trust', 'task'];
  const NET_MODES = [
    ['strict', 'Только разрешённое', 'Всё, чего нет в белых списках, блокируется. Обойти фильтр нельзя: копия изолирована на уровне smolvm. Рекомендуется для агентов.'],
    ['soft', 'Только разрешённое, без изоляции', 'Фильтр работает через прокси — для программ, которым нужны сервисы этого компьютера. Программа может его обойти.'],
    ['off', 'Без ограничений', 'Копия ходит в интернет как этот компьютер.'],
  ];
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
  // «+»: make a new one of the kind.
  function plusTile(name, sub, onclick, disabled) {
    return h('button', { type: 'button', class: 'aw-tile aw-plus', disabled: !!disabled, onclick },
      h('span', { class: 'aw-tile-ic' }, ic('plus')), h('span', { class: 'aw-tile-text' }, h('b', {}, name), h('span', { class: 'muted small' }, sub)));
  }

  window.agentWizard = async function agentWizard({ profile = null, step = null, onDone } = {}) {
    const ui = window.agentUi;
    let d; let eg; let vault;
    try {
      [d, presetsCache, eg, vault] = await Promise.all([
        api('GET', '/ui/sandbox'),
        presetsCache || api('GET', '/ui/profiles').then((r) => r.profiles),
        api('GET', '/ui/egress').catch(() => ({ lists: [], defaults: {} })),
        api('GET', '/ui/vault').catch(() => ({ secrets: [] })),
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
    };
    try { st.inTab = localStorage.getItem('smolvm.agentTab') === '1'; } catch {}
    // A template of your own machine carries its isolation: the mode is fixed by it.
    const ownTpl = () => (st.template ? tplOf(st.template) : null);
    const isolated = () => st.net === 'strict';
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
      if (id === 'net') return NET_MODES.find(([v]) => v === st.net)?.[1];
      if (id === 'dirs') return st.dirs.length ? st.dirs.map((f) => base(f.hostPath)).join(', ') : 'нет';
      if (id === 'secrets') return st.secrets.length ? st.secrets.join(', ') : 'нет';
      if (id === 'trust') return ui.TRUST[st.trust]?.title;
      return st.name;
    }

    function draw() {
      while (!canGo(st.step)) st.step = STEPS[Math.max(0, STEPS.indexOf(st.step) - 1)];
      drawSteps();
      const v = { program: programStep, net: netStep, dirs: dirsStep, secrets: secretsStep, trust: trustStep, task: taskStep }[st.step]();
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
      if (['program', 'net'].includes(st.step) && id !== st.step && STEPS.indexOf(id) > STEPS.indexOf('net')) ensureImage();
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

    // ---------- 2. Изоляция ----------
    function netStep() {
      const fixed = !!ownTpl(); // the hard isolation of your template is in its checkpoint
      const cards = h('div', { class: 'aw-cards', role: 'radiogroup' }, ...NET_MODES.map(([v, t, desc]) => {
        const off = fixed && (v === 'strict') !== (st.net === 'strict');
        return h('button', {
          type: 'button', role: 'radio', 'aria-checked': String(st.net === v), class: `aw-card${st.net === v ? ' on' : ''}`, disabled: off,
          title: off ? 'Жёсткая изоляция задана в шаблоне вашей машины' : '', onclick: () => { st.net = v; draw(); },
        }, h('b', {}, t), h('span', { class: 'muted small' }, desc));
      }));
      const lists = h('div', { class: 'aw-lists' });
      if (st.net !== 'off' && window.egressListsPicker) {
        window.egressListsPicker(lists, {
          selected: st.lists,
          onToggle: (id, on) => { st.lists = on ? [...new Set([...st.lists, id])] : st.lists.filter((x) => x !== id); },
        });
      }
      return {
        body: [
          h('p', { class: 'muted' }, 'Куда копия агента сможет ходить в интернет. Действует на каждую задачу агента.'), cards,
          st.preset && !fixed ? h('div', { class: 'muted small' }, 'С жёсткой изоляцией и без неё у программы разные образы — нужный подготовится сам.') : null,
          st.net === 'off' ? null : h('div', { class: 'ws-field' }, h('div', { class: 'label-like' }, 'Белые списки'), lists,
            h('span', { class: 'muted small' }, 'Серверы самого агента (API модели, вход по подписке) разрешаются автоматически.')),
        ],
        foot: [back(), h('span', { class: 'spacer' }), ...saveBtns(), next()],
      };
    }

    // ---------- 3. Директории ----------
    function dirsStep() {
      const tiles = st.dirs.map((f) => tile({
        on: true, icon: ic('folder'), name: base(f.hostPath), title: f.hostPath,
        sub: f.hostPath.replace(state.info?.home || '\u0000', '~'),
        note: h('span', { class: 'tag' }, DIR_MODES[f.mode] || f.mode),
        extra: h('span', { class: 'aw-tile-x', role: 'button', tabindex: '0', title: 'Убрать', 'aria-label': `Убрать ${base(f.hostPath)}`,
          onclick: (e) => { e.stopPropagation(); st.dirs = st.dirs.filter((x) => x !== f); draw(); } }, ic('x')),
        onclick: () => openFolderDialog({ fixedMachine: '__new', sandbox: true, hostPath: f.hostPath, mode: f.mode,
          onDone: (b) => { Object.assign(f, { hostPath: b.hostPath, mode: b.mode === 'ro' ? 'ro' : 'review' }); draw(); } }),
      }));
      const add = plusTile('Дать доступ к папке', 'выбрать папку компьютера и режим', () => openFolderDialog({
        fixedMachine: '__new', sandbox: true, mode: 'review',
        onDone: (b) => { st.dirs = st.dirs.filter((x) => x.hostPath !== b.hostPath).concat([{ hostPath: b.hostPath, mode: b.mode === 'ro' ? 'ro' : 'review' }]); draw(); },
      }));
      return {
        body: [
          h('p', { class: 'muted' }, 'Какие папки компьютера получает агент. В каждой задаче — свежая копия папки; ваши файлы меняются только после проверки.'),
          h('div', { class: 'aw-tiles' }, ...tiles, add),
          h('ul', { class: 'small muted aw-hints' },
            h('li', {}, h('b', {}, 'Копия с проверкой'), ' — агент правит копию; на диск попадёт только то, что вы примете в «Решениях».'),
            h('li', {}, h('b', {}, 'Только чтение'), ' — агент видит копию; на компьютер из неё ничего не записывается.'),
            h('li', {}, 'Прямой доступ «Чтение и запись» в песочнице невозможен: smolvm не подключает папки к копии из образа.')),
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
      const clash = st.net !== 'off' ? (vault.secrets || []).filter((x) => st.secrets.includes(x.name) && x.mode === 'substitute').map((x) => x.name) : [];
      return {
        body: [
          h('p', { class: 'muted' }, 'Ключи моделей и токены из «Секретов». Агент пользуется ими через шлюз и не видит значений. Отметьте нужные.'),
          p?.keys?.length ? h('div', { class: 'muted small' }, `Программе ${p.title} нужен ключ модели: ${p.keys.join(', ')}.`) : null,
          vault.ok === false ? h('div', { class: 'error small' }, vault.error) : null,
          h('div', { class: 'aw-tiles' }, ...tiles, add),
          clash.length ? h('div', { class: 'ag-prep bad' }, h('b', {}, `${clash.join(', ')}: режим «Подстановка smolvm» не работает вместе с фильтром «Сеть»`),
            h('span', {}, 'Переведите секрет в режим «Шлюз smolvm-web» на странице «Секреты» («Изменить»), снимите его здесь или выберите на шаге «Изоляция» «Без ограничений».')) : null,
        ],
        foot: [back(), h('span', { class: 'spacer' }), ...saveBtns(), h('button', { class: 'btn primary', disabled: clash.length > 0, onclick: () => go('trust') }, 'Дальше →')],
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

    // ---------- 5. Доверие и время жизни ----------
    function trustStep() {
      const num = (id, value, max, onIn) => {
        const x = h('input', { class: 'input aw-num', id, type: 'number', min: 0, max, value: value || '' });
        x.addEventListener('input', () => onIn(Math.max(0, Math.min(max, Math.floor(Number(x.value) || 0)))));
        return x;
      };
      const idleOn = h('input', { type: 'checkbox', id: 'aw-idle-on', checked: st.idle > 0 });
      const ttlOn = h('input', { type: 'checkbox', id: 'aw-ttl-on', checked: st.ttl > 0 });
      const idleIn = num('aw-idle', st.idle || 30, 7 * 24 * 60, (v) => { idleOn.checked = v > 0; st.idle = v; });
      const ttlIn = num('aw-ttl', st.ttl || 8, 30 * 24, (v) => { ttlOn.checked = v > 0; st.ttl = v; });
      idleOn.addEventListener('change', () => { st.idle = idleOn.checked ? Number(idleIn.value) || 30 : 0; });
      ttlOn.addEventListener('change', () => { st.ttl = ttlOn.checked ? Number(ttlIn.value) || 8 : 0; });
      return {
        body: [
          h('p', { class: 'muted' }, 'Насколько вы доверяете агенту: что делать с адресами, которых нет в белых списках.'),
          ui.trustPicker(st.trust, (id) => { st.trust = id; draw(); }),
          h('div', { class: 'aw-life' },
            h('b', {}, 'Когда удалять песочницу'),
            h('span', { class: 'muted small' }, '«Закончить» в сессии удаляет её сразу. А если забыть — вот что сделает smolvm-web сам; то, что агент запомнил, всё равно уйдёт к вам на проверку.'),
            h('div', { class: 'aw-life-row' }, idleOn, h('label', { for: 'aw-idle-on' }, 'После простоя агента'), idleIn, h('span', { class: 'muted' }, 'мин'),
              h('span', { class: 'muted small' }, '— агент не ходит в сеть и не обращается к модели')),
            h('div', { class: 'aw-life-row' }, ttlOn, h('label', { for: 'aw-ttl-on' }, 'В любом случае через'), ttlIn, h('span', { class: 'muted' }, 'ч')),
            st.trust === 'careful' && !st.ttl ? h('span', { class: 'muted small' }, 'Уровень «Осторожно» сам ограничивает жизнь песочницы двумя часами.') : null),
        ],
        foot: [back(), h('span', { class: 'spacer' }), ...saveBtns(), next()],
      };
    }

    // ---------- 6. Задача ----------
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
          h('div', { class: 'aw-col aw-narrow' },
            h('label', { class: 'ws-field', for: 'aw-name' }, 'Имя агента', name),
            program ? h('div', { class: 'ws-field' }, h('div', { class: 'label-like' }, 'Интерфейс агента'), program) : null,
            from ? h('label', { class: 'ws-field', for: 'aw-from' }, 'Память агента', from) : null,
            h('label', { class: 'ag-check', for: 'aw-review' }, review, h('span', {}, 'Проверять, что агент запоминает', h('span', { class: 'muted small' }, ' — skills, MCP и настройки сохранятся только после вашего «да»'))),
            h('label', { class: 'ag-check', for: 'aw-tab' }, inTab, h('span', {}, 'Открывать агента в отдельной вкладке браузера')),
            img && !img.ready ? h('div', { class: 'ag-prep' }, h('b', {}, 'Образ программы готовится'), imageNote(img),
              h('span', { class: 'small' }, 'Агента можно создать уже сейчас; «Создать и запустить» включится, когда образ будет готов. Окно можно закрыть.')) : null,
            edit ? h('a', { href: `#/profile?id=${enc(prof.id)}`, onclick: () => dlg.close() }, 'Память агента: инструкции, MCP, skills →') : null,
            edit ? h('button', { class: 'btn ghost danger aw-del', onclick: removeAgent }, ic('trash'), 'Удалить агента') : null),
        ],
        foot: [back(), h('span', { class: 'spacer' }), save, run],
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
      if (start && st.trust === 'trusted') {
        const c = await confirmDialog('Пропускать неизвестные адреса?', 'Агент сможет ходить куда угодно в интернете и ничего не будет спрашивать. Всё, что он увидит в копиях папок, он сможет отправить наружу.', false, '', 'Да, доверяю');
        if (!c.ok) return;
      }
      ensureImage();
      // The tab opens on the click itself: later the browser would block it.
      const tab = start && st.inTab ? agentTab() : null;
      const fields = {
        name: st.name.trim(), preset: st.preset, template: ownTpl() ? st.template : null, agent: st.agent,
        net: st.net, lists: st.lists, secrets: st.secrets, folders: st.dirs, folder: null,
        trust: st.trust, idleMinutes: st.idle, ttlHours: st.ttl,
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
        const r = await api('POST', '/ui/sandbox/open', { profile: id, agent: st.agent, trust: st.trust, template: ownTpl() ? st.template : null });
        dlg.close();
        if (tab && r.url) { agentInTab(r.name, true); goAgent(tab, r.url); } else if (tab) tab.close();
        toast('Агент запущен', 'ok');
        refreshMachines();
        location.hash = `#/session?name=${enc(r.name)}`;
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
