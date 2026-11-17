// Activity (#exec/reports; was "Reports", renamed by the owner 18 Nov 2026). Executives only.
// One call: activity_report(from, to, prev_from, prev_to) (migration 0024) gives totals for the period and the one
// before it, hours by department, and every staff member's hours, shifts, sessions hosted and mod actions taken.
// Staff with no shifts in the period are listed apart ("No shifts"). Loaded after faces.js and cases.js.
const AC_RANGES = {
  week: { label: 'This week', vs: 'vs this time last week', span() { const s = +new Date(weekStartSydney()), n = Date.now(); return [s, n, s - 7 * 864e5, n - 7 * 864e5]; } },
  last: { label: 'Last week', vs: 'vs the week before', span() { const s = +new Date(weekStartSydney()); return [s - 7 * 864e5, s, s - 14 * 864e5, s - 7 * 864e5]; } },
  d30: { label: 'Last 30 days', vs: 'vs the 30 days before', span() { const n = Date.now(); return [n - 30 * 864e5, n, n - 60 * 864e5, n - 30 * 864e5]; } },
};
const AC_SORTS = [['hours', 'Hours'], ['sessions', 'Sessions'], ['actions', 'Mod actions']];
const acNum = (n) => Number(n || 0);
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const acH = (n) => { const v = acNum(n); return v >= 100 ? Math.round(v).toString() : v.toFixed(1); };
const acDeptColour = (name) => (DEPARTMENTS.find((d) => d.name === name) || {}).color || '#3a82d0';

// Change against the comparison period. Hours as a percentage, counts as +/- a number.
function acTrend(cur, prev, { pct = false, quiet = false } = {}) {
  cur = acNum(cur); prev = acNum(prev);
  if (!cur && !prev) return quiet ? '' : '<span class="ac-tr flat">No change</span>';
  if (!prev) return '<span class="ac-tr up">New</span>';
  const d = cur - prev;
  if (Math.abs(d) < (pct ? 0.05 : 1)) return '<span class="ac-tr flat">No change</span>';
  const txt = pct ? `${Math.round(Math.abs(d) / prev * 100)}%` : Math.abs(d);
  return `<span class="ac-tr ${d > 0 ? 'up' : 'down'}"><span aria-hidden="true">${d > 0 ? '↑' : '↓'}</span><span class="sr">${d > 0 ? 'Up' : 'Down'} </span>${txt}</span>`;
}

