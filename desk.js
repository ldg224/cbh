// CareBeyond frame + window (0.32.0, Delta; replaces the Desk sidebar, which Bravo built for phase 1 of the rebuild).
// The owner approved this layout on 18 Nov 2026 (https://claude.ai/artifact/VZZbeBkH6uZZBPKmtfhPhN, version C):
//   FRAME (bright pale blue, never changes): a top bar (logo, search, the live session, Start shift, you) and a left menu
//     (Home, your own pages, your departments as plain links, Help).
//   WINDOW (white, raised): <main>. A department opens in it with ITS OWN menu down the left (#win-sub), built here
//     from the same pages dept.js shows as tabs; the tabs stay for phones.
// Phones: the frame shrinks to a top bar with a menu button; the left menu slides out as a drawer.
// Nothing here grants access: it only builds navigation from what the person can use (canSee / hasPerm / myDirects in
// app.js), and the database decides what each page shows. Every hash route is unchanged.
(() => {
  let data = null, shift = null, endArmed = 0;
  window.deskTodo = {};   // my_todo() (migration 0045): per department, what's waiting on me
  const icon = (name) => `--icon:${iconUrl(name)}`;

  // ---------- skeleton (built once) ----------
  const side = document.createElement('aside');
  side.className = 'desk-side'; side.id = 'desk-side'; side.setAttribute('aria-label', 'Menu');
  const top = document.createElement('header');
  top.className = 'desk-top';
  const scrim = document.createElement('div');
  scrim.className = 'desk-scrim'; scrim.dataset.desk = 'close';
  document.body.prepend(scrim, top, side);
  const sub = document.createElement('nav');   // the department's own menu, inside the window
  sub.className = 'win-sub'; sub.id = 'win-sub';

  // ---------- what this person can use ----------
  const hash = () => location.hash || '#';
  // The OUTER MENU (owner, 0.32.2): only what's yours wherever you are. Sessions, Courses and Tickets live in each
  // department's INNER MENU now; Commands is part of Rules & info; Help sits at the bottom.
  function myStuff() {
    return [
      canSee('staff') && myDepartments.length && { href: '#shifts', label: 'My shift', icon: 'clock' },
      { href: '#apply', label: 'Apply', icon: 'resume' },
    ].filter(Boolean);
  }
  const HELP = [{ href: '#rules', label: 'Rules & info', icon: 'book' }, { href: '#support', label: 'Support', icon: 'help' }, { href: '#contact', label: 'Contact a team', icon: 'chat' }];
  // What each department page has waiting (my_todo, migration 0046): red = needs action now, orange = a note.
  function pageCounts(d) {
    const t = window.deskTodo[d.name] || {}, n = (v) => Number(v || 0);
    return {
      members: n(t.inactive_alert) ? { n: n(t.inactive_alert), sev: 'red' } : n(t.inactive_note) ? { n: n(t.inactive_note), sev: 'orange' } : null,
      meetings: n(t.attendance) ? { n: n(t.attendance), sev: 'red' } : null,
      applications: n(t.apps) ? { n: n(t.apps), sev: 'red' } : null,
      history: n(t.failed) ? { n: n(t.failed), sev: 'red' } : null,
      courses: n(t.courses) ? { n: n(t.courses) + n(t.courses_note), sev: 'red' } : n(t.courses_note) ? { n: n(t.courses_note), sev: 'orange' } : null,
    };
  }
  // A department's badge in the frame menu: its red count, or an orange count if there are only notes.
  function deptBadge(d) {
    const t = window.deskTodo[d.name] || {};
    const red = Number(t.red ?? (Number(t.apps || 0) + Number(t.attendance || 0) + Number(t.failed || 0))), orange = Number(t.orange || 0);
    return red ? { n: red, sev: 'red' } : orange ? { n: orange, sev: 'orange' } : null;
  }
  // The department window's menu. `grp`: 'main' for everyone's pages, 'lead' for leaders' pages, 'tool' for the
  // Administration hospital tools (admin-tools.js). Same pages, same order and same permissions as dept.js's tabs.
  function deptPages(d) {
    const can = (p) => hasPerm(p, d.name), director = !!access.exec || myDirects.includes(d.name);
    const member = director || inMyDept(d.name);
    const base = `#directors/${d.id}`, pc = pageCounts(d), cnt = (k) => pc[k] || {};
    const ext = (window.DEPT_TABS || []).filter((x) => { try { return x.show(d.name); } catch { return false; } });
    const extItem = (x, grp) => ({ href: `${base}/${x.id}`, label: x.label, icon: x.icon || (x.id === 'applications' ? 'resume' : x.id === 'courses' ? 'graduation-cap' : 'clipboard'), tab: x.id, grp, ...cnt(x.id) });
    const one = (id, grp) => ext.filter((x) => x.id === id && !x.tool).map((x) => extItem(x, grp));
    return [
      (member || can('dept.view')) && { href: base, label: 'Overview', icon: 'home', tab: 'overview', grp: 'main' },
      ...one('roster', 'main'), ...one('events', 'main'),
      ...one('courses', 'main'),
      (can('dept.view') || can('courses.manage') || can('courses.assess')) && !ext.some((x) => x.id === 'courses') && { href: base + '/courses', label: 'Courses', icon: 'graduation-cap', tab: 'courses', grp: 'main', tag: 'Soon' },
      can('dept.view') && { href: base + '/members', label: 'Members', icon: 'people', tab: 'members', grp: 'lead', ...cnt('members') },
      (can('dept.view') || can('meetings.manage') || can('meetings.attendance')) && { href: base + '/meetings', label: 'Meetings', icon: 'calendar', tab: 'meetings', grp: 'lead', ...cnt('meetings') },
      ...ext.filter((x) => !x.tool && !['roster', 'events', 'courses'].includes(x.id)).map((x) => extItem(x, 'lead')),
      can('history.view') && { href: base + '/history', label: 'History', icon: 'history', tab: 'history', grp: 'lead', ...cnt('history') },
      director && { href: base + '/ranks', label: 'Ranks & permissions', icon: 'star', tab: 'ranks', grp: 'lead' },
      ...ext.filter((x) => x.tool).map((x) => ({ ...extItem(x, 'tool'), n: undefined })),
    ].filter(Boolean);
  }
  function rankIn(d) {
    if (access.exec) return 'Executive';
    if (myDirects.includes(d.name)) return 'Director';
    const r = (data?.roles || []).filter((x) => x.kind === 'rank' && x.department === d.name).sort((a, b) => b.rank_order - a.rank_order)[0];
    return r ? r.rank_label : '';
  }
  const myDepts = () => DEPARTMENTS.filter((d) => canSee('dir:' + d.name) && deptPages(d).length);
  // The department the window is showing (#directors/<id>[/<tab>]), or null.
  function deptHere() {
    const [a, b] = hash().slice(1).split('/');
    return a === 'directors' && b ? myDepts().find((d) => d.id === b) || null : null;
  }

  // ---------- drawing ----------
  const count = (it) => (it.n ? `<span class="ds-n${it.sev === 'orange' ? ' orange' : ''}" title="${it.sev === 'orange' ? 'A note' : 'Needs you'}">${it.n}</span>` : '');
  const link = (it) => `<a class="ds-link" href="${it.href}"${isHere(it) ? ' aria-current="page"' : ''}><span class="ds-i" style="${icon(it.icon)}"></span><span class="ds-lab">${esc(it.label)}</span>${it.tag ? `<span class="ds-tag">${esc(it.tag)}</span>` : ''}${count(it)}</a>`;
  function isHere(it) {
    const h = hash();
    if (it.tab) {   // department page: #directors/<id>[/<tab>[/<sub>]]
      const [a, b, c] = h.slice(1).split('/'), [, id] = it.href.slice(1).split('/');
      const [, , , dd] = h.slice(1).split('/');
      if (a !== 'directors' || b !== id || (c || 'overview') !== it.tab) return false;
      return it.view ? dd === it.view : !(it.tab === 'roster' && dd && dd !== 'all');   // a saved view, or the plain page
    }
    if (it.dept) return h.startsWith(it.href + '/') || h === it.href;
    if (it.href === '#') return h === '#' || h === '';
    return h === it.href || h.startsWith(it.href + '/');
  }
  function deptLink(d) {
    const b = deptBadge(d), here = isHere({ href: `#directors/${d.id}`, dept: true });
    return `<a class="ds-link ds-dept" href="#directors/${d.id}"${here ? ' aria-current="page"' : ''} style="--c:${d.color}"><span class="ds-dot" aria-hidden="true"></span><span class="ds-lab">${esc(d.name)}</span>${b ? count(b) : ''}</a>`;
  }
  const brand = `<a class="ds-brand" href="#"><img src="assets/cbh-icon.svg" alt="" width="30" height="30"><span class="ds-wm"><span class="wm-care">Care</span><span class="wm-beyond">Beyond</span></span></a>`;
  function drawSide() {
    const depts = myDepts();
    // Redrawing on every page change used to reset the menu to the top (user, 18 Nov 2026): keep its scroll position.
    const before = side.querySelector('.ds-nav'), keepTop = before ? before.scrollTop : 0;
    side.innerHTML = `
      <div class="ds-drawer-head">${brand}<button class="dt-btn" type="button" data-desk="close" aria-label="Close the menu"><span aria-hidden="true">×</span></button></div>
      <nav class="ds-nav" aria-label="Pages">
        ${link({ href: '#', label: 'Home', icon: 'home' })}
        ${window.chartNav ? window.chartNav(link) : ''}
        ${window.checkinNav ? window.checkinNav(link) : ''}
        ${myStuff().map((it) => link(it)).join('')}
        ${depts.length ? `<div class="ds-cat">${depts.length === 1 ? 'Your department' : 'Your departments'}</div>${depts.map(deptLink).join('')}` : ''}
        <div class="ds-grow"></div>
        <div class="ds-cat">Help</div>
        ${HELP.map((it) => link(it)).join('')}
      </nav>
      <div class="ds-phone-only">${sessionCard()}</div>`;
    const nav = side.querySelector('.ds-nav');
    nav.scrollTop = keepTop;
    const cur = nav.querySelector('[aria-current="page"]');
    if (cur) { const n = nav.getBoundingClientRect(), c = cur.getBoundingClientRect(); if (c.top < n.top || c.bottom > n.bottom) cur.scrollIntoView({ block: 'nearest' }); }
  }
  // The top bar: menu button (phones), logo, search, the live session (computers), Start shift / Clock out, you.
  function drawTop() {
    const s = typeof currentSession !== 'undefined' ? currentSession : null, live = s && s.live;
    const code = (typeof joinCode !== 'undefined' && joinCode) || (s && s.code) || '';
    const waiting = myDepts().reduce((a, d) => a + ((deptBadge(d) || {}).sev === 'red' ? deptBadge(d).n : 0), 0);
    const canShift = canSee('staff') && myDepartments.length;
    const me = data?.me, name = me ? cleanName(me.display_name) : $('name').textContent;
    const photo = $('avatar') && !$('avatar').hidden ? $('avatar').src : '';
    const state = shift ? (shift.status === 'break' ? 'brk' : 'on') : '';
    const ini = (name.trim()[0] || '?').toUpperCase();
    const role = (data && buildBadges(data.roles, data.departments)[0]?.label) || '';
    const youSub = shift ? (shift.status === 'break' ? 'On break' : 'On shift · ' + shift.department) : role;
    const wasOpen = !!top.querySelector('.dt-menu:not([hidden])');
    top.innerHTML = `
      <button class="dt-btn dt-drawer" type="button" data-desk="drawer" aria-label="Open the menu" aria-controls="desk-side" aria-expanded="${document.body.classList.contains('desk-open')}"><span style="${icon('menu')}"></span>${waiting ? `<span class="ds-n dt-dot">${waiting}</span>` : ''}</button>
      ${brand}
      <button class="dt-search" type="button" data-desk="search" aria-label="Search"><span class="dt-si" style="${icon('search')}" aria-hidden="true"></span><span class="dt-st">Search or do anything</span><kbd>/</kbd></button>
      ${live || (s && s.next) ? `<div class="dt-live${live ? ' on' : ''}"><span class="dt-ld" aria-hidden="true"></span><span class="dt-lt">${live ? 'Session live' : esc('Next session ' + whenAhead(s.next.scheduled_for))}${code ? ` · <b>${esc(code)}</b>` : ''}</span>${live && code && typeof joinGameBtn === 'function' ? joinGameBtn(code, 'dt-join') : ''}</div>` : ''}
      ${canShift ? `<button class="dt-clock${shift ? ' end' : ''}" type="button" data-desk="clock"><span class="dt-cd" aria-hidden="true"></span>${shift ? (Date.now() < endArmed ? 'Tap again to end' : 'End shift') : 'Start shift'}</button>` : ''}
      <button class="dt-you" type="button" data-desk="you" aria-label="You: ${esc(name)}" aria-expanded="${wasOpen}" aria-haspopup="true"><span class="ds-av ${state}">${photo ? `<img src="${esc(photo)}" alt="">` : `<span class="ds-ini">${esc(ini)}</span>`}</span></button>
      <div class="dt-menu" role="menu"${wasOpen ? '' : ' hidden'}>
        <div class="dt-who"><b>${esc(name)}</b><span>${esc(youSub)}</span></div>
        ${shift ? `<button class="dt-mi plain" type="button" role="menuitem" data-desk="break"><span style="${icon('clock')}" aria-hidden="true"></span>${shift.status === 'break' ? 'End break' : 'Take a break'}</button>` : ''}
        ${shift && window.chartLogBtn ? window.chartLogBtn('ds') : ''}
        <label class="ds-switch"><input type="checkbox" data-desk="quiet"${quietNotes ? ' checked' : ''}><span class="ds-sw" aria-hidden="true"></span>
          <span>Show quiet-member notes<small>Pings when people in your departments haven’t been active</small></span></label>
        <button class="dt-mi" type="button" role="menuitem" data-desk="logout"><span style="${icon('logout')}" aria-hidden="true"></span>Log out</button>
      </div>`;
  }
  function sessionCard() {
    const s = typeof currentSession !== 'undefined' ? currentSession : null, live = s && s.live, next = s && s.next;
    const code = (typeof joinCode !== 'undefined' && joinCode) || (s && s.code) || '';
    const head = live ? 'Session live' : next ? 'Next session' : 'Maple Hospital';
    const meta = live ? (live.host_name ? 'Hosted by ' + cleanName(live.host_name) : '') : next ? whenAhead(next.scheduled_for) : '';
    return `<div class="ds-session${live ? ' live' : ''}"><div class="ds-srow"><span class="ds-live">${head}</span>${meta ? `<span class="ds-smeta" style="margin-left:auto">${esc(meta)}</span>` : ''}</div>
      ${code ? `<div class="ds-srow"><span class="ds-smeta">Join code</span><span class="ds-code">${esc(code)}</span><button class="ds-mini" type="button" data-desk="copy">Copy</button></div>
        ${typeof joinGameBtn === 'function' ? joinGameBtn(code, 'ds-join') : ''}` : ''}</div>`;
  }
  // The department's own menu inside the window (computers; phones keep dept.js's tabs).
  // It lives at the start of the window for good (0.32.1): leaving a department just drops body.in-dept, so the menu
  // slides out (desk.css) still showing the department you left, instead of vanishing.
  function drawSub() {
    const d = deptHere(), page = $('page'), main = document.querySelector('main');
    if (sub.parentNode !== main) main.prepend(sub);
    document.body.classList.toggle('in-dept', !!d && !page.hidden);
    sub.inert = !d || page.hidden;   // out of view: not focusable
    if (!d || page.hidden) return;
    const pages = deptPages(d), rank = rankIn(d);
    const views = pages.some((p) => p.tab === 'roster') && window.dvViews ? window.dvViews(d) : [];   // deptviews.js
    const group = (g) => pages.filter((p) => p.grp === g).map(link).join('');
    sub.style.setProperty('--c', d.color);
    sub.setAttribute('aria-label', d.name);
    sub.innerHTML = `<div class="ws-in">
      <a class="ws-head" href="#directors/${d.id}"><span class="ws-tile" style="${icon(d.icon)}" aria-hidden="true"></span><span class="ws-name"><b>${esc(d.name)}</b>${rank ? `<small>${esc(rank === 'Director' ? 'You’re the Director' : rank === 'Executive' ? 'Executive view' : rank)}</small>` : ''}</span></a>
      ${group('main')}
      ${views.length ? `<div class="ds-cat">Views</div>${views.map(link).join('')}` : ''}
      ${pages.some((p) => p.grp === 'lead') ? `<div class="ds-cat">Leaders</div>${group('lead')}` : ''}
      ${pages.some((p) => p.grp === 'tool') ? `<div class="ds-cat">Hospital tools</div>${group('tool')}` : ''}</div>`;
  }
  function drawAll() { if (!document.body.classList.contains('desk')) return; drawTop(); drawSide(); drawSub(); }

  // ---------- my shift (for Start shift / End shift) ----------
  async function loadShift() {
    if (!myDiscordId || !canSee('staff')) { shift = null; return; }
    const { data: rows } = await sb.from('shifts').select('id, status, department, started_at').eq('discord_id', myDiscordId)
      .neq('status', 'ended').order('started_at', { ascending: false }).limit(1);
    shift = (rows || [])[0] || null;
  }
  async function clock(btn) {
    if (!shift && myDepartments.length > 1) { location.hash = '#shifts'; return; }   // pick the department there
    if (shift && Date.now() > endArmed) { endArmed = Date.now() + 4000; drawTop(); setTimeout(drawTop, 4100); return; }
    btn.disabled = true;
    const { error } = shift ? await sb.rpc('shift_end') : await sb.rpc('shift_start', { department: myDepartments[0] });
    endArmed = 0;
    if (error) { btn.disabled = false; btn.textContent = 'Try again'; btn.title = error.message; return; }
    await loadShift(); drawAll();
    if (hash() === '#shifts' || hash() === '#') route();
  }

  // ---------- events ----------
  function setDrawer(on) {
    document.body.classList.toggle('desk-open', on);
    top.querySelector('[data-desk="drawer"]')?.setAttribute('aria-expanded', on);
    if (on) side.querySelector('a, button')?.focus();
  }
  function setYou(on) {
    const m = top.querySelector('.dt-menu'), b = top.querySelector('.dt-you');
    if (!m) return;
    m.hidden = !on; b.setAttribute('aria-expanded', on);
  }
  document.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-desk]');
    if (!e.target.closest('.dt-menu, .dt-you')) setYou(false);
    if (act) {
      const a = act.dataset.desk;
      if (a === 'drawer') return setDrawer(!document.body.classList.contains('desk-open'));
      if (a === 'close') return setDrawer(false);
      if (a === 'you') return setYou(act.getAttribute('aria-expanded') !== 'true');
      if (a === 'logout') return $('logout').click();
      if (a === 'quiet') { act.disabled = true; await window.deskSetQuietNotes(act.checked); setYou(true); return; }
      if (a === 'clock') return clock(act);
      if (a === 'break') {
        act.disabled = true;
        const { error } = await sb.rpc('shift_break');
        if (error) { act.disabled = false; act.title = error.message; act.lastChild.textContent = 'Try again'; return; }
        await loadShift(); drawAll(); if (hash() === '#shifts' || hash() === '#') route(); return;
      }
      if (a === 'copy') { try { await navigator.clipboard.writeText(joinCode); act.textContent = 'Copied'; } catch { act.textContent = joinCode; } setTimeout(() => { act.textContent = 'Copy'; }, 1500); return; }
      if (a === 'search') { setDrawer(false); if (hash() !== '#') location.hash = ''; setTimeout(() => $('h-q')?.focus(), 60); return; }
    }
    if (e.target.closest('.ds-link, .ds-brand')) setDrawer(false);
    if (e.target.closest('.dp-tabs [data-tab]')) setTimeout(drawAll, 0);   // dept.js changes the hash with replaceState
    // The window menu: dept.js re-renders on the hash change; keep the page from jumping to its old tab.
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if (document.body.classList.contains('desk-open')) setDrawer(false); if (top.querySelector('.dt-menu:not([hidden])')) { setYou(false); top.querySelector('.dt-you')?.focus(); } }
    if (e.key === '/' && document.body.classList.contains('desk') && !/input|textarea|select/i.test(document.activeElement?.tagName || '') && !document.activeElement?.isContentEditable) {
      e.preventDefault(); if (hash() !== '#') location.hash = ''; setTimeout(() => $('h-q')?.focus(), 60);
    }
  });
  window.addEventListener('hashchange', () => setTimeout(drawAll, 0));

  // ---------- hooks for app.js ----------
  async function loadTodo() {
    const { data: t } = await sb.rpc('my_todo');
    window.deskTodo = t || {};
  }
  let quietNotes = true;   // user_prefs.quiet_notes (0049): show quiet-member notes
  async function loadPrefs() { const { data: p } = await sb.rpc('get_my_prefs'); quietNotes = !(p && p.quiet_notes === false); }
  async function refreshTodo() {
    await loadTodo().catch(() => {});
    drawAll();
    if (!$('home').hidden && typeof drawNeeds === 'function' && $('h-need-sec')) drawNeeds();
  }
  // Clear a To do item (todo_dismiss checks who may). Returns an error message, or '' when saved.
  window.deskDismiss = async (dept, kind, target, until = null, reason = null) => {
    const { error } = await sb.rpc('todo_dismiss', { department: dept, kind, target: String(target), until, reason });
    if (error) return error.message;
    await refreshTodo();
    if (location.hash.startsWith('#directors/') && typeof route === 'function') route();
    return '';
  };
  window.deskUndismiss = async (dept, kind, target) => {
    const { error } = await sb.rpc('todo_undismiss', { department: dept, kind, target: String(target) });
    if (error) return error.message;
    await refreshTodo(); return '';
  };
  window.deskSetQuietNotes = async (show) => {
    const { error } = await sb.rpc('set_my_quiet_notes', { show });
    if (error) return error.message;
    quietNotes = show; await refreshTodo(); return '';
  };
  window.deskDraw = async (d) => {
    data = d;
    document.body.classList.add('desk');
    drawAll();
    await Promise.all([loadShift().catch(() => {}), loadTodo().catch(() => {}), loadPrefs().catch(() => {})]);
    drawAll();
    if (!$('home').hidden && typeof drawNeeds === 'function' && $('h-need-sec')) drawNeeds();
  };
  window.deskRefresh = drawAll;   // after the session banner or access changes
  window.deskSub = drawSub;       // app.js route(): the window's department menu follows the page
  window.deskShift = () => shift;   // the current shift (or null), for chart.js
  window.deskOff = () => { data = null; shift = null; sub.remove(); document.body.classList.remove('desk', 'desk-open', 'in-dept'); };
})();
