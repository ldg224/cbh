// Department window (0.32.0, Delta): the new Overview, Roster views, Events, "From the Director" posts and the weekly
// target. Owner-approved design: https://claude.ai/artifact/VZZbeBkH6uZZBPKmtfhPhN (version C).
// Back end: Alpha's DEPT-OVERVIEW-CONTRACT (0078/0079: my_department_overview, dept_post_*, dept_set_target,
// dept_targets, dept_roster_view) and Bravo's EVENTS-CONTRACT (0075-0077: events_feed, my_whats_on, event_rsvp,
// event_get, event_kinds_list, event_save, event_cancel). Errors from the database are shown as written.
// dept.js calls dvOverview() for its Overview tab; the Roster and Events tabs register through DEPT_TABS (dept.js draws
// leaders' Roster itself, with the member list); #events and #events/<id> is the hospital-wide list and one event.

window.DEPT_TABS = window.DEPT_TABS || [];
const dvRanks = {};   // department -> its ranks [{ id, rank_label, rank_order, badge_color }], highest first
async function dvLoadRanks(dept) {
  if (dvRanks[dept]) return dvRanks[dept];
  const { data } = await sb.from('roles').select('id, rank_label, rank_order, badge_color').eq('kind', 'rank').eq('department', dept);
  dvRanks[dept] = (data || []).sort((a, b) => b.rank_order - a.rank_order);
  return dvRanks[dept];
}
const dvLeader = (dept) => !!access.exec || myDirects.includes(dept) || hasPerm('activity.view', dept);
const dvMyRank = (dept) => (window.myRanks || []).filter((r) => r.department === dept).sort((a, b) => b.rank_order - a.rank_order)[0] || null;
const dvRankColour = (dept, label) => { const r = (dvRanks[dept] || []).find((x) => x.rank_label === label); return r && r.badge_color ? hex(r.badge_color) : '#9aa9c4'; };
const dvBadge = (dept, label) => (label ? `<span class="rbadge dv-rank" style="--c:${dvRankColour(dept, label)}"><span class="rl">${esc(label)}</span></span>` : '');
const dvMins = (m) => { m = Math.round(Number(m || 0)); return m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ' ' + (m % 60) + 'm' : ''}` : `${m}m`; };
const dvHello = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; };
// The name in the Overview greeting: the first name, or title + name when the name starts with one ("Dr. Turtle", not
// "Dr."; 0.33.1).
const DV_TITLE = /^(dr|doctor|prof|professor|nurse|sister|mr|mrs|ms|mx|miss|sir|dame|capt|captain|chief|sgt|lt)\.?$/i;
// The short name ("Maia", "Dr. Turtle", "Nurse. Raven"); trailing punctuation goes ("Alex." -> "Alex"). 0.34.0: takes a
// name (the Overview passes the member's own), else the header's.
const dvFirst = (n) => { const w = cleanName(String(n || $('name')?.textContent || '').trim()).split(/\s+/).filter(Boolean);
  const out = w.length > 1 && DV_TITLE.test(w[0]) ? w[0] + ' ' + w[1] : w[0] || '';
  return out.replace(/[.,;:|]+$/, ''); };
const dvDeptOf = (name) => DEPARTMENTS.find((d) => d.name === name);

// ---------- events ----------
const dvDay = (iso) => { const d = new Date(iso); return { wd: d.toLocaleDateString([], { weekday: 'short' }).toUpperCase(), n: d.getDate() }; };
const dvTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function dvEventRow(e, { full = false } = {}) {
  const live = e.status === 'live', d = dvDay(e.starts_at);
  const where = e.location_text ? ' · ' + e.location_text : '';
  const who = e.going ? ` · ${e.going} going` : '';
  const scope = e.audience === 'hospital' ? ' · Everyone' : '';
  const rsvp = e.rsvp && e.can_rsvp && !live && e.status !== 'ended' ? `<span class="dv-rsvp" role="group" aria-label="Are you going to ${esc(e.title)}?">
      <button type="button" class="dv-r${e.my_rsvp === 'going' ? ' on' : ''}" data-rsvp="going" aria-pressed="${e.my_rsvp === 'going'}">${e.my_rsvp === 'going' ? 'Going' : 'Attend'}</button>
      <button type="button" class="dv-r maybe${e.my_rsvp === 'maybe' ? ' on' : ''}" data-rsvp="maybe" aria-pressed="${e.my_rsvp === 'maybe'}">Maybe</button></span>` : '';
  const join = live && e.join_code && typeof joinGameBtn === 'function' ? joinGameBtn(e.join_code, 'dv-join') : '';
  return `<div class="dv-ev${live ? ' live' : ''}" data-ev="${e.id}" style="--k:${esc(e.kind_colour || '#3a82d0')}">
      <span class="dv-date" aria-hidden="true">${live ? '<b>NOW</b><i class="dv-pulse"></i>' : `<b>${esc(d.wd)}</b>${d.n}`}</span>
      <span class="dv-evt"><a href="#events/${e.id}"><strong>${esc(e.title)}</strong></a>
        <span>${live ? 'Live now' : esc(dvTime(e.starts_at))} · ${esc(e.kind_label || 'Event')}${esc(scope + where)}${esc(who)}</span>
        ${full && e.description ? `<span class="dv-desc">${esc(e.description)}</span>` : ''}</span>
      ${join || rsvp}</div>`;
}
// Going / Maybe: tapping your current answer clears it. event_rsvp returns the fresh counts.
function dvWireRsvp(root, events, after) {
  root.querySelectorAll('[data-rsvp]').forEach((b) => b.onclick = async () => {
    const row = b.closest('[data-ev]'), e = events.find((x) => String(x.id) === row.dataset.ev);
    if (!e) return;
    const want = e.my_rsvp === b.dataset.rsvp ? null : b.dataset.rsvp;
    row.querySelectorAll('[data-rsvp]').forEach((x) => { x.disabled = true; });
    const { data, error } = await sb.rpc('event_rsvp', { p_id: e.id, p_response: want });
    if (error) { row.querySelectorAll('[data-rsvp]').forEach((x) => { x.disabled = false; }); dvToast(row, error.message); return; }
    Object.assign(e, { going: data.going, maybe: data.maybe, my_rsvp: data.my_rsvp });
    row.outerHTML = dvEventRow(e, { full: row.querySelector('.dv-desc') != null });
    dvWireRsvp(root, events, after);
    after?.();
  });
}
function dvToast(row, msg) {
  row.querySelector('.dv-err')?.remove();
  row.insertAdjacentHTML('beforeend', `<p class="error dv-err">${esc(msg)}</p>`);
}

// ---------- posts ("From the Director") ----------
function dvPost(p, canPost) {
  return `<article class="dv-post" data-post="${p.id}">
      <div class="dv-ph"><strong>${esc(p.title)}</strong>${p.pinned ? '<span class="dv-pin">Pinned</span>' : ''}</div>
      <p class="dv-pb">${esc(p.body)}</p>
      <div class="dv-pm">${p.author_avatar_url !== undefined ? face({ name: p.author_name || '', avatarUrl: p.author_avatar_url || '', discordId: p.author_discord_id || ('post-' + p.id), size: 'xs' }) : ''}<span>${esc(cleanName(p.author_name || ''))} ·${esc(when(p.created_at))}${p.edited_by_name ? ' · edited' : ''}${p.mirror ? ' · also in Discord' : ''}</span>
        ${canPost ? `<span class="dv-pact"><button type="button" class="linkish" data-pedit="${p.id}">Edit</button><button type="button" class="linkish danger" data-pdel="${p.id}">Delete</button></span>` : ''}</div>
    </article>`;
}
function dvPostForm(p, dept) {
  return `<form class="dv-pform" data-pid="${p ? p.id : ''}">
      <label class="f"><span>Title</span><input name="title" maxlength="120" required value="${esc(p ? p.title : '')}"></label>
      <label class="f"><span>Message</span><textarea name="body" rows="4" maxlength="4000" required>${esc(p ? p.body : '')}</textarea></label>
      <div class="dv-checks">
        <label><input type="checkbox" name="pinned"${p && p.pinned ? ' checked' : ''}> Pin to the top</label>
        <label><input type="checkbox" name="mirror"${!p || p.mirror ? ' checked' : ''}> Also post in Discord</label>
        ${p ? '' : `<label><input type="checkbox" name="ping"> Ping ${esc(dept)}</label>`}
      </div>
      <p class="error" hidden></p>
      <div class="dv-fbtns"><button type="button" class="ghost" data-pcancel>Cancel</button><button type="submit" class="refresh">${p ? 'Save' : 'Post'}</button></div>
    </form>`;
}
function dvWirePosts(sec, dept, posts, canPost, redraw) {
  const open = (p) => {
    sec.querySelector('.dv-pform')?.remove();
    sec.querySelector('.dv-posts').insertAdjacentHTML('beforebegin', dvPostForm(p, dept));
    const f = sec.querySelector('.dv-pform');
    f.querySelector('[name=title]').focus();
    const ping = f.querySelector('[name=ping]'), mirror = f.querySelector('[name=mirror]');
    const sync = () => { if (ping) { ping.disabled = !mirror.checked; if (!mirror.checked) ping.checked = false; } };
    mirror.onchange = sync; sync();
    f.querySelector('[data-pcancel]').onclick = () => f.remove();
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const fd = new FormData(f), err = f.querySelector('.error'), btn = f.querySelector('[type=submit]');
      const body = { title: fd.get('title').trim(), body: fd.get('body').trim(), pinned: !!fd.get('pinned'), mirror: !!fd.get('mirror'), ping: !!fd.get('ping') };
      if (p) body.id = p.id; else body.department = dept;
      btn.disabled = true; err.hidden = true;
      const { error } = await sb.rpc('dept_post_save', { p: body });
      if (error) { btn.disabled = false; err.textContent = error.message; err.hidden = false; return; }
      redraw();
    };
  };
  sec.querySelector('[data-pnew]')?.addEventListener('click', () => open(null));
  sec.querySelectorAll('[data-pedit]').forEach((b) => b.onclick = () => open(posts.find((p) => String(p.id) === b.dataset.pedit)));
  sec.querySelectorAll('[data-pdel]').forEach((b) => b.onclick = async () => {
    if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Tap again to delete'; setTimeout(() => { if (b.isConnected) { b.dataset.armed = ''; b.textContent = 'Delete'; } }, 4000); return; }
    b.disabled = true;
    const { error } = await sb.rpc('dept_post_delete', { p_id: Number(b.dataset.pdel) });
    if (error) { b.disabled = false; dvToast(b.closest('.dv-post'), error.message); return; }
    redraw();
  });
}

// ---------- Overview "Next Up" (0.34.0, Alpha; owner picked direction A of https://claude.ai/artifact/LW9bLE8UrrELaaNZ7ai1bw) ----------
// Your own header (Discord photo, name, rank, the department's pulse), ONE "Next up" action, then Department News,
// Your Team, Your Week (minutes over the week against the target line), What's On and Courses. A card with nothing in
// it is left out for members, or becomes an invite for the person who can fill it. dept.js hides its banner on this tab.
// Back end: my_department_overview (0078 + 0082: me.avatar_url, my_week.days, team, last_shift, avatars), course_list.
// Your Team: 'faces' (everyone, green ring when on shift) is the owner's default; 'pulse' (On now + this week's top 3)
// is the alternative shown in the screenshots. Switch here if the owner picks it.
const DV_TEAM = 'faces';
window.dvOvSkel = () => {
  const card = (...ws) => `<section class="card dv-card">${sk('34%', 14)}<span style="display:block;height:16px"></span>${lines(...ws)}</section>`;
  return `<div class="nu-hero nu-sk" aria-hidden="true"><span class="nu-me-sk"></span><div>${sk('220px', 22)}<span style="display:block;height:8px"></span>${sk('140px', 12)}</div></div>
    <div class="card nu-next nu-sk-next">${sk('50%', 14)}<span style="display:block;height:8px"></span>${sk('70%', 12)}</div>
    <div class="nu-grid"><div class="dv-col">${card('80%', '62%')}${card('90%', '55%')}</div><div class="dv-col">${card('60%', '45%')}</div></div>`;
};
// dept.js starts the Overview's requests as soon as a department opens; dvOverview uses them if they're fresh.
const dvOvPending = {};
const dvOvFetch = (dept) => Promise.all([
  sb.rpc('my_department_overview', { p_department: dept }),
  sb.rpc('course_list', { dept }).then((r) => r, () => ({ data: null })),
  dvLoadRanks(dept),
]);
window.dvPrefetch = (dept) => { dvOvPending[dept] = { at: Date.now(), p: dvOvFetch(dept) }; };
const dvDayName = (iso) => new Date(iso + 'T12:00:00').toLocaleDateString([], { weekday: 'long' });
// Calendar days, not 24-hour blocks: a shift that ended at 5 pm yesterday is "yesterday" at 9 am today.
const dvAgo = (iso) => { const day = (t) => { const x = new Date(t); x.setHours(0, 0, 0, 0); return x; };
  const d = Math.round((day(Date.now()) - day(iso)) / 864e5);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d < 7 ? new Date(iso).toLocaleDateString([], { weekday: 'long' }) : when(iso); };

// Your Week: cumulative minutes Monday to Sunday, the target as a dashed line, today's point marked. Days still to
// come are left blank. Plain SVG drawn to one scale; colours come from the department (--dept-tab) and the theme.
function dvWeekGraph(days, target) {
  const done = days.filter((d) => d.cumulative != null);
  // No minutes and no target: a short strip instead of a tall empty chart.
  const W = 300, H = target || done.some((x) => x.cumulative > 0) ? 120 : 52, L = 8, R = 8, T = H > 60 ? 14 : 10, B = 22;
  const top = Math.max(60, target || 0, ...done.map((d) => d.cumulative)) * 1.12;
  const x = (i) => L + (i * (W - L - R)) / 6, y = (m) => T + (H - T - B) * (1 - m / top);
  const pts = done.map((d, i) => [x(i), y(d.cumulative)]);
  const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const area = pts.length ? `${line} L${pts[pts.length - 1][0].toFixed(1)} ${y(0)} L${pts[0][0].toFixed(1)} ${y(0)} Z` : '';
  const lab = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  const tgtY = target ? y(target) : null;
  return `<svg class="nu-graph" viewBox="0 0 ${W} ${H}" role="img" aria-label="Minutes on shift this week${done.length ? ': ' + dvMins(done[done.length - 1].cumulative) : ''}${target ? ', target ' + dvMins(target) : ''}">
      <line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" class="nu-g-base"/>
      ${target ? `<line x1="${L}" x2="${W - R}" y1="${tgtY.toFixed(1)}" y2="${tgtY.toFixed(1)}" class="nu-g-tgt"/><text x="${W - R}" y="${(tgtY - 4).toFixed(1)}" text-anchor="end" class="nu-g-tl">Target ${esc(dvMins(target))}</text>` : ''}
      ${area ? `<path d="${area}" class="nu-g-area"/><path d="${line}" class="nu-g-line"/>` : ''}
      ${done.map((d, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(d.cumulative).toFixed(1)}" r="${i === done.length - 1 ? 4.5 : 2.6}" class="${i === done.length - 1 ? 'nu-g-now' : 'nu-g-dot'}"/>`).join('')}
      ${lab.map((l, i) => `<text x="${x(i).toFixed(1)}" y="${H - 5}" text-anchor="middle" class="nu-g-x${i === done.length - 1 ? ' on' : ''}">${l}</text>`).join('')}
    </svg>`;
}

window.dvOverview = async (pane, dept, attention, wire) => {
  const d = dvDeptOf(dept) || { id: '', color: '#3a82d0', icon: 'clock' };
  const pre = dvOvPending[dept];
  delete dvOvPending[dept];
  pane.innerHTML = `${window.dvOvSkel()}`;
  const [ovQ, coursesQ] = await (pre && Date.now() - pre.at < 15000 ? pre.p : dvOvFetch(dept));
  if (!pane.isConnected) return;
  if (ovQ.error || !ovQ.data) {
    pane.innerHTML = `${attention}<div class="card"><p class="${ovQ.error ? 'error' : 'muted small'}">${esc(ovQ.error ? ovQ.error.message : 'Nothing to show yet.')}</p></div>`;
    wire(pane); return;
  }
  const ov = ovQ.data, me = ov.me || {}, wk = ov.my_week || {}, events = ov.whats_on || [], posts = ov.posts || [];
  const team = ov.team || [], meRow = team.find((t) => t.me), onNow = ov.on_now || [];
  const mine = (coursesQ.data || []).filter((c) => c.mine), done = mine.filter((c) => c.complete).length;
  const nextCourse = mine.find((c) => !c.complete && !c.lock);
  const leader = !!(me.can_manage || me.leader), canPost = !!me.can_post;
  const base = `#directors/${d.id}`;
  const myName = cleanName(me.name || ($('name')?.textContent || ''));

  // ---- header ----
  const rankPill = me.rank ? `<span class="nu-pill">${esc(me.rank)}</span>` : access.exec ? '<span class="nu-pill">Executive View</span>' : '';
  const nOn = onNow.length;
  const hero = `<section class="nu-hero" style="--icon:${iconUrl(d.icon)}">
      <span class="nu-me">${face({ name: myName, discordId: myDiscordId || '', avatarUrl: me.avatar_url || '', size: 'l' })}</span>
      <div class="nu-hi"><h2>${esc(dvHello())}${dvFirst(me.name) ? ', ' + esc(dvFirst(me.name)) : ''}</h2>
        <div class="nu-sub">${rankPill}<span>${esc(dept)} · ${plural(Number(ov.department?.members || team.length), 'member')}</span></div></div>
      <div class="nu-live"><span class="${nOn ? 'on' : ''}">${nOn ? `${nOn} on shift now` : 'Nobody on shift'}</span></div>
    </section>`;

  // ---- Next up: the one most useful thing to do now ----
  const soon = events.find((e) => e.status === 'live') || events.find((e) => e.status === 'scheduled' && new Date(e.starts_at) - Date.now() < 864e5);
  const hasClock = !!document.querySelector('[data-desk="clock"]');
  const N = (ico, k, title, sub, acts) => `<section class="nu-next" style="--icon:${iconUrl(ico)}"><span class="nu-nico" aria-hidden="true"></span>
      <div class="nu-nt"><span class="nu-k">${esc(k)}</span><strong>${esc(title)}</strong>${sub ? `<span class="nu-ns">${esc(sub)}</span>` : ''}</div>
      <div class="nu-acts">${acts}</div></section>`;
  const btn = (label, attrs, pri) => `<${attrs.startsWith('href') ? 'a' : 'button type="button"'} class="${pri ? 'nu-b pri' : 'nu-b'}" ${attrs}>${esc(label)}</${attrs.startsWith('href') ? 'a' : 'button'}>`;
  let next, nextIsCourse = false, nextEvent = null;
  if (meRow && meRow.on_shift) next = N('clock', meRow.on_shift === 'break' ? 'On break' : 'On shift now', `You're on shift in ${dept}`, `${dvMins(wk.minutes)} this week`, btn('Shift Manager', 'href="#shifts"', true));
  else if (soon) {
    nextEvent = soon;
    const live = soon.status === 'live';
    const acts = live ? btn('Open event', `href="#events/${soon.id}"`, true)
      : soon.rsvp && soon.can_rsvp ? `${btn('Maybe', `data-nrsvp="maybe" data-ev="${soon.id}" aria-pressed="${soon.my_rsvp === 'maybe'}"`)}${btn(soon.my_rsvp === 'going' ? 'Going' : "I'm going", `data-nrsvp="going" data-ev="${soon.id}" aria-pressed="${soon.my_rsvp === 'going'}"`, true)}` : btn('Details', `href="#events/${soon.id}"`, true);
    next = N('calendar', live ? 'Happening now' : 'Next up · ' + dpRel(soon.starts_at).toLowerCase(), soon.title,
      `${new Date(soon.starts_at).toLocaleDateString([], { weekday: 'short' })} ${dvTime(soon.starts_at)}${soon.location_text ? ' · ' + soon.location_text : ''}${soon.going ? ' · ' + soon.going + ' going' : ''}`, acts);
  } else if (nextCourse && (nextIsCourse = true)) next = N('graduation-cap', 'Next up', `Finish ${nextCourse.title}`, `${done} of ${plural(mine.length, 'course')} done in ${dept}`, btn(done ? 'Continue' : 'Start course', `href="${base}/courses"`, true));
  else if (leader && !events.length) next = N('calendar', 'Next up', `Nothing planned for ${dept} this week`, 'An event or a post gives your team something to see here.',
    `${canPost ? btn('Write a post', 'data-npost') : ''}${btn('Plan an event', `href="${base}/events"`, true)}`);
  else next = N('clock', 'Next up', wk.shifts ? `Back on shift in ${dept}` : `Start your first shift this week`, wk.target ? `${dvMins(wk.minutes)} of ${dvMins(wk.target)} so far` : '',
    hasClock ? btn('Start shift', 'data-nclock', true) : btn('Shift Manager', 'href="#shifts"', true));

  // ---- Department News ----
  const news = posts.length || canPost ? `<section class="card dv-card dv-posts-sec nu-news"><div class="dp-head"><h2>Department News</h2>${canPost && posts.length ? '<button type="button" class="ghost small-btn" data-pnew>New post</button>' : ''}</div>
      ${posts.length ? '' : `<div class="nu-invite"><span class="nu-iico" style="--icon:${iconUrl('megaphone')}" aria-hidden="true"></span><div><b>Write your first post</b><span>It shows here for everyone in ${esc(dept)}, and in Discord if you like.</span></div><button type="button" class="ghost small-btn" data-pnew>New post</button></div>`}
      <div class="dv-posts">${posts.map((p) => dvPost(p, canPost)).join('')}</div></section>` : '';

  // ---- Your Team ----
  const ls = ov.last_shift;
  const lastLine = nOn ? `${onNow.slice(0, 2).map((p) => esc(dvFirst(p.name))).join(' and ')}${nOn > 2 ? ` and ${nOn - 2} more` : ''} ${nOn === 1 ? 'is' : 'are'} on shift`
    : ls ? `Last shift: ${esc(dvFirst(ls.name))}, ${esc(dvAgo(ls.ended_at))}, ${esc(dvMins(ls.minutes))}` : `No shifts in ${esc(dept)} yet`;
  const faceOf = (p, size) => face({ name: p.name, discordId: p.discord_id, avatarUrl: p.avatar_url || '', size });
  let teamHtml;
  if ((window.dvTeamMode || DV_TEAM) === 'pulse') {
    const top = team.filter((t) => Number(t.week_minutes) > 0).sort((a, b) => b.week_minutes - a.week_minutes).slice(0, 3);
    teamHtml = `<section class="card dv-card nu-team"><div class="dp-head"><h2>On Now</h2><a class="linkish" href="${base}/shifts">Shifts</a></div>
        ${nOn ? `<div class="nu-onrow">${onNow.map((p) => `<span class="nu-on">${faceOf(p, 's')}<span>${esc(cleanName(p.name))}${p.status === 'break' ? '<small>On break</small>' : ''}</span></span>`).join('')}</div>` : `<p class="muted small nu-quiet">Nobody's on shift. ${ls ? `Last shift: ${esc(dvFirst(ls.name))}, ${esc(dvAgo(ls.ended_at))}.` : ''}</p>`}
        <h3 class="nu-h3">Top This Week</h3>
        ${top.length ? `<ol class="nu-top">${top.map((t, i) => `<li><span class="nu-place">${i + 1}</span>${faceOf(t, 's')}<span class="nu-tn">${esc(cleanName(t.name))}${t.me ? ' <em>You</em>' : ''}</span><b>${esc(dvMins(t.week_minutes))}</b></li>`).join('')}</ol>`
          : `<p class="muted small nu-quiet">Nobody has been on shift this week yet.</p>`}</section>`;
  } else {
    teamHtml = `<section class="card dv-card nu-team"><div class="dp-head"><h2>Your Team</h2><a class="linkish" href="${base}/roster">Roster</a></div>
        <div class="nu-faces">${team.map((t) => `<a class="nu-face${t.on_shift ? ' on' : ''}" href="${base}/roster" title="${esc(cleanName(t.name))}${t.on_shift ? (t.on_shift === 'break' ? ', on break' : ', on shift') : ''}">${faceOf(t, 'm')}<small>${esc(dvFirst(t.name))}</small><em>${esc(t.rank || '')}</em></a>`).join('')}</div>
        <p class="nu-last"><span class="nu-lico" style="--icon:${iconUrl('clock')}" aria-hidden="true"></span>${lastLine}</p></section>`;
  }

  // ---- Your Week ----
  const days = wk.days || [];
  const tgt = wk.target || null;
  const weekHtml = `<section class="card dv-card nu-week"><div class="dp-head"><h2>Your Week</h2><a class="linkish" href="${base}/shifts/week">Shifts</a></div>
      <div class="nu-wnum"><b>${esc(dvMins(wk.minutes))}</b><span>${tgt ? `of ${esc(dvMins(tgt))} target` : 'on shift'} · ${plural(Number(wk.shifts || 0), 'shift')}</span>${tgt && wk.minutes >= tgt ? '<span class="dv-streak">Target met</span>' : ''}</div>
      ${days.length ? dvWeekGraph(days, tgt) : ''}
      ${tgt ? '' : me.can_manage ? `<p class="nu-notgt">No target set. <a class="linkish" href="${base}/manage/ranks">Set a target</a></p>` : '<p class="nu-notgt">No target set</p>'}
    </section>`;

  // ---- What's On (events beyond the one in Next up) and Courses ----
  const rest = events.filter((e) => !nextEvent || e.id !== nextEvent.id);
  const evHtml = rest.length ? `<section class="card dv-card"><div class="dp-head"><h2>What's On</h2><a class="linkish" href="${base}/events">All events</a></div>
      <div class="dv-evs">${rest.slice(0, 4).map((e) => dvEventRow(e)).join('')}</div></section>` : '';
  const crHtml = mine.length && !(nextIsCourse && mine.length === 1) ? `<section class="card dv-card"><div class="dp-head"><h2>Courses</h2><a class="linkish" href="${base}/courses">All courses</a></div>
      <div class="dv-big">${done} <span>of ${mine.length} ${mine.length === 1 ? 'course' : 'courses'}</span></div>
      <div class="dv-bar dept"><i style="width:${Math.round((done / mine.length) * 100)}%"></i></div></section>` : '';

  const draw = () => {
    pane.innerHTML = `${hero}${attention}${next}
      <div class="nu-grid"><div class="dv-col">${news}${teamHtml}</div><div class="dv-col">${weekHtml}${evHtml}${crHtml}</div></div>`;
    wire(pane);
    dvWireRsvp(pane, events);
    const sec = pane.querySelector('.dv-posts-sec');
    if (sec) dvWirePosts(sec, dept, posts, canPost, async () => {
      window.dvOverview(pane, dept, attention, wire);
    });
    pane.querySelector('[data-npost]')?.addEventListener('click', () => { const b = pane.querySelector('.dv-posts-sec [data-pnew]'); b?.click(); b?.closest('section')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); });
    pane.querySelector('[data-nclock]')?.addEventListener('click', () => document.querySelector('[data-desk="clock"]')?.click());
    pane.querySelectorAll('[data-nrsvp]').forEach((b) => b.onclick = async () => {
      const e = events.find((x) => String(x.id) === b.dataset.ev); if (!e) return;
      const want = e.my_rsvp === b.dataset.nrsvp ? null : b.dataset.nrsvp;
      pane.querySelectorAll('[data-nrsvp]').forEach((x) => { x.disabled = true; });
      const { data, error } = await sb.rpc('event_rsvp', { p_id: e.id, p_response: want });
      if (error) { pane.querySelectorAll('[data-nrsvp]').forEach((x) => { x.disabled = false; }); b.closest('.nu-next').insertAdjacentHTML('beforeend', `<p class="error dv-err">${esc(error.message)}</p>`); return; }
      Object.assign(e, { going: data.going, maybe: data.maybe, my_rsvp: data.my_rsvp });
      pane.querySelectorAll('[data-nrsvp]').forEach((x) => { x.disabled = false; x.setAttribute('aria-pressed', String(e.my_rsvp === x.dataset.nrsvp)); if (x.dataset.nrsvp === 'going') x.textContent = e.my_rsvp === 'going' ? 'Going' : "I'm going"; });
      const ns = b.closest('.nu-next').querySelector('.nu-ns'); if (ns) ns.textContent = ns.textContent.replace(/ · \d+ going$/, '') + (e.going ? ` · ${e.going} going` : '');
    });
    loadFaces(pane);
  };
  draw();
};

// ---------- Roster for members (everyone in the department) ----------
// Leaders (dept.view, members.edit or activity.view) get dept.js's member list here instead, with its edit controls.
// Members: Everyone, or their own Year, as toggles at the top (the database allows "all" and their own Year; the
// rankings moved to Shifts as its Leaderboard, owner 0.33.0).
window.DEPT_TABS.push({
  id: 'roster', label: 'Roster', icon: 'people',
  show: (dept) => inMyDept(dept) || dvLeader(dept),
  async render(pane, dept, sub) {
    const ranks = await dvLoadRanks(dept), mine = dvMyRank(dept);
    const views = [['all', 'Everyone'], ...(mine && mine.rank_label !== 'Director' ? [['year:' + mine.id, mine.rank_label]] : [])];
    let view = views.some(([k]) => k === sub) ? sub : 'all';
    const d = dvDeptOf(dept);
    async function draw() {
      pane.innerHTML = `${views.length > 1 ? `<div class="dp-toggles" role="group" aria-label="Roster">${views.map(([k, l]) => `<button type="button" data-view="${esc(k)}" aria-pressed="${k === view}">${esc(l)}</button>`).join('')}</div>` : ''}
        <div class="dv-cards">${typeof lines === 'function' ? `<div class="card dv-pc">${lines('50%', '30%')}</div>` : ''}</div>`;
      pane.querySelectorAll('[data-view]').forEach((b) => b.onclick = () => {
        if (b.dataset.view === view) return;
        view = b.dataset.view;
        try { history.replaceState(null, '', `#directors/${d.id}/roster${view === 'all' ? '' : '/' + view}`); } catch { /* fine */ }
        draw();
      });
      const { data, error } = await sb.rpc('dept_roster_view', { p_department: dept, p_view: view, p_period: 'week' });
      const box = pane.querySelector('.dv-cards');
      if (!box || !pane.isConnected) return;
      if (error) { box.innerHTML = `<p class="error">${esc(error.message)}</p>`; return; }
      const rows = (data && data.rows) || [];
      box.innerHTML = rows.length ? rows.map((r) => `<div class="card dv-pc">
          <div class="dv-pch">${face({ name: r.name, discordId: r.discord_id, avatarUrl: r.avatar_url || '', size: 'm' })}
            <span class="dv-pcn"><strong>${esc(cleanName(r.name))}</strong>${dvBadge(dept, r.rank)}</span>${r.on_now ? '<span class="dv-on">On now</span>' : ''}</div>
          ${r.minutes != null ? `<div class="dv-trio"><div><b>${esc(dvMins(r.minutes))}</b><span>On shift</span></div><div><b>${Number(r.shifts || 0)}</b><span>Shifts</span></div><div><b>${Number(r.events_attended || 0)}</b><span>Events</span></div></div>` : ''}
          ${r.last_active ? `<div class="dv-pcf"><span>Last active ${esc(when(r.last_active))}</span></div>` : ''}
        </div>`).join('') : `<p class="muted small">Nobody here yet.</p>`;
      loadFaces(box);
    }
    draw();
  },
});