async function renderActivity(body) {
  const st = { range: 'week', sort: 'hours', dept: 'all', data: null };
  body.innerHTML = `
    <div class="ac-top">
      <div class="ma-seg" id="ac-range" role="group" aria-label="Period">${Object.entries(AC_RANGES).map(([k, r]) =>
        `<button type="button" data-r="${k}" aria-pressed="${k === st.range}">${r.label}</button>`).join('')}</div>
      <span class="ac-vs" id="ac-vs"></span>
    </div>
    <div id="ac-body"><div class="card"><p class="muted small">Loading activity…</p></div></div>`;
  const $b = (s) => body.querySelector(s);
  const out = $b('#ac-body');

  $b('#ac-range').onclick = (e) => {
    const b = e.target.closest('[data-r]'); if (!b || b.dataset.r === st.range) return;
    st.range = b.dataset.r;
    body.querySelectorAll('#ac-range [data-r]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    load();
  };

  async function load() {
    const [f, t, pf, pt] = AC_RANGES[st.range].span().map((x) => new Date(x).toISOString());
    $b('#ac-vs').textContent = '';
    const { data, error } = await sb.rpc('activity_report', { from_ts: f, to_ts: t, prev_from: pf, prev_to: pt });
    if (error) { out.innerHTML = ''; return liveError(out, error); }
    if (!data) { out.innerHTML = '<div class="card"><p class="muted small">Only executives can see Activity.</p></div>'; return; }
    st.data = data;
    $b('#ac-vs').textContent = 'Changes ' + AC_RANGES[st.range].vs;
    draw();
  }

  function draw() {
    const d = st.data, T = d.totals, P = d.prev;
    const people = d.people.map((p) => ({ ...p, name: cleanName(p.name || 'Unknown') }));
    const active = people.filter((p) => acNum(p.hours) || acNum(p.sessions) || acNum(p.actions));
    const quiet = people.filter((p) => p.staff && !acNum(p.shifts));
    const inDept = (p) => st.dept === 'all' || (p.departments || []).includes(st.dept);
    const rows = active.filter(inDept).sort((a, b) => acNum(b[st.sort]) - acNum(a[st.sort]) || acNum(b.hours) - acNum(a.hours) || a.name.localeCompare(b.name));
    const quietRows = quiet.filter(inDept).sort((a, b) => acNum(b.prev_hours) - acNum(a.prev_hours) || a.name.localeCompare(b.name));

    // every department, even with no hours, so a quiet department shows
    const depts = DEPARTMENTS.map((x) => {
      const r = d.departments.find((y) => y.department === x.name) || {};
      return { name: x.name, color: x.color, hours: acNum(r.hours), prev: acNum(r.prev_hours), shifts: acNum(r.shifts), people: acNum(r.people) };
    }).sort((a, b) => b.hours - a.hours);
    const max = Math.max(1, ...depts.map((x) => x.hours));
    const stat = (label, cur, prev, opts) => `<div class="ac-stat"><span class="ac-stat-l">${label}</span>
      <span class="ac-stat-n">${cur}</span>${acTrend(opts.raw, opts.prevRaw ?? prev, opts)}</div>`;

    out.innerHTML = `
      <div class="ac-stats">
        ${stat('Hours on shift', acH(T.hours), P.hours, { raw: T.hours, pct: true })}
        ${stat('Shifts', acNum(T.shifts), P.shifts, { raw: T.shifts })}
        ${stat('Sessions run', acNum(T.sessions), P.sessions, { raw: T.sessions })}
        ${stat('Mod actions', acNum(T.actions), P.actions, { raw: T.actions })}
      </div>

      <section class="ac-sec">
        <h2 class="ma-day">Departments</h2>
        <div class="card ac-depts">${depts.map((x) => `
          <button type="button" class="ac-dept${st.dept === x.name ? ' on' : ''}" data-dept="${esc(x.name)}" style="--c:${x.color}" aria-pressed="${st.dept === x.name}">
            <span class="ac-dept-name"><span class="ac-dot" aria-hidden="true"></span>${esc(x.name)}</span>
            <span class="meter"><span style="width:${(x.hours / max) * 100}%"></span></span>
            <span class="ac-dept-h"><strong>${acH(x.hours)} h</strong>${acTrend(x.hours, x.prev, { pct: true, quiet: true })}</span>
            <span class="ac-dept-sub">${x.shifts ? `${plural(x.shifts, 'shift')} · ${plural(x.people, 'person', 'people')}` : 'No shifts'}</span>
          </button>`).join('')}</div>
      </section>

      <section class="ac-sec">
        <div class="ac-head">
          <h2 class="ma-day">${st.dept === 'all' ? 'Staff' : esc(st.dept)} <span class="count">${rows.length}</span></h2>
          <div class="ac-tools">
            ${st.dept !== 'all' ? '<button type="button" class="chip" id="ac-alldepts">All departments ×</button>' : ''}
            <div class="ma-seg" id="ac-sort" role="group" aria-label="Sort by">${AC_SORTS.map(([k, l]) =>
              `<button type="button" data-s="${k}" aria-pressed="${k === st.sort}">${l}</button>`).join('')}</div>
          </div>
        </div>
        <div class="card ac-list">${rows.length ? `
          <div class="ac-row ac-colhead" aria-hidden="true"><span></span><span></span><span>Hours</span><span>Shifts</span><span>Sessions</span><span>Mod actions</span></div>
          ${rows.map((p) => `
          <div class="ac-row">
            ${face({ name: p.name, discordId: p.discord_id, avatarUrl: p.avatar_url, size: 'm' })}
            <div class="ac-who"><button type="button" class="ma-name" data-rec="${esc(p.discord_id)}" data-name="${esc(p.name)}">${esc(p.name)}</button>
              <span class="ac-depts-of">${(p.departments || []).map((x) => `<span class="ac-dtag" style="--c:${acDeptColour(x)}">${esc(x)}</span>`).join('') || '<span class="muted">No department</span>'}</span></div>
            <span class="ac-n ac-hours${st.sort === 'hours' ? ' on' : ''}"><strong>${acH(p.hours)} h</strong>${acTrend(p.hours, p.prev_hours, { pct: true, quiet: true })}</span>
            <div class="ac-counts">${[['shifts', 'shift'], ['sessions', 'session'], ['actions', 'mod action']].map(([k, one]) => {
              const n = acNum(p[k]);
              return `<span class="ac-n${st.sort === k ? ' on' : ''}${n ? '' : ' zero'}">${n || '–'}<span class="ac-lbl"> ${plural(n, one).replace(/^\d+ /, '')}</span></span>`;
            }).join('')}</div>
          </div>`).join('')}` : `<p class="muted small ac-empty">No activity ${st.dept === 'all' ? '' : `in ${esc(st.dept)} `}in this period.</p>`}</div>
      </section>

      ${quietRows.length ? `<section class="ac-sec">
        <h2 class="ma-day">No shifts <span class="count">${quietRows.length}</span></h2>
        <div class="card ac-quiet">${quietRows.map((p) => `
          <button type="button" class="ac-q" data-rec="${esc(p.discord_id)}" data-name="${esc(p.name)}">
            ${face({ name: p.name, discordId: p.discord_id, avatarUrl: p.avatar_url, size: 's' })}
            <span class="ac-q-main"><span class="ac-q-name">${esc(p.name)}</span>
              <span class="ac-q-sub">${esc((p.departments || []).join(', ') || 'No department')}${acNum(p.prev_hours) ? ` · ${acH(p.prev_hours)} h before` : ''}</span></span>
          </button>`).join('')}</div>
      </section>` : ''}`;
    loadFaces(out);
  }

  out.onclick = (e) => {
    const r = e.target.closest('[data-rec]');
    if (r) { rememberRecord(r.dataset.rec, r.dataset.name); openRecord(r.dataset.rec); return; }
    const dp = e.target.closest('[data-dept]');
    if (dp) { st.dept = st.dept === dp.dataset.dept ? 'all' : dp.dataset.dept; draw(); return; }
    if (e.target.closest('#ac-alldepts')) { st.dept = 'all'; draw(); return; }
    const s = e.target.closest('[data-s]');
    if (s && s.dataset.s !== st.sort) { st.sort = s.dataset.s; draw(); }
  };

  load();
}

LIVE.reports = renderActivity;
