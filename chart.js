// CBH Chart v2 (Delta; owner approved 18 Nov 2026, design https://claude.ai/artifact/DS8E7o28qjjwhezPRqmS6N).
// Live player patients only: every case starts from a patient check-in (website #checkin or the Discord button).
// Staff: #chart (live queue: waiting / in care / discharged today), #chart/cases, #chart/case/<id>, #chart/cosign.
// Members: #checkin (form → "Your visit" → discharge summary and rating). One shared Case per visit.
// Back end: Alpha's RPCs (0062–0064, then 0067–0070; contract Plans/CareBeyond/chart/CHART-V2-CONTRACT.md). The database decides
// who reads, writes, sets the ESI and cosigns; this file only draws what chart_me() and chart_get().can allow.
// Everything lives in this closure; the only globals it adds are LIVE.chart and window.chartNav / chartLogBtn /
// chartTab (sidebar, shift card and phone tab hooks used by desk.js and home.js).
// CBH_CHART_OFF (owner, 0.37.0): the Chart and Check In are off until the Chart is rebuilt. Code and data stay;
// set this to false to bring every entry point back (sidebar, Home card, shift card button, phone tab, search, pages).
window.CBH_CHART_OFF = true;
(() => {
  if (window.CBH_CHART_OFF) {
    // Old #chart / #checkin links go Home. The pages are never registered, so search and the menus don't list them.
    const home = () => { if (/^#(chart|checkin)(\/|$)/.test(location.hash)) location.replace('#'); };
    home(); window.addEventListener('hashchange', home);
    return;
  }
  const api = async (fn, args) => {
    const { data, error } = await sb.rpc(fn, args || {});
    if (error) throw new Error(error.message || 'Something went wrong. Try again.');
    return data;
  };
  let ME = null, CAT = null, QUEUE = null, deskData = null, flash = '', CASE_ORDERS = [];
  let QS = null, QSIG = '', CI = null;   // checkin_queue() for staff, checkin_status() for everyone
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
    if (v.pulse != null) p.push(`Pulse ${v.pulse}`);
    if (v.etco2 != null) p.push(`CO₂ ${v.etco2}`);
    if (v.temp_f != null) p.push(`${v.temp_f}°F`);
    if (v.glucose != null) p.push(`Glucose ${v.glucose}`);
    if (v.pain != null) p.push(`Pain ${v.pain}/10`);
    if (v.avpu) p.push(`AVPU ${v.avpu}`);
    return p.join(' · ');
  };
  // Danger-zone vitals for the ESI helper (adult cut-offs from the ESI handbook; a hint only).
  // Vitals in the game's order (v1.1): the catalogue lists them that way, each with a `source`: 'portal' (vitals cart and
  // the Patient Portal: BP, HR, Temp), 'monitor' (bedside monitor after the EKG: HR, SpO₂, Pulse, CO₂, RR) or 'other'.
  // BP is one tile (sbp/dbp); AVPU is chips; a key shown twice in the catalogue is drawn once, in its last group.
  const SRC = { portal: 'Vitals cart · Patient Portal', monitor: 'Bedside monitor (after the EKG)', other: 'Other' };
  const vitalList = () => {
    const vs = (CAT.vitals || []).filter((v) => v.key !== 'avpu' && v.key !== 'dbp');
    return vs.filter((v, i) => vs.findIndex((x, j) => x.key === v.key && j > i) === -1);
  };
  const vitalTile = (v, idp) => `<button type="button" class="cx-vt" data-vk="${v.key}"><small>${v.key === 'sbp' ? 'BP' : esc(v.label)}</small><b id="${idp}${v.key}">–</b><em>${v.key === 'sbp' ? 'mmHg' : esc(v.unit || '')}</em></button>`;
  const vitalGrid = (list, idp) => {
    if (!list.some((v) => v.source)) return `<div class="cx-vit">${list.map((v) => vitalTile(v, idp)).join('')}</div>`;
    const groups = [];
    for (const v of list) { const s = v.source || 'other'; let g = groups.find((x) => x.s === s); if (!g) groups.push(g = { s, l: [] }); g.l.push(v); }
    return groups.map((g) => `<div class="cx-grp"><span class="cx-gl">${esc(SRC[g.s] || g.s)}</span><div class="cx-vit">${g.l.map((v) => vitalTile(v, idp)).join('')}</div></div>`).join('');
  };
  const showVitals = (box, list, V, idp) => {
    for (const v of list) {
      const el = box.querySelector('#' + idp + v.key); if (!el) continue;
      el.textContent = v.key === 'sbp' ? (V.sbp != null ? `${V.sbp}/${V.dbp ?? '–'}` : '–') : (V[v.key] ?? '–');
      el.closest('.cx-vt').classList.toggle('set', v.key === 'sbp' ? V.sbp != null : V[v.key] != null);
    }
  };
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

  // ---------- queue and check-in state ----------
  const waitingRows = () => (QS?.queue || []).filter((q) => q.state === 'waiting');
  const careRows = () => (QS?.queue || []).filter((q) => q.state === 'claimed' || q.state === 'in_room');
  const qsig = (q) => JSON.stringify((q?.queue || []).map((x) => [x.id, x.state, x.esi, x.room, x.staff_name]));
  async function loadQS() {
    if (!ME?.can_read) { QS = null; return null; }
    try { QS = await api('checkin_queue'); } catch { QS = QS || { queue: [], suggested_staff: [] }; }
    return QS;
  }
  async function loadCI() {
    try { CI = await api('checkin_status', {}); } catch { CI = null; }
    access.checkin = true;
    return CI;
  }
  const mins = (s) => Math.max(0, Math.round((s || 0) / 60));
  const since = (iso) => iso ? Math.max(0, Math.round((Date.now() - new Date(iso)) / 6e4)) : 0;

  // ---------- registration (no edits to app.js) ----------
  PAGES.push({ id: 'chart', aud: 'chart', title: 'CBH Chart', icon: 'stethoscope', layout: 'chart' });
  PAGES.push({ id: 'checkin', aud: 'checkin', title: 'Check In', icon: 'nurse', layout: 'checkin' });
  if (typeof TOOL_FOLDER === 'object') { TOOL_FOLDER.chart = 'operations'; TOOL_FOLDER.checkin = 'help'; }
  const deskDraw = window.deskDraw;
  if (deskDraw) {
    window.deskDraw = async (d) => {
      deskData = d;
      if (ME) access.chart = !!ME.can_read;   // setAccess() just rebuilt `access`; keep the pages open while we re-check
      access.checkin = true;
      const done = deskDraw(d);
      await Promise.all([loadMe(true), loadCI()]);
      await loadQS(); QSIG = qsig(QS);
      window.deskRefresh?.();
      window.checkinHome?.();
      // The first route() ran before chart_me() answered, so a #chart link fell back to Home: route again.
      if ((location.hash.startsWith('#chart') && ME.can_read || location.hash.startsWith('#checkin')) && $('page').hidden) route();
      return done;
    };
  }
  // Keep the counts in the sidebar, shift card and phone tab current (quietly, only while the tab is visible).
  setInterval(async () => {
    if (document.hidden || !deskData) return;
    const before = QSIG, ciBefore = JSON.stringify(CI && [CI.session_live, CI.active?.state, CI.active?.position, CI.feedback_due?.length]);
    await Promise.all([ME?.can_read ? loadQS() : null, loadCI()]);
    QSIG = qsig(QS);
    const ciNow = JSON.stringify(CI && [CI.session_live, CI.active?.state, CI.active?.position, CI.feedback_due?.length]);
    if (QSIG !== before || ciNow !== ciBefore) { window.deskRefresh?.(); window.checkinHome?.(); document.dispatchEvent(new CustomEvent('cx-queue')); }
  }, 20000);

  // Sidebar: "CBH Chart" for Chart readers, with the number of patients waiting.
  window.chartNav = (link) => ME?.can_read ? link({ href: '#chart', label: 'CBH Chart', icon: 'stethoscope', n: waitingRows().length || 0 }) : '';
  // Shift card: take the recommended patient in one tap. Home shift bar: the queue with its count.
  window.chartLogBtn = (where) => {
    if (!ME?.can_write) return '';
    const w = waitingRows(), rec = w.find((q) => q.recommended) || w[0];
    if (where === 'ds') return rec ? `<button type="button" class="cx-logbtn cx-logbtn-ds" data-cx-take="${rec.id}">Take next · ${esc(rec.board_name || rec.first_name)}</button>` : `<a class="cx-logbtn cx-logbtn-ds quiet" href="#chart">Queue is empty</a>`;
    return `<a class="cx-logbtn cx-logbtn-${where}" href="#chart">Queue · ${w.length} waiting</a>`;
  };
  // Phone bottom tabs: the queue in the middle while on shift, with the waiting count.
  window.chartTab = () => ME?.can_read ? `<a class="cx-fab" href="#chart" aria-label="Patient queue, ${waitingRows().length} waiting"><span class="cx-fab-b" aria-hidden="true">${waitingRows().length}<small>WAITING</small></span><span>Queue</span></a>` : '';
  // Members: "Check in" (or "Your visit") in My stuff and on Home, only while it means something.
  const ciLabel = () => CI?.active ? 'Your Visit' : CI?.feedback_due?.length ? 'Rate Your Visit' : CI?.can_check_in ? 'Check In' : '';
  window.checkinNav = (link) => ciLabel() && (CI.active || CI.feedback_due?.length || !ME?.can_write) ? link({ href: '#checkin', label: ciLabel(), icon: 'nurse' }) : '';
  window.checkinHome = () => {
    const home = $('home'); if (!home) return;
    let el = home.querySelector('#cx-home-ci');
    const l = ciLabel();
    if (!l) { el?.remove(); return; }
    const a = CI.active;
    const line = a ? (a.state === 'waiting' ? `You're #${a.position} in the queue` : a.state === 'claimed' ? `${esc(a.staff_name || 'A clinician')} is coming to get you` : `Your room: ${esc(a.room || '')}`)
      : CI.feedback_due?.length ? 'How was your visit? Rate your care.' : 'Need care? Check in as a patient.';
    const html = `<a class="cx-homeci${a ? ' active' : ''}" href="#checkin"><span><b>${esc(l)}</b><small>${line}</small></span><span class="cx-go">${a ? 'Open' : CI.feedback_due?.length ? 'Rate' : 'Check in'}</span></a>`;
    if (!el) { el = document.createElement('div'); el.id = 'cx-home-ci'; (home.querySelector('#h-live') || home.firstElementChild)?.after(el); }
    el.innerHTML = html;
  };
  // "Take next" from the shift card (and any data-cx-take button).
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-cx-take]'); if (!b) return;
    e.preventDefault(); takePatient(Number(b.dataset.cxTake), b);
  });
  async function takePatient(id, btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Taking…'; }
    try {
      const r = await api('checkin_take', { p_id: id });
      const row = (QS?.queue || []).find((q) => q.id === id);
      flash = `You took ${row?.name || 'this patient'}. Set their room when they're in one.`;
      await loadQS(); QSIG = qsig(QS); window.deskRefresh?.();
      location.hash = '#chart/case/' + r.case_id;
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = 'Take patient'; }
      const slot = document.querySelector('#page-body .cx-err-slot');
      if (slot) slot.innerHTML = failBox(e.message); else window.alert?.(e.message);
      await loadQS(); document.dispatchEvent(new CustomEvent('cx-queue'));
    }
  }

  function setHead(title, back) {
    setPageTitle('stethoscope', title, 'staff');
    document.title = title + ' · CareBeyond';
    const b = $('page').querySelector('.back');
    if (b) { b.href = back ? '#chart' : '#'; b.lastChild.textContent = back ? 'Queue' : 'Home'; }
  }
  const failBox = (msg) => `<p class="error cx-err" role="alert">${esc(msg)}</p>`;

  LIVE.chart = async (body) => {
    const [, sub, id] = location.hash.slice(1).split('/');
    body.innerHTML = '<p class="muted">Loading…</p>';
    try { await Promise.all([loadMe(), loadCat()]); } catch (e) { body.innerHTML = failBox(e.message); return; }
    if (!ME.can_read) { setHead('CBH Chart'); body.innerHTML = '<div class="card"><p>The CBH Chart is for clinical staff: Nursing, Paramedicine, Medical and Surgical.</p></div>'; return; }
    if (sub === 'case' && id) return drawCase(body, Number(id));
    if (sub === 'cosign') return drawCosign(body);
    if (sub === 'cases') return drawList(body);
    return drawQueuePage(body, sub === 'mine');
  };
  LIVE.checkin = (body) => drawCheckin(body);

  const TABS = [['', 'Queue'], ['mine', 'My patients'], ['cases', 'All cases'], ['cosign', 'Needs cosign']];
  const tabsBar = (on) => `<nav class="cx-tabs" aria-label="CBH Chart">${TABS.map(([k, l]) => {
    const n = k === 'cosign' ? waiting() : 0;
    return `<a class="chip${on === k ? ' on' : ''}" href="#chart${k ? '/' + k : ''}"${on === k ? ' aria-current="page"' : ''}>${l}${n ? ` <span class="cx-n">${n}</span>` : ''}</a>`; }).join('')}</nav>`;

  // ================= The queue =================
  async function drawQueuePage(body, mineOnly) {
    setHead('CBH Chart');
    let myRating = null;
    await Promise.all([loadQS(), loadQueue(), ME.can_write ? api('checkin_my_rating', {}).then((r) => { myRating = r; }).catch(() => {}) : null]);
    if (!body.isConnected) return;
    QSIG = qsig(QS);
    const draw = () => {
      const w = waitingRows(), care = careRows().filter((q) => !mineOnly || q.staff_discord_id === myDiscordId);
      const free = (QS?.suggested_staff || []).filter((s) => !s.active_patients);
      const canTake = ME.can_write && ME.shift_id;
      const card = (q) => {
        const syms = (q.symptoms || []).map((s) => s.label).join(' · ');
        const esiCtl = ME.can_esi ? `<span class="cx-qesi" role="group" aria-label="Set ESI">${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="cx-esib mini${q.esi === n ? ' on' : ''}" data-qesi="${q.case_id}:${n}" style="--fg:${ESI_C[n][0]};--bg:${ESI_C[n][1]}" title="ESI ${n}"><b>${n}</b></button>`).join('')}</span>` : '';
        return `<div class="cx-qc${q.recommended ? ' rec' : ''}">
          ${q.recommended ? '<span class="cx-rtag">Recommended next</span>' : ''}
          ${esiBadge(q.esi)}
          <span class="cx-qmain"><b>${esc(q.name)}${q.age != null ? `<span class="cx-age">, ${esc(q.age)}</span>` : ''}</b>
            <span class="cx-rsub">${esc(syms)}${q.pain != null ? ` · Pain ${esc(q.pain)}` : ''}${q.esi ? '' : ' · <b>ESI not set</b>'}</span>
            <span class="cx-rmeta">@${esc(q.roblox_name || '')} · ${q.source === 'website' ? 'website' : 'Discord'}</span></span>
          <span class="cx-qside"><span class="cx-wait" data-since="${esc(q.created_at)}">${mins(q.waited_seconds)} min</span></span>
          ${esiCtl || canTake ? `<span class="cx-qact">${esiCtl}${canTake ? `<button type="button" class="${q.recommended ? 'refresh' : 'ghost'} small-btn cx-take" data-cx-take="${q.id}">Take patient</button>` : ''}</span>` : ''}
          ${q.recommended && free.length ? `<span class="cx-sugg">Free now: ${free.slice(0, 4).map((s) => `<span>${esc(s.discord_id === myDiscordId ? 'you' : cleanName(s.name))} <i>${esc(s.department)}</i></span>`).join('')}</span>` : ''}
        </div>`;
      };
      const careCard = (q) => `<a class="cx-qc care" href="#chart/case/${q.case_id}">
          ${esiBadge(q.esi)}
          <span class="cx-qmain"><b>${esc(q.name)}${q.age != null ? `<span class="cx-age">, ${esc(q.age)}</span>` : ''}</b>
            <span class="cx-rsub">${esc(q.staff_discord_id === myDiscordId ? 'You' : cleanName(q.staff_name || ''))} · <span data-since="${esc(q.claimed_at)}">${since(q.claimed_at)} min</span> · ${q.diagnosis_label ? 'Dx ' + esc(q.diagnosis_label) : '<span class="cx-pending">Dx pending</span>'}</span></span>
          <span class="cx-qside">${q.room ? `<span class="cx-room">${esc(q.room)}</span>` : '<span class="cx-wait">No room yet</span>'}${q.pending_cosign ? `<span class="cx-cos">${q.pending_cosign} cosign</span>` : ''}</span></a>`;
      body.innerHTML = `<div class="cx-tabrow">${tabsBar(mineOnly ? 'mine' : '')}${myRating?.ratings ? `<span class="cx-myrating" title="Your average from patients">Your rating <b>${Number(myRating.avg_rating).toFixed(1)} ★</b> <small>(${esc(myRating.ratings)})</small></span>` : ''}</div>
        ${flash ? `<p class="cx-flash" role="status">${esc(flash)}</p>` : ''}
        <div class="cx-err-slot"></div>
        <div class="cx-qbar-ch" id="cx-qch" hidden><span>The queue has changed.</span><button type="button" class="refresh small-btn" id="cx-qref">Refresh</button></div>
        ${!QS?.session_live ? '<p class="cx-note">No session is running, so nobody can check in right now. Patients still in care are below.</p>' : ''}
        ${ME.can_write && !ME.shift_id ? '<div class="cx-clockbar"><span>You’re off shift. Clock in to take patients.</span><button type="button" class="refresh small-btn" id="cx-clockin">Clock in</button></div>' : ''}
        <div class="cx-qcols">
          ${mineOnly ? '' : `<section class="cx-qcol" aria-labelledby="cx-qh-w"><h3 class="cx-qh" id="cx-qh-w">Waiting <b>${w.length}</b></h3>${w.map(card).join('') || '<p class="cx-empty small">Nobody is waiting.</p>'}</section>`}
          <section class="cx-qcol" aria-labelledby="cx-qh-c"><h3 class="cx-qh" id="cx-qh-c">${mineOnly ? 'Your patients' : 'In care'} <b>${care.length}</b></h3>${care.map(careCard).join('') || `<p class="cx-empty small">${mineOnly ? "You're not caring for anyone." : 'Nobody is in care.'}</p>`}</section>
          ${mineOnly ? '' : '<section class="cx-qcol" aria-labelledby="cx-qh-d"><h3 class="cx-qh" id="cx-qh-d">Discharged today <b id="cx-dcount">…</b></h3><div id="cx-done"></div></section>'}
        </div>`;
      flash = '';
      body.querySelectorAll('[data-qesi]').forEach((b) => b.onclick = async () => {
        const [cid, n] = b.dataset.qesi.split(':').map(Number);
        try { await api('chart_set_esi', { case_id: cid, esi: n }); await loadQS(); QSIG = qsig(QS); draw(); window.deskRefresh?.(); }
        catch (e) { body.querySelector('.cx-err-slot').innerHTML = failBox(e.message); }
      });
      const ci = body.querySelector('#cx-clockin');
      if (ci) ci.onclick = async () => {
        const dept = (ME.departments || []).map((d) => d.name).find((d) => myDepartments.includes(d));
        if (!dept) { location.hash = '#shifts'; return; }
        ci.disabled = true; ci.textContent = 'Starting…';
        const { error } = await sb.rpc('shift_start', { department: dept });
        if (error) { body.querySelector('.cx-err-slot').innerHTML = failBox(error.message); ci.disabled = false; ci.textContent = 'Clock in'; return; }
        await loadMe(true); if (deskData) window.deskDraw?.(deskData); draw();
      };
      body.querySelector('#cx-qref').onclick = async () => { await loadQS(); QSIG = qsig(QS); draw(); };
      if (!mineOnly) fillDone(body.querySelector('#cx-done'), body.querySelector('#cx-dcount'));
    };
    draw();
    // Never redraw by itself (owner rule): when the queue changes, offer a Refresh; only the wait timers tick.
    const onQ = () => { const bar = body.querySelector('#cx-qch'); if (bar && QSIG !== body.dataset.sig) bar.hidden = false; };
    body.dataset.sig = QSIG;
    document.addEventListener('cx-queue', onQ);
    const tick = setInterval(() => {
      if (!body.isConnected || !location.hash.startsWith('#chart') || location.hash.includes('/case')) { clearInterval(tick); document.removeEventListener('cx-queue', onQ); return; }
      body.querySelectorAll('[data-since]').forEach((el) => { el.textContent = since(el.dataset.since) + ' min'; });
    }, 30000);
  }
  async function fillDone(box, count) {
    if (QS?.recent) {
      const rec = QS.recent.filter((r) => r.state === 'discharged');
      count.textContent = rec.length;
      box.innerHTML = rec.length ? rec.map((r) => `<a class="cx-qc care done" href="#chart/case/${r.case_id}">
          <span class="cx-qmain"><b>${esc(r.board_name)}</b><span class="cx-rsub">${esc(r.diagnosis_label || 'No diagnosis')} · ${esc(cleanName(r.staff_name || ''))}${r.minutes != null ? ` · ${esc(r.minutes)} min` : ''}</span></span>
          <span class="cx-qside">${r.rating != null ? `<span class="cx-rating">${esc(r.rating)} ★</span>` : ''}</span></a>`).join('') : '<p class="cx-empty small">Nobody yet.</p>';
      return;
    }
    let rows = [];
    try { rows = await api('chart_list', { status: 'closed', lim: 30 }); } catch { /* the queue still works without it */ }
    const day = new Date().toDateString();
    rows = rows.filter((r) => new Date(r.last_at || r.opened_at).toDateString() === day);
    if (!box.isConnected) return;
    count.textContent = rows.length;
    box.innerHTML = rows.length ? rows.map((c) => `<a class="cx-qc care" href="#chart/case/${c.id}">${esiBadge(c.esi)}
        <span class="cx-qmain"><b>${esc(c.patient_name)}</b><span class="cx-rsub">${esc(c.diagnosis_label || label('dispositions', c.disposition) || '')} · ${esc(cleanName(c.opened_by_name || ''))}</span></span>
        <span class="cx-qside"><span class="cx-time">${esc(hhmm(c.last_at || c.opened_at))}</span></span></a>`).join('') : '<p class="cx-empty small">Nobody yet.</p>';
  }


  // ================= Cases =================
  const LIST = { status: 'open', mine: false, session: false, dept: '', q: '' };
  async function drawList(body) {
    setHead('CBH Chart');
    const tabs = tabsBar('cases');
    await loadQueue();
    const n = waiting();
    body.innerHTML = `${tabs}<div class="cx-top">
        <div class="cx-filters" role="group" aria-label="Show">
          ${[['open', 'Open'], ['mine', 'Mine'], ['session', 'This session'], ['closed', 'Closed'], ['all', 'All']].map(([k, l]) =>
            `<button type="button" class="chip${isOn(k) ? ' on' : ''}" data-f="${k}" aria-pressed="${isOn(k)}">${l}</button>`).join('')}
        </div>
      </div>
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
</div>`;
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
        <span class="cx-rmain"><b>${esc(c.patient_name)}${c.age != null ? `<span class="cx-age">, ${esc(c.age)}</span>` : ''}${c.alias ? ' <span class="cx-tag">Unknown</span>' : ''}${c.room ? ` <span class="cx-room">Room ${esc(c.room)}</span>` : ''}</b>
          <span class="cx-rsub">${esc(c.complaint_label || '')}${'diagnosis_label' in c ? ` · <span class="${c.diagnosis_label ? 'cx-dx' : 'cx-pending'}">${c.diagnosis_label ? 'Dx ' + esc(c.diagnosis_label) : 'Dx pending'}</span>` : ''}${c.latest_vitals ? ' · ' + esc(vitalsLine(c.latest_vitals)) : ''}</span>
          <span class="cx-rmeta"><span class="cx-dot" style="--c:${deptColor(c.department)}"></span>${esc(c.department)} · ${esc(cleanName(c.opened_by_name || ''))} · ${c.entries} ${c.entries === 1 ? 'entry' : 'entries'}${c.pending_cosign ? ` · <span class="cx-cos">${c.pending_cosign} needs cosign</span>` : ''}</span></span>
        <span class="cx-rside">${st}<span class="cx-time">${esc(ago(c.last_at || c.opened_at))}</span></span>
      </a>`;
  }

  // ================= v1.1 detail components (quick log and "Edit details") =================
  // Mirrors the game's Patient Portal: Patient (age, room) → Symptoms → History → Diagnosis; orders with "result back".
  const grouped = (list) => { const g = {}; for (const x of list) (g[x.group || ''] = g[x.group || ''] || []).push(x); return g; };
  const PATHWAY = { seen: ['Seen in game', 'Seen in the game, steps not confirmed yet'], none: ['No game pathway', 'No treatment pathway in the game yet'] };
  const pathTag = (c) => PATHWAY[c.pathway] ? `<span class="cx-rp cx-pw" title="${PATHWAY[c.pathway][1]}">${PATHWAY[c.pathway][0]}</span>` : '';
  // Symptoms: several chips plus free text (max 12). S = array of catalogue ids or free text.
  function symptomsUI(S, idp) {
    const cat = CAT.symptoms || [];
    const html = `${Object.entries(grouped(cat)).map(([g, l]) => `<div class="cx-grp">${g ? `<span class="cx-gl">${esc(g)}</span>` : ''}<div class="cx-chips">${l.map((s) =>
        `<button type="button" class="chip" data-sym="${esc(s.id)}" aria-pressed="false">${esc(s.label)}</button>`).join('')}</div></div>`).join('')}
      <div class="cx-chips" id="${idp}sym-free"></div>
      <div class="cx-addrow"><input id="${idp}sym-in" type="text" maxlength="40" placeholder="Another symptom, then Enter" aria-label="Add a symptom" autocomplete="off"><button type="button" class="ghost small-btn" id="${idp}sym-add">Add</button></div>`;
    const bind = (root, onChange) => {
      const draw = () => {
        root.querySelectorAll('[data-sym]').forEach((b) => { const on = S.includes(b.dataset.sym); b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
        const ids = new Set(cat.map((s) => s.id));
        root.querySelector(`#${idp}sym-free`).innerHTML = S.filter((x) => !ids.has(x)).map((x) => `<button type="button" class="chip on" data-symx="${esc(x)}" title="Remove">${esc(x)} <span aria-hidden="true">×</span></button>`).join('');
        root.querySelectorAll('[data-symx]').forEach((b) => b.onclick = () => { S.splice(S.indexOf(b.dataset.symx), 1); draw(); onChange?.(); });
      };
      root.querySelectorAll('[data-sym]').forEach((b) => b.onclick = () => { const i = S.indexOf(b.dataset.sym); if (i >= 0) S.splice(i, 1); else if (S.length < 12) S.push(b.dataset.sym); draw(); onChange?.(); });
      const inp = root.querySelector(`#${idp}sym-in`);
      const add = () => { const v = inp.value.trim(); if (v && !S.includes(v) && S.length < 12) S.push(v); inp.value = ''; draw(); onChange?.(); };
      root.querySelector(`#${idp}sym-add`).onclick = add;
      inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } };
      draw();
    };
    return { html, bind };
  }
  // History from the game's dialogue: allergies (or NKDA), past history, last ate/drank, onset.
  function historyUI(H, idp) {
    const f = (k, l, ph) => `<label class="f"><span>${l}</span><input id="${idp}${k}" type="text" maxlength="200" placeholder="${ph}" value="${esc(H[k] || '')}" autocomplete="off"></label>`;
    const html = `<div class="cx-hist">
        <div class="cx-allerg"><label class="f"><span>Allergies</span><input id="${idp}allergies" type="text" maxlength="200" placeholder="For example penicillin" value="${esc(H.allergies || '')}"${H.nkda ? ' disabled' : ''} autocomplete="off"></label>
          <button type="button" class="chip${H.nkda ? ' on' : ''}" id="${idp}nkda" aria-pressed="${!!H.nkda}">No known allergies</button></div>
        ${f('past_history', 'Past history', 'For example tonsils out as a child')}
        ${f('last_intake', 'Last ate or drank', 'For example some chips last night')}
        ${f('onset', 'Onset', 'For example since last night')}</div>`;
    const bind = (root, onChange) => {
      for (const k of ['allergies', 'past_history', 'last_intake', 'onset']) root.querySelector('#' + idp + k).oninput = (e) => { H[k] = e.target.value; onChange?.(); };
      root.querySelector('#' + idp + 'nkda').onclick = (e) => {
        H.nkda = !H.nkda; e.currentTarget.classList.toggle('on', H.nkda); e.currentTarget.setAttribute('aria-pressed', H.nkda);
        const a = root.querySelector('#' + idp + 'allergies'); a.disabled = H.nkda; if (H.nkda) { a.value = ''; H.allergies = ''; }
        onChange?.();
      };
    };
    return { html, bind };
  }
  // Diagnosis: Pending until the game gives one; the game's names first, then other, or free text.
  function diagnosisUI(D, idp) {
    const cat = CAT.diagnoses || [];
    const known = cat.some((d) => d.id === D.v);
    const html = `<div class="cx-chips"><button type="button" class="chip${!D.v ? ' on' : ''}" data-dx="" aria-pressed="${!D.v}">Pending</button></div>
      ${Object.entries(grouped(cat)).map(([g, l]) => `<div class="cx-grp">${g ? `<span class="cx-gl">${esc(g)}</span>` : ''}<div class="cx-chips">${l.map((d) =>
        `<button type="button" class="chip${D.v === d.id ? ' on' : ''}" data-dx="${esc(d.id)}" aria-pressed="${D.v === d.id}">${esc(d.label)}</button>`).join('')}</div></div>`).join('')}
      <div class="cx-chips"><button type="button" class="chip${D.v && !known ? ' on' : ''}" data-dx="__other">Other</button></div>
      <input id="${idp}dx-other" type="text" maxlength="60" placeholder="Diagnosis" aria-label="Other diagnosis" value="${D.v && !known ? esc(D.v) : ''}"${D.v && !known ? '' : ' hidden'}>`;
    const bind = (root, onChange) => {
      const o = root.querySelector('#' + idp + 'dx-other');
      root.querySelectorAll('[data-dx]').forEach((b) => b.onclick = () => {
        const v = b.dataset.dx;
        root.querySelectorAll('[data-dx]').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', x === b); });
        o.hidden = v !== '__other';
        D.v = v === '__other' ? o.value.trim() : v;
        if (!o.hidden) o.focus();
        onChange?.();
      });
      o.oninput = () => { D.v = o.value.trim(); onChange?.(); };
    };
    return { html, bind };
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
    CASE_ORDERS = c.orders || [];
    setHead(`Case #${c.id}`, true);
    document.title = (c.patient?.name || 'Case') + ' · CareBeyond';
    const pt = c.patient || {};
    body.innerHTML = `${flash ? `<p class="cx-flash${/didn't save/.test(flash) ? ' warn' : ''}" role="status">${esc(flash)}</p>` : ''}
      <div class="card cx-head">
        <div class="cx-head-l">${esiBadge(c.esi, true)}
          <div><div class="cx-pname">${esc(pt.name)}${pt.alias ? ' <span class="cx-tag">Unknown</span>' : ''}</div>
            <div class="cx-psub">${[pt.age != null ? pt.age + ' years' : pt.age_band, pt.sex, pt.roblox_username && '@' + pt.roblox_username].filter(Boolean).map(esc).join(' · ')}${c.room ? ` <span class="cx-room">Room ${esc(c.room)}</span>` : ''}</div>
            <div class="cx-psub"><b>${esc(c.complaint_label || c.complaint)}</b> · ${esc(label('arrivals', c.arrival))}</div>
            ${(c.symptoms || []).length ? `<div class="cx-symline">${c.symptoms.map((s) => `<span class="cx-symtag">${esc(s.label)}</span>`).join('')}</div>` : ''}</div></div>
        <div class="cx-head-r">${c.status === 'open' ? '<span class="st cx-st open">Open</span>' : c.status === 'void' ? '<span class="st cx-st void">Void</span>' : `<span class="st cx-st">${esc(label('dispositions', c.disposition))}</span>`}
          ${c.pending_cosign ? `<span class="cx-cos">${c.pending_cosign} needs cosign</span>` : ''}
          <span class="cx-meta"><span class="cx-dot" style="--c:${deptColor(c.department)}"></span>${esc(c.department)} · opened by ${esc(cleanName(c.opened_by_name || ''))} · ${esc(hhmm(c.opened_at))}</span></div>
        <div class="cx-dxline"><span class="cx-gl">Diagnosis</span>${c.diagnosis ? `<b>${esc(c.diagnosis.label)}</b><span class="cx-meta">${esc(cleanName(c.diagnosis.by_name || ''))}${c.diagnosis.at ? ' · ' + esc(hhmm(c.diagnosis.at)) : ''}</span>` : '<span class="cx-pending">Pending</span>'}</div>
        ${histLine(c.history)}
        ${c.latest_vitals ? `<div class="cx-lv"><span class="cx-gl">Latest vitals · ${esc(hhmm(c.latest_vitals.at))}</span>${esc(vitalsLine(c.latest_vitals))}${danger(c.latest_vitals) ? ' <span class="cx-warn">Danger zone</span>' : ''}</div>` : ''}
        ${open && can.esi ? `<div class="cx-esiset"><span class="cx-gl">${c.esi ? 'Change ESI' : 'Set ESI'}</span>${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="cx-esib mini${c.esi === n ? ' on' : ''}" data-setesi="${n}" style="--fg:${ESI_C[n][0]};--bg:${ESI_C[n][1]}"><b>${n}</b></button>`).join('')}</div>` : ''}
      </div>
      ${checkinCard(c, open && can.add)}
      ${ordersCard(c, open && can.add)}
      ${open && can.add ? `<div class="cx-actions" role="toolbar" aria-label="Add to this case">
          <button type="button" class="ghost cx-again" data-add="vitals">+ ${c.latest_vitals ? 'Vitals again' : 'Vitals'}</button>
          ${[['order', 'Order'], ['intervention', 'Intervention'], ['medication', 'Medicine'], ['assessment', 'Assessment'], ['handoff', 'Handoff'], ['note', 'Note'], ['details', 'Edit details']].map(([k, l]) => `<button type="button" class="ghost" data-add="${k}">${k === 'details' ? l : '+ ' + l}</button>`).join('')}
          ${can.close ? '<button type="button" class="refresh" data-add="close">Discharge</button>' : ''}
        </div><div id="cx-composer"></div>` : ''}
      <div class="cx-err-slot"></div>
      <ol class="cx-tl" aria-label="Timeline">${(C.entries || []).map((e) => entryRow(e, c, mine)).join('')}</ol>
      ${open && can.add ? `<div class="cx-dock"><button type="button" class="ghost" data-add="vitals">+ ${c.latest_vitals ? 'Vitals again' : 'Vitals'}</button>${can.close ? '<button type="button" class="refresh" data-add="close">Discharge</button>' : ''}</div>` : ''}
      ${can.void && c.status !== 'void' ? '<div class="cx-foot"><button type="button" class="cx-link" id="cx-void">Void this case (duplicate or test)</button><div id="cx-voidbox"></div></div>' : ''}`;
    flash = '';
    const slot = body.querySelector('.cx-err-slot');
    const redo = () => drawCase(body, id);
    const run = async (fn, args, ok) => { slot.innerHTML = ''; try { await api(fn, args); flash = ok || ''; await loadMe(true); window.deskRefresh?.(); redo(); } catch (e) { slot.innerHTML = failBox(e.message); } };
    body.querySelectorAll('[data-setesi]').forEach((b) => b.onclick = () => Number(b.dataset.setesi) !== c.esi && run('chart_set_esi', { case_id: id, esi: Number(b.dataset.setesi) }, `ESI set to ${b.dataset.setesi}.`));
    body.querySelectorAll('[data-add]').forEach((b) => b.onclick = () => composer(body.querySelector('#cx-composer'), b.dataset.add, C, run));
    body.querySelectorAll('[data-cosign]').forEach((b) => b.onclick = () => { b.disabled = true; run('chart_cosign', { entry_id: Number(b.dataset.cosign) }, 'Cosigned.'); });
    body.querySelectorAll('[data-result]').forEach((b) => b.onclick = () => {
      const row = b.closest('.cx-ord');
      row.querySelector('.cx-ord-x').innerHTML = `<input type="text" maxlength="200" placeholder="Result (optional)" aria-label="Result"><button type="button" class="refresh small-btn">Save</button>`;
      const inp = row.querySelector('.cx-ord-x input'); inp.focus();
      const go = () => run('chart_add', { case_id: id, kind: 'result', data: { order_id: Number(b.dataset.result), text: inp.value.trim() || undefined }, department: c.department }, 'Result recorded.');
      row.querySelector('.cx-ord-x button').onclick = go;
      inp.onkeydown = (e) => { if (e.key === 'Enter') go(); };
    });
    body.querySelectorAll('[data-err]').forEach((b) => b.onclick = () => reasonForm(b.closest('.cx-e').querySelector('.cx-e-x'), 'Why is this entry wrong?', 'Mark entered in error',
      (r) => run('chart_error', { entry_id: Number(b.dataset.err), reason: r }, 'Marked as entered in error.')));
    wireCheckin(body, c, run);
    const vb = body.querySelector('#cx-void');
    if (vb) vb.onclick = () => reasonForm(body.querySelector('#cx-voidbox'), 'Why void this case? (for example: duplicate of another case)', 'Void case', (r) => run('chart_void', { case_id: id, reason: r }, 'Case voided.'));
  }
  // ---------- the patient's own check-in answers: confirm or correct ----------
  const CONF_KEY = (id) => 'cx-confirmed-' + id;
  const confirmed = (id) => { try { return JSON.parse(localStorage.getItem(CONF_KEY(id)) || '[]'); } catch { return []; } };
  const setConfirmed = (id, list) => { try { localStorage.setItem(CONF_KEY(id), JSON.stringify(list)); } catch { /* fine without it */ } };
  function checkinCard(c, canEdit) {
    const ci = c.checkin; if (!ci) return '';
    const pt = c.patient || {}, h = c.history || {};
    const ans = ci.answers;   // Alpha: { key: { original, current, confirmed, corrected } } once chart_confirm is live
    const ok = ans ? Object.entries(ans).filter(([, a]) => a && (a.confirmed || a.corrected)).map(([k]) => k) : confirmed(c.id);
    const rows = [
      ['name', 'Name', pt.name], ['age', 'Age', pt.age], ['roblox_username', 'Roblox', pt.roblox_username],
      ['symptoms', 'Symptoms', (c.symptoms || []).map((s) => s.label).join(' · ')], ['pain', 'Pain', ci.pain != null ? ci.pain + ' / 10' : null],
      ['onset', 'Onset', h.onset], ['allergies', 'Allergies', h.nkda ? 'No known allergies' : h.allergies], ['history', 'Medical history', h.past_history], ['last_intake', 'Last ate or drank', h.last_intake],
    ].filter(([, , v]) => v != null && v !== '');
    const all = rows.every(([k]) => ok.includes(k));
    const editable = ['name', 'age', 'roblox_username', 'onset', 'allergies', 'history', 'last_intake'];
    const state = ci.state === 'claimed' ? '<span class="cx-wait">Taken · no room yet</span>' : ci.state === 'in_room' ? `<span class="cx-room">${esc(c.room || 'In a room')}</span>` : `<span class="st cx-st">${esc(ci.state)}</span>`;
    return `<div class="card cx-ci">
      <div class="cx-ci-h"><h3>From Their Check-In</h3><span class="cx-meta">${ci.source === 'website' ? 'Website' : 'Discord'} · checked in ${esc(hhmm(ci.created_at))} · waited ${mins(ci.waited_seconds)} min${ci.staff_name ? ' · taken by ' + esc(cleanName(ci.staff_name)) : ''}</span>${state}</div>
      ${canEdit && (ci.state === 'claimed' || ci.state === 'in_room') ? `<div class="cx-roomrow"><label class="f"><span>Room</span><input id="cx-room-in" type="text" maxlength="20" value="${esc(c.room || '')}" placeholder="ER 3, Exam 2, Trauma Bay 1" autocomplete="off"></label>
        <button type="button" class="refresh small-btn" id="cx-room-go">${ci.state === 'in_room' ? 'Change room' : 'Set room'}</button>
        <span class="cx-roomacts"><button type="button" class="cx-link" id="cx-release">Give back to the queue</button><button type="button" class="cx-link" id="cx-left">Left without being seen</button></span><div id="cx-ci-x"></div></div>` : ''}
      ${all ? `<p class="cx-okline">All answers confirmed. <button type="button" class="cx-link" id="cx-ci-show">Show them</button></p>` : ''}
      <div class="cx-confirm"${all ? ' hidden' : ''} id="cx-ci-rows">${rows.map(([k, l, v]) => `<div class="cx-cf${ok.includes(k) ? ' ok' : ''}" data-cf="${k}">
          <span class="cx-cf-k">${esc(l)}</span><span class="cx-cf-v">${ans?.[k]?.corrected && ans[k].original != null ? `<s>${esc(String(ans[k].original))}</s> → ` : ''}${esc(String(v))}</span>
          <span class="cx-cf-a">${ok.includes(k) ? `<span class="cx-ok">${ans?.[k]?.corrected ? 'Corrected' : 'Confirmed'}</span>` : canEdit ? `<button type="button" class="refresh small-btn" data-cfok="${k}">Confirm</button>${editable.includes(k) ? `<button type="button" class="ghost small-btn" data-cffix="${k}">Correct</button>` : k === 'symptoms' ? '<button type="button" class="ghost small-btn" data-add="details">Correct</button>' : ''}` : ''}</span>
          <div class="cx-cf-x"></div></div>`).join('')}
        ${canEdit && !all ? '<button type="button" class="refresh small-btn" id="cx-cf-all">Confirm all</button>' : ''}</div>
    </div>`;
  }
  function wireCheckin(body, c, run) {
    const ci = c.checkin; if (!ci) return;
    const keys = [...body.querySelectorAll('[data-cf]')].map((x) => x.dataset.cf);
    const mark = (list) => {
      if (ci.answers) { run('chart_confirm', { case_id: c.id, fields: [...new Set(list)] }, 'Confirmed.'); return; }
      setConfirmed(c.id, [...new Set(list)]); drawCase(body, c.id);
    };
    body.querySelectorAll('[data-cfok]').forEach((b) => b.onclick = () => mark(ci.answers ? [b.dataset.cfok] : [...confirmed(c.id), b.dataset.cfok]));
    const all = body.querySelector('#cx-cf-all');
    if (all) all.onclick = () => (ci.answers ? run('chart_confirm', { case_id: c.id, fields: null }, 'All answers confirmed.') : mark(keys));
    const show = body.querySelector('#cx-ci-show'); if (show) show.onclick = () => { body.querySelector('#cx-ci-rows').hidden = false; show.parentElement.hidden = true; };
    body.querySelectorAll('[data-cffix]').forEach((b) => b.onclick = () => {
      const k = b.dataset.cffix, row = b.closest('.cx-cf'), box = row.querySelector('.cx-cf-x');
      const hk = k === 'history' ? 'past_history' : k;   // chart_update calls medical history past_history
      const cur = k === 'allergies' && c.history?.nkda ? '' : (k === 'name' || k === 'age' || k === 'roblox_username' ? (c.patient || {})[k] : (c.history || {})[hk]) ?? '';
      box.innerHTML = `<input type="${k === 'age' ? 'number' : 'text'}" maxlength="200" value="${esc(String(cur))}" aria-label="Correct ${esc(k)}"><button type="button" class="refresh small-btn">Save</button><button type="button" class="ghost small-btn">Cancel</button>`;
      const [inp] = box.querySelectorAll('input'), [save, cancel] = box.querySelectorAll('button');
      inp.focus();
      cancel.onclick = () => { box.innerHTML = ''; };
      save.onclick = () => {
        const v = inp.value.trim();
        const changes = k === 'age' ? { age: v === '' ? null : Number(v) } : k === 'allergies' ? (/^(none|no|nka|nkda)$/i.test(v) ? { nkda: true, allergies: null } : { allergies: v || null, nkda: false }) : { [hk]: v || null };
        setConfirmed(c.id, [...confirmed(c.id), k]);
        run('chart_update', { case_id: c.id, changes }, 'Corrected.');
      };
    });
    const rg = body.querySelector('#cx-room-go');
    if (rg) rg.onclick = () => { const v = body.querySelector('#cx-room-in').value.trim(); if (v) run('checkin_room', { p_id: ci.id, p_room: v }, `Room set: ${v}. The patient gets a message.`); };
    const rel = body.querySelector('#cx-release');
    if (rel) rel.onclick = () => { flash = 'Patient is back in the queue.'; api('checkin_release', { p_id: ci.id }).then(() => { location.hash = '#chart'; }).catch((e) => { flash = ''; body.querySelector('.cx-err-slot').innerHTML = failBox(e.message); }); };
    const left = body.querySelector('#cx-left');
    if (left) left.onclick = () => reasonForm(body.querySelector('#cx-ci-x'), 'What happened? (for example: left the game)', 'Mark as left',
      (r) => api('checkin_left', { p_id: ci.id, p_reason: r }).then(() => { flash = 'Marked as left without being seen.'; location.hash = '#chart'; }).catch((e) => { body.querySelector('.cx-err-slot').innerHTML = failBox(e.message); }));
  }

  function histLine(h) {
    if (!h) return '';
    const p = [];
    if (h.nkda) p.push('<b>No known allergies</b>'); else if (h.allergies) p.push(`<b>Allergies:</b> ${esc(h.allergies)}`);
    if (h.past_history) p.push(`<b>Past:</b> ${esc(h.past_history)}`);
    if (h.last_intake) p.push(`<b>Last ate or drank:</b> ${esc(h.last_intake)}`);
    if (h.onset) p.push(`<b>Onset:</b> ${esc(h.onset)}`);
    return p.length ? `<div class="cx-histline">${p.join('<span class="cx-sep">·</span>')}</div>` : '';
  }
  function ordersCard(c, canAdd) {
    const os = c.orders || [];
    if (!os.length) return '';
    return `<div class="card cx-orders"><h3>Orders</h3>${os.map((o) => `<div class="cx-ord${o.result_at ? ' back' : ''}">
        <span class="cx-ord-l"><b>${esc(o.label)}</b><small>${esc(cleanName(o.ordered_by_name || ''))} · ${esc(hhmm(o.ordered_at))}</small></span>
        ${o.result_at ? `<span class="cx-ord-r"><span class="cx-ok">Result back</span>${o.result_text ? ' · ' + esc(o.result_text) : ''}<small>${esc(cleanName(o.result_by_name || ''))} · ${esc(hhmm(o.result_at))}</small></span>`
          : `<span class="cx-ord-r"><span class="cx-wait">Waiting for result</span>${canAdd ? `<button type="button" class="ghost small-btn" data-result="${o.entry_id}">Result back</button>` : ''}</span>`}
        <div class="cx-ord-x"></div></div>`).join('')}</div>`;
  }
  const KIND = { vitals: 'Vitals', intervention: 'Intervention', medication: 'Medicine', assessment: 'Assessment', handoff: 'Handoff', note: 'Note', triage: 'Triage', disposition: 'Disposition', order: 'Order', result: 'Result', update: 'Details', diagnosis: 'Diagnosis' };
  const FIELD = { room: 'Room', age: 'Age', sex: 'Sex', roblox_username: 'Roblox', symptoms: 'Symptoms', allergies: 'Allergies', nkda: 'No known allergies', past_history: 'Past history', last_intake: 'Last ate or drank', onset: 'Onset', diagnosis: 'Diagnosis' };
  const fieldVal = (k, v) => v == null || v === '' ? '–' : k === 'nkda' ? (v ? 'yes' : 'no') : Array.isArray(v) ? v.map((x) => (typeof x === 'object' ? x.label : label('symptoms', x))).join(', ') : typeof v === 'object' ? v.label || '' : String(v);
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
      case 'order': return `<b>${esc(e.label || label('orders', d.item))}</b> ordered`;
      case 'result': { const o = (CASE_ORDERS || []).find((x) => x.entry_id === d.order_id); return `<b>${esc(o?.label || 'Order')}</b> result back${d.text ? ': ' + esc(d.text) : ''}`; }
      case 'diagnosis': return `<b>${esc(d.label || d.id || 'Pending')}</b>${d.from ? ` (was ${esc(d.from)})` : ''}`;
      // changed = { field: [old, new] } (Alpha, 0067): show the new value.
      case 'update': return Object.entries(d.changed || {}).map(([k, v]) => `${esc(FIELD[k] || k)}: ${esc(fieldVal(k, Array.isArray(v) ? v[1] : v))}`).join('<br>');
      default: return esc(d.text || '');
    }
  }
  function entryRow(e, c, mine) {
    const err = e.error;
    // Triage and disposition can't be marked in error (set the ESI again, or void the case).
    const canErr = !err && !['triage', 'disposition', 'update', 'diagnosis', 'result'].includes(e.kind) && (e.author === myDiscordId || ME.owner || (ME.departments || []).some((d) => d.name === e.department && d.rank >= 6));
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
      const list = vitalList();
      box.innerHTML = `<div class="card cx-comp"><h3>Vitals</h3>${vitalGrid(list, 'cx-cv-')}
        <div class="cx-chips cx-avpu"><span class="cx-gl">AVPU</span>${['A', 'V', 'P', 'U'].map((o) => `<button type="button" class="chip" data-avpu="${o}">${o}</button>`).join('')}</div>${foot('Add vitals')}</div>`;
      const lv = c.latest_vitals;
      if (lv) for (const v of list) {   // "Vitals again": show the last set faintly so changes stand out
        const was = v.key === 'sbp' ? (lv.sbp != null ? `${lv.sbp}/${lv.dbp ?? '–'}` : null) : lv[v.key];
        if (was != null) box.querySelector('#cx-cv-' + v.key).closest('.cx-vt').insertAdjacentHTML('beforeend', `<i class="cx-was">was ${esc(String(was))}</i>`);
      }
      box.querySelectorAll('[data-vk]').forEach((b) => b.onclick = () => keypad(b.dataset.vk, V, list, () => showVitals(box, list, V, 'cx-cv-')));
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
    } else if (kind === 'order') {
      const sel = new Set();
      box.innerHTML = `<div class="card cx-comp"><h3>Order</h3><div class="cx-chips">${(CAT.orders || []).map((o) => `<button type="button" class="chip" data-o="${esc(o.id)}">${esc(o.label)}</button>`).join('')}</div>${foot('Add order')}</div>`;
      box.querySelectorAll('[data-o]').forEach((b) => b.onclick = () => { const k = b.dataset.o; if (sel.has(k)) sel.delete(k); else sel.add(k); b.classList.toggle('on', sel.has(k)); });
      box.querySelector('[data-go]').onclick = async (ev) => {
        if (!sel.size) return;
        ev.currentTarget.disabled = true;
        const items = [...sel], last = items.pop();
        try { for (const item of items) await api('chart_add', { case_id: id, kind: 'order', data: { item }, department: dep }); }
        catch (e) { box.querySelector('.cx-comp').insertAdjacentHTML('beforeend', failBox(e.message)); ev.currentTarget.disabled = false; return; }
        run('chart_add', { case_id: id, kind: 'order', data: { item: last }, department: dep }, sel.size > 1 ? `${sel.size} orders added.` : `${label('orders', last)} ordered.`);
      };
    } else if (kind === 'details') {
      const pt = c.patient || {}, H = { ...(c.history || {}) }, D = { v: c.diagnosis?.id || c.diagnosis?.label || '' };
      const S = (c.symptoms || []).map((s) => s.id || s.label);
      const before = { room: c.room || '', age: pt.age ?? '', symptoms: JSON.stringify(S), diagnosis: D.v, ...Object.fromEntries(['allergies', 'nkda', 'past_history', 'last_intake', 'onset'].map((k) => [k, H[k] ?? (k === 'nkda' ? false : '')])) };
      const SY = symptomsUI(S, 'cx-e-'), HI = historyUI(H, 'cx-eh-'), DX = diagnosisUI(D, 'cx-e-');
      box.innerHTML = `<div class="card cx-comp cx-details"><h3>Edit Details</h3>
        <div class="cx-pt2"><label class="f"><span>Age</span><input id="cx-e-age" type="number" inputmode="numeric" min="0" max="120" value="${esc(pt.age ?? '')}"></label>
          <label class="f"><span>Room</span><input id="cx-e-room" type="text" maxlength="20" value="${esc(c.room || '')}" autocomplete="off"></label></div>
        ${(CAT.symptoms || []).length ? `<div class="cx-sub" id="cx-e-sym"><span class="cx-gl">Symptoms</span>${SY.html}</div>` : ''}
        <div class="cx-sub" id="cx-e-hist"><span class="cx-gl">History</span>${HI.html}</div>
        ${(CAT.diagnoses || []).length ? `<div class="cx-sub" id="cx-e-dx"><span class="cx-gl">Diagnosis</span>${DX.html}</div>` : ''}
        ${foot('Save details')}</div>`;
      if (box.querySelector('#cx-e-sym')) SY.bind(box.querySelector('#cx-e-sym'));
      HI.bind(box.querySelector('#cx-e-hist'));
      if (box.querySelector('#cx-e-dx')) DX.bind(box.querySelector('#cx-e-dx'));
      box.querySelector('[data-go]').onclick = () => {
        // Send only what changed (chart_update logs each change on the timeline); null clears a field.
        const now = { room: box.querySelector('#cx-e-room').value.trim(), age: box.querySelector('#cx-e-age').value.replace(/\D/g, ''), symptoms: JSON.stringify(S), diagnosis: D.v,
          allergies: (H.allergies || '').trim(), nkda: !!H.nkda, past_history: (H.past_history || '').trim(), last_intake: (H.last_intake || '').trim(), onset: (H.onset || '').trim() };
        const changes = {};
        for (const k of Object.keys(now)) {
          if (String(now[k]) === String(before[k] ?? '')) continue;
          changes[k] = k === 'symptoms' ? S : k === 'age' ? (now.age === '' ? null : Number(now.age)) : k === 'nkda' ? now.nkda : (now[k] === '' ? null : now[k]);
        }
        if (!Object.keys(changes).length) { box.innerHTML = ''; return; }
        run('chart_update', { case_id: id, changes }, 'Details saved.');
      };
    } else if (kind === 'close') {
      let dispo = 'discharged';
      const live = (C.entries || []).filter((e) => !e.error);
      const idOf = {};
      for (const e of live) if (e.author_name && e.author && !idOf[cleanName(e.author_name)]) idOf[cleanName(e.author_name)] = e.author;
      const treatedBy = Object.keys(idOf);
      const did = [...new Set(live.filter((e) => ['intervention', 'medication', 'order'].includes(e.kind)).map((e) => e.label || label(e.kind === 'intervention' ? 'interventions' : e.kind === 'medication' ? 'medications' : 'orders', e.data?.item)))];
      const PHRASES = ['Rest and drink plenty of water.', 'Come back if it gets worse.', 'Take your medicine as directed.', 'Keep the area clean and dry.', 'Use the crutches for a week.'];
      box.innerHTML = `<div class="card cx-comp cx-dis"><div class="cx-dis-l"><h3>Discharge</h3>
          <div class="cx-chips">${(CAT.dispositions || []).filter((d) => d.id !== 'lwbs').map((d) => `<button type="button" class="chip${d.id === dispo ? ' on' : ''}" data-dispo="${esc(d.id)}">${esc(d.label)}</button>`).join('')}</div>
          ${c.diagnosis ? '' : '<p class="cx-hint cx-warnline">Diagnosis is still Pending. Set it in Edit details first if the game has given one.</p>'}
          <label class="f"><span>Advice for the patient <em>(they receive this)</em></span><textarea id="cx-fu" rows="3" maxlength="500" placeholder="What they should do next"></textarea></label>
          <div class="cx-chips">${PHRASES.map((s) => `<button type="button" class="chip" data-phrase="${esc(s)}">+ ${esc(s.replace(/\.$/, ''))}</button>`).join('')}</div>
          <div class="f"><span>Cared for by <em>(untick anyone who shouldn't be named)</em></span><div class="cx-chips">${treatedBy.map((n) => `<button type="button" class="chip on" data-cared="${esc(n)}" aria-pressed="true">${esc(n)}</button>`).join('')}</div></div>
          <label class="f"><span>Staff note <em>(optional, never sent to the patient)</em></span><input id="cx-note" type="text" maxlength="200"></label>
          ${foot('Discharge')}</div>
        <div class="cx-dis-r"><span class="cx-gl">${c.checkin ? 'The patient receives' : 'Summary'}</span><div class="cx-sum" id="cx-sum"></div></div></div>`;
      const goBtn = box.querySelector('[data-go]'), fu = box.querySelector('#cx-fu');
      const cared = new Set(treatedBy);
      box.querySelectorAll('[data-cared]').forEach((b) => b.onclick = () => { const n = b.dataset.cared; if (cared.has(n)) cared.delete(n); else cared.add(n); b.classList.toggle('on', cared.has(n)); b.setAttribute('aria-pressed', cared.has(n)); preview(); });
      const preview = () => {
        const d = (CAT.dispositions || []).find((x) => x.id === dispo);
        box.querySelector('#cx-sum').innerHTML = `<b class="cx-sum-t">Your visit summary</b>
          <div class="cx-sum-f"><span><b>Diagnosis</b>${esc(c.diagnosis?.label || 'Pending')}</span><span><b>Cared for by</b>${esc([...cared].join(', ') || '–')}</span></div>
          <span><b>What we did</b>${esc(did.join(' · ') || '–')}</span>
          <span><b>${esc(d?.label || '')}</b></span>
          <span><b>Advice</b>${esc(fu.value.trim() || '–')}</span>
          <small>${c.checkin ? 'Then: How was your care? 1 to 5' : ''}</small>`;
      };
      box.querySelectorAll('[data-dispo]').forEach((b) => b.onclick = () => { dispo = b.dataset.dispo; box.querySelectorAll('[data-dispo]').forEach((x) => x.classList.toggle('on', x === b)); goBtn.textContent = dispo === 'discharged' ? 'Discharge' : 'Close case'; preview(); });
      box.querySelectorAll('[data-phrase]').forEach((b) => b.onclick = () => { fu.value = (fu.value.trim() + ' ' + b.dataset.phrase).trim().slice(0, 500); preview(); });
      fu.oninput = preview;
      preview();
      goBtn.onclick = () => run('chart_close', { case_id: id, disposition: dispo, note: box.querySelector('#cx-note').value.trim() || null, follow_up: fu.value.trim() || null, cared_for: treatedBy.filter((n) => cared.has(n)).map((n) => idOf[n]) },
        c.checkin ? 'Discharged. The patient has their summary and can rate their care.' : 'Case closed.');
    }
    box.querySelector('[data-x]')?.addEventListener('click', () => { box.innerHTML = ''; });
    box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // ================= Cosign queue =================
  async function drawCosign(body) {
    setHead('CBH Chart');
    await loadQueue();
    if (!body.isConnected) return;
    const q = QUEUE || [];
    body.innerHTML = `${tabsBar('cosign')}${flash ? `<p class="cx-flash" role="status">${esc(flash)}</p>` : ''}<div class="cx-err-slot"></div>
      ${q.length ? `<div class="cx-list">${q.map((x) => `<div class="cx-row cx-qrow" style="--c:${deptColor(x.department)}">
          <span class="cx-rmain"><b>${esc(x.label)}</b><span class="cx-rsub">${esc(KIND[x.kind] || x.kind)} for <a href="#chart/case/${x.case_id}">${esc(x.patient_name)}</a></span>
            <span class="cx-rmeta"><span class="cx-dot"></span>${esc(cleanName(x.author_name || ''))} · ${esc(x.author_rank_label || '')} · ${esc(x.department)} · ${esc(ago(x.at))}</span></span>
          <span class="cx-rside"><button type="button" class="refresh small-btn" data-cosign="${x.entry_id}">Cosign</button><a class="ghost small-btn" href="#chart/case/${x.case_id}">Open case</a></span></div>`).join('')}</div>`
        : '<div class="cx-empty"><b>Nothing needs your cosign.</b><a class="ghost small-btn" href="#chart">Back to cases</a></div>'}`;
    flash = '';
    body.querySelectorAll('[data-cosign]').forEach((b) => b.onclick = async () => {
      b.disabled = true; b.textContent = 'Cosigning…';
      try { await api('chart_cosign', { entry_id: Number(b.dataset.cosign) }); flash = 'Cosigned.'; await loadMe(true); window.deskRefresh?.(); drawCosign(body); }
      catch (e) { body.querySelector('.cx-err-slot').innerHTML = failBox(e.message); b.disabled = false; b.textContent = 'Cosign'; }
    });
  }

  // ================= Members: check in, your visit, summary and rating =================
  // Symptom labels for the patient form (the database matches labels to its list; anything else is kept as typed).
  const PT_SYMPTOMS = ['Pain', 'Headache', 'Dizzy', 'Nausea', 'Vomiting', 'Fever', 'Cough', 'Sneezing', 'Runny nose', 'Shortness of breath',
    'Chest pain', 'Thirst / dry mouth', 'Wound', 'Deformity', 'Rash / swelling', 'Confusion', 'Seizure'];
  async function drawCheckin(body) {
    setPageTitle('nurse', 'Check In', 'everyone');
    document.title = 'Check in · CareBeyond';
    body.innerHTML = '<p class="muted">Loading…</p>';
    await loadCI();
    if (!body.isConnected) return;
    if (!CI) { body.innerHTML = failBox("We couldn't load check-in. Refresh to try again."); return; }
    if (CI.active) return drawVisit(body);
    if (CI.feedback_due?.length) return drawSummary(body, CI.feedback_due[0]);
    if (CI.can_check_in) return drawCheckinForm(body);
    const next = CI.next_session?.scheduled_for || CI.next_session?.at;
    body.innerHTML = `<div class="card cx-closed"><h3>${CI.session_live ? "You can't check in right now" : 'Check-in is closed'}</h3>
      <p>${esc(CI.reason || 'Check in when a session is live.')}</p>
      ${!CI.session_live && next ? `<p class="muted">Next session: ${esc(new Date(next).toLocaleString(undefined, { weekday: 'long', hour: 'numeric', minute: '2-digit' }))}</p>` : ''}</div>`;
  }

  function drawCheckinForm(body) {
    const F = { symptoms: [], pain: null, nkda: false };
    body.innerHTML = `<form class="cx-form cx-ptform" id="cx-ci" novalidate>
      <p class="cx-ctx-l">A session is running.${CI.est_wait_min != null ? ` Wait is about ${esc(CI.est_wait_min)} min.` : ''}</p>
      <section class="cx-sec"><h3>About You</h3>
        <label class="f"><span>Your character's name</span><input id="ci-name" type="text" maxlength="80" autocomplete="off" required></label>
        <div class="cx-pt2"><label class="f"><span>Age</span><input id="ci-age" type="number" inputmode="numeric" min="0" max="120" required></label>
          <label class="f"><span>Roblox username</span><input id="ci-rbx" type="text" maxlength="40" autocomplete="off" required></label></div>
      </section>
      <section class="cx-sec" id="ci-sym"><h3>What's wrong? <em>(pick all that fit)</em></h3>
        <div class="cx-chips">${PT_SYMPTOMS.map((s) => `<button type="button" class="chip" data-ps="${esc(s)}" aria-pressed="false">${esc(s)}</button>`).join('')}</div>
        <div class="cx-chips" id="ci-free"></div>
        <div class="cx-addrow"><input id="ci-other" type="text" maxlength="40" placeholder="Something else, then Enter" aria-label="Another symptom" autocomplete="off"><button type="button" class="ghost small-btn" id="ci-add">Add</button></div>
        <div class="cx-grp"><span class="cx-gl">Pain <em>(optional)</em></span><div class="cx-chips cx-pain">${[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => `<button type="button" class="chip" data-pp="${n}" aria-pressed="false">${n}</button>`).join('')}</div></div>
      </section>
      <section class="cx-sec"><h3>More about you <em>(optional)</em></h3>
        <div class="cx-pt2 wide"><label class="f"><span>When did it start?</span><input id="ci-onset" type="text" maxlength="200" autocomplete="off"></label>
          <label class="f"><span>Allergies</span><input id="ci-all" type="text" maxlength="200" placeholder="None, or what" autocomplete="off"></label></div>
        <label class="f"><span>Medical history</span><input id="ci-hist" type="text" maxlength="200" autocomplete="off"></label>
        <label class="f"><span>Last ate or drank</span><input id="ci-oral" type="text" maxlength="200" autocomplete="off"></label>
      </section>
      <div class="cx-err-slot"></div>
      <div class="cx-savebar"><span class="cx-need" id="ci-need"></span><button type="submit" class="refresh cx-save" id="ci-go">Check in</button></div>
    </form>`;
    const f = body.querySelector('#cx-ci'), $c = (s) => f.querySelector(s);
    const sync = () => {
      const miss = [];
      if (!$c('#ci-name').value.trim()) miss.push('name');
      if ($c('#ci-age').value === '') miss.push('age');
      if (!$c('#ci-rbx').value.trim()) miss.push('Roblox username');
      if (!F.symptoms.length) miss.push('a symptom');
      $c('#ci-need').textContent = miss.length ? 'Still needs: ' + miss.join(', ') : "You'll join the queue";
      $c('#ci-go').disabled = miss.length > 0;
    };
    const drawFree = () => {
      $c('#ci-free').innerHTML = F.symptoms.filter((s) => !PT_SYMPTOMS.includes(s)).map((s) => `<button type="button" class="chip on" data-px="${esc(s)}" title="Remove">${esc(s)} <span aria-hidden="true">×</span></button>`).join('');
      f.querySelectorAll('[data-px]').forEach((b) => b.onclick = () => { F.symptoms.splice(F.symptoms.indexOf(b.dataset.px), 1); drawFree(); sync(); });
    };
    f.querySelectorAll('[data-ps]').forEach((b) => b.onclick = () => {
      const s = b.dataset.ps, i = F.symptoms.indexOf(s);
      if (i >= 0) F.symptoms.splice(i, 1); else if (F.symptoms.length < 12) F.symptoms.push(s);
      b.classList.toggle('on', i < 0); b.setAttribute('aria-pressed', i < 0); sync();
    });
    const add = () => { const v = $c('#ci-other').value.trim(); if (v && !F.symptoms.includes(v) && F.symptoms.length < 12) F.symptoms.push(v); $c('#ci-other').value = ''; drawFree(); sync(); };
    $c('#ci-add').onclick = add;
    $c('#ci-other').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } };
    f.querySelectorAll('[data-pp]').forEach((b) => b.onclick = () => {
      F.pain = F.pain === Number(b.dataset.pp) ? null : Number(b.dataset.pp);
      f.querySelectorAll('[data-pp]').forEach((x) => { const on = Number(x.dataset.pp) === F.pain; x.classList.toggle('on', on); x.setAttribute('aria-pressed', on); });
    });
    ['#ci-name', '#ci-age', '#ci-rbx'].forEach((s) => { $c(s).oninput = sync; });
    f.onsubmit = async (e) => {
      e.preventDefault();
      const go = $c('#ci-go'); go.disabled = true; go.textContent = 'Checking in…';
      const v = (s) => $c(s).value.trim() || null;
      try {
        await api('checkin_create', { p_name: v('#ci-name'), p_age: Number($c('#ci-age').value), p_roblox_name: v('#ci-rbx'), p_symptoms: F.symptoms, p_pain: F.pain,
          p_onset: v('#ci-onset'), p_allergies: v('#ci-all'), p_history: v('#ci-hist'), p_last_oral: v('#ci-oral'), p_source: 'website' });
        flash = "You're checked in. We'll also message you on Discord as the queue moves.";
        drawCheckin(body); window.deskRefresh?.();
      } catch (err) { $c('.cx-err-slot').innerHTML = failBox(err.message); go.disabled = false; go.textContent = 'Check in'; }
    };
    sync();
    $c('#ci-name').focus({ preventScroll: true });
  }

  async function drawVisit(body) {
    setPageTitle('nurse', 'Your Visit', 'everyone');
    document.title = 'Your visit · CareBeyond';
    let board = null;
    try { board = await api('checkin_board'); } catch { /* the board is a bonus */ }
    if (!body.isConnected) return;
    const a = CI.active;
    const who = [a.staff_name && cleanName(a.staff_name), a.staff_department, a.staff_rank].filter(Boolean).join(' · ');
    const big = a.state === 'waiting' ? `<span class="cx-vbig">#${esc(a.position)}</span><span>in the queue · waiting ${mins(a.waited_seconds)} min${a.est_wait_min != null ? ` · about ${esc(a.est_wait_min)} min to go` : ''}</span>`
      : a.state === 'claimed' ? `<span class="cx-vbig sm">${esc(cleanName(a.staff_name || 'A clinician'))} is coming to get you</span><span>${esc(who)}</span>`
      : `<span class="cx-vbig sm">Your room: ${esc(a.room || '')}</span><span>${esc(who)}</span>`;
    body.innerHTML = `${flash ? `<p class="cx-flash" role="status">${esc(flash)}</p>` : ''}
      <div class="card cx-visit ${esc(a.state)}"><span class="cx-gl">${a.state === 'waiting' ? 'Waiting' : a.state === 'claimed' ? 'Taken' : 'In a room'}</span>${big}
        <p class="muted">We'll message you on Discord too. Stay in game near the ER entrance.</p></div>
      ${board ? `<div class="card cx-board"><h3>Waiting Board</h3>${board.map((r) => `<div class="cx-brow${r.id === a.id ? ' me' : ''}">
          <span>${r.state === 'waiting' ? `<b>${esc(r.position ?? '')}</b> ` : ''}${esc(r.board_name)}${r.id === a.id ? ' (you)' : ''}</span>
          <span class="${r.state === 'waiting' ? 'cx-wait' : 'cx-ok'}">${r.state === 'waiting' ? `${esc(r.waited_min ?? mins(r.waited_seconds))} min` : `with ${esc(r.with_name || '')}${r.room ? ' · ' + esc(r.room) : ''}`}</span></div>`).join('')}
          <p class="muted small">First name and last initial only. The order follows urgency, so it can change.</p></div>` : ''}
      <div class="cx-err-slot"></div>
      <div class="cx-row-btns"><button type="button" class="ghost" id="cv-edit">Add or change details</button>
        ${a.state === 'waiting' || a.state === 'claimed' ? '<button type="button" class="ghost cx-danger" id="cv-leave">Leave the queue</button>' : ''}</div>
      <div id="cv-x"></div>`;
    flash = '';
    body.querySelector('#cv-edit').onclick = () => {
      const x = body.querySelector('#cv-x');
      x.innerHTML = `<div class="card cx-comp"><h3>More Details</h3>
        <div class="cx-pt2 wide"><label class="f"><span>When did it start?</span><input id="cv-onset" type="text" maxlength="200"></label><label class="f"><span>Allergies</span><input id="cv-all" type="text" maxlength="200"></label></div>
        <label class="f"><span>Medical history</span><input id="cv-hist" type="text" maxlength="200"></label><label class="f"><span>Last ate or drank</span><input id="cv-oral" type="text" maxlength="200"></label>
        <div class="cx-grp"><span class="cx-gl">Pain</span><div class="cx-chips">${[0, 2, 4, 6, 8, 10].map((n) => `<button type="button" class="chip" data-vp="${n}">${n}</button>`).join('')}</div></div>
        <div class="cx-row-btns"><button type="button" class="refresh" id="cv-save">Save</button><button type="button" class="ghost" id="cv-cancel">Cancel</button></div></div>`;
      let pain = null;
      x.querySelectorAll('[data-vp]').forEach((b) => b.onclick = () => { pain = Number(b.dataset.vp); x.querySelectorAll('[data-vp]').forEach((y) => y.classList.toggle('on', y === b)); });
      x.querySelector('#cv-cancel').onclick = () => { x.innerHTML = ''; };
      x.querySelector('#cv-save').onclick = async () => {
        const g = (s) => x.querySelector(s).value.trim() || null;
        try { await api('checkin_details', { p_id: a.id, p_onset: g('#cv-onset'), p_allergies: g('#cv-all'), p_history: g('#cv-hist'), p_last_oral: g('#cv-oral'), p_pain: pain }); flash = 'Details saved. Your clinician can see them.'; drawCheckin(body); }
        catch (e) { body.querySelector('.cx-err-slot').innerHTML = failBox(e.message); }
      };
    };
    const lv = body.querySelector('#cv-leave');
    if (lv) lv.onclick = () => {
      const x = body.querySelector('#cv-x');
      x.innerHTML = `<div class="card cx-comp"><p>Leave the queue? You'll lose your place.</p><div class="cx-row-btns"><button type="button" class="refresh cx-danger-fill" id="cv-yes">Leave the queue</button><button type="button" class="ghost" id="cv-no">Stay</button></div></div>`;
      x.querySelector('#cv-no').onclick = () => { x.innerHTML = ''; };
      x.querySelector('#cv-yes').onclick = async () => {
        try { await api('checkin_cancel', { p_id: a.id }); flash = "You've left the queue."; await loadCI(); window.deskRefresh?.(); window.checkinHome?.(); drawCheckin(body); }
        catch (e) { body.querySelector('.cx-err-slot').innerHTML = failBox(e.message); }
      };
    };
    // A status page: it follows the patient's own visit (position, taken, room) without a refresh.
    const sig = JSON.stringify([a.state, a.position, a.room, a.staff_name]);
    const poll = setInterval(async () => {
      if (!body.isConnected || location.hash !== '#checkin') { clearInterval(poll); return; }
      if (document.hidden || body.querySelector('#cv-x')?.children.length) return;
      await loadCI();
      const now = CI?.active ? JSON.stringify([CI.active.state, CI.active.position, CI.active.room, CI.active.staff_name]) : 'done';
      if (now !== sig) { clearInterval(poll); window.deskRefresh?.(); drawCheckin(body); }
    }, 15000);
  }

  async function drawSummary(body, due) {
    setPageTitle('nurse', 'Your visit summary', 'everyone');
    document.title = 'Your visit summary · CareBeyond';
    let s;
    try { s = await api('checkin_summary', { p_id: due.id }); } catch (e) { body.innerHTML = failBox(e.message); return; }
    if (!body.isConnected) return;
    let stars = 0;
    body.innerHTML = `${flash ? `<p class="cx-flash" role="status">${esc(flash)}</p>` : ''}
      <div class="card cx-summary">
        <div class="cx-sum-f"><span><b>Diagnosis</b>${esc(s.diagnosis || 'Not recorded')}</span><span><b>Cared for by</b>${esc((s.treated_by || [s.staff_name]).filter(Boolean).map(cleanName).join(', '))}</span></div>
        ${(s.treatment || []).length ? `<span><b>What we did</b>${esc(s.treatment.join(' · '))}</span>` : ''}
        ${s.follow_up ? `<span><b>Advice</b>${esc(s.follow_up)}</span>` : ''}
        <small class="muted">${esc(s.disposition_label || '')}${s.minutes != null ? ` · ${esc(s.minutes)} minutes` : ''}</small>
      </div>
      ${s.rated ? '<p class="cx-flash">Thanks for rating your care.</p>' : `<div class="card cx-rate"><h3>How Was Your Care?</h3>
        <div class="cx-stars" role="radiogroup" aria-label="Rating">${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="cx-star" data-star="${n}" role="radio" aria-checked="false" aria-label="${n} out of 5">${n}</button>`).join('')}</div>
        <label class="f"><span>Anything to add? <em>(optional)</em></span><textarea id="cr-c" rows="2" maxlength="500"></textarea></label>
        <div class="cx-err-slot"></div><button type="button" class="refresh" id="cr-go" disabled>Send rating</button></div>`}`;
    flash = '';
    body.querySelectorAll('[data-star]').forEach((b) => b.onclick = () => {
      stars = Number(b.dataset.star);
      body.querySelectorAll('[data-star]').forEach((x) => { const on = Number(x.dataset.star) <= stars; x.classList.toggle('on', on); x.setAttribute('aria-checked', Number(x.dataset.star) === stars); });
      body.querySelector('#cr-go').disabled = false;
    });
    const go = body.querySelector('#cr-go');
    if (go) go.onclick = async () => {
      go.disabled = true;
      try { await api('checkin_feedback', { p_id: due.id, p_rating: stars, p_comment: body.querySelector('#cr-c').value.trim() || null }); flash = 'Thanks for rating your care.'; await loadCI(); window.deskRefresh?.(); window.checkinHome?.(); drawCheckin(body); }
      catch (e) { body.querySelector('.cx-err-slot').innerHTML = failBox(e.message); go.disabled = false; }
    };
  }
})();
