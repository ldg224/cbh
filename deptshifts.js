// Department Shifts page (0.33.0, Bravo): #directors/<dept>/shifts[/week|/leaderboard], in the window's main menu after
// Roster (dept.js + desk.js place it, Delta). One page with three toggles, no sub-pages:
//   On Now       who in this department is on shift or on break, and for how long.
//   This Week    your minutes against the weekly target and your shift log; leaders also see everyone's.
//   Leaderboard  everyone in the department, ranked by minutes or Top Performing, this week or the last 30 days
//                (public to the department, owner 19 Nov 2026), with your own place on top. Replaces the old side
//                views "Most Minutes" / "Top Performing".
// Back end: dept_shifts(p_department, p_part, p_period, p_metric), migration 0081. The database decides what each
// person gets (members get only their own shift log). The page never redraws by itself: it checks quietly every 30 s
// while it's open and shows "Things have changed. Refresh".
// Uses deptviews.js helpers (dvLeader, dvMins, dvBadge, dvLoadRanks, dvDeptOf, dvTime).

const DS_PARTS = [['now', 'On Now'], ['week', 'This Week'], ['leaderboard', 'Leaderboard']];
const dsState = {};   // department -> { metric, period } for this visit
let dsTimer = null;   // the one change check; a new visit to Shifts replaces it
const dsOrdinal = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
const dsDur = (a, b) => dvMins((new Date(b || Date.now()) - new Date(a)) / 60000);
const dsDay = (iso) => new Date(iso).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
// What's on screen, minus numbers that tick up on their own while someone is on shift (those don't count as a change).
const DS_TICKING = new Set(['minutes', 'break_minutes', 'score', 'place', 'ranked']);
const dsSig = (data) => JSON.stringify(data, (k, v) => (DS_TICKING.has(k) ? undefined : v));

