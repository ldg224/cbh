// CBH Chart (Delta, 19 Nov 2026), built from the approved prototype (Plans/CareBeyond/chart/prototype, v24) and
// OPERATIONS.md / FLOW-AUDIT.md. Staff side only: patients use Alpha's #visit pages (visit.js).
// Roles: Reception (front desk), Patient Care as Room / On call / Road, and Supervisor (the floor plan). One next-step
// bar in the record drives every flow; rooms and beds go through one check (bedUsable); alerts by sound, tab title and
// desktop notifications. The back end is Bravo's chart_* RPCs (BACKEND-PLAN.md / CONTRACT.md).
// Who sees the Chart is decided by the DATABASE launch switch (chart_ops.launched, read from chart_poll):
// before launch only owners and Supervise-sessions holders see it (for their test); after launch every staff member.
// CBH_CHART_OFF is only the emergency kill: set chartKill: true in config.js to hide the Chart from everyone.
const LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
window.CBH_CHART_OFF = !!(window.CBH_CONFIG && window.CBH_CONFIG.chartKill === true);
(() => {
  if (window.CBH_CHART_OFF) {
    // Old #chart / #checkin links go Home while it's off. The page is never registered, so search and menus don't list it.
    const home = () => { if (/^#(chart|checkin)(\/|$)/.test(location.hash)) location.replace('#'); };
    home(); window.addEventListener('hashchange', home);
    return;
  }
  // ---------- demo data: replaced by chart_poll in M2 ----------
  const FX = (() => {
    const now = Date.now(), ago = (m) => new Date(now - m * 60000);
    const URGENCY = {
      1: { name: 'Red', label: 'Now', colour: '#D92D20', ink: '#fff', within: 'Straight away', what: 'Life at risk: not breathing, no pulse, heavy bleeding.' },
      2: { name: 'Orange', label: 'Very urgent', colour: '#F57C00', ink: '#fff', within: 'Within 10 min', what: 'Struggling to breathe, chest pain, very bad pain.' },
      3: { name: 'Yellow', label: 'Urgent', colour: '#E3B100', ink: '#0B1E4A', within: 'Within 30 min', what: 'Bad pain, being sick, a broken bone.' },
      4: { name: 'Green', label: 'Standard', colour: '#16A34A', ink: '#fff', within: 'Within 1 hour', what: 'Small injury, mild pain, feeling unwell.' },
      5: { name: 'Blue', label: 'Not urgent', colour: '#2F6FD6', ink: '#fff', within: 'Within 2 hours', what: 'Could wait, or see a doctor another day.' },
    };
    // Symptoms, what was done, orders, results, diagnoses, follow-up and advice are TYPED (owner, 19 Nov 2026), with
    // suggestions learned from what staff typed before; only the lists we define ourselves live here.
    // Normal ranges (adult); units match Maple Hospital's monitors (°F).
    const VITALS = [
      { key: 'hr', name: 'Heart rate', unit: 'bpm', lo: 60, hi: 100, warn: 15, help: 'Beats a minute. On the bedside monitor after the EKG.' },
      { key: 'sys', name: 'Blood pressure (top)', unit: '', lo: 90, hi: 120, warn: 20, help: 'The first number on the Vitals Cart, e.g. 100 of 100/65.' },
      { key: 'dia', name: 'Blood pressure (bottom)', unit: '', lo: 60, hi: 80, warn: 10, help: 'The second number, e.g. 65 of 100/65.' },
      { key: 'temp', name: 'Temperature', unit: '°F', lo: 97, hi: 99.5, warn: 1.5, step: 0.1, help: 'From the thermometer.' },
      { key: 'spo2', name: 'Oxygen', unit: '%', lo: 95, hi: 100, warn: 3, help: 'SpO₂ on the monitor. Below 95 is low.' },
      { key: 'rr', name: 'Breathing rate', unit: '/min', lo: 12, hi: 20, warn: 4, help: 'Breaths a minute, on the monitor.' },
      { key: 'pain', name: 'Pain', unit: '/10', lo: 0, hi: 3, warn: 3, help: '0 is no pain, 10 is the worst. Ask the patient.' },
    ];
    // How a visit ended (OPERATIONS.md §2). Home / follow-up / admitted go to Ready to leave (optional checkout);
    // the others close the case.
    const OUTCOMES = [['home', 'Discharged home', 'Treated and safe to go home.'], ['follow', 'Discharged with follow-up', 'Needs a check-up later.'], ['admit', 'Admitted', 'Staying on a ward.'],
      ['left', 'Left against medical advice', 'Left before treatment was finished.']];   // Deceased is recorded separately ("Record a death")
    // ROOMS: Maple Hospital's main ward, from the owner's map (chart/maps/main-ward.png): 10 rooms, 14 beds. `area` is
    // where the room sits on the floor plan; `ped` = Paediatric Emergency, children only (109 and 110, green on the map). The Emergency and Trauma bays come later:
    // add them here and nothing else needs to change. Checked-in patients sit in WAITING_ROOM until someone takes them.
    const ROOMS = [
      { id: '101', beds: 2, area: 'r101' }, { id: '102', beds: 1, area: 'r102' }, { id: '103', beds: 1, area: 'r103' }, { id: '104', beds: 1, area: 'r104' },
      { id: '105', beds: 2, area: 'r105' }, { id: '106', beds: 2, area: 'r106' }, { id: '107', beds: 2, area: 'r107' }, { id: '108', beds: 1, area: 'r108' },
      { id: '109', beds: 1, area: 'r109', ped: true }, { id: '110', beds: 1, area: 'r110', ped: true },
    ];
    // Every bed as a label: "101 Bed A", "101 Bed B", "102", ...
    const BEDS = ROOMS.flatMap((r) => (r.beds > 1 ? ['A', 'B'].slice(0, r.beds).map((b) => `${r.id} Bed ${b}`) : [r.id]));
    const roomOfBed = (bed) => ROOMS.find((r) => String(bed || '').split(' ')[0] === r.id) || null;
    const isPed = (bed) => !!(roomOfBed(bed) || {}).ped;
    const WAITING_ROOM = 'the Waiting Room';
    // Patient-care departments (the teams a patient can be sent to) and their colours. Supervisors decide which
    // department each room belongs to; these are the defaults. Paediatric Emergency stays children-only.
    // The live department colours (each Director role's badge_color in Supabase `roles`, 19 Nov 2026).
    const CARE_DEPTS = [['Nursing', '#FF3D7E'], ['Medical', '#2F7AF2'], ['Surgical', '#229147'], ['Paramedicine', '#FF5533']];
    // Who holds which bed at the start of the demo (OPERATIONS.md §3: people own beds, up to 2 each).
    const BED_OWNER = { '105 Bed A': 'sam', '106 Bed A': 'ava', '103': 'ava' };
    const ROOM_DEPT = { 101: 'Nursing', 102: 'Nursing', 103: 'Nursing', 104: 'Nursing', 105: 'Medical', 106: 'Medical', 107: 'Medical', 108: 'Medical', 109: 'Nursing', 110: 'Nursing' }   // 109 and 110 are Children only (a room setting);
    const LIMIT = 2;   // the most patients one person can have at once
    // Plain questions the front desk asks to find the colour (the first "yes" sets it).
    const COLOUR_QUESTIONS = [[1, 'Is their life at risk right now? Not breathing, no pulse, heavy bleeding.'], [2, 'Are they struggling to breathe, or in very bad pain or chest pain?'],
      [3, 'Bad pain, being sick, or a broken bone?'], [4, 'A small injury, mild pain, or feeling unwell?'], [5, 'None of these: it could wait.']];
    const STAFF = [
      { id: 'me', name: 'Dr. Turtle', dept: 'Nursing', depts: ['Nursing', 'Medical', 'Paramedicine'], rank: 'Year 1', you: true },
      { id: 'ava', name: 'Ava Patel', dept: 'Nursing', rank: 'Year 5' },
      { id: 'mia', name: 'Dr. Mia Chen', dept: 'Medical', rank: 'Year 3', doctor: true },
      { id: 'kai', name: 'Dr. Kai Lee', dept: 'Surgical', rank: 'Year 4', doctor: true },
      { id: 'sam', name: 'Sam Ortiz', dept: 'Nursing', rank: 'Year 2' },
      { id: 'liam', name: 'Liam Ford', dept: 'Paramedicine', rank: 'Year 2' },
      { id: 'nina', name: 'Nina Ross', dept: 'Administration', rank: 'Team Member' },
    ];
    // stage: checkin (checked in online; the desk still has to confirm them) · queue (Up next) · care (someone has them)
    // · checkout (at the desk to leave) · closed. A handed-back patient is back in the queue but still in their room.
    const P = (o) => ({ vitals: [], did: [], orders: [], diagnosis: null, notes: '', colourLog: [], age: null, ...o });
    const patients = [
      P({ id: 1, name: 'Anna S.', dept: 'Medical', teams: ['Medical', 'Surgical'], roblox: 'annas_rbx', age: 25, symptoms: ['Headache', 'Dizzy', 'Feeling sick'], urgency: 3, stage: 'care', phase: 'in', room: '105 Bed A', nurse: 'sam', doctor: 'mia', called: true,
        source: 'desk', arrived: ago(22), queuedAt: ago(21), takenAt: ago(18), colourConfirmed: true,
        colourLog: [{ to: 3, by: 'desk', at: ago(21) }, { to: 3, by: 'sam', at: ago(17), confirm: true }],
        vitals: [{ at: ago(17), by: 'sam', hr: 106, sys: 100, dia: 65, temp: 99, spo2: 96 }], did: [{ what: 'Thermometer', by: 'sam', at: ago(16) }, { what: 'Heart & lungs', by: 'sam', at: ago(15) }],
        orders: [{ what: 'Blood sample', who: 'Nurse', by: 'mia', at: ago(12), done: ago(8), doneBy: 'sam', result: 'Shows dehydration' }, { what: 'Saline IV (fluids)', who: 'Nurse', by: 'mia', at: ago(4) }],
        notes: 'Played all day, forgot to drink.' }),
      P({ id: 2, name: 'Priya K.', dept: 'Medical', roblox: 'priyak', age: 31, symptoms: ['Injury', 'Pain'], urgency: 4, stage: 'care', phase: 'in', room: '106 Bed A', nurse: 'ava', called: true, source: 'online',
        arrived: ago(14), queuedAt: ago(12), takenAt: ago(9), colourLog: [{ to: 4, by: 'desk', at: ago(12) }] }),
      P({ id: 3, name: 'Zoe R.', dept: 'Nursing', roblox: 'zoer', age: 27, symptoms: ['Fever', 'Cough'], urgency: 5, stage: 'care', phase: 'called', calledAt: ago(1), room: '103', nurse: 'ava', called: false, source: 'online',
        arrived: ago(30), queuedAt: ago(28), takenAt: ago(0.5), colourLog: [{ to: 5, by: 'desk', at: ago(28) }] }),
      P({ id: 4, name: 'Ben T.', dept: 'Nursing', roblox: 'bent', age: 33, symptoms: ['Injury'], urgency: 4, stage: 'queue', room: '102', source: 'desk', arrived: ago(40), queuedAt: ago(6),
        handback: { note: 'Needs an X-ray. I had to log off.', by: 'liam', at: ago(6) }, colourLog: [{ to: 4, by: 'desk', at: ago(39) }] }),
      P({ id: 5, name: 'Leo M.', dept: 'Nursing', teams: ['Nursing', 'Medical'], roblox: 'leo_m22', age: 48, symptoms: ['Chest pain', 'Hard to breathe'], urgency: 2, stage: 'queue', source: 'online', arrived: ago(14), queuedAt: ago(13),
        colourLog: [{ to: 2, by: 'desk', at: ago(13) }] }),
      P({ id: 6, name: 'Noah B.', dept: 'Nursing', roblox: 'noahb', age: 19, symptoms: ['Cough'], urgency: 5, stage: 'queue', source: 'desk', arrived: ago(3), queuedAt: ago(3),
        colourLog: [{ to: 5, by: 'desk', at: ago(3) }] }),
      P({ id: 7, name: 'Omar H.', roblox: 'omar_h', age: 60, symptoms: ['Fainted', 'Dizzy'], urgency: null, said: 'Very bad', stage: 'checkin', source: 'online', arrived: ago(2) }),
      P({ id: 8, name: 'Grace L.', dept: 'Nursing', roblox: 'gracelee', age: 22, symptoms: ['Burn', 'Pain'], urgency: 3, stage: 'closed', discharged: true, closedAt: ago(12), room: null, nurse: 'liam', called: true, source: 'online',
        arrived: ago(55), queuedAt: ago(53), takenAt: ago(45), diagnosis: 'Burn', outcome: 'home', rating: 5, ratedBy: 'patient', log: [{ at: ago(10), t: 'Rated by the patient: 5 of 5' }],
        did: [{ what: 'Clean the wound', by: 'liam', at: ago(40) }, { what: 'Bandage', by: 'liam', at: ago(38) }],
        orders: [{ what: 'Burn cream', who: 'Nurse', by: 'liam', at: ago(39), done: ago(37), doneBy: 'liam' }], colourLog: [{ to: 3, by: 'desk', at: ago(53) }] }),
    ];
    // Fake online check-ins that arrive now and then (each says how bad it feels; the desk sets the colour).
    const ARRIVALS = [
      { name: 'Mila J.', roblox: 'milaj', age: 22, symptoms: ['Burn', 'Pain'], said: 'Quite bad' },
      { name: 'Hugo P.', roblox: 'hugop', age: 60, symptoms: ['Chest pain'], said: 'Very bad' },
      { name: 'Ella W.', roblox: 'ellaw', age: 14, symptoms: ['Allergic reaction'], said: 'Very bad' },
      { name: 'Sami K.', roblox: 'samik', age: 33, symptoms: ['Injury'], said: 'A little' },
      { name: 'Ivy N.', roblox: 'ivyn', age: 27, symptoms: ['Fever', 'Cough'], said: 'Quite bad' },
    ];
    return { URGENCY, VITALS, OUTCOMES, ROOMS, BEDS, roomOfBed, isPed, WAITING_ROOM, LIMIT, COLOUR_QUESTIONS, CARE_DEPTS, ROOM_DEPT, BED_OWNER, STAFF, patients, ARRIVALS, nextSession: 'Fri 20 Nov · 7:00 pm',
      // The permanent server invite and the Maple Hospital custom server (live site: settings.join_code, ROBLOX_PLACE in app.js).
      DISCORD: 'https://discord.gg/xxqTP4shRA', JOIN_CODE: '4920-4087', ROBLOX_PLACE: 8704997000 };
  })();

  const D = FX, $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const staff = (id) => D.STAFF.find((x) => x.id === id);
  const nm = (sid) => (staff(sid) || {}).name || (sid === 'tag' ? 'Someone' : String(sid || 'Someone'));
  const first = (id) => { const x = staff(id); if (!x) return id === 'desk' ? 'Front desk' : id === 'tag' ? 'Someone' : String(id || ''); if (x.you) return 'You'; return x.name.startsWith('Dr.') ? x.name.split(' ').slice(0, 2).join(' ') : x.name.split(' ')[0]; };
  const title = (id) => { const x = staff(id); if (!x) return ''; return x.doctor ? first(id) : `${x.dept === 'Paramedicine' ? 'Paramedic' : 'Nurse'} ${x.you ? 'Turtle' : first(id)}`; };
  const mins = (d) => Math.max(0, Math.round((Date.now() - new Date(d)) / 60000));
  const ago = (d) => { const m = mins(d); return m < 1 ? 'just now' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
  const clock = (d) => new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const load = (k, d) => { try { const v = localStorage.getItem('cbh.chart.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem('cbh.chart.' + k, JSON.stringify(v)); } catch { /* fine */ } };
  const U = (n) => D.URGENCY[n];
  const WITHIN = { 1: 0, 2: 10, 3: 30, 4: 60, 5: 120 };   // minutes before someone waiting should be re-checked

  const S = {
    deskBy: null, sec: 'desk', deskTab: 'queue', open: null, tab: 'chart', right: load('right', null),
    draft: { name: '', roblox: '', age: '', symptoms: [], urgency: null, teams: [] }, npOpen: false, confirmFor: null, recheckFor: null,
    handbackFor: null, endShift: false, checkout: {}, vdraft: {}, outcome: null, arrivals: 0,
    ph: [{ s: 'board' }], phone: false, pid: null, pdraft: { name: '', symptoms: [], said: null }, cdept: {},
    // OPERATIONS.md (Alpha, 19 Nov 2026): everyone picks a Chart role. reception | room | oncall | road | super
    // Demo: who you are. Default = a normal nurse (Nursing only, no Supervise sessions).
    myDepts: [], canSuper: false, canPick: [], onShift: true, queueIds: [], staffStatus: {}, staffReq: {}, offer: null, pickSel: null,
    session: true, role: null, rdept: null, ready: false, readyAt: null, readyGone: false, lastAct: Date.now(),
    superOther: false, recOpen: true, online: true, fast: false,
    roomDept: {}, roomCfg: {}, bedOwner: {}, staffRole: {}, staffReady: {},
    reqs: [], codes: [], incoming: [], reqMenu: false, rq: null, rqMode: 'down', pick: false, npc: null, inc: null, incDone: false,
    lv: {}, dth: {}, skipVit: {}, rqf: {}, finishAsk: null, forceAsk: false, mvBed: null, placeFor: null, deathFor: null,
    face: null, roleAsk: null, roomPanel: null, who: null, pendRoom: null, sendFor: null, endSess: false,
  };
  const minsAgo = (m) => new Date(Date.now() - m * 60000);
  // The demo data's shapes stay (colours, vitals ranges, outcomes); the people, rooms and patients come from the server.
  D.patients = []; D.ROOMS = []; D.BEDS = []; D.STAFF = [{ id: 'me', name: 'You', dept: '', depts: [], you: true }];
  D.roomOfBed = (bed) => D.ROOMS.find((r) => String(bed || '').split(' ')[0] === r.id) || null;
  D.isPed = (bed) => !!(S.roomCfg[(D.roomOfBed(bed) || {}).id] || {}).kids;
  let nextId = 100;
  const P = () => D.patients;
  const byId = (id) => P().find((p) => p.id === id);
  const isPhone = () => window.matchMedia('(max-width: 860px)').matches;
  // ----- derived lists -----
  const qOrder = (a, b) => (!!b.bumped - !!a.bumped) || (a.urgency - b.urgency) || (new Date(a.queuedAt) - new Date(b.queuedAt));
  const upNext = () => (S.queueIds || []).map((id) => byId(id)).filter((p) => p && p.stage === 'queue');
  const toConfirm = () => P().filter((p) => p.stage === 'checkin').sort((a, b) => new Date(a.arrived) - new Date(b.arrived));
  const callOuts = () => P().filter((p) => p.stage === 'care' && p.phase === 'called' && !p.calledOut);
  // Discharged cases are closed; the desk can still do optional after-care if the patient comes back (papers, follow-up, rating).
  const checkouts = () => P().filter((p) => p.stage === 'closed' && p.discharged && !p.deskDone).sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt));
  const inCare = () => P().filter((p) => p.stage === 'care').sort((a, b) => a.urgency - b.urgency);
  const mine = (sid = 'me') => P().filter((p) => p.stage === 'care' && p.nurse === sid);
  const roomsInUse = () => Object.fromEntries(P().filter((p) => p.room && (p.stage === 'care' || p.stage === 'queue')).map((p) => [p.room, p]));
  const freeRooms = () => D.BEDS.filter((b) => !roomsInUse()[b]);   // free beds
  const isChild = (p) => !!p.child || (p.age != null && p.age < 18);
  // ----- roles, rooms and beds (OPERATIONS.md §1 and §3) -----
  const ROLE_NAME = { reception: 'Reception', room: 'Room', oncall: 'On call', road: 'Road', super: 'Supervisor', off: 'Off the Chart', break: 'On a break' };
  const roleOf = (sid) => (sid === 'me' ? S.role : S.staffRole[sid]);
  const superOn = () => S.role === 'super' || S.superOther;
  const syncDesk = () => { const o = D.STAFF.find((x) => !x.you && S.staffRole[x.id] === 'reception'); S.deskBy = S.role === 'reception' ? 'me' : o ? o.id : null; };
  const deptColour = (d) => (D.CARE_DEPTS.find((x) => x[0] === d) || [0, '#9aa9c4'])[1];
  const roomIdOf = (bed) => (D.roomOfBed(bed) || {}).id;
  const roomDeptOf = (bed) => S.roomDept[roomIdOf(bed)];
  const kidsOnly = (bed) => !!(S.roomCfg[roomIdOf(bed)] || {}).kids;
  const adultsOnly = (bed) => !!(S.roomCfg[roomIdOf(bed)] || {}).adults;
  const bedOff = (bed) => !!((S.roomCfg[roomIdOf(bed)] || {}).off || {})[bed];
  const closedBed = (bed) => !!(S.roomCfg[roomIdOf(bed)] || {}).closed || bedOff(bed);
  // bedUsable(bed, patient): '' if the bed may be used, otherwise the reason. EVERY path that places a patient or gives
  // someone a bed goes through it (drag, Who?, Give anyway, Place/Move, swap, room picker, Ready/auto-assign, takeover, give room).
  const bedUsable = (bed, p) => { if (!bed) return 'No bed'; const c = S.roomCfg[roomIdOf(bed)];
    if (!c) return `${bed} is not a bed`; if (c.closed) return `Room ${roomIdOf(bed)} is closed${c.why ? ': ' + c.why : ''}`; if (bedOff(bed)) return `${bed} is unavailable`;
    if (p && c.kids && !isChild(p)) return `${roomIdOf(bed)} is Paediatric only`; if (p && c.adults && isChild(p)) return `${roomIdOf(bed)} is adults only`;
    return ''; };
  // Can this patient be dropped on this bed? (greyed and refused while dragging if not)
  const dropWhy = (p, bed) => { const other = roomsInUse()[bed], u = bedUsable(bed, p); if (u) return u;
    if (other && other !== p && !(p.room && other.stage === 'queue') && !(p.room && p.stage === 'care')) return `${bed} has ${other.name}`;
    return ''; };
  const ownerOf = (bed) => S.bedOwner[bed] || null;
  const bedsOf = (sid) => D.BEDS.filter((b) => S.bedOwner[b] === sid);
  const freeBedsOf = (sid) => bedsOf(sid).filter((b) => !roomsInUse()[b] && !bedUsable(b));
  const staffDept = (sid) => (sid === 'me' ? S.rdept || 'Nursing' : (staff(sid) || {}).dept);
  const isReady = (sid) => (sid === 'me' ? S.ready : !!S.staffReady[sid]);
  const readyAt = (sid) => +new Date((sid === 'me' ? S.readyAt : S.staffReady[sid]) || 0);
  const roomCap = (sid = 'me') => Math.min(D.LIMIT - mine(sid).length, freeBedsOf(sid).length);
  // Which of their free beds a patient would go into. Children prefer Children only rooms and use a normal bed only
  // when every Children only bed is taken; adults never go into one automatically.
  const bedPick = (p, sid) => { const f = freeBedsOf(sid);
    if (isChild(p)) { const k = f.find(kidsOnly); if (k) return k; if (D.BEDS.some((b) => kidsOnly(b) && !roomsInUse()[b] && !closedBed(b))) return null; return f.find((b) => !adultsOnly(b)) || null; }
    return f.find((b) => !kidsOnly(b)) || null; };
  const teamOk = (p, sid) => { const m = (p.teams || (p.dept ? [p.dept] : ['Any']))[0]; return !m || m === 'Any' || m === staffDept(sid); };
  const canHave = (p, sid) => teamOk(p, sid) && mine(sid).length < D.LIMIT && !(p.room && bedUsable(p.room, p)) && (p.room ? ownerOf(p.room) === sid || (!ownerOf(p.room) && bedsOf(sid).length < D.LIMIT) : !!bedPick(p, sid));
  const teamsOf = (p) => p.teams || (p.dept ? [p.dept] : ['Any']);
  const toggleTeam = (list, t) => (t === 'Any' ? ['Any'] : list.includes(t) ? list.filter((x) => x !== t) : [...list.filter((x) => x !== 'Any'), t]);
  const teamChips = (p) => teamsOf(p).filter((t) => t !== 'Any').map((t, i) => `<span class="team-c${i ? '' : ' main'}" style="--dc:${deptColour(t)}" title="${i ? 'Also needs ' + esc(t) : 'Main team: ' + esc(t)}">${esc(t)}</span>`).join('');
  const deptFit = (p, sid) => (!p.dept || p.dept === 'Any' || p.dept === staffDept(sid) ? 1 : 0);
  // The best waiting patient for someone (§6): bumped, colour, handed back or lost, their department, then the longest wait.
  const bestFor = (sid) => upNext().filter((p) => canHave(p, sid)).sort((a, b) => (!!b.bumped - !!a.bumped) || (a.urgency - b.urgency)
    || (!!b.handback - !!a.handback) || (deptFit(b, sid) - deptFit(a, sid)) || (new Date(a.queuedAt) - new Date(b.queuedAt)))[0] || null;
  // Timers: Got it 60 s, No show 5 min, requests 3 and 8 min, Ready 10 min. "Fast timers" in the demo runs them 10 times faster.
  const K = () => (S.fast ? 10 : 1);
  const SEC = (s) => (s * 1000) / K();
  const since = (d) => Date.now() + SKEW - new Date(d).getTime();
  const mmss = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const countdown = (from, secs) => `<span class="cd" data-cd="${new Date(from).toISOString()}" data-secs="${secs}">${mmss((SEC(secs) - since(from)) * K())}</span>`;
  const elapsed = (from) => `<span class="cd" data-up="${new Date(from).toISOString()}">${mmss(since(from) * K())}</span>`;
  const tooLong = (p) => p.stage === 'queue' && p.urgency && mins(p.queuedAt) > WITHIN[p.urgency];
  const place = (p) => upNext().indexOf(p) + 1;
  const stCode = (p) => (p.stage === 'checkin' ? 'triage' : p.stage === 'queue' ? (p.room ? 'wir' : 'waiting') : p.stage === 'closed' ? (p.discharged ? 'discharged' : 'closed')
    : p.phase === 'assigned' ? 'assigned' : p.phase === 'called' ? 'called' : p.phase === 'transferred' ? 'transferred' : p.offWard ? 'offward' : p.diagnosis ? 'complete' : p.did.length || p.orders.length ? 'treatment' : 'assessed');
  const status = (p) => ({ triage: 'Awaiting triage', waiting: 'Waiting to be seen', wir: 'Waiting in room for a nurse', discharged: 'Discharged', closed: 'Closed',
    assigned: `Assigned to ${title(p.nurse)}`, called: 'Called to room', transferred: `Transferred to ${p.where || 'another team'}`, offward: `In ${p.offWard}`,
    complete: 'Treatment complete', treatment: 'In treatment', assessed: 'Being assessed' }[stCode(p)]);
  const stKey = (p) => stCode(p);
  const say = (p) => `${p.name}, room ${roomIdOf(p.room) || '?'}${p.room && p.room.includes('Bed') ? ' ' + p.room.split(' ').slice(1).join(' ') : ''}, ${title(p.nurse)}`;
  const isOpenReq = (r) => !r.doneAt && !r.cancelled;
  const reqsFor = (p) => S.reqs.filter((r) => r.pid === p.id && isOpenReq(r));
  const reqById = (id) => S.reqs.find((r) => r.id === +id);
  const codeFor = (p) => S.codes.find((c) => c.pid === p.id);
  const typing = () => document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
  const upill = (n, short) => (n ? `<span class="upill" style="--u:${U(n).colour}">${short ? U(n).name : `${U(n).name} · ${U(n).label}`}</span>` : '<span class="upill none">No colour yet</span>');
  const nth = (n) => n + (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th');
  const vstate = (v, val) => { if (val === '' || val == null || isNaN(val)) return ''; val = +val; if (val >= v.lo && val <= v.hi) return 'ok'; const off = val < v.lo ? v.lo - val : val - v.hi; return off <= v.warn ? 'warn' : 'bad'; };
  const vword = (v, val) => { const st = vstate(v, val); if (!st || st === 'ok') return st ? 'Normal' : ''; return (+val < v.lo ? 'Low' : 'High') + (st === 'warn' ? ' (a little)' : ''); };
  const vrange = (v, val, r) => (vstate(v, val) === 'ok' ? `Normal range ${r}` : `${vword(v, val)}${vstate(v, val) ? ' · ' : ''}normal ${r}`);
  const latest = (p) => Object.assign({}, ...p.vitals);
  const toast = (t, ms) => { const el = $('#chx-toast'); el.innerHTML = t.replace(/\.(<\/?b>)?\./g, '.$1');   // "Leo M.." -> "Leo M."
    el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { el.hidden = true; }, ms || 4000); };
  const fromSaid = { 'A little': 4, 'Quite bad': 3, 'Very bad': 2 };

  // ================= THE SERVER (Bravo's chart_* RPCs, CONTRACT.md v1) =================
  // chart_poll(since_rev) feeds every screen; an adapter turns the snapshot into the view model the approved prototype
  // draws (patients with stage/phase, bed owners, roles, requests). Every button calls its RPC; the server enforces every
  // rule and a refusal shows its plain-words message. The client's greying is only a hint.
  let REV = 0, SNAP = null, SKEW = 0, ME_ID = null, pollT = null, polling = false, dirty = false, loadingRec = null;
  const RECS = {}, BED_LABEL = {}, BED_ID = {};
  const sidOf = (id) => (!id ? null : String(id) === String(ME_ID) ? 'me' : String(id));
  const idOf = (sid) => (sid === 'me' ? ME_ID : sid);
  const ROLE_IN = { reception: 'reception', room: 'room', on_call: 'oncall', road: 'road', supervisor: 'super' };
  const ROLE_OUT = { reception: 'reception', room: 'room', oncall: 'on_call', road: 'road', super: 'supervisor' };
  const OUT_IN = { home: 'home', follow_up: 'follow', admitted: 'admit', transferred: 'transferred', left_before_seen: 'lbbs', left_during_care: 'left', died: 'died', session_ended: 'ended' };
  const SAID = { a_little: 'A little', quite_bad: 'Quite bad', very_bad: 'Very bad' };
  const bedId = (label) => BED_ID[label] || label;
  async function rpc(fn, args) {
    const { data, error } = await sb.rpc(fn, args || {});
    if (error) { const e = new Error(error.message || 'Something went wrong. Try again.'); e.hint = error.hint; throw e; }
    return data;
  }
  // Every change: the RPC, then a fresh poll (and the open record). Refusals show the server's words as they are.
  async function call(fn, args, ok, onHint) {
    try {
      const r = await rpc(fn, args);
      if (ok) toast(typeof ok === 'function' ? ok(r || {}) : ok);
      await poll(true); return r || { ok: true };
    } catch (e) {
      if (onHint && onHint[e.hint]) onHint[e.hint](e); else toast(esc(e.message));
      render(); return null;
    }
  }
  const entry = (p, kind, data) => rpc('chart_entry_add', { p_case: p.id, p_kind: kind, p_data: data });
  // Any charting moves a "Called to room" patient to with-the-nurse first (FLOW-AUDIT #1).
  async function touch(p) { if (p && p.nurse === 'me' && p.phase === 'called') { try { await rpc('chart_with_patient', { p_case: p.id }); } catch { /* the charting call below still runs */ } } }
  async function chartIt(p, kind, data, ok) { try { await touch(p); await entry(p, kind, data); if (ok) toast(ok); } catch (e) { toast(esc(e.message)); } await poll(true); }

  // A poll asked for while another is in flight runs again straight after it (pollAgain), and whether the Chart page is
  // open is read AFTER the reply: opening the Chart during a background poll used to leave it on "Loading" for good.
  let pollAgain = false, drawnWithData = false;
  async function poll(now) {
    if (polling) { if (now) pollAgain = true; return; }
    polling = true; clearTimeout(pollT);
    let onPage = app.isConnected;
    try {
      const s = await Promise.race([rpc('chart_poll', { p_since_rev: now ? 0 : REV }), new Promise((_, no) => setTimeout(() => no(new Error('The Chart is taking too long to answer.')), 15000))]);
      onPage = app.isConnected;
      S.pollErr = null;
      const changed = !!(s && !s.unchanged); if (changed) { ingest(s); document.dispatchEvent(new Event('cbh-chart-poll')); }
      if (onPage && (changed || !drawnWithData)) { if (drag) dirty = true; else render(); }
    } catch (e) {
      // Never leave the page spinning: a failed read or a drawing error shows a message, and the next poll starts from scratch.
      console.error('CBH Chart:', e); S.pollErr = e.hint ? e.message : 'Something went wrong drawing the Chart.'; REV = 0;
      if (onPage) { try { if (!SNAP) render(); else $('#chx-view').innerHTML = holdScreen('The Chart didn’t load', `${esc(S.pollErr)} It tries again by itself in a few seconds.`); } catch (e2) { console.error('CBH Chart:', e2); } }
    }
    polling = false;
    if (pollAgain) { pollAgain = false; return poll(true); }
    if (onPage && S.open && (!RECS[S.open] || RECS[S.open].rev !== REV)) loadRec(S.open);
    pollT = setTimeout(() => poll(), onPage && !document.hidden ? 3000 : 15000);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && app.isConnected) poll(); });
  document.addEventListener('focusout', () => { if (dirty && !drag && app.isConnected) { dirty = false; setTimeout(render, 0); } });

  // ---------- snapshot → view model ----------
  const person = (id, name, dept) => { if (!id) return null; const sid = sidOf(id); if (sid === 'me') return sid;
    let x = D.STAFF.find((s) => s.id === sid); if (!x) { x = { id: sid, name: name || 'Someone', dept: dept || '' }; D.STAFF.push(x); } else { if (name) x.name = name; if (dept) x.dept = dept; } return sid; };
  const HIST = { checkin: 'Checked in', colour: 'Colour changed', confirm_colour: 'Colour confirmed', assign: 'Assigned', assign_override: 'Assigned outside their team', got_it: 'Accepted',
    expire_assign: 'Not accepted in time', called: 'Called to room', called_out: 'Called in by Reception', with_patient: 'With the nurse', no_show: 'No show', hand_back: 'Handed over',
    theyve_gone: 'Nurse left', move: 'Moved', swap: 'Swapped beds', discharge: 'Discharged', left: 'Closed', aftercare: 'After-care at the desk', rate: 'Rated',
    request: 'Request', request_accept: 'Request accepted', request_here: 'Arrived at bedside', request_done: 'Consult finished', request_cancel: 'Request cancelled', code: 'Code Blue', code_clear: 'Code Blue cleared', transfer: 'Transferred', off_ward: 'Off the ward', handover: 'Ambulance handover', team: 'Teams changed' };
  const histWords = (h) => `${HIST[h.action] || String(h.action || '').replace(/_/g, ' ')}${h.actor_name ? ' · ' + h.actor_name : ''}`;
  function toP(c) {
    const st = c.state, ph = { assigned: 'assigned', called: 'called', in_care: 'in' }[st];
    const stage = st === 'checked_in' ? 'checkin' : st === 'incoming' ? 'incoming' : st === 'waiting' || st === 'waiting_in_room' ? 'queue' : ph ? 'care' : 'closed';
    const nurse = c.owner ? person(c.owner, c.owner_name) : null;
    const transferred = ph === 'in' && c.off_ward && S.staffRole[nurse] === 'oncall';
    const old = P().find((x) => x.id === c.id) || {};
    const rec = (RECS[c.id] || {}).p || {};
    return Object.assign({ vitals: [], did: [], orders: [], diagnosis: null, notes: '', colourLog: [], log: [], consults: [], symptoms: [] }, rec, {
      ...(Array.isArray(c.symptoms) ? { symptoms: c.symptoms } : {}), symKnown: Array.isArray(c.symptoms) || !!RECS[c.id],
      id: c.id, name: c.short_name, roblox: c.roblox_username || old.roblox || '', urgency: c.esi, colourConfirmed: !!c.colour_confirmed,
      stage, phase: transferred ? 'transferred' : ph || null, where: transferred ? c.off_ward : null, source: c.source,
      teams: [c.team || 'Any', ...(c.extra_teams || [])], dept: c.team, child: !!c.child, npc: !!c.npc,
      room: c.bed ? BED_LABEL[c.bed] || c.bed : null, nurse, ownerName: c.owner_name,
      bumped: !!c.prioritised, lost: !!c.lost_nurse, handback: c.handback_note ? { note: c.handback_note, by: null, at: c.queued_at } : null,
      hbCount: c.handback_count || 0, flag: (c.handback_count || 0) >= 3, inRoom: !!c.handback_note,
      queuedAt: c.queued_at, assignedAt: c.assigned_at, assignExp: c.assign_expires_at, calledAt: c.called_at, calledOut: !!c.called_out_at, calledOutAt: c.called_out_at,
      age: c.age ?? old.age ?? null, pain: c.pain ?? null, suggestedEsi: c.suggested_esi || null, careNotes: c.care_notes || '', robloxId: c.roblox_user_id || null,
      offWard: transferred ? null : c.off_ward, said: SAID[c.said] || old.said || null, tags: c.tags || {}, online: !!c.online_unconfirmed,
      arrived: rec.arrived || c.queued_at || c.assigned_at || new Date().toISOString(), takenAt: c.assigned_at, called: ph === 'in' });
  }
  function ingest(s) {
    SNAP = s; REV = s.rev || REV; if (s.server_now) SKEW = Date.parse(s.server_now) - Date.now();
    const me = s.me || {}, ops = s.ops || {};
    if (me.discord_id) ME_ID = String(me.discord_id);
    const meRow = D.STAFF.find((x) => x.you) || { id: 'me', you: true };
    Object.assign(meRow, { name: me.name || meRow.name || 'You', dept: me.department || me.shift_department || '', depts: me.departments || [] });
    D.STAFF = [meRow];
    // rooms and beds
    if (s.rooms) {
      D.ROOMS = s.rooms.map((r) => ({ id: String(r.id), beds: r.beds, area: r.area, ped: r.who === 'kids' }));
      s.rooms.forEach((r) => { S.roomDept[r.id] = r.department; S.roomCfg[r.id] = Object.assign(S.roomCfg[r.id] || { log: [] }, { kids: r.who === 'kids', adults: r.who === 'adults', closed: !!r.closed, why: r.closed_reason || '', problem: r.problem || null, off: {} }); });
    }
    S.bedOwner = {};
    if (s.beds) {
      D.BEDS = s.beds.map((b) => b.label);
      s.beds.forEach((b) => { BED_LABEL[b.id] = b.label; BED_ID[b.label] = b.id;
        if (!b.available && S.roomCfg[b.room]) S.roomCfg[b.room].off[b.label] = b.off_reason || true;
        if (b.owner) S.bedOwner[b.label] = person(b.owner.discord_id, b.owner.name); });
    }
    // people
    S.staffRole = {}; S.staffReady = {}; S.staffStatus = {}; S.staffReq = {};
    (s.staff || []).forEach((x) => { const sid = person(x.discord_id, x.name, x.department); if (sid === 'me') return;
      S.staffRole[sid] = ROLE_IN[x.role] || (x.status === 'break' ? 'break' : 'off'); if (x.status === 'ready') S.staffReady[sid] = x.ready_since || true;
      S.staffStatus[sid] = x.status; S.staffReq[sid] = x.request || null; });
    (ops.supervisors || []).forEach((x) => { const sid = person(x.discord_id, x.name); if (sid !== 'me' && !S.staffRole[sid]) S.staffRole[sid] = 'super'; });
    // me
    const wasRole = S.role; S.onShift = me.on_shift !== false; S.role = ROLE_IN[me.role] || null; S.rdept = me.department || null;
    if (S.role && S.role !== wasRole) { S.sec = SECTIONS[S.role][0][0]; S.ph = [{ s: isPhone() && S.role === 'super' ? 'board' : S.sec }]; S.deskTab = S.role === 'reception' ? 'checkin' : 'queue'; }
    S.ready = !!me.ready; S.readyAt = me.ready_since || null; S.readyExp = me.ready_expires_at || null;
    S.myDepts = me.departments || []; S.canPick = me.can_pick || []; S.canSuper = !!me.can_supervise; S.offer = me.offer || null;
    (me.notices || []).forEach((n) => { if (!(S.seenNotices || (S.seenNotices = new Set())).has(n.id)) { S.seenNotices.add(n.id); toast(esc(n.text), 6000); } });
    S.launched = ops.launched !== false;
    S.session = ops.session === 'live'; S.autoMode = !!ops.auto_mode; S.superOther = !ops.auto_mode && S.role !== 'super';
    S.recOpen = ops.reception_open !== false; S.online = (ops.online_mode || 'open') === 'open';
    // cases (open board) + the desk's recently discharged
    const cases = (s.cases || []).map(toP);
    const closed = (s.recent_discharged || []).map((x) => { const o = P().find((y) => y.id === x.id) || {};
      return Object.assign({ vitals: [], did: [], orders: [], colourLog: [], log: [], symptoms: [] }, o, { id: x.id, name: x.short_name, stage: 'closed', discharged: true, outcome: OUT_IN[x.outcome] || x.outcome, closedAt: x.discharged_at, papersGiven: !!x.papers, rating: x.rated ? o.rating || 1 : null, ratedBy: x.rated ? o.ratedBy || 'patient' : null, deskDone: false }); });
    D.patients = [...cases, ...closed];
    S.queueIds = s.queue || [];
    S.incoming = (s.incoming || []).map((id) => { const p = byId(id); return p ? { id, name: p.name, urgency: p.urgency || 4, what: '', at: p.queuedAt || p.arrived, eta: null, by: S.role === 'road' ? 'me' : 'x', done: false } : null; }).filter(Boolean);
    // requests (or, for roles that don't get the list, the per-case tags)
    if (s.requests) S.reqs = s.requests.map((r) => ({ id: r.id, type: r.kind, mode: r.surgery_mode === 'take_to_surgery' ? 'take' : r.surgery_mode ? 'down' : undefined, pid: r.case_id,
      by: person(r.asked_by, r.asked_by_name), at: r.asked_at, note: r.note || '', acceptedBy: r.accepted_by ? person(r.accepted_by, r.accepted_by_name) : null, acceptedAt: r.accepted_at,
      hereAt: r.here_at, sentTo: r.sent_to ? person(r.sent_to) : null, auto: !!r.auto, chase: r.chased || 0, red: !!r.red, reopened: r.reopened || 0 }));
    else S.reqs = (s.cases || []).flatMap((c) => Object.entries(c.tags || {}).filter(([, t]) => t && t !== 'done').map(([k, t]) => ({ id: `t${c.id}${k}`, type: k, pid: c.id, at: c.queued_at, acceptedBy: t === 'accepted' || t === 'here' ? 'tag' : null, acceptedAt: c.queued_at, hereAt: t === 'here' ? c.queued_at : null })));
    S.codes = (s.codes || []).map((c) => ({ pid: c.case_id, by: c.by_name, at: c.at }));
    syncDesk();
  }
  async function loadRec(id) {
    if (loadingRec === id) return; loadingRec = id;
    try {
      const r = await rpc('chart_case', { p_id: id }), c = r.case || {}, E = (r.entries || []).filter((e) => !e.error);
      const by = (e) => (String(e.by) === String(ME_ID) ? 'me' : e.by_name || '');
      const d = (e) => e.data || {};
      RECS[id] = { rev: REV, can: r.can || {}, p: {
        age: c.age, symptoms: c.symptoms || [], fullName: c.patient_name, follow: c.follow_up, rating: c.rating, ratedBy: c.rating_source === 'reception' ? 'desk' : c.rating_source ? 'patient' : null,
        vitals: E.filter((e) => e.kind === 'vitals').map((e) => ({ at: e.at, by: by(e), ...d(e) })),
        did: E.filter((e) => e.kind === 'intervention').map((e) => ({ id: e.id, what: d(e).text, by: by(e), at: e.at })),
        orders: E.filter((e) => e.kind === 'order').map((e) => ({ id: e.id, what: d(e).text, who: d(e).who || 'Anyone', by: by(e), at: e.at, done: e.done_at || d(e).done_at || null, doneBy: e.done_by_name || d(e).done_by_name, result: e.result || d(e).result || null })),
        diagnosis: (E.filter((e) => e.kind === 'diagnosis').pop() || { data: {} }).data.text || c.diagnosis || null,
        notes: (E.filter((e) => e.kind === 'note').pop() || { data: {} }).data.text || '',
        consults: (r.requests || []).filter((q) => q.done_at && q.kind !== 'imaging').map((q) => ({ by: String(q.accepted_by) === String(ME_ID) ? 'me' : q.accepted_by_name, type: q.kind, at: q.done_at, text: q.done_note || '' })),
        colourLog: (r.history || []).filter((h) => h.action === 'colour' || h.action === 'confirm_colour').map((h) => ({ from: (h.detail || {}).from, to: (h.detail || {}).to ?? c.esi, by: h.actor_name, at: h.at, confirm: h.action === 'confirm_colour' })),
        log: (r.history || []).map((h) => ({ at: h.at, t: histWords(h) })),
        arrived: c.opened_at || c.queued_at } };
      const p = byId(id); if (p) Object.assign(p, RECS[id].p);
      render();
    } catch (e) {
      // On call opening a request they can accept (or have accepted): the server only opens the full record once they're on
      // the case, so keep the drawer with the request steps from the poll; it reloads after Accept.
      if (e.hint === 'no_access' && reqFor(id)) { RECS[id] = { rev: REV, can: {}, limited: true, p: {} }; loadingRec = null; render(); return; }
      if (e.hint === 'no_access') { (S.noRec || (S.noRec = new Set())).add(id); if (S.open === id) { S.open = null; if (S.ph.length > 1 && (S.ph[S.ph.length - 1] || {}).id === id) S.ph.pop(); const p = byId(id); toast(p ? boardLine(p) : esc(e.message)); render(); } } }
    loadingRec = null;
  }
  const reqFor = (id) => S.reqs.some((r) => r.pid === id && isOpenReq(r) && (r.acceptedBy === 'me' || (!r.acceptedBy && r.type !== 'imaging' && canAccept(r))));
  const boardLine = (p) => `${esc(p.name)}${p.room ? `, ${esc(p.room)}` : ''}: ${esc(status(p).toLowerCase())}${p.nurse && p.nurse !== 'me' ? ` · with ${esc(first(p.nurse))}` : ''}. You can't open their record.`;
  const canDo = (p, k) => { const r = RECS[p.id]; return r ? r.can[k] !== false : true; };

  // ---------- small pieces the screens use ----------
  const log = (p, t) => (p.log = p.log || []).push({ at: new Date(), t });
  const outName = (k) => ({ lbbs: 'Left before being seen', ended: 'Closed at end of session', died: 'Deceased', transferred: 'Transferred' }[k] || (D.OUTCOMES.find((o) => o[0] === k) || [0, k])[1]);
  const teamsArg = (t) => (t && t.length ? t : ['Any']);
  // Reception can change the colour while the patient is still on the desk side; once a nurse is with them, the nurse owns it.
  const deskOwnsColour = (p) => p.stage === 'checkin' || p.stage === 'queue' || (p.stage === 'care' && (p.phase === 'assigned' || p.phase === 'called'));
  function editBox(p) { const own = deskOwnsColour(p), tm = teamsOf(p), lock = p.stage === 'care' && p.phase !== 'assigned' && p.phase !== 'called';
    return `<div class="sendbox edit-box"><div class="ma-h"><b>Edit ${esc(p.name)}</b><button type="button" class="btn small" data-a="editx">Done</button></div>
      <div class="f"><span>Teams <em>${lock ? 'a nurse has them: you can add a team (it becomes a request), not remove one' : 'first = main team'}</em></span><div class="chips">${[...D.CARE_DEPTS.map((x) => x[0]), 'Any'].map((t) => { const i = tm.indexOf(t);
        return `<button type="button" class="chip team${i >= 0 ? ' on' : ''}" aria-pressed="${i >= 0}" style="--dc:${deptColour(t)}" data-eteam="${t}"${lock && (i >= 0 || t === 'Any') ? ' disabled' : ''}>${t === 'Any' ? 'Any team' : t}${i === 0 && t !== 'Any' && tm.length > 1 ? ' <i>main</i>' : ''}</button>`; }).join('')}</div></div>
      ${own ? `<div class="f"><span>Triage colour</span>${urgPicker(p.urgency, 'data-ecol')}</div>${colourQs('data-ecol')}` : `<div class="f"><span>Triage colour</span><div class="urg-now">${upill(p.urgency)}<span class="muted small">${esc(first(p.nurse))} is with them, so the nurse owns the colour now.</span></div></div>`}</div>`; }
  function editTeam(p, t) { const lock = p.stage === 'care' && p.phase !== 'assigned' && p.phase !== 'called';
    if (lock && (teamsOf(p).includes(t) || t === 'Any')) return;
    let next = toggleTeam(teamsOf(p), t); if (!next.length) next = ['Any'];
    call('chart_set_team', { p_case: p.id, p_teams: next }, `${esc(p.name)}: ${esc(next.join(' + '))}.`); }
  function editColour(p, n) { if (!deskOwnsColour(p) || n === p.urgency) return;
    call('chart_colour', { p_case: p.id, p_esi: n, p_reason: 'Changed by Reception' }, `${esc(p.name)} is now ${esc(U(n).name)}.`); }

  const act = {
    add(d) {
      call('chart_checkin', { p_patient: { name: d.name.trim(), roblox_username: d.roblox.trim() || null, age: d.age ? +d.age : null, symptoms: d.symptoms.slice(), ...(d.pain != null ? { pain: d.pain } : {}), ...(d.onset ? { onset: d.onset } : {}), ...((d.care || '').trim() ? { care_notes: d.care.trim() } : {}) },
        p_source: S.role === 'reception' || S.role === 'super' ? 'desk' : 'walk_in', p_esi: d.urgency, p_teams: teamsArg(d.teams) },
        `${esc(d.name.trim())} checked in · send them to ${esc(D.WAITING_ROOM)}.`);
      S.draft = { name: '', roblox: '', age: '', symptoms: [], urgency: null, teams: [] }; S.npOpen = false;
    },
    confirm(p, colour) { S.confirmFor = null;
      call('chart_confirm_online', { p_case: p.id, p_esi: colour, p_teams: teamsArg(S.cdept[p.id] || p.teams), p_child: !!(p.child || isChild(p)) }, `${esc(p.name)} confirmed and in the queue.`); },
    gotIt(p) { call('chart_got_it', { p_case: p.id }, `Accepted: ${esc(p.name)}${p.room ? ', ' + esc(shortBed(p.room)) : ''}.`); },
    calledOut(p, undo) { call('chart_called_out', { p_case: p.id, p_undo: !!undo }, undo ? 'Called in: undone.' : `${esc(p.name)} called in · <button type="button" class="toast-undo" data-undocall="${p.id}">Undo</button>`); },
    withPatient(p) { return call('chart_with_patient', { p_case: p.id }, `You're with ${esc(p.name)}.`); },
    noShow(p) { call('chart_no_show', { p_case: p.id }, `${esc(p.name)}: no show recorded.`); },
    ready() { call('chart_ready', { p_on: true }, (r) => (r.need_room ? 'Pick your room first.' : superOn() ? 'You’re Ready. The supervisor will give you your next patient.' : 'You’re Ready.'),
      { need_room: () => { S.pick = true; toast('Pick your room first.'); } }).then((r) => { if (r && r.need_room) { S.pick = true; render(); } }); },
    notReady() { call('chart_ready', { p_on: false }); },
    stayReady() { call('chart_stay_ready', {}, 'Still Ready.'); },
    bump(p) { call('chart_prioritise', { p_case: p.id, p_on: !p.bumped }, p.bumped ? 'Priority removed.' : `${esc(p.name)} prioritised.`); },
    recheck(p, colour) { S.recheckFor = null; call('chart_colour', { p_case: p.id, p_esi: colour, p_reason: 'Re-checked while waiting' }, `${esc(p.name)} re-checked: ${esc(U(colour).name)}.`); },
    handback(p, note) { S.handbackFor = null; if (S.open === p.id) S.open = null; return call('chart_hand_back', { p_case: p.id, p_note: String(note || '').trim() }, `${esc(p.name)} handed over.`); },
    // Discharge (FLOW-AUDIT §3). The details v1 has no argument for (admitted to, left AMA, forced) go on the record as a note first.
    async leave(p, outcome, forced) {
      const lv = { ...S.lv };
      try {
        await touch(p);
        if (outcome === 'left') await rpc('chart_left', { p_case: p.id, p_kind: 'left_during_care', p_note: (lv.left || '').trim() });
        else await rpc('chart_discharge', { p_case: p.id, p_outcome: { home: 'home', follow: 'follow_up', admit: 'admitted', transferred: 'transferred' }[outcome],
          p_follow_up: (lv.follow || '').trim() || null, p_advice: (p.advice || '').trim() || null, p_admitted_to: outcome === 'admit' ? (lv.admit || '').trim() || null : null, p_forced: !!forced });
        Object.assign(S, { tab: 'chart', outcome: null, open: null, lv: {}, forceAsk: false });
        toast(outcome === 'left' ? `${esc(p.name)}: left against medical advice.` : `${esc(p.name)} ${outcome === 'admit' ? 'admitted' : 'discharged'}. Hand over the discharge papers in game.`);
      } catch (e) { if (e.hint === 'min_record') { S.forceAsk = true; render(); return; } toast(esc(e.message)); }
      await poll(true);
    },
    async death(p, d) {
      const [h, m] = String(d.time || '').split(':').map(Number), t = new Date(); if (!isNaN(h)) t.setHours(h, m || 0, 0, 0);
      try { await rpc('chart_left', { p_case: p.id, p_kind: 'died', p_note: d.note.trim(), p_time_of_death: t.toISOString(), p_confirmed_by: idOf(d.by) });
        Object.assign(S, { tab: 'chart', outcome: null, open: null, lv: {}, dth: {}, deathFor: null }); toast(`Death recorded for ${esc(p.name)}.`); }
      catch (e) { toast(esc(e.message)); }
      await poll(true);
    },
    checkedOut(p) { const c = S.checkout[p.id] || {};
      call('chart_aftercare', { p_case: p.id, p_follow_up: (c.follow || '').trim() || null, p_papers: true, ...(!p.rating && c.rating ? { p_rating: c.rating } : {}) }, `Done: ${esc(p.name)}'s visit is complete.`)
        .then((r) => { if (r) p.deskDone = true; render(); }); },
    lbbs(p) { call('chart_left', { p_case: p.id, p_kind: 'left_before_seen' }, `${esc(p.name)}: left before being seen.`); },
    npc(name, bed) { const syms = ((S.npc || {}).symptoms || []).slice(); S.npc = null; call('chart_checkin', { p_patient: { name: (name || '').trim() || 'NPC patient', symptoms: syms, bed: bedId(bed) }, p_source: 'npc', p_esi: 4, p_teams: ['Any'] }, `NPC logged in ${esc(bed)}. It counts towards your ${D.LIMIT}.`); },
  };

  // ---------- requests (OPERATIONS.md §4) ----------
  const REQ = { doctor: ['Doctor', 'A doctor comes to the room to review'], surgery: ['Surgery', 'A surgeon comes down, or takes them to surgery'],
    imaging: ['Imaging', 'You take them to Radiology yourself. The bed stays yours and shows Off the ward'], help: ['Assistance', 'Another pair of hands'] };
  // The server decides; this only hides buttons that would certainly be refused.
  const canAccept = (r, sid = 'me') => { const role = roleOf(sid), dept = staffDept(sid);
    if (r.type === 'help') return role === 'room' || role === 'oncall';
    if (r.type === 'doctor') return (role === 'oncall' && dept === 'Medical') || role === 'super';
    if (r.type === 'surgery') return role === 'oncall' && dept === 'Surgical';
    return false; };
  // grey, then amber at 3 min (straight away for a Red patient), then "stuck" at 8 min. Accepted: amber at 5 min, late at 10.
  const reqLevel = (r) => { const p = byId(r.pid);
    if (r.type === 'imaging') return 'ok';
    if (r.acceptedBy) return r.hereAt ? 'ok' : since(r.acceptedAt) >= SEC(600) ? 'late' : since(r.acceptedAt) >= SEC(300) ? 'amber' : 'ok';
    if (since(r.at) >= SEC(480)) return 'stuck';
    return since(r.at) >= SEC(180) || r.red || (p && p.urgency === 1) ? 'amber' : 'grey'; };
  const req = {
    async ask(p, type, note, mode) {
      S.reqMenu = false; S.rq = null;
      if (type === 'code') { call('chart_code', { p_case: p.id }, `<b>Code Blue</b> called for ${esc(p.name)}. Press the Code button in game too: it starts CPR.`); return; }
      const dup = S.reqs.find((x) => x.pid === p.id && x.type === type && isOpenReq(x)); if (dup) { toast(`A ${REQ[type][0].toLowerCase()} request is already open.`); S.rq = type; return; }
      await touch(p);
      await call('chart_request', { p_case: p.id, p_kind: type, p_note: (note || '').trim() || null, ...(type === 'surgery' ? { p_surgery_mode: mode === 'take' ? 'take_to_surgery' : 'come_down' } : {}) },
        type === 'imaging' ? `Take ${esc(p.name)} to Radiology. The bed stays yours.` : `Asked for ${esc(REQ[type][0].toLowerCase())}. Keep going with ${esc(p.name)} while you wait.`);
      if (type === 'imaging') call('chart_off_ward', { p_case: p.id, p_place: 'Radiology' });
    },
    accept(r) { const p = byId(r.pid); return call('chart_request_accept', { p_id: r.id }, `Accepted: room ${esc(roomIdOf(p && p.room) || '?')}, ${esc(p ? p.name : '')}.`); },
    here(r) { call('chart_request_here', { p_id: r.id }, 'You’re at the bedside.'); },
    done(r, text) {
      if (r.type === 'imaging') { const p = byId(r.pid); call('chart_off_ward', { p_case: r.pid, p_place: null }).then(() => call('chart_request_cancel', { p_id: r.id, p_reason: 'Back on the ward' })); return; }
      call('chart_request_done', { p_id: r.id, p_note: (text || '').trim() || null }, 'Consult finished.'); },
    cancel(r, why) { call('chart_request_cancel', { p_id: r.id, p_reason: why || null }, 'Request cancelled.'); },
    again(r) { call('chart_request_reopen', { p_id: r.id }, 'The request is open again for anyone to take.'); },
    transfer(r) { call('chart_transfer', { p_case: r.pid, p_to: idOf(r.acceptedBy), p_off_ward: 'Pre-Op' }, 'Transferred: take them to Pre-Op (2nd floor).'); },
    send(r, sid) { call('chart_request_send', { p_id: r.id, p_person: idOf(sid) }, `Sent to ${esc((staff(sid) || {}).name || '')}. It's still their choice to accept.`); },
    chase(r) { call('chart_request_chase', { p_id: r.id }, 'Chased: on-call staff alerted again.'); },
  };

  function pickRole(r, dept) {
    call('chart_role_set', { p_role: ROLE_OUT[r] || null, p_department: dept || null },
      { reception: 'You’re on Reception.', room: `You’re on Room · ${esc(dept || '')}.`, oncall: `You’re On call · ${esc(dept || '')}.`, road: 'You’re on Road.', super: 'You’re supervising from the floor plan.' }[r] || '',
      { hold_patients: (e) => { S.endShift = true; toast(esc(e.message)); }, })
      .then((res) => { if (!res) return;
        Object.assign(S, { open: null, face: null, roomPanel: null, endShift: false, reqMenu: false, pick: !!res.need_room });
        S.sec = SECTIONS[r][0][0]; S.ph = [{ s: isPhone() && r === 'super' ? 'board' : S.sec }]; S.deskTab = r === 'reception' ? 'checkin' : 'queue'; render(); });
  }
  // Ends the site shift too (the same shift_end the top bar uses), then shows Shift Manager.
  const endMyShift = async () => { S.endShift = false; const { error } = await sb.rpc('shift_end'); if (error) toast(`Handed over. ${esc(error.message || 'End your shift in Shift Manager.')}`); else toast('Handed over and clocked out.');
    if (typeof window.deskRefresh === 'function') window.deskRefresh(); location.hash = '#shifts'; };
  const leaveRole = () => call('chart_role_set', { p_role: null }, '', { hold_patients: (e) => { S.endShift = true; toast(esc(e.message)); } });
  // Room picking: tap beds to choose (up to 2), then Done sends them in one go.
  const pickSelNow = () => S.pickSel || bedsOf('me');
  function pickBed(bed) {
    const sel = S.pickSel || (S.pickSel = bedsOf('me').slice()), o = ownerOf(bed);
    if (sel.includes(bed)) { const p = roomsInUse()[bed]; if (p && p.nurse === 'me') { toast('You have a patient in that bed.'); return; } S.pickSel = sel.filter((b) => b !== bed); return; }
    if (o && o !== 'me') { toast(`${esc((staff(o) || {}).name || 'Someone')} has ${esc(bed)}.`); return; }
    const no = bedUsable(bed); if (no) { toast(`${esc(no)}.`); return; }
    if (sel.length >= D.LIMIT) { toast(`You can have ${D.LIMIT} beds. Tap one of yours to let it go first.`); return; }
    S.pickSel = [...sel, bed]; if (kidsOnly(bed)) toast(`${esc(bed)} is Paediatric: you'll get patients under 18 there.`);
  }
  async function pickDone() {
    const want = (S.pickSel || []).slice(), have = bedsOf('me');
    if (!want.length) { toast('Pick at least one bed.'); return; }
    if (want.length === have.length && want.every((b) => have.includes(b))) { S.pick = false; S.pickSel = null; render(); return; }
    try { if (have.length) await rpc('chart_leave_beds', {}); await rpc('chart_take_beds', { p_beds: want.map(bedId) }); S.pick = false; S.pickSel = null; toast(`Your room: ${esc(want.join(', '))}. Press Ready when you're free.`); }
    catch (e) { toast(esc(e.message)); }
    await poll(true);
  }
  // Supervisor actions on people and rooms (§5)
  function setRole(sid, k, sure) { const m = mine(sid), cur = S.staffRole[sid]; if (!k || k === cur) return;
    if (m.length && !sure) { S.roleAsk = k; return; }
    S.roleAsk = null;
    call('chart_set_role_for', { p_person: idOf(sid), p_role: ROLE_OUT[k] || null, ...(m.length ? { p_hand_back_note: `${first(sid)}'s role was changed by the supervisor` } : {}) },
      `${esc((staff(sid) || {}).name || '')} is now ${esc(ROLE_NAME[k] || 'Off the Chart')}.${m.length ? ' Their patients are back in the queue, in their beds.' : ''}`); }
  function gone(sid) { S.face = null; call('chart_theyve_gone', { p_person: idOf(sid) }, `${esc((staff(sid) || {}).name || '')} marked as gone. Their patients are first in the queue.`); }
  function giveRoom(sid, id, move) {
    if (S.roomCfg[id] && S.roomCfg[id].closed) { toast(`Room ${esc(id)} is closed${S.roomCfg[id].why ? ': ' + esc(S.roomCfg[id].why) : ''}.`); return; }
    const take = D.BEDS.filter((b) => roomIdOf(b) === id && !bedUsable(b) && (!ownerOf(b) || ownerOf(b) === sid)).slice(0, D.LIMIT);
    if (!take.length) { toast(`Every bed in ${esc(id)} already has someone.`); return; }
    const withP = bedsOf(sid).filter((b) => roomIdOf(b) !== id && roomsInUse()[b]);
    if (withP.length && !move) { S.pendRoom = { sid, id }; return; }
    S.pendRoom = null;
    call('chart_give_room', { p_person: idOf(sid), p_beds: take.map(bedId), p_move_patients: !!move }, `${esc((staff(sid) || {}).name || '')} now has ${esc(take.join(' and '))}.`);
  }
  function giveTo(p, sid, bed, force) {
    S.teamWarn = null;
    return call('chart_assign', { p_case: p.id, p_bed: bedId(p.room || bed), p_person: idOf(sid), p_override: !!force },
      `${esc(p.name)} given to ${esc((staff(sid) || {}).name || '')}. They have a minute to accept.`,
      { not_their_team: () => { S.teamWarn = { pid: p.id, sid, bed }; } });
  }
  const teamWarnPanel = () => { if (!S.teamWarn) return ''; const w = S.teamWarn, p = byId(w.pid), x = staff(w.sid) || {}; if (!p) return '';
    return `<div class="move-ask warn-ask" role="alertdialog" aria-label="Not their team"><b>Not their team</b><span>${esc(p.name)}'s main team is <b>${esc(teamsOf(p)[0])}</b>. ${esc(x.name || '')} is working <b>${esc(staffDept(w.sid) || '')}</b>. Give them anyway?</span>
      <div class="row-btns"><button type="button" class="btn warn" data-a="twyes">Give anyway</button><button type="button" class="btn ghost" data-a="twno">Cancel</button></div></div>`; };
  function dropOnBed(pid, bed) {
    const p = byId(pid), o = ownerOf(bed), other = roomsInUse()[bed];
    const no = dropWhy(p, bed); if (no) { toast(`${esc(no)}.`); return; }
    if (p.stage === 'queue' && !p.room && !other) {
      if (!o) { S.who = { pid, bed }; return; }
      giveTo(p, o, bed); return; }
    planMove(pid, bed);
  }
  function dropOnPerson(pid, sid) {
    const p = byId(pid);
    if (p.stage !== 'queue') { toast(`${esc(p.name)} is already with ${esc(first(p.nurse))}. Drag them onto a bed to move them.`); return; }
    const bed = p.room || bedPick(p, sid);
    if (!bed) { toast(`${esc((staff(sid) || {}).name || '')} has no free bed${bedsOf(sid).length ? ' that fits' : ': drag them onto a room first'}.`); return; }
    giveTo(p, sid, bed);
  }
  function endSession() { S.endSess = false; call('chart_session_end', { p_close_all: true }, (r) => `Session ended. ${(r.open || []).length} open case${(r.open || []).length === 1 ? '' : 's'} closed as Closed at end of session. Nothing was deleted.`); }
  function handover(id) { S.incDone = true; call('chart_handover', { p_case: id, p_note: 'Handed over at the ER' }, 'Handed over: they’re in the queue with your colour and note.'); }
  function roomSet(id, ch) { const c = S.roomCfg[id] || {};
    const next = { p_room: id, p_department: S.roomDept[id], p_who: c.kids ? 'kids' : c.adults ? 'adults' : 'anyone', p_closed: !!c.closed, p_closed_reason: c.why || null, ...ch };
    return call('chart_room_set', next, ch.p_closed === true ? `Room ${esc(id)} is closed. Nobody can take it.` : ch.p_closed === false ? `Room ${esc(id)} is open again.` : `Room ${esc(id)} updated.`); }

  // ---------- shared pieces ----------
  const teamPick = (sel, attr) => `<div class="chips" role="group" aria-label="Teams">${[...D.CARE_DEPTS.map((x) => x[0]), 'Any'].map((t) => { const i = sel.indexOf(t);
    return `<button type="button" class="chip team${i >= 0 ? ' on' : ''}" aria-pressed="${i >= 0}" style="--dc:${deptColour(t)}" ${attr}="${t}">${t === 'Any' ? 'Any team' : t}${i === 0 && t !== 'Any' && sel.length > 1 ? ' <i>main</i>' : ''}</button>`; }).join('')}</div>`;
  const chip = (label, on, attr) => `<button type="button" class="chip${on ? ' on' : ''}" aria-pressed="${!!on}" ${attr}>${esc(label)}</button>`;
  const urgPicker = (sel, attr) => `<div class="upick" role="radiogroup" aria-label="Colour">${[1, 2, 3, 4, 5].map((n) => `<button type="button" role="radio" aria-checked="${sel === n}" class="${sel === n ? 'on' : ''}" style="--u:${U(n).colour};--ui:${U(n).ink}" ${attr}="${n}"><b>${U(n).name}</b><span>${U(n).label}</span><small>${U(n).what} ${U(n).within}.</small></button>`).join('')}</div>
    <p class="explain">${sel ? `<b>${U(sel).name} · ${U(sel).label}:</b> ${U(sel).what} ${U(sel).within}.` : 'Tap a colour, or answer the questions below. Each colour says how soon they should be seen.'}</p>`;
  const colourQs = (attr) => `<div class="cq"><span>Not sure? Ask these, top to bottom. The first “yes” is the colour.</span>${D.COLOUR_QUESTIONS.map(([n, q]) => `<button type="button" class="cq-q" style="--u:${U(n).colour}" ${attr}="${n}"><i></i><span>${esc(q)}</span><b>${U(n).name}</b></button>`).join('')}</div>`;
  const careTag = (p) => (p.careNotes ? `<span class="care-note" title="Care notes">${esc(p.careNotes)}</span>` : '');
  const pnameRow = (p, extra = '') => `<div class="wl-m"><b>${esc(p.name)}${careTag(p)}${p.stage === 'checkin' ? '' : teamChips(p)}${flags(p)}</b><small>${upill(p.urgency)} ${esc(p.symptoms.join(', ') || (p.symKnown ? 'No symptoms given' : ''))}${extra}</small></div>`;
  // Waiting in a room for someone to take them: their own colour stays, plus a small pulsing bell (owner, 19 Nov 2026).
  const bell = '<span class="wait-bell" role="img" aria-label="Waiting for someone to take them" title="Waiting for someone to take them"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg></span>';
  const handbackFlag = (p) => (p.handback && p.room ? `<div class="wir" style="--u:${U(p.urgency).colour}"><b>${bell}Waiting in ${esc(p.room || 'their room')}</b><span>Handed over by ${esc(first(p.handback.by))} ${ago(p.handback.at)} ago: “${esc(p.handback.note)}”</span></div>` : '');
  const vitalCards = (p) => { const l = latest(p); if (!p.vitals.length) return '<p class="muted">No numbers yet. Add them from the monitor.</p>';
    return `<div class="vgrid">${D.VITALS.filter((v) => v.key !== 'dia' && l[v.key] != null).map((v) => { const val = v.key === 'sys' ? `${l.sys}/${l.dia ?? '–'}` : l[v.key];
      return `<div class="vcard ${vstate(v, l[v.key])}"><small>${v.key === 'sys' ? 'Blood pressure' : v.name}</small><b>${esc(val)}<i>${v.unit}</i></b><em>${vrange(v, l[v.key], v.key === 'sys' ? '90/60–120/80' : `${v.lo}–${v.hi}`)}</em></div>`; }).join('')}</div>`; };
  const vitalForm = () => `<div class="vform">${D.VITALS.map((v) => { const val = S.vdraft[v.key] ?? ''; return `<label class="vin ${vstate(v, val)}"><span>${v.name} <i>${v.unit}</i></span><input type="number" inputmode="decimal" step="${v.step || 1}" data-v="${v.key}" value="${esc(val)}" placeholder="–"><small>${vrange(v, val, `${v.lo}–${v.hi}`)}</small></label>`; }).join('')}</div>
    <button type="button" class="btn" data-a="vsave">Save numbers</button>`;
  const byWho = (c) => (c.by === 'desk' ? 'front desk' : c.by === 'self' ? 'the patient (online)' : first(c.by));
  const colourHistory = (p) => `<ol class="tl">${p.colourLog.map((c) => `<li><time>${clock(c.at)}</time><span>${c.confirm ? 'Confirmed' : c.from && c.from !== c.to ? `${esc(U(c.from).name)} → ` : 'Set to '}<b>${esc(U(c.to).name)}</b> · ${esc(byWho(c))}${c.note ? ' · ' + esc(c.note) : ''}</span></li>`).join('')}</ol>`;
  const timeline = (p) => { const ev = [{ at: p.arrived, t: p.source === 'online' ? 'Checked in online' : 'Checked in at the front desk' },
      ...p.colourLog.map((c) => ({ at: c.at, t: `Colour ${c.confirm ? 'confirmed' : 'set'}: ${U(c.to).name} · ${byWho(c)}` })),
      ...(p.takenAt && !(p.log || []).length ? [{ at: p.takenAt, t: `Taken by ${first(p.nurse) || 'staff'}` }] : []), ...(p.log || []),
      ...(p.consults || []).map((c) => ({ at: c.at, t: `${REQ[c.type][0]} · ${first(c.by)}${c.text ? ': ' + c.text : ''}` })),
      ...(p.moves || []).map((m) => ({ at: m.at, t: `${m.how === 'swapped' ? 'Swapped' : 'Moved'} ${m.from ? 'from ' + m.from + ' ' : ''}to ${m.to || 'Up next'} · ${first(m.by)}` })),
      ...p.vitals.map((v) => ({ at: v.at, t: `Numbers taken · ${first(v.by)}` })), ...p.did.map((d) => ({ at: d.at, t: `${d.what} · ${first(d.by)}` })),
      ...p.orders.map((o) => ({ at: o.at, t: `Asked for ${o.what} · ${first(o.by)}` })), ...p.orders.filter((o) => o.done).map((o) => ({ at: o.done, t: `${o.what} done · ${first(o.doneBy)}${o.result ? ' · ' + o.result : ''}` }))]
      .sort((a, b) => new Date(a.at) - new Date(b.at));
    return `<ol class="tl">${ev.map((e) => `<li><time>${clock(e.at)}</time><span>${esc(e.t)}</span></li>`).join('')}</ol>`; };
  const ratingRO = (p) => `<div class="stars ro" role="img" aria-label="${p.rating} of 5">${[1, 2, 3, 4, 5].map((n) => `<span class="${p.rating >= n ? 'on' : ''}">★</span>`).join('')}</div>`;
  const ratingField = (p, c) => (p.rating
    ? `<div class="f"><span>How was their visit? <em class="rated">${p.ratedBy === 'desk' ? 'Entered by Reception for the patient' : 'Rated by the patient'} · locked</em></span>${ratingRO(p)}</div>`
    : `<div class="f"><span>How was their visit? <em>ask them, 1 to 5. Saved for good when you press Checked out</em></span><div class="stars">${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="${c.rating >= n ? 'on' : ''}" data-star="${p.id}" data-v="${n}" aria-label="${n} of 5">★</button>`).join('')}</div></div>`);
  const papers = (p, outcome, follow) => `<div class="papers"><div class="pp-head"><img src="assets/cbh-icon.svg" alt="" width="22" height="22"><b>CareBeyond Hospital</b><span>Discharge papers</span></div>
    <dl><dt>Patient</dt><dd>${esc(p.name)}${p.age ? ', ' + p.age : ''}${p.roblox ? ' · @' + esc(p.roblox) : ''}</dd><dt>Visit</dt><dd>Arrived ${clock(p.arrived)} · ${ago(p.arrived)}</dd>
    <dt>What was wrong</dt><dd>${esc(p.diagnosis || 'Not decided')}${p.urgency ? ' · ' + esc(U(p.urgency).name) : ''}</dd>
    <dt>What we did</dt><dd>${esc([...p.did.map((d) => d.what), ...p.orders.filter((o) => o.done).map((o) => o.what)].join(', ') || 'Nothing recorded')}</dd>
    <dt>Outcome</dt><dd>${outcome ? esc(outName(outcome)) : 'Pick one above'}</dd>${p.advice ? `<dt>Advice</dt><dd>${esc(p.advice)}</dd>` : ''}${follow ? `<dt>Follow-up</dt><dd>${esc(follow)}</dd>` : ''}
    <dt>Treated by</dt><dd>${esc([p.nurse && title(p.nurse), p.doctor && first(p.doctor)].filter(Boolean).join(' · ') || '–')}</dd></dl></div>`;
  // ---------- COMPUTER sections ----------
  function deskSection() {
    if (S.deskBy !== 'me' && S.role !== 'super') return `<div class="pane-pad"><div class="closed-desk">
      <div class="cd-ic" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 18h16M6 18V9h12v9M9 9V6h6v3"/></svg></div>
      <h2>Front Desk</h2><p>${S.deskBy ? `${esc(first(S.deskBy))} is on the desk.` : 'Nobody is on the desk right now.'} Anyone on shift can work it, like the receptionist in game: check people in and set their colour, call them in when someone takes them, and check them out.</p>
      <button type="button" class="btn big" data-a="deskOn">Work the front desk</button>
      <p class="muted small">While nobody is on the desk, online check-ins join Up next with the colour they picked, and staff call their own patients in.</p></div></div>`;
    const tabs = [['checkin', 'Check in', toConfirm().length], ['queue', 'Up next', upNext().length], ['checkout', 'After-care', 0]];
    let body = '';
    if (S.deskTab === 'checkin') body = `${S.npOpen ? newPatient() : '<button type="button" class="btn" data-a="npopen">+ Walk-in patient</button>'}
      <section class="card"><div class="card-head"><h3>Checked in online <span class="count">${toConfirm().length}</span></h3>${S.online ? '' : '<span class="tag-warn">Online check-in closed: walk-ins only</span>'}</div>
        ${toConfirm().length ? `<ul class="wlist">${toConfirm().map((p) => `<li style="--u:#9aa9c4"><span class="ubar"></span>${pnameRow(p, ` · said “${esc(p.said || '–')}” · suggested ${esc(U((p.suggestedEsi || fromSaid[p.said] || 4)).name)}`)}<span class="wl-t" data-since="${new Date(p.arrived).toISOString()}">${ago(p.arrived)}</span>
          <span class="row-btns"><button type="button" class="btn small" data-cconf="${p.id}" data-c="${(p.suggestedEsi || fromSaid[p.said] || 4)}">Confirm ${esc(U((p.suggestedEsi || fromSaid[p.said] || 4)).name)}</button><button type="button" class="btn small ghost" data-confirm="${p.id}">Change</button></span>${S.confirmFor === p.id ? `<div class="sendbox"><div class="f"><span>Which teams? <em>first = main</em></span>${teamPick(S.cdept[p.id] || [], `data-cdeptp="${p.id}" data-v`)}</div><div class="f"><span>Set their colour</span>${urgPicker(null, `data-cconf="${p.id}" data-c`)}</div>${colourQs(`data-cconf="${p.id}" data-c`)}</div>` : ''}</li>`).join('')}</ul>`
          : '<p class="muted">Nobody to confirm. Online check-ins appear here.</p>'}</section>`;
    if (S.deskTab === 'queue') body = `<section class="card"><div class="card-head"><h3>Up next <span class="count">${upNext().length}</span></h3><span class="muted small">Prioritised first, then colour, then longest wait.</span></div>
      ${upNext().length ? `<ol class="wlist qlist">${upNext().map((p, i) => `<li style="--u:${U(p.urgency).colour}" class="${p.handback ? 'hb' : ''}"><span class="qn">${i + 1}</span>${pnameRow(p, ` · ${p.room ? `${bell}<b class="wir-inline">Waiting in ${esc(p.room)}</b>` : `in ${esc(D.WAITING_ROOM)}`}${p.bumped ? ' · <b>prioritised</b>' : ''}${p.lost ? ' · <b>needs a new nurse</b>' : ''}${p.flag ? ' · <b>handed over 3 times</b>' : ''}`)}
        <span class="wl-t ${tooLong(p) ? 'late' : ''}" data-since="${new Date(p.queuedAt).toISOString()}">${ago(p.queuedAt)}</span>
        <span class="row-btns">${tooLong(p) ? `<button type="button" class="btn small warn" data-recheck="${p.id}">Re-check</button>` : ''}<button type="button" class="btn small ghost" data-bump="${p.id}">${p.bumped ? 'Remove priority' : 'Prioritise'}</button><button type="button" class="btn small ghost" data-lbbs="${p.id}">Left before being seen</button><button type="button" class="btn small ghost" data-edit="${p.id}">Edit</button></span>
        ${handbackFlag(p)}${S.editFor === p.id ? editBox(p) : ''}${S.recheckFor === p.id ? `<div class="sendbox"><div class="f"><span>They've waited ${ago(p.queuedAt)}. Ask how they are now: has the colour changed?</span>${urgPicker(p.urgency, `data-rc="${p.id}" data-c`)}</div></div>` : ''}</li>`).join('')}</ol>`
        : '<p class="muted">Nobody is waiting.</p>'}</section>
      ${(() => { const cl = P().filter((x) => x.stage === 'care' && x.phase === 'called' && x.calledOut); return cl.length ? `<section class="card"><div class="card-head"><h3>Called in <span class="count">${cl.length}</span></h3><span class="muted small">Until the nurse has them</span></div><ul class="wlist">${cl.map((x) => `<li style="--u:${U(x.urgency).colour}"><span class="ubar"></span>${pnameRow(x, ` · ${esc(x.room)} · ${esc(title(x.nurse))}`)}<span class="wl-t">Called ${elapsed(x.calledOutAt || x.calledAt)}</span></li>`).join('')}</ul></section>` : ''; })()}
      ${inCare().filter((p) => !callOuts().includes(p)).length ? `<details class="card with-staff"${S.editFor && byId(S.editFor) && byId(S.editFor).stage === 'care' && !callOuts().includes(byId(S.editFor)) ? ' open' : ''}><summary><h3>With staff <span class="count">${inCare().filter((p) => !callOuts().includes(p)).length}</span></h3><span class="muted small">Edit to add a team</span></summary>
        <ul class="wlist">${inCare().filter((p) => !callOuts().includes(p)).map((p) => `<li style="--u:${U(p.urgency).colour}"><span class="ubar"></span>${pnameRow(p, ` · ${esc(p.room || p.where || '')} · ${esc(first(p.nurse))} · ${esc(status(p))}`)}<span></span><span class="row-btns"><button type="button" class="btn small ghost" data-edit="${p.id}">Edit</button></span>${S.editFor === p.id ? editBox(p) : ''}</li>`).join('')}</ul></details>` : ''}`;
    if (S.deskTab === 'checkout') body = `<p class="muted small">Discharged patients. Their case is already closed: open one only if they come back to the desk.</p>` + (checkouts().length ? checkouts().map((p) => { const c = S.checkout[p.id] || (S.checkout[p.id] = { follow: '', rating: 0 });
      if (S.backFor !== p.id) return `<section class="card cb-row"><div><b>${esc(p.name)}</b> <small class="muted">${esc(outName(p.outcome))} · discharged by ${esc(title(p.nurse))} · ${ago(p.closedAt || p.arrived)} ago${p.papersGiven ? ' · papers given' : ''}${p.rating ? ' · rated ' + p.rating + '/5' : ''}</small></div><button type="button" class="btn small ghost" data-back="${p.id}">Came back to the desk</button></section>`;
      return `<section class="card"><div class="card-head"><h3>${esc(p.name)} <small>discharged by ${esc(title(p.nurse))} · ${ago(p.closedAt || p.arrived)} ago</small></h3><button type="button" class="link" data-back="${p.id}">Close</button></div>${papers(p, p.outcome, c.follow)}
        <div class="f"><span>Follow-up <em>(optional)</em></span>${c.follow ? `<span class="res-v">${esc(c.follow)} <button type="button" class="link" data-furm="${p.id}">Change</button></span>` : fbox('fu' + p.id, 'follow', '', 'e.g. come back if it gets worse', 'Save')}</div>
        ${ratingField(p, c)}
        <div class="row-btns"><button type="button" class="btn" data-out-done="${p.id}">Done</button></div></section>`; }).join('') : '<section class="card"><p class="muted">Nobody discharged yet.</p></section>');
    const calls = callOuts();
    return `<div class="pane-pad desk"><div class="pane-head"><div><h2>Front Desk</h2><p class="muted">${S.role === 'super' ? (S.deskBy ? `${esc(first(S.deskBy))} is on Reception; you can help` : 'Nobody is on Reception: the waiting list is yours') : 'You\u2019re on Reception'} · ${upNext().length} waiting in ${esc(D.WAITING_ROOM)}</p></div></div>
      ${incomingStrip()}${bedStrip()}
      ${calls.length ? `<section class="callouts" aria-label="Call them in">${calls.map((p) => `<div class="callout" style="--u:${U(p.urgency).colour}"><span class="co-say">Call them in · say in game</span><b>“${esc(say(p))}”</b><span class="row-btns"><button type="button" class="btn ghost" data-edit="${p.id}">Edit</button><button type="button" class="btn" data-called="${p.id}">Called in</button></span>${S.editFor === p.id ? editBox(p) : ''}</div>`).join('')}</section>` : ''}
      <div class="dtabs" role="tablist">${tabs.map(([k, l, n]) => `<button type="button" role="tab" aria-selected="${S.deskTab === k}" data-dtab="${k}">${l}${n ? ` <i class="${k !== 'queue' ? 'red' : ''}">${n}</i>` : ''}</button>`).join('')}</div>${body}</div>`;
  }
  function newPatient() {
    const d = S.draft, ok = d.name.trim() && d.urgency;
    return `<section class="card np-panel"><div class="card-head"><h3>Walk-in patient</h3><button type="button" class="link" data-a="npx">Cancel</button></div>
      <div class="row2"><label class="f"><span>Name</span><input id="d-name" value="${esc(d.name)}" placeholder="e.g. Anna S." autocomplete="off"></label>
      <label class="f"><span>Roblox username <em>optional</em></span><input id="d-roblox" value="${esc(d.roblox)}" autocomplete="off"></label></div>
      <label class="f age-f"><span>Age <em>under 18 goes to a Paediatric room</em></span><input id="d-age" type="number" inputmode="numeric" min="1" max="120" value="${esc(d.age)}" placeholder="e.g. 25"></label>
      <div class="row2"><div class="f"><span>Pain <em>0 to 10</em></span><div class="chips pain-pick">${[0, 2, 4, 6, 8, 10].map((n) => `<button type="button" class="chip${S.draft.pain === n ? ' on' : ''}" data-dpain="${n}">${n}</button>`).join('')}</div></div>
      <div class="f"><span>Started</span><div class="chips">${[['just_now', 'Just now'], ['today', 'Today'], ['days', 'Days ago'], ['longer', 'Longer']].map(([k, l]) => `<button type="button" class="chip${S.draft.onset === k ? ' on' : ''}" data-donset="${k}">${l}</button>`).join('')}</div></div></div>
      <label class="f"><span>Care notes <em>optional, e.g. uses a wheelchair, hard of hearing</em></span><input id="d-care" value="${esc(S.draft.care || '')}" maxlength="200" autocomplete="off"></label>
      <div class="f"><span>Symptoms <em>type each one, Enter to add</em></span>${tagList(d.symptoms, 'data-dsymrm')}${fbox('sym', 'sym', '', 'e.g. headache, hurt left arm', 'Add')}</div>
      <div class="f"><span>Triage colour</span>${urgPicker(d.urgency, 'data-durg')}</div><details class="cq-fold"${d.urgency ? '' : ''}><summary>Not sure? Ask these questions</summary>${colourQs('data-durg')}</details>
      <div class="f"><span>Teams <em>optional; the first is their main team</em></span>${teamPick(d.teams || [], 'data-ddept')}</div>
      <div class="np-foot"><button type="button" class="btn" data-a="add"${ok ? '' : ' disabled'}>Check in to the queue</button><span class="muted small">${ok ? `${esc(d.name.trim())} · ${esc(U(d.urgency).name)}` : 'Needs a name and a triage colour.'}</span></div></section>`;
  }
  // ---------- small shared pieces for the roles ----------
  const initial = (sid) => (staff(sid) ? nm(sid).replace('Dr. ', '')[0] : '?');
  const face = (sid) => (sid ? `<span class="face${sid === 'me' ? ' me' : ''}" title="${esc(nm(sid))}" style="--dc:${deptColour(staffDept(sid))}">${esc(initial(sid))}</span>` : '');
  // Request tags: full words; short forms only on the compact floor-plan beds, with the full word on hover.
  const RT = { doctor: 'Doctor', surgery: 'Surgery', imaging: 'Imaging', help: 'Assist' }, RTS = { doctor: 'Dr', surgery: 'Surg', imaging: 'Img', help: 'Assist' };
  const flags = (p, short) => [...reqsFor(p).map((r) => { const ok = !!r.acceptedBy, lv = reqLevel(r);
      return `<span class="rq-ic rt ${ok ? 'rt-ok' : 'rt-wait'}${lv === 'stuck' || lv === 'late' ? ' late' : ''}" title="${esc(REQ[r.type][0])}: ${r.type === 'imaging' ? 'off the ward at Radiology' : ok ? `${esc(nm(r.acceptedBy))} ${r.hereAt ? 'is here' : 'is on the way'}` : 'waiting for someone to take it'}">${(short ? RTS : RT)[r.type]}</span>`; }),
    codeFor(p) ? '<span class="rq-ic code">CODE</span>' : '', p.npc ? '<span class="rq-ic npc">NPC</span>' : ''].join('');
  const noShowBtn = (p) => (since(p.calledAt) >= SEC(300) ? `<button type="button" class="btn small warn" data-noshow="${p.id}">No show</button>` : `<span class="muted small">No show after ${countdown(p.calledAt, 300)}</span>`);
  const incomingStrip = () => { const l = S.incoming.filter((i) => !i.done); return l.length ? `<div class="inc-strip"><span>Incoming by ambulance</span>${l.map((i) => `<span class="q-chip inc ro" style="--u:${U(i.urgency).colour}"><b>${esc(i.name)}</b><small>${esc(U(i.urgency).name)} · ${since(i.at) >= SEC(i.eta * 60) ? 'arriving now' : 'ETA ' + countdown(i.at, i.eta * 60)}</small></span>`).join('')}</div>` : ''; };
  const bedStrip = () => `<div class="bed-strip" aria-label="Beds"><span>Beds</span>${D.BEDS.map((b) => { const q = roomsInUse()[b], o = ownerOf(b);
    return `<span class="bs${q ? ' used' : ''}${closedBed(b) ? ' closed' : ''}" style="${q ? `--u:${U(q.urgency).colour}` : ''}" title="${esc(b)}${o ? ' · ' + esc(nm(o)) : ' · nobody'}${q ? ' · ' + esc(q.name) : ' · free'}">${esc(b.replace(' Bed ', ''))}${o ? `<i>${esc(initial(o))}</i>` : ''}</span>`; }).join('')}</div>`;
  // ---------- THE NEXT-STEP BAR (Alpha's flow audit #1): exactly one primary, worked out from where the patient really is ----------
  const myReq = (p) => S.reqs.find((r) => r.pid === p.id && isOpenReq(r) && r.type !== 'imaging' && (r.acceptedBy === 'me' || (!r.acceptedBy && S.role === 'oncall' && canAccept(r))));
  const youAre = (sid, verb) => (sid === 'me' ? `You're ${verb}` : `${first(sid)} is ${verb}`);
  // The minimum record before Discharge is the primary (audit §3). Returns what's still missing.
  const minMissing = (p, o) => { const m = [], base = ['home', 'follow', 'admit'].includes(o);
    if (base && !p.colourConfirmed) m.push('the triage colour confirmed'); if (base && !(p.did.length || (p.notes || '').trim())) m.push('care given (or a note)');
    if (o === 'follow' && !(S.lv.follow || '').trim()) m.push('the follow-up (what and when)'); if (o === 'admit' && !(S.lv.admit || '').trim()) m.push('where they are admitted to');
    if (o === 'left' && !(S.lv.left || '').trim()) m.push('a one-line note'); return m; };
  const OUT_BTN = { home: 'Discharge home', follow: 'Discharge with follow-up', admit: 'Admit', left: 'Close: left against advice' };
  // nextBar(p): { step, text, primary, more } or null. Buttons use the same data-* actions on computer and phone.
  function nextBar(p) {
    const btn = (attrs, label, extra = '') => `<button type="button" class="btn r-next" ${attrs}>${label}${extra}</button>`;
    const sec = (attrs, label) => `<button type="button" class="btn small ghost" ${attrs}>${label}</button>`;
    const r = S.role === 'oncall' && myReq(p);
    if (r) {
      if (!r.acceptedBy) return { step: `${REQ[r.type][0]} request`, text: `From ${title(r.by)}${r.note ? `: “${esc(r.note)}”` : ''}`, primary: btn(`data-accept="${r.id}"`, 'Accept request') };
      if (!r.hereAt) return { step: 'On the way', text: `${youAre('me', 'on the way')} to room ${esc(roomIdOf(p.room) || '?')}.`, primary: btn(`data-here="${r.id}"`, 'Arrived at bedside') };
      if (S.finishAsk === r.id) return { step: 'Finish consult', text: 'Finish without a note? A line of findings helps the nurse.', primary: btn(`data-rqfinish="${r.id}" data-force="1"`, 'Finish without a note'), more: sec('data-a="finishno"', 'Write one') };
      return { step: 'Your findings', text: `<textarea id="rqf-${r.id}" class="rqf" rows="2" placeholder="${r.type === 'help' ? 'What you helped with' : 'What you found, any orders, the plan'}">${esc((S.rqf || {})[r.id] || '')}</textarea>`,
        primary: btn(`data-rqfinish="${r.id}"`, 'Finish consult'), more: r.type === 'surgery' && r.mode === 'take' ? sec(`data-transfer="${r.id}"`, 'Take to Pre-Op') : '' };
    }
    if (S.role === 'super' && p.stage === 'queue') return { step: status(p), text: `Waiting ${ago(p.queuedAt) === 'just now' ? 'since just now' : ago(p.queuedAt)}${teamsOf(p)[0] !== 'Any' ? ' · ' + esc(teamsOf(p).join(' + ')) : ''}. Drag them onto a bed or a person, or place them here.`, primary: btn(`data-place="${p.id}"`, S.placeFor === p.id ? 'Choose a lit bed…' : 'Place…') };
    if (p.nurse !== 'me' || p.stage !== 'care') return null;
    if (p.phase === 'assigned') return { step: 'New patient', text: `Accept within a minute${p.handback ? ` · handed over: “${esc(p.handback.note)}”` : ''}.`, primary: btn(`data-gotit="${p.id}"`, 'Accept patient', ` <small class="gi-t">${countdown(p.assignedAt, 60)}</small>`) };
    if (p.phase === 'called') return { step: 'Called to room', text: `${S.deskBy ? `Reception ${p.calledOut ? 'has called them in' : 'is calling them in'}. ` : ''}Collect them from ${esc(D.WAITING_ROOM)}, or say in game: <b>“${esc(say(p))}”</b>`, primary: btn(`data-withpt="${p.id}"`, 'Patient is with me'), more: since(p.calledAt) >= SEC(300) ? sec(`data-noshow="${p.id}"`, 'No show') : '' };
    if (S.tab === 'leave' && !isPhone() || (isPhone() && top().s === 'p-leave')) {
      if (!S.outcome) return { step: 'Discharge', text: 'Choose an outcome below.', primary: btn('disabled', 'Discharge') };
      const miss = minMissing(p, S.outcome);
      if (!miss.length) return { step: 'Discharge', text: `${esc(outName(S.outcome))}. Check the papers below.`, primary: btn('data-a="leavego"', OUT_BTN[S.outcome]) };
      if (S.outcome === 'left') return { step: 'Discharge', text: 'Add a one-line note about what happened (below).', primary: btn('disabled', OUT_BTN.left) };
      if (S.forceAsk) return { step: 'Discharge', text: `Nothing's written yet (missing: ${esc(miss.join(', '))}). Discharge anyway?`, primary: btn('data-a="leaveforce"', 'Discharge anyway'), more: sec('data-a="forceno"', 'Cancel') };
      return { step: 'Discharge', text: `Still missing: ${esc(miss.join(', '))}.`, primary: '', more: sec('data-a="forceask"', `${OUT_BTN[S.outcome]} anyway…`) };
    }
    if (p.phase === 'transferred') return { step: 'Transferred to you', text: 'When you\u2019re done, record the outcome.', primary: btn(`data-discharge="${p.id}"`, 'Discharge') };
    if (!p.colourConfirmed) return { step: 'Assessment', text: `Confirm their triage colour: ${upill(p.urgency)}`, primary: btn('data-a="pconfirm"', 'Looks right'), more: sec('data-a="urgopen"', 'Change') };
    if (!p.vitals.length && !(S.skipVit || {})[p.id]) return { step: 'Assessment', text: 'Add their vitals: copy them from the monitor.', primary: btn('data-a="vopen"', 'Add vitals'), more: sec(`data-skipvit="${p.id}"`, 'Skip') };
    if (!(p.did.length || (p.notes || '').trim())) return { step: 'Treatment', text: 'Record the care given as you go.', primary: btn('data-a="focusdid"', 'Record care given'), more: sec(`data-discharge="${p.id}"`, 'Discharge…') };
    return { step: 'Treatment', text: 'Keep charting, or discharge when they\u2019re done.', primary: btn(`data-discharge="${p.id}"`, 'Discharge') };
  }
  const nextBarHtml = (p) => { const n = nextBar(p); return n ? `<div class="nxbar"><div class="nx-txt"><span class="nx-step">${esc(n.step)}</span><span class="nx-what">${n.text}</span></div><div class="nx-btns">${n.primary || ''}${n.more || ''}</div></div>` : ''; };
  // List cards show status and open the record; they don't repeat its buttons (audit #3).
  const careCard = (p) => `<div class="care-p${S.open === p.id ? ' sel' : ''}" style="--u:${U(p.urgency).colour}">
    <button type="button" class="cp-main" data-open="${p.id}"><b>${esc(p.name)}${p.age ? ', ' + p.age : ''}</b>${upill(p.urgency)}<span class="cp-sub">${esc(p.room || p.where || 'No bed')} · ${esc(status(p))}${teamChips(p)}</span>${flags(p) ? `<span class="cp-flags">${flags(p)}</span>` : ''}${(() => { const n = p.nurse === 'me' && nextBar(p); return n ? `<span class="cp-nx">Next: ${esc((n.primary || '').replace(/<[^>]*>/g, ' ').replace(/\s*\d+:\d\d\s*$/, '').replace(/\s+/g, ' ').trim() || n.step)}</span>` : ''; })()}</button></div>`;

  // ---------- PATIENT CARE: ROOM ----------
  function myRoomSection() {
    const beds = bedsOf('me'), m = mine(), cap = roomCap();
    if (!beds.length) S.pick = true;
    if (S.pick) return pickSection();
    const asg = m.filter((p) => p.phase === 'assigned'), rest = m.filter((p) => p.phase !== 'assigned');
    const deskOffer = !A.asked && 'Notification' in window ? `<div class="desk-offer"><span>Get alerts even when this tab is in the background?</span><span class="row-btns"><button type="button" class="btn small ghost" data-a="deskyes">Turn on</button><button type="button" class="btn small ghost" data-a="deskno">Not now</button></span></div>` : '';
    // A new patient takes over the top. Phone: a sticky card with the big Accept. Computer: the record opens with Accept as
    // its primary, so this card just opens it (one home per action).
    const gotIt = isPhone() ? '' : asg.map((p) => `<div class="gotit${isPhone() ? ' sticky' : ''}" style="--u:${U(p.urgency).colour}"><span class="lab">${p.inRoom ? 'Waiting in your room' : 'New patient'}</span><b>${esc(p.name)}${p.age ? ', ' + p.age : ''}${teamChips(p)}</b>${upill(p.urgency)}
      <span>${esc(p.room)} · ${esc(p.symptoms.join(', ') || (p.symKnown ? 'no symptoms given' : ''))}${p.handback ? ` · handed over: “${esc(p.handback.note)}”` : ''}${p.lost ? ' · <b>Needs a new nurse</b>' : ''}</span>
      ${isPhone() ? `<button type="button" class="btn big" data-gotit="${p.id}">Accept patient <small class="gi-t">${countdown(p.assignedAt, 60)}</small></button>` : `<button type="button" class="btn ghost" data-open="${p.id}">Open their record · accept within ${countdown(p.assignedAt, 60)}</button>`}</div>`).join('');
    const offers = [];   // the server offers open rooms (me.offer)
    const free = `${cap} bed${cap === 1 ? '' : 's'} free`;
    const card = m.length >= D.LIMIT ? `<div class="ready-line"><b>You have ${D.LIMIT} patients</b><span>That's the most at once. Finish or hand over one to get another.</span></div>`
      : cap <= 0 ? `<div class="ready-line"><b>Your bed${beds.length > 1 ? 's are' : ' is'} in use</b><span>${beds.length < D.LIMIT ? 'One bed means one patient at a time.' : 'Ready comes back when a bed frees.'}</span>${beds.length < D.LIMIT ? '<button type="button" class="btn small ghost" data-a="pick">Add a room</button>' : ''}</div>`
      : S.ready ? `<div class="${m.length ? 'ready-line on' : 'ready-card on'}"><span class="ready-dot" aria-hidden="true"></span><b>You're Ready</b><span>${superOn() ? 'The supervisor will give you your next patient.' : 'You\u2019ll get the next patient who fits your beds.'} Expires in ${countdown(S.readyExp ? new Date(Date.parse(S.readyExp) - 600000).toISOString() : new Date(Date.now() + SKEW).toISOString(), 600)} if nothing happens.</span><span class="row-btns"><button type="button" class="btn small ghost" data-a="stayready">Stay ready</button><button type="button" class="btn small ghost" data-a="notready">Not ready</button></span></div>`
      : m.length ? `<div class="ready-line"><b>Ready for another?</b><span>${free}</span><button type="button" class="btn small" data-a="ready">Ready</button></div>`
      : `<div class="ready-card">${S.readyGone ? '<b>Your Ready status expired</b><span>10 minutes went by with no patient. Still free?</span>' : `<b>Ready for a patient?</b><span>${superOn() ? 'Press Ready and the supervisor will give you one.' : 'Press Ready and you\u2019ll be given the next patient who fits your beds.'}</span>`}<button type="button" class="btn big ready-btn" data-a="ready">Ready</button></div>`;
    return `<div class="pane-pad care"><div class="pane-head"><div><h2>My Room</h2><p class="muted">${beds.map(esc).join(' · ')} · ${m.length} of ${D.LIMIT} patients</p></div>${m.length ? '' : '<button type="button" class="btn ghost" data-a="pick">Change room</button>'}</div>
      ${movePanel()}${gotIt}
      ${rest.length ? `<h3 class="care-h">Your patient${rest.length === 1 ? '' : 's'}</h3><div class="care-list">${rest.map(careCard).join('')}</div>` : ''}
      ${card}
      ${S.hadPatient || m.length ? (S.hadPatient = true, deskOffer) : ''}
      ${S.offer ? `<div class="offer-card" style="--u:#f0a530"><div><b>${bell}Nobody has room ${esc(S.offer.room)}${S.offer.waiting ? `: ${S.offer.waiting} waiting` : ''}</b><span>Take it over to look after ${S.offer.waiting > 1 ? 'them' : 'them'}.</span></div><button type="button" class="btn small ghost" data-takeover="1">Take over ${esc(S.offer.room)}</button></div>` : ''}
      ${!S.session ? (S.npc ? npcForm() : `<div class="npc-row"><button type="button" class="btn ghost" data-a="npc"${cap > 0 ? '' : ' disabled'}>+ NPC patient</button><span class="muted small">No session is running, so NPC patients can be charted. They count towards your ${D.LIMIT}.</span></div>`) : ''}
      ${!S.deskBy && S.session ? (S.npOpen ? newPatient() : '<div class="npc-row"><button type="button" class="btn ghost" data-a="npopen">+ Walk-in patient</button><span class="muted small">Nobody is on Reception. A walk-in goes through the queue like anyone else.</span></div>') : ''}
      <button type="button" class="btn ghost end-btn" data-a="endshift">End my shift</button>${S.endShift ? endShiftPanel() : ''}</div>`;
  }
  const npcForm = () => `<section class="card np-panel"><div class="card-head"><h3>NPC patient</h3><button type="button" class="link" data-a="npcx">Cancel</button></div>
    <label class="f"><span>Name on the wait-list board</span><input id="npc-name" value="${esc(S.npc.name)}" placeholder="e.g. Felipe B." autocomplete="off"></label>
    <div class="f"><span>Symptoms <em>optional, type each one and press Enter</em></span>${tagList(S.npc.symptoms || [], 'data-npcsymrm')}${fbox('npcsym', 'sym', '', 'e.g. chest pain, hurt left arm', 'Add')}</div>
    <div class="f"><span>Which bed? Tap one to log them</span><div class="chips">${freeBedsOf('me').map((b) => `<button type="button" class="chip" data-npcbed="${esc(b)}">${esc(b)}</button>`).join('')}</div></div></section>`;
  function pickSection() {
    const n = pickSelNow().length;
    return `<div class="pane-pad rooms-pad"><div class="pane-head"><div><h2>${n ? 'Your room' : 'Pick your room'}</h2><p class="muted">Tap beds to take them, up to ${D.LIMIT}: a 2-bed room, any two 1-bed rooms, or one bed in a shared room. ${esc(S.rdept || '')} rooms are outlined. You stay in it for the shift.</p></div>${n ? `<button type="button" class="btn" data-a="pickdone">Done · ${n} bed${n > 1 ? 's' : ''}</button>` : ''}</div>
      ${isPhone() ? D.ROOMS.map((r) => `<h4 class="ph-sub">${r.id} · ${S.roomCfg[r.id].kids ? 'Paediatric' : esc(S.roomDept[r.id] || '')}${S.roomCfg[r.id].closed ? ' · closed' : ''}</h4><div class="ph-beds">${D.BEDS.filter((b) => roomIdOf(b) === r.id).map((b) => bedCell(b, r.beds > 1 ? 'Bed ' + b.slice(-1) : 'Bed', 'pick')).join('')}</div>`).join('')
        : `<div class="floor-wrap"><div class="floor pick" aria-label="Pick your room">${floorInner('pick')}</div></div>`}</div>`;
  }

  // ---------- PATIENT CARE: ON CALL (and the Supervisor's Requests) ----------
  const reqCard = (r) => { const p = byId(r.pid), lv = reqLevel(r);
    return `<div class="rq-card ${lv}" style="--u:${U(p.urgency).colour}">
      <div class="rq-top"><span class="rq-type">${REQ[r.type][0]}${r.mode === 'take' ? ': take to surgery' : r.mode === 'down' ? ': come down' : ''}</span>${upill(p.urgency, true)}<span class="rq-t">${r.acceptedBy ? (r.hereAt ? `${youAre(r.acceptedBy, 'at the bedside')}` : `${youAre(r.acceptedBy, 'on the way')} · ${elapsed(r.acceptedAt)}`) : `Waiting · ${elapsed(r.at)}`}</span></div>
      <button type="button" class="rq-main" data-open="${p.id}"><b>Room ${esc(roomIdOf(p.room) || '–')} · ${esc(p.name)}</b><span>from ${esc(title(r.by))}${r.auto ? ' · from check-in' : ''}${r.note ? `: “${esc(r.note)}”` : ''}${r.sentTo && !r.acceptedBy ? ` · sent to ${esc(first(r.sentTo))}` : ''}</span><em class="rq-open">${!r.acceptedBy && canAccept(r) ? 'Open to accept' : r.acceptedBy === 'me' ? 'Open your consult' : 'Open the record'}</em></button>
      ${!r.acceptedBy && S.role === 'super' ? `<button type="button" class="btn small ghost" data-sendto="${r.id}">Send to…</button>${S.sendFor === r.id ? sendPanel(r) : ''}` : ''}</div>`; };
  const sendPanel = (r) => `<div class="sendbox"><span class="muted small">Send it to someone. It's still their choice to accept.</span><div class="chips">${D.STAFF.filter((x) => !x.you && canAccept(r, x.id)).map((x) => `<button type="button" class="chip" data-sendsid="${x.id}">${esc(x.name)}</button>`).join('') || '<span class="muted small">Nobody on call can take this kind right now.</span>'}</div></div>`;
  function reqSection() {
    const rank = { stuck: 0, late: 0, amber: 1, grey: 2, ok: 3 };
    const open = S.reqs.filter((r) => isOpenReq(r) && !r.acceptedBy && r.type !== 'imaging' && (S.role === 'super' || canAccept(r)))
      .sort((a, b) => (rank[reqLevel(a)] - rank[reqLevel(b)]) || (byId(a.pid).urgency - byId(b.pid).urgency) || (new Date(a.at) - new Date(b.at)));
    const mineR = S.reqs.filter((r) => isOpenReq(r) && r.acceptedBy === 'me' && r.type !== 'imaging');
    const taken = S.role === 'super' ? S.reqs.filter((r) => isOpenReq(r) && r.acceptedBy && r.acceptedBy !== 'me' && r.type !== 'imaging') : [];
    const trans = mine().filter((p) => p.phase === 'transferred');
    return `<div class="pane-pad"><div class="pane-head"><div><h2>Requests</h2><p class="muted">${S.role === 'super' ? 'Everyone\u2019s requests. Amber has waited 3 minutes.' : `On call · ${esc(S.rdept)} · the first to accept gets it`}</p></div></div>
      ${mineR.length ? `<h3 class="care-h">Your consults</h3>${mineR.map(reqCard).join('')}` : ''}
      <h3 class="care-h">Open <span class="count">${open.length}</span></h3>${open.length ? open.map(reqCard).join('') : '<p class="muted">No open requests. They show up here the moment a nurse asks.</p>'}
      ${taken.length ? `<h3 class="care-h">Taken</h3>${taken.map(reqCard).join('')}` : ''}
      ${trans.length ? `<h3 class="care-h">Transferred to you</h3><div class="care-list">${trans.map(careCard).join('')}</div>` : ''}</div>`;
  }

  // ---------- PATIENT CARE: ROAD (paramedics) ----------
  function roadSection() {
    const d = S.inc || (S.inc = { name: '', age: '', urgency: null, what: '', hr: '', bp: '', eta: 5 });
    const mineI = S.incoming.filter((i) => i.by === 'me' && !i.done);
    return `<div class="pane-pad"><div class="pane-head"><div><h2>Incoming</h2><p class="muted">Ambulance cases you're bringing in. They join Up next when you hand over at the ER.</p></div></div>
      ${mineI.map((i) => `<div class="inc-card" style="--u:${U(i.urgency).colour}"><div><b>${esc(i.name)}${i.age ? ', ' + esc(i.age) : ''}</b>${upill(i.urgency)}<span>${esc(i.what || 'No note')}${i.hr ? ` · HR ${esc(i.hr)}` : ''}${i.bp ? ` · BP ${esc(i.bp)}` : ''}</span><small>${since(i.at) >= SEC(i.eta * 60) ? 'Should be at the ER now' : `ETA ${countdown(i.at, i.eta * 60)}`}</small></div><button type="button" class="btn" data-handover="${i.id}">Handed over at the ER</button></div>`).join('')}
      ${S.incDone && !mineI.length ? '<div class="road-next"><b>Handed over at the ER.</b><span class="row-btns"><button type="button" class="btn" data-a="incnew">New incoming case</button><button type="button" class="btn ghost" data-a="changerole">Switch role</button></span></div>' : `
      <section class="card"><div class="card-head"><h3>New incoming case</h3></div>
        <div class="row2"><label class="f"><span>Name</span><input id="i-name" value="${esc(d.name)}" placeholder="e.g. Max R." autocomplete="off"></label><label class="f"><span>Age</span><input id="i-age" type="number" inputmode="numeric" value="${esc(d.age)}" placeholder="optional"></label></div>
        <label class="f"><span>What happened</span><input id="i-what" value="${esc(d.what)}" placeholder="e.g. car crash, hurt left leg" autocomplete="off"></label>
        <div class="row2"><label class="f"><span>Heart rate</span><input id="i-hr" type="number" inputmode="numeric" value="${esc(d.hr)}" placeholder="optional"></label><label class="f"><span>Blood pressure</span><input id="i-bp" value="${esc(d.bp)}" placeholder="e.g. 110/70"></label></div>
        <div class="f"><span>Triage colour</span>${urgPicker(d.urgency, 'data-iurg')}</div>
        <div class="f"><span>Arriving in</span><div class="chips">${[2, 5, 10, 15].map((m) => chip(m + ' min', d.eta === m, `data-ieta="${m}"`)).join('')}</div></div>
        <div class="np-foot"><button type="button" class="btn" data-a="incgo"${d.name.trim() && d.urgency ? '' : ' disabled'}>Send to the ER</button><span class="muted small">Needs a name and a colour; what happened helps a lot.</span></div></section>`}</div>`;
  }

  // ---------- WARD BOARD (read-only list for everyone) ----------
  function boardSection() {
    const rows = inCare(), q = upNext(), hb = q.filter((p) => p.room);
    const shut = D.ROOMS.flatMap((r) => { const c = S.roomCfg[r.id]; return c.closed ? [`${r.id} closed${c.why ? ' (' + c.why + ')' : ''}`] : Object.keys(c.off).filter((b) => c.off[b]).map((b) => `${b} unavailable`); });
    return `<div class="board" id="board"><div class="b-head"><h2>Ward Board</h2><span class="muted">${rows.length} being seen · ${q.length} waiting</span></div>${shut.length ? `<p class="shut-line">${esc(shut.join(' · '))}</p>` : ''}
      ${incomingStrip()}${q.length ? `<div class="q-strip"><span>Up next</span>${q.map((p) => `<span class="q-chip ro" style="--u:${U(p.urgency).colour}">${p.room ? bell : ''}${esc(p.name)}</span>`).join('')}</div>` : ''}
      ${hb.map((p) => `<div class="wir big" style="--u:${U(p.urgency).colour}"><b>${bell}${esc(p.name)} · WAITING IN ${esc((p.room || 'their room').toUpperCase())}</b><span>${p.handback ? `Handed over by ${esc(first(p.handback.by))} ${ago(p.handback.at)} ago: “${esc(p.handback.note)}”.` : 'Waiting in a bed.'} ${nth(place(p))} in Up next.${p.lost ? ' Lost nurse.' : ''}</span></div>`).join('')}
      <table class="btable"><thead><tr><th class="c-u">Colour</th><th class="c-room">Room</th><th>Patient</th><th class="c-prob">Problem</th><th class="c-nurse">With</th><th class="c-doc">Doctor</th><th class="c-st">Status</th><th class="c-t">Time</th></tr></thead>
      <tbody>${rows.map((p) => `<tr class="${S.open === p.id ? 'sel' : ''}" data-open="${p.id}" style="--u:${U(p.urgency).colour}"><td class="c-u">${upill(p.urgency, true)}${p.colourConfirmed ? '' : ' <span class="unconf" title="The nurse hasn’t confirmed the colour yet">?</span>'}</td><td class="c-room">${esc(p.room || p.where || '–')}</td>
        <td class="c-name"><span class="dot"></span><b>${esc(p.name)}</b></td><td class="c-prob">${esc(p.symptoms.slice(0, 2).join(', '))}</td><td class="c-nurse">${esc(first(p.nurse))}</td><td class="c-doc">${esc(first(p.doctor) || '')}</td>
        <td class="c-st"><span class="st st-${stKey(p)}">${esc(status(p))}</span>${flags(p)}</td><td class="c-t" data-since="${new Date(p.takenAt || p.arrived).toISOString()}">${ago(p.takenAt || p.arrived)}</td></tr>`).join('')}</tbody></table>
      <ul class="bcompact">${rows.map((p) => `<li class="${S.open === p.id ? 'sel' : ''}" data-open="${p.id}" style="--u:${U(p.urgency).colour}"><b>${esc(p.name)}</b><small>${esc(p.room || '')} · ${esc(first(p.nurse))}</small></li>`).join('')}</ul>
      <p class="b-key">Colour = how urgent, red first. A ? means the nurse hasn't confirmed the colour yet.</p></div>`;
  }
  function endShiftPanel() {
    const m = mine();
    const role = S.endShift === 'role';
    return `<section class="card np-panel"><div class="card-head"><h3>${role ? 'Change role' : 'End your shift'}</h3><button type="button" class="link" data-a="endx">Not yet</button></div>
      ${m.length ? `<p class="muted">You still have ${m.length} patient${m.length > 1 ? 's' : ''}. Hand them over (they stay in their beds, at the top of the queue) or finish them first.</p>
        <ul class="wlist">${m.map((p) => `<li style="--u:${U(p.urgency).colour}"><span class="ubar"></span>${pnameRow(p, ' · ' + esc(p.room || p.where || ''))}<span></span><span class="row-btns"><button type="button" class="btn small ghost" data-open="${p.id}">Finish</button><button type="button" class="btn small" data-hb="${p.id}">Hand over</button></span>
          ${S.handbackFor === p.id ? handbackBox(p) : ''}</li>`).join('')}</ul>
        <div class="sendbox"><label class="f"><span>Or hand ${m.length > 1 ? 'both' : 'them'} over and ${role ? 'change role' : 'clock out'}. A note for whoever takes over:</span><input id="hb-all" placeholder="e.g. Waiting for results" autocomplete="off"></label><button type="button" class="btn" data-a="hball">Hand over ${m.length > 1 ? 'both ' : ''}and ${role ? 'change role' : 'clock out'}</button></div>`
        : role ? '<p>You have no patients now.</p><button type="button" class="btn" data-a="changerole">Change role</button>' : '<p>You have no patients. You can end your shift.</p><button type="button" class="btn" data-a="endgo">End shift</button>'}</section>`;
  }
  const handbackBox = (p) => `<div class="sendbox"><label class="f"><span>A note for whoever takes ${esc(p.name)} next (needed)</span><input id="hb-note" placeholder="e.g. Waiting for blood results" autocomplete="off"></label>
    <div class="row-btns"><button type="button" class="btn" data-hbgo="${p.id}">Hand over</button><button type="button" class="btn ghost" data-a="hbx">Cancel</button></div></div>`;

  // ---------- SUPERVISOR: the floor plan (§5) ----------
  const superBar = () => `<div class="sbar"><span class="sb-who">Supervising: ${S.superOther ? 'you and 1 other' : 'you'}</span>
    <button type="button" class="dm-t${S.recOpen ? ' on' : ''}" data-a="recopen" aria-pressed="${S.recOpen}">Reception ${S.recOpen ? 'open' : 'closed'}</button>
    <button type="button" class="dm-t${S.online ? ' on' : ''}" data-a="online" aria-pressed="${S.online}">${S.online ? 'Online check-in open' : 'Full: walk-ins only'}</button>
    ${S.session ? '<button type="button" class="btn small ghost" data-a="endsess">End session</button>' : '<span class="muted small">No session running</span>'}</div>`;
  const closeWhy = (id) => { const beds = D.BEDS.filter((b) => roomIdOf(b) === id), pt = beds.map((b) => roomsInUse()[b]).find(Boolean), ow = beds.map(ownerOf).find(Boolean);
    return pt ? `${pt.name} is in it: move them out first.` : ow ? `${ow === 'me' ? 'You have' : nm(ow) + ' has'} it: make it open first (below).` : ''; };
  const roomLog = (id, t) => S.roomCfg[id].log.unshift({ at: new Date(), by: 'me', t });
  function roomPanel() { const id = S.roomPanel; if (!id) return ''; const c = S.roomCfg[id], beds = D.BEDS.filter((b) => roomIdOf(b) === id);
    return `<div class="move-ask room-set"><div class="ma-h"><b>Room ${esc(id)} settings</b><button type="button" class="link" data-a="roompx">Done</button></div>
      <div class="f"><span>Department</span><div class="chips">${[...D.CARE_DEPTS.map((x) => x[0]), 'Any'].map((d) => `<button type="button" class="chip team${S.roomDept[id] === d ? ' on' : ''}" style="--dc:${deptColour(d)}" data-rdset="${d}">${d}</button>`).join('')}</div></div>
      <div class="f"><span>Who can go in</span><div class="chips">${[['', 'Anyone'], ['kids', 'Paediatric only'], ['adults', 'Adults only']].map(([k, l]) => { const on = k ? c[k] : !c.kids && !c.adults; return `<button type="button" class="chip${on ? ' on' : ''}" aria-pressed="${on}" data-rrestr="${k}">${l}</button>`; }).join('')}</div></div>
      ${beds.length > 1 ? `<div class="f"><span>Beds available</span><div class="chips">${beds.map((b) => { const off = !!c.off[b], used = roomsInUse()[b]; return `<button type="button" class="chip${off ? '' : ' on'}" aria-pressed="${!off}" data-bedoff="${esc(b)}"${used && !off ? ' disabled title="Someone is in it"' : ''}>${esc(b.split(' ').slice(1).join(' '))}${off ? ' · off' : ''}</button>`; }).join('')}</div></div>` : ''}
      <div class="f"><span>Who has it</span>${beds.map((b) => { const o = ownerOf(b), q = roomsInUse()[b]; return `<div class="rp-bed"><span>${esc(b)}</span>${o ? `${face(o)} ${esc(nm(o))}${q && q.stage === 'care' ? '' : ` <button type="button" class="link" data-unown="${esc(b)}">Make open</button>`}` : '<span class="muted">Nobody</span>'}</div>`; }).join('')}</div>
      ${c.closed ? `<div class="rs-closed"><b>Closed</b><span>${esc(c.why || 'No reason given')}</span><button type="button" class="btn small" data-a="roomopen">Open the room</button></div>`
        : `<div class="f"><span>Close the room <em>nobody can take it while it's closed</em></span><div class="fb-row"><input id="rc-why" placeholder="Why? e.g. Training in ${esc(id)}" autocomplete="off"><button type="button" class="btn warn" data-a="roomclose"${closeWhy(id) ? ` disabled title="${esc(closeWhy(id))}"` : ''}>Close room</button></div>${closeWhy(id) ? `<small class="muted">${esc(closeWhy(id))}</small>` : ''}</div>`}
      ${c.log.length ? `<details class="rs-log"><summary>Changes (${c.log.length})</summary><ol class="tl">${c.log.map((l) => `<li><time>${clock(l.at)}</time><span>${esc(l.t)} · ${esc(first(l.by))}</span></li>`).join('')}</ol></details>` : ''}</div>`; }
  function facePanel() { const sid = S.face; if (!sid) return ''; const x = staff(sid), m = mine(sid), cur = S.staffRole[sid];
    const roles = [['room', 'Room'], ['oncall', 'On call'], ['road', 'Road'], ['reception', 'Reception'], ['break', 'Break'], ['off', 'Not on the Chart']];
    return `<div class="move-ask"><div class="ma-h">${face(sid)}<b>${esc(x.name)}</b><span class="muted small">${esc(x.dept)} · ${esc(ROLE_NAME[cur])}${bedsOf(sid).length ? ' · ' + esc(bedsOf(sid).join(', ')) : ''} · ${m.length} patient${m.length === 1 ? '' : 's'}</span><button type="button" class="link" data-a="facex">Close</button></div>
      <div class="chips">${roles.map(([k, l]) => `<button type="button" class="chip${cur === k ? ' on' : ''}" data-setrole="${k}"${k === 'reception' && !S.recOpen ? ' disabled' : ''}>${l}</button>`).join('')}${cur === 'room' ? `<button type="button" class="chip${isReady(sid) ? ' on' : ''}" data-setready="${sid}">${isReady(sid) ? 'Ready' : 'Not ready'}</button>` : ''}</div>
      ${S.roleAsk ? `<div class="sendbox"><b>${esc(first(sid))} has ${m.length} patient${m.length > 1 ? 's' : ''}. Hand them back and change to ${esc(ROLE_NAME[S.roleAsk])}?</b><span class="row-btns"><button type="button" class="btn small" data-a="roleyes">Hand back and change</button><button type="button" class="btn small ghost" data-a="roleno">Cancel</button></span></div>` : ''}
      <div class="row-btns"><button type="button" class="btn small warn" data-gone="${sid}">They've gone</button><span class="muted small">Left the game or closed the site: their patients go back first in line, marked Lost nurse.</span></div></div>`; }
  function whoPanel() { if (!S.who) return ''; const p = byId(S.who.pid), bed = S.who.bed;
    const fits = (x) => mine(x.id).length < D.LIMIT && bedsOf(x.id).length < D.LIMIT;
    const room = D.STAFF.filter((x) => !x.you && S.staffRole[x.id] === 'room' && fits(x)).sort((a, b) => (teamOk(p, b.id) - teamOk(p, a.id)) || (mine(a.id).length - mine(b.id).length));
    const oc = D.STAFF.filter((x) => !x.you && S.staffRole[x.id] === 'oncall' && fits(x));
    const ch = (x) => `<button type="button" class="chip${teamOk(p, x.id) ? ' best' : ''}" data-whosid="${x.id}">${esc(x.name)} · ${esc(x.dept)} · ${mine(x.id).length} of ${D.LIMIT}${teamOk(p, x.id) ? '' : ' · not their team'}</button>`;
    return `<div class="move-ask"><b>Nobody has ${esc(bed)}. Who takes ${esc(p.name)}?</b><div class="chips">${room.map(ch).join('') || '<span class="muted small">No Room staff with space.</span>'}</div>
      ${oc.length ? `<details class="who-oc"><summary>Give a room to someone on call (busy night)</summary><div class="chips">${oc.map(ch).join('')}</div></details>` : ''}<button type="button" class="link" data-a="whox">Cancel</button></div>`; }
  const pendRoomPanel = () => { if (!S.pendRoom) return ''; const { sid, id } = S.pendRoom, n = bedsOf(sid).filter((b) => roomsInUse()[b]).length;
    return `<div class="move-ask"><b>${esc(first(sid))} has ${n} patient${n > 1 ? 's' : ''} in ${esc(bedsOf(sid).join(', '))}. Give them room ${esc(id)} and move their patients too?</b><div class="row-btns"><button type="button" class="btn" data-a="pryes">Move their patients too</button><button type="button" class="btn ghost" data-a="prno">Cancel</button></div></div>`; };
  function endSessionPanel() { const open = P().filter((p) => ['checkin', 'queue', 'care'].includes(p.stage));
    return `<div class="move-ask"><div class="ma-h"><b>End the session</b><button type="button" class="link" data-a="endsessx">Not yet</button></div>
      ${open.length ? `<p class="muted small">${open.length} open case${open.length > 1 ? 's' : ''}. Each needs an outcome before the session ends.</p><ul class="es-list">${open.map((p) => `<li style="--u:${p.urgency ? U(p.urgency).colour : '#9aa9c4'}"><b>${esc(p.name)}</b><small>${esc(status(p))}${p.nurse ? ' · ' + esc(first(p.nurse)) : ''}</small>${p.stage === 'care' ? `<button type="button" class="btn small ghost" data-finish="${p.id}">Finish now</button>` : ''}<button type="button" class="btn small ghost" data-endcase="${p.id}">Close as Session ended</button></li>`).join('')}</ul>` : ''}
      <button type="button" class="btn" data-a="endall">${open.length ? 'Close all as Session ended, and end' : 'End the session'}</button><small class="muted">Online patients still waiting are told “We're closing for now, sorry”, and online check-in closes. Nothing is deleted.</small></div>`; }
  const shortBed = (b) => b.replace(' Bed ', '');
  const helping = (sid) => S.reqs.find((x) => isOpenReq(x) && x.acceptedBy === sid && x.type !== 'imaging');
  const personStatus = (sid) => { const r = S.staffRole[sid], rq = helping(sid), m = mine(sid);
    if (rq) { const q = byId(rq.pid), rm = roomIdOf(q.room) || '?'; return rq.hereAt ? [`In ${rm} · ${RT[rq.type]}`, 'busy'] : [`Going to ${rm} · ${RT[rq.type]}`, 'go']; }
    if (r === 'break') return ['Break', 'off']; if (r === 'off') return ['Not on the Chart', 'off'];
    if (r === 'reception') return ['At the desk', 'ok'];
    if (r === 'road') return [S.incoming.some((i) => !i.done && i.by === sid) ? 'Bringing one in' : 'On the road', 'ok'];
    if (m.some((p) => p.phase === 'assigned')) return ['New patient', 'go'];
    if (m.some((p) => p.phase === 'called')) return ['Collecting a patient', 'go'];
    if (m.length) return [m.length > 1 ? `With ${m.length} patients` : 'With patient', 'busy'];
    if (r === 'room' && !bedsOf(sid).length) return ['No room yet', 'off'];
    if (isReady(sid)) return ['Ready', 'ok'];
    return [r === 'oncall' ? 'Available' : 'Free', 'ok']; };
  const staffChip = (x) => { const m = mine(x.id), b = bedsOf(x.id), r = S.staffRole[x.id], [st, sc] = personStatus(x.id);
    return `<button type="button" class="staff-drop${S.face === x.id ? ' sel' : ''}" data-sid="${x.id}" data-dragsid="${x.id}" title="${esc(x.name)} · ${esc(st)}" style="--dc:${deptColour(x.dept)};--st:${{ ok: '#0D7D74', go: '#F0A530', busy: '#3A82D0', off: '#9aa9c4' }[sc]}">${face(x.id)}<span><b>${esc(x.name)}</b><small>${esc(ROLE_NAME[r])}${r === 'oncall' || r === 'room' ? ' · ' + esc(x.dept) : ''}${b.length ? ' · ' + esc(b.map(shortBed).join(', ')) : ''}${m.length ? ` · ${m.length} of ${D.LIMIT}` : ''}</small></span><em class="ps-st ${sc}">${esc(st)}</em></button>`; };
  const incomingChips = () => S.incoming.filter((i) => !i.done).map((i) => `<span class="q-chip inc ro" style="--u:${U(i.urgency).colour}"><b>${esc(i.name)}</b><small>Ambulance · ${since(i.at) >= SEC(i.eta * 60) ? 'arriving now' : 'ETA ' + countdown(i.at, i.eta * 60)}</small></span>`).join('');
  const pplOpen = () => (S.peopleOpen == null ? window.innerWidth >= 1400 : S.peopleOpen);
  function planSection() {
    const q = upNext(), ppl = D.STAFF.filter((x) => !x.you), nReq = S.reqs.filter((r) => isOpenReq(r) && !r.acceptedBy && r.type !== 'imaging').length;
    const grp = [['room', 'Room'], ['oncall', 'On call'], ['road', 'Road'], ['reception', 'Reception'], ['break', 'On a break'], ['off', 'Off the Chart']];
    if (!S.session) S.endSess = false;
    const asks = `${S.endSess ? endSessionPanel() : ''}${teamWarnPanel()}${whoPanel()}${pendRoomPanel()}${movePanel()}`, open = pplOpen();
    return `<div class="plan">${asks ? `<div class="plan-asks">${asks}</div>` : ''}
      <div class="plan-q" aria-label="Up next"><span class="pq-l">Up next <i>${q.length}</i></span><div class="pq-row">${incomingChips()}${q.length ? q.map((p) => `<button type="button" class="q-chip" style="--u:${U(p.urgency).colour}" data-drag="${p.id}" data-open="${p.id}" title="${esc(p.name)} · ${esc(U(p.urgency).name)}${isChild(p) ? ' · child' : ''}${p.room ? ' · waiting in ' + esc(p.room) : ''} · ${ago(p.queuedAt)}. Press to read their record; drag onto a bed or a person.">${p.room ? bell : ''}<b>${esc(p.name)}</b>${teamChips(p)}${flags(p)}${p.lost ? '<span class="rq-ic rt rt-wait">Needs a new nurse</span>' : ''}<small>${ago(p.queuedAt)}</small></button>`).join('') : '<span class="muted small">Nobody waiting</span>'}</div>${nReq ? `<button type="button" class="link pq-req" data-sec="reqs">${nReq} request${nReq > 1 ? 's' : ''}</button>` : ''}</div>
      <div class="plan-grid${open ? '' : ' shut'}"><div class="floor-wrap"><div class="floor" aria-label="Main ward floor plan">${floorInner('super')}</div></div>
        <aside class="plan-s" aria-label="People on shift"><div class="ps-h"><h3>People</h3><button type="button" class="link" data-a="pplx" aria-expanded="${open}" title="${open ? 'Make the People list narrow' : 'Show the People list'}">${open ? 'Hide' : '‹'}</button></div>${grp.map(([k, l]) => { const xs = ppl.filter((x) => S.staffRole[x.id] === k); return xs.length ? `<span class="ps-l">${l}</span>${xs.map(staffChip).join('')}` : ''; }).join('')}</aside></div>
      ${S.roomPanel ? `<div class="room-pop" data-room="${S.roomPanel}" role="dialog" aria-label="Room ${S.roomPanel} settings">${roomPanel()}</div>` : ''}
      ${S.face ? `<div class="popover" data-anchor="${S.face}" role="dialog" aria-label="${esc(nm(S.face))}">${facePanel()}</div>` : ''}</div>`;
  }
  // The main ward floor plan, roughly to scale with the owner's map (chart/maps/main-ward.png). Units are ~studs:
  // corridors are 20 wide and run all round the Central Hub (one building: the nurses' & doctors' station, break room,
  // lockers and reception at its front). Everything that isn't a room, the hub or a wall is corridor. Openings:
  // Radiology (top, between 105 and 106), the ER Waiting Room (top, between 108 and the blank wall above 109),
  // Emergency (right, between 109 and 110), and two doors to the main waiting area (bottom: beside 101 and beside 110).
  const FW = 415, FH = 300;
  const FLOOR = {
    rooms: { 105: [0, 0, 140, 75], 106: [160, 0, 55, 75], 107: [215, 0, 55, 75], 108: [270, 0, 55, 75],
      104: [0, 75, 75, 60], 103: [0, 135, 75, 50], 102: [0, 185, 75, 50], 101: [0, 235, 130, 65],
      109: [345, 95, 70, 70], 110: [345, 190, 70, 75] },
    // the Central Hub outline (station block with reception's front part below it)
    hub: [[95, 95], [325, 95], [325, 210], [290, 210], [290, 300], [150, 300], [150, 210], [95, 210]],
    restroom: [290, 210, 35, 90],   // Family Restroom: against the hub (shares its walls), opposite 110
    walls: [[345, 0, 70, 95], [345, 265, 70, 35]],
    gaps: { top: [[140, 160, 'To Radiology'], [325, 345, 'To the ER Waiting Room']], right: [[165, 190, 'To Emergency']],
      bottom: [[130, 150, 'To the main waiting area'], [325, 345, 'To the main waiting area']] },
  };
  const pc = (v, of) => `${(v / of) * 100}%`;
  const box = ([x, y, w, h]) => `left:${pc(x, FW)};top:${pc(y, FH)};width:${pc(w, FW)};height:${pc(h, FH)}`;
  const bedIcons = (p) => `${p.stage === 'queue' ? bell : ''}${flags(p, true)}`;
  const inits = (n) => String(n || '').replace(/[^A-Za-z ]/g, '').split(' ').filter(Boolean).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  const bedCell = (bed, short, mode, shared, narrow) => { const p = roomsInUse()[bed], o = ownerOf(bed);
    const cls = `bed${bedOff(bed) ? ' off' : ''}${p ? ' used' : ''}${p && p.stage === 'queue' ? ' hb' : ''}${p && codeFor(p) ? ' code' : ''}${o === 'me' ? ' mine' : ''}${S.moveFor && !p ? ' target' : ''}`;
    const placing = mode === 'super' && S.placeFor && !p ? (dropWhy(byId(S.placeFor), bed) ? ' no-drop' : ' fit') : '';
    if (placing === ' fit') return `<button type="button" class="${cls} fit" data-placebed="${esc(bed)}" aria-label="Place ${esc(byId(S.placeFor).name)} in ${esc(bed)}"><span class="bed-n">${esc(short)}</span><small class="free-l">Place</small></button>`;
    if (mode === 'pick') { const on = pickSelNow().includes(bed), other = o && o !== 'me' ? o : null; return `<button type="button" class="${cls.replace(' mine', '')}${on ? ' mine picked' : ''} pickable" data-pickbed="${esc(bed)}" aria-pressed="${on}"${p ? ` style="--u:${U(p.urgency).colour}"` : ''}><span class="bed-n">${esc(short)}</span>${on ? `${face('me')}<b>Yours</b>` : other ? `${face(other)}<b>${esc(first(other))}</b>` : `<small class="free-l">${p ? `${esc(p.name)} waiting · nobody's` : bedOff(bed) ? 'Unavailable' : closedBed(bed) ? `Closed${S.roomCfg[roomIdOf(bed)].why ? ': ' + esc(S.roomCfg[roomIdOf(bed)].why) : ''}` : 'Free'}</small>`}</button>`; }
    return `<div class="${cls}${placing}" data-bed="${esc(bed)}"${p ? ` style="--u:${U(p.urgency).colour}" data-open="${p.id}"${mode === 'super' ? ` data-drag="${p.id}"` : ''} role="button" tabindex="0" aria-label="${esc(p.name)} in ${esc(bed)}${o ? ', ' + esc(nm(o)) + '\u2019s bed' : ''}. Enter opens the record${mode === 'super' ? ', M moves them' : ''}."` : ''}>
      ${narrow ? '' : `<span class="bed-n">${esc(short)}</span>`}${shared ? face(o) : ''}${p ? `<b title="${esc(p.name)} · ${esc(p.stage === 'queue' ? 'Waiting in room' : status(p))}">${esc(narrow ? p.name.split(' ')[0] : p.name)}</b>${narrow ? '' : `<small class="bed-st">${esc(p.stage === 'queue' ? 'Waiting in room' : status(p))}</small>`}<span class="bed-tags">${bedIcons(p)}</span>` : `<small class="free-l">${bedOff(bed) ? 'Off' : narrow ? '' : 'Free'}</small>`}</div>`; };
  const roomBox = (r, mode) => { const beds = D.BEDS.filter((b) => D.roomOfBed(b) === r), g = FLOOR.rooms[r.id]; if (!g) return '';
    const c = S.roomCfg[r.id], rd = S.roomDept[r.id], open = !beds.some(ownerOf);
    const owners = [...new Set(beds.map(ownerOf).filter(Boolean))];
    const helpers = S.reqs.filter((x) => isOpenReq(x) && x.acceptedBy && x.type !== 'imaging' && beds.includes((byId(x.pid) || {}).room));
    const people = [...owners, ...helpers.map((x) => x.acceptedBy)];
    const who = mode === 'pick' ? '' : `<span class="rh-who">${owners.map((o) => `${face(o)}${g[2] >= 100 ? `<i>${esc(o === 'me' ? 'You' : first(o).replace('Dr. ', 'Dr '))}</i>` : ''}`).join('')}${helpers.map((x) => `<span class="face helper${x.hereAt ? '' : ' going'}" style="--dc:${deptColour(staffDept(x.acceptedBy))}" title="${esc(nm(x.acceptedBy))} ${x.hereAt ? 'is here' : 'is on the way'} (${esc(REQ[x.type][0].toLowerCase())})">${esc(initial(x.acceptedBy))}</span>`).join('')}</span>`;
    return `<div class="fp-room${c.kids ? ' ped' : ''}${c.closed ? ' closed' : ''}${open ? ' open' : ''}${mode === 'pick' && rd === S.rdept ? ' mydept' : ''}${g[2] > g[3] * 1.3 ? ' wide' : ''}${r.beds > 1 && g[2] <= g[3] * 1.3 ? ' stack' : ''}${g[3] <= 55 ? ' short' : ''}${S.face && people.includes(S.face) ? ' hl' : ''}" data-room="${r.id}" data-people="${people.join(' ')}" title="Room ${r.id} · ${esc(rd)}${c.kids ? ' · children only' : ''}${c.closed ? ' · closed' : ''}" style="${box(g)};--dc:${deptColour(rd)}">
      <div class="fp-rh"><b>${r.id}</b>${g[2] >= 100 || mode === 'pick' ? `<span class="rd-tag">${esc(rd)}</span>` : ''}${c.kids ? '<span class="ped-tag">Paediatric</span>' : ''}${c.adults ? '<span class="ad-tag">Adults</span>' : ''}${who}${mode === 'super' ? `<button type="button" class="rh-edit" data-roomcfg="${r.id}" aria-label="Room ${r.id} settings" title="Room ${r.id} settings"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/></svg></button>` : ''}</div>
      ${c.closed ? `<div class="cl-why"><b>Closed</b>${c.why ? `<span>${esc(c.why)}</span>` : ''}</div>` : ''}
      <div class="fp-beds">${beds.map((b) => bedCell(b, r.beds > 1 ? 'Bed ' + b.slice(-1) : 'Bed', mode, owners.length > 1, mode !== 'pick' && !(g[2] > g[3] * 1.3))).join('')}</div></div>`; };
  const floorInner = (mode) => `${FLOOR.walls.map((w) => `<div class="fp-block" style="${box(w)}"></div>`).join('')}${hubSvg()}<div class="fp-rest" style="${box(FLOOR.restroom)}"><b>Family Restroom</b></div>${D.ROOMS.map((r) => roomBox(r, mode)).join('')}${wallSegs()}${exitLabels()}`;
  function wallSegs() {
    const seg = (side, from, to) => side === 'top' || side === 'bottom'
      ? `<i class="fp-wall fw-h" style="left:${pc(from, FW)};width:${pc(to - from, FW)};${side === 'top' ? 'top:0' : 'bottom:0'}"></i>`
      : `<i class="fp-wall fw-v" style="top:${pc(from, FH)};height:${pc(to - from, FH)};${side === 'left' ? 'left:0' : 'right:0'}"></i>`;
    const run = (side, len) => { const gaps = (FLOOR.gaps[side] || []).slice().sort((a, b) => a[0] - b[0]); let at = 0, out = '';
      gaps.forEach(([g0, g1]) => { out += seg(side, at, g0); at = g1; }); return out + seg(side, at, len); };
    return run('top', FW) + run('bottom', FW) + run('left', FH) + run('right', FH);
  }
  function exitLabels() {
    const lab = (side, a, b2, text) => { const mid = (a + b2) / 2;
      return side === 'right' ? `<span class="fp-exit fx-right" style="top:${pc(mid, FH)}">→ ${esc(text)}</span>`
        : `<span class="fp-exit fx-${side}" style="left:${pc(mid, FW)}">${side === 'top' ? '↑' : '↓'} ${esc(text)}</span>`; };
    return Object.entries(FLOOR.gaps).flatMap(([side, list]) => list.map(([a, b2, t]) => lab(side, a, b2, t))).join('');
  }
  const hubSvg = () => `<svg class="fp-hub" viewBox="0 0 ${FW} ${FH}" preserveAspectRatio="none" aria-hidden="true"><polygon points="${FLOOR.hub.map((x) => x.join(',')).join(' ')}"/></svg>
    <div class="fp-hub-label" style="${box([95, 115, 230, 80])}"><b>Central Hub</b><small>Nurses' & doctors' station · break room · lockers</small></div>
    <div class="fp-hub-label front" style="${box([150, 235, 140, 55])}"><b>Reception</b><small>Front desk, facing the main waiting area</small></div>`;
  // Moving patients: drag a patient (or someone from Up next) onto a bed. The checks, a swap offer and the log live in
  // planMove(); the keyboard and touch-free way is "Move to…" (M on a bed, or the button in the record).
  function planMove(pid, bed) {
    const p = byId(pid), other = roomsInUse()[bed];
    if (!p || p.room === bed) return;
    const no = dropWhy(p, bed); if (no) { toast(`${esc(no)}. Change the room's settings first if you need it.`); return; }
    if (other) { S.pending = { pid, bed, swap: other.id }; return; }
    doMove(pid, bed);
  }
  function doMove(pid, bed, swapId) {
    S.pending = null; S.moveFor = null;
    if (swapId) call('chart_swap', { p_case_a: pid, p_case_b: swapId }, 'Swapped.');
    else call('chart_move', { p_case: pid, p_bed: bedId(bed) }, `Moved to ${esc(bed)}.`);
  }
  function movePanel() {
    if (S.pending) { const pd = S.pending, p = byId(pd.pid), o = pd.swap && byId(pd.swap);
      return `<div class="move-ask" role="alertdialog" aria-label="Confirm the move"><b>${o ? `${esc(pd.bed)} has ${esc(o.name)} in it.` : `Move ${esc(p.name)} to ${esc(pd.bed)}?`}</b>
        ${pd.warnPed ? `<span class="tag-warn">${esc(pd.bed.split(' ')[0])} is Children only. ${esc(p.name)} is ${p.age ? p.age : 'not a child'}.</span>` : ''}
        <div class="row-btns">${o ? `<button type="button" class="btn" data-mv-swap>Swap them${p.room ? '' : ` (${esc(o.name)} goes back to Up next)`}</button>` : `<button type="button" class="btn" data-mv-yes>Move anyway</button>`}<button type="button" class="btn ghost" data-mv-no>Cancel</button></div></div>`; }
    if (S.moveFor) { const p = byId(S.moveFor);
      return `<div class="move-ask"><b>Move ${esc(p.name)}${p.room ? ` from ${esc(p.room)}` : ''} to…</b><div class="chips">${D.BEDS.filter((b) => b !== p.room && !closedBed(b) && (S.role === 'super' || ownerOf(b) === 'me')).map((b) => { const o = roomsInUse()[b];
        return `<button type="button" class="chip${o ? '' : ' free'}" data-mv-to="${esc(b)}">${esc(b)}${o ? ` · swap with ${esc(o.name)}` : ownerOf(b) ? ` · ${esc(first(ownerOf(b)))}'s` : ' · nobody’s'}${kidsOnly(b) ? ' · children' : ''}</button>`; }).join('')}</div>
        <button type="button" class="link" data-mv-no>Cancel</button></div>`; }
    return '';
  }
  // "What you did", orders, results and diagnoses are typed, not picked (owner, 19 Nov 2026: "we don't know what the
  // in-game stuff is"). Under each box: what staff have typed before, most used first; tap one to use it again. The
  // list grows from use. Counts come from every record in the prototype (in the real Chart: the database).
  const usage = (kind, key) => { const all = P(), c = new Map(), add = (t) => { if (t) { const k = t.trim(); c.set(k, (c.get(k) || 0) + 1); } };
    if (kind === 'did') all.forEach((x) => x.did.forEach((d) => add(d.what)));
    if (kind === 'order') all.forEach((x) => x.orders.forEach((o) => add(o.what)));
    if (kind === 'result') all.forEach((x) => x.orders.forEach((o) => { if (o.result && (!key || o.what.toLowerCase() === key.toLowerCase())) add(o.result); }));
    if (kind === 'dx') all.forEach((x) => add(x.diagnosis));
    if (kind === 'sym') all.forEach((x) => (x.symptoms || []).forEach(add));
    if (kind === 'follow') all.forEach((x) => add(x.follow));
    if (kind === 'advice') all.forEach((x) => add(x.advice));
    if (kind === 'consult') all.forEach((x) => (x.consults || []).forEach((c) => add(c.text)));
    return [...c.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])); };
  const suggChips = (id, kind, key, typed) => { const t = (typed || '').trim().toLowerCase();
    const list = usage(kind, key).filter(([w]) => !t || w.toLowerCase().includes(t)).slice(0, 8);
    return list.length ? `<span class="sg-l">Suggestions</span>${list.map(([w, n]) => `<button type="button" class="chip sug" data-fbpick="${id}" data-fbval="${esc(w)}">${esc(w)}${n > 1 ? ` <i>×${n}</i>` : ''}</button>`).join('')}` : (t ? '' : '<span class="sg-l">Nothing typed before yet. What you add here will show up as a suggestion next time.</span>'); };
  const fbox = (id, kind, key, placeholder, btn) => `<div class="fbox"><div class="fb-row"><input id="fb-${id}" data-fb="${id}" data-fbkind="${kind}" data-fbkey="${esc(key || '')}" value="${esc((S.fb || {})[id] || '')}" placeholder="${esc(placeholder)}" autocomplete="off" enterkeyhint="done"><button type="button" class="btn" data-fbadd="${id}">${btn}</button></div>
    <div class="fb-sugg" id="sg-${id}">${suggChips(id, kind, key, (S.fb || {})[id])}</div></div>`;
  // Symptoms in the record. Anyone working the case can add them (the server allows the desk, the owner and anyone who
  // worked it); NPCs and desk check-ins often start with none.
  const canAddSym = (p) => p && ['queue', 'care'].includes(p.stage) && !(RECS[p.id] || {}).limited && (p.nurse === 'me' || ['reception', 'super'].includes(S.role) || S.reqs.some((r) => r.pid === p.id && r.acceptedBy === 'me'));
  const symBlock = (p) => { const add = canAddSym(p), editing = add && S.symEdit === p.id;
    if (!p.symptoms.length && !p.diagnosis && !add) return '';
    return `<section class="rs sym-sec"><h4>Symptoms</h4>${p.symptoms.length ? `<div class="tags ro">${p.symptoms.map((x) => `<span class="tag">${esc(x)}</span>`).join('')}</div>` : ''}
      ${editing ? `${fbox('rsym', 'sym', '', 'e.g. headache, hurt left arm', 'Add')}<button type="button" class="link" data-symx="1">Done</button>` : add ? `<button type="button" class="link sym-add" data-symadd="${p.id}">+ Add symptoms</button>` : ''}
      ${p.diagnosis ? `<p class="rs-dx">Diagnosis: <b>${esc(p.diagnosis)}</b></p>` : ''}</section>`; };
  const tagList = (list, rmAttr) => (list.length ? `<div class="tags">${list.map((x, i) => `<span class="tag">${esc(x)}<button type="button" ${rmAttr}="${i}" aria-label="Remove ${esc(x)}">×</button></span>`).join('')}</div>` : '');
  const didList = (p) => (p.did.length ? `<ul class="didlist">${p.did.map((d, i) => `<li><time>${clock(d.at)}</time><span>${esc(d.what)}</span><small>${esc(first(d.by))}</small>${d.by === 'me' ? `<button type="button" class="x-mini" data-didrm="${i}" aria-label="Remove ${esc(d.what)}">×</button>` : ''}</li>`).join('')}</ul>` : '');
  const WHO = ['Anyone', 'Nurse', 'Doctor', 'Radiology'];
  const whoPick = () => `<div class="chips who" role="group" aria-label="Who does it">${WHO.map((w) => chip(w, (S.orderWho || 'Anyone') === w, `data-ow="${w}"`)).join('')}</div>`;
  const resultsBlock = (p, big) => { const done = p.orders.filter((o) => o.done);
    return done.length ? done.map((o) => { const i = p.orders.indexOf(o); return `<div class="res"><b>${esc(o.what)}</b>${o.result ? `<span class="res-v">${esc(o.result)} <button type="button" class="link" data-reschange="${i}">Change</button></span>` : fbox('res' + i, 'result', o.what, 'What came back? e.g. normal, shows dehydration', 'Save')}</div>`; }).join('')
      : `<p class="muted">Nothing done yet. Results go here once something in Orders is marked done.</p>`; };
  const dxBlock = (p) => (p.diagnosis && !S.dxEdit ? `<p class="res-v big"><b>${esc(p.diagnosis)}</b> <button type="button" class="link" data-a="dxedit">Change</button></p>` : fbox('dx', 'dx', '', 'What was wrong? e.g. dehydrated, broken left arm', 'Save'));
  const canReq = (p) => p.stage === 'care' && (p.nurse === 'me' || S.role === 'super');
  // Requests: one per type at a time (audit #5); an open one shows its state with Chase / Cancel instead of Ask.
  const openReqOf = (p, t) => S.reqs.find((r) => r.pid === p.id && r.type === t && isOpenReq(r));
  const reqMenu = (p) => { const sel = S.rq, ex = sel && openReqOf(p, sel);
    return `<div class="rq-menu"><div class="chips">${['doctor', 'surgery', 'imaging', 'help'].map((t) => { const o = openReqOf(p, t); return `<button type="button" class="chip${sel === t ? ' on' : ''}${o ? ' has' : ''}" data-rqpick="${t}">${REQ[t][0]}${o ? ` · ${o.acceptedBy ? 'accepted' : 'requested'}` : ''}</button>`; }).join('')}<button type="button" class="chip code-chip" data-rqcode="${p.id}">Code Blue</button></div>
    ${ex ? `<div class="rq-ex"><span>${esc(REQ[sel][0])} ${ex.type === 'imaging' ? 'in progress' : `requested ${ago(ex.at) === 'just now' ? 'just now' : ago(ex.at) + ' ago'} · ${ex.acceptedBy ? youAre(ex.acceptedBy, ex.hereAt ? 'at the bedside' : 'on the way') : 'waiting'}`}${ex.auto ? ' · from check-in' : ''}.</span><span class="row-btns">${!ex.acceptedBy && ex.type !== 'imaging' ? `<button type="button" class="btn small" data-rqchase="${ex.id}">Chase</button>` : ''}${ex.type !== 'imaging' ? `<button type="button" class="btn small ghost" data-rqcancel="${ex.id}">Cancel request</button>` : ''}</span></div>`
      : sel ? `<p class="muted small">${REQ[sel][1]}.</p>${sel === 'surgery' ? `<div class="chips">${chip('Come down', S.rqMode !== 'take', 'data-rqmode="down"')}${chip('Take to surgery', S.rqMode === 'take', 'data-rqmode="take"')}</div>` : ''}
      <div class="fb-row"><input id="rq-note" placeholder="${sel === 'imaging' ? 'Which scan? e.g. X-ray of the left arm (optional)' : 'One line, optional: e.g. chest pain, ECG changed'}" autocomplete="off"><button type="button" class="btn" data-rqgo="${p.id}">${sel === 'imaging' ? 'Going to Radiology' : 'Send request'}</button></div>` : ''}</div>`; };
  const reqBlock = (p) => { const rs = reqsFor(p), c = codeFor(p); if (!rs.length && !c) return '';
    return `<div class="rq-block">${c ? `<div class="rq-row code"><span class="rq-type">Code Blue</span><span>Called ${elapsed(c.at)} ago by ${esc(first(c.by))}</span><span class="row-btns"><button type="button" class="btn small" data-codeclear="${p.id}">Clear Code Blue</button></span></div>` : ''}${rs.map((r) => { const lv = reqLevel(r);
      return `<div class="rq-row ${lv}"><span class="rq-type" title="${esc(REQ[r.type][0])}">${RT[r.type]}</span><span>${r.type === 'imaging' ? `In Radiology · ${elapsed(r.at)}` : r.acceptedBy ? `${youAre(r.acceptedBy, r.hereAt ? 'at the bedside' : 'on the way')} · ${elapsed(r.acceptedAt)}` : `No one has accepted yet · ${elapsed(r.at)}`}${r.auto ? ' · from check-in' : ''}</span>
        <span class="row-btns">${r.type === 'imaging' && r.by === 'me' ? `<button type="button" class="btn small" data-rqdone="${r.id}">Back on the ward</button>` : ''}${lv === 'late' ? `<button type="button" class="btn small" data-rqagain="${r.id}">Ask someone else</button>` : ''}</span>
        ${lv === 'stuck' && !r.kept && r.by === 'me' ? `<div class="rq-stuck"><b>No one has accepted yet.</b><span class="row-btns"><button type="button" class="btn small ghost" data-rqkeep="${r.id}">Keep waiting</button><button type="button" class="btn small ghost" data-rqwithout="${r.id}">Continue without</button><button type="button" class="btn small" data-rqhelp="${r.id}">Request assistance</button></span></div>` : ''}</div>`; }).join('')}</div>`; };
  // Discharge tab (computer) and the phone's discharge screen share this.
  const lvField = (k, label, ph) => `<label class="f"><span>${label}</span><input id="lv-${k}" value="${esc(S.lv[k] || '')}" placeholder="${ph}" autocomplete="off"></label>`;
  const nowHM = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const deathForm = (p) => `<div class="death-form"><b>Record a death</b><span class="muted small">This closes the case as Deceased. The patient's own screen will only say “Your visit has ended”.</span>
    <div class="row2"><label class="f"><span>Time of death</span><input id="dth-time" type="time" value="${esc(S.dth.time || nowHM())}"></label>
    <label class="f"><span>Confirmed by</span><select id="dth-by">${D.STAFF.filter((x) => x.you || ['room', 'oncall'].includes(S.staffRole[x.id])).map((x) => `<option value="${x.id}"${(S.dth.by || 'me') === x.id ? ' selected' : ''}>${esc(x.you ? x.name + ' (you)' : x.name)}</option>`).join('')}</select></label></div>
    <label class="f"><span>Note</span><input id="dth-note" value="${esc(S.dth.note || '')}" placeholder="e.g. Passed away peacefully after a Code Blue; family informed in game." autocomplete="off"></label>
    <div class="row-btns"><button type="button" class="btn warn" data-a="deathgo"${(S.dth.note || '').trim() ? '' : ' disabled'}>Record death</button><button type="button" class="btn ghost" data-a="deathx">Cancel</button></div></div>`;
  const leaveBody = (p) => `<section class="rs"><h4>Outcome</h4><div class="outs">${D.OUTCOMES.map(([k, l, h]) => `<button type="button" class="out${S.outcome === k ? ' on' : ''}" data-out="${k}"><b>${l}</b><span>${h}</span></button>`).join('')}</div></section>
      ${S.outcome === 'follow' ? lvField('follow', 'Follow-up: what and when (needed)', 'e.g. come back in 2 days to check the dressing') : ''}${S.outcome === 'admit' ? lvField('admit', 'Admitted to (needed)', 'e.g. Ward 2, or Surgery Ward') : ''}${S.outcome === 'left' ? lvField('left', 'What happened (one line, needed)', 'e.g. left before the X-ray, advised to come back') : ''}
      ${S.outcome && S.outcome !== 'left' ? `<section class="rs"><h4>Advice for the patient <em>optional</em></h4>${p.advice ? `<span class="res-v">${esc(p.advice)} <button type="button" class="link" data-advrm>Change</button></span>` : fbox('adv', 'advice', '', 'e.g. drink plenty of water, rest the arm', 'Save')}</section>
      <section class="rs"><h4>Discharge papers</h4>${papers(p, S.outcome, S.lv.follow)}</section>` : ''}
      <section class="rs rs-death">${S.deathFor === p.id ? deathForm(p) : '<button type="button" class="btn small ghost" data-a="deathopen">Record a death…</button>'}</section>`;
  function recordPane(p) {
    const steps = ['Waiting', 'Assessment', 'Treatment', 'Discharge'], si = p.phase === 'assigned' || p.phase === 'called' || p.stage === 'queue' ? 0 : p.did.length || p.orders.length || p.diagnosis ? 2 : 1;
    const consult = S.role === 'oncall' && p.nurse !== 'me';   // the On call doctor's view: their job, not the nurse's chart
    const tabs = [['chart', 'Chart'], ['orders', 'Orders'], ['results', 'Results'], ...(consult || p.stage !== 'care' || (p.nurse !== 'me' && S.role !== 'super') ? [] : [['leave', 'Discharge']])];
    if (!tabs.some((t) => t[0] === S.tab)) S.tab = 'chart';
    const nurseOwns = p.nurse === 'me' || S.role === 'super';
    let body = '';
    const urgBlock = nurseOwns && S.urgOpen ? `${urgPicker(p.urgency, 'data-purg')}<div class="rs-act"><button type="button" class="btn small ghost" data-a="urgx">Done</button></div>`
      : `<div class="urg-now">${upill(p.urgency)}<span class="${p.colourConfirmed ? 'okmark' : 'muted small'}">${p.colourConfirmed ? 'Confirmed' : p.nurse === 'me' ? 'Not confirmed yet' : 'The nurse confirms it'}</span>${nurseOwns && p.colourConfirmed ? '<button type="button" class="link" data-a="urgopen">Change</button>' : ''}</div>`;
    if (S.tab === 'chart') body = `
      <section class="rs"><h4>Triage colour</h4>${urgBlock}</section>
      ${p.vitals.length || S.vopen ? `<section class="rs"><div class="rs-h"><h4>Vitals</h4>${S.vopen || consult ? '' : '<button type="button" class="link" data-a="vopen">+ Add vitals</button>'}</div>${S.vopen ? vitalForm() : vitalCards(p)}</section>` : consult ? '' : '<button type="button" class="link add-l" data-a="vopen">+ Add vitals</button>'}
      ${symBlock(p)}
      <section class="rs"><h4>Care given</h4>${didList(p)}${consult ? (p.did.length ? '' : '<p class="muted small">Nothing recorded yet.</p>') : fbox('did', 'did', '', 'e.g. bandaged left arm, gave fluids', 'Add')}</section>
      ${(p.consults || []).length ? `<section class="rs"><h4>Consults</h4><ul class="didlist">${p.consults.map((c) => `<li><time>${clock(c.at)}</time><span>${esc(c.text || 'No note')}</span><small>${esc(REQ[c.type][0])} · ${esc(first(c.by))}</small></li>`).join('')}</ul></section>` : ''}
      <section class="rs"><h4>Notes</h4><textarea id="p-notes" rows="2" placeholder="Anything worth knowing"${consult ? ' readonly' : ''}>${esc(p.notes)}</textarea></section>
      <details class="rs hist"><summary>History</summary>${timeline(p)}<h5>Colour changes</h5>${colourHistory(p)}</details>`;
    if (S.tab === 'orders') body = `<section class="rs"><h4>Orders</h4>${p.orders.length ? `<ul class="olist">${p.orders.map((o, i) => `<li class="${o.done ? 'done' : ''}"><div><b>${esc(o.what)}</b><small>Ordered by ${esc(first(o.by))} · ${clock(o.at)} · ${o.who === 'Anyone' ? 'anyone can do it' : o.who === 'Radiology' ? 'for Radiology' : 'for a ' + esc(o.who.toLowerCase())}</small></div>${o.done ? `<span class="okmark">Done ${clock(o.done)}</span>` : `<button type="button" class="btn small" data-odone="${i}">Mark done</button>`}</li>`).join('')}</ul>` : '<p class="muted">No orders yet.</p>'}</section>
      <section class="rs"><h4>New order</h4>${whoPick()}${fbox('ord', 'order', '', 'e.g. blood sample, X-ray of the left leg', 'Order')}</section>`;
    if (S.tab === 'results') body = `<section class="rs"><h4>Results</h4>${resultsBlock(p)}</section><section class="rs"><h4>Diagnosis</h4>${dxBlock(p)}</section>`;
    if (S.tab === 'leave') body = leaveBody(p);
    const movable = p.room && ((p.nurse === 'me' && freeBedsOf('me').length) || S.role === 'super');
    return `<div class="record">
      <header class="r-head" style="--u:${U(p.urgency).colour}"><div class="rh-main"><h3>${esc(p.name)}${p.age ? `<small>, ${p.age}</small>` : ''}</h3>
          ${p.careNotes ? `<div class="rh-care">${esc(p.careNotes)}</div>` : ''}<div class="rh-meta">${upill(p.urgency)}<span>${esc(p.room || p.where || 'No bed')}</span><span class="rh-step" title="${steps.join(' → ')}"><i class="dots" aria-hidden="true">${steps.map((t, i) => `<i class="${i < si ? 'd' : i === si ? 'n' : ''}"></i>`).join('')}</i>${esc(status(p))}</span>${p.nurse && p.stage === 'care' && stCode(p) !== 'assigned' ? `<span>${esc(title(p.nurse))}</span>` : ''}${teamChips(p) ? `<span class="rh-teams">${teamChips(p)}</span>` : ''}${flags(p) ? `<span class="rh-flags">${flags(p)}</span>` : ''}${p.npc ? '<span class="rq-ic npc">NPC</span>' : ''}${p.room && kidsOnly(p.room) && !isChild(p) ? '<span class="tag-warn">Paediatric room</span>' : ''}</div></div>
        <div class="rh-acts">${canReq(p) ? `<button type="button" class="btn small ghost" data-a="reqmenu" aria-expanded="${S.reqMenu}">Request</button>` : ''}${p.nurse === 'me' && p.stage === 'care' ? `<button type="button" class="btn small ghost" data-hb="${p.id}">Hand over</button>` : ''}${movable ? '<button type="button" class="btn small ghost" data-a="mvbedopen">Move bed…</button>' : ''}<button type="button" class="x" data-a="closerec" aria-label="Close the record">×</button></div>
        ${nextBarHtml(p)}</header>
      ${S.mvBed === p.id ? `<div class="pane-pad rq-pad"><div class="mv-bed"><b>Move ${esc(p.name)} to:</b><div class="chips">${(S.role === 'super' ? freeRooms().filter((b) => !dropWhy(p, b)) : freeBedsOf('me').filter((b) => !dropWhy(p, b))).map((b) => `<button type="button" class="chip" data-mvbed="${esc(b)}">${esc(b)}</button>`).join('') || '<span class="muted small">No free bed they can go to.</span>'}</div><button type="button" class="link" data-a="mvbedx">Cancel</button></div></div>` : ''}
      ${S.handbackFor === p.id ? `<div class="pane-pad" style="padding-bottom:0">${handbackBox(p)}</div>` : ''}
      ${(S.reqMenu && canReq(p)) || reqBlock(p) ? `<div class="pane-pad rq-pad">${S.reqMenu && canReq(p) ? reqMenu(p) : ''}${reqBlock(p)}</div>` : ''}
      <div class="r-tabs" role="tablist">${tabs.map(([k, l]) => `<button type="button" role="tab" aria-selected="${S.tab === k}" data-tab="${k}">${l}${k === 'orders' && p.orders.some((o) => !o.done) ? ` <i>${p.orders.filter((o) => !o.done).length}</i>` : ''}</button>`).join('')}</div>
      <div class="r-body">${body}</div></div>`;
  }
  const SECTIONS = { reception: [['desk', 'Front Desk']], room: [['myroom', 'My Room'], ['board', 'Ward Board']], oncall: [['reqs', 'Requests'], ['board', 'Ward Board']],
    road: [['road', 'Incoming'], ['board', 'Ward Board']], super: [['plan', 'Floor Plan'], ['desk', 'Front Desk'], ['reqs', 'Requests'], ['board', 'Ward Board']] };
  const me = () => staff('me');
  function roleScreen() {
    const can = (r) => (S.canPick || []).includes(r);
    const ds = D.CARE_DEPTS.map((x) => x[0]).filter((d) => S.myDepts.includes(d)), room = can('room') ? ds.filter((d) => d !== 'Paramedicine') : [], oc = can('on_call') ? ds.filter((d) => d === 'Medical' || d === 'Surgical') : [];
    const db = (r, d) => `<button type="button" class="btn" style="--dc:${deptColour(d)}" data-role="${r}" data-rdept="${d}">${d}</button>`;
    return `<div class="role-screen"><div class="rs-in"><span class="lab">${S.session ? 'Session live' : 'No session running'} · CBH Chart</span><h1>What are you doing ${S.session ? 'this session' : 'right now'}?</h1>
      <p class="muted">${S.session ? 'Pick one. During a session the patients are players only: no NPCs.' : `No session is on, so NPC patients can be charted.${nextSess() ? ` Next session: <b>${esc(nextSess())}</b>.` : ''}`}</p>
      <div class="role-cards">
        ${can('reception') || !S.recOpen ? `<button type="button" class="rc" data-role="reception"${S.recOpen ? '' : ' disabled'}><span class="rc-ic rc-rec" aria-hidden="true"></span><b>Reception</b><span>${S.recOpen ? 'Check people in, set their colour, call them in, check them out. You only see the front desk.' : 'The supervisor has closed Reception, so everyone is Patient Care.'}</span></button>` : ''}
        <div class="rc care"><span class="rc-ic rc-care" aria-hidden="true"></span><b>Patient Care</b>
          ${!room.length && !oc.length && !(can('road') && ds.includes('Paramedicine')) ? '<p class="muted small">None of your departments work at the bedside.</p>' : ''}${room.length ? `<div class="pc-opt"><b>Room</b><span>Pick your room, press Ready, and you're given patients.</span><div class="rc-depts">${room.map((d) => db('room', d)).join('')}</div></div>` : ''}
          ${oc.length ? `<div class="pc-opt"><b>On call</b><span>Take doctor requests: go to the room and write your part.</span><div class="rc-depts">${oc.map((d) => db('oncall', d)).join('')}</div></div>` : ''}
          ${can('road') && ds.includes('Paramedicine') ? `<div class="pc-opt"><b>Road</b><span>Ambulance cases: tell the ER who's coming.</span><div class="rc-depts">${db('road', 'Paramedicine')}</div></div>` : ''}</div>
        ${S.canSuper && can('supervisor') ? '<button type="button" class="rc" data-role="super"><span class="rc-ic rc-sup" aria-hidden="true"></span><b>Supervisor</b><span>Run the floor plan: give out patients and rooms, and watch requests. You have Supervise sessions (session hosts get it too).</span></button>' : ''}
      </div>${S.superOther && S.canSuper ? '<p class="muted small">Someone else is supervising. Two supervisors both have full powers.</p>' : ''}</div></div>`;
  }
  const nextSess = () => { try { const n = typeof currentSession === 'object' && currentSession && currentSession.next; return n && typeof whenAhead === 'function' ? whenAhead(n.scheduled_for) : ''; } catch { return ''; } };
  const holdScreen = (h, t, btn) => `<div class="role-screen"><div class="rs-in"><span class="lab">CBH Chart</span><h1>${h}</h1>${t ? `<p class="muted">${t}</p>` : ''}${btn || ''}</div></div>`;
  const gate = () => (!SNAP ? holdScreen(S.pollErr ? 'The Chart didn\u2019t load' : 'Loading the Chart\u2026', S.pollErr ? `${esc(S.pollErr)} It tries again by itself in a few seconds.` : '')
    : !S.onShift ? holdScreen('Start a shift to use the Chart', `The Chart is for staff on shift.${nextSess() ? ` Next session: <b>${esc(nextSess())}</b>.` : ''}`, '<a class="btn" href="#shifts">Go to Shift Manager</a>')
    : S.role ? '' : roleScreen());
  const deskCount = () => callOuts().length + toConfirm().length;
  const openReqCount = () => S.reqs.filter((r) => isOpenReq(r) && !r.acceptedBy && r.type !== 'imaging' && (S.role === 'super' || canAccept(r))).length;
  const codeBar = () => (S.codes.length ? `<div class="code-bar" role="alert">${S.codes.map((c) => { const p = byId(c.pid); return `<div><b>CODE BLUE</b><span>Room ${esc(roomIdOf(p.room) || '?')} · ${esc(p.name)} · ${elapsed(c.at)}</span>${p.nurse === 'me' || S.role === 'super' ? `<button type="button" class="btn small" data-codeclear="${p.id}">Clear</button>` : ''}</div>`; }).join('')}</div>` : '');
  // The role card (owner, 19 Nov 2026): your role and team as a gradient in that team's colour. Reception is a warm
  // yellow, Supervisor goes teal to Executive blue.
  const roleLabel = () => (S.role === 'room' ? `Room · ${S.rdept}` : S.role === 'oncall' ? `On call · ${S.rdept}` : S.role === 'road' ? 'Road · Paramedicine' : ROLE_NAME[S.role] || '');
  const roleSub = () => ({ reception: 'Check-ins, call-outs, after-care', room: `${bedsOf('me').join(' · ') || 'No room yet'}${bedsOf('me').length ? ` · ${mine().length} of ${D.LIMIT}` : ''}`, oncall: 'Doctor and help requests',
    road: 'Ambulance cases for the ER', super: superOn() && S.superOther ? 'You and 1 other' : 'The whole floor' }[S.role] || '');
  const roleGrad = () => { if (S.role === 'reception') return 'background:linear-gradient(135deg,#FFD66B,#FFAA00);color:#0B1E4A';
    if (S.role === 'super') return 'background:linear-gradient(135deg,#2ED3C6,#3A82D0)';
    const c = deptColour(S.rdept || 'Nursing'); return `background:linear-gradient(135deg,color-mix(in srgb,${c} 72%,white),color-mix(in srgb,${c} 88%,#0B1E4A))`; };
  const roleCard = (cls = '') => `<div class="role-card ${cls}" style="${roleGrad()}" data-role="${S.role || ''}" data-dept="${esc(S.rdept || '')}"><span>You</span><b>${esc(roleLabel())}</b><small>${esc(roleSub())}</small>
    <div class="rc-alerts"><button type="button" class="snd-chip${A.on ? ' on' : ''}" data-a="sndtoggle" aria-pressed="${A.on}" title="${A.on ? 'Mute alert sounds' : 'Turn alert sounds on'}">${A.on ? 'Sounds on' : 'Muted'}</button><button type="button" class="snd-set" data-a="alertset" aria-expanded="${!!S.alertSet}" aria-label="Alert settings" title="Alert settings"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/></svg></button></div></div>${S.alertSet ? alertSettings() : ''}`;
  // ---------- ALERTS (owner, 19 Nov 2026): a ping when something is for you, a flashing tab title, desktop notifications ----------
  const A = Object.assign({ on: true, vol: 0.6, desk: false, asked: false }, load('alerts', {}));
  const saveA = () => save('alerts', { on: A.on, vol: A.vol, desk: A.desk, asked: A.asked });
  let actx = null, unseen = 0, lastTitle = '', flashT = null;
  const arm = () => { try { if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); } catch { /* no audio */ } };
  // Browsers only allow sound after the person has clicked the page once: the role screen click or Ready arms it.
  document.addEventListener('pointerdown', arm, { capture: true });
  const TONES = { patient: [[660, 0, .18], [880, .16, .26]], req: [[740, 0, .2], [988, .14, .22]], handback: [[523, 0, .18], [659, .15, .25]],
    arrival: [[587, 0, .16]], code: [[880, 0, .12], [660, .14, .12], [880, .28, .12], [660, .42, .12], [880, .56, .2]] };
  function tone(kind) { if (!A.on || !actx) return; const now = actx.currentTime, soft = kind === 'arrival' ? .45 : 1;
    TONES[kind].forEach(([f, at, dur]) => { const o = actx.createOscillator(), g = actx.createGain(); o.type = kind === 'code' ? 'square' : 'sine'; o.frequency.value = f;
      const v = A.vol * (kind === 'code' ? .18 : .35) * soft; g.gain.setValueAtTime(0, now + at); g.gain.linearRampToValueAtTime(v, now + at + .015); g.gain.exponentialRampToValueAtTime(.0001, now + at + dur);
      o.connect(g).connect(actx.destination); o.start(now + at); o.stop(now + at + dur + .02); }); }
  const baseTitle = 'CBH Chart · CareBeyond';
  function flashTitle(label) { lastTitle = label; if (flashT) return; let on = false;
    flashT = setInterval(() => { if (!unseen) { clearInterval(flashT); flashT = null; document.title = baseTitle; return; } on = !on; document.title = on ? `(${unseen}) ${lastTitle} – CBH Chart` : baseTitle; }, 1000); }
  const seen = () => { if (document.hidden) return; unseen = 0; document.title = baseTitle; };
  window.addEventListener('focus', seen); document.addEventListener('visibilitychange', seen);
  function alertMe(kind, label, body, pid) {
    tone(kind);
    if (document.hidden || !document.hasFocus()) { unseen += 1; flashTitle(label); }
    if (A.desk && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      try { const n = new Notification(`${label} – CBH Chart`, { body, tag: `${kind}-${pid || ''}`, icon: 'assets/cbh-icon.svg' });
        n.onclick = () => { window.focus(); if (pid && byId(pid) && ['care', 'queue'].includes(byId(pid).stage)) { if (isPhone()) S.ph = [S.ph[0], { s: 'patient', id: pid }]; else S.open = pid; } n.close(); render(); }; } catch { /* fine */ } }
  }
  // Watch for things that are new since the last redraw, so every path (auto-assign, the supervisor, demo staff) alerts the same way.
  const W = { ready: false, mine: new Set(), req: new Set(), code: new Set(), q: new Set() };
  function alertWatch() {
    const mineA = mine().filter((p) => p.phase === 'assigned'), reqs = S.role === 'oncall' || S.role === 'room' ? S.reqs.filter((r) => isOpenReq(r) && !r.acceptedBy && r.type !== 'imaging' && canAccept(r)) : [];
    const now = { mine: new Set(mineA.map((p) => p.id)), req: new Set(reqs.map((r) => `${r.id}:${r.chase || 0}`)), code: new Set(S.codes.map((c) => c.pid + '@' + +new Date(c.at))), q: new Set(S.role === 'super' ? upNext().map((p) => p.id) : []) };
    if (W.ready) {
      S.codes.filter((c) => !W.code.has(c.pid + '@' + +new Date(c.at))).forEach((c) => { const p = byId(c.pid); alertMe('code', 'CODE BLUE', `Room ${roomIdOf(p.room) || '?'} · ${p.name}`, p.id); });
      mineA.filter((p) => !W.mine.has(p.id)).forEach((p) => { if (!isPhone() && !S.open) { S.open = p.id; S.tab = 'chart'; setTimeout(render, 0); } });
      mineA.filter((p) => !W.mine.has(p.id)).forEach((p) => alertMe(p.handback ? 'handback' : 'patient', p.handback ? 'Handed over to you' : 'New patient', `${p.name} · ${U(p.urgency).name} · ${p.room || ''}. Accept within a minute.`, p.id));
      reqs.filter((r) => !W.req.has(`${r.id}:${r.chase || 0}`)).forEach((r) => { const p = byId(r.pid); alertMe('req', `${REQ[r.type][0]} request`, `Room ${roomIdOf(p.room) || '?'} · ${p.name} · from ${title(r.by)}`, p.id); });
      upNext().filter((p) => S.role === 'super' && !W.q.has(p.id)).forEach((p) => alertMe('arrival', 'New in Up next', `${p.name} · ${U(p.urgency).name}`, p.id));
    }
    Object.assign(W, now, { ready: true });
  }
  const alertSettings = () => `<div class="alert-pop" role="dialog" aria-label="Alert settings"><div class="ma-h"><b>Alerts</b><button type="button" class="link" data-a="alertset">Done</button></div>
    <button type="button" class="dm-t${A.on ? ' on' : ''}" data-a="sndtoggle" aria-pressed="${A.on}">Sounds</button>
    <label class="vol"><span>Volume</span><input type="range" min="0" max="1" step="0.05" value="${A.vol}" data-vol aria-label="Alert volume"></label>
    <button type="button" class="dm-t${A.desk ? ' on' : ''}" data-a="desktoggle" aria-pressed="${A.desk}"${'Notification' in window ? '' : ' disabled'}>Desktop alerts</button>
    <div class="row-btns"><button type="button" class="btn small ghost" data-a="sndtest">Test sound</button><button type="button" class="btn small ghost" data-a="sndtestcode">Test Code Blue</button></div>
    <small class="muted">${'Notification' in window && Notification.permission === 'denied' ? 'Desktop alerts are blocked in this browser\u2019s settings. ' : ''}On a phone, alerts only work while the CBH page is open.</small></div>`;
  async function askDesk() { if (!('Notification' in window)) { toast('This browser can\u2019t show desktop alerts.'); return; }
    const r = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission(); A.desk = r === 'granted'; A.asked = true; saveA();
    toast(A.desk ? 'Desktop alerts are on. You\u2019ll get them even when this tab is in the background.' : 'Desktop alerts are off. You can turn them on in the role card.'); render(); }

  function innerMenu() {
    const badge = { plan: upNext().length, desk: deskCount(), reqs: openReqCount(), myroom: mine().filter((p) => p.phase === 'assigned').length, road: 0, board: 0 };
    const red = { desk: 1, reqs: 1, myroom: 1 };
    return `<nav class="inner" aria-label="CBH Chart"><div class="in-head"><span class="in-tile" aria-hidden="true"></span><div><b>CBH Chart</b><small class="${S.session ? 'open' : ''}">${S.session ? 'Session live' : 'No session running'}${superOn() ? '' : ' · auto mode'}</small></div></div>
      ${roleCard()}<button type="button" class="link in-change" data-a="changerole">Change role</button>
      <div class="in-views"><span class="in-l">Views</span>${SECTIONS[S.role].map(([k, l]) => `<button type="button" class="in-link${S.sec === k ? ' on' : ''}" data-sec="${k}"${S.sec === k ? ' aria-current="page"' : ''}><span>${l}</span>${badge[k] ? `<i class="${red[k] ? 'red' : ''}">${badge[k]}</i>` : ''}</button>`).join('')}</div>
      <p class="in-note">${S.deskBy ? `Reception: ${esc(first(S.deskBy))}` : S.recOpen ? 'Nobody on Reception' : 'Reception closed'}${S.online ? '' : ' · walk-ins only'}</p>
</nav>`;
  }

  function computer() {
    const g = gate(); if (g) return g;
    if (S.open && (!byId(S.open) || !['care', 'queue'].includes(byId(S.open).stage))) S.open = null;
    const allowed = SECTIONS[S.role]; if (!allowed.some((x) => x[0] === S.sec)) S.sec = allowed[0][0];
    const sec = { board: boardSection, desk: deskSection, myroom: myRoomSection, reqs: reqSection, road: roadSection, plan: planSection }[S.sec]();
    return `${codeBar()}<div class="chart-wrap">${rail()}
      <div class="ch-main">${chTop()}<section class="pane-sec" aria-label="${allowed.find((x) => x[0] === S.sec)[1]}">${sec}</section></div>
      </div>`;
  }
  // The Chart's own menu is a slim rail while you work (owner, 19 Nov 2026): the role as a coloured chip; it opens on
  // hover or click to show the role card, Change role and the demo. The views are tabs across the top instead.
  function rail() {
    const ab = { reception: 'RC', room: 'RM', oncall: 'OC', road: 'RD', super: 'SV' }[S.role] || '';
    return `<nav class="rail${S.railOpen ? ' open' : ''}" aria-label="CBH Chart"><div class="rail-in">
      <div class="in-head"><span class="in-tile" aria-hidden="true"></span><div class="rx"><b>CBH Chart</b><small class="${S.session ? 'open' : ''}">${S.session ? 'Session live' : 'No session running'}</small></div></div>
      <button type="button" class="role-chip" style="${roleGrad()}" data-role="${S.role || ''}" data-dept="${esc(S.rdept || '')}" data-a="rail" aria-expanded="${!!S.railOpen}" title="${esc(roleLabel())}">${ab}</button>
      <div class="rx rail-role">${roleCard()}<button type="button" class="link in-change" data-a="changerole">Change role</button></div>
      <div class="rail-grow"></div></div></nav>`;
  }
  function chTop() {
    const badge = { plan: upNext().length, desk: deskCount(), reqs: openReqCount(), myroom: mine().filter((p) => p.phase === 'assigned').length, road: 0, board: 0 };
    const red = { desk: 1, reqs: 1, myroom: 1 };
    const pill = (on, t) => `<span class="spill${on ? ' on' : ''}">${t}</span>`;
    return `<div class="ch-top"><nav class="vtabs" role="tablist" aria-label="Views">${SECTIONS[S.role].map(([k, l]) => `<button type="button" role="tab" aria-selected="${S.sec === k}" data-sec="${k}">${l}${badge[k] ? `<i class="${red[k] ? 'red' : ''}">${badge[k]}</i>` : ''}</button>`).join('')}</nav>
      <div class="sess">${pill(S.session, S.session ? 'Session live' : 'No session')}${pill(S.recOpen, S.deskBy ? `Reception: ${esc(first(S.deskBy))}` : S.recOpen ? 'Reception open' : 'Reception closed')}${pill(S.online, S.online ? 'Online check-in open' : 'Walk-ins only')}${superOn() ? '' : pill(false, 'Auto mode')}
        <button type="button" class="btn small ghost top-change" data-a="changerole">Change role</button>
        ${S.role === 'super' ? `<div class="sess-m"><button type="button" class="btn small ghost" data-a="sessmenu" aria-expanded="${!!S.sessMenu}">Session ▾</button>${S.sessMenu ? `<div class="sess-pop" role="menu">
          <button type="button" class="dm-t${S.recOpen ? ' on' : ''}" data-a="recopen" aria-pressed="${S.recOpen}">Reception open</button>
          <button type="button" class="dm-t${S.online ? ' on' : ''}" data-a="online" aria-pressed="${S.online}">Online check-in open</button>
          <span class="muted small">${S.superOther ? 'Supervising: you and 1 other' : 'Supervising: you'}</span>
          ${S.session ? '<button type="button" class="btn small warn" data-a="endsess">End session…</button>' : '<span class="muted small">No session running</span>'}</div>` : ''}</div>` : ''}</div></div>`;
  }


  // ---------- PATIENT'S PHONE (what someone who checked in online sees, live) ----------
  const joinUrl = () => `https://www.roblox.com/games/start?launchData=${encodeURIComponent(JSON.stringify({ serverCode: String(D.JOIN_CODE) }))}&placeId=${D.ROBLOX_PLACE}`;
  const joinBlock = () => `<div class="pp-join"><a class="btn big" href="${joinUrl()}" target="_blank" rel="noopener">Join game</a>
    <div class="pp-code"><span>Or type the join code in Maple Hospital</span><b>${esc(D.JOIN_CODE)}</b><button type="button" class="btn small ghost" data-copycode>${S.copied ? 'Copied' : 'Copy'}</button></div></div>`;
  function patientPhone() {
    const p = S.pid && byId(S.pid), d = S.pdraft;
    let h;
    if (!p && !S.session) h = `<div class="pp-state"><h3>No session is running right now</h3><p>Online check-in opens when staff are on shift.${D.nextSession ? ` Next session: <b>${esc(D.nextSession)}</b>.` : ''}</p><a class="btn big discord" href="${D.DISCORD}" target="_blank" rel="noopener">Join our Discord</a><p class="muted small">See when the next sessions are.</p></div>`;
    else if (!p && !S.online) h = `<div class="pp-state"><h3>The online check-in desk is closed</h3><p>You can still come to the front desk in game.</p>${joinBlock()}</div>`;
    else if (!p) h = `<h3>Check in</h3><p class="pp-sub">CareBeyond Hospital · staff are on shift · no account needed</p>
      <label class="f"><span>Your Roblox username</span><input id="pd-name" value="${esc(d.name)}" placeholder="exactly as it shows above your head" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
      <div class="f"><span>What's wrong? <em>type each thing</em></span>${tagList(d.symptoms, 'data-pdsymrm')}${fbox('psym', 'sym', '', 'e.g. my arm hurts', 'Add')}</div>
      <div class="f"><span>How bad is it?</span><div class="chips">${['A little', 'Quite bad', 'Very bad'].map((x) => chip(x, d.said === x, `data-pdsaid="${x}"`)).join('')}</div></div>
      <button type="button" class="btn big" data-a="pdgo"${d.name.trim() && d.said ? '' : ' disabled'}>Check in</button>`;
    else if (p.stage === 'checkin') h = `<div class="pp-state"><span class="pp-ic">✓</span><h3>You're checked in</h3><p>The front desk will confirm you in a moment.</p><p class="pp-do">Go to <b>${esc(D.WAITING_ROOM)}</b> in game.</p>${joinBlock()}</div>`;
    else if (p.stage === 'queue') h = `<div class="pp-state"><span class="pp-big">${nth(place(p))}</span><h3>You're ${nth(place(p))} in line</h3><p>${p.room ? `Please stay in <b>${esc(p.room)}</b>. Someone will be with you soon.` : `Wait in <b>${esc(D.WAITING_ROOM)}</b>. We'll tell you when someone is ready.`}</p><p class="muted small">Waiting ${ago(p.queuedAt)}</p></div>`;
    else if (p.stage === 'care' && p.phase === 'assigned') h = `<div class="pp-state"><span class="pp-big">1st</span><h3>You're next</h3><p>A nurse is getting ready for you. Stay in <b>${esc(D.WAITING_ROOM)}</b>.</p></div>`;
    else if (p.stage === 'care' && p.phase === 'transferred') h = `<div class="pp-state"><span class="pp-ic">+</span><h3>Transferring to surgery</h3><p>${esc(title(p.nurse))} is taking you to <b>Pre-Op</b> (2nd floor).</p></div>`;
    else if (p.stage === 'closed' && ['ended', 'lbbs', 'left', 'died'].includes(p.outcome)) h = `<div class="pp-state"><h3>${p.outcome === 'ended' ? 'We’re closing for now, sorry' : 'Your visit ended'}</h3><p>${p.outcome === 'ended' ? 'The session has finished. Please come back next time.' : 'If you still need help, check in again.'}</p></div>`;
    else if (p.stage === 'care' && p.phase === 'called') h = `<div class="pp-state go"><span class="pp-ic">→</span><h3>${esc(title(p.nurse))} is ready</h3><p class="pp-do">Go to <b>${esc(p.room || 'the front desk')}</b> now.</p></div>`;
    else if (p.stage === 'care') h = `<div class="pp-state"><span class="pp-ic">+</span><h3>Being treated</h3><p>${esc(title(p.nurse))} is looking after you in <b>${esc(p.room || '')}</b>.</p></div>`;
    else h = `<div class="pp-state"><h3>${p.discharged ? 'You\u2019ve been discharged' : 'Thanks for visiting'}</h3>${p.discharged ? '<p>Here are your discharge papers. Thanks for visiting CareBeyond Hospital.</p>' : ''}${papers(p, p.outcome, S.checkout[p.id] && S.checkout[p.id].follow)}
      ${p.rating ? `<div class="f"><span>${p.ratedBy === 'desk' ? 'Your rating, given at the front desk' : 'Your rating. Thank you!'}</span>${ratingRO(p)}</div>` : `<div class="f"><span>How was your visit?</span><div class="stars">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-prate="${n}" aria-label="${n} of 5">★</button>`).join('')}</div></div>`}</div>`;
    return `<aside class="pphone" aria-label="Patient's phone (demo)"><div class="pp-top"><div><b>Patient's phone</b><span>What a patient who checked in online sees, live</span></div><button type="button" class="x dark" data-a="phonex" aria-label="Close">×</button></div>
      <div class="pp-screen">${p ? `<div class="pp-visit"><b>Your visit</b><span class="pp-url">cbh/visit/${esc(p.vkey)}</span><small>Bookmark this page to follow your visit. It's private: only people with this link can see it.</small></div>` : ''}${h}</div>${p ? '<button type="button" class="link pp-reset" data-a="pdreset">Start again as a new patient</button>' : ''}</aside>`;
  }

  // ---------- PHONE (staff): one thing per screen ----------
  const top = () => S.ph[S.ph.length - 1];
  const go = (s, extra = {}) => { S.ph.push({ s, ...extra }); };
  const back = () => { if (S.ph.length > 1) S.ph.pop(); };
  const phHead = (t, sub) => `<div class="ph-head">${S.ph.length > 1 ? '<button type="button" class="ph-back" data-pb aria-label="Back">‹</button>' : ''}<div><h2>${t}</h2>${sub ? `<p>${sub}</p>` : ''}</div></div>`;
  function phone() {
    const gp = gate(); if (gp) return `<div class="phone-ui">${gp}</div>`;
    const t = top(), p = t.id && byId(t.id); let h = '';
    const plist = (list, attrs, extra) => `<ul class="ph-list">${list.map((x) => `<li style="--u:${x.urgency ? U(x.urgency).colour : '#9aa9c4'}"><button type="button" class="ph-row" ${attrs(x)}><span class="ubar"></span><span><b>${esc(x.name)}</b><small>${extra(x)}</small></span></button></li>`).join('')}</ul>`;
    if (t.s === 'myroom') h = myRoomSection();
    if (t.s === 'reqs') h = reqSection();
    if (t.s === 'road') h = roadSection();
    if (t.s === 'board') h = `${phHead('Ward Board', `${inCare().length} being seen · ${upNext().length} waiting`)}${incomingStrip()}${upNext().length ? `<div class="q-strip"><span>Up next</span>${upNext().map((x) => `<span class="q-chip ro" style="--u:${U(x.urgency).colour}">${x.room ? bell : ''}${esc(x.name)}</span>`).join('')}</div>` : ''}
      ${S.role === 'room' ? `<h4 class="ph-sub">Mine</h4>${mine().length ? plist(mine(), (x) => `data-popen="${x.id}"`, (x) => `${esc(x.room || '')} · ${esc(status(x))}`) : '<p class="muted">No patients.</p>'}` : ''}
      <h4 class="ph-sub">${S.role === 'room' ? 'Everyone else' : 'Being seen'}</h4>${plist(inCare().filter((x) => S.role !== 'room' || x.nurse !== 'me'), (x) => `data-popen="${x.id}"`, (x) => `${esc(x.room || x.where || '')} · ${esc(first(x.nurse))} · ${esc(status(x))}`)}`;
    if (t.s === 'desk') h = `${phHead('Front Desk', `They wait in ${esc(D.WAITING_ROOM)}`)}${incomingStrip()}${callOuts().map((x) => `<div class="callout" style="--u:${U(x.urgency).colour}"><span class="co-say">Call them in · say in game</span><b>“${esc(say(x))}”</b><button type="button" class="btn" data-called="${x.id}">Called</button></div>`).join('')}
        <div class="ph-tiles"><button type="button" class="cx-tile" data-pgo="pcheckin"><b>Check in ${toConfirm().length ? `<i>${toConfirm().length}</i>` : ''}</b><span>Walk-ins and online check-ins</span></button>
        <button type="button" class="cx-tile" data-pgo="pqueue"><b>Up next</b><span>${upNext().length} waiting</span></button>
        <button type="button" class="cx-tile" data-pgo="pcheckout"><b>Came back</b><span>Discharged patients at the desk</span></button>
        </div>`;
    if (t.s === 'pcheckin') h = `${phHead('Check in')}<button type="button" class="btn big" data-pgo="new1">+ Walk-in patient</button>${toConfirm().length ? `<h4 class="ph-sub">Checked in online</h4>${plist(toConfirm(), (x) => `data-pgo="pconf" data-pid="${x.id}"`, (x) => `said “${esc(x.said)}” · ${ago(x.arrived)}`)}` : `<p class="muted">${S.online ? 'Nobody to confirm.' : 'Online check-in is closed: walk-ins only.'}</p>`}`;
    if (t.s === 'pconf' && p) h = `${phHead('Their colour', esc(p.name) + ' said “' + esc(p.said) + '”')}${urgPicker(null, `data-cconf="${p.id}" data-c`)}`;
    if (t.s === 'pqueue') h = `${phHead('Up next', 'Given out in this order')}${plist(upNext(), (x) => `data-pgo="pq" data-pid="${x.id}"`, (x) => `${x.room ? bell + 'Waiting in ' + esc(x.room) : ago(x.queuedAt)}${tooLong(x) ? ' · re-check' : ''}${x.bumped ? ' · bumped' : ''}${x.lost ? ' · lost nurse' : ''}`)}`;
    if (t.s === 'pq' && p && p.stage === 'queue') h = `${phHead(esc(p.name), `${nth(place(p))} in line · waited ${ago(p.queuedAt)}`)}${handbackFlag(p)}<div class="ph-tiles"><button type="button" class="cx-tile" data-bump="${p.id}"><b>${p.bumped ? 'Unbump' : 'Bump to the top'}</b><span>For someone who can't wait</span></button>
      <button type="button" class="cx-tile" data-pgo="prc" data-pid="${p.id}"><b>Re-check colour</b><span>Now ${esc(U(p.urgency).name)}</span></button><button type="button" class="cx-tile ghost" data-lbbs="${p.id}"><b>Left</b><span>Left before being seen</span></button><button type="button" class="cx-tile" data-edit="${p.id}"><b>Edit</b><span>Teams and colour</span></button></div>${S.editFor === p.id ? editBox(p) : ''}`;
    if (t.s === 'prc' && p) h = `${phHead('Re-check', 'Ask how they are now')}${urgPicker(p.urgency, `data-rc="${p.id}" data-c`)}`;
    if (t.s === 'pcheckout') h = `${phHead('Came back', 'Only if they come back to the desk')}${checkouts().length ? plist(checkouts(), (x) => `data-pgo="pco" data-pid="${x.id}"`, (x) => `${esc(x.diagnosis || '')} · from ${esc(first(x.nurse))}`) : '<p class="muted">Nobody is ready to leave.</p>'}`;
    if (t.s === 'pco' && p && checkouts().includes(p)) { const c = S.checkout[p.id] || (S.checkout[p.id] = { follow: '', rating: 0 });
      h = `${phHead('Check out', esc(p.name))}${papers(p, p.outcome, c.follow)}<div class="f"><span>Follow-up <em>(optional)</em></span>${c.follow ? `<span class="res-v">${esc(c.follow)} <button type="button" class="link" data-furm="${p.id}">Change</button></span>` : fbox('fu' + p.id, 'follow', '', 'e.g. come back if it gets worse', 'Save')}</div>
        ${ratingField(p, c)}<button type="button" class="btn big" data-out-done="${p.id}">Done</button>`; }
    const d = S.draft;
    if (t.s === 'new1') h = `${phHead('Walk-in', 'Step 1 of 3')}<label class="f"><span>Name</span><input id="d-name" value="${esc(d.name)}" placeholder="e.g. Anna S."></label><label class="f"><span>Roblox username (optional)</span><input id="d-roblox" value="${esc(d.roblox)}"></label><label class="f"><span>Age</span><input id="d-age" type="number" inputmode="numeric" value="${esc(d.age)}" placeholder="under 18 goes to a Children only room"></label><div class="grow"></div><button type="button" class="btn big" data-pgo="new2"${d.name.trim() ? '' : ' disabled'} data-needname>Next</button>`;
    if (t.s === 'new2') h = `${phHead('What\u2019s wrong?', 'Step 2 of 3 · type each thing')}${tagList(d.symptoms, 'data-dsymrm')}${fbox('sym', 'sym', '', 'e.g. headache', 'Add')}<div class="grow"></div><button type="button" class="btn big" data-pgo="new3">Next</button>`;
    if (t.s === 'new3') h = `${phHead('Their colour', 'Step 3 of 3')}${urgPicker(d.urgency, 'data-durg')}<button type="button" class="btn big" data-a="padd"${d.urgency ? '' : ' disabled'}>Check in to Up next</button>`;
    if (t.s === 'rooms') h = `${phHead('Rooms', `Main ward · ${Object.keys(roomsInUse()).length} of ${D.BEDS.length} beds in use`)}${D.ROOMS.map((r) => `<h4 class="ph-sub">${r.id} · ${S.roomCfg[r.id].kids ? 'Paediatric' : esc(S.roomDept[r.id] || '')}${S.roomCfg[r.id].closed ? ' · closed' : ''}</h4><div class="ph-beds">${D.BEDS.filter((b) => roomIdOf(b) === r.id).map((b) => bedCell(b, r.beds > 1 ? `${r.id} · Bed ${b.slice(-1)}` : r.id)).join('')}</div>`).join('')}`;
    if (t.s === 'patient' && p && p.stage === 'care') { const l = latest(p), un = p.orders.filter((o) => !o.done).length, mineP = p.nurse === 'me';
      h = `${phHead(esc(p.name) + (p.age ? `<small>, ${p.age}</small>` : ''), `${upill(p.urgency)} ${esc(p.room || p.where || '')} · ${esc(status(p))}`)}
${nextBarHtml(p)}
        ${canReq(p) ? `<button type="button" class="btn ghost r-req2" data-pgo="p-req" data-pid="${p.id}">Request</button>` : ''}${reqBlock(p)}${symBlock(p)}<div class="ph-tiles">
        <button type="button" class="cx-tile" data-pgo="p-urg" data-pid="${p.id}" style="--u:${U(p.urgency).colour}"><b>Triage colour ${p.colourConfirmed ? '' : '<i>Confirm</i>'}</b><span><span class="udot"></span>${U(p.urgency).name} · ${U(p.urgency).label}</span></button>
        <button type="button" class="cx-tile" data-pgo="p-num" data-pid="${p.id}"><b>Vitals</b><span>${p.vitals.length ? `HR ${l.hr ?? '–'} · BP ${l.sys ?? '–'}/${l.dia ?? '–'} · ${l.temp ?? '–'}°F` : 'None yet'}</span></button>
        <button type="button" class="cx-tile" data-pgo="p-did" data-pid="${p.id}"><b>Care given</b><span>${p.did.length ? p.did.length + ' recorded' : 'Nothing recorded yet'}</span></button>
        <button type="button" class="cx-tile" data-pgo="p-ord" data-pid="${p.id}"><b>Orders & results</b><span>${p.orders.length ? `${p.orders.length} asked${un ? ` · ${un} to do` : ''}` : 'None'}${p.diagnosis ? ' · ' + esc(p.diagnosis) : ''}</span></button>
        ${S.role === 'super' ? `<button type="button" class="cx-tile navy" data-pgo="p-leave" data-pid="${p.id}"><b>Discharge</b><span>Or close the case: left or died</span></button>` : ''}
        ${mineP ? `<button type="button" class="cx-tile ghost" data-hb="${p.id}"><b>Hand over</b><span>Back to the queue; they stay in their bed</span></button>` : ''}</div>${S.handbackFor === p.id ? handbackBox(p) : ''}`; }
    if (t.s === 'p-urg' && p) h = `${phHead('Triage colour', p.colourConfirmed ? 'Confirmed' : 'Set at check-in: confirm or change')}${urgPicker(p.urgency, 'data-purg')}${p.colourConfirmed ? '' : `<button type="button" class="btn big" data-a="pconfirm">Confirm ${esc(U(p.urgency).name)}</button>`}`;
    if (t.s === 'p-num' && p) h = `${phHead('Vitals', 'Copy them from the monitor')}${vitalForm()}`;
    if (t.s === 'p-did' && p) h = `${phHead('Care given', 'Type it, then Add')}${fbox('did', 'did', '', 'e.g. bandaged left arm', 'Add')}${didList(p)}`;
    if (t.s === 'p-ord' && p) h = `${phHead('Orders & results', esc(p.name))}${p.orders.length ? `<ul class="olist">${p.orders.map((o, i) => `<li class="${o.done ? 'done' : ''}"><div><b>${esc(o.what)}</b><small>${o.done ? (o.result ? 'Result: ' + esc(o.result) : 'Done') : (o.who === 'Anyone' ? 'Anyone can do it' : o.who === 'Radiology' ? 'For Radiology' : 'For a ' + esc(o.who.toLowerCase()))}</small></div>${o.done ? '' : `<button type="button" class="btn small" data-odone="${i}">Done</button>`}</li>`).join('')}</ul>` : '<p class="muted">Nothing asked for yet.</p>'}
      ${p.orders.some((o) => o.done) ? `<h4 class="ph-sub">Results</h4>${resultsBlock(p)}` : ''}
      <button type="button" class="btn ghost" data-pgo="p-ask" data-pid="${p.id}">New order</button><button type="button" class="btn ghost" data-pgo="p-dx" data-pid="${p.id}">Diagnosis${p.diagnosis ? ': ' + esc(p.diagnosis) : ''}</button>`;
    if (t.s === 'p-ask' && p) h = `${phHead('New order', 'Type what you need')}${whoPick()}${fbox('ord', 'order', '', 'e.g. blood sample', 'Ask')}`;
    if (t.s === 'p-dx' && p) h = `${phHead('Diagnosis', 'In your own words')}${dxBlock(p)}<button type="button" class="btn big ghost" data-pb>Done</button>`;
    if (t.s === 'p-req' && p) h = `${phHead('Request', esc(p.name))}${reqMenu(p)}`;
    if (t.s === 'p-leave' && p) h = `${phHead('Discharge', esc(p.name))}${nextBarHtml(p)}${leaveBody(p)}`;
    const NAV = { reception: [['desk', 'Front Desk', deskCount()]], room: [['myroom', 'My Room', mine().filter((x) => x.phase === 'assigned').length], ['board', 'Ward Board', 0]],
      oncall: [['reqs', 'Requests', openReqCount()], ['board', 'Ward Board', 0]], road: [['road', 'Incoming', 0], ['board', 'Ward Board', 0]],
      super: [['board', 'Board', 0], ['desk', 'Front Desk', deskCount()], ['reqs', 'Requests', openReqCount()], ['rooms', 'Rooms', 0]] };
    const nav = NAV[S.role];
    return `${codeBar()}<div class="phone-ui"><div class="ph-screen">${S.role === 'room' && t.s === 'myroom' ? mine().filter((x) => x.phase === 'assigned').map((x) => `<div class="gotit sticky" style="--u:${U(x.urgency).colour}"><span class="lab">${x.inRoom ? 'Waiting in your room' : 'New patient'}</span><b>${esc(x.name)}${x.age ? ', ' + x.age : ''}</b>${upill(x.urgency)}<span>${esc(x.room)} · ${esc(x.symptoms.join(', ') || 'no symptoms given')}</span><button type="button" class="btn big" data-gotit="${x.id}">Accept patient <small class="gi-t">${countdown(x.assignedAt, 60)}</small></button></div>`).join('') : ''}${S.ph.length === 1 && !(S.role === 'room' && mine().some((x) => x.phase === 'assigned')) ? `<div class="ph-role">${roleCard('small')}<button type="button" class="link" data-a="changerole">Change role</button></div>` : ''}${h || phHead('Not here any more', 'That patient has moved on.')}</div><nav class="ph-nav" style="grid-template-columns:repeat(${nav.length}, 1fr)">${nav.map(([k, l, n]) => `<button type="button" class="${S.ph[0].s === k ? 'on' : ''}" data-proot="${k}">${l}${n ? ` <i>${n}</i>` : ''}</button>`).join('')}</nav></div>`;
  }

  // ---------- render (keeps every scroll area and the focus) ----------
  const app = document.createElement('div'); app.className = 'chx'; app.id = 'chx';
  const AREAS = ['.pane-sec', '.pp-screen'];
  const areaKey = (sel) => (sel === '.pane-work' ? `${S.open}|${S.tab}` : sel === '.pane-sec' ? S.sec + S.deskTab : sel === '.pp-screen' ? 'pp' : sel === 'page' ? (isPhone() ? JSON.stringify(top()) : 'c') : 'same');
  const sig = (el) => { if (!el || el === document.body) return null; if (el.id) return '#' + CSS.escape(el.id);
    const a = [...el.attributes].filter((x) => x.name.startsWith('data-') && x.name !== 'data-since').map((x) => `[${x.name}="${CSS.escape(x.value)}"]`).join('');
    return a ? el.tagName.toLowerCase() + a : null; };
  function render() {
    drawnWithData = !!SNAP;
    const se = document.scrollingElement;
    const K0 = render.keys || {}, before = { page: [se.scrollTop, K0.page], ...Object.fromEntries(AREAS.map((sel) => { const e = $(sel); return [sel, e ? [e.scrollTop, K0[sel]] : null]; })) };
    const focusSig = sig(document.activeElement), keep = document.activeElement && document.activeElement.id;
    // The page redraws into #view; the record drawer lives in #dhost and STAYS mounted (owner, 19 Nov 2026: no flash on
    // every click). It slides in only when a different patient opens; otherwise only its content is swapped, and only
    // when something in it actually changed (ticking timers don't count), keeping its scroll and focus.
    if (!$('#chx-view')) app.innerHTML = '<div id="chx-view"></div><div id="chx-dhost"></div><div class="cx-toast" id="chx-toast" role="status" hidden></div>';
    $('#chx-view').innerHTML = (isPhone() ? phone() : computer());
    // Supervisors on the floor plan: the record docks beside the plan and shrinks it, so the beds stay in view (audit #6).
    const dock = !isPhone() && S.role === 'super' && S.sec === 'plan' && !!S.open;
    $('#chx-view').classList.toggle('docked-view', dock); $('#chx-dhost').classList.toggle('docked', dock); document.body.classList.toggle('phone', isPhone());
    drawer();
    app.classList.toggle('is-phone', isPhone());
    alertWatch();
    AREAS.forEach((sel) => { const e = $(sel), b = before[sel]; if (e && b && b[1] === areaKey(sel)) e.scrollTop = b[0]; });
    se.scrollTop = before.page[1] === areaKey('page') ? before.page[0] : 0;
    render.keys = { page: areaKey('page'), ...Object.fromEntries(AREAS.map((sel) => [sel, areaKey(sel)])) };
    if (!isPhone()) { sizeBoard(); placePop(); }
    try { const el = keep ? document.getElementById(keep) : focusSig && app.querySelector(focusSig); if (el) { el.focus({ preventScroll: true }); if (keep && el.setSelectionRange && el.type === 'text') el.setSelectionRange(el.value.length, el.value.length); } } catch { /* fine */ }
  }
  function placePop() { placeRoomPop(); const pop = $('.popover'), plan = $('.plan'); if (!pop || !plan) return;
    const a = $(`.staff-drop[data-sid="${CSS.escape(pop.dataset.anchor)}"]`); if (!a) return;
    const r = a.getBoundingClientRect(), pr = plan.getBoundingClientRect(), w = pop.offsetWidth;
    pop.style.left = Math.max(8, r.left - pr.left - w - 10) + 'px'; pop.style.top = Math.max(8, Math.min(r.top - pr.top, plan.clientHeight - pop.offsetHeight - 8)) + 'px'; }
  function placeRoomPop() { const pop = $('.room-pop'), plan = $('.plan'); if (!pop || !plan) return; const a = $(`.fp-room[data-room="${CSS.escape(pop.dataset.room)}"]`); if (!a) return;
    const r = a.getBoundingClientRect(), pr = plan.getBoundingClientRect(), w = pop.offsetWidth, right = r.right - pr.left + 10;
    pop.style.left = (right + w < plan.clientWidth ? right : Math.max(8, r.left - pr.left - w - 10)) + 'px'; pop.style.top = Math.max(8, Math.min(r.top - pr.top, plan.clientHeight - pop.offsetHeight - 8)) + 'px'; }
  function drawer() {
    const dh = $('#chx-dhost'), p = !isPhone() && S.role && S.open && byId(S.open);
    if (!p) { if (dh.dataset.pid) { dh.innerHTML = ''; dh.dataset.pid = ''; dh._sig = ''; } return; }
    const html = recordPane(p), sig = html.replace(/<span class="cd"[^>]*>[^<]*<\/span>/g, '');
    if (dh.dataset.pid !== String(p.id)) {
      dh.innerHTML = `<button type="button" class="drawer-bg" data-a="closerec" aria-label="Close the record" tabindex="-1"></button><aside class="drawer" role="dialog" aria-label="Patient record">${html}</aside>`;
      dh.dataset.pid = p.id; dh.dataset.tab = S.tab; dh._sig = sig; return; }
    if (dh._sig === sig) return;
    const d = dh.querySelector('.drawer'), top = d.scrollTop; d.innerHTML = html; dh._sig = sig;
    if (dh.dataset.tab !== S.tab) { d.scrollTop = 0; dh.dataset.tab = S.tab; } else d.scrollTop = top;
  }
  function sizeBoard() { const b = $('#board'); if (!b) return; const w = b.clientWidth; b.dataset.size = w >= 860 ? 'xl' : w >= 680 ? 'l' : w >= 520 ? 'm' : w >= 380 ? 's' : 'xs'; }
  function wireDivider() {
    const dv = $('#divider'), split = $('#split'); if (!dv) return;
    const clamp = (px) => Math.max(360, Math.min(split.clientWidth - 200, px));
    const set = (px) => { S.right = clamp(px); split.style.setProperty('--right', S.right + 'px'); dv.setAttribute('aria-valuenow', S.right); sizeBoard(); };
    dv.onpointerdown = (e) => { e.preventDefault(); dv.setPointerCapture(e.pointerId); document.body.classList.add('dragging'); const r = split.getBoundingClientRect();
      dv.onpointermove = (ev) => set(r.right - ev.clientX); dv.onpointerup = () => { dv.onpointermove = null; document.body.classList.remove('dragging'); save('right', S.right); }; };
    dv.onkeydown = (e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); set((S.right || split.clientWidth / 2) + (e.key === 'ArrowLeft' ? 40 : -40)); save('right', S.right); } };
    dv.ondblclick = () => { set(split.clientWidth / 2); save('right', S.right); };
    if (S.right) set(S.right);
  }

  // ---------- events ----------
  app.addEventListener('input', (e) => {
    const t = e.target;
    if (t.id === 'd-name') { S.draft.name = t.value; const b = app.querySelector('[data-a="add"], [data-needname]'); if (b) b.disabled = !(t.value.trim() && (b.dataset.needname !== undefined || S.draft.urgency)); }
    else if (t.id === 'd-roblox') S.draft.roblox = t.value;
    else if (t.id === 'd-age') S.draft.age = t.value;
    else if (t.id === 'd-care') S.draft.care = t.value;
    else if (t.id === 'npc-name') S.npc.name = t.value;
    else if (/^i-(name|age|what|hr|bp)$/.test(t.id)) { const k = t.id.slice(2); S.inc[k] = t.value; if (k === 'name') { const b = app.querySelector('[data-a="incgo"]'); if (b) b.disabled = !(t.value.trim() && S.inc.urgency); } }
    else if (t.id === 'pd-name') { S.pdraft.name = t.value; const b = app.querySelector('[data-a="pdgo"]'); if (b) b.disabled = !(t.value.trim() && S.pdraft.said); }
    else if (t.id === 'p-notes') { const p = byId(S.open); if (p) p.notes = t.value; }
    else if (/^lv-(follow|admit|left)$/.test(t.id)) { S.lv[t.id.slice(3)] = t.value; render(); }
    else if (/^dth-(time|note)$/.test(t.id)) { S.dth[t.id.slice(4)] = t.value; const b = $('[data-a="deathgo"]'); if (b) b.disabled = !(S.dth.note || '').trim(); }
    else if (/^rqf-\d+$/.test(t.id)) S.rqf[t.id.slice(4)] = t.value;
    else if (t.dataset.vol !== undefined) { A.vol = +t.value; saveA(); clearTimeout(t._v); t._v = setTimeout(() => { arm(); const was = A.on; A.on = true; tone('patient'); A.on = was; }, 150); }
    else if (t.dataset.fb) { (S.fb || (S.fb = {}))[t.dataset.fb] = t.value; const sg = $('#sg-' + CSS.escape(t.dataset.fb)); if (sg) sg.innerHTML = suggChips(t.dataset.fb, t.dataset.fbkind, t.dataset.fbkey, t.value); }
    else if (t.dataset.v && t.closest('.vin')) { S.vdraft[t.dataset.v] = t.value; const v = D.VITALS.find((x) => x.key === t.dataset.v), lab = t.closest('.vin'); lab.className = 'vin ' + vstate(v, t.value); lab.querySelector('small').textContent = vrange(v, t.value, `${v.lo}–${v.hi}`); }
  });
  app.addEventListener('change', (e) => {
    if (e.target.id === 'p-notes') { const p = byId(S.open), v = e.target.value.trim(), last = ((RECS[S.open] || {}).p || {}).notes || ''; if (p && v && v !== last) chartIt(p, 'note', { text: v }, 'Note saved.'); return; }
    if (e.target.id === 'dth-by') { S.dth.by = e.target.value; return; }
    if (e.target.id !== 'p-room') return;
    const bed = e.target.value.replace(' (children only)', '');
    if (S.role === 'super') S.sec = 'plan'; planMove(S.open, bed); render();
  });
  // save what was typed into a box (Enter or the button, or a tapped suggestion)
  function fbSave(id, kind, val) {
    const v = String(val || '').trim(); if (!v) return false;
    kind = kind || ({ did: 'did', ord: 'order', dx: 'dx', sym: 'sym', psym: 'sym', adv: 'advice' }[id] || (id.startsWith('res') ? 'result' : id.startsWith('fu') ? 'follow' : ''));
    if (id === 'sym') { if (!S.draft.symptoms.includes(v)) S.draft.symptoms.push(v); return true; }
    if (id === 'npcsym') { if (S.npc && !S.npc.symptoms.includes(v)) S.npc.symptoms.push(v); return true; }
    if (id === 'rsym') { const p = byId(S.symEdit); if (!p) return false; const next = [...new Set([...(p.symptoms || []), v])];
      p.symptoms = next; p.symKnown = true; call('chart_case_update', { p_case: p.id, p_changes: { symptoms: next } }, `Added: ${esc(v)}.`); return true; }
    if (id === 'psym') { if (!S.pdraft.symptoms.includes(v)) S.pdraft.symptoms.push(v); return true; }
    if (kind === 'follow') { const pid = +id.slice(2); S.checkout[pid].follow = v; byId(pid).follow = v; return true; }
    if (/^rq\d+$/.test(id)) { req.done(reqById(id.slice(2)), v); return true; }
    const p = isPhone() ? byId(top().id) : byId(S.open); if (!p) return false;
    if (kind === 'advice') { p.advice = v; return true; }   // goes out with the discharge
    if (kind === 'did') chartIt(p, 'intervention', { text: v });
    if (kind === 'order') chartIt(p, 'order', { text: v, who: S.orderWho || 'Anyone' }, `Ordered: ${esc(v)}.`);
    if (kind === 'result') { const o = p.orders[+id.slice(3)]; if (o && o.id) touch(p).then(() => call('chart_order_done', { p_entry: o.id, p_result: v }, 'Result saved.')); }
    if (kind === 'dx') { chartIt(p, 'diagnosis', { text: v }, 'Diagnosis saved.'); S.dxEdit = false; }
    return true;
  }
  app.addEventListener('keydown', (e) => { const t = e.target; if (e.key === 'Enter' && t.dataset && t.dataset.fb) { e.preventDefault(); const b = app.querySelector(`[data-fbadd="${CSS.escape(t.dataset.fb)}"]`); if (b) b.click(); } });
  // ---- Supervisor drag and drop (mouse, pen and touch: pointer events). A patient onto a bed or a person; a person onto a room. ----
  let drag = null, justDragged = false;
  app.addEventListener('pointerdown', (e) => {
    if (S.role !== 'super' || e.button > 0 || isPhone()) return;
    const src = e.target.closest('[data-drag], [data-dragsid]'); if (!src) return;
    drag = { pid: src.dataset.drag ? +src.dataset.drag : null, sid: src.dataset.drag ? null : src.dataset.dragsid, x: e.clientX, y: e.clientY, src, ghost: null, over: null, marked: false };
  });
  window.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (!drag.ghost) { if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return;
      const p = drag.pid && byId(drag.pid); drag.ghost = document.createElement('div'); drag.ghost.className = 'drag-ghost'; drag.ghost.style.setProperty('--u', p ? U(p.urgency).colour : deptColour(staffDept(drag.sid)));
      drag.ghost.textContent = p ? p.name : nm(drag.sid); document.body.append(drag.ghost); document.body.classList.add('dragging-p'); drag.src.classList.add('drag-src'); }
    e.preventDefault();
    drag.ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 12}px)`;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const tg = el && (drag.pid ? (el.closest('.bed[data-bed]') || el.closest('.staff-drop[data-sid]')) : el.closest('.fp-room[data-room]'));
    if (drag.pid && !drag.marked) { drag.marked = true; const dp = byId(drag.pid); app.querySelectorAll('.bed[data-bed]').forEach((x) => { const why = dp.room === x.dataset.bed ? '' : dropWhy(dp, x.dataset.bed); if (why) { x.classList.add('no-drop'); x.dataset.why = why; } }); }
    if (drag.over && drag.over !== tg) drag.over.classList.remove('drop-over');
    if (tg && !tg.classList.contains('no-drop') && (!drag.pid || tg.dataset.sid || byId(drag.pid).room !== tg.dataset.bed)) { tg.classList.add('drop-over'); drag.over = tg; } else drag.over = null;
  }, { passive: false });
  window.addEventListener('pointerup', () => {
    if (!drag) return;
    const d = drag; drag = null;
    if (!d.ghost) return;   // a plain click
    d.ghost.remove(); document.body.classList.remove('dragging-p'); d.src.classList.remove('drag-src');
    app.querySelectorAll('.no-drop').forEach((x) => { x.classList.remove('no-drop'); delete x.dataset.why; });
    justDragged = true; setTimeout(() => { justDragged = false; }, 0);
    if (!d.over) return;
    d.over.classList.remove('drop-over');
    if (d.sid) giveRoom(d.sid, d.over.dataset.room);
    else if (d.over.dataset.sid) dropOnPerson(d.pid, d.over.dataset.sid);
    else dropOnBed(d.pid, d.over.dataset.bed);
    render();
  });
  const hl = (sid, on) => app.querySelectorAll('.fp-room[data-people]').forEach((r) => { if (r.dataset.people.split(' ').includes(sid)) r.classList.toggle('hl', on || S.face === sid); });
  app.addEventListener('mouseover', (e) => { const x = e.target.closest('.plan-s .staff-drop'); if (x && !drag) hl(x.dataset.sid, true); });
  app.addEventListener('mouseout', (e) => { const x = e.target.closest('.plan-s .staff-drop'); if (x && !x.contains(e.relatedTarget)) hl(x.dataset.sid, false); });
  app.addEventListener('focusin', (e) => { const x = e.target.closest('.plan-s .staff-drop'); if (x) hl(x.dataset.sid, true); });
  app.addEventListener('focusout', (e) => { const x = e.target.closest('.plan-s .staff-drop'); if (x) hl(x.dataset.sid, false); });
  document.addEventListener('keydown', (e) => { if (e.key !== 'Escape' || !app.isConnected) return;
    if (S.sessMenu || S.face || S.railOpen) { S.sessMenu = false; S.face = null; S.roleAsk = null; S.railOpen = false; }
    else if (S.teamWarn || S.who || S.pendRoom || S.roomPanel || S.endSess || S.moveFor || S.pending) Object.assign(S, { teamWarn: null, who: null, pendRoom: null, roomPanel: null, endSess: false, moveFor: null, pending: null });
    else if (S.open && !isPhone()) { S.open = null; S.reqMenu = false; S.handbackFor = null; } else return;
    render(); });
  app.addEventListener('keydown', (e) => { if ((e.key === 'm' || e.key === 'M') && e.target.matches('.bed[data-drag]')) { e.preventDefault(); S.moveFor = +e.target.dataset.drag; render(); } });
  app.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.bed[data-open]')) { e.preventDefault(); e.target.click(); } });
  app.addEventListener('click', (e) => {
    if (justDragged) { e.preventDefault(); return; }
    let closed = false;
    if (S.sessMenu && !e.target.closest('.sess-m')) { S.sessMenu = false; closed = true; }
    if (S.face && !e.target.closest('.popover, .staff-drop')) { S.face = null; S.roleAsk = null; closed = true; }
    if (S.roomPanel && !e.target.closest('.room-pop, .rh-edit')) { S.roomPanel = null; closed = true; }
    if (S.railOpen && !e.target.closest('.rail')) { S.railOpen = false; S.alertSet = false; closed = true; }
    const b = e.target.closest('button, tr[data-open], li[data-open], div[data-open]'); if (!b || b.disabled) { if (closed) render(); return; }
    S.lastAct = Date.now();
    const ds = b.dataset, cur = () => (isPhone() ? byId(top().id) : byId(S.open));
    const home = () => { S.ph = [{ s: S.role === 'super' ? 'board' : SECTIONS[S.role][0][0] }]; };
    const openP = (id) => { S.urgOpen = false; if (isPhone()) go('patient', { id }); else { S.open = id; S.tab = 'chart'; S.vopen = false; S.outcome = null; S.reqMenu = false; S.rq = null; } };
    const sure = (v, msg) => { if (String(v || '').trim()) return true; toast(msg); return false; };
    // roles and Ready
    if (ds.role) pickRole(ds.role, ds.rdept);
    else if (ds.a === 'changerole') { if (mine().length) { S.endShift = 'role'; if (S.role === 'room') { S.sec = 'myroom'; S.ph = [{ s: 'myroom' }]; } toast('Hand over or finish your patients before changing role.'); }
      else { Object.assign(S, { open: null, pick: false }); leaveRole(); } }
    else if (ds.a === 'rail') S.railOpen = !S.railOpen;
    else if (ds.a === 'sndtoggle') { A.on = !A.on; saveA(); arm(); if (A.on) tone('patient'); toast(A.on ? 'Alert sounds on.' : 'Alert sounds muted.'); }
    else if (ds.a === 'alertset') { S.alertSet = !S.alertSet; if (S.alertSet) S.railOpen = true; }
    else if (ds.a === 'sndtest') { arm(); const was = A.on; A.on = true; tone('patient'); A.on = was; }
    else if (ds.a === 'sndtestcode') { arm(); const was = A.on; A.on = true; tone('code'); A.on = was; }
    else if (ds.a === 'desktoggle') { if (A.desk) { A.desk = false; saveA(); } else { askDesk(); return; } }
    else if (ds.a === 'deskyes') { askDesk(); return; }
    else if (ds.a === 'deskno') { A.asked = true; saveA(); }
    else if (ds.a === 'sessmenu') S.sessMenu = !S.sessMenu;
    else if (ds.a === 'pplx') S.peopleOpen = !pplOpen();
    else if (ds.discharge) { const id = +ds.discharge; Object.assign(S, { outcome: null, lv: {}, forceAsk: false }); if (isPhone()) go('p-leave', { id }); else { if (S.open !== id) openP(id); S.tab = 'leave'; } }
    else if (ds.rqfinish) { const r = reqById(ds.rqfinish), v = ((S.rqf || {})[r.id] || '').trim();
      if (!v && !ds.force) S.finishAsk = r.id; else { req.done(r, v); S.finishAsk = null; delete S.rqf[r.id]; } }
    else if (ds.a === 'finishno') { S.finishAsk = null; setTimeout(() => { const t = $('.rqf'); if (t) t.focus(); }, 0); }
    else if (ds.skipvit) S.skipVit[+ds.skipvit] = true;
    else if (ds.a === 'focusdid') { if (isPhone()) go('p-did', { id: top().id }); else { S.tab = 'chart'; setTimeout(() => { const i = $('#fb-did'); if (i) { i.scrollIntoView({ block: 'center' }); i.focus(); } }, 0); } }
    else if (ds.a === 'forceask') S.forceAsk = true; else if (ds.a === 'forceno') S.forceAsk = false;
    else if (ds.a === 'leaveforce') { act.leave(cur(), S.outcome, true); if (isPhone()) home(); }
    else if (ds.a === 'deathopen') { S.deathFor = cur().id; S.dth = { time: nowHM(), by: 'me', note: '' }; }
    else if (ds.a === 'deathx') { S.deathFor = null; S.dth = {}; }
    else if (ds.a === 'deathgo') { const p = cur(); if ((S.dth.note || '').trim()) { act.death(p, { time: S.dth.time || nowHM(), by: S.dth.by || 'me', note: S.dth.note }); if (isPhone()) home(); } }
    else if (ds.a === 'mvbedopen') S.mvBed = S.mvBed === S.open || S.mvBed === (top() || {}).id ? null : (isPhone() ? top().id : S.open);
    else if (ds.a === 'mvbedx') S.mvBed = null;
    else if (ds.mvbed) { const id = S.mvBed; S.mvBed = null; planMove(id, ds.mvbed); }
    else if (ds.place) { S.placeFor = S.placeFor === +ds.place ? null : +ds.place; if (S.placeFor) toast('Lit beds can take them: click one.'); }
    else if (ds.placebed) { const id = S.placeFor; S.placeFor = null; dropOnBed(id, ds.placebed); }
    else if (ds.rqchase) req.chase(reqById(ds.rqchase));
    else if (ds.a === 'incnew') S.incDone = false;
    else if (ds.a === 'urgopen') S.urgOpen = true;
    else if (ds.a === 'urgx') S.urgOpen = false;
    else if (ds.a === 'ready') act.ready();
    else if (ds.a === 'notready') act.notReady();
    else if (ds.a === 'stayready') act.stayReady();
    else if (ds.gotit) { const p = byId(+ds.gotit); if (p && p.phase === 'assigned') { act.gotIt(p); openP(p.id); } }
    else if (ds.withpt) { const p = byId(+ds.withpt); if (p) { act.withPatient(p); if (!isPhone()) openP(p.id); } }
    else if (ds.noshow) { act.noShow(byId(+ds.noshow)); if (isPhone()) home(); }
    else if (ds.takeover) call('chart_offer_take', {}, 'You took over the room.');
    else if (ds.a === 'pick') { S.pick = true; S.pickSel = bedsOf('me').slice(); }
    else if (ds.a === 'pickdone') pickDone();
    else if (ds.pickbed) pickBed(ds.pickbed);
    else if (ds.a === 'npc') S.npc = { name: '', symptoms: [] }; else if (ds.a === 'npcx') S.npc = null;
    else if (ds.npcbed) act.npc(S.npc.name, ds.npcbed);
    // requests
    else if (ds.a === 'reqmenu') { S.reqMenu = !S.reqMenu; S.rq = null; }
    else if (ds.rqpick) S.rq = S.rq === ds.rqpick ? null : ds.rqpick;
    else if (ds.rqmode) S.rqMode = ds.rqmode;
    else if (ds.rqgo) { req.ask(byId(+ds.rqgo), S.rq, ($('#rq-note') || {}).value, S.rq === 'surgery' ? S.rqMode : undefined); S.reqMenu = false; S.rq = null; if (isPhone()) back(); }
    else if (ds.rqcode) { req.ask(byId(+ds.rqcode), 'code'); if (isPhone()) back(); }
    else if (ds.codeclear) call('chart_code_clear', { p_case: +ds.codeclear }, 'Code Blue cleared.');
    else if (ds.accept) { const r = reqById(ds.accept); if (r) req.accept(r).then((ok) => { if (ok) { openP(r.pid); render(); } }); }
    else if (ds.here) req.here(reqById(ds.here));
    else if (ds.transfer) req.transfer(reqById(ds.transfer));
    else if (ds.rqdone) req.done(reqById(ds.rqdone));
    else if (ds.rqagain) req.again(reqById(ds.rqagain));
    else if (ds.rqcancel) req.cancel(reqById(ds.rqcancel));
    else if (ds.rqkeep) reqById(ds.rqkeep).kept = true;
    else if (ds.rqwithout) req.cancel(reqById(ds.rqwithout), 'Continued without');
    else if (ds.rqhelp) { const r = reqById(ds.rqhelp); call('chart_request_cancel', { p_id: r.id, p_reason: 'Asked for assistance instead' }).then(() => req.ask(byId(r.pid), 'help', `Instead of a ${REQ[r.type][0].toLowerCase()}${r.note ? ': ' + r.note : ''}`)); }
    else if (ds.sendto) S.sendFor = S.sendFor === +ds.sendto ? null : +ds.sendto;
    else if (ds.sendsid) { const r = reqById(S.sendFor); S.sendFor = null; if (r) req.send(r, ds.sendsid); }
    // supervisor
    else if (ds.roomcfg) { S.roomPanel = S.roomPanel === ds.roomcfg ? null : ds.roomcfg; S.face = null; }
    else if (ds.a === 'roompx') S.roomPanel = null;
    else if (ds.rdset) roomSet(S.roomPanel, { p_department: ds.rdset });
    else if (ds.rrestr !== undefined) roomSet(S.roomPanel, { p_who: ds.rrestr === 'kids' ? 'kids' : ds.rrestr === 'adults' ? 'adults' : 'anyone' });
    else if (ds.bedoff && !(S.roomCfg[S.roomPanel] || { off: {} }).off[ds.bedoff] && roomsInUse()[ds.bedoff]) toast('Someone is in that bed: move them first.');
    else if (ds.bedoff) { const off = !!(S.roomCfg[S.roomPanel] || { off: {} }).off[ds.bedoff]; call('chart_bed_set', { p_bed: bedId(ds.bedoff), p_available: off, p_reason: off ? null : 'Switched off by the supervisor' }, off ? `${esc(ds.bedoff)} is available again.` : `${esc(ds.bedoff)} is switched off.`); }
    else if (ds.a === 'roomclose' && closeWhy(S.roomPanel)) toast(esc(closeWhy(S.roomPanel)));
    else if (ds.a === 'roomclose') { const why = (($('#rc-why') || {}).value || '').trim(); if (why.length < 3) toast('Say why the room is closed (at least 3 letters).'); else roomSet(S.roomPanel, { p_closed: true, p_closed_reason: why }); }
    else if (ds.a === 'roomopen') roomSet(S.roomPanel, { p_closed: false, p_closed_reason: null });
    else if (ds.unown) toast('Ask them to leave the bed, or use They\u2019ve gone.');
    else if (ds.sid) { S.face = S.face === ds.sid ? null : ds.sid; S.roleAsk = null; S.roomPanel = null; }
    else if (ds.a === 'facex') { S.face = null; S.roleAsk = null; }
    else if (ds.setrole) setRole(S.face, ds.setrole);
    else if (ds.a === 'roleyes') setRole(S.face, S.roleAsk, true);
    else if (ds.a === 'roleno') S.roleAsk = null;
    else if (ds.setready) toast('Only they can set themselves Ready.');
    else if (ds.gone) gone(ds.gone);
    else if (ds.whosid) { const { pid, bed } = S.who; S.who = null; giveTo(byId(pid), ds.whosid, bed); }
    else if (ds.a === 'twyes') { const w = S.teamWarn; giveTo(byId(w.pid), w.sid, w.bed, true); }
    else if (ds.a === 'twno') S.teamWarn = null;
    else if (ds.a === 'whox') S.who = null;
    else if (ds.a === 'pryes') giveRoom(S.pendRoom.sid, S.pendRoom.id, true);
    else if (ds.a === 'prno') S.pendRoom = null;
    else if (ds.a === 'recopen') { S.sessMenu = false; call('chart_switches', { p_reception_open: !S.recOpen, p_online_mode: S.online ? 'open' : 'walk_ins_only' }, S.recOpen ? 'Reception closed: everyone is Patient Care.' : 'Reception is open.'); }
    else if (ds.a === 'online') { S.sessMenu = false; call('chart_switches', { p_reception_open: S.recOpen, p_online_mode: S.online ? 'walk_ins_only' : 'open' }, S.online ? 'Walk-ins only: online check-in is paused.' : 'Online check-in is open again.'); }
    else if (ds.a === 'endsess') { S.endSess = !S.endSess; S.sessMenu = false; } else if (ds.a === 'endsessx') S.endSess = false;
    else if (ds.endcase) toast('Use Close all at the bottom, or Finish now for this one.');
    else if (ds.finish) { S.open = +ds.finish; S.tab = 'leave'; S.outcome = null; }
    else if (ds.a === 'endall') endSession();
    // road
    else if (ds.iurg) S.inc.urgency = +ds.iurg;
    else if (ds.ieta) S.inc.eta = +ds.ieta;
    else if (ds.a === 'incgo') { const d = S.inc, [sy, di] = String(d.bp || '').split('/');
      call('chart_checkin', { p_patient: { name: d.name.trim(), age: d.age ? +d.age : null, symptoms: d.what ? [d.what] : [], eta_minutes: d.eta, note: d.what || '', vitals: { ...(d.hr ? { hr: +d.hr } : {}), ...(sy ? { sys: +sy } : {}), ...(di ? { dia: +di } : {}) } }, p_source: 'incoming', p_esi: d.urgency, p_teams: ['Any'] }, `${esc(d.name.trim())} is on the way. The ER sees them as Incoming.`);
      S.inc = null; S.incDone = false; }
    else if (ds.handover) handover(+ds.handover);
    // front desk
    else if (ds.lbbs) { act.lbbs(byId(+ds.lbbs)); if (isPhone()) back(); }
    else if (ds.back) S.backFor = S.backFor === +ds.back ? null : +ds.back;
    else if (ds.edit) { S.editFor = S.editFor === +ds.edit ? null : +ds.edit; S.recheckFor = null; }
    else if (ds.a === 'editx') S.editFor = null;
    else if (ds.eteam) editTeam(byId(S.editFor), ds.eteam);
    else if (ds.ecol) editColour(byId(S.editFor), +ds.ecol);
    else if (ds.dpain !== undefined) S.draft.pain = S.draft.pain === +ds.dpain ? null : +ds.dpain;
    else if (ds.donset) S.draft.onset = S.draft.onset === ds.donset ? null : ds.donset;
    else if (ds.ddept) S.draft.teams = toggleTeam(S.draft.teams || [], ds.ddept);
    else if (ds.cdeptp) S.cdept[+ds.cdeptp] = toggleTeam(S.cdept[+ds.cdeptp] || [], ds.v);
    else if (ds.fbadd || ds.fbpick) { const id = ds.fbadd || ds.fbpick, inp = $('#fb-' + CSS.escape(id)); const val = ds.fbpick ? ds.fbval : (inp && inp.value);
      if (fbSave(id, inp ? inp.dataset.fbkind : '', val)) { (S.fb || (S.fb = {}))[id] = ''; if (isPhone() && (id === 'ord' || id === 'dx')) back(); } }
    else if (ds.dsymrm) S.draft.symptoms.splice(+ds.dsymrm, 1);
    else if (ds.npcsymrm && S.npc) S.npc.symptoms.splice(+ds.npcsymrm, 1);
    else if (ds.symadd) { S.symEdit = +ds.symadd; }
    else if (ds.symx) S.symEdit = null;
    else if (ds.pdsymrm) S.pdraft.symptoms.splice(+ds.pdsymrm, 1);
    else if (ds.furm) { S.checkout[+ds.furm].follow = ''; byId(+ds.furm).follow = ''; }
    else if (ds.advrm !== undefined) delete cur().advice;
    else if (ds.didrm) { const d = cur().did[+ds.didrm]; if (d && d.id) call('chart_entry_error', { p_entry: d.id, p_reason: 'Removed by the author' }, 'Removed.'); }
    else if (ds.ow) S.orderWho = ds.ow;
    else if (ds.reschange) { const o = cur().orders[+ds.reschange]; if (o) o.result = null; }
    else if (ds.a === 'dxedit') S.dxEdit = true;
    else if (ds.mvTo) { const id = S.moveFor; S.moveFor = null; dropOnBed(id, ds.mvTo); }
    else if (ds.mvYes !== undefined) doMove(S.pending.pid, S.pending.bed);
    else if (ds.mvSwap !== undefined) doMove(S.pending.pid, S.pending.bed, S.pending.swap);
    else if (ds.mvNo !== undefined) { S.pending = null; S.moveFor = null; }
    else if (ds.mvopen) S.moveFor = +ds.mvopen;
    else if (ds.a === 'moveto') { S.sec = 'plan'; S.moveFor = S.open; S.open = null; }
    else if (ds.a === 'arrive') toast('Online check-ins come from patients on the #visit page.');
    else if (ds.a === 'npopen') S.npOpen = true; else if (ds.a === 'npx') S.npOpen = false;
    else if (ds.a === 'add') act.add(S.draft);
    else if (ds.a === 'padd') { act.add(S.draft); S.ph = [{ s: S.role === 'room' ? 'myroom' : 'desk' }]; }
    else if (ds.a === 'closerec') { S.open = null; S.vopen = false; S.outcome = null; S.handbackFor = null; S.reqMenu = false; }
    else if (ds.a === 'vopen') { S.vopen = true; S.vdraft = {}; }
    else if (ds.a === 'vsave') { const p = cur(); const vals = Object.fromEntries(Object.entries(S.vdraft).filter(([, v]) => v !== '').map(([k, v]) => [k, +v]));
      if (Object.keys(vals).length) chartIt(p, 'vitals', vals, 'Vitals saved.'); S.vopen = false; S.vdraft = {}; if (isPhone()) back(); }
    else if (ds.a === 'pconfirm') { const p = cur(); touch(p).then(() => call('chart_colour', { p_case: p.id, p_esi: p.urgency, p_confirm: true }, `Triage colour confirmed: ${esc(U(p.urgency).name)}.`)); if (isPhone() && top().s === 'p-urg') back(); }
    else if (ds.a === 'leavego') { const p = cur(); act.leave(p, S.outcome); if (isPhone()) home(); }
    else if (ds.a === 'endshift') S.endShift = !S.endShift; else if (ds.a === 'endx') S.endShift = false;
    else if (ds.a === 'hball') { const note = ($('#hb-all') || {}).value; if (sure(note, 'Add a short note for whoever takes over.')) { Promise.all(mine().map((p) => rpc('chart_hand_back', { p_case: p.id, p_note: note.trim() }).catch(() => null)))
      .then(() => { if (S.endShift === 'role') { S.endShift = false; return leaveRole().then((r) => { if (r) toast('Handed over. Pick your new role.'); }); } return rpc('chart_leave_beds', {}).catch(() => null).then(endMyShift); }); } }
    else if (ds.a === 'endgo') { rpc('chart_leave_beds', {}).catch(() => null).then(endMyShift); }
    else if (ds.a === 'hbx') S.handbackFor = null;
    else if (ds.a === 'phone') S.phone = !S.phone; else if (ds.a === 'phonex') S.phone = false;
    else if (ds.a === 'pdgo') toast('Patients check in on the #visit page.');
    else if (ds.a === 'pdreset') S.pid = null;
    else if (ds.copycode !== undefined) { try { navigator.clipboard.writeText(D.JOIN_CODE); } catch { /* fine */ } S.copied = true; setTimeout(() => { S.copied = false; if (!typing()) render(); }, 2000); toast('Join code copied.'); }
    else if (ds.pdsaid) S.pdraft.said = ds.pdsaid;
    else if (ds.prate) toast('Patients rate on their visit page.');
    else if (ds.durg) S.draft.urgency = +ds.durg;
    else if (ds.confirm) S.confirmFor = S.confirmFor === +ds.confirm ? null : +ds.confirm;
    else if (ds.cconf) { act.confirm(byId(+ds.cconf), +ds.c); if (isPhone()) back(); }
    else if (ds.rc) { act.recheck(byId(+ds.rc), +ds.c); if (isPhone()) back(); }
    else if (ds.recheck) S.recheckFor = S.recheckFor === +ds.recheck ? null : +ds.recheck;
    else if (ds.bump) act.bump(byId(+ds.bump));
    else if (ds.called) act.calledOut(byId(+ds.called));
    else if (ds.star) { if (!byId(+ds.star).rating) S.checkout[+ds.star].rating = +ds.v; }
    else if (ds.outDone) { act.checkedOut(byId(+ds.outDone)); if (isPhone()) back(); }
    else if (ds.hb) S.handbackFor = S.handbackFor === +ds.hb ? null : +ds.hb;
    else if (ds.hbgo) { const note = ($('#hb-note') || {}).value; if (sure(note, 'Add a short note first: it\u2019s needed.')) { act.handback(byId(+ds.hbgo), note); if (isPhone()) home(); } }
    else if (ds.purg) { const p = cur(), n = +ds.purg; if (n !== p.urgency) touch(p).then(() => call('chart_colour', { p_case: p.id, p_esi: n, p_confirm: p.nurse === 'me', p_reason: 'Changed after checking them' }, `Colour changed to ${esc(U(n).name)}. It's in the colour history.`)); }
    else if (ds.odone) { const o = cur().orders[+ds.odone]; if (o && o.id) call('chart_order_done', { p_entry: o.id }, `${esc(o.what)}: done.`); }
    else if (ds.out) { S.outcome = ds.out; S.forceAsk = false; }
    else if (ds.tab) { S.tab = ds.tab; S.vopen = false; }
    else if (ds.dtab) { S.deskTab = ds.dtab; S.confirmFor = null; S.recheckFor = null; }
    else if (ds.sec) S.sec = ds.sec;
    else if (ds.open) { const p = byId(+ds.open); if (p && S.noRec && S.noRec.has(p.id) && p.nurse !== 'me' && !reqFor(p.id)) toast(boardLine(p)); else if (p && (p.stage === 'care' || (p.stage === 'queue' && S.role === 'super' && !isPhone()))) openP(p.id); else if (p) toast(`${esc(p.name)}: ${esc(status(p).toLowerCase())}.`); }
    else if (ds.popen) { go('patient', { id: +ds.popen }); S.outcome = null; }
    else if (ds.pgo) { if (ds.pgo === 'p-num') S.vdraft = {}; go(ds.pgo, { id: ds.pid ? +ds.pid : top().id }); }
    else if (ds.proot) S.ph = [{ s: ds.proot }];
    else if (ds.pb !== undefined) back();
    else return;
    render();
  });
  // Timers: Got it (60 s), Ready running out (10 min), and requests crossing 3 / 8 min redraw the screen once; the
  // countdowns tick every second without a redraw.
  setInterval(() => {
    if (!app.isConnected) return;
    let dirty = false;
    const sig2 = [...S.reqs.filter(isOpenReq).map(reqLevel), ...P().filter((p) => p.phase === 'called').map((p) => (since(p.calledAt) >= SEC(300) ? 1 : 0)), ...S.incoming.map((x) => (since(x.at) >= SEC(x.eta * 60) ? 1 : 0))].join();
    if (sig2 !== tickSig) { tickSig = sig2; dirty = true; }
    if (dirty && !typing() && !drag) render();
    app.querySelectorAll('[data-cd]').forEach((el) => { el.textContent = mmss((SEC(+el.dataset.secs) - since(el.dataset.cd)) * K()); });
    app.querySelectorAll('[data-up]').forEach((el) => { el.textContent = mmss(since(el.dataset.up) * K()); });
  }, 1000);
  let tickSig = '';
  setInterval(() => app.querySelectorAll('[data-since]').forEach((el) => { el.textContent = ago(el.dataset.since); }), 20000);
  let wasPhone = isPhone();
  window.addEventListener('resize', () => { if (!app.isConnected) return; if (isPhone() !== wasPhone) { wasPhone = isPhone(); render(); } else if (!isPhone()) sizeBoard(); });
  app.addEventListener('click', (e) => { const u = e.target.closest('[data-undocall]'); if (!u) return; const p = byId(+u.dataset.undocall); if (p) { $('#chx-toast').hidden = true; act.calledOut(p, true); } });
  if (window.ResizeObserver) new ResizeObserver(() => { if (!isPhone()) sizeBoard(); }).observe(app);
  // Test hook (prototype only): the room-rule self-test in the console uses these.
  if (LOCAL) window.__cbh = { S, D, A, byId, act, bedUsable, alertMe, tone, dropOnBed, dropOnPerson, giveRoom, giveTo, pickBed, planMove, doMove, canHave, bestFor, bedsOf, roomsInUse, myRoomSection, roomPanel };
  // ---------- hooks for the entry points outside chart.js (sidebar badge, shift card, phone tab) ----------
  window.CBHChart = Object.assign(window.CBHChart || {}, {
    summary: () => (!SNAP ? null : {
      on_shift: !!S.onShift, role: ROLE_OUT[S.role] || null, department: S.rdept,
      assigned: mine().filter((p) => p.phase === 'assigned').map((p) => ({ id: p.id, short_name: p.name, expires_at: p.assignExp })),
      to_confirm: S.role === 'reception' || S.role === 'super' ? toConfirm().length : 0,
      open_requests_for_me: S.reqs.filter((r) => isOpenReq(r) && !r.acceptedBy && r.type !== 'imaging' && canAccept(r)).length,
      queue: upNext().length, codes: S.codes.length }),
    open: (id) => { S.open = +id; S.tab = 'chart'; if (location.hash !== '#chart') location.hash = '#chart'; else render(); },
    URG: D.URGENCY, COLOUR_QUESTIONS: D.COLOUR_QUESTIONS,
  });
  // ---------- the site page (#chart) ----------
  PAGES.push({ id: 'chart', aud: 'chart', title: 'CBH Chart', icon: 'stethoscope', layout: 'chart' });
  if (typeof TOOL_FOLDER === 'object') TOOL_FOLDER.chart = 'operations';
  // Shown in menus, search and Home only once the server says this person may use it. Until the first poll a
  // direct #chart link stays reachable (it shows Loading, then the Chart or "opens soon").
  const visible = () => !!SNAP && (S.launched || S.canSuper || !!window.execReal);
  window.CBHChart.visible = visible;
  const openAccess = () => { access.chart = SNAP ? visible() : location.hash.startsWith('#chart'); };
  let wasVisible = null;
  document.addEventListener('cbh-chart-poll', () => { const v = visible(); if (v !== wasVisible) { wasVisible = v; openAccess(); if (typeof window.deskRefresh === 'function') window.deskRefresh(); if (v && location.hash.startsWith('#chart') && !app.isConnected && typeof route === 'function') route(); } });
  const deskDraw = window.deskDraw;
  if (deskDraw) window.deskDraw = (d) => { const done = deskDraw(d); openAccess(); if (!pollT && !polling) poll(true); if (location.hash.startsWith('#chart') && $('#page').hidden) route(); return done; };
  openAccess();
  LIVE.chart = (body) => {
    document.body.classList.add('in-chart'); setPageTitle('stethoscope', 'CBH Chart', 'staff');
    body.replaceChildren(app); render(); poll(true);
  };
  window.addEventListener('hashchange', () => { if (!location.hash.startsWith('#chart')) document.body.classList.remove('in-chart'); });

})();
