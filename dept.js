// Department pages (#directors/<dept>), redesigned 0.17.x (Bravo; owner's choices in chat, 18 Nov 2026).
// Layout A (tabs): a department banner (Directors violet into the department colour, with its numbers), then tabs
// Overview, Members, Courses, Meetings, History. Courses comes in a later stage and shows as "being built" for
// now. Meetings (stage 2, migration 0025) are scheduled here and posted by CareBeyond Helper (meetings cog). Every change (year/rank, add, remove) takes an optional reason, shown in History.
// Back end: dept_roster, dept_weekly_hours, member_search, dept_set_rank / dept_add / dept_remove (reason
// optional, migration 0023), role_changes. CareBeyond Helper carries changes out in Discord: Pending, then Done
// or Failed. The page polls only while something is Pending, and stops when you leave.

const DP_STATUS = { pending: 'Pending', done: 'Done', failed: 'Failed' };
const DP_ST_CLASS = { pending: 'sub-pending', done: 'sub-accepted', failed: 'sub-denied' };
const DP_INACTIVE_DAYS = 14;
const dpTab = {};          // last tab per department, for this visit
let dpWatch = null;

const dpDay = 864e5;
const dpLastActive = (p) => Math.max(p.last_shift_at ? new Date(p.last_shift_at).getTime() : 0, p.last_meeting_at ? new Date(p.last_meeting_at).getTime() : 0);
const dpInactive = (p) => !p.on_shift && Date.now() - dpLastActive(p) > DP_INACTIVE_DAYS * dpDay;
const dpHours = (h) => { const n = Number(h || 0); return n >= 10 ? n.toFixed(0) : n.toFixed(1).replace(/\.0$/, ''); };
const dpDayShort = (iso) => new Date(iso).toLocaleDateString([], { weekday: 'short', day: 'numeric' });
function dpRel(iso) {
  const ms = new Date(iso) - Date.now(), m = Math.round(ms / 6e4);
  if (m < 1) return 'Starting';
  if (m < 60) return `In ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `In ${h} hour${h === 1 ? '' : 's'}`;
  const d = Math.round(h / 24);
  return `In ${d} day${d === 1 ? '' : 's'}`;
}
const dpH = (h) => { const s = Math.round(Number(h || 0) * 3600); return s ? hrs(s) : '0m'; };

async function renderDept(body, tool) {
  const dept = tool.dept, exec = access.exec;
  const dep = DEPARTMENTS.find((d) => d.name === dept) || { name: dept, color: '#3a82d0', icon: 'clock' };
  const route = `#directors/${tool.id}`;
  $('page-title').hidden = true;
  body.style.setProperty('--dept-tab', dep.color);
  body.innerHTML = `<div class="dp-banner dp-loading" style="--dept:${dep.color};--icon:${iconUrl(dep.icon)}"><div class="dp-b-row"><span class="dp-sq"></span><div><h1 class="dp-name">${esc(dept)}</h1></div></div></div>
    <div class="card"><p class="muted small">Loading…</p></div>`;

  const [roster, ranksQ, changes, weekly, meetQ, lastMeet] = await Promise.all([
    sb.rpc('dept_roster', { department: dept }),
    sb.from('roles').select('id, name, rank_label, rank_order, badge_color').eq('kind', 'rank').eq('department', dept).order('rank_order', { ascending: false }),
    sb.from('role_changes').select('*').eq('department', dept).order('created_at', { ascending: false }).limit(100),
    sb.rpc('dept_weekly_hours', { department: dept }),
    sb.from('meetings').select('*').eq('department', dept).order('scheduled_for', { ascending: false }).limit(60),
    sb.rpc('dept_last_meeting', { department: dept }),
  ]);
  if (!body.isConnected || location.hash !== route) return;
  if (roster.error) { body.innerHTML = ''; return liveError(body, roster.error); }

  const ranks = (ranksQ.data || []).sort((a, b) => b.rank_order - a.rank_order);
  const rankById = Object.fromEntries(ranks.map((r) => [r.id, r]));
  const canGive = ranks.filter((r) => exec || r.rank_label !== 'Director');
  const word = ranks.some((r) => /^Year/.test(r.rank_label)) ? 'year' : 'rank';
  const Word = word === 'year' ? 'Year' : 'Rank';
  const people = (roster.data || []).sort((a, b) => (b.rank_order || 0) - (a.rank_order || 0) || cleanName(a.display_name).localeCompare(cleanName(b.display_name)));
  const byId = Object.fromEntries(people.map((p) => [p.discord_id, p]));
  (lastMeet.data || []).forEach((r) => { if (byId[r.discord_id]) byId[r.discord_id].last_meeting_at = r.last_meeting_at; });
  const meetings = meetQ.data || [];
  const upcoming = meetings.filter((m) => m.status === 'scheduled' || m.status === 'live').sort((a, b) => (a.status === 'live' ? -1 : 0) - (b.status === 'live' ? -1 : 0) || new Date(a.scheduled_for) - new Date(b.scheduled_for));
  const past = meetings.filter((m) => m.status === 'ended' || m.status === 'cancelled');
  const nextMeet = upcoming[0] || null;
  const nameOf = (id, fallback) => cleanName(byId[id]?.display_name || fallback || 'Someone');
  const hist = changes.data || [];
  const pending = Object.fromEntries(hist.filter((c) => c.status === 'pending').map((c) => [c.target_discord_id, c]));
  const weeks = Object.fromEntries((weekly.data || []).map((w) => [w.discord_id, (w.weeks || []).map(Number)]));
  const deptWeeks = [0, 1, 2, 3].map((i) => people.reduce((a, p) => a + ((weeks[p.discord_id] || [])[i] || 0), 0));
  // A Director can't change themselves or another Director (execs can); the database checks this too.
  const locked = (p) => !exec && (p.discord_id === myDiscordId || p.rank_label === 'Director');
  const onNow = people.filter((p) => p.on_shift);
  const inactive = people.filter(dpInactive);
  const weekTotal = people.reduce((a, p) => a + Number(p.week_hours || 0), 0);

  const rankBadge = (p) => {
    const r = rankById[p.rank_role_id];
    return `<span class="rbadge dp-rank-badge" style="--c:${r && r.badge_color ? hex(r.badge_color) : '#9aa9c4'}"><span class="rl">${esc(p.rank_label || 'No ' + word)}</span></span>`;
  };
  const spark = (id) => {
    const w = weeks[id] || [0, 0, 0, 0], max = Math.max(4, ...w);
    return `<span class="dp-spark" title="Hours, last 4 weeks: ${w.map(dpHours).join(', ')}" aria-label="Hours, last 4 weeks: ${w.map(dpHours).join(', ')}">${w.map((h, i) => `<i style="height:${Math.max(8, Math.round((h / max) * 100))}%"${i === 3 ? ' class="now"' : ''}></i>`).join('')}</span>`;
  };
  const lastSeen = (p) => (p.on_shift ? 'On shift now' : p.last_shift_at ? 'Last shift ' + when(p.last_shift_at) : 'No shifts yet');
  const changeText = (c) => {
    const n = esc(nameOf(c.target_discord_id, c.target_name));
    if (c.action === 'remove') return `${n} removed`;
    const label = esc(c.rank_label || rankById[c.rank_role_id]?.rank_label || '');
    return c.action === 'add' ? `${n} added as ${label}` : `${n} now ${label}`;
  };
  const changeRow = (c, full) => `<div class="dp-hrow">
      <div class="dp-hmain"><strong>${changeText(c)}</strong>
        ${c.reason ? `<span class="dp-reason">“${esc(c.reason)}”</span>` : ''}
        <span class="muted small-meta">${full && c.requested_by_name ? 'By ' + esc(cleanName(c.requested_by_name)) + ' · ' : ''}${esc(when(c.created_at))}${c.status === 'failed' && c.error ? ' · ' + esc(c.error) : ''}</span></div>
      <span class="st ${DP_ST_CLASS[c.status] || ''}">${esc(DP_STATUS[c.status] || c.status)}</span></div>`;

  // ---------- banner + tabs ----------
  const TABS = [
    { id: 'overview', label: 'Overview' },
    { id: 'members', label: 'Members', n: people.length },
    { id: 'courses', label: 'Courses', soon: true },
    { id: 'meetings', label: 'Meetings', n: upcoming.length || null },
    { id: 'history', label: 'History', n: hist.length || null },
  ];
  let tab = dpTab[dept] || 'overview';
  body.innerHTML = `
    <section class="dp-banner" style="--dept:${dep.color};--icon:${iconUrl(dep.icon)}">
      <span class="dp-big" aria-hidden="true"></span>
      <div class="dp-b-row"><span class="dp-sq" aria-hidden="true"></span>
        <div><h1 class="dp-name">${esc(dept)}</h1>
          <span class="dp-pill">${exec ? 'Executive view' : 'You direct this department'}</span></div></div>
      <div class="dp-stats">
        <div class="dp-stat"><b>${people.length}</b><span>Members</span></div>
        <div class="dp-stat"><b>${onNow.length}</b><span>On shift now</span></div>
        <div class="dp-stat"><b>${dpHours(weekTotal)}</b><span>Hours this week</span></div>
        <div class="dp-stat"><b>${nextMeet ? (nextMeet.status === 'live' ? 'Now' : esc(dpDayShort(nextMeet.scheduled_for))) : 'None'}</b><span>${nextMeet && nextMeet.status === 'live' ? 'Meeting on' : 'Next meeting'}</span></div>
      </div>
    </section>
    <div class="dp-tabs" role="tablist" aria-label="${esc(dept)}">${TABS.map((t) => `<button type="button" role="tab" id="dpt-${t.id}" data-tab="${t.id}" aria-selected="${t.id === tab}" tabindex="${t.id === tab ? 0 : -1}">${t.label}${t.n ? ` <span class="n">${t.n}</span>` : ''}${t.soon ? ' <span class="dp-soon">Soon</span>' : ''}</button>`).join('')}</div>
    <p class="error" id="dp-err" hidden></p>
    <div id="dp-pane" role="tabpanel"></div>`;
  const pane = body.querySelector('#dp-pane'), tabsEl = body.querySelector('.dp-tabs');
  const fail = (msg) => { const e = body.querySelector('#dp-err'); e.textContent = msg; e.hidden = !msg; };

  function show(id, focus) {
    tab = dpTab[dept] = id;
    tabsEl.querySelectorAll('[role=tab]').forEach((b) => { const on = b.dataset.tab === id; b.setAttribute('aria-selected', on); b.tabIndex = on ? 0 : -1; if (on && focus) b.focus(); });
    const cur = tabsEl.querySelector('[aria-selected="true"]');   // keep the chosen tab in view on narrow screens
    if (cur && (cur.offsetLeft < tabsEl.scrollLeft || cur.offsetLeft + cur.offsetWidth > tabsEl.scrollLeft + tabsEl.clientWidth)) tabsEl.scrollLeft = cur.offsetLeft - 12;
    pane.setAttribute('aria-labelledby', 'dpt-' + id);
    fail('');
    ({ overview: drawOverview, members: drawMembers, courses: drawCourses, meetings: drawMeetings, history: drawHistory })[id]();
    loadFaces(pane);
  }
  tabsEl.onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) show(b.dataset.tab); };
  tabsEl.onkeydown = (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const ids = TABS.map((t) => t.id), i = ids.indexOf(tab);
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? ids.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length;
    show(ids[j], true);
  };

  // ---------- Overview ----------
  function drawOverview() {
    const attention = [
      ...hist.filter((c) => c.status === 'failed').slice(0, 3).map((c) => ({ id: c.target_discord_id, name: nameOf(c.target_discord_id, c.target_name), why: 'Change failed: ' + (c.error || 'try again'), flag: ['bad', 'Failed'] })),
      ...inactive.slice(0, 6).map((p) => ({ id: p.discord_id, name: cleanName(p.display_name), why: dpLastActive(p) ? 'Not active since ' + new Date(dpLastActive(p)).toLocaleDateString([], { day: 'numeric', month: 'short' }) : 'No shifts or meetings yet', flag: ['warn', 'Inactive'], av: p.avatar_url })),
    ];
    const max = Math.max(1, ...deptWeeks);
    const weekLabel = (i) => {
      if (i === 3) return 'This week';
      const d = new Date(); const day = (d.getDay() + 6) % 7; d.setDate(d.getDate() - day - (3 - i) * 7);
      return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
    };
    pane.innerHTML = `<div class="dp-ov">
      <div class="dp-col">
        <section class="card dp-card"><div class="dp-head"><h2>Needs your attention</h2>${inactive.length > 6 ? `<button class="linkish" data-go="members" data-filter="inactive">All ${inactive.length} inactive</button>` : ''}</div>
          ${attention.length ? `<div class="dp-list">${attention.map((a) => `<div class="dp-mini">${face({ name: a.name, discordId: a.id, avatarUrl: a.av || byId[a.id]?.avatar_url || '', size: 'm' })}
              <div class="dp-m"><strong>${esc(a.name)}</strong><span>${esc(a.why)}</span></div><span class="dp-flag ${a.flag[0]}">${a.flag[1]}</span></div>`).join('')}</div>`
            : `<p class="muted small">Nothing needs you right now. Everyone has had a shift or come to a meeting in the last ${DP_INACTIVE_DAYS} days.</p>`}
        </section>
        <section class="card dp-card"><div class="dp-head"><h2>Recent changes</h2>${hist.length > 5 ? '<button class="linkish" data-go="history">See all</button>' : ''}</div>
          ${hist.length ? `<div class="dp-list">${hist.slice(0, 5).map((c) => changeRow(c, false)).join('')}</div>` : `<p class="muted small">No changes yet.</p>`}
        </section>
      </div>
      <div class="dp-col">
        <section class="card dp-card"><div class="dp-head"><h2>Next meeting</h2><button class="linkish" data-go="meetings">${nextMeet ? 'Meetings' : 'Schedule one'}</button></div>
          ${nextMeet ? meetLine(nextMeet) : `<p class="muted small">No meeting planned.</p>`}
        </section>
        <section class="card dp-card"><div class="dp-head"><h2>On shift now</h2></div>
          ${onNow.length ? `<div class="dp-list">${onNow.map((p) => `<div class="dp-mini">${face({ name: p.display_name, discordId: p.discord_id, avatarUrl: p.avatar_url, size: 'm' })}
              <div class="dp-m"><strong>${esc(cleanName(p.display_name))}</strong><span>${esc(dpH(p.week_hours))} this week</span></div>${rankBadge(p)}</div>`).join('')}</div>`
            : `<p class="muted small">Nobody from ${esc(dept)} is on shift.</p>`}
        </section>
        <section class="card dp-card"><div class="dp-head"><h2>Hours, last 4 weeks</h2></div>
          <div class="dp-chart" role="img" aria-label="Department hours: ${deptWeeks.map((h, i) => weekLabel(i) + ' ' + dpHours(h)).join(', ')}">
            ${deptWeeks.map((h, i) => `<div class="dp-bar${i === 3 ? ' now' : ''}"><span class="dp-bar-v">${dpHours(h)}</span><i style="height:${Math.max(3, Math.round((h / max) * 100))}%"></i><span class="dp-bar-l">${esc(weekLabel(i))}</span></div>`).join('')}
          </div>
        </section>
      </div></div>`;
    pane.querySelectorAll('[data-go]').forEach((b) => b.onclick = () => { if (b.dataset.filter) memState.filter = b.dataset.filter; if (b.dataset.go === 'meetings' && !nextMeet) meetState.open = 'new'; show(b.dataset.go); });
  }

  // ---------- Members ----------
  const memState = { q: '', filter: 'all', sort: 'rank' };
  const SORTS = { rank: 'Year', hours: 'Hours', recent: 'Last shift', name: 'Name' };
  if (word === 'rank') SORTS.rank = 'Rank';
  function drawMembers() {
    pane.innerHTML = `
      <div class="dp-mtools">
        <label class="ma-search dp-q"><span class="h-glass" aria-hidden="true"></span><input type="search" id="dp-q" placeholder="Find a member" autocomplete="off" aria-label="Find a member" value="${esc(memState.q)}"></label>
        <div class="chips dp-filters" role="group" aria-label="Show">
          ${[['all', 'All', people.length], ['on', 'On shift', onNow.length], ['inactive', 'Inactive', inactive.length]].map(([k, l, n]) => `<button type="button" class="chip${memState.filter === k ? ' on' : ''}" data-f="${k}" aria-pressed="${memState.filter === k}">${l} <span class="count">${n}</span></button>`).join('')}
        </div>
        <label class="dp-sort"><span>Sort</span><select id="dp-sort">${Object.entries(SORTS).map(([k, l]) => `<option value="${k}"${memState.sort === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        <button class="refresh dp-addbtn" id="dp-add-open" type="button">Add someone</button>
      </div>
      <div id="dp-add-box"></div>
      <div class="card dp-members" id="dp-list"></div>`;
    const q = pane.querySelector('#dp-q');
    q.oninput = () => { memState.q = q.value; drawRows(); };
    pane.querySelector('.dp-filters').onclick = (e) => {
      const b = e.target.closest('[data-f]'); if (!b) return;
      memState.filter = b.dataset.f;
      pane.querySelectorAll('.dp-filters .chip').forEach((x) => { const on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-pressed', on); });
      drawRows();
    };
    pane.querySelector('#dp-sort').onchange = (e) => { memState.sort = e.target.value; drawRows(); };
    pane.querySelector('#dp-add-open').onclick = openAdd;
    drawRows();
  }
  function drawRows() {
    const list = pane.querySelector('#dp-list');
    const term = memState.q.trim().toLowerCase();
    let rows = people.filter((p) => (!term || cleanName(p.display_name).toLowerCase().includes(term))
      && (memState.filter === 'all' || (memState.filter === 'on' ? p.on_shift : dpInactive(p))));
    const last = (p) => (p.on_shift ? Infinity : p.last_shift_at ? new Date(p.last_shift_at).getTime() : 0);
    if (memState.sort === 'hours') rows = rows.slice().sort((a, b) => Number(b.week_hours || 0) - Number(a.week_hours || 0));
    if (memState.sort === 'recent') rows = rows.slice().sort((a, b) => last(b) - last(a));
    if (memState.sort === 'name') rows = rows.slice().sort((a, b) => cleanName(a.display_name).localeCompare(cleanName(b.display_name)));
    if (!people.length) { list.innerHTML = `<p class="muted small">Nobody is in ${esc(dept)} yet. Use Add someone to bring people in.</p>`; return; }
    if (!rows.length) { list.innerHTML = `<p class="muted small">${term ? 'Nobody matches that name.' : memState.filter === 'on' ? 'Nobody is on shift.' : 'Nobody is inactive.'}</p>`; return; }
    list.innerHTML = rows.map((p) => {
      const pend = pending[p.discord_id], name = cleanName(p.display_name);
      return `<div class="dp-row" data-id="${esc(p.discord_id)}">
        <div class="dp-row-main">
          <span class="dp-face${p.on_shift ? ' on' : ''}">${face({ name: p.display_name, discordId: p.discord_id, avatarUrl: p.avatar_url, size: 'm' })}</span>
          <div class="dp-m"><strong>${esc(name)}</strong>
            <span>${esc(dpH(p.week_hours))} this week · ${Number(p.shifts_30d || 0)} shift${p.shifts_30d == 1 ? '' : 's'} in 30 days · ${esc(lastSeen(p))}${p.last_meeting_at ? ' · last meeting ' + esc(dpDayShort(p.last_meeting_at)) : ''}</span></div>
          ${spark(p.discord_id)}
          <span class="dp-tags">${pend ? `<span class="st sub-pending">Pending</span>` : dpInactive(p) ? '<span class="dp-flag warn">Inactive</span>' : ''}${rankBadge(p)}</span>
          <div class="ma-side dp-side">${locked(p) || pend ? '<span class="dp-dots-gap"></span>' : `<button type="button" class="ma-dots" aria-label="More for ${esc(name)}" aria-haspopup="menu" aria-expanded="false" data-menu="${esc(p.discord_id)}"><span></span></button>`}</div>
        </div>
        <div class="dp-inline" hidden></div></div>`;
    }).join('');
    loadFaces(list);
  }
  // row menu
  pane.addEventListener('click', (e) => {
    const dots = e.target.closest('.dp-row [data-menu]');
    if (dots) openMenu(dots, byId[dots.dataset.menu]);
  });
  function closeMenus() {
    pane.querySelectorAll('.ma-menu').forEach((x) => x.remove());
    pane.querySelectorAll('.ma-dots[aria-expanded="true"]').forEach((x) => x.setAttribute('aria-expanded', 'false'));
  }
  const outside = (e) => { if (!body.isConnected) return document.removeEventListener('click', outside); if (!e.target.closest('.ma-menu') && !e.target.closest('.ma-dots')) closeMenus(); };
  document.addEventListener('click', outside);
  function openMenu(btn, p) {
    const wasOpen = btn.getAttribute('aria-expanded') === 'true';
    closeMenus();
    if (wasOpen) return;
    const items = [['rank', `Change ${word}`], ['remove', `Remove from ${dept}`]];
    if (access.admin && typeof openRecord === 'function') items.push(['record', 'Open record']);
    const m = document.createElement('div');
    m.className = 'ma-menu'; m.setAttribute('role', 'menu');
    m.innerHTML = items.map(([k, l]) => `<button type="button" role="menuitem" data-do="${k}"${k === 'remove' ? ' class="warnish"' : ''}>${l}</button>`).join('');
    btn.setAttribute('aria-expanded', 'true');
    btn.closest('.ma-side').append(m);
    m.querySelector('button').focus();
    m.onclick = (e) => { const b = e.target.closest('[data-do]'); if (!b) return; closeMenus(); doRow(b.dataset.do, p, btn); };
    m.onkeydown = (e) => {
      const bs = [...m.querySelectorAll('button')], i = bs.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); bs[(i + 1) % bs.length].focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); bs[(i - 1 + bs.length) % bs.length].focus(); }
      if (e.key === 'Escape') { closeMenus(); btn.focus(); }
      if (e.key === 'Tab') closeMenus();
    };
  }
  const reasonField = (ph) => `<label class="f"><span>Reason <em class="dp-opt">optional</em></span><textarea rows="2" maxlength="500" placeholder="${esc(ph)}"></textarea></label>`;
  function doRow(k, p, btn) {
    const name = cleanName(p.display_name);
    if (k === 'record') { if (typeof rememberRecord === 'function') rememberRecord(p.discord_id, name); openRecord(p.discord_id); return; }
    const box = pane.querySelector(`.dp-row[data-id="${CSS.escape(p.discord_id)}"] .dp-inline`);
    pane.querySelectorAll('.dp-inline').forEach((x) => { if (x !== box) { x.hidden = true; x.innerHTML = ''; } });
    box.hidden = false;
    if (k === 'rank') {
      const current = p.rank_role_id;
      box.innerHTML = `<form class="dp-iform"><strong>Change ${esc(name)}’s ${word}</strong>
        <div class="dp-seg" role="radiogroup" aria-label="${Word}">${canGive.slice().reverse().map((r) => `<button type="button" role="radio" data-r="${esc(r.id)}" aria-checked="${r.id === current}" style="--c:${r.badge_color ? hex(r.badge_color) : '#9aa9c4'}"${r.id === current ? ' class="cur"' : ''}>${esc(r.rank_label)}${r.id === current ? ' <em>now</em>' : ''}</button>`).join('')}</div>
        ${reasonField(word === 'year' ? 'e.g. Finished Year 2 training and 20 hours' : 'e.g. Ran three events well')}
        <p class="error" hidden></p>
        <div class="f-actions"><button type="button" class="linkish" data-x>Cancel</button><button type="submit" class="refresh" disabled>Save</button></div></form>`;
      const f = box.querySelector('form'), save = f.querySelector('[type=submit]');
      let pick = null;
      f.querySelector('.dp-seg').onclick = (e) => {
        const b = e.target.closest('[data-r]'); if (!b) return;
        pick = b.dataset.r;
        f.querySelectorAll('[data-r]').forEach((x) => x.setAttribute('aria-checked', x === b));
        const r = rankById[pick];
        save.disabled = pick === current;
        save.textContent = pick === current ? 'Save' : `${(rankById[current]?.rank_order ?? -1) < r.rank_order ? 'Promote' : 'Move'} to ${r.rank_label}`;
      };
      wire(f, box, btn, (reason) => sb.rpc('dept_set_rank', { target: p.discord_id, department: dept, rank_role_id: pick, reason: reason || null }));
    }
    if (k === 'remove') {
      box.innerHTML = `<form class="dp-iform"><strong>Remove ${esc(name)} from ${esc(dept)}?</strong>
        <span class="muted small-meta">They lose the ${esc(dept)} role and their ${word}. CareBeyond Helper updates Discord.</span>
        ${reasonField('e.g. Left the hospital')}
        <p class="error" hidden></p>
        <div class="f-actions"><button type="button" class="linkish" data-x>Cancel</button><button type="submit" class="refresh danger-fill">Remove</button></div></form>`;
      wire(box.querySelector('form'), box, btn, (reason) => sb.rpc('dept_remove', { target: p.discord_id, department: dept, reason: reason || null }));
    }
    box.querySelector('[role=radio], textarea')?.focus();
  }
  function wire(f, box, btn, call) {
    f.querySelector('[data-x]').onclick = () => { box.hidden = true; box.innerHTML = ''; btn?.focus(); };
    f.onkeydown = (e) => { if (e.key === 'Escape') f.querySelector('[data-x]').click(); };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const er = f.querySelector('.error'), sbm = f.querySelector('[type=submit]');
      sbm.disabled = true; er.hidden = true;
      const { error } = await call(f.querySelector('textarea').value.trim());
      if (error) { er.textContent = error.message; er.hidden = false; sbm.disabled = false; return; }
      renderDept(body, tool);
    };
  }

  // Add someone: search server members, pick one, pick a starting year/rank, optional reason.
  function openAdd() {
    const box = pane.querySelector('#dp-add-box');
    if (box.innerHTML) { box.innerHTML = ''; return; }
    box.innerHTML = `<form class="card dp-add">
      <div class="dp-head"><h2>Add someone to ${esc(dept)}</h2></div>
      <label class="f"><span>Find a server member</span><input id="dp-aq" autocomplete="off" placeholder="Start typing a name"></label>
      <div id="dp-results" class="dp-results" role="listbox" aria-label="Server members"></div>
      <div class="f"><span>Starting ${word}</span><div class="dp-seg" role="radiogroup" aria-label="Starting ${word}">${canGive.slice().reverse().map((r, i) => `<button type="button" role="radio" data-r="${esc(r.id)}" aria-checked="${i === 0}" style="--c:${r.badge_color ? hex(r.badge_color) : '#9aa9c4'}">${esc(r.rank_label)}</button>`).join('')}</div></div>
      ${reasonField('e.g. Passed their interview')}
      <p class="error" hidden></p>
      <div class="f-actions"><button type="button" class="linkish" data-x>Cancel</button><button class="refresh" type="submit" disabled>Add to ${esc(dept)}</button></div></form>`;
    const f = box.querySelector('form'), q = f.querySelector('#dp-aq'), res = f.querySelector('#dp-results'), go = f.querySelector('[type=submit]');
    let picked = null, timer = null, rank = canGive[canGive.length - 1]?.id;
    q.focus();
    q.oninput = () => {
      clearTimeout(timer); picked = null; go.disabled = true;
      const term = q.value.trim();
      if (term.length < 2) { res.innerHTML = ''; return; }
      timer = setTimeout(async () => {
        const { data, error } = await sb.rpc('member_search', { q: term });
        if (q.value.trim() !== term) return;
        if (error) { res.innerHTML = `<p class="error">${esc(error.message)}</p>`; return; }
        const list = (data || []).filter((m) => !byId[m.discord_id]);
        res.innerHTML = list.length ? list.map((m) => `<button type="button" class="dp-pick" role="option" aria-selected="false" data-id="${esc(m.discord_id)}">
            ${face({ name: m.display_name, discordId: m.discord_id, avatarUrl: m.avatar_url, size: 's' })}<span>${esc(cleanName(m.display_name))}</span></button>`).join('')
          : `<p class="muted small">Nobody found who isn't already in ${esc(dept)}.</p>`;
        loadFaces(res);
      }, 250);
    };
    res.onclick = (e) => {
      const b = e.target.closest('.dp-pick'); if (!b) return;
      res.querySelectorAll('.dp-pick').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', x === b); });
      picked = b.dataset.id; go.disabled = !rank;
    };
    f.querySelector('.dp-seg').onclick = (e) => {
      const b = e.target.closest('[data-r]'); if (!b) return;
      rank = b.dataset.r;
      f.querySelectorAll('.dp-seg [data-r]').forEach((x) => x.setAttribute('aria-checked', x === b));
    };
    f.querySelector('[data-x]').onclick = () => { box.innerHTML = ''; pane.querySelector('#dp-add-open').focus(); };
    f.onsubmit = async (e) => {
      e.preventDefault();
      if (!picked) return;
      const er = f.querySelector('.error'); go.disabled = true; er.hidden = true;
      const { error } = await sb.rpc('dept_add', { target: picked, department: dept, rank_role_id: rank, reason: f.querySelector('textarea').value.trim() || null });
      if (error) { er.textContent = error.message; er.hidden = false; go.disabled = false; return; }
      dpTab[dept] = 'members';
      renderDept(body, tool);
    };
  }

  // ---------- Courses / Meetings (later stages) ----------
  function drawCourses() {
    pane.innerHTML = `<div class="is-building">${BUILDING_NOTE('Courses')}
      <div class="dp-cblocks">${['General Skills', 'Evaluation', 'Induction'].map((k) => `<div class="dp-cb"><span>${k}</span><b></b><i></i></div>`).join('')}</div></div>`;
  }
  // ---------- Meetings (stage 2, migration 0025) ----------
  // Upcoming and past meetings. The Director (or an exec) schedules, edits, starts, ends or cancels them, marks
  // attendance and keeps notes. CareBeyond Helper posts each one in the department's channel (meetings cog).
  const meetState = { open: null };   // 'new' | 'edit:<id>' | 'att:<id>' | 'notes:<id>' | 'cancel:<id>'
  function meetLine(m) {
    const d = new Date(m.scheduled_for);
    const st = m.status === 'live' ? '<span class="st dp-live">On now</span>' : m.status === 'cancelled' ? '<span class="st">Cancelled</span>'
      : m.status === 'ended' ? '' : `<span class="st sub-pending">${esc(dpRel(m.scheduled_for))}</span>`;
    return `<div class="dp-meet${m.status === 'cancelled' ? ' off' : ''}">
      <span class="dp-date" aria-hidden="true"><b>${esc(d.toLocaleDateString([], { month: 'short' }).toUpperCase())}</b><span>${d.getDate()}</span></span>
      <div class="dp-m"><strong>${esc(m.title)}</strong>
        <span>${esc(d.toLocaleDateString([], { weekday: 'short' }))} ${esc(d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))} · ${esc(m.location || 'Discord')} · ${m.duration_minutes || 60} min</span></div>${st}</div>`;
  }
  function drawMeetings() {
    pane.innerHTML = `
      <div class="dp-head dp-mhead"><h2>Upcoming</h2><button class="refresh" type="button" id="dp-new-meet">Schedule a meeting</button></div>
      <div id="dp-mt-form"></div>
      <div class="card dp-mlist">${upcoming.length ? upcoming.map((m) => meetRow(m)).join('') : `<p class="muted small">No meetings planned. Schedule one and CareBeyond Helper posts it in the ${esc(dept)} channel.</p>`}</div>
      ${past.length ? `<div class="dp-head dp-mhead"><h2>Past</h2></div><div class="card dp-mlist">${past.map((m) => meetRow(m)).join('')}</div>` : ''}`;
    pane.querySelector('#dp-new-meet').onclick = () => { meetState.open = meetState.open === 'new' ? null : 'new'; drawMeetForm(); };
    pane.querySelectorAll('[data-mact]').forEach((b) => b.onclick = () => meetAct(b.dataset.mact, meetings.find((x) => x.id === +b.dataset.mid)));
    if (meetState.open === 'new') drawMeetForm();
    else if (meetState.open) { const [k, id] = meetState.open.split(':'); const m = meetings.find((x) => x.id === +id); meetState.open = null; if (m) meetAct(k, m); }
  }
  function meetRow(m) {
    const acts = m.status === 'scheduled' ? [['start', 'Start now'], ['edit', 'Edit'], ['cancel', 'Cancel']]
      : m.status === 'live' ? [['end', 'End meeting'], ['att', 'Attendance'], ['notes', 'Notes']]
      : m.status === 'ended' ? [['att', 'Attendance'], ['notes', m.notes ? 'Notes' : 'Add notes']] : [];
    return `<div class="dp-mrow" data-mrow="${m.id}">
      <div class="dp-mrow-main">${meetLine(m)}
        <div class="dp-macts">${acts.map(([k, l]) => `<button type="button" class="${k === 'start' || k === 'end' ? 'refresh' : 'ghost'} small-btn${k === 'cancel' ? ' danger' : ''}" data-mact="${k}" data-mid="${m.id}">${l}</button>`).join('')}</div></div>
      ${m.agenda && m.status !== 'ended' ? `<p class="dp-agenda">${esc(m.agenda)}</p>` : ''}
      ${m.status === 'ended' && m.notes ? `<p class="dp-agenda dp-notes-peek">${esc(m.notes.length > 220 ? m.notes.slice(0, 220) + '…' : m.notes)}</p>` : ''}
      <div class="dp-inline dp-minline" hidden></div></div>`;
  }
  function drawMeetForm(m) {
    const box = pane.querySelector('#dp-mt-form');
    if (!m && meetState.open !== 'new') { box.innerHTML = ''; return; }
    const d = m ? new Date(m.scheduled_for) : null;
    const sydDate = (x) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(x);
    const sydTime = (x) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Australia/Sydney', hour: '2-digit', minute: '2-digit', hour12: false }).format(x);
    const target = m ? pane.querySelector(`[data-mrow="${m.id}"] .dp-minline`) : box;
    if (m) { target.hidden = false; }
    target.innerHTML = `<form class="${m ? 'dp-iform' : 'card dp-add'} dp-mform">
      ${m ? `<strong>Edit meeting</strong>` : `<div class="dp-head"><h2>Schedule a ${esc(dept)} meeting</h2></div>`}
      <label class="f"><span>Title</span><input name="title" maxlength="100" required placeholder="e.g. Monthly ${esc(dept)} meeting" value="${esc(m?.title || '')}"></label>
      <div class="dp-f3">
        <label class="f"><span>Date</span><input type="date" name="date" required value="${d ? sydDate(d) : sydneyToday()}"></label>
        <label class="f"><span>Time <em>Sydney</em></span><input type="time" name="time" required value="${d ? sydTime(d) : '19:00'}"></label>
        <label class="f"><span>Length</span><select name="len">${[30, 45, 60, 90, 120].map((n) => `<option value="${n}"${(m?.duration_minutes || 60) === n ? ' selected' : ''}>${n < 60 ? n + ' minutes' : n / 60 + (n === 60 ? ' hour' : ' hours')}</option>`).join('')}</select></label>
      </div>
      <label class="f"><span>Where <em>optional</em></span><input name="loc" maxlength="120" placeholder="e.g. ${esc(dept)} voice channel" value="${esc(m?.location || '')}"></label>
      <label class="f"><span>Agenda <em>optional</em></span><textarea name="agenda" rows="3" maxlength="1500" placeholder="What you'll cover">${esc(m?.agenda || '')}</textarea></label>
      <label class="dp-switch"><input type="checkbox" name="ping"${m && !m.ping ? '' : ' checked'}><span class="dp-sw" aria-hidden="true"></span><span>Ping ${esc(dept)} in Discord <em class="muted">(15 minutes before, and when it starts)</em></span></label>
      <p class="error" hidden></p>
      <div class="f-actions"><button type="button" class="linkish" data-x>Cancel</button><button type="submit" class="refresh">${m ? 'Save changes' : 'Schedule meeting'}</button></div></form>`;
    const f = target.querySelector('form');
    f.querySelector('[name=title]').focus();
    f.querySelector('[data-x]').onclick = () => { meetState.open = null; target.innerHTML = ''; if (m) target.hidden = true; };
    f.onkeydown = (e) => { if (e.key === 'Escape') f.querySelector('[data-x]').click(); };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const er = f.querySelector('.error'), b = f.querySelector('[type=submit]');
      const v = (n) => f.querySelector(`[name=${n}]`).value.trim();
      const when = sydneyToIso(v('date'), v('time'));
      if (!m && new Date(when) < Date.now() - 5 * 6e4) { er.textContent = 'Pick a time in the future.'; er.hidden = false; return; }
      b.disabled = true; er.hidden = true;
      const { error } = await sb.rpc('meeting_save', { mid: m ? m.id : null, department: dept, title: v('title'), scheduled_for: when,
        duration_minutes: +v('len'), location: v('loc') || null, agenda: v('agenda') || null, ping: f.querySelector('[name=ping]').checked });
      if (error) { er.textContent = error.message; er.hidden = false; b.disabled = false; return; }
      meetState.open = null; dpTab[dept] = 'meetings';
      renderDept(body, tool);
    };
  }
  async function meetAct(k, m) {
    const row = pane.querySelector(`[data-mrow="${m.id}"]`), box = row.querySelector('.dp-minline');
    pane.querySelectorAll('.dp-minline').forEach((x) => { if (x !== box) { x.hidden = true; x.innerHTML = ''; } });
    const status = async (to) => {
      const { error } = await sb.rpc('meeting_set_status', { mid: m.id, to_status: to });
      if (error) return fail(error.message);
      dpTab[dept] = 'meetings'; if (to === 'ended') meetState.open = 'att:' + m.id;
      renderDept(body, tool);
    };
    if (k === 'edit') return drawMeetForm(m);
    if (k === 'start') return status('live');
    if (k === 'end') return status('ended');
    if (k === 'cancel') {
      box.hidden = false;
      box.innerHTML = `<form class="dp-iform"><strong>Cancel “${esc(m.title)}”?</strong><span class="muted small-meta">CareBeyond Helper marks the Discord post as cancelled.</span>
        <div class="f-actions"><button type="button" class="linkish" data-x>Keep it</button><button type="submit" class="refresh danger-fill">Cancel meeting</button></div></form>`;
      const f = box.querySelector('form');
      f.querySelector('[data-x]').onclick = () => { box.hidden = true; box.innerHTML = ''; };
      f.onsubmit = (e) => { e.preventDefault(); status('cancelled'); };
      f.querySelector('[type=submit]').focus();
      return;
    }
    if (k === 'notes') {
      box.hidden = false;
      box.innerHTML = `<form class="dp-iform"><strong>Notes</strong>
        <label class="f"><span class="sr-only">Notes for ${esc(m.title)}</span><textarea rows="7" maxlength="10000" placeholder="What was discussed, decisions, actions">${esc(m.notes || '')}</textarea></label>
        ${m.notes_updated_at ? `<span class="muted small-meta">Last saved ${esc(when(m.notes_updated_at))}${m.notes_updated_by_name ? ' by ' + esc(cleanName(m.notes_updated_by_name)) : ''}</span>` : ''}
        <p class="error" hidden></p>
        <div class="f-actions"><button type="button" class="linkish" data-x>Close</button><button type="submit" class="refresh">Save notes</button></div></form>`;
      const f = box.querySelector('form');
      f.querySelector('textarea').focus();
      f.querySelector('[data-x]').onclick = () => { box.hidden = true; box.innerHTML = ''; };
      f.onsubmit = async (e) => {
        e.preventDefault();
        const er = f.querySelector('.error'), b = f.querySelector('[type=submit]'); b.disabled = true; er.hidden = true;
        const { error } = await sb.rpc('meeting_notes', { mid: m.id, notes: f.querySelector('textarea').value });
        if (error) { er.textContent = error.message; er.hidden = false; b.disabled = false; return; }
        dpTab[dept] = 'meetings'; renderDept(body, tool);
      };
      return;
    }
    if (k === 'att') {
      box.hidden = false;
      box.innerHTML = '<div class="dp-iform"><p class="muted small">Loading…</p></div>';
      const { data, error } = await sb.from('meeting_attendance').select('discord_id, status').eq('meeting_id', m.id);
      if (error) { box.innerHTML = `<p class="error">${esc(error.message)}</p>`; return; }
      const cur = Object.fromEntries((data || []).map((a) => [a.discord_id, a.status]));
      const pick = { ...cur };
      const OPTS = [['present', 'Present'], ['late', 'Late'], ['apologies', 'Apologies'], ['absent', 'Absent']];
      const tally = () => OPTS.map(([k2, l]) => `${l} ${Object.values(pick).filter((x) => x === k2).length}`).join(' · ');
      box.innerHTML = `<form class="dp-iform dp-att"><div class="dp-att-head"><strong>Attendance</strong><span class="muted small-meta" data-tally>${tally()}</span></div>
        <button type="button" class="linkish dp-allp" data-all>Mark everyone not marked as Present</button>
        <div class="dp-att-list">${people.map((p) => `<div class="dp-att-row">${face({ name: p.display_name, discordId: p.discord_id, avatarUrl: p.avatar_url, size: 's' })}
          <span class="dp-att-name">${esc(cleanName(p.display_name))}</span>
          <div class="dp-seg dp-att-seg" role="radiogroup" aria-label="${esc(cleanName(p.display_name))}">${OPTS.map(([k2, l]) => `<button type="button" role="radio" data-p="${esc(p.discord_id)}" data-s="${k2}" class="a-${k2}" aria-checked="${pick[p.discord_id] === k2}">${l}</button>`).join('')}</div></div>`).join('')}</div>
        <p class="error" hidden></p>
        <div class="f-actions"><button type="button" class="linkish" data-x>Close</button><button type="submit" class="refresh">Save attendance</button></div></form>`;
      loadFaces(box);
      const f = box.querySelector('form');
      const paint = () => { f.querySelectorAll('[data-p]').forEach((b) => b.setAttribute('aria-checked', pick[b.dataset.p] === b.dataset.s)); f.querySelector('[data-tally]').textContent = tally(); };
      f.onclick = (e) => {
        const b = e.target.closest('[data-p]');
        if (b) { pick[b.dataset.p] = pick[b.dataset.p] === b.dataset.s ? null : b.dataset.s; paint(); }
        if (e.target.closest('[data-all]')) { people.forEach((p) => { if (!pick[p.discord_id]) pick[p.discord_id] = 'present'; }); paint(); }
      };
      f.querySelector('[data-x]').onclick = () => { box.hidden = true; box.innerHTML = ''; };
      f.onsubmit = async (e) => {
        e.preventDefault();
        const marks = Object.keys({ ...cur, ...pick }).filter((id) => (pick[id] || null) !== (cur[id] || null)).map((id) => ({ discord_id: id, status: pick[id] || null }));
        const er = f.querySelector('.error'), b = f.querySelector('[type=submit]');
        if (!marks.length) { box.hidden = true; box.innerHTML = ''; return; }
        b.disabled = true; er.hidden = true;
        const { error: e2 } = await sb.rpc('meeting_mark', { mid: m.id, marks });
        if (e2) { er.textContent = e2.message; er.hidden = false; b.disabled = false; return; }
        dpTab[dept] = 'meetings'; renderDept(body, tool);
      };
    }
  }

  // ---------- History ----------
  const histState = { f: 'all' };
  function drawHistory() {
    const F = [['all', 'All'], ['set_rank', `${Word} changes`], ['add', 'Added'], ['remove', 'Removed']];
    const rows = hist.filter((c) => histState.f === 'all' || c.action === histState.f);
    pane.innerHTML = `<div class="chips dp-filters" role="group" aria-label="Show">${F.map(([k, l]) => `<button type="button" class="chip${histState.f === k ? ' on' : ''}" data-h="${k}" aria-pressed="${histState.f === k}">${l}</button>`).join('')}</div>
      <div class="card dp-hist">${rows.length ? rows.map((c) => changeRow(c, true)).join('') : `<p class="muted small">${hist.length ? 'Nothing of that kind yet.' : `No changes in ${esc(dept)} yet.`}</p>`}</div>
      ${hist.length >= 100 ? '<p class="muted small">Showing the latest 100 changes.</p>' : ''}`;
    pane.querySelector('.dp-filters').onclick = (e) => { const b = e.target.closest('[data-h]'); if (b) { histState.f = b.dataset.h; drawHistory(); } };
  }

  show(tab);

  // While anything is Pending, check every 3 s. When the bot has carried it out, wait a moment for the roles to sync
  // back, then show the result. Nothing else redraws, and it stops when you leave.
  clearInterval(dpWatch);
  const waiting = hist.filter((c) => c.status === 'pending').map((c) => c.id);
  if (waiting.length) {
    dpWatch = setInterval(async () => {
      if (!body.isConnected || location.hash !== route) return clearInterval(dpWatch);
      const { data } = await sb.from('role_changes').select('id, status').in('id', waiting);
      if ((data || []).some((c) => c.status !== 'pending')) {
        clearInterval(dpWatch);
        setTimeout(() => { if (body.isConnected && location.hash === route) renderDept(body, tool); }, 2500);
      }
    }, 3000);
  }
}

LIVE.dept = renderDept;
