// CareBeyond Desk (Bravo; phase 1 of the rebuild the owner approved on 18 Nov 2026, mockup
// https://claude.ai/artifact/5YmRkaVVj5uzdLrkCwbRYc). One sidebar replaces the header and the menu:
//   search · Home · My stuff (My shift, Sessions, My courses, Contact a team, Apply, ...) · your departments as
//   coloured folders that open into their pages · Hospital tools (for people with those powers) · Help ·
//   a live-session card (join code, Copy) · you (Clock in / Clock out, Log out).
// Phones: the sidebar is a drawer, with a top bar (menu, logo, search) and bottom tabs (Home, To do, Shift, Menu).
// It only builds navigation from what the person can use (canSee / hasPerm / myDirects from app.js); every page
// still renders exactly as before in <main>, and every hash route is unchanged. Nothing here grants access: the
// database decides what each page shows.
(() => {
  const OPEN_KEY = 'cbh-desk-open';
  let data = null, shift = null, endArmed = 0;
  window.deskTodo = {};   // my_todo() (migration 0045): per department, what's waiting on me
  const icon = (name) => `--icon:${iconUrl(name)}`;
  const chev = '<svg class="ds-chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg>';
  const readOpen = () => { try { return JSON.parse(localStorage.getItem(OPEN_KEY) || '{}'); } catch { return {}; } };
  const saveOpen = (o) => { try { localStorage.setItem(OPEN_KEY, JSON.stringify(o)); } catch { /* fine without it */ } };
  let open = readOpen();

  // ---------- skeleton (built once) ----------
  const side = document.createElement('aside');
  side.className = 'desk-side'; side.id = 'desk-side'; side.setAttribute('aria-label', 'Menu');
  const top = document.createElement('div');
  top.className = 'desk-top';
  top.innerHTML = `<button class="dt-btn" type="button" data-desk="drawer" aria-label="Open the menu" aria-controls="desk-side" aria-expanded="false"><span style="${icon('menu')}"></span></button>
    <a class="ds-brand" href="#"><img src="assets/cbh-icon.svg" alt="" width="28" height="28"><span class="ds-wm"><span class="wm-care">Care</span><span class="wm-beyond">Beyond</span></span></a>
    <button class="dt-btn dt-search" type="button" data-desk="search" aria-label="Search"><span style="${icon('search')}"></span></button>`;
  const tabs = document.createElement('nav');
  tabs.className = 'desk-tabs'; tabs.setAttribute('aria-label', 'Quick tabs');
  const scrim = document.createElement('div');
  scrim.className = 'desk-scrim'; scrim.dataset.desk = 'close';
  document.body.prepend(scrim, tabs, top, side);

  // ---------- what this person can use ----------
  const hash = () => location.hash || '#';
  function sessionsHref() { return canSee('sessions') ? (canSee('director') ? '#directors/sessions' : '#admin/sessions') : null; }
  function myStuff() {
    return [
      canSee('staff') && myDepartments.length && { href: '#shifts', label: 'My shift', icon: 'clock' },
      sessionsHref() && { href: sessionsHref(), label: 'Sessions', icon: 'calendar' },
      { label: 'My courses', icon: 'graduation-cap', soon: true },
      { href: '#contact', label: 'Contact a team', icon: 'chat' },
      canSee('leads') && { href: '#tickets', label: 'Team tickets', icon: 'inbox' },
      { href: '#apply', label: 'Apply', icon: 'resume' },
      canSee('staff') && { href: '#roster', label: 'Staff directory', icon: 'people' },
    ].filter(Boolean);
  }
  // What each department page has waiting (my_todo, migration 0046): red = needs action now (applications,
  // attendance, failed rank changes, inactivity of 60+ days); orange = a note (inactivity of 14-59 days).
  function pageCounts(d) {
    const t = window.deskTodo[d.name] || {}, n = (v) => Number(v || 0);
    return {
      members: n(t.inactive_alert) ? { n: n(t.inactive_alert), sev: 'red' } : n(t.inactive_note) ? { n: n(t.inactive_note), sev: 'orange' } : null,
      meetings: n(t.attendance) ? { n: n(t.attendance), sev: 'red' } : null,
      applications: n(t.apps) ? { n: n(t.apps), sev: 'red' } : null,
      history: n(t.failed) ? { n: n(t.failed), sev: 'red' } : null,
    };
  }
  // A collapsed folder's badge: its red count, or an orange count if there are only notes.
  function folderBadge(d) {
    const t = window.deskTodo[d.name] || {};
    const red = Number(t.red ?? (Number(t.apps || 0) + Number(t.attendance || 0) + Number(t.failed || 0))), orange = Number(t.orange || 0);
    return red ? { n: red, sev: 'red' } : orange ? { n: orange, sev: 'orange' } : null;
  }
  function deptPages(d) {
    const can = (p) => hasPerm(p, d.name), director = !!access.exec || myDirects.includes(d.name);
    const base = `#directors/${d.id}`, pc = pageCounts(d), cnt = (k) => pc[k] || {};
    const ext = (window.DEPT_TABS || []).filter((x) => { try { return x.show(d.name); } catch { return false; } });
    return [
      can('dept.view') && { href: base, label: 'Overview', icon: 'home', tab: 'overview' },
      can('dept.view') && { href: base + '/members', label: 'Members', icon: 'people', tab: 'members', ...cnt('members') },
      (can('dept.view') || can('courses.manage') || can('courses.assess')) && !ext.some((x) => x.id === 'courses') && { href: base + '/courses', label: 'Courses', icon: 'graduation-cap', tab: 'courses', tag: 'Soon' },
      (can('dept.view') || can('meetings.manage') || can('meetings.attendance')) && { href: base + '/meetings', label: 'Meetings', icon: 'calendar', tab: 'meetings', ...cnt('meetings') },
      ...ext.map((x) => ({ href: `${base}/${x.id}`, label: x.label, icon: x.id === 'applications' ? 'resume' : x.id === 'courses' ? 'graduation-cap' : 'clipboard', tab: x.id, ...cnt(x.id) })),
      can('history.view') && { href: base + '/history', label: 'History', icon: 'history', tab: 'history', ...cnt('history') },
      director && { href: base + '/ranks', label: 'Ranks & permissions', icon: 'star', tab: 'ranks' },
    ].filter(Boolean);
  }
  function rankIn(d) {
    if (myDirects.includes(d.name) && !access.exec) return 'Director';
    const r = (data?.roles || []).filter((x) => x.kind === 'rank' && x.department === d.name).sort((a, b) => b.rank_order - a.rank_order)[0];
    return r ? r.rank_label : access.exec ? 'Executive' : '';
  }
  function hospitalTools() {
    const out = [];
    for (const p of PAGES.filter((x) => (x.id === 'admin' || x.id === 'exec') && x.tools)) {
      for (const t of p.tools) {
        if (t.building || t.layout === 'sessions' || !canSee(toolAud(p, t))) continue;
        out.push({ href: `#${p.id}/${t.id}`, label: t.title, icon: t.icon });
      }
    }
    return out;
  }

  // ---------- drawing ----------
  const link = (it, c) => it.soon
    ? `<span class="ds-link soon" aria-disabled="true"><span class="ds-i" style="${icon(it.icon)}"></span><span class="ds-lab">${esc(it.label)}</span><span class="ds-tag">Soon</span></span>`
    : `<a class="ds-link" href="${it.href}"${isHere(it) ? ' aria-current="page"' : ''}><span class="ds-i" style="${icon(it.icon)}"></span><span class="ds-lab">${esc(it.label)}</span>${it.tag ? `<span class="ds-tag">${esc(it.tag)}</span>` : ''}${it.n ? `<span class="ds-n${it.sev === 'orange' ? ' orange' : ''}" title="${it.sev === 'orange' ? 'A note' : 'Needs you'}">${it.n}</span>` : ''}</a>`;
  function isHere(it) {
    const h = hash();
    if (it.tab) {   // department page: #directors/<id>[/<tab>[/<sub>]]
      const [a, b, c] = h.slice(1).split('/'), [, id] = it.href.slice(1).split('/');
      return a === 'directors' && b === id && (c || 'overview') === it.tab;
    }
    if (it.href === '#') return h === '#' || h === '';
    return h === it.href || h.startsWith(it.href + '/');
  }
  function folder(key, name, small, ic, color, items, badge) {
    const here = items.some(isHere), isOpen = open[key] ?? here;
    const b = !isOpen && badge;   // opened: the counts move onto the pages inside
    return `<button class="ds-dept${isOpen ? ' open' : ''}" type="button" data-fold="${key}" aria-expanded="${isOpen}" aria-label="${esc(name)}${badge ? `, ${badge.n} ${badge.sev === 'orange' ? 'notes' : 'waiting'}` : ''}" style="--c:${color};${icon(ic)}">
        <span class="ds-tile"></span><span class="ds-dname"><b>${esc(name)}</b>${small ? `<small>${esc(small)}</small>` : ''}</span>${b ? `<span class="ds-n${b.sev === 'orange' ? ' orange' : ''}">${b.n}</span>` : ''}${chev}</button>
      ${isOpen ? `<div class="ds-sub" style="--c:${color}">${items.map((it) => link(it, color)).join('')}</div>` : ''}`;
  }
  function drawSide() {
    const depts = DEPARTMENTS.filter((d) => canSee('dir:' + d.name) && deptPages(d).length);
    const hosp = hospitalTools();
    side.innerHTML = `
      <a class="ds-brand" href="#"><img src="assets/cbh-icon.svg" alt="" width="32" height="32"><span class="ds-wm"><span class="wm-care">Care</span><span class="wm-beyond">Beyond</span></span></a>
      <button class="ds-search" type="button" data-desk="search"><span class="ds-i" style="${icon('search')};width:16px;height:16px;background:currentColor;-webkit-mask:var(--icon) center/contain no-repeat;mask:var(--icon) center/contain no-repeat"></span>Search or do anything<kbd>/</kbd></button>
      <nav class="ds-nav" aria-label="Pages">
        ${link({ href: '#', label: 'Home', icon: 'home' })}
        <div class="ds-cat">My stuff</div>
        ${myStuff().map((it) => link(it)).join('')}
        ${depts.length ? `<div class="ds-cat">Departments</div>` : ''}
        ${depts.map((d) => folder(d.id, d.name, rankIn(d), d.icon, d.color, deptPages(d), folderBadge(d))).join('')}
        ${hosp.length ? `<div class="ds-cat">Hospital</div>${folder('hospital', 'Hospital tools', access.exec ? 'Executive' : 'Administration', 'shield', '#22579f', hosp)}` : ''}
        <div class="ds-cat">Help</div>
        ${link({ href: '#rules', label: 'Rules & info', icon: 'book' })}${link({ href: '#commands', label: 'Commands', icon: 'console' })}
      </nav>
      ${sessionCard()}
      ${meCard()}`;
  }
  function sessionCard() {
    const s = typeof currentSession !== 'undefined' ? currentSession : null, live = s && s.live, next = s && s.next;
    const code = (typeof joinCode !== 'undefined' && joinCode) || (s && s.code) || '';
    const head = live ? 'Session live' : next ? 'Next session' : 'Maple Hospital';
    const meta = live ? (live.host_name ? 'Hosted by ' + cleanName(live.host_name) : '') : next ? whenAhead(next.scheduled_for) : '';
    return `<div class="ds-session${live ? ' live' : ''}"><div class="ds-srow"><span class="ds-live">${head}</span>${meta ? `<span class="ds-smeta" style="margin-left:auto">${esc(meta)}</span>` : ''}</div>
      ${code ? `<div class="ds-srow"><span class="ds-smeta">Join code</span><span class="ds-code">${esc(code)}</span><button class="ds-mini" type="button" data-desk="copy">Copy</button></div>` : ''}</div>`;
  }
  function meCard() {
    const me = data?.me, name = me ? cleanName(me.display_name) : $('name').textContent;
    const role = (data && buildBadges(data.roles, data.departments)[0]?.label) || '';
    const photo = $('avatar') && !$('avatar').hidden ? $('avatar').src : '';
    const state = shift ? (shift.status === 'break' ? 'brk' : 'on') : '';
    const canShift = canSee('staff') && myDepartments.length;
    const sub = shift ? (shift.status === 'break' ? 'On break' : 'On shift · ' + shift.department) : role;
    const ini = (name.trim()[0] || '?').toUpperCase();
    return `<div class="ds-me"><div class="ds-merow"><span class="ds-av ${state}">${photo ? `<img src="${esc(photo)}" alt="">` : `<span class="ds-ini">${esc(ini)}</span>`}</span>
      <span class="ds-who"><b>${esc(name)}</b><span>${esc(sub)}</span></span>
      <button class="ds-out" type="button" data-desk="logout" aria-label="Log out" title="Log out"><span style="${icon('logout')}"></span></button></div>
      ${canShift ? `<button class="ds-clock${shift ? ' end' : ''}" type="button" data-desk="clock">${shift ? (Date.now() < endArmed ? 'Tap again to clock out' : 'Clock out') : 'Clock in' + (myDepartments.length === 1 ? ' to ' + esc(myDepartments[0]) : '')}</button>` : ''}</div>`;
  }
  function drawTabs() {
    const d = DEPARTMENTS.find((x) => myDirects.includes(x.name)) || DEPARTMENTS.find((x) => canSee('dir:' + x.name));
    const items = [
      { href: '#', label: 'Home', icon: 'home' },
      d ? { href: `#directors/${d.id}`, label: d.name.split(' ')[0], icon: d.icon, dept: d } : { href: '#apply', label: 'Apply', icon: 'resume' },
      canSee('staff') && myDepartments.length ? { href: '#shifts', label: 'Shift', icon: 'clock' } : { href: '#contact', label: 'Contact', icon: 'chat' },
    ];
    const cur = (it) => (it.dept ? hash().startsWith(it.href) : it.href === '#' ? hash() === '#' : hash() === it.href);
    tabs.innerHTML = items.map((it) => { const b = it.dept ? folderBadge(it.dept) : null;
      return `<a href="${it.href}"${cur(it) ? ' aria-current="page"' : ''}><span class="dt-i" style="${icon(it.icon)}"></span>${esc(it.label)}${b ? `<span class="ds-n${b.sev === 'orange' ? ' orange' : ''}">${b.n}</span>` : ''}</a>`; }).join('')
      + `<button type="button" data-desk="drawer"><span class="dt-i" style="${icon('menu')}"></span>Menu</button>`;
  }
  function drawAll() { if (!document.body.classList.contains('desk')) return; drawSide(); drawTabs(); }

  // ---------- my shift (for Clock in / Clock out) ----------
  async function loadShift() {
    if (!myDiscordId || !canSee('staff')) { shift = null; return; }
    const { data: rows } = await sb.from('shifts').select('id, status, department, started_at').eq('discord_id', myDiscordId)
      .neq('status', 'ended').order('started_at', { ascending: false }).limit(1);
    shift = (rows || [])[0] || null;
  }
  async function clock(btn) {
    if (!shift && myDepartments.length > 1) { location.hash = '#shifts'; return; }   // pick the department there
    if (shift && Date.now() > endArmed) { endArmed = Date.now() + 4000; drawSide(); setTimeout(drawSide, 4100); return; }
    btn.disabled = true;
    const { error } = shift ? await sb.rpc('shift_end') : await sb.rpc('shift_start', { department: myDepartments[0] });
    endArmed = 0;
    if (error) { btn.disabled = false; btn.textContent = 'Try again'; btn.title = error.message; return; }
    await loadShift(); drawSide();
    if (hash() === '#shifts' || hash() === '#') route();
  }

  // ---------- events ----------
  function setDrawer(on) {
    document.body.classList.toggle('desk-open', on);
    top.querySelector('[data-desk="drawer"]').setAttribute('aria-expanded', on);
    if (on) side.querySelector('a, button')?.focus();
  }
  document.addEventListener('click', async (e) => {
    const fold = e.target.closest('[data-fold]');
    if (fold && side.contains(fold)) { const k = fold.dataset.fold; open[k] = fold.getAttribute('aria-expanded') !== 'true'; saveOpen(open); drawSide(); side.querySelector(`[data-fold="${k}"]`)?.focus(); return; }
    const act = e.target.closest('[data-desk]');
    if (act) {
      const a = act.dataset.desk;
      if (a === 'drawer') return setDrawer(!document.body.classList.contains('desk-open'));
      if (a === 'close') return setDrawer(false);
      if (a === 'logout') return $('logout').click();
      if (a === 'clock') return clock(act);
      if (a === 'copy') { try { await navigator.clipboard.writeText(joinCode); act.textContent = 'Copied'; } catch { act.textContent = joinCode; } setTimeout(() => { act.textContent = 'Copy'; }, 1500); return; }
      if (a === 'search') { setDrawer(false); if (hash() !== '#') location.hash = ''; setTimeout(() => $('h-q')?.focus(), 60); return; }
    }
    if (e.target.closest('.ds-link, .desk-tabs a, .ds-brand')) setDrawer(false);
    if (e.target.closest('.dp-tabs [data-tab]')) setTimeout(drawAll, 0);   // dept.js changes the hash with replaceState
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('desk-open')) setDrawer(false);
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
  window.deskDraw = async (d) => {
    data = d;
    document.body.classList.add('desk');
    drawAll();
    await Promise.all([loadShift().catch(() => {}), loadTodo().catch(() => {})]);
    drawAll();
    if (!$('home').hidden && typeof drawNeeds === 'function' && $('h-need-sec')) drawNeeds();
  };
  window.deskRefresh = drawAll;   // after the session banner or access changes
  window.deskOff = () => { data = null; shift = null; document.body.classList.remove('desk', 'desk-open'); };
})();