window.DEPT_TABS = window.DEPT_TABS || [];
window.DEPT_TABS.push({
  id: 'shifts', label: 'Shifts', icon: 'clock',
  show: (dept) => inMyDept(dept) || dvLeader(dept),
  async render(pane, dept, sub) {
    const d = dvDeptOf(dept);
    const st = dsState[dept] || (dsState[dept] = { metric: 'minutes', period: 'week' });
    // sub: '' | 'week' | 'leaderboard' | 'leaderboard/top' (the old Roster "Top Performing" link lands here).
    const [subPart, subMetric] = String(sub || '').split('/');
    let part = DS_PARTS.some(([k]) => k === subPart) ? subPart : 'now';
    if (part === 'leaderboard' && ['minutes', 'top'].includes(subMetric)) st.metric = subMetric;
    let shownSig = null;
    clearInterval(dsTimer);
    dvLoadRanks(dept);   // rank badge colours

    pane.innerHTML = `<div class="ds">
        <div class="ds-head"><h2>Shifts</h2>
          <div class="ma-seg ds-seg" role="group" aria-label="Show">${DS_PARTS.map(([k, l]) => `<button type="button" data-part="${k}" aria-pressed="${k === part}">${l}</button>`).join('')}</div></div>
        <div class="cx-qbar-ch ds-ch" hidden role="status"><span>Things have changed.</span><button type="button" class="refresh small-btn">Refresh</button></div>
        <div class="ds-body"><p class="muted small">Loading…</p></div></div>`;
    const body = pane.querySelector('.ds-body'), ch = pane.querySelector('.ds-ch');
    pane.querySelectorAll('[data-part]').forEach((b) => b.onclick = () => {
      part = b.dataset.part;
      pane.querySelectorAll('[data-part]').forEach((x) => x.setAttribute('aria-pressed', x === b));
      setUrl();
      load();
    });
    function setUrl() {
      const tail = part === 'now' ? '' : part === 'leaderboard' && st.metric === 'top' ? '/leaderboard/top' : '/' + part;
      try { history.replaceState(null, '', `#directors/${d.id}/shifts${tail}`); } catch { /* fine without it */ }
    }
    ch.querySelector('button').onclick = () => load();

    const fetchPart = () => sb.rpc('dept_shifts', { p_department: dept, p_part: part, p_period: st.period, p_metric: st.metric });
    async function load() {
      ch.hidden = true;
      body.setAttribute('aria-busy', 'true');
      const { data, error } = await fetchPart();
      body.removeAttribute('aria-busy');
      if (!body.isConnected) return;
      if (error) { body.innerHTML = `<p class="error">${esc(error.message)}</p>`; return; }
      shownSig = part + dsSig(data);
      body.innerHTML = part === 'now' ? drawNow(data) : part === 'week' ? drawWeek(data) : drawBoard(data);
      wire();
      loadFaces(body);
    }
    // Quiet change check: never redraws, only offers Refresh.
    const timer = dsTimer = setInterval(async () => {
      if (!body.isConnected) { clearInterval(timer); return; }
      if (document.hidden || shownSig === null || !ch.hidden) return;
      const want = part;
      const { data, error } = await fetchPart();
      if (!error && want === part && body.isConnected && part + dsSig(data) !== shownSig) ch.hidden = false;
    }, 30000);

    const person = (r, extra = '') => `${face({ name: r.name, discordId: r.discord_id, avatarUrl: r.avatar_url || '', size: 'm' })}
        <span class="ds-who"><strong>${esc(cleanName(r.name || ''))}</strong>${r.me ? '<span class="ds-you">You</span>' : ''}${dvBadge(dept, r.rank)}${extra}</span>`;

    // ---------- On Now ----------
    function drawNow(data) {
      const rows = data.rows || [], on = rows.filter((r) => r.status === 'active').length, br = rows.length - on;
      if (!rows.length) return `<div class="card ds-empty"><p class="muted small">Nobody in ${esc(dept)} is on shift right now.</p></div>`;
      return `<div class="ds-sum"><span class="ds-pill on">${on} On Shift</span>${br ? `<span class="ds-pill brk">${br} On Break</span>` : ''}</div>
        <div class="card ds-list">${rows.map((r) => `<div class="ds-row${r.me ? ' me' : ''}">${person(r)}
          <span class="ds-meta"><span class="ds-pill ${r.status === 'break' ? 'brk' : 'on'}">${r.status === 'break' ? 'On Break' : 'On Shift'}</span>
            <small>${r.status === 'break' && r.break_since ? `Break since ${esc(dvTime(r.break_since))}` : `Since ${esc(dvTime(r.since))}`} · ${esc(dvMins(r.minutes))} worked</small></span></div>`).join('')}</div>`;
    }

    // ---------- This Week ----------
    const bar = (mins, tgt) => {
      const pc = tgt ? Math.min(100, Math.round(100 * mins / tgt)) : 0;
      return `<div class="dv-bar ds-bar${mins >= tgt ? ' met' : ''}" role="progressbar" aria-label="Weekly target" aria-valuenow="${pc}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pc}%"></i></div>`;
    };
    function drawWeek(data) {
      // Exec view switched off (0.35.0, app.js execViewOff): show the page as the person's own roles. A page filter only;
      // the database still answers as an exec. dvLeader follows the switch.
      const asSelf = !!window.execViewOff?.() && !dvLeader(dept);
      const me = data.me || {}, log = (data.log || []).filter((s) => !asSelf || s.me), people = asSelf ? null : data.people;
      const meCard = inMyDept(dept) || me.shifts ? `<section class="card dv-card ds-mine"><div class="dp-head"><h2>My Week</h2>${me.target && me.minutes >= me.target ? '<span class="dv-streak">Target met</span>' : ''}</div>
          <div class="dv-big">${esc(dvMins(me.minutes))} <span>${me.target ? 'of ' + esc(dvMins(me.target)) : 'on shift'} · ${Number(me.shifts || 0)} ${me.shifts == 1 ? 'shift' : 'shifts'}</span></div>
          ${me.target ? bar(me.minutes, me.target) : ''}</section>` : '';
      const team = people ? `<section class="card dv-card"><div class="dp-head"><h2>Team</h2><span class="dv-count">${people.filter((p) => p.target && p.minutes >= p.target).length} of ${people.filter((p) => p.target).length} on target</span></div>
          ${people.length ? `<div class="ds-team">${people.map((p) => `<div class="ds-trow">${person(p)}
            <span class="ds-tnum"><b>${esc(dvMins(p.minutes))}</b>${p.target ? `<small>of ${esc(dvMins(p.target))}</small>` : ''}</span>
            ${p.target ? bar(p.minutes, p.target) : '<span class="ds-notgt"></span>'}</div>`).join('')}</div>` : `<p class="muted small">Nobody in ${esc(dept)} yet.</p>`}</section>` : '';
      const days = {};
      log.forEach((s) => { (days[dsDay(s.started_at)] = days[dsDay(s.started_at)] || []).push(s); });
      const how = (s) => (s.status !== 'ended' ? `<span class="ds-pill ${s.status === 'break' ? 'brk' : 'on'}">${s.status === 'break' ? 'On Break' : 'On Shift'}</span>`
        : s.ended_by === 'auto' ? '<span class="ds-pill auto">Ended Automatically</span>' : s.ended_by === 'staff' ? '<span class="ds-pill auto">Ended by Staff</span>' : '');
      const logHtml = `<section class="ds-log"><h3 class="dv-dayh">${people ? 'Shift Log' : 'My Shift Log'}</h3>
          ${log.length ? Object.entries(days).map(([day, rows]) => `<div class="ds-day"><h4>${esc(day)}</h4><div class="card ds-list">${rows.map((s) => `<div class="ds-row${s.me && people ? ' me' : ''}">
            ${people ? person(s) : `<span class="ds-who"><strong>${esc(dvTime(s.started_at))} – ${s.ended_at ? esc(dvTime(s.ended_at)) : 'now'}</strong></span>`}
            <span class="ds-meta">${how(s)}<small>${people ? `${esc(dvTime(s.started_at))} – ${s.ended_at ? esc(dvTime(s.ended_at)) : 'now'} · ` : ''}${esc(dvMins(s.minutes))}${s.break_minutes ? ` · ${esc(dvMins(s.break_minutes))} break` : ''}</small></span></div>`).join('')}</div></div>`).join('')
            : `<div class="card ds-empty"><p class="muted small">${people ? `No shifts in ${esc(dept)} this week yet.` : 'You haven’t been on shift this week yet.'}</p></div>`}</section>`;
      return `<div class="ds-week${people ? ' lead' : ''}"><div class="ds-wtop">${meCard}${team}</div>${logHtml}</div>`;
    }

    // ---------- Leaderboard ----------
    function drawBoard(data) {
      const rows = data.rows || [], me = data.me, top = st.metric === 'top';
      const when = st.period === 'week' ? 'this week' : 'in the last 30 days';
      const placed = rows.filter((r) => r.place != null), rest = rows.length - placed.length;
      const mine = me ? (me.place ? `You’re <b>${dsOrdinal(me.place)}</b> of ${Number(data.of)} ${when}.` : `You’re not on the board ${when} yet.`) : '';
      return `<div class="ds-btools">
          <div class="ma-seg" role="group" aria-label="Rank by">${[['minutes', 'Most Minutes'], ['top', 'Top Performing']].map(([k, l]) => `<button type="button" data-metric="${k}" aria-pressed="${st.metric === k}">${l}</button>`).join('')}</div>
          <div class="ma-seg" role="group" aria-label="Period">${[['week', 'This Week'], ['30d', 'Last 30 Days']].map(([k, l]) => `<button type="button" data-period="${k}" aria-pressed="${st.period === k}">${l}</button>`).join('')}</div></div>
        ${mine ? `<p class="ds-mine-line">${mine}</p>` : ''}
        ${placed.length ? `<div class="card ds-list ds-board">${placed.map((r) => `<div class="ds-row${r.me ? ' me' : ''}${r.place <= 3 ? ' p' + r.place : ''}">
            <span class="ds-place">${r.place}</span>${person(r)}
            <span class="ds-nums"><span><b>${esc(dvMins(r.minutes))}</b><small>On shift</small></span>${top ? '' : `<span><b>${Number(r.shifts || 0)}</b><small>${r.shifts == 1 ? 'Shift' : 'Shifts'}</small></span>`}
              <span><b>${Number(r.events_attended || 0)}</b><small>Events</small></span>${top ? `<span><b>${Math.round(r.score || 0)}</b><small>Score</small></span>` : ''}</span></div>`).join('')}</div>`
          : `<div class="card ds-empty"><p class="muted small">Nobody in ${esc(dept)} has been on shift ${when} yet.</p></div>`}
        ${placed.length && rest ? `<p class="muted small ds-rest">${rest} ${rest === 1 ? 'person has' : 'people have'} no minutes ${when}.</p>` : ''}`;
    }

    function wire() {
      body.querySelectorAll('[data-metric]').forEach((b) => b.onclick = () => { st.metric = b.dataset.metric; setUrl(); load(); });
      body.querySelectorAll('[data-period]').forEach((b) => b.onclick = () => { st.period = b.dataset.period; load(); });
    }
    load();
  },
});
