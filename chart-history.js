// CHART HISTORY (Alpha): "how do we check the history of each chart submitted?" (user, 20 Nov 2026). One per
// clinical department: a department page tab (dept.js DEPT_TABS hook, like Shifts), the department's closed cases
// with search + filters + Load more, and the full record READ-ONLY. Works with nobody on shift. Data:
//   chart_history(p_before_id, p_limit, p_search, p_from, p_to, p_outcome, p_team, p_person)  paged, newest first
//   chart_case(p_id)  the full record, shown here READ-ONLY
// The server decides who sees what (owners all, Directors their department's cases, staff the cases they worked on);
// this tab always asks for its own department (p_team).
// EDITING (0.39.8, user: "if someone says I entered this wrong, or can you delete this"): holders of the department
// permission "Edit chart history" get an Edit mode: amend a detail or an entry (a short reason each time), strike an
// entry, delete the whole record (a reason; it's hidden, never erased). Everyone sees what was amended, by whom and
// why. Owners can show deleted records and restore them. The RPC names live in EDIT below (Bravo's contract).
(() => {
  const EDIT_PERM = 'chart.history_edit';
  // Bravo's 0093 (CONTRACT): every call needs a reason; refusals raise with a hint and a message to show.
  const EDIT = {
    amendCase: (id, field, value, reason) => rpc('chart_history_amend', { p_case: id, p_field: field, p_value: value, p_reason: reason }),
    amendEntry: (id, data, result, reason) => rpc('chart_history_amend_entry', { p_entry: id, p_reason: reason, p_data: data, p_result: result }),
    strike: (id, reason) => rpc('chart_history_strike', { p_entry: id, p_reason: reason }),
    remove: (id, reason) => rpc('chart_history_void', { p_case: id, p_reason: reason }),
    restore: (id, reason) => rpc('chart_history_restore', { p_case: id, p_reason: reason }),
  };
  // The case details a correction may change (0093's fields), in the order they're shown. kind: text | long | num | list | outcome
  const FIELDS = [['diagnosis', 'Diagnosis', 'text'], ['symptoms', 'Symptoms', 'list'], ['pain', 'Pain (1 to 10)', 'num'], ['onset', 'Started', 'text'],
    ['allergies', 'Allergies', 'text'], ['past_history', 'Medical history', 'long'], ['last_intake', 'Last ate or drank', 'text'], ['care_notes', 'Care needs', 'long'],
    ['outcome', 'Outcome', 'outcome'], ['admitted_to', 'Admitted to', 'text'], ['advice', 'Advice', 'long'], ['follow_up', 'Follow-up', 'long']];
  const FIELD_NAME = Object.fromEntries(FIELDS.map(([k, l]) => [k, l]));
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
  const U = { rows: [], people: [], done: false, busy: false, err: '', open: null, rec: null, recErr: '', showFilters: false, gen: 0,
    edit: false, amend: null, strike: null, del: false, saving: false, editErr: '', showDeleted: false, flash: '' };
  const can = (k) => !!(U.rec && U.rec.can && U.rec.can[k]);   // amend, void, restore (from chart_case)
  const canEdit = () => can('amend') || can('void');
  const isOwner = () => !!window.execReal;

  // ---------- data ----------
  async function load(more) {
    if (U.busy && more) return;
    const gen = ++U.gen; U.busy = true; U.err = '';
    if (!more) { U.rows = []; U.done = false; }
    draw();
    try {
      const r = await ctx.rpc('chart_history', { p_before_id: more && U.rows.length ? U.rows[U.rows.length - 1].id : null, p_limit: LIMIT,
        p_search: F.search.trim() || null, p_from: F.from || null, p_to: F.to || null, p_outcome: F.outcome || null, p_team: DEPT || null, p_person: F.person || null, ...(U.showDeleted ? { p_voided: true } : {}) });
      if (gen !== U.gen) return;   // a newer search started
      const rows = Array.isArray(r) ? r : (r && r.rows) || [];
      if (r && r.people) U.people = r.people;
      U.rows = U.rows.concat(rows); U.done = rows.length < LIMIT;
      if (!U.people.length) U.people = [...new Set(U.rows.flatMap((x) => x.cared_for_names || []))].map((n) => ({ discord_id: '', name: n })).filter(() => false);   // only real ids can filter
    } catch (e) { if (gen === U.gen) U.err = e.message || 'Couldn’t load past patients.'; }
    if (gen === U.gen) { U.busy = false; draw(); }
  }
  async function openCase(id, keepEdit) {
    U.open = id; U.rec = null; U.recErr = ''; if (!keepEdit) Object.assign(U, { edit: false, amend: null, strike: null, del: false, editErr: '' }); draw();
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
        ${activeFilters() || F.search ? '<button type="button" class="ph-btn link" data-ph="clear">Clear</button>' : ''}
        ${isOwner() ? `<label class="ph-del-t"><input type="checkbox" id="ph-showdel"${U.showDeleted ? ' checked' : ''}> Show deleted</label>` : ''}</div></div>`;
  function row(c) {
    const names = (c.cared_for_names || (c.cared_for || []).map((p) => p.name || p) || []).filter(Boolean);
    const treated = names.length ? names.join(', ') : c.owner_name || '–';
    return `<button type="button" class="ph-row${U.open === c.id ? ' sel' : ''}${c.voided ? ' deleted' : ''}" data-phcase="${c.id}" style="--u:${urg(c.esi)[2]}">
      <span class="ph-c-when"><b>${esc(clock(c.closed_at || c.discharged_at))}</b><small>${esc(dayLabel(c.closed_at || c.discharged_at))}</small></span>
      <span class="ph-c-who"><b>${esc(c.patient_name || c.short_name)}${c.age ? `<small>, ${esc(c.age)}</small>` : ''}</b>${c.child ? '<em class="ph-tag">Child</em>' : ''}${c.npc ? '<em class="ph-tag">NPC</em>' : ''}${c.voided ? `<em class="ph-tag del" title="${esc(c.void_reason || '')}">Deleted</em>` : ''}${c.amended ? '<em class="ph-tag amd">Amended</em>' : ''}</span>
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

  // ---------- the record: read-only, with an Edit mode for holders of "Edit chart history" ----------
  const valText = (k, v) => (v == null || v === '' ? '' : k === 'symptoms' ? (Array.isArray(v) ? v.join(', ') : String(v)) : k === 'outcome' ? (OUT[v] || v) : k === 'pain' ? `${v} of 10` : String(v));
  const showVal = (v) => (v == null || v === '' || (Array.isArray(v) && !v.length) ? '<em class="ph-none">empty</em>' : esc(Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? (v.text ?? JSON.stringify(v)) : v));
  const reasonBox = (ph) => `<label class="ph-reason"><span>Reason <em>needed, shown on the record</em></span><input id="ph-why" maxlength="200" placeholder="${esc(ph || 'e.g. typed in the wrong patient')}" autocomplete="off"></label>`;
  const editErr = () => (U.editErr ? `<p class="ph-err" role="alert">${esc(U.editErr)}</p>` : '');
  const formBtns = (go, label, danger) => `<div class="ph-fbtns"><button type="button" class="ph-btn${danger ? ' danger' : ''}" data-ph="${go}"${U.saving ? ' disabled' : ''}>${U.saving ? 'Saving…' : label}</button><button type="button" class="ph-btn ghost" data-ph="cancelform">Cancel</button></div>`;
  function fieldForm(k, kind, v) {
    const cur = k === 'symptoms' ? (v || []).join(', ') : v ?? '';
    const input = kind === 'outcome' ? `<select id="ph-val">${Object.entries(OUT).filter(([o]) => o !== 'void').map(([o, l]) => `<option value="${o}"${o === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`
      : kind === 'long' ? `<textarea id="ph-val" rows="2" maxlength="500">${esc(cur)}</textarea>`
      : kind === 'num' ? `<input id="ph-val" type="number" min="1" max="10" value="${esc(cur)}">`
      : `<input id="ph-val" value="${esc(cur)}" maxlength="300" autocomplete="off"${kind === 'list' ? ' placeholder="Separate with commas"' : ''}>`;
    return `<div class="ph-form"><label><span>New ${esc(FIELD_NAME[k].toLowerCase())}</span>${input}</label>${reasonBox()}${editErr()}${formBtns('saveamend', 'Save correction')}</div>`;
  }
  function entryForm(x) {
    const isOrder = x.kind === 'order';
    return `<div class="ph-form"><label><span>Corrected text</span><textarea id="ph-val" rows="2" maxlength="500">${esc((x.data && x.data.text) || '')}</textarea></label>
      ${isOrder ? `<label><span>Result</span><input id="ph-res" value="${esc(x.result || '')}" maxlength="300" autocomplete="off" placeholder="optional"></label>` : ''}${reasonBox()}${editErr()}${formBtns('saveentry', 'Save correction')}</div>`;
  }
  const strikeForm = () => `<div class="ph-form">${reasonBox('e.g. entered on the wrong patient')}${editErr()}${formBtns('savestrike', 'Strike it out', true)}</div>`;

  function record() {
    if (U.recErr) return `<div class="ph-rec"><div class="ph-rh">${backBtn()}<b>Couldn't open this record</b></div><p class="ph-muted">${esc(U.recErr)}</p></div>`;
    if (!U.rec) return `<div class="ph-rec"><div class="ph-rh">${backBtn()}</div><div class="ph-skel">${'<i></i>'.repeat(5)}</div></div>`;
    const c = U.rec.case || {}, E = U.rec.entries || [], R = U.rec.requests || [], H = U.rec.history || [];
    const ed = U.edit && canEdit() && !c.voided_at;
    const live = (k) => E.filter((x) => x.kind === k);
    const struck = (x) => (x.error ? ` class="struck" title="Struck out: ${esc(x.error)}"` : '');
    const by = (x) => `<small>${esc(clock(x.at))}${x.by_name ? ' · ' + esc(x.by_name) : ''}${x.entered_for ? ' (for ' + esc(x.entered_for) + ')' : ''}</small>`;
    const amdMark = (x) => (x.amended ? `<small class="ph-amd">Amended by ${esc(x.amended.by_name || 'someone')}: ${esc(x.amended.reason || '')}</small>` : '')
      + (x.error ? `<small class="ph-amd struck-why">Struck out: ${esc(x.error)}</small>` : '');
    const acts = (x, text) => (!ed || x.error || !can('amend') ? '' : `<span class="ph-eacts">${text ? `<button type="button" class="ph-btn link" data-phamend-entry="${x.id}">Amend</button>` : ''}<button type="button" class="ph-btn link warn" data-phstrike="${x.id}">Strike</button></span>`);
    const entryLi = (x, f, text = true) => `<li${struck(x)}><div class="ph-li"><span>${f(x)}</span>${by(x)}</div>${amdMark(x)}${acts(x, text)}
      ${U.amend && U.amend.entry === x.id ? entryForm(x) : ''}${U.strike === x.id ? strikeForm() : ''}</li>`;
    const vit = live('vitals'), care = live('intervention'), ord = live('order'), res = live('result'), dx = live('diagnosis'), notes = live('note').concat(live('handoff'));
    const colours = H.filter((h) => h.action === 'colour' || h.action === 'confirm_colour');
    const fixes = H.filter((h) => ['amend', 'amend_entry', 'entry_error', 'void', 'restore'].includes(h.action));
    const sect = (title, body) => (body ? `<section class="ph-s"><h4>${title}</h4>${body}</section>` : '');
    const list2 = (xs, f, text) => (xs.length ? `<ul class="ph-ul">${xs.map((x) => entryLi(x, f, text)).join('')}</ul>` : '');
    const vitTable = vit.length ? `<div class="ph-vt"><table><thead><tr><th>Time</th>${VIT.map(([, l]) => `<th>${l}</th>`).join('')}${ed ? '<th></th>' : ''}</tr></thead><tbody>${vit.map((v) => `<tr${struck(v)}><td>${esc(clock(v.at))}</td>${VIT.map(([k, , u]) => `<td>${v.data && v.data[k] != null ? esc(k === 'sys' ? `${v.data.sys}/${v.data.dia ?? '–'}` : v.data[k]) + `<i>${u}</i>` : '–'}</td>`).join('')}${ed ? `<td>${v.error ? '' : `<button type="button" class="ph-btn link warn" data-phstrike="${v.id}">Strike</button>`}</td>` : ''}</tr>`).join('')}</tbody></table></div>${vit.some((v) => U.strike === v.id) ? strikeForm() : ''}${vit.filter((v) => v.error || v.amended).map((v) => `<p class="ph-muted ph-small">${esc(clock(v.at))} set: ${v.error ? `struck out: ${esc(v.error)}` : `amended by ${esc(v.amended.by_name)}: ${esc(v.amended.reason)}`}</p>`).join('')}` : '';
    const fixLine = (h) => { const d = h.detail || {};
      const what = h.action === 'amend' ? `${esc(FIELD_NAME[d.field] || d.field)} changed from ${showVal(d.old)} to ${showVal(d.new)}`
        : h.action === 'amend_entry' ? `An entry was corrected${d.old && d.old.data && d.old.data.text ? ` (was “${esc(d.old.data.text)}”)` : ''}`
        : h.action === 'entry_error' ? 'An entry was struck out' : h.action === 'void' ? 'The record was deleted' : 'The record was restored';
      return `<li><time>${esc(when(h.at))}</time><span>${what}${d.reason ? ` · <b>“${esc(d.reason)}”</b>` : ''}${h.actor_name ? ' · ' + esc(h.actor_name) : ''}</span></li>`; };
    const voidH = [...H].reverse().find((h) => h.action === 'void');
    return `<div class="ph-rec${ed ? ' editing' : ''}${c.voided_at ? ' voided' : ''}" role="region" aria-label="Record of ${esc(c.patient_name || c.short_name)}">
      <div class="ph-rh" style="--u:${urg(c.esi)[2]}">${backBtn()}<div><h3>${esc(c.patient_name || c.short_name)}${c.age ? `<small>, ${esc(c.age)}</small>` : ''}</h3>
        <p>${pill(c.esi)} ${outPill(c.outcome)} ${ed ? '<span class="ph-ro edit">Editing</span>' : '<span class="ph-ro">Read only</span>'}
          ${canEdit() && !c.voided_at ? `<button type="button" class="ph-btn ${ed ? '' : 'ghost'} ph-editb" data-ph="edit" aria-pressed="${ed}">${ed ? 'Done editing' : 'Edit'}</button>` : ''}</p>
        <p class="ph-muted">${esc(when(c.opened_at || c.queued_at))} → ${esc(when(c.closed_at || c.discharged_at))}${stay(c.opened_at || c.queued_at, c.closed_at || c.discharged_at) ? ' · ' + esc(stay(c.opened_at || c.queued_at, c.closed_at || c.discharged_at)) : ''}${c.team && c.team !== 'Any' ? ' · ' + esc(c.team) : ''}${c.bed ? ' · ' + esc(c.bed) : ''}</p>
        ${(c.cared_for || []).length ? `<p class="ph-muted">Treated by ${esc(c.cared_for.join(', '))}</p>` : ''}</div></div>
      ${U.flash ? `<p class="ph-flash" role="status">${esc(U.flash)}</p>` : ''}
      ${c.voided_at ? `<div class="ph-voided"><b>Deleted</b><span>${voidH ? `by ${esc(voidH.actor_name || 'someone')} · “${esc((voidH.detail || {}).reason || '')}” · ${esc(when(c.voided_at))}` : esc(when(c.voided_at))}. It's hidden from Chart History; only owners can see it.</span>
        ${can('restore') ? (U.del === 'restore' ? `<div class="ph-form">${reasonBox('optional: e.g. deleted by mistake')}${editErr()}${formBtns('saverestore', 'Restore the record')}</div>` : '<button type="button" class="ph-btn" data-ph="restore">Restore</button>') : ''}</div>` : ''}
      ${ed ? '<p class="ph-editnote">You’re editing. Every change needs a short reason, and it’s shown on the record with your name.</p>' : ''}
      <div class="ph-body">
        ${ed && can('amend') ? sect('Correct the details', `<div class="ph-fields">${FIELDS.map(([k, l, kind]) => `<div class="ph-field"><div class="ph-kv"><span>${l}</span><b>${esc(valText(k, k === 'symptoms' ? c.symptoms : c[k])) || '<em class="ph-none">empty</em>'}</b>
          ${U.amend && U.amend.field === k ? '' : `<button type="button" class="ph-btn link" data-phamend="${k}">Amend</button>`}</div>${U.amend && U.amend.field === k ? fieldForm(k, kind, k === 'symptoms' ? c.symptoms : c[k]) : ''}</div>`).join('')}</div>`) : ''}
        ${fixes.length ? sect('Corrections', `<ol class="ph-tl ph-fixes">${fixes.map(fixLine).join('')}</ol>`) : ''}
        ${sect('Symptoms', (c.symptoms || []).length ? `<div class="ph-tags">${c.symptoms.map((x) => `<span>${esc(x)}</span>`).join('')}</div>` : '<p class="ph-muted">None recorded.</p>')}
        ${sect('About the patient', [c.pain != null ? ['Pain', `${c.pain} of 10`] : null, c.onset ? ['Started', c.onset] : null, c.allergies || c.nkda ? ['Allergies', c.nkda ? 'No known allergies' : c.allergies] : null,
          c.past_history ? ['Medical history', c.past_history] : null, c.last_intake ? ['Last ate or drank', c.last_intake] : null, c.care_notes ? ['Care needs', c.care_notes] : null, c.roblox_username ? ['Roblox', '@' + c.roblox_username] : null]
          .filter(Boolean).map(([k, v]) => `<div class="ph-kv"><span>${k}</span><b>${esc(v)}</b></div>`).join(''))}
        ${sect('Vitals', vitTable)}
        ${sect('Care given', list2(care, (x) => esc(x.data && x.data.text)))}
        ${sect('Orders and results', ord.length || res.length ? `${list2(ord, (x) => `${esc(x.data && x.data.text)}${x.data && x.data.who ? ` <em>for ${esc(x.data.who)}</em>` : ''}${x.result ? ` → <b>${esc(x.result)}</b>` : x.done_at ? ' · done' : ' · not done'}`)}${list2(res, (x) => esc(x.data && x.data.text))}` : '')}
        ${sect('Diagnosis', list2(dx, (x) => `<b>${esc(x.data && x.data.text)}</b>`) || (c.diagnosis ? `<p><b>${esc(c.diagnosis)}</b></p>` : ''))}
        ${sect('Requests', R.length ? `<ul class="ph-ul">${R.map((q) => `<li><div class="ph-li"><span><b>${esc({ doctor: 'Doctor', surgery: 'Surgery', imaging: 'Imaging', help: 'Assistance', code: 'Code Blue' }[q.kind] || q.kind)}</b> · asked by ${esc(q.asked_by_name || '')}${q.accepted_by_name ? ` · ${esc(q.accepted_by_name)}` : ''}${q.done_note ? `: “${esc(q.done_note)}”` : q.cancel_reason ? ` · cancelled (${esc(q.cancel_reason)})` : ''}</span><small>${esc(clock(q.asked_at))}</small></div></li>`).join('')}</ul>` : '')}
        ${sect('Notes', list2(notes, (x) => esc(x.data && x.data.text)))}
        ${sect('Discharge papers', c.outcome ? `<dl class="ph-papers"><dt>Outcome</dt><dd>${esc(OUT[c.outcome] || c.outcome)}</dd>${c.diagnosis ? `<dt>Diagnosis</dt><dd>${esc(c.diagnosis)}</dd>` : ''}${c.advice ? `<dt>Advice</dt><dd>${esc(c.advice)}</dd>` : ''}${c.follow_up ? `<dt>Follow-up</dt><dd>${esc(c.follow_up)}</dd>` : ''}${c.admitted_to ? `<dt>Admitted to</dt><dd>${esc(c.admitted_to)}</dd>` : ''}${c.time_of_death ? `<dt>Time of death</dt><dd>${esc(when(c.time_of_death))}</dd>` : ''}<dt>Papers given</dt><dd>${c.papers ? 'Yes' : 'Not recorded'}</dd></dl>` : '')}
        ${sect('Rating', c.rating ? `<p class="ph-stars" aria-label="${c.rating} of 5">${'★'.repeat(c.rating)}<span>${'★'.repeat(5 - c.rating)}</span> <small>${c.rating_source === 'reception' ? 'given at the front desk' : 'by the patient'}</small></p>` : '<p class="ph-muted">Not rated.</p>')}
        ${sect('Colour history', colours.length ? `<ol class="ph-tl">${colours.map((h) => `<li><time>${esc(clock(h.at))}</time><span>${h.detail && h.detail.from ? `${esc(urg(h.detail.from)[0])} → ` : ''}<b>${esc(urg((h.detail || {}).to || c.esi)[0])}</b>${h.action === 'confirm_colour' ? ' (confirmed)' : ''} · ${esc(h.actor_name || '')}</span></li>`).join('')}</ol>` : '')}
        ${H.length ? `<details class="ph-s ph-timeline"><summary>Full timeline (${H.length})</summary><ol class="ph-tl">${H.map((h) => `<li><time>${esc(clock(h.at))}</time><span>${esc(String(h.action || '').replace(/_/g, ' '))}${h.actor_name ? ' · ' + esc(h.actor_name) : ''}</span></li>`).join('')}</ol></details>` : ''}
        ${ed && can('void') ? `<section class="ph-s ph-danger"><h4>Delete this record</h4>${U.del === true
          ? `<p>The record will be hidden from Chart History for everyone. Nothing is erased: owners can still see it and restore it.</p>${reasonBox('e.g. a test patient, or a duplicate of another visit')}${editErr()}${formBtns('savedelete', 'Delete this record', true)}`
          : '<p class="ph-muted">For a record that should not be here at all, such as a test patient or a duplicate.</p><button type="button" class="ph-btn danger ghost" data-ph="delete">Delete this record…</button>'}</section>` : ''}
      </div></div>`;
  }
  const backBtn = () => `<button type="button" class="ph-x" data-ph="close" aria-label="Back to the list">${ctx.isPhone() ? '‹ Back' : '×'}</button>`;

  // ---------- draw ----------
  function draw() {
    if (!el || !el.isConnected) return;
    const ae = document.activeElement, keepId = ae && el.contains(ae) && ae.id, pos = keepId && ae.selectionStart;
    // Keep what's typed in an open correction form across redraws (Saving…, an error message).
    const typed = Object.fromEntries([...el.querySelectorAll('#ph-val, #ph-res, #ph-why')].map((x) => [x.id, x.value]));
    const phone = ctx.isPhone();
    const restore = () => { Object.entries(typed).forEach(([id, v]) => { const x = el.querySelector('#' + id); if (x) x.value = v; });
      if (keepId && el.querySelector('#' + CSS.escape(keepId))) { const x = el.querySelector('#' + CSS.escape(keepId)); x.focus(); try { x.setSelectionRange(pos, pos); } catch { /* date/select */ } } };
    if (phone && U.open) { el.innerHTML = `<div class="ph phone">${record()}</div>`; restore(); return; }
    el.innerHTML = `<div class="ph${phone ? ' phone' : ''}${U.open ? ' with-rec' : ''}"><div class="ph-main"><div class="ph-top"><h2>Chart History</h2><span class="ph-sub">${esc(DEPT)} · ${esc(scope())}</span>${U.rows.length ? `<span class="ph-count">${U.rows.length}${U.done ? '' : '+'}</span>` : ''}</div>
      ${filters()}${list()}</div>${U.open && !phone ? record() : ''}</div>`;
    restore();
  }

  // ---------- events ----------
  let qT = null;
  const onInput = (ev) => {
    const t = ev.target;
    if (t.id === 'ph-q') { F.search = t.value; clearTimeout(qT); qT = setTimeout(() => load(false), 350); return; }   // search as you type, debounced
  };
  const onChange = (ev) => {
    if (ev.target.id === 'ph-showdel') { U.showDeleted = ev.target.checked; load(false); return; }
    const k = { 'ph-from': 'from', 'ph-to': 'to', 'ph-outcome': 'outcome', 'ph-team': 'team', 'ph-person': 'person' }[ev.target.id];
    if (k) { F[k] = ev.target.value; load(false); }
  };
  // ---------- editing ----------
  const why = () => ((el.querySelector('#ph-why') || {}).value || '').trim();
  async function save(fn, after) {
    if (U.saving) return;
    U.saving = true; U.editErr = ''; draw();
    try { await fn(); U.saving = false; Object.assign(U, { amend: null, strike: null, del: false, flash: after }); await openCase(U.open, true); setTimeout(() => { if (U.flash === after) { U.flash = ''; draw(); } }, 4000); }
    catch (e) { U.saving = false; U.editErr = e.message || 'That didn’t save. Try again.'; draw(); el.querySelector('#ph-why')?.focus(); }
  }
  const needWhy = () => { if (why().length >= 3) return true; U.editErr = 'Say why in a few words: it’s shown on the record.'; draw(); el.querySelector('#ph-why')?.focus(); return false; };
  function parseVal(k) {
    const raw = ((el.querySelector('#ph-val') || {}).value ?? '').trim(), kind = (FIELDS.find((f) => f[0] === k) || [])[2];
    if (kind === 'list') return raw ? raw.split(',').map((x) => x.trim()).filter(Boolean) : [];
    if (kind === 'num') return raw === '' ? null : Number(raw);
    return raw === '' ? null : raw;
  }
  const onEditClick = (b) => {
    const d = b.dataset, c = (U.rec && U.rec.case) || {};
    if (d.phamend) { Object.assign(U, { amend: { field: d.phamend }, strike: null, del: false, editErr: '' }); draw(); el.querySelector('#ph-val')?.focus(); return true; }
    if (d.phamendEntry) { Object.assign(U, { amend: { entry: +d.phamendEntry }, strike: null, del: false, editErr: '' }); draw(); el.querySelector('#ph-val')?.focus(); return true; }
    if (d.phstrike) { Object.assign(U, { strike: +d.phstrike, amend: null, del: false, editErr: '' }); draw(); el.querySelector('#ph-why')?.focus(); return true; }
    const a = d.ph;
    if (a === 'edit') { Object.assign(U, { edit: !U.edit, amend: null, strike: null, del: false, editErr: '' }); draw(); return true; }
    if (a === 'cancelform') { Object.assign(U, { amend: null, strike: null, del: false, editErr: '' }); draw(); return true; }
    if (a === 'saveamend' && needWhy()) { const k = U.amend.field; save(() => EDIT.amendCase(c.id, k, parseVal(k), why()), `${FIELD_NAME[k]} corrected.`); return true; }
    if (a === 'saveentry' && needWhy()) { const x = (U.rec.entries || []).find((e) => e.id === U.amend.entry) || {};
      const data = { ...(x.data || {}), text: ((el.querySelector('#ph-val') || {}).value || '').trim() }, res = el.querySelector('#ph-res');
      save(() => EDIT.amendEntry(x.id, data, res ? res.value.trim() || null : null, why()), 'Entry corrected.'); return true; }
    if (a === 'savestrike' && needWhy()) { const id = U.strike; save(() => EDIT.strike(id, why()), 'Entry struck out.'); return true; }
    if (a === 'delete') { Object.assign(U, { del: true, amend: null, strike: null, editErr: '' }); draw(); el.querySelector('#ph-why')?.focus(); return true; }
    if (a === 'savedelete' && needWhy()) {
      const id = c.id, r = why(); U.saving = true; U.editErr = ''; draw();
      EDIT.remove(id, r).then(() => { U.saving = false; Object.assign(U, { open: null, rec: null, edit: false, del: false, flash: '' }); setHash(null); load(false); },
        (e) => { U.saving = false; U.editErr = e.message; draw(); });
      return true; }
    if (a === 'restore') { Object.assign(U, { del: 'restore', editErr: '' }); draw(); return true; }
    if (a === 'saverestore') { const r = why(); save(() => EDIT.restore(c.id, r || null), 'Record restored.').then(() => load(false)); return true; }
    return ['saveamend', 'saveentry', 'savestrike', 'savedelete'].includes(a);   // a missing reason: the message is already shown
  };
  const onClick = (ev) => {
    const b = ev.target.closest('[data-phcase], [data-ph], [data-phamend], [data-phamend-entry], [data-phstrike]'); if (!b || !el.contains(b)) return;
    if (b.dataset.phcase) return openCase(+b.dataset.phcase);
    if (onEditClick(b)) return;
    const a = b.dataset.ph;
    if (a === 'more') load(true);
    if (a === 'retry') load(false);
    if (a === 'filters') { U.showFilters = !U.showFilters; draw(); }
    if (a === 'clear') { Object.assign(F, { search: '', from: '', to: '', outcome: '', team: '', person: '' }); load(false); }
    if (a === 'close') { U.open = null; U.rec = null; draw(); setHash(null); }
  };
  const onKey = (ev) => { if (ev.key !== 'Escape' || !U.open || !el) return;
    if (U.amend || U.strike || U.del) { Object.assign(U, { amend: null, strike: null, del: false, editErr: '' }); draw(); return; }   // Esc closes a form first
    U.open = null; U.rec = null; draw(); };

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