// ---------- Events (the department's tab, and #events for everyone) ----------
const DV_DURATIONS = [[30, '30 minutes'], [45, '45 minutes'], [60, '1 hour'], [90, '1.5 hours'], [120, '2 hours'], [180, '3 hours']];
function dvEventForm(kinds, dept) {
  const today = new Date(Date.now() + 864e5), pad = (n) => String(n).padStart(2, '0');
  const date = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  const hosp = kinds.some((k) => k.can_create_hospital);
  return `<form class="card dv-eform">
      <h3>New Event</h3>
      <div class="dv-grid2">
        <label class="f"><span>Type</span><select name="kind">${kinds.filter((k) => k.can_create_department || k.can_create_hospital).map((k) => `<option value="${esc(k.kind)}">${esc(k.label)}</option>`).join('')}</select></label>
        <label class="f"><span>Title</span><input name="title" maxlength="120" required></label>
        <label class="f"><span>Date</span><input type="date" name="date" value="${date}" required></label>
        <label class="f"><span>Time</span><input type="time" name="time" value="19:00" required></label>
        <label class="f"><span>Length</span><select name="duration">${DV_DURATIONS.map(([m, l]) => `<option value="${m}"${m === 60 ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="f"><span>Where</span><input name="location" maxlength="120" placeholder="In game, or a voice channel"></label>
        ${hosp ? `<label class="f"><span>Who it's for</span><select name="audience"><option value="department">${esc(dept)}</option><option value="hospital">Everyone at CareBeyond</option></select></label>` : ''}
      </div>
      <label class="f"><span>Details</span><textarea name="description" rows="3" maxlength="2000"></textarea></label>
      <label class="dv-checks"><span><input type="checkbox" name="ping" checked> Ping people when it's posted</span></label>
      <p class="error" hidden></p>
      <div class="dv-fbtns"><button type="button" class="ghost" data-ecancel>Cancel</button><button type="submit" class="refresh">Create event</button></div>
    </form>`;
}
async function dvEventsList(pane, dept) {
  const [feedQ, kindsQ] = await Promise.all([
    dept ? sb.rpc('events_feed', { p_department: dept }) : sb.rpc('my_whats_on', { p_days: 14 }),
    dept ? sb.rpc('event_kinds_list', { p_department: dept }).then((r) => r, () => ({ data: [] })) : Promise.resolve({ data: [] }),
  ]);
  if (!pane.isConnected) return;
  if (feedQ.error) { pane.innerHTML = `<div class="card"><p class="error">${esc(feedQ.error.message)}</p></div>`; return; }
  const events = feedQ.data || [], kinds = (kindsQ.data || []).filter((k) => k.can_create_department || k.can_create_hospital);
  const days = {};
  events.forEach((e) => { const k = new Date(e.starts_at).toDateString(); (days[k] ||= []).push(e); });
  const label = (k) => { const d = new Date(k), t = new Date(); const diff = Math.round((new Date(d.toDateString()) - new Date(t.toDateString())) / 864e5);
    return diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' }); };
  pane.innerHTML = `<div class="dv-rhead"><h2>${dept ? 'Events' : 'Coming Up'}</h2>${kinds.length ? '<button type="button" class="refresh" data-enew>New event</button>' : ''}</div>
    <div class="dv-eform-slot"></div>
    ${events.length ? Object.entries(days).map(([k, list]) => `<section class="dv-day"><h3 class="dv-dayh">${esc(label(k))}</h3><div class="card dv-evs">${list.map((e) => dvEventRow(e, { full: true })).join('')}</div></section>`).join('')
      : `<div class="card"><p class="muted small">Nothing planned for the next two weeks.</p></div>`}`;
  dvWireRsvp(pane, events);
  pane.querySelector('[data-enew]')?.addEventListener('click', () => {
    const slot = pane.querySelector('.dv-eform-slot');
    if (slot.firstChild) { slot.innerHTML = ''; return; }
    slot.innerHTML = dvEventForm(kinds, dept);
    const f = slot.querySelector('form');
    f.querySelector('[name=title]').focus();
    f.querySelector('[data-ecancel]').onclick = () => { slot.innerHTML = ''; };
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const fd = new FormData(f), err = f.querySelector('.error'), btn = f.querySelector('[type=submit]');
      const starts = new Date(`${fd.get('date')}T${fd.get('time')}`);
      if (isNaN(starts)) { err.textContent = 'Pick a date and time.'; err.hidden = false; return; }
      const loc = String(fd.get('location') || '').trim();
      btn.disabled = true; err.hidden = true;
      const { error } = await sb.rpc('event_save', { p: { kind: fd.get('kind'), title: fd.get('title').trim(), description: String(fd.get('description') || '').trim() || null,
        department: dept, audience: fd.get('audience') || 'department', starts_at: starts.toISOString(), duration_minutes: Number(fd.get('duration')),
        location_kind: loc ? 'in_game' : 'discord', location_text: loc || null, ping: !!fd.get('ping') } });
      if (error) { btn.disabled = false; err.textContent = error.message; err.hidden = false; return; }
      dvEventsList(pane, dept);
    };
  });
}
window.DEPT_TABS.push({ id: 'events', label: 'Events', icon: 'calendar', show: (dept) => inMyDept(dept) || dvLeader(dept), render: (pane, dept) => { pane.innerHTML = '<p class="muted small">Loading…</p>'; dvEventsList(pane, dept); } });

// One event (#events/<id>; the bot's "Details" button links here).
async function dvEventPage(body, id) {
  body.innerHTML = '<div class="card"><p class="muted small">Loading…</p></div>';
  const { data: e, error } = await sb.rpc('event_get', { p_id: id });
  if (!body.isConnected) return;
  if (error || !e) { body.innerHTML = `<div class="card"><p class="${error ? 'error' : 'muted small'}">${esc(error ? error.message : 'We couldn’t find that event.')}</p></div>`; return; }
  const start = new Date(e.starts_at), end = e.ends_at ? new Date(e.ends_at) : null;
  const going = (e.rsvps || []).filter((r) => r.response === 'going'), maybe = (e.rsvps || []).filter((r) => r.response === 'maybe');
  const ppl = (list) => list.map((r) => `<span class="dv-chip">${esc(cleanName(r.name))}</span>`).join('');
  body.innerHTML = `<article class="card dv-evpage" style="--k:${esc(e.kind_colour || '#3a82d0')}">
      <span class="dv-kind">${esc(e.kind_label || 'Event')}${e.department ? ' · ' + esc(e.department) : ' · Everyone'}${e.status === 'cancelled' ? ' · Cancelled' : e.status === 'live' ? ' · Live now' : ''}</span>
      <h2>${esc(e.title)}</h2>
      <p class="dv-when">${esc(start.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' }))}, ${esc(dvTime(e.starts_at))}${end ? ' to ' + esc(dvTime(e.ends_at)) : ''}${e.location_text ? ' · ' + esc(e.location_text) : ''}</p>
      ${e.description ? `<p class="dv-desc">${esc(e.description)}</p>` : ''}
      <p class="muted small">${(e.hosts || []).length ? 'Hosted by ' + esc(e.hosts.map((h) => cleanName(h.name)).join(', ')) + ' · ' : ''}${Number(e.going || 0)} going${e.maybe ? ' · ' + e.maybe + ' maybe' : ''}</p>
      <div class="dv-evs">${dvEventRow(e)}</div>
      ${e.rsvps ? `<div class="dv-rsvps">${going.length ? `<h3>Going</h3><div>${ppl(going)}</div>` : ''}${maybe.length ? `<h3>Maybe</h3><div>${ppl(maybe)}</div>` : ''}</div>` : ''}
      ${e.can_edit && e.status === 'scheduled' ? `<div class="dv-fbtns"><button type="button" class="ghost danger" data-ecan>Cancel event</button></div><p class="error" hidden></p>` : ''}
    </article>`;
  dvWireRsvp(body, [e]);
  const can = body.querySelector('[data-ecan]');
  if (can) can.onclick = async () => {
    if (can.dataset.armed !== '1') { can.dataset.armed = '1'; can.textContent = 'Tap again to cancel it'; return; }
    can.disabled = true;
    const { error: err } = await sb.rpc('event_cancel', { p_id: e.id, p_reason: null });
    if (err) { can.disabled = false; const p = body.querySelector('.error'); p.textContent = err.message; p.hidden = false; return; }
    dvEventPage(body, id);
  };
}
LIVE.events = (body) => {
  const id = Number(location.hash.split('/')[1]);
  if (id) dvEventPage(body, id); else dvEventsList(body, null);
};

// ---------- weekly minutes target (Ranks & permissions; dept.js calls this after the grid) ----------
window.dvTargetsCard = async (pane, dept, ranks) => {
  const { data, error } = await sb.rpc('dept_targets', { p_department: dept });
  if (!pane.isConnected || error || !data) return;
  const byRank = Object.fromEntries((data.ranks || []).map((r) => [r.rank_role_id, r.minutes]));
  const rows = ranks.filter((r) => r.rank_label !== 'Director');
  const inp = (name, val, label) => `<input type="number" min="0" max="10080" step="15" inputmode="numeric" name="${name}" value="${val ?? ''}" placeholder="None" aria-label="${esc(label)}">`;
  pane.insertAdjacentHTML('beforeend', `<section class="card dv-targets">
      <div class="dp-head"><h2>Weekly Minutes Target</h2><span class="muted small-meta">Shown on everyone's Overview. A rank's own target replaces the department's.</span></div>
      <form class="dv-tform"><div class="dv-trow"><span>${esc(dept)}</span>${inp('dept', data.department, dept + ' weekly target in minutes')}<em>min</em></div>
        ${rows.map((r) => `<div class="dv-trow"><span>${dvBadge(dept, r.rank_label) || esc(r.rank_label)}</span>${inp('r:' + r.id, byRank[r.id], r.rank_label + ' weekly target in minutes')}<em>min</em></div>`).join('')}
        <p class="error" hidden></p><div class="dv-fbtns"><span class="muted small-meta dv-saved" hidden>Saved</span><button type="submit" class="refresh">Save targets</button></div></form>
    </section>`);
  const f = pane.querySelector('.dv-tform');
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    const err = f.querySelector('.error'), btn = f.querySelector('[type=submit]'), ok = f.querySelector('.dv-saved');
    const val = (el) => (el.value === '' ? null : Number(el.value));
    btn.disabled = true; err.hidden = true; ok.hidden = true;
    const calls = [];
    const dEl = f.querySelector('[name=dept]');
    if (val(dEl) !== (data.department ?? null)) calls.push(sb.rpc('dept_set_target', { p_department: dept, p_minutes: val(dEl), p_rank_role_id: null }));
    f.querySelectorAll('[name^="r:"]').forEach((el) => { const id = el.name.slice(2); if (val(el) !== (byRank[id] ?? null)) calls.push(sb.rpc('dept_set_target', { p_department: dept, p_minutes: val(el), p_rank_role_id: id })); });
    const res = await Promise.all(calls);
    btn.disabled = false;
    const bad = res.find((r) => r.error);
    if (bad) { err.textContent = bad.error.message; err.hidden = false; return; }
    ok.hidden = false;
  };
};

// ---------- 0.32.2: the outer menu tidy (owner) ----------
// Sessions and Tickets are department pages now (Leaders in the inner menu); Commands is part of Rules & info.
const dvMine = () => DEPARTMENTS.filter((d) => canSee('dir:' + d.name));
const dvTicketsFor = (dept) => !!access.exec || myLeads.includes(dept);
window.DEPT_TABS.push({ id: 'sessions', label: 'Sessions', icon: 'controller', show: (dept) => canSee('sessions') && (inMyDept(dept) || dvLeader(dept)), render: (pane) => renderSessions(pane) });
// Administration has one Tickets: the Hospital Tools one (admin-tools.js), for every lead there.
window.DEPT_TABS.push({ id: 'tickets', label: 'Tickets', icon: 'inbox', show: (dept) => dvTicketsFor(dept) && !(dept === 'Administration' && (access.admin || (typeof adminTicketLead === 'function' && adminTicketLead()))), render: (pane, dept) => renderTeamTickets(pane, dept) });
// Old links land on the same thing in your department (or the closest page you can see).
function dvRedirect() {
  const h = location.hash;
  const go = (to) => { location.replace(to); return true; };
  if (/^#commands(\/|$)/.test(h)) return go('#rules');
  if (/^#support(\/|$)/.test(h)) return go('#contact');   // the Support FAQ page was dropped (owner, 0.32.2)
  if (/^#(admin|directors)\/sessions(\/|$)/.test(h)) {
    const d = dvMine()[0];
    return go(d ? `#directors/${d.id}/${canSee('sessions') ? 'sessions' : 'events'}` : '#events');
  }
  if (/^#tickets(\/|$)/.test(h)) {
    const d = DEPARTMENTS.find((x) => dvTicketsFor(x.name) && canSee('dir:' + x.name) && !(x.name === 'Administration' && access.admin));
    return go(d ? `#directors/${d.id}/tickets` : access.admin ? adminHref('tickets') : '#');
  }
  return false;
}

// Rules & info: the rules (still being written) and the Discord commands.
LIVE.rules = (body) => {
  body.innerHTML = `<div class="card building-note"><span class="t-ico" style="--c:#3a82d0;--icon:${iconUrl('book')}" aria-hidden="true"></span>
      <div class="case-main"><strong>The hospital rules are being written</strong><span class="muted small-meta">They'll be here soon.</span></div></div>
    <h2 class="dv-sec">Discord Commands</h2>${commandsPage()}`;
};
