// CHART HISTORY (Alpha): "how do we check the history of each chart submitted?" (user, 20 Nov 2026). One per
// clinical department: a department page tab (dept.js DEPT_TABS hook, like Shifts), the department's closed cases
// with search + filters + Load more, and the full record READ-ONLY. Works with nobody on shift. Data:
//   chart_history(p_before_id, p_limit, p_search, p_from, p_to, p_outcome, p_team, p_person)  paged, newest first
//   chart_case(p_id)  the full record, shown here READ-ONLY
// The server decides who sees what (owners all, Directors their department's cases, staff the cases they worked on);
// this tab always asks for its own department (p_team).
(() => {
  const CLINICAL = ['Nursing', 'Medical', 'Surgical', 'Paramedicine'];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const URG = { 1: ['Red', 'Immediate', '#D92D20'], 2: ['Orange', 'Very urgent', '#F57C00'], 3: ['Yellow', 'Urgent', '#E3B100'], 4: ['Green', 'Standard', '#16A34A'], 5: ['Blue', 'Not urgent', '#2F6FD6'] };
  const urg = (n) => URG[n] || ['–', 'No colour', '#9AA9C4'];
  const OUT = { home: 'Discharged home', follow_up: 'Discharged with follow-up', admitted: 'Admitted', transferred: 'Transferred', left_before_seen: 'Left before being seen',
    left_during_care: 'Left against medical advice', died: 'Deceased', session_ended: 'Closed at end of session', void: 'Voided' };
  const OUTCLS = { home: 'ok', follow_up: 'ok', admitted: 'info', transferred: 'info', left_before_seen: 'muted', left_during_care: 'warn', died: 'dark', session_ended: 'muted', void: 'muted' };
  const VIT = [['hr', 'Heart rate', 'bpm'], ['sys', 'Blood pressure', 'mmHg'], ['temp', 'Temperature', '°F'], ['spo2', 'Oxygen', '%'], ['rr', 'Breathing rate', '/min'], ['co2', 'CO₂', 'mmHg'], ['pain', 'Pain', '/10']];
  const when = (iso) => (iso ? new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '');
  const dayLabel = (iso) => (iso ? new Date(iso).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : '');
  const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '');
  const stay = (a, b) => { if (!a || !b) return ''; const m = Math.max(0, Math.round((new Date(b) - new Date(a)) / 60000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
  const pill = (n) => `<span class="ph-u" style="--u:${urg(n)[2]}">${esc(urg(n)[0])}</span>`;
  const outPill = (o) => `<span class="ph-o ${OUTCLS[o] || 'muted'}">${esc(OUT[o] || o || 'Closed')}</span>`;
  const LIMIT = 30;

  let el = null, ctx = null, DEPT = '';
  const F = { search: '', from: '', to: '', outcome: '', team: '', person: '' };
  const deptId = () => ((typeof DEPARTMENTS !== 'undefined' && DEPARTMENTS.find((d) => d.name === DEPT)) || {}).id || '';
  const setHash = (caseId) => { try { history.replaceState(null, '', `#directors/${deptId()}/chart-history${caseId ? '/' + caseId : ''}`); } catch { /* fine */ } };
  const U = { rows: [], people: [], done: false, busy: false, err: '', open: null, rec: null, recErr: '', showFilters: false, gen: 0 };

  // ---------- data ----------
  async function load(more) {
    if (U.busy && more) return;
    const gen = ++U.gen; U.busy = true; U.err = '';
    if (!more) { U.rows = []; U.done = false; }
    draw();
    try {
      const r = await ctx.rpc('chart_history', { p_before_id: more && U.rows.length ? U.rows[U.rows.length - 1].id : null, p_limit: LIMIT,
        p_search: F.search.trim() || null, p_from: F.from || null, p_to: F.to || null, p_outcome: F.outcome || null, p_team: DEPT || null, p_person: F.person || null });
      if (gen !== U.gen) return;   // a newer search started
      const rows = Array.isArray(r) ? r : (r && r.rows) || [];
      if (r && r.people) U.people = r.people;
      U.rows = U.rows.concat(rows); U.done = rows.length < LIMIT;
      if (!U.people.length) U.people = [...new Set(U.rows.flatMap((x) => x.cared_for_names || []))].map((n) => ({ discord_id: '', name: n })).filter(() => false);   // only real ids can filter
    } catch (e) { if (gen === U.gen) U.err = e.message || 'Couldn’t load past patients.'; }
    if (gen === U.gen) { U.busy = false; draw(); }
  }
  async function openCase(id) {
    U.open = id; U.rec = null; U.recErr = ''; draw();
    try { const r = await ctx.rpc('chart_case', { p_id: id }); if (U.open === id) U.rec = r; }
    catch (e) { if (U.open === id) U.recErr = e.hint === 'no_access' ? 'You can only open patients you treated (or your department’s, as a Director).' : e.message; }
    draw();
    setHash(id);
  }

  // ---------- list ----------
  const people = () => U.people.map((p) => (typeof p === 'string' ? { discord_id: p, name: p } : p));
  const activeFilters = () => ['from', 'to', 'outcome', 'person'].filter((k) => F[k]).length;
  const filters = () => `<div class="ph-filters${U.showFilters || !ctx.isPhone() ? ' open' : ''}" role="search">
      <label class="ph-search"><span class="ph-si" aria-hidden="true"></span><input id="ph-q" type="search" value="${esc(F.search)}" placeholder="Search by patient name" autocomplete="off"></label>
      ${ctx.isPhone() ? `<button type="button" class="ph-btn ghost" data-ph="filters" aria-expanded="${U.showFilters}">Filters${activeFilters() ? ` · ${activeFilters()}` : ''}</button>` : ''}
      <div class="ph-more">
        <label><span>From</span><input type="date" id="ph-from" value="${esc(F.from)}"></label>
        <label><span>To</span><input type="date" id="ph-to" value="${esc(F.to)}"></label>
        <label><span>Outcome</span><select id="ph-outcome"><option value="">Any outcome</option>${Object.entries(OUT).filter(([k]) => k !== 'void').map(([k, l]) => `<option value="${k}"${F.outcome === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
        <label><span>Treated by</span><select id="ph-person"><option value="">Anyone</option>${people().map((p) => `<option value="${esc(p.discord_id)}"${F.person === p.discord_id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
        ${activeFilters() || F.search ? '<button type="button" class="ph-btn link" data-ph="clear">Clear</button>' : ''}</div></div>`;
  function row(c) {
    const names = (c.cared_for_names || (c.cared_for || []).map((p) => p.name || p) || []).filter(Boolean);
    const treated = names.length ? names.join(', ') : c.owner_name || '–';
    return `<button type="button" class="ph-row${U.open === c.id ? ' sel' : ''}" data-phcase="${c.id}" style="--u:${urg(c.esi)[2]}">
      <span class="ph-c-when"><b>${esc(clock(c.closed_at || c.discharged_at))}</b><small>${esc(dayLabel(c.closed_at || c.discharged_at))}</small></span>
      <span class="ph-c-who"><b>${esc(c.patient_name || c.short_name)}${c.age ? `<small>, ${esc(c.age)}</small>` : ''}</b>${c.child ? '<em class="ph-tag">Child</em>' : ''}${c.npc ? '<em class="ph-tag">NPC</em>' : ''}</span>
      <span class="ph-c-col">${pill(c.esi)}</span><span class="ph-c-out">${outPill(c.outcome)}</span>
      <span class="ph-c-by">${esc(treated)}</span><span class="ph-c-team">${esc(c.team && c.team !== 'Any' ? c.team : '–')}</span>
      <span class="ph-c-stay">${esc(stay(c.opened_at, c.closed_at || c.discharged_at) || '–')}</span></button>`;
  }
  function list() {
    if (U.err && !U.rows.length) return `<div class="ph-empty"><b>Couldn't load past patients</b><span>${esc(U.err)}</span><button type="button" class="ph-btn" data-ph="retry">Try again</button></div>`;
    if (!U.rows.length && U.busy) return `<div class="ph-skel">${'<i></i>'.repeat(6)}</div>`;
    if (!U.rows.length) return `<div class="ph-empty"><b>${F.search || activeFilters() ? 'No past patients match' : 'No past patients yet'}</b><span>${F.search || activeFilters() ? 'Try a different name or clear the filters.' : 'Patients appear here once their visit has ended.'}</span></div>`;
    return `<div class="ph-head" aria-hidden="true"><span>Closed</span><span>Patient</span><span>Colour</span><span>Outcome</span><span>Treated by</span><span>Team</span><span>Stay</span></div>
      <div class="ph-list">${U.rows.map(row).join('')}</div>
      ${U.done ? `<p class="ph-end">${U.rows.length} patient${U.rows.length === 1 ? '' : 's'}${U.rows.length > LIMIT ? '' : ''}. That's everyone${F.search || activeFilters() ? ' matching' : ''}.</p>`
        : `<button type="button" class="ph-btn ghost ph-moreb" data-ph="more"${U.busy ? ' disabled' : ''}>${U.busy ? 'Loading…' : 'Load more'}</button>`}`;
  }

  // ---------- the read-only record ----------
  function record() {
    if (U.recErr) return `<div class="ph-rec"><div class="ph-rh">${backBtn()}<b>Couldn't open this record</b></div><p class="ph-muted">${esc(U.recErr)}</p></div>`;
    if (!U.rec) return `<div class="ph-rec"><div class="ph-rh">${backBtn()}</div><div class="ph-skel">${'<i></i>'.repeat(5)}</div></div>`;
    const c = U.rec.case || {}, E = U.rec.entries || [], R = U.rec.requests || [], H = U.rec.history || [];
    const live = (k) => E.filter((x) => x.kind === k);
    const struck = (x) => (x.error ? ` class="struck" title="Struck out: ${esc(x.error)}"` : '');
    const by = (x) => `<small>${esc(clock(x.at))}${x.by_name ? ' · ' + esc(x.by_name) : ''}${x.entered_for ? ' (for ' + esc(x.entered_for) + ')' : ''}</small>`;
    const vit = live('vitals'), care = live('intervention'), ord = live('order'), res = live('result'), dx = live('diagnosis'), notes = live('note').concat(live('handoff'));
    const colours = H.filter((h) => h.action === 'colour' || h.action === 'confirm_colour');
    const sect = (title, body) => (body ? `<section class="ph-s"><h4>${title}</h4>${body}</section>` : '');
    const list2 = (xs, f) => (xs.length ? `<ul class="ph-ul">${xs.map((x) => `<li${struck(x)}><span>${f(x)}</span>${by(x)}</li>`).join('')}</ul>` : '');
    const vitTable = vit.length ? `<div class="ph-vt"><table><thead><tr><th>Time</th>${VIT.map(([, l]) => `<th>${l}</th>`).join('')}</tr></thead><tbody>${vit.map((v) => `<tr${struck(v)}><td>${esc(clock(v.at))}</td>${VIT.map(([k, , u]) => `<td>${v.data && v.data[k] != null ? esc(k === 'sys' ? `${v.data.sys}/${v.data.dia ?? '–'}` : v.data[k]) + `<i>${u}</i>` : '–'}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '';
    return `<div class="ph-rec" role="region" aria-label="Record of ${esc(c.patient_name || c.short_name)}">
      <div class="ph-rh" style="--u:${urg(c.esi)[2]}">${backBtn()}<div><h3>${esc(c.patient_name || c.short_name)}${c.age ? `<small>, ${esc(c.age)}</small>` : ''}</h3>
        <p>${pill(c.esi)} ${outPill(c.outcome)} <span class="ph-ro">Read only</span></p>
        <p class="ph-muted">${esc(when(c.opened_at || c.queued_at))} → ${esc(when(c.closed_at || c.discharged_at))}${stay(c.opened_at || c.queued_at, c.closed_at || c.discharged_at) ? ' · ' + esc(stay(c.opened_at || c.queued_at, c.closed_at || c.discharged_at)) : ''}${c.team && c.team !== 'Any' ? ' · ' + esc(c.team) : ''}${c.bed ? ' · ' + esc(c.bed) : ''}</p>
        ${(c.cared_for || []).length ? `<p class="ph-muted">Treated by ${esc(c.cared_for.join(', '))}</p>` : ''}</div></div>
      <div class="ph-body">
        ${sect('Symptoms', (c.symptoms || []).length ? `<div class="ph-tags">${c.symptoms.map((s) => `<span>${esc(s)}</span>`).join('')}</div>` : '<p class="ph-muted">None recorded.</p>')}
        ${sect('About the patient', [c.pain != null ? ['Pain', `${c.pain} of 10`] : null, c.onset ? ['Started', c.onset] : null, c.allergies || c.nkda ? ['Allergies', c.nkda ? 'No known allergies' : c.allergies] : null,
          c.past_history ? ['Medical history', c.past_history] : null, c.care_notes ? ['Care needs', c.care_notes] : null, c.roblox_username ? ['Roblox', '@' + c.roblox_username] : null]
          .filter(Boolean).map(([k, v]) => `<div class="ph-kv"><span>${k}</span><b>${esc(v)}</b></div>`).join(''))}
        ${sect('Vitals', vitTable)}
        ${sect('Care given', list2(care, (x) => esc(x.data && x.data.text)))}
        ${sect('Orders and results', ord.length || res.length ? `${list2(ord, (x) => `${esc(x.data && x.data.text)}${x.data && x.data.who ? ` <em>for ${esc(x.data.who)}</em>` : ''}${x.result ? ` → <b>${esc(x.result)}</b>` : x.done_at ? ' · done' : ' · not done'}`)}${list2(res, (x) => esc(x.data && x.data.text))}` : '')}
        ${sect('Diagnosis', list2(dx, (x) => `<b>${esc(x.data && x.data.text)}</b>`) || (c.diagnosis ? `<p><b>${esc(c.diagnosis)}</b></p>` : ''))}
        ${sect('Requests', R.length ? `<ul class="ph-ul">${R.map((q) => `<li><span><b>${esc({ doctor: 'Doctor', surgery: 'Surgery', imaging: 'Imaging', help: 'Assistance', code: 'Code Blue' }[q.kind] || q.kind)}</b> · asked by ${esc(q.asked_by_name || '')}${q.accepted_by_name ? ` · ${esc(q.accepted_by_name)}` : ''}${q.done_note ? `: “${esc(q.done_note)}”` : q.cancel_reason ? ` · cancelled (${esc(q.cancel_reason)})` : ''}</span><small>${esc(clock(q.asked_at))}</small></li>`).join('')}</ul>` : '')}
        ${sect('Notes', list2(notes, (x) => esc(x.data && x.data.text)))}
        ${sect('Discharge papers', c.outcome ? `<dl class="ph-papers"><dt>Outcome</dt><dd>${esc(OUT[c.outcome] || c.outcome)}</dd>${c.diagnosis ? `<dt>Diagnosis</dt><dd>${esc(c.diagnosis)}</dd>` : ''}${c.advice ? `<dt>Advice</dt><dd>${esc(c.advice)}</dd>` : ''}${c.follow_up ? `<dt>Follow-up</dt><dd>${esc(c.follow_up)}</dd>` : ''}${c.admitted_to ? `<dt>Admitted to</dt><dd>${esc(c.admitted_to)}</dd>` : ''}${c.time_of_death ? `<dt>Time of death</dt><dd>${esc(when(c.time_of_death))}</dd>` : ''}<dt>Papers given</dt><dd>${c.papers ? 'Yes' : 'Not recorded'}</dd></dl>` : '')}
        ${sect('Rating', c.rating ? `<p class="ph-stars" aria-label="${c.rating} of 5">${'★'.repeat(c.rating)}<span>${'★'.repeat(5 - c.rating)}</span> <small>${c.rating_source === 'reception' ? 'given at the front desk' : 'by the patient'}</small></p>` : '<p class="ph-muted">Not rated.</p>')}
        ${sect('Colour history', colours.length ? `<ol class="ph-tl">${colours.map((h) => `<li><time>${esc(clock(h.at))}</time><span>${h.detail && h.detail.from ? `${esc(urg(h.detail.from)[0])} → ` : ''}<b>${esc(urg((h.detail || {}).to || c.esi)[0])}</b>${h.action === 'confirm_colour' ? ' (confirmed)' : ''} · ${esc(h.actor_name || '')}</span></li>`).join('')}</ol>` : '')}
        ${H.length ? `<details class="ph-s ph-timeline"><summary>Full timeline (${H.length})</summary><ol class="ph-tl">${H.map((h) => `<li><time>${esc(clock(h.at))}</time><span>${esc(String(h.action || '').replace(/_/g, ' '))}${h.actor_name ? ' · ' + esc(h.actor_name) : ''}</span></li>`).join('')}</ol></details>` : ''}
      </div></div>`;
  }
  const backBtn = () => `<button type="button" class="ph-x" data-ph="close" aria-label="Back to the list">${ctx.isPhone() ? '‹ Back' : '×'}</button>`;

  // ---------- draw ----------
  function draw() {
    if (!el || !el.isConnected) return;
    const ae = document.activeElement, keepId = ae && el.contains(ae) && ae.id, pos = keepId && ae.selectionStart;
    const phone = ctx.isPhone();
    if (phone && U.open) { el.innerHTML = `<div class="ph phone">${record()}</div>`; return; }
    el.innerHTML = `<div class="ph${phone ? ' phone' : ''}${U.open ? ' with-rec' : ''}"><div class="ph-main"><div class="ph-top"><h2>Chart History</h2><span class="ph-sub">${esc(DEPT)} · ${esc(scope())}</span>${U.rows.length ? `<span class="ph-count">${U.rows.length}${U.done ? '' : '+'}</span>` : ''}</div>
      ${filters()}${list()}</div>${U.open && !phone ? record() : ''}</div>`;
    if (keepId && el.querySelector('#' + CSS.escape(keepId))) { const x = el.querySelector('#' + CSS.escape(keepId)); x.focus(); try { x.setSelectionRange(pos, pos); } catch { /* date/select */ } }
  }

  // ---------- events ----------
  let qT = null;
  const onInput = (ev) => {
    const t = ev.target;
    if (t.id === 'ph-q') { F.search = t.value; clearTimeout(qT); qT = setTimeout(() => load(false), 350); return; }   // search as you type, debounced
  };
  const onChange = (ev) => {
    const k = { 'ph-from': 'from', 'ph-to': 'to', 'ph-outcome': 'outcome', 'ph-team': 'team', 'ph-person': 'person' }[ev.target.id];
    if (k) { F[k] = ev.target.value; load(false); }
  };
  const onClick = (ev) => {
    const b = ev.target.closest('[data-phcase], [data-ph]'); if (!b || !el.contains(b)) return;
    if (b.dataset.phcase) return openCase(+b.dataset.phcase);
    const a = b.dataset.ph;
    if (a === 'more') load(true);
    if (a === 'retry') load(false);
    if (a === 'filters') { U.showFilters = !U.showFilters; draw(); }
    if (a === 'clear') { Object.assign(F, { search: '', from: '', to: '', outcome: '', team: '', person: '' }); load(false); }
    if (a === 'close') { U.open = null; U.rec = null; draw(); setHash(null); }
  };
  const onKey = (ev) => { if (ev.key === 'Escape' && U.open && el) { U.open = null; U.rec = null; draw(); } };

  // Directors and owners see all the department's cases; everyone else the ones they worked on (the server enforces it).
  const leader = () => (typeof dvLeader === 'function' ? dvLeader(DEPT) : !!(window.access && access.exec));
  const scope = () => (leader() ? 'every case in the department' : 'patients you treated');
  const isPhone = () => window.matchMedia('(max-width: 760px)').matches;
  const rpc = async (fn, args) => { const { data, error } = await sb.rpc(fn, args || {}); if (error) { const e = new Error(error.message || 'Something went wrong. Try again.'); e.hint = error.hint; throw e; } return data; };
  let mountedFor = '';
  function unmount() { if (!el) return; el.removeEventListener('input', onInput); el.removeEventListener('change', onChange); el.removeEventListener('click', onClick); document.removeEventListener('keydown', onKey); el = null; }

  window.DEPT_TABS = window.DEPT_TABS || [];
  window.DEPT_TABS.push({
    id: 'chart-history', label: 'Chart History', icon: 'stethoscope',
    // Clinical departments only; members see their own cases, Directors/owners the whole department's.
    show: (dept) => CLINICAL.includes(dept) && ((typeof inMyDept === 'function' && inMyDept(dept)) || (typeof dvLeader === 'function' && dvLeader(dept)) || !!(window.access && access.exec)),
    render(pane, dept, sub) {
      unmount();
      // Draw into our own wrapper: when dept.js swaps the pane to another tab, the wrapper is gone and late replies
      // (a slow page of results) can't paint over that tab.
      pane.innerHTML = '<div class="ph-host"></div>';
      el = pane.firstElementChild; DEPT = dept; ctx = { isPhone, rpc };
      if (mountedFor !== dept) { Object.assign(F, { search: '', from: '', to: '', outcome: '', team: '', person: '' }); U.rows = []; U.people = []; mountedFor = dept; }
      U.open = null; U.rec = null; U.showFilters = false;
      el.addEventListener('input', onInput); el.addEventListener('change', onChange); el.addEventListener('click', onClick); document.addEventListener('keydown', onKey);
      load(false);
      // Everyone who treated a case I may see, for "Treated by" (Bravo's 0092); falls back to names on the loaded rows.
      rpc('chart_history_people').then((ps) => { if (Array.isArray(ps) && ps.length && el) { U.people = ps; draw(); } }, () => {});
      const id = parseInt(String(sub || ''), 10); if (id) openCase(id);
    },
  });
})();
