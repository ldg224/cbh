// CBH Chart v1 (Delta; owner approved option C + a sidebar item, 18 Nov 2026; design
// https://claude.ai/artifact/Ke52eeo3CsZCFiz7iwEZZ7). A quick patient log: one shared Case per visit that every
// department adds entries to. Screens: #chart (Cases), #chart/new (quick log), #chart/case/<id>, #chart/cosign.
// Back end: Alpha's RPCs (migrations 0062–0064, contract in Plans/CareBeyond/chart/CONTRACT.md). The database decides
// who reads, writes, sets the ESI and cosigns; this file only draws what chart_me() and chart_get().can allow.
// Everything lives in this closure; the only globals it adds are LIVE.chart and window.chartNav / chartLogBtn /
// chartTab (sidebar, shift card and phone tab hooks used by desk.js and home.js).
(() => {
  const api = async (fn, args) => {
    const { data, error } = await sb.rpc(fn, args || {});
    if (error) throw new Error(error.message || 'Something went wrong. Try again.');
    return data;
  };
  let ME = null, CAT = null, QUEUE = null, deskData = null, flash = '';
  const ESI_C = { 1: ['#b42318', '#fde2e0'], 2: ['#c4320a', '#ffe4d6'], 3: ['#8a5a00', '#fff1cc'], 4: ['#0e6b3a', '#ddf7ea'], 5: ['#22579f', '#e3eefb'] };
  const DEPT_C = { Nursing: '#ff3d7e', Paramedicine: '#ff5533', Medical: '#2f7af2', Surgical: '#229147' };
  const deptColor = (d) => (typeof DEPARTMENTS !== 'undefined' && DEPARTMENTS.find((x) => x.name === d)?.color) || DEPT_C[d] || '#55688c';
  const ago = (iso) => {
    if (!iso) return '';
    const m = Math.round((Date.now() - new Date(iso)) / 6e4);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    if (m < 60 * 24) return Math.floor(m / 60) + ' h ago';
    return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  };
  const hhmm = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const esiBadge = (n, big) => n
    ? `<span class="cx-esi${big ? ' big' : ''}" style="--fg:${ESI_C[n][0]};--bg:${ESI_C[n][1]}" title="ESI ${n}">${n}</span>`
    : `<span class="cx-esi none${big ? ' big' : ''}" title="ESI not set yet">–</span>`;
  const label = (list, id) => (CAT?.[list] || []).find((x) => x.id === id)?.label || id;
  const vitalsLine = (v) => {
    if (!v) return '';
    const p = [];
    if (v.hr != null) p.push(`HR ${v.hr}`);
    if (v.sbp != null) p.push(`BP ${v.sbp}${v.dbp != null ? '/' + v.dbp : ''}`);
    if (v.rr != null) p.push(`RR ${v.rr}`);
    if (v.spo2 != null) p.push(`SpO₂ ${v.spo2}%`);
    if (v.temp_f != null) p.push(`${v.temp_f}°F`);
    if (v.glucose != null) p.push(`Glucose ${v.glucose}`);
    if (v.pain != null) p.push(`Pain ${v.pain}/10`);
    if (v.avpu) p.push(`AVPU ${v.avpu}`);
    return p.join(' · ');
  };
  // Danger-zone vitals for the ESI helper (adult cut-offs from the ESI handbook; a hint only).
  const danger = (v) => v && ((v.hr != null && v.hr > 100) || (v.rr != null && v.rr > 20) || (v.spo2 != null && v.spo2 < 92));

  async function loadMe(force) {
    if (ME && !force) return ME;
    try { ME = await api('chart_me'); } catch { ME = { can_read: false, can_write: false, departments: [] }; }
    const page = PAGES.find((p) => p.id === 'chart');
    if (page) access.chart = !!ME.can_read;
    return ME;
  }
  async function loadCat() {
    if (!CAT) CAT = await api('chart_catalog');
    return CAT;
  }
  async function loadQueue() {
    try { QUEUE = ME?.can_write ? await api('chart_cosign_queue') : []; } catch { QUEUE = []; }
    return QUEUE;
  }
  const waiting = () => ME?.cosign_waiting ?? QUEUE?.length ?? 0;   // chart_me().cosign_waiting (Alpha)

  // ---------- registration (no edits to app.js) ----------
  PAGES.push({ id: 'chart', aud: 'chart', title: 'CBH Chart', icon: 'stethoscope', layout: 'chart' });
  if (typeof TOOL_FOLDER === 'object') TOOL_FOLDER.chart = 'operations';
  const deskDraw = window.deskDraw;
  if (deskDraw) {
    window.deskDraw = async (d) => {
      deskData = d;
      if (ME) access.chart = !!ME.can_read;   // setAccess() just rebuilt `access`; keep the page open while we re-check
      const done = deskDraw(d);
      await loadMe(true);
      window.deskRefresh?.();
      // The first route() ran before chart_me() answered, so a #chart link fell back to Home: route again.
      if (location.hash.startsWith('#chart') && ME.can_read && $('page').hidden) route();
      return done;
    };
  }
  // Sidebar: "CBH Chart" for anyone who can read cases (clinical staff, Administration, owners), with the cosign count.
  window.chartNav = (link) => ME?.can_read ? link({ href: '#chart', label: 'CBH Chart', icon: 'stethoscope', n: waiting() || 0 }) : '';
  // Shift card and Home shift bar, while clocked in.
  window.chartLogBtn = (where) => ME?.can_write ? `<a class="cx-logbtn cx-logbtn-${where}" href="#chart/new"><span aria-hidden="true">+</span> Log a patient</a>` : '';
  // Phone bottom tabs: a raised + in the middle while on shift.
  window.chartTab = () => ME?.can_write ? `<a class="cx-fab" href="#chart/new" aria-label="Log a patient"><span class="cx-fab-b" aria-hidden="true">+</span><span>Log</span></a>` : '';

  function setHead(title, back) {
    setPageTitle('stethoscope', title, 'staff');
    document.title = title + ' · CareBeyond';
    const b = $('page').querySelector('.back');
    if (b) { b.href = back ? '#chart' : '#'; b.lastChild.textContent = back ? 'Cases' : 'Home'; }
  }
  const failBox = (msg) => `<p class="error cx-err" role="alert">${esc(msg)}</p>`;

  LIVE.chart = async (body) => {
    const [, sub, id] = location.hash.slice(1).split('/');
    body.innerHTML = '<p class="muted">Loading…</p>';
    try { await Promise.all([loadMe(), loadCat()]); } catch (e) { body.innerHTML = failBox(e.message); return; }
    if (!ME.can_read) { setHead('CBH Chart'); body.innerHTML = '<div class="card"><p>The CBH Chart is for clinical staff: Nursing, Paramedicine, Medical and Surgical.</p></div>'; return; }
    if (sub === 'new') return drawNew(body);
    if (sub === 'case' && id) return drawCase(body, Number(id));
    if (sub === 'cosign') return drawQueue(body);
    return drawList(body);
  };

  // ================= Cases =================
  const LIST = { status: 'open', mine: false, session: false, dept: '', q: '' };
  async function drawList(body) {
    setHead('CBH Chart');
    await loadQueue();
    const n = waiting();
    body.innerHTML = `<div class="cx-top">
        <div class="cx-filters" role="group" aria-label="Show">
          ${[['open', 'Open'], ['mine', 'Mine'], ['session', 'This session'], ['closed', 'Closed'], ['all', 'All']].map(([k, l]) =>
            `<button type="button" class="chip${isOn(k) ? ' on' : ''}" data-f="${k}" aria-pressed="${isOn(k)}">${l}</button>`).join('')}
        </div>
        ${ME.can_write ? '<a class="refresh cx-new" href="#chart/new"><span aria-hidden="true">+</span> Log a patient</a>' : ''}
      </div>
      ${n ? `<a class="cx-qbar" href="#chart/cosign"><b>${n}</b> ${n === 1 ? 'entry needs' : 'entries need'} your cosign<span class="cx-go">Review</span></a>` : ''}
      <div class="cx-tools">
        <label class="cx-search"><span class="h-glass" aria-hidden="true"></span><input id="cx-q" type="search" placeholder="Search patient or Roblox name" value="${esc(LIST.q)}" autocomplete="off" aria-label="Search cases"></label>
        <div class="cx-depts">${['', 'Nursing', 'Paramedicine', 'Medical', 'Surgical'].map((d) =>
          `<button type="button" class="chip cx-dchip${LIST.dept === d ? ' on' : ''}" data-d="${d}" style="--c:${d ? deptColor(d) : '#0b1e4a'}" aria-pressed="${LIST.dept === d}">${d ? `<span class="cx-dot"></span>${esc(d)}` : 'All departments'}</button>`).join('')}</div>
      </div>
      ${flash ? `<p class="cx-flash" role="status">${esc(flash)}</p>` : ''}
      <div class="cx-list" id="cx-list"><p class="muted">Loading cases…</p></div>`;
    flash = '';
    body.querySelectorAll('[data-f]').forEach((b) => b.onclick = () => {
      const k = b.dataset.f;
      if (k === 'mine') LIST.mine = !LIST.mine;
      else if (k === 'session') LIST.session = !LIST.session;
      else LIST.status = k;
      drawList(body);
    });
    body.querySelectorAll('[data-d]').forEach((b) => b.onclick = () => { LIST.dept = b.dataset.d; drawList(body); });
    let t;
    body.querySelector('#cx-q').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { LIST.q = e.target.value.trim(); fillList(body.querySelector('#cx-list')); }, 250); };
    fillList(body.querySelector('#cx-list'));
  }
  function isOn(k) { return k === 'mine' ? LIST.mine : k === 'session' ? LIST.session : LIST.status === k; }
  async function fillList(box, before) {
    let rows;
    try {
      rows = await api('chart_list', { status: LIST.status, mine: LIST.mine, session_id: LIST.session ? ME.session_id : null,
        department: LIST.dept || null, q: LIST.q || null, before_id: before || null, lim: 30 });
    } catch (e) { box.innerHTML = failBox(e.message); return; }
    if (!box.isConnected) return;
    if (!before) box.innerHTML = '';
    box.querySelector('.cx-more')?.remove();
    if (!rows.length && !before) {
      box.innerHTML = `<div class="cx-empty"><b>${LIST.q ? 'No cases match that search.' : LIST.session && !ME.session_id ? 'No session is running.' : LIST.status === 'open' ? 'No open cases.' : 'No cases yet.'}</b>
        ${ME.can_write && !LIST.q ? '<a class="ghost small-btn" href="#chart/new">Log a patient</a>' : ''}</div>`;
      return;
    }
    box.insertAdjacentHTML('beforeend', rows.map(caseRow).join(''));
    if (rows.length === 30) {
      const more = document.createElement('button');
      more.type = 'button'; more.className = 'ghost cx-more'; more.textContent = 'Show more';
      more.onclick = () => { more.disabled = true; fillList(box, rows[rows.length - 1].id); };
      box.append(more);
    }
  }
  function caseRow(c) {
    const st = c.status === 'open' ? '<span class="st cx-st open">Open</span>'
      : c.status === 'void' ? '<span class="st cx-st void">Void</span>'
      : `<span class="st cx-st">${esc(label('dispositions', c.disposition) || 'Closed')}</span>`;
    return `<a class="cx-row" href="#chart/case/${c.id}">
        ${esiBadge(c.esi)}
        <span class="cx-rmain"><b>${esc(c.patient_name)}${c.alias ? ' <span class="cx-tag">Unknown</span>' : ''}</b>
          <span class="cx-rsub">${esc(c.complaint_label || '')}${c.latest_vitals ? ' · ' + esc(vitalsLine(c.latest_vitals)) : ''}</span>
          <span class="cx-rmeta"><span class="cx-dot" style="--c:${deptColor(c.department)}"></span>${esc(c.department)} · ${esc(cleanName(c.opened_by_name || ''))} · ${c.entries} ${c.entries === 1 ? 'entry' : 'entries'}${c.pending_cosign ? ` · <span class="cx-cos">${c.pending_cosign} needs cosign</span>` : ''}</span></span>
        <span class="cx-rside">${st}<span class="cx-time">${esc(ago(c.last_at || c.opened_at))}</span></span>
      </a>`;
  }

  // ================= Quick log =================
  async function drawNew(body) {
    setHead('Log a patient', true);
    if (!ME.can_write) { body.innerHTML = '<div class="card"><p>Only clinical staff can log patients. You can read every case.</p></div>'; return; }
    if (!ME.shift_id) return drawClockIn(body);
    const F = { name: '', unknown: false, age: 'Adult', sex: '', roblox: '', showRoblox: false, complaint: '', other: '', arrival: 'walk_in',
      esi: null, vitals: {}, items: new Set(), dept: ME.default_department, sbar: false, s: '', b: '', a: '', r: '', to: '', sbarEdited: false, dispo: '', dnote: '' };
    const depts = ME.departments || [];
    const groups = (list) => { const g = {}; for (const x of list) (g[x.group] = g[x.group] || []).push(x); return g; };
    const allItems = [...(CAT.interventions || []).map((x) => ({ ...x, kind: 'intervention' })), ...(CAT.medications || []).map((x) => ({ ...x, kind: 'medication' }))];
    const itemsById = Object.fromEntries(allItems.map((x) => [x.id, x]));
    const vitals = (CAT.vitals || []).filter((v) => v.key !== 'avpu' && v.key !== 'dbp');
    const avpu = (CAT.vitals || []).find((v) => v.key === 'avpu');
    const myRankHere = () => depts.find((d) => d.name === F.dept);
    const inScope = (it) => ME.owner || (it.scope && myRankHere() && it.scope[F.dept] != null && myRankHere().rank >= it.scope[F.dept]);

    body.innerHTML = `<form class="cx-form" id="cx-form" novalidate>
      <div class="cx-ctx">
        ${depts.length > 1 ? `<span class="cx-ctx-l">Acting for</span>${depts.map((d) => `<button type="button" class="chip cx-dchip${d.name === F.dept ? ' on' : ''}" data-dept="${esc(d.name)}" style="--c:${deptColor(d.name)}"><span class="cx-dot"></span>${esc(d.name)} · ${esc(d.rank_label)}</button>`).join('')}`
          : `<span class="cx-ctx-l"><span class="cx-dot" style="--c:${deptColor(F.dept)}"></span>${esc(F.dept)} · ${esc(depts[0]?.rank_label || '')}</span>`}
        <span class="cx-shiftchip">On shift${ME.session_id ? ' · session running' : ''}</span>
      </div>

      <section class="cx-sec" aria-labelledby="cx-l-pt"><h3 id="cx-l-pt">Patient</h3>
        <div class="cx-name"><input id="cx-name" type="text" maxlength="60" placeholder="Patient name" autocomplete="off" aria-label="Patient name">
          <button type="button" class="chip" id="cx-unknown" aria-pressed="false">Unknown patient</button></div>
        <div class="cx-chips" data-group="age">${(CAT.age_bands || []).map((a) => `<button type="button" class="chip${a === F.age ? ' on' : ''}" data-age="${esc(a)}">${esc(a)}</button>`).join('')}</div>
        <div class="cx-chips" data-group="sex">${(CAT.sexes || []).map((s) => `<button type="button" class="chip" data-sex="${esc(s)}">${esc(s)}</button>`).join('')}
          <button type="button" class="cx-link" id="cx-rbx-t">+ Roblox username</button></div>
        <input id="cx-rbx" type="text" maxlength="40" placeholder="Roblox username" autocomplete="off" aria-label="Roblox username" hidden>
      </section>

      <section class="cx-sec" aria-labelledby="cx-l-cc"><h3 id="cx-l-cc">Chief complaint</h3>
        ${Object.entries(groups(CAT.complaints || [])).map(([g, list]) => `<div class="cx-grp"><span class="cx-gl">${esc(g)}</span><div class="cx-chips">${list.map((c) =>
          `<button type="button" class="chip" data-cc="${esc(c.id)}">${esc(c.label)}${c.in_game === false ? '<span class="cx-rp" title="Roleplay only: not in the game">RP</span>' : ''}</button>`).join('')}</div></div>`).join('')}
        <div class="cx-chips"><button type="button" class="chip" data-cc="__other">Other</button></div>
        <input id="cx-other" type="text" maxlength="120" placeholder="Describe the complaint" aria-label="Other complaint" hidden>
      </section>

      <section class="cx-sec" aria-labelledby="cx-l-ar"><h3 id="cx-l-ar">Arrival</h3>
        <div class="cx-chips">${(CAT.arrivals || []).map((a) => `<button type="button" class="chip${a.id === F.arrival ? ' on' : ''}" data-ar="${esc(a.id)}">${esc(a.label)}</button>`).join('')}</div>
      </section>

      <section class="cx-sec" aria-labelledby="cx-l-esi"><h3 id="cx-l-esi">ESI triage</h3>
        <div class="cx-esirow" role="radiogroup" aria-labelledby="cx-l-esi">${(CAT.esi || []).filter((e) => e && e.level).map((e) =>
          `<button type="button" class="cx-esib" role="radio" aria-checked="false" data-esi="${e.level}" style="--fg:${ESI_C[e.level][0]};--bg:${ESI_C[e.level][1]}"${ME.can_esi ? '' : ' disabled'}><b>${e.level}</b><small>${esc(e.label)}</small></button>`).join('')}</div>
        ${ME.can_esi ? '<button type="button" class="cx-link" id="cx-help">Help me choose</button><div class="cx-helper" id="cx-helper" hidden></div>'
          : '<p class="muted cx-hint">An RN-level colleague sets the ESI.</p>'}
      </section>

      <section class="cx-sec" aria-labelledby="cx-l-v"><h3 id="cx-l-v">Vitals</h3>
        <div class="cx-vit">${vitals.map((v) => `<button type="button" class="cx-vt" data-vk="${v.key}"><small>${v.key === 'sbp' ? 'BP' : esc(v.label)}</small><b id="cx-v-${v.key}">–</b><em>${v.key === 'sbp' ? 'mmHg' : esc(v.unit || '')}</em></button>`).join('')}</div>
        ${avpu ? `<div class="cx-chips cx-avpu"><span class="cx-gl">AVPU</span>${avpu.options.map((o) => `<button type="button" class="chip" data-avpu="${o}">${o}</button>`).join('')}</div>` : ''}
      </section>

      <section class="cx-sec" aria-labelledby="cx-l-i"><h3 id="cx-l-i">Interventions and medicines</h3>
        <label class="cx-search small"><span class="h-glass" aria-hidden="true"></span><input id="cx-ifind" type="search" placeholder="Find an intervention or medicine" autocomplete="off" aria-label="Find an intervention or medicine"></label>
        <div id="cx-items">${Object.entries(groups(allItems)).map(([g, list]) => `<div class="cx-grp" data-ig="${esc(g)}"><span class="cx-gl">${esc(g)}</span><div class="cx-chips">${list.map((it) =>
          `<button type="button" class="chip cx-item" data-it="${esc(it.id)}" data-find="${esc((it.label + ' ' + g).toLowerCase())}">${esc(it.label)}${it.in_game === false ? '<span class="cx-rp" title="Roleplay only: not in the game">RP</span>' : ''}<span class="cx-cosdot" hidden title="Needs a cosign at your rank"></span></button>`).join('')}</div></div>`).join('')}</div>
        <p class="cx-hint" id="cx-coshint" hidden></p>
      </section>

      <section class="cx-sec" aria-labelledby="cx-l-h"><h3 id="cx-l-h">Handoff <em>(SBAR, optional)</em></h3>
        <button type="button" class="cx-link" id="cx-sbar-t">Add a handoff</button>
        <div id="cx-sbar" hidden>
          <div class="cx-chips"><span class="cx-gl">To</span>${['Nursing', 'Paramedicine', 'Medical', 'Surgical'].map((d) => `<button type="button" class="chip cx-dchip" data-to="${d}" style="--c:${deptColor(d)}"><span class="cx-dot"></span>${d}</button>`).join('')}</div>
          <label class="f"><span>Situation</span><textarea id="cx-s" rows="2" maxlength="300"></textarea></label>
          <label class="f"><span>Background</span><textarea id="cx-b" rows="2" maxlength="300"></textarea></label>
          <label class="f"><span>Assessment</span><textarea id="cx-a" rows="2" maxlength="300"></textarea></label>
          <label class="f"><span>Recommendation</span><input id="cx-r" type="text" maxlength="200" placeholder="What should happen next"></label>
        </div>
      </section>

      <section class="cx-sec" aria-labelledby="cx-l-d"><h3 id="cx-l-d">Disposition <em>(closes the case)</em></h3>
        <div class="cx-chips">${(CAT.dispositions || []).map((d) => `<button type="button" class="chip" data-dispo="${esc(d.id)}">${esc(d.label)}</button>`).join('')}</div>
        <p class="muted cx-hint">Leave it empty to keep the case open for others to add to.</p>
      </section>
      <div class="cx-err-slot"></div>
      <div class="cx-savebar"><span class="cx-need" id="cx-need"></span><button type="submit" class="refresh cx-save" id="cx-save">Save case</button></div>
    </form>`;

    const form = body.querySelector('#cx-form');
    const $f = (s) => form.querySelector(s);
    const pick = (sel, attr, val) => form.querySelectorAll(sel).forEach((b) => { const on = b.dataset[attr] === val; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
    const sync = () => {
      const missing = [];
      if (!F.unknown && !F.name.trim()) missing.push('patient');
      if (!F.complaint || (F.complaint === '__other' && !F.other.trim())) missing.push('complaint');
      const cos = [...F.items].filter((id) => !inScope(itemsById[id])).length;
      $f('#cx-need').innerHTML = missing.length ? `Still needs: ${missing.join(', ')}` : cos ? `<span class="cx-cos">${cos} will need a cosign</span>` : F.dispo ? 'Saves and closes the case' : 'Saves an open case';
      $f('#cx-save').disabled = missing.length > 0;
      form.querySelectorAll('.cx-item').forEach((b) => { b.querySelector('.cx-cosdot').hidden = inScope(itemsById[b.dataset.it]); });
      const hint = $f('#cx-coshint');
      hint.hidden = !form.querySelector('.cx-cosdot:not([hidden])');
      hint.innerHTML = '<span class="cx-cosdot"></span> needs a cosign from a senior at your rank. You can still record it.';
      if (F.sbar && !F.sbarEdited) prefillSbar();
    };
    const prefillSbar = () => {
      const cc = F.complaint === '__other' ? F.other : label('complaints', F.complaint);
      $f('#cx-s').value = [F.age && F.age.toLowerCase(), F.sex && F.sex.toLowerCase(), 'patient', cc && `with ${cc}`, F.esi && `ESI ${F.esi}`].filter(Boolean).join(' ').replace(/^./, (c) => c.toUpperCase()) + '.';
      const done = [...F.items].map((id) => itemsById[id]?.label).filter(Boolean);
      $f('#cx-b').value = `Arrived ${({ walk_in: 'as a walk-in', ambulance: 'by ambulance', helicopter: 'by helicopter' })[F.arrival] || ''}.${done.length ? ' Given: ' + done.join(', ') + '.' : ''}`;
      $f('#cx-a').value = vitalsLine(F.vitals) || '';
    };

    form.querySelectorAll('[data-dept]').forEach((b) => b.onclick = () => { F.dept = b.dataset.dept; pick('[data-dept]', 'dept', F.dept); sync(); });
    $f('#cx-name').oninput = (e) => { F.name = e.target.value; sync(); };
    $f('#cx-unknown').onclick = (e) => {
      F.unknown = !F.unknown; e.currentTarget.classList.toggle('on', F.unknown); e.currentTarget.setAttribute('aria-pressed', F.unknown);
      const n = $f('#cx-name'); n.disabled = F.unknown; n.placeholder = F.unknown ? 'Gets a name like “Unknown Alpha-12”' : 'Patient name'; if (F.unknown) n.value = '', F.name = '';
      sync();
    };
    form.querySelectorAll('[data-age]').forEach((b) => b.onclick = () => { F.age = F.age === b.dataset.age ? '' : b.dataset.age; pick('[data-age]', 'age', F.age); sync(); });
    form.querySelectorAll('[data-sex]').forEach((b) => b.onclick = () => { F.sex = F.sex === b.dataset.sex ? '' : b.dataset.sex; pick('[data-sex]', 'sex', F.sex); sync(); });
    $f('#cx-rbx-t').onclick = (e) => { e.currentTarget.hidden = true; const r = $f('#cx-rbx'); r.hidden = false; r.focus(); };
    $f('#cx-rbx').oninput = (e) => { F.roblox = e.target.value.trim(); };
    form.querySelectorAll('[data-cc]').forEach((b) => b.onclick = () => {
      F.complaint = F.complaint === b.dataset.cc ? '' : b.dataset.cc; pick('[data-cc]', 'cc', F.complaint);
      const o = $f('#cx-other'); o.hidden = F.complaint !== '__other'; if (!o.hidden) o.focus();
      sync();
    });
    $f('#cx-other').oninput = (e) => { F.other = e.target.value; sync(); };
    form.querySelectorAll('[data-ar]').forEach((b) => b.onclick = () => { F.arrival = b.dataset.ar; pick('[data-ar]', 'ar', F.arrival); sync(); });
    const setEsi = (n) => { F.esi = F.esi === n ? null : n; form.querySelectorAll('[data-esi]').forEach((b) => { const on = Number(b.dataset.esi) === F.esi; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); }); sync(); };
    form.querySelectorAll('[data-esi]').forEach((b) => b.onclick = () => setEsi(Number(b.dataset.esi)));
    if (ME.can_esi) $f('#cx-help').onclick = () => { const h = $f('#cx-helper'); h.hidden = !h.hidden; if (!h.hidden) esiHelper(h, F, (n) => { F.esi = null; setEsi(n); h.hidden = true; }); };
    form.querySelectorAll('[data-vk]').forEach((b) => b.onclick = () => keypad(b.dataset.vk, F.vitals, vitals, (k) => {
      for (const v of vitals) {
        const el = $f('#cx-v-' + v.key);
        el.textContent = v.key === 'sbp' ? (F.vitals.sbp != null ? `${F.vitals.sbp}/${F.vitals.dbp ?? '–'}` : '–') : (F.vitals[v.key] ?? '–');
        el.closest('.cx-vt').classList.toggle('set', v.key === 'sbp' ? F.vitals.sbp != null : F.vitals[v.key] != null);
      }
      sync();
      return k;
    }));
    form.querySelectorAll('[data-avpu]').forEach((b) => b.onclick = () => { F.vitals.avpu = F.vitals.avpu === b.dataset.avpu ? undefined : b.dataset.avpu; pick('[data-avpu]', 'avpu', F.vitals.avpu); sync(); });
    form.querySelectorAll('[data-it]').forEach((b) => b.onclick = () => {
      const id = b.dataset.it; F.items.has(id) ? F.items.delete(id) : F.items.add(id);
      b.classList.toggle('on', F.items.has(id)); b.setAttribute('aria-pressed', F.items.has(id)); sync();
    });
    $f('#cx-ifind').oninput = (e) => {
      const q = e.target.value.trim().toLowerCase();
      form.querySelectorAll('.cx-item').forEach((b) => { b.hidden = !!q && !b.dataset.find.includes(q) && !b.classList.contains('on'); });
      form.querySelectorAll('[data-ig]').forEach((g) => { g.hidden = ![...g.querySelectorAll('.cx-item')].some((b) => !b.hidden); });
    };
    $f('#cx-sbar-t').onclick = (e) => { e.currentTarget.hidden = true; F.sbar = true; $f('#cx-sbar').hidden = false; prefillSbar(); };
    ['s', 'b', 'a'].forEach((k) => $f('#cx-' + k).oninput = () => { F.sbarEdited = true; });
    form.querySelectorAll('[data-to]').forEach((b) => b.onclick = () => { F.to = F.to === b.dataset.to ? '' : b.dataset.to; pick('[data-to]', 'to', F.to); });
    form.querySelectorAll('[data-dispo]').forEach((b) => b.onclick = () => { F.dispo = F.dispo === b.dataset.dispo ? '' : b.dataset.dispo; pick('[data-dispo]', 'dispo', F.dispo); sync(); });
    form.onsubmit = (e) => { e.preventDefault(); saveNew(form, F, itemsById); };
    sync();
    $f('#cx-name').focus({ preventScroll: true });
  }

  async function saveNew(form, F, itemsById) {
    const btn = form.querySelector('#cx-save'), slot = form.querySelector('.cx-err-slot');
    btn.disabled = true; btn.textContent = 'Saving…'; slot.innerHTML = '';
    // One call, one transaction (Alpha): the case, its entries and the disposition save together or not at all.
    const entries = [];
    const v = Object.fromEntries(Object.entries(F.vitals).filter(([, x]) => x != null && x !== ''));
    if (Object.keys(v).length) entries.push({ kind: 'vitals', data: v });
    for (const it of F.items) entries.push({ kind: itemsById[it].kind, data: { item: it } });
    if (F.sbar) {
      const g = (k) => form.querySelector('#cx-' + k).value.trim();
      if (g('s') || g('b') || g('a') || g('r')) entries.push({ kind: 'handoff', data: { s: g('s'), b: g('b'), a: g('a'), r: g('r'), to: F.to || null } });
    }
    let c;
    try {
      c = await api('chart_open', {
        patient: { name: F.unknown ? null : F.name.trim(), age_band: F.age || null, sex: F.sex || null, roblox_username: F.roblox || null },
        complaint: F.complaint === '__other' ? F.other.trim() : F.complaint, arrival: F.arrival, esi: ME.can_esi ? F.esi : null, department: F.dept,
        entries: entries.length ? entries : null, disposition: F.dispo || null,
      });
    } catch (e) { slot.innerHTML = failBox(e.message); btn.disabled = false; btn.textContent = 'Save case'; slot.scrollIntoView({ block: 'nearest' }); return; }
    const id = c.case?.id ?? c.id;
    flash = F.dispo ? 'Case saved and closed.' : 'Case saved.';
    loadMe(true).then(() => window.deskRefresh?.());
    location.hash = '#chart/case/' + id;
  }

  async function drawClockIn(body) {
    const shiftDepts = (ME.departments || []).map((d) => d.name).filter((d) => myDepartments.includes(d));
    let dept = shiftDepts.includes(ME.default_department) ? ME.default_department : shiftDepts[0];
    body.innerHTML = `<div class="card cx-clock">
        <h3>You're not on shift</h3>
        <p class="muted">Cases attach to your shift. Start one to log a patient.</p>
        ${shiftDepts.length > 1 ? `<div class="cx-chips">${shiftDepts.map((d) => `<button type="button" class="chip cx-dchip${d === dept ? ' on' : ''}" data-sd="${esc(d)}" style="--c:${deptColor(d)}"><span class="cx-dot"></span>${esc(d)}</button>`).join('')}</div>` : ''}
        <div class="cx-row-btns"><button type="button" class="refresh" id="cx-start"${dept ? '' : ' disabled'}>Start shift${dept ? ' in ' + esc(dept) : ''}</button><a class="ghost" href="#chart">Not now</a></div>
        <div class="cx-err-slot"></div></div>`;
    body.querySelectorAll('[data-sd]').forEach((b) => b.onclick = () => { dept = b.dataset.sd; body.querySelectorAll('[data-sd]').forEach((x) => x.classList.toggle('on', x === b)); body.querySelector('#cx-start').textContent = 'Start shift in ' + dept; });
    body.querySelector('#cx-start').onclick = async (e) => {
      e.currentTarget.disabled = true; e.currentTarget.textContent = 'Starting…';
      const { error } = await sb.rpc('shift_start', { department: dept });
      if (error) { body.querySelector('.cx-err-slot').innerHTML = failBox(error.message); e.currentTarget.disabled = false; e.currentTarget.textContent = 'Try again'; return; }
      await loadMe(true);
      if (deskData) window.deskDraw?.(deskData);
      drawNew(body);
    };
  }

  // ---------- ESI A–D helper (ESI v5 handbook, simplified; a suggestion, the nurse decides) ----------
  function esiHelper(box, F, use) {
    const step = (q, yes, no) => `<p class="cx-hq">${q}</p><div class="cx-row-btns">${yes}${no}</div>`;
    const go = (n) => { box.innerHTML = `<p class="cx-hq">Suggested: ${esiBadge(n)} <b>ESI ${n}</b></p>${n === 3 && danger(F.vitals) ? '<p class="cx-hint"><b>D:</b> the vitals are in the danger zone, so consider ESI 2.</p>' : ''}
      <div class="cx-row-btns"><button type="button" class="refresh small-btn" data-use="${n}">Use ESI ${n}</button>${n === 3 && danger(F.vitals) ? '<button type="button" class="ghost small-btn" data-use="2">Use ESI 2</button>' : ''}</div>`;
      box.querySelectorAll('[data-use]').forEach((b) => b.onclick = () => use(Number(b.dataset.use))); };
    const A = () => { box.innerHTML = step('<b>A.</b> Does the patient need a lifesaving action right now?', '<button type="button" class="ghost small-btn" data-a="y">Yes</button>', '<button type="button" class="ghost small-btn" data-a="n">No</button>');
      box.querySelector('[data-a="y"]').onclick = () => go(1); box.querySelector('[data-a="n"]').onclick = B; };
    const B = () => { box.innerHTML = step('<b>B.</b> High-risk situation, new confusion, or severe pain or distress?', '<button type="button" class="ghost small-btn" data-b="y">Yes</button>', '<button type="button" class="ghost small-btn" data-b="n">No</button>');
      box.querySelector('[data-b="y"]').onclick = () => go(2); box.querySelector('[data-b="n"]').onclick = C; };
    const C = () => { box.innerHTML = `<p class="cx-hq"><b>C.</b> How many kinds of resources will they need (labs, imaging, IV fluids or medicines, a procedure)?</p>
      <div class="cx-row-btns"><button type="button" class="ghost small-btn" data-c="5">None</button><button type="button" class="ghost small-btn" data-c="4">One</button><button type="button" class="ghost small-btn" data-c="3">Two or more</button></div>`;
      box.querySelectorAll('[data-c]').forEach((b) => b.onclick = () => go(Number(b.dataset.c))); };
    A();
  }

  // ---------- vitals keypad (bottom sheet on phones, small panel on computers) ----------
  function keypad(start, V, list, onChange) {
    document.querySelector('.cx-pad')?.remove();
    const keys = list.map((v) => v.key);
    let k = start, buf = '', dia = false;
    const meta = (key) => (CAT.vitals || []).find((v) => v.key === key) || {};
    const pad = document.createElement('div');
    pad.className = 'cx-pad'; pad.setAttribute('role', 'dialog'); pad.setAttribute('aria-label', 'Enter vitals');
    const show = () => {
      const m = meta(k), bp = k === 'sbp';
      const cur = bp ? `${dia ? (V.sbp ?? '') + '/' : ''}${buf || (!dia && V.sbp != null ? V.sbp : '')}` : buf || (V[k] ?? '');
      pad.innerHTML = `<div class="cx-pad-h"><b>${bp ? 'Blood pressure' : esc(m.label)}</b><span class="cx-pad-v" aria-live="polite">${esc(String(cur)) || '<span class="muted">–</span>'}<em>${bp ? 'mmHg' : esc(m.unit || '')}</em></span></div>
        <p class="cx-pad-err" id="cx-pad-err"></p>
        <div class="cx-pad-k">${['1', '2', '3', '4', '5', '6', '7', '8', '9', bp ? '/' : (k === 'temp_f' ? '.' : ''), '0', '⌫'].map((x) => x ? `<button type="button" data-key="${x}">${x === '⌫' ? '<span aria-label="Delete">⌫</span>' : x}</button>` : '<span></span>').join('')}</div>
        <div class="cx-pad-f"><button type="button" class="ghost" data-pad="clear">Clear</button><button type="button" class="ghost" data-pad="done">Done</button><button type="button" class="refresh" data-pad="next">${keys.indexOf(k) < keys.length - 1 ? 'Next' : 'Done'}</button></div>`;
    };
    const commit = () => {
      if (!buf) return true;
      const key = k === 'sbp' && dia ? 'dbp' : k, m = meta(key), n = Number(buf);
      if (Number.isNaN(n) || (m.min != null && n < m.min) || (m.max != null && n > m.max)) { pad.querySelector('#cx-pad-err').textContent = `${m.label} is ${m.min}–${m.max}${m.unit ? ' ' + m.unit : ''}.`; return false; }
      V[key] = n; buf = ''; onChange(k); return true;
    };
    pad.onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.key) {
        const x = b.dataset.key;
        if (x === '⌫') buf = buf.slice(0, -1);
        else if (x === '/') { if (commit()) dia = true; }
        else if (x === '.' ? !buf.includes('.') : buf.length < 5) buf += x;
        show(); return;
      }
      if (b.dataset.pad === 'clear') { if (k === 'sbp') { delete V.sbp; delete V.dbp; dia = false; } else delete V[k]; buf = ''; onChange(k); show(); return; }
      if (!commit()) return;
      if (b.dataset.pad === 'next' && keys.indexOf(k) < keys.length - 1) {
        if (k === 'sbp' && !dia && V.sbp != null) { dia = true; show(); return; }
        k = keys[keys.indexOf(k) + 1]; dia = false; show(); return;
      }
      close();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { close(); return; }
      if (/^[0-9]$/.test(e.key) || e.key === '.' || e.key === '/' || e.key === 'Backspace') { e.preventDefault(); pad.querySelector(`[data-key="${e.key === 'Backspace' ? '⌫' : e.key}"]`)?.click(); }
      if (e.key === 'Enter') { e.preventDefault(); pad.querySelector('[data-pad="next"]').click(); }
    };
    const close = () => { pad.remove(); document.removeEventListener('keydown', onKey); document.querySelector(`[data-vk="${start}"]`)?.focus(); };
    document.addEventListener('keydown', onKey);
    show();
    document.body.append(pad);
    pad.querySelector('[data-pad="next"]').focus();
  }

  // ================= One case =================
  async function drawCase(body, id) {
    setHead('Case', true);
    let C;
    try { [C] = await Promise.all([api('chart_get', { case_id: id }), loadQueue()]); } catch (e) { body.innerHTML = failBox(e.message); return; }
    if (!body.isConnected) return;
    const c = C.case, can = C.can || {}, open = c.status === 'open';
    const mine = new Set((QUEUE || []).map((q) => q.entry_id));
    setHead(`Case #${c.id}`, true);
    document.title = (c.patient?.name || 'Case') + ' · CareBeyond';
    const pt = c.patient || {};
    body.innerHTML = `${flash ? `<p class="cx-flash${/didn't save/.test(flash) ? ' warn' : ''}" role="status">${esc(flash)}</p>` : ''}
      <div class="card cx-head">
        <div class="cx-head-l">${esiBadge(c.esi, true)}
          <div><div class="cx-pname">${esc(pt.name)}${pt.alias ? ' <span class="cx-tag">Unknown</span>' : ''}</div>
            <div class="cx-psub">${[pt.age_band, pt.sex, pt.roblox_username && '@' + pt.roblox_username].filter(Boolean).map(esc).join(' · ')}</div>
            <div class="cx-psub"><b>${esc(c.complaint_label || c.complaint)}</b> · ${esc(label('arrivals', c.arrival))}</div></div></div>
        <div class="cx-head-r">${c.status === 'open' ? '<span class="st cx-st open">Open</span>' : c.status === 'void' ? '<span class="st cx-st void">Void</span>' : `<span class="st cx-st">${esc(label('dispositions', c.disposition))}</span>`}
          ${c.pending_cosign ? `<span class="cx-cos">${c.pending_cosign} needs cosign</span>` : ''}
          <span class="cx-meta"><span class="cx-dot" style="--c:${deptColor(c.department)}"></span>${esc(c.department)} · opened by ${esc(cleanName(c.opened_by_name || ''))} · ${esc(hhmm(c.opened_at))}</span></div>
        ${c.latest_vitals ? `<div class="cx-lv"><span class="cx-gl">Latest vitals · ${esc(hhmm(c.latest_vitals.at))}</span>${esc(vitalsLine(c.latest_vitals))}${danger(c.latest_vitals) ? ' <span class="cx-warn">Danger zone</span>' : ''}</div>` : ''}
        ${open && can.esi ? `<div class="cx-esiset"><span class="cx-gl">${c.esi ? 'Change ESI' : 'Set ESI'}</span>${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="cx-esib mini${c.esi === n ? ' on' : ''}" data-setesi="${n}" style="--fg:${ESI_C[n][0]};--bg:${ESI_C[n][1]}"><b>${n}</b></button>`).join('')}</div>` : ''}
      </div>
      ${open && can.add ? `<div class="cx-actions" role="toolbar" aria-label="Add to this case">
          ${[['vitals', 'Vitals'], ['intervention', 'Intervention'], ['medication', 'Medicine'], ['assessment', 'Assessment'], ['handoff', 'Handoff'], ['note', 'Note']].map(([k, l]) => `<button type="button" class="ghost" data-add="${k}">+ ${l}</button>`).join('')}
          ${can.close ? '<button type="button" class="refresh" data-add="close">Close case</button>' : ''}
        </div><div id="cx-composer"></div>` : ''}
      <div class="cx-err-slot"></div>
      <ol class="cx-tl" aria-label="Timeline">${(C.entries || []).map((e) => entryRow(e, c, mine)).join('')}</ol>
      ${can.void && c.status !== 'void' ? '<div class="cx-foot"><button type="button" class="cx-link" id="cx-void">Void this case (duplicate or test)</button><div id="cx-voidbox"></div></div>' : ''}`;
    flash = '';
    const slot = body.querySelector('.cx-err-slot');
    const redo = () => drawCase(body, id);
    const run = async (fn, args, ok) => { slot.innerHTML = ''; try { await api(fn, args); flash = ok || ''; await loadMe(true); window.deskRefresh?.(); redo(); } catch (e) { slot.innerHTML = failBox(e.message); } };
    body.querySelectorAll('[data-setesi]').forEach((b) => b.onclick = () => Number(b.dataset.setesi) !== c.esi && run('chart_set_esi', { case_id: id, esi: Number(b.dataset.setesi) }, `ESI set to ${b.dataset.setesi}.`));
    body.querySelectorAll('[data-add]').forEach((b) => b.onclick = () => composer(body.querySelector('#cx-composer'), b.dataset.add, C, run));
    body.querySelectorAll('[data-cosign]').forEach((b) => b.onclick = () => { b.disabled = true; run('chart_cosign', { entry_id: Number(b.dataset.cosign) }, 'Cosigned.'); });
    body.querySelectorAll('[data-err]').forEach((b) => b.onclick = () => reasonForm(b.closest('.cx-e').querySelector('.cx-e-x'), 'Why is this entry wrong?', 'Mark entered in error',
      (r) => run('chart_error', { entry_id: Number(b.dataset.err), reason: r }, 'Marked as entered in error.')));
    const vb = body.querySelector('#cx-void');
    if (vb) vb.onclick = () => reasonForm(body.querySelector('#cx-voidbox'), 'Why void this case? (for example: duplicate of another case)', 'Void case', (r) => run('chart_void', { case_id: id, reason: r }, 'Case voided.'));
  }
  const KIND = { vitals: 'Vitals', intervention: 'Intervention', medication: 'Medicine', assessment: 'Assessment', handoff: 'Handoff', note: 'Note', triage: 'Triage', disposition: 'Disposition' };
  function entryText(e) {
    const d = e.data || {};
    switch (e.kind) {
      case 'vitals': return esc(vitalsLine(d));
      case 'intervention': return `<b>${esc(e.label || label('interventions', d.item))}</b>${d.note ? ' · ' + esc(d.note) : ''}`;
      case 'medication': return `<b>${esc(e.label || label('medications', d.item))}</b>${d.dose ? ' · ' + esc(d.dose) : ''}${d.note ? ' · ' + esc(d.note) : ''}`;
      case 'assessment': return esc((d.items || []).map((x) => label('assessments', x)).join(', ')) + (d.text ? ` · ${esc(d.text)}` : '');
      case 'handoff': return `${d.to ? `<b>To ${esc(d.to)}</b><br>` : ''}<span class="cx-sbar"><b>S</b> ${esc(d.s)}<br><b>B</b> ${esc(d.b)}<br><b>A</b> ${esc(d.a)}<br><b>R</b> ${esc(d.r)}</span>`;
      case 'triage': return `ESI set to <b>${esc(d.esi)}</b>${d.from ? ` (was ${esc(d.from)})` : ''}`;
      case 'disposition': return `<b>${esc(label('dispositions', d.disposition || d.item))}</b>${d.note ? ' · ' + esc(d.note) : ''}`;
      default: return esc(d.text || '');
    }
  }
  function entryRow(e, c, mine) {
    const err = e.error;
    // Triage and disposition can't be marked in error (set the ESI again, or void the case).
    const canErr = !err && !['triage', 'disposition'].includes(e.kind) && (e.author === myDiscordId || ME.owner || (ME.departments || []).some((d) => d.name === e.department && d.rank >= 6));
    return `<li class="cx-e${err ? ' is-err' : ''}${e.needs_cosign && !e.cosigned_at ? ' is-cos' : ''}" style="--c:${deptColor(e.department)}">
      <span class="cx-e-dot" aria-hidden="true"></span>
      <div class="cx-e-b">
        <div class="cx-e-h"><b>${esc(KIND[e.kind] || e.kind)}</b><span class="cx-time">${esc(hhmm(e.at))}</span>
          ${e.needs_cosign && !e.cosigned_at && !err ? '<span class="cx-cos">Needs cosign</span>' : ''}${e.cosigned_at ? `<span class="cx-ok">Cosigned by ${esc(cleanName(e.cosigned_by_name || ''))}</span>` : ''}</div>
        <div class="cx-e-t">${entryText(e)}</div>
        <div class="cx-e-m">${esc(cleanName(e.author_name || ''))}${e.author_rank_label ? ' · ' + esc(e.author_rank_label) : ''} · ${esc(e.department)}</div>
        ${err ? `<div class="cx-e-err">Entered in error by ${esc(cleanName(err.by_name || ''))}: ${esc(err.reason)}</div>` : ''}
        ${!err && (mine.has(e.id) || canErr) ? `<div class="cx-e-a">${mine.has(e.id) ? `<button type="button" class="refresh small-btn" data-cosign="${e.id}">Cosign</button>` : ''}${canErr ? `<button type="button" class="cx-link" data-err="${e.id}">Entered in error</button>` : ''}</div><div class="cx-e-x"></div>` : ''}
      </div></li>`;
  }
  function reasonForm(box, prompt, go, onGo) {
    box.innerHTML = `<div class="cx-reason"><label class="f"><span>${esc(prompt)}</span><input type="text" maxlength="200" required></label>
      <div class="cx-row-btns"><button type="button" class="refresh small-btn">${esc(go)}</button><button type="button" class="ghost small-btn">Cancel</button></div></div>`;
    const inp = box.querySelector('input'), [ok, no] = box.querySelectorAll('button');
    inp.focus();
    ok.onclick = () => { if (!inp.value.trim()) { inp.focus(); return; } ok.disabled = true; onGo(inp.value.trim()); };
    no.onclick = () => { box.innerHTML = ''; };
  }
  // Inline composer for one more entry on an open case.
  function composer(box, kind, C, run) {
    const c = C.case, id = c.id, dep = (ME.departments || []).find((d) => d.name === c.department) ? c.department : ME.default_department;
    const scoped = (it) => it.mine !== false;
    const chips = (list, attr, multi) => Object.entries(list.reduce((g, x) => ((g[x.group || ''] = g[x.group || ''] || []).push(x), g), {})).map(([g, l]) =>
      `<div class="cx-grp">${g ? `<span class="cx-gl">${esc(g)}</span>` : ''}<div class="cx-chips">${l.map((x) => `<button type="button" class="chip" data-${attr}="${esc(x.id)}">${esc(x.label)}${x.in_game === false ? '<span class="cx-rp">RP</span>' : ''}${x.scope && !scoped(x) ? '<span class="cx-cosdot" title="Needs a cosign at your rank"></span>' : ''}</button>`).join('')}</div></div>`).join('');
    const foot = (go) => `<div class="cx-row-btns"><button type="button" class="refresh" data-go>${go}</button><button type="button" class="ghost" data-x>Cancel</button></div>`;
    const V = {};
    if (kind === 'vitals') {
      const list = (CAT.vitals || []).filter((v) => v.key !== 'avpu' && v.key !== 'dbp');
      box.innerHTML = `<div class="card cx-comp"><h3>Vitals</h3><div class="cx-vit">${list.map((v) => `<button type="button" class="cx-vt" data-vk="${v.key}"><small>${v.key === 'sbp' ? 'BP' : esc(v.label)}</small><b id="cx-cv-${v.key}">–</b><em>${v.key === 'sbp' ? 'mmHg' : esc(v.unit || '')}</em></button>`).join('')}</div>
        <div class="cx-chips cx-avpu"><span class="cx-gl">AVPU</span>${['A', 'V', 'P', 'U'].map((o) => `<button type="button" class="chip" data-avpu="${o}">${o}</button>`).join('')}</div>${foot('Add vitals')}</div>`;
      box.querySelectorAll('[data-vk]').forEach((b) => b.onclick = () => keypad(b.dataset.vk, V, list, () => {
        for (const v of list) { const el = box.querySelector('#cx-cv-' + v.key); el.textContent = v.key === 'sbp' ? (V.sbp != null ? `${V.sbp}/${V.dbp ?? '–'}` : '–') : (V[v.key] ?? '–'); el.closest('.cx-vt').classList.toggle('set', v.key === 'sbp' ? V.sbp != null : V[v.key] != null); }
      }));
      box.querySelectorAll('[data-avpu]').forEach((b) => b.onclick = () => { V.avpu = V.avpu === b.dataset.avpu ? undefined : b.dataset.avpu; box.querySelectorAll('[data-avpu]').forEach((x) => x.classList.toggle('on', x.dataset.avpu === V.avpu)); });
      box.querySelector('[data-go]').onclick = () => { const d = Object.fromEntries(Object.entries(V).filter(([, x]) => x != null)); if (!Object.keys(d).length) return; run('chart_add', { case_id: id, kind: 'vitals', data: d, department: dep }, 'Vitals added.'); };
    } else if (kind === 'intervention' || kind === 'medication') {
      const list = CAT[kind === 'intervention' ? 'interventions' : 'medications'] || [];
      let item = '';
      box.innerHTML = `<div class="card cx-comp"><h3>${kind === 'intervention' ? 'Intervention' : 'Medicine'}</h3>${chips(list, 'pick')}
        ${kind === 'medication' ? '<label class="f"><span>Dose <em>(optional)</em></span><input id="cx-dose" type="text" maxlength="40" placeholder="for example 1 g"></label>' : ''}
        <label class="f"><span>Note <em>(optional)</em></span><input id="cx-note" type="text" maxlength="200"></label>${foot('Add')}</div>`;
      box.querySelectorAll('[data-pick]').forEach((b) => b.onclick = () => { item = b.dataset.pick; box.querySelectorAll('[data-pick]').forEach((x) => x.classList.toggle('on', x === b)); });
      box.querySelector('[data-go]').onclick = () => { if (!item) return; const d = { item }; const n = box.querySelector('#cx-note').value.trim(); if (n) d.note = n; const ds = box.querySelector('#cx-dose')?.value.trim(); if (ds) d.dose = ds;
        run('chart_add', { case_id: id, kind, data: d, department: dep }, `${label(kind === 'intervention' ? 'interventions' : 'medications', item)} added.`); };
    } else if (kind === 'assessment') {
      const sel = new Set();
      box.innerHTML = `<div class="card cx-comp"><h3>Assessment</h3>${chips(CAT.assessments || [], 'as')}<label class="f"><span>Findings <em>(optional)</em></span><input id="cx-note" type="text" maxlength="300"></label>${foot('Add assessment')}</div>`;
      box.querySelectorAll('[data-as]').forEach((b) => b.onclick = () => { const k = b.dataset.as; sel.has(k) ? sel.delete(k) : sel.add(k); b.classList.toggle('on', sel.has(k)); });
      box.querySelector('[data-go]').onclick = () => { const t = box.querySelector('#cx-note').value.trim(); if (!sel.size && !t) return; run('chart_add', { case_id: id, kind: 'assessment', data: { items: [...sel], text: t || undefined }, department: dep }, 'Assessment added.'); };
    } else if (kind === 'handoff') {
      const done = (C.entries || []).filter((e) => !e.error && (e.kind === 'intervention' || e.kind === 'medication')).map((e) => label(e.kind === 'intervention' ? 'interventions' : 'medications', e.data?.item));
      let to = '';
      box.innerHTML = `<div class="card cx-comp"><h3>Handoff (SBAR)</h3>
        <div class="cx-chips"><span class="cx-gl">To</span>${['Nursing', 'Paramedicine', 'Medical', 'Surgical'].map((d) => `<button type="button" class="chip cx-dchip" data-to="${d}" style="--c:${deptColor(d)}"><span class="cx-dot"></span>${d}</button>`).join('')}</div>
        <label class="f"><span>Situation</span><textarea id="cx-s" rows="2" maxlength="300">${esc([c.patient?.age_band, c.patient?.sex && c.patient.sex.toLowerCase(), 'patient with', c.complaint_label, c.esi && `, ESI ${c.esi}`].filter(Boolean).join(' ').replace(' ,', ',') + '.')}</textarea></label>
        <label class="f"><span>Background</span><textarea id="cx-b" rows="2" maxlength="300">${esc(`Arrived ${({ walk_in: 'as a walk-in', ambulance: 'by ambulance', helicopter: 'by helicopter' })[c.arrival] || ''}.${done.length ? ' Given: ' + done.join(', ') + '.' : ''}`)}</textarea></label>
        <label class="f"><span>Assessment</span><textarea id="cx-a" rows="2" maxlength="300">${esc(vitalsLine(c.latest_vitals))}</textarea></label>
        <label class="f"><span>Recommendation</span><input id="cx-r" type="text" maxlength="200" placeholder="What should happen next"></label>${foot('Add handoff')}</div>`;
      box.querySelectorAll('[data-to]').forEach((b) => b.onclick = () => { to = to === b.dataset.to ? '' : b.dataset.to; box.querySelectorAll('[data-to]').forEach((x) => x.classList.toggle('on', x.dataset.to === to)); });
      box.querySelector('[data-go]').onclick = () => { const g = (k) => box.querySelector('#cx-' + k).value.trim(); if (!g('r')) { box.querySelector('#cx-r').focus(); return; }
        run('chart_add', { case_id: id, kind: 'handoff', data: { s: g('s'), b: g('b'), a: g('a'), r: g('r'), to: to || null }, department: dep }, 'Handoff added.'); };
    } else if (kind === 'note') {
      box.innerHTML = `<div class="card cx-comp"><h3>Note</h3><label class="f"><span>Note</span><textarea id="cx-t" rows="3" maxlength="1000"></textarea></label>${foot('Add note')}</div>`;
      box.querySelector('#cx-t').focus();
      box.querySelector('[data-go]').onclick = () => { const t = box.querySelector('#cx-t').value.trim(); if (t) run('chart_add', { case_id: id, kind: 'note', data: { text: t }, department: dep }, 'Note added.'); };
    } else if (kind === 'close') {
      let dispo = '';
      box.innerHTML = `<div class="card cx-comp"><h3>Close case</h3><div class="cx-chips">${(CAT.dispositions || []).map((d) => `<button type="button" class="chip" data-dispo="${esc(d.id)}">${esc(d.label)}</button>`).join('')}</div>
        <label class="f"><span>Note <em>(optional)</em></span><input id="cx-note" type="text" maxlength="200"></label>${foot('Close case')}</div>`;
      box.querySelectorAll('[data-dispo]').forEach((b) => b.onclick = () => { dispo = b.dataset.dispo; box.querySelectorAll('[data-dispo]').forEach((x) => x.classList.toggle('on', x === b)); });
      box.querySelector('[data-go]').onclick = () => { if (!dispo) return; run('chart_close', { case_id: id, disposition: dispo, note: box.querySelector('#cx-note').value.trim() || null }, 'Case closed.'); };
    }
    box.querySelector('[data-x]')?.addEventListener('click', () => { box.innerHTML = ''; });
    box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // ================= Cosign queue =================
  async function drawQueue(body) {
    setHead('Needs your cosign', true);
    await loadQueue();
    if (!body.isConnected) return;
    const q = QUEUE || [];
    body.innerHTML = `${flash ? `<p class="cx-flash" role="status">${esc(flash)}</p>` : ''}<div class="cx-err-slot"></div>
      ${q.length ? `<div class="cx-list">${q.map((x) => `<div class="cx-row cx-qrow" style="--c:${deptColor(x.department)}">
          <span class="cx-rmain"><b>${esc(x.label)}</b><span class="cx-rsub">${esc(KIND[x.kind] || x.kind)} for <a href="#chart/case/${x.case_id}">${esc(x.patient_name)}</a></span>
            <span class="cx-rmeta"><span class="cx-dot"></span>${esc(cleanName(x.author_name || ''))} · ${esc(x.author_rank_label || '')} · ${esc(x.department)} · ${esc(ago(x.at))}</span></span>
          <span class="cx-rside"><button type="button" class="refresh small-btn" data-cosign="${x.entry_id}">Cosign</button><a class="ghost small-btn" href="#chart/case/${x.case_id}">Open case</a></span></div>`).join('')}</div>`
        : '<div class="cx-empty"><b>Nothing needs your cosign.</b><a class="ghost small-btn" href="#chart">Back to cases</a></div>'}`;
    flash = '';
    body.querySelectorAll('[data-cosign]').forEach((b) => b.onclick = async () => {
      b.disabled = true; b.textContent = 'Cosigning…';
      try { await api('chart_cosign', { entry_id: Number(b.dataset.cosign) }); flash = 'Cosigned.'; await loadMe(true); window.deskRefresh?.(); drawQueue(body); }
      catch (e) { body.querySelector('.cx-err-slot').innerHTML = failBox(e.message); b.disabled = false; b.textContent = 'Cosign'; }
    });
  }
})();
