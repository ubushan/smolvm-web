'use strict';
// Access: the login window, and ⚙ → «Настройки…» → «Доступ» — accounts with roles and
// the administrator's policy (rules every task obeys; the server checks them on open).

(() => {
  const ROLE = { viewer: 'Наблюдатель', operator: 'Оператор', admin: 'Администратор' };
  const ROLE_HINT = {
    viewer: 'смотрит задачи, входящие, журнал и настройки — ничего не меняет',
    operator: 'даёт задачи, отвечает на запросы агентов, проверяет и принимает результат, «Остановить всё»',
    admin: 'всё: агенты, проекты, сеть, секреты, машины, настройки, доступ и политика',
  };

  // ---------- login ----------
  let shown = false;
  window.showLogin = function showLogin() {
    if (shown) return;
    shown = true;
    const name = h('input', { class: 'input', id: 'lg-name', autocomplete: 'username', spellcheck: 'false' });
    const pass = h('input', { class: 'input', id: 'lg-pass', type: 'password', autocomplete: 'current-password' });
    const out = h('div', { class: 'error small', hidden: true });
    const go = h('button', { class: 'btn primary', type: 'submit' }, 'Войти');
    const dlg = h('dialog', { class: 'dialog small login-dialog' },
      h('form', { method: 'dialog', onsubmit: async (e) => {
        e.preventDefault();
        go.disabled = true; out.hidden = true;
        try { await api('POST', '/ui/auth/login', { name: name.value.trim(), password: pass.value }); location.reload(); }
        catch (err) { out.textContent = err.message; out.hidden = false; go.disabled = false; pass.select(); }
      } },
        h('header', {}, h('h3', {}, 'Вход в smolvm-web')),
        h('div', { class: 'dialog-body' },
          h('label', { class: 'ws-field', for: 'lg-name' }, 'Имя', name),
          h('label', { class: 'ws-field', for: 'lg-pass' }, 'Пароль', pass),
          out, go)));
    // No way around it: Escape does not close it.
    dlg.addEventListener('cancel', (e) => e.preventDefault());
    document.body.append(dlg);
    dlg.showModal();
    setTimeout(() => name.focus(), 0);
  };

  // ---------- ⚙ → «Доступ» ----------
  window.renderAccess = async function renderAccess(box) {
    let users; let pol;
    try {
      const [u, st] = await Promise.all([api('GET', '/ui/access/users'), api('GET', '/ui/auth/state')]);
      users = u.users; pol = st.policy;
    } catch (e) { fill(box, h('div', { class: 'error' }, e.message)); return; }
    const redraw = () => renderAccess(box);
    const me = window.auth.user?.name;

    // Accounts
    const roleSel = (value) => h('select', { class: 'input small' }, Object.entries(ROLE).map(([v, t]) => h('option', { value: v, selected: v === value }, t)));
    const rows = users.map((u) => {
      const sel = roleSel(u.role);
      sel.addEventListener('change', async () => {
        try { await api('PUT', `/ui/access/users/${enc(u.name)}`, { role: sel.value }); toast(`${u.name}: ${ROLE[sel.value].toLowerCase()}`, 'ok'); } catch (e) { toast(e.message, 'err'); }
        if (u.name === me) location.reload(); else redraw();
      });
      return h('div', { class: 'acc-row' },
        h('div', {}, h('b', {}, u.name), u.name === me ? h('span', { class: 'muted small' }, ' (вы)') : null,
          h('div', { class: 'muted small' }, u.disabled ? 'отключена' : u.lastLogin ? `входил ${fmtAgo(Math.floor(u.lastLogin / 1000))}` : 'ещё не входил')),
        sel,
        h('button', { type: 'button', class: 'btn ghost small-btn', onclick: () => passwordDialog(u.name, redraw) }, 'Пароль'),
        h('button', { type: 'button', class: 'btn ghost small-btn', onclick: async () => {
          try { await api('PUT', `/ui/access/users/${enc(u.name)}`, { disabled: !u.disabled }); } catch (e) { toast(e.message, 'err'); }
          redraw();
        } }, u.disabled ? 'Включить' : 'Отключить'),
        h('button', { type: 'button', class: 'btn ghost icon danger', title: 'Удалить', 'aria-label': `Удалить ${u.name}`, onclick: async () => {
          const last = users.length === 1;
          const c = await confirmDialog(`Удалить ${u.name}?`, last ? 'Это последняя учётная запись: вход выключится, и smolvm-web снова будет открыт всем, кто до него доберётся, с правами администратора.' : 'Её сессии закончатся сразу.', false, '', 'Удалить');
          if (!c.ok) return;
          try { await api('DELETE', `/ui/access/users/${enc(u.name)}`); } catch (e) { toast(e.message, 'err'); return; }
          if (last || u.name === me) location.reload(); else redraw();
        } }, ic('trash')));
    });
    const first = !users.length;
    const nName = h('input', { class: 'input', placeholder: 'имя', autocomplete: 'off', spellcheck: 'false' });
    const nPass = h('input', { class: 'input', type: 'password', placeholder: 'пароль, от 10 символов', autocomplete: 'new-password' });
    const nRole = roleSel(first ? 'admin' : 'operator');
    if (first) nRole.disabled = true;
    const add = h('button', { type: 'button', class: 'btn primary', onclick: async () => {
      if (first && !(await confirmDialog('Включить вход?', 'После этого smolvm-web будет требовать вход у всех, включая вас. Запомните пароль: восстановить его можно, только удалив файл access.json в директории настроек smolvm-web.', false, '', 'Включить вход')).ok) return;
      try {
        await api('PUT', `/ui/access/users/${enc(nName.value.trim())}`, { role: nRole.value, password: nPass.value });
        toast(first ? 'Вход включён — вы вошли как администратор' : `Учётная запись ${nName.value.trim()} создана`, 'ok');
        if (first) { location.reload(); return; }
        redraw();
      } catch (e) { toast(e.message, 'err'); }
    } }, first ? 'Создать и включить вход' : 'Добавить');

    // Policy
    const trust = h('select', { class: 'input' }, [['careful', 'Осторожно'], ['normal', 'Обычно'], ['trusted', 'Доверяю']]
      .map(([v, t]) => h('option', { value: v, selected: pol.maxTrust === v }, t)));
    const sw = (on) => h('input', { type: 'checkbox', checked: !!on });
    const f = {
      requireFilter: sw(pol.requireFilter), requireIsolation: sw(pol.requireIsolation), allowPersistent: sw(pol.allowPersistent),
      memoryReview: sw(pol.memoryReview), allowEnvSecrets: sw(pol.allowEnvSecrets),
      maxTtl: h('input', { class: 'input', type: 'number', min: 0, max: 720, value: pol.maxTtlHours || '', placeholder: 'без ограничения' }),
      mergeBy: h('select', { class: 'input' }, [['operator', 'операторы и администраторы'], ['admin', 'только администраторы']].map(([v, t]) => h('option', { value: v, selected: pol.mergeBy === v }, t))),
    };
    const row = (title, note, ctl) => h('div', { class: 'pol-row' }, h('div', { class: 'pol-text' }, h('b', {}, title), h('div', { class: 'muted small' }, note)), ctl);
    const toggle = (cb) => h('label', { class: 'switch' }, cb, h('span', {}));
    const savePolicy = async () => {
      try {
        await api('PUT', '/ui/access/policy', { maxTrust: trust.value, requireFilter: f.requireFilter.checked, requireIsolation: f.requireIsolation.checked,
          allowPersistent: f.allowPersistent.checked, memoryReview: f.memoryReview.checked, allowEnvSecrets: f.allowEnvSecrets.checked,
          maxTtlHours: f.maxTtl.value || 0, mergeBy: f.mergeBy.value });
        toast('Политика сохранена — действует для новых задач', 'ok');
        redraw();
      } catch (e) { toast(e.message, 'err'); }
    };

    fill(box,
      h('div', { class: 'pol-card' },
        h('div', { class: 'acc-head' }, h('b', {}, 'Учётные записи'),
          h('span', { class: `ss-pill ${users.length ? 'ok' : 'warn'}` }, users.length ? 'вход включён' : 'вход не нужен — все администраторы')),
        ...rows,
        h('div', { class: 'acc-add' }, nName, nPass, nRole, add),
        h('ul', { class: 'muted small acc-roles' }, ...Object.entries(ROLE).map(([k, t]) => h('li', {}, h('b', {}, t), ` — ${ROLE_HINT[k]}`)))),
      h('div', { class: 'pol-card' },
        h('div', { class: 'acc-head' }, h('b', {}, 'Политика: обязательно для всех задач')),
        row('Потолок доверия', 'Задачи, проекты и агенты не могут получить уровень выше. «Осторожно» — неизвестные адреса запрещены, «Обычно» — с подтверждения, «Доверяю» — без ограничений.', trust),
        row('Только с фильтром «Сеть»', 'Агент с сетью «Без ограничений» не откроет задачу.', toggle(f.requireFilter)),
        row('Только с жёсткой изоляцией', 'Фильтр нельзя обойти: егресс-политика smolvm. Включает и предыдущее.', toggle(f.requireIsolation)),
        row('Постоянные сессии', 'Задачи без срока жизни. Выключите — все задачи закрываются сами.', toggle(f.allowPersistent)),
        row('Максимальный срок задачи, часов', 'Любая задача закрывается не позже; «+2 ч» его не превышает. С ним постоянные сессии невозможны.', f.maxTtl),
        row('Память агента всегда на проверку', 'Отметку «без ревью» у агента нельзя включить.', toggle(f.memoryReview)),
        row('Секреты в режиме «Переменная»', 'В этом режиме агент видит значение ключа. Выключите — задачи с такими секретами не откроются, только шлюз и подстановка.', toggle(f.allowEnvSecrets)),
        row('Кто вливает ветки задач', 'Принять и оставить веткой могут операторы; влить в основную ветку — по этой настройке.', f.mergeBy),
        h('div', { class: 'row' }, h('span', { class: 'muted small' }, 'Уже открытые задачи не меняются; нарушение видно при открытии новой.'), h('span', { class: 'spacer' }),
          h('button', { type: 'button', class: 'btn primary', onclick: savePolicy }, 'Сохранить политику'))));
  };

  function passwordDialog(name, done) {
    const p1 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'от 10 символов' });
    const ok = h('button', { class: 'btn primary', type: 'button' }, 'Сменить');
    const dlg = h('dialog', { class: 'dialog small' },
      h('header', {}, h('h3', {}, `Пароль для ${name}`), h('button', { type: 'button', class: 'btn ghost icon', 'aria-label': 'Закрыть', onclick: () => dlg.close() }, ic('x'))),
      h('div', { class: 'dialog-body' }, p1, h('p', { class: 'muted small' }, 'Открытые сессии этой учётной записи закончатся.'), ok));
    ok.addEventListener('click', async () => {
      try { await api('PUT', `/ui/access/users/${enc(name)}`, { password: p1.value }); toast('Пароль изменён', 'ok'); dlg.close(); if (name === window.auth.user?.name) location.reload(); else done(); }
      catch (e) { toast(e.message, 'err'); }
    });
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
  }
})();
