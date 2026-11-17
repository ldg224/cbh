// CareBeyond home (0.14.0, owner-approved design "B3 refined"): search with smart suggestions, a Session active
// block (only while a session runs), your own pins, and four folders of live cards that each open as a page.
// Everyone gets the same page; each person only sees the tools they can use (canSee/toolAud from app.js).
// Back end (Bravo, migration 0016): get_my_prefs / set_my_pins, home_counts, people_search.

const FOLDERS = [
  { id: 'moderation', title: 'Moderation', blurb: 'Keep the server safe', icon: 'shield', g: ['#2b3aa8', '#5c72ff'], tint: '#f5f6ff' },
  { id: 'people', title: 'People', blurb: 'Staff, departments and applicants', icon: 'people', g: ['#0d7d74', '#2ed3c6'], tint: '#f1fbfa' },
  { id: 'operations', title: 'Operations', blurb: 'Sessions, shifts, hours and settings', icon: 'settings', g: ['#3d2a8f', '#6a4fd6'], tint: '#f5f3ff' },
  { id: 'help', title: 'Help and info', blurb: 'For everyone', icon: 'book', g: ['#22579f', '#4cacf0'], tint: '#f2f7fd' },
];
const TOOL_FOLDER = {
  'admin/cases': 'moderation', 'admin/records': 'moderation', 'admin/logs': 'moderation', 'admin/tickets': 'moderation',
  tickets: 'moderation', 'exec/strikes': 'moderation',
  roster: 'people', 'admin/applications': 'people', review: 'people',
  'directors/sessions': 'operations', 'admin/sessions': 'operations', shifts: 'operations', 'exec/reports': 'operations',
  'exec/announce': 'operations', 'exec/settings': 'operations',
  rules: 'help', contact: 'help', apply: 'help', commands: 'help',
};
const TOOL_BLURB = {
  'admin/cases': 'Warn, time out, kick, ban', 'admin/records': 'Look anyone up', 'admin/logs': 'Edits, deletes, joins',
  'admin/tickets': 'Contact-a-team conversations', tickets: 'Your team’s conversations', 'exec/strikes': 'Staff discipline',
  roster: 'Everyone, by department', 'admin/applications': 'Read and decide', review: 'Read and decide',
  'directors/sessions': 'Start or schedule', 'admin/sessions': 'Start or schedule', shifts: 'Clock in and out',
  'exec/reports': 'Hours by person and department', 'exec/announce': 'Post to Discord', 'exec/settings': 'Join code, auto-end',
  rules: 'Policy and what each rank does', contact: 'Talk to a team', apply: 'Join a team', commands: 'The bot’s commands',
};
const SEARCH_WORDS = {
  'admin/cases': 'warn timeout kick ban unban moderation punish', 'admin/records': 'profile history user lookup person warnings',
  'admin/logs': 'deleted edited messages joins leaves audit', 'admin/tickets': 'support help conversations',
  tickets: 'support conversations', roster: 'staff members people directory', shifts: 'clock in out on duty hours',
  'directors/sessions': 'session server start schedule maple', 'admin/sessions': 'session server start schedule maple',
  'exec/reports': 'hours quota activity', 'exec/settings': 'join code auto end settings maple', apply: 'application form join',
  contact: 'ticket support help', rules: 'policy rules ranks', commands: 'slash bot',
};

// Order inside each folder (unbuilt pages always go last).
const TOOL_ORDER = ['admin/cases', 'admin/records', 'admin/logs', 'admin/tickets', 'tickets', 'exec/strikes',
  'admin/applications', 'review', 'roster',
  'directors/sessions', 'admin/sessions', 'shifts', 'exec/reports', 'exec/settings', 'exec/announce',
  'contact', 'apply', 'rules', 'commands'];
const toolRank = (t) => (t.def.building ? 1000 : 0) + (t.def.layout === 'dept' ? 500 : 0) + (TOOL_ORDER.indexOf(t.key) + 1 || 400);

let HC = null;           // home_counts() for me
let PREFS = null;        // { enabled, count, items }
let homeTimer = null;

// Every tool this person can use, with its folder.
function myTools() {
  const out = [];
  for (const p of PAGES) {
    if (p.tools) {
      if (!canSee(p.aud)) continue;
      for (const t of p.tools.filter((x) => canSee(toolAud(p, x)))) {
        const key = `${p.id}/${t.id}`;
        out.push({ key, href: '#' + key, def: t, folder: t.layout === 'dept' ? 'people' : TOOL_FOLDER[key] || 'operations' });
      }
    } else if (canSee(p.aud)) {
      out.push({ key: p.id, href: '#' + p.id, def: p, folder: TOOL_FOLDER[p.id] || 'help' });
    }
  }
  return out.sort((a, b) => toolRank(a) - toolRank(b));
}
const toolGrad = (t) => {
  if (t.def.color) return `linear-gradient(135deg,#3d2a8f,${t.def.color})`;
  const f = FOLDERS.find((x) => x.id === t.folder);
  return `linear-gradient(135deg,${f.g[0]},${f.g[1]})`;
};

// ---------- live lines ----------
const n0 = (v) => Number(v || 0);
const plural = (n, w) => `${n} ${w}${n == 1 ? '' : 's'}`;
function liveInfo(t) {
  const h = HC || {}, k = t.key, d = t.def;
  if (d.building) return { line: 'Being built' };
  if (d.layout === 'dept') {
    const on = n0(h.dept_on_now && h.dept_on_now[d.dept]), mem = n0(h.dept_members && h.dept_members[d.dept]);
    return { line: on ? `${on} on now` : plural(mem, 'member') };
  }
  switch (k) {
    case 'admin/cases': return { line: `${n0(h.actions_week)} this week`, alert: n0(h.failed_mine) ? `${n0(h.failed_mine)} didn’t go through` : '' };
    case 'admin/records': { const last = lastRecord(); return { line: last ? `Last: ${last.name}` : 'Look anyone up' }; }
    case 'admin/logs': { const l = h.logs_today || {}; return { line: `${n0(l.deleted) + n0(l.edited) + n0(l.joins_leaves) + n0(l.roles)} events today` }; }
    case 'admin/tickets': case 'tickets': return { line: h.tickets_latest ? `${h.tickets_latest.name || ''}${h.tickets_latest.team ? ' · ' + h.tickets_latest.team : ''}` : 'Nothing open', badge: n0(h.tickets_open) ? `${n0(h.tickets_open)} open` : '' };
    case 'roster': return { line: `${plural(n0(h.members_total), 'member')}` };
    case 'admin/applications': case 'review': return { line: h.apps_oldest_at ? `Oldest ${when(h.apps_oldest_at)}` : 'Nothing waiting', badge: n0(h.apps_waiting) ? `${n0(h.apps_waiting)} waiting` : '', warm: !!n0(h.apps_waiting) };
    case 'directors/sessions': case 'admin/sessions': {
      const s = h.session || currentSession || {};
      if (s.live) return { line: `Hosted by ${s.live.host_name || 'staff'}`, live: true };
      return { line: s.next ? `Next: ${whenAhead(s.next.scheduled_for)}` : 'No session planned' };
    }
    case 'shifts': return { line: h.my_shift ? `You’re on: ${hrs(shiftSecs(h.my_shift))}` : `You: ${hrs(n0(h.my_week_hours) * 3600)} this week`, clock: !!h.my_shift };
    case 'exec/reports': return { line: `${n0(h.hospital_hours_week).toFixed(1)} h across the hospital this week` };
    case 'exec/settings': return { line: `Join code ${(h.session && h.session.code) || joinCode}` };
    default: return { line: TOOL_BLURB[k] || '' };
  }
}
function folderNeeds(fid) {
  const h = HC || {};
  if (fid === 'moderation') { const x = n0(h.failed_mine) + n0(h.tickets_open); return x ? ['bad', `${x} need${x == 1 ? 's' : ''} you`] : null; }
  if (fid === 'people') { const x = n0(h.apps_waiting); return x ? ['warm', `${x} to review`] : null; }
  if (fid === 'operations') { const s = h.session || currentSession; return s && s.live ? ['live', 'Session live'] : null; }
  return null;
}
function lastRecord() { try { return JSON.parse(localStorage.getItem('cbh-last-record') || 'null'); } catch { return null; } }
function rememberRecord(id, name) { try { localStorage.setItem('cbh-last-record', JSON.stringify({ id, name })); } catch { /* fine */ } }

// ---------- data ----------
async function loadHomeData() {
  const [c, p] = await Promise.all([
    sb.rpc('home_counts').then((r) => (r.error ? null : r.data), () => null),
    sb.rpc('get_my_prefs').then((r) => (r.error ? null : r.data), () => null),
  ]);
  HC = c || {};
  let pins = p && p.pins;
  if (!pins) { try { pins = JSON.parse(localStorage.getItem('cbh-pins') || 'null'); } catch { pins = null; } }
  PREFS = Object.assign({ enabled: true, count: 4, items: [] }, pins || {});
}
async function savePins(pins) {
  PREFS = pins;
  const { error } = await sb.rpc('set_my_pins', { pins });
  if (error) { try { localStorage.setItem('cbh-pins', JSON.stringify(pins)); } catch { /* fine */ } }
}

// ---------- the page ----------
function homeShell() {
  const name = cleanName($('name').textContent || '');
  return `
    <div class="h-hero">
      <h1 class="h-title" id="h-title"><span class="h-type" aria-hidden="true"></span></h1>
      <div class="h-search" id="h-search">
        <label class="h-box"><span class="h-glass" aria-hidden="true"></span>
          <input id="h-q" placeholder="Search people, tools or settings" autocomplete="off" aria-label="Search" aria-controls="h-results">
          <kbd class="h-kbd" aria-hidden="true">/</kbd></label>
        <div class="h-results" id="h-results" role="listbox" hidden></div>
      </div>
      <div class="h-sugg" id="h-sugg"></div>
    </div>
    <div id="h-live"></div>
    <section class="h-sec" id="h-pins-sec"></section>
    <section class="h-sec"><h2 class="h-label">Everything you can use</h2><div class="h-folders" id="h-folders"></div></section>`;
}

async function renderHome() {
  const box = $('home');
  if (!box.dataset.built) { box.innerHTML = homeShell(); box.dataset.built = '1'; wireSearch(); }
  typeHeadline();
  drawHome();
  await loadHomeData();
  if (!box.isConnected || box.hidden) return;
  drawHome();
}
function drawHome() {
  const tools = myTools();
  drawSuggestions(tools);
  drawLive();
  drawPins(tools);
  $('h-folders').innerHTML = FOLDERS.map((f) => folderCard(f, tools.filter((t) => t.folder === f.id))).join('');
  tickHome();
}

function cardHtml(t, big) {
  const i = liveInfo(t);
  const f = FOLDERS.find((x) => x.id === t.folder);
  const tint = t.def.color ? `linear-gradient(160deg, color-mix(in srgb, ${t.def.color} 16%, #fff), #fff)` : f.tint;
  return `<a class="h-card${big ? ' big' : ''}${t.def.color ? ' dept' : ''}${i.warm ? ' warm' : ''}" href="${t.href}" style="--tint:${tint};${t.def.color ? `--dc:${t.def.color}` : ''}">
    <span class="h-card-top"><strong>${esc(t.def.title)}</strong>${i.live ? '<span class="h-pill live">Live</span>' : i.badge ? `<span class="h-pill">${esc(i.badge)}</span>` : ''}</span>
    <span class="h-card-line${i.clock ? ' clock' : ''}" ${i.clock ? 'data-tick="shift-line"' : ''}>${esc(i.line)}</span>
    ${big && TOOL_BLURB[t.key] && i.line !== TOOL_BLURB[t.key] ? `<span class="h-card-blurb">${esc(TOOL_BLURB[t.key])}</span>` : ''}
    ${i.alert ? `<span class="h-card-alert">${esc(i.alert)}</span>` : ''}</a>`;
}
function folderCard(f, tools) {
  if (!tools.length) return '';
  const need = folderNeeds(f.id);
  const depts = tools.filter((t) => t.def.layout === 'dept'), rest = tools.filter((t) => t.def.layout !== 'dept');
  return `<div class="h-folder">
    <div class="h-folder-head">
      <span class="h-fico" style="--g1:${f.g[0]};--g2:${f.g[1]};--icon:${iconUrl(f.icon)}" aria-hidden="true"></span>
      <a class="h-fname" href="#f/${f.id}"><strong>${f.title}</strong><span>${f.blurb}</span></a>
      ${need ? `<span class="h-pill ${need[0]}">${esc(need[1])}</span>` : ''}
      <a class="h-open" href="#f/${f.id}" aria-label="Open ${f.title}"></a>
    </div>
    <div class="h-cards">${rest.map((t) => cardHtml(t)).join('')}
      ${depts.length ? `<div class="h-depts">${depts.map((t) => cardHtml(t)).join('')}</div>` : ''}</div>
  </div>`;
}


// ---------- the headline (0.14.1, owner) ----------
// One line picked at random per page load, typed out once, then left alone. Calm, professional wording: no emoji,
// no exclamation marks, no slang. Time-of-day greetings only appear at the right local time.
const HEADLINES = {
  any: [
    'Welcome back, {name}.', 'Welcome, {name}.', 'Good to see you, {name}.', 'Hello, {name}.',
    'Welcome back to CareBeyond, {name}.', 'Hello again, {name}.', 'Ready when you are, {name}.',
    'Everything is here, {name}.', 'Here\u2019s where things stand, {name}.', 'Glad you\u2019re here, {name}.',
    'What do you need, {name}?', 'What can I help with, {name}?', 'Where are we starting today, {name}?',
    'What are you looking for, {name}?', 'Who are you looking for, {name}?', 'What\u2019s next, {name}?',
    'Where would you like to go, {name}?', 'What would you like to do, {name}?', 'How can I help, {name}?',
    'What are we working on, {name}?', 'Where to first, {name}?', 'What should we look at first, {name}?',
    'What do you need to find, {name}?', 'Looking for someone, {name}?', 'Looking for a tool, {name}?',
    'What would you like to review, {name}?', 'Ready to get started, {name}?', 'What\u2019s on your list, {name}?',
    'Who do you need, {name}?', 'Which record do you need, {name}?', 'Need to find something, {name}?',
    'What would you like to check, {name}?', 'Where shall we begin, {name}?', 'What do you need today, {name}?',
    'What can I open for you, {name}?', 'Anything I can find for you, {name}?', 'What can I pull up, {name}?',
    'Welcome back, {name}. What do you need?', 'Welcome back, {name}. Where would you like to start?',
    'Hello, {name}. What can I help with?', 'Hello, {name}. Where would you like to start?',
  ],
  morning: ['Good morning, {name}.', 'Good morning, {name}. Where would you like to start?', 'Good morning, {name}. Here\u2019s where things stand.'],
  afternoon: ['Good afternoon, {name}.', 'Good afternoon, {name}. What do you need?', 'Good afternoon, {name}. Here\u2019s where things stand.'],
  evening: ['Good evening, {name}.', 'Good evening, {name}. What can I help with?', 'Good evening, {name}. Here\u2019s where things stand.'],
};
let headline = null;   // chosen once per page load
function typeHeadline() {
  const h1 = $('h-title'), span = h1 && h1.querySelector('.h-type');
  if (!span) return;
  const raw = cleanName($('name').textContent || '').split(' | ')[0].trim();
  if (!headline) {
    const hr = new Date().getHours();   // the viewer's local time
    const part = hr >= 5 && hr < 12 ? 'morning' : hr >= 12 && hr < 17 ? 'afternoon' : hr >= 17 && hr < 22 ? 'evening' : null;
    const pool = HEADLINES.any.concat(part ? HEADLINES[part] : []);
    headline = { text: pool[Math.floor(Math.random() * pool.length)], typed: false };
  }
  const text = raw ? headline.text.replace('{name}', raw) : headline.text.replace(/,? \{name\}/, '');
  h1.setAttribute('aria-label', text);
  const instant = headline.typed || matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (instant) { span.textContent = text; h1.classList.remove('typing'); return; }
  headline.typed = true;
  span.textContent = '';
  h1.classList.add('typing');
  let i = 0;
  const step = () => {
    if (!span.isConnected) return;
    span.textContent = text.slice(0, ++i);
    if (i < text.length) setTimeout(step, text[i - 1] === ',' || text[i - 1] === '.' ? 140 : 34);
    else setTimeout(() => h1.classList.remove('typing'), 900);
  };
  setTimeout(step, 250);
}

// ---------- pins ----------
function pinnedTools(tools) {
  const byKey = Object.fromEntries(tools.map((t) => [t.key, t]));
  const chosen = (PREFS.items || []).map((k) => byKey[k]).filter(Boolean);
  // Until you choose, your first tools stand in (never "most used").
  const fill = tools.filter((t) => !chosen.includes(t) && !t.def.building);
  return chosen.concat(PREFS.items && PREFS.items.length ? [] : fill).slice(0, PREFS.count);
}
function drawPins(tools) {
  const sec = $('h-pins-sec');
  if (!PREFS) { sec.innerHTML = ''; return; }
  if (!PREFS.enabled) {
    sec.innerHTML = `<p class="h-off">Pins are turned off. <button class="linkish" id="h-pins-on">Turn them on</button></p>`;
    sec.querySelector('#h-pins-on').onclick = () => openPinSettings(tools, true);
    return;
  }
  const pins = pinnedTools(tools);
  sec.innerHTML = `<div class="h-sec-head"><h2 class="h-label">Pinned</h2><button class="linkish" id="h-pins-edit">Edit pins</button></div>
    <div class="h-pins" style="--n:${Math.max(pins.length, 2)}"></div>`;
  // Pins are the classic home tiles (tileEl in app.js): frosted icon square, big faint icon, gradient and shade.
  // (0.14.4: 0.14.0 drew them as plain gradient links and lost the icons.)
  const grid = sec.querySelector('.h-pins');
  for (const t of pins) {
    const i = liveInfo(t);
    const f = FOLDERS.find((x) => x.id === t.folder);
    const a = tileEl(t.href, t.def, 'everyone', 'h-pin-tile');
    a.classList.remove('wide');   // every pin is the same size (Sessions is a wide banner elsewhere)
    if (t.def.color) a.style.setProperty('--dept', t.def.color);
    else { a.style.setProperty('--g1', f.g[0]); a.style.setProperty('--g2', f.g[1]); a.style.setProperty('--g3', f.g[1]); }
    a.querySelector('.tile-flag')?.remove();   // "Being built" is never pinned-worthy noise; live flags below instead
    if (i.live) a.insertAdjacentHTML('beforeend', '<span class="tile-flag live">Live now</span>');
    else if (i.badge) a.insertAdjacentHTML('beforeend', `<span class="tile-flag">${esc(i.badge)}</span>`);
    else if (i.clock) a.insertAdjacentHTML('beforeend', `<span class="tile-flag" data-tick="pin-clock">${esc(clock(shiftSecs(HC.my_shift)))}</span>`);
    grid.append(a);
  }
  sec.querySelector('#h-pins-edit').onclick = () => openPinSettings(tools);
}
function openPinSettings(tools, turnOn) {
  const draft = { enabled: turnOn ? true : PREFS.enabled, count: PREFS.count, items: pinnedTools(tools).map((t) => t.key) };
  const byKey = Object.fromEntries(tools.map((t) => [t.key, t]));
  const ov = document.createElement('div');
  ov.className = 'h-overlay';
  ov.innerHTML = `<section class="h-modal" role="dialog" aria-modal="true" aria-labelledby="pm-title">
      <div class="h-modal-head"><h2 id="pm-title">Pinned tools</h2><button class="h-x" aria-label="Close">&times;</button></div>
      <div class="h-modal-body" id="pm-body"></div>
      <div class="h-modal-foot"><button class="linkish" id="pm-cancel">Cancel</button><button class="refresh" id="pm-save">Save pins</button></div>
    </section>`;
  document.body.append(ov);
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
  ov.querySelector('.h-x').onclick = close;
  ov.querySelector('#pm-cancel').onclick = close;
  ov.querySelector('#pm-save').onclick = async () => { await savePins({ ...draft, items: draft.items.slice(0, draft.count) }); close(); drawHome(); };
  const body = ov.querySelector('#pm-body');
  const draw = () => {
    draft.items = draft.items.slice(0, draft.count);
    const others = tools.filter((t) => !draft.items.includes(t.key));
    body.innerHTML = `
      <label class="pm-switch"><span><strong>Show pins on my home page</strong><span class="muted">Turn off for just search and the tool list.</span></span>
        <input type="checkbox" id="pm-on" ${draft.enabled ? 'checked' : ''}><span class="pm-track" aria-hidden="true"></span></label>
      <div class="pm-block${draft.enabled ? '' : ' off'}">
        <strong>How many</strong>
        <div class="pm-count">${[2, 3, 4, 5, 6, 7].map((n) => `<button type="button" data-n="${n}" aria-pressed="${n === draft.count}">${n}</button>`).join('')}</div>
        <div class="pm-head"><strong>Your pins, in order</strong></div>
        <div class="pm-list">${draft.items.map((k, i) => `<div class="pm-row">
            <span class="pm-sw" style="background:${toolGrad(byKey[k])}"></span><strong>${esc(byKey[k].def.title)}</strong>
            <button type="button" class="pm-mv" data-up="${i}" aria-label="Move ${esc(byKey[k].def.title)} up" ${i ? '' : 'disabled'}>↑</button>
            <button type="button" class="pm-mv" data-down="${i}" aria-label="Move ${esc(byKey[k].def.title)} down" ${i < draft.items.length - 1 ? '' : 'disabled'}>↓</button>
            <button type="button" class="ghost small-btn" data-rm="${i}">Remove</button></div>`).join('') || '<p class="muted small">No pins yet. Add some below.</p>'}</div>
        <label class="f"><span>${draft.items.length < draft.count ? 'Add a pin' : 'Swap one in'}</span>
          <select id="pm-add" ${draft.items.length < draft.count ? '' : 'disabled'}><option value="">Choose a tool…</option>${others.map((t) => `<option value="${t.key}">${esc(t.def.title)}</option>`).join('')}</select></label>
        <span class="muted small">You've chosen ${draft.items.length} of ${draft.count}.${draft.items.length >= draft.count ? ' Remove one to swap in another, or pick a bigger number above.' : ''}</span>
      </div>`;
    body.querySelector('#pm-on').onchange = (e) => { draft.enabled = e.target.checked; draw(); };
    body.querySelectorAll('[data-n]').forEach((b) => { b.onclick = () => { draft.count = +b.dataset.n; draw(); }; });
    body.querySelectorAll('[data-up]').forEach((b) => { b.onclick = () => { const i = +b.dataset.up; [draft.items[i - 1], draft.items[i]] = [draft.items[i], draft.items[i - 1]]; draw(); }; });
    body.querySelectorAll('[data-down]').forEach((b) => { b.onclick = () => { const i = +b.dataset.down; [draft.items[i + 1], draft.items[i]] = [draft.items[i], draft.items[i + 1]]; draw(); }; });
    body.querySelectorAll('[data-rm]').forEach((b) => { b.onclick = () => { draft.items.splice(+b.dataset.rm, 1); draw(); }; });
    body.querySelector('#pm-add').onchange = (e) => { if (e.target.value) { draft.items.push(e.target.value); draw(); } };
  };
  draw();
  ov.querySelector('.h-x').focus();
}

// ---------- session active ----------
function drawLive() {
  const el = $('h-live');
  const h = HC || {};
  const s = h.session || currentSession || {};
  if (!s.live) { drawIdle(el, h, s); return; }
  const live = s.live, me = h.my_shift, on = h.on_shift || {};
  const since = live.started_at ? new Date(live.started_at) : null;
  const byDept = Object.entries(on.by_dept || {}).filter(([, v]) => v).map(([k, v]) => `${k === 'Community Engagement' ? 'CE' : k === 'Administration' ? 'Admin' : k} ${v}`).join(' · ');
  el.innerHTML = `<section class="h-live" aria-label="Session active">
    <div class="h-live-head"><span class="h-live-tag"><span class="h-live-dot"></span>SESSION ACTIVE</span>
      <span class="h-live-meta">Hosted by ${esc(live.host_name || 'staff')}${since ? ` · since ${since.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · <span data-tick="sess-len">${hrs((Date.now() - since) / 1000)}</span>` : ''}</span>
      ${canSee('sessions') ? `<a class="h-live-link" href="${canSee('director') ? '#directors/sessions' : '#admin/sessions'}">Session details</a>` : ''}</div>
    <div class="h-live-grid">
      <div class="h-panel"><span class="h-plabel">JOIN CODE</span><strong class="h-big">${esc(live.join_code || s.code || joinCode)}</strong>
        <button class="h-white" id="h-copy">Copy code</button></div>
      ${canSee('staff') ? `<div class="h-panel"><span class="h-plabel">${me ? 'YOUR SHIFT · ' + esc(me.department).toUpperCase() : 'YOUR SHIFT'}</span>
        ${me ? `<strong class="h-big" data-tick="live-clock">${clock(shiftSecs(me))}</strong>
          <div class="h-row"><button class="h-glassbtn" id="h-break">${me.status === 'break' ? 'End break' : 'Take a break'}</button><button class="h-teal" id="h-end">End shift</button></div>`
        : myDepartments.length ? `<strong class="h-big muted-w">Off shift</strong><div class="h-row">${homeDeptPicker()}<button class="h-teal" id="h-start">Start shift</button></div>`
        : '<span class="h-small">You need a department role to start a shift.</span>'}</div>` : ''}
      ${on.total != null ? `<div class="h-panel"><span class="h-plabel">ON SHIFT NOW</span>
        <div class="h-row"><strong class="h-big">${n0(on.total)}</strong><span class="h-faces">${(on.people || []).slice(0, 4).map((p) => `<span class="h-face" title="${esc(p.name)}" style="${p.avatar_url ? `background-image:url('${esc(sized(p.avatar_url, 64))}')` : ''}">${p.avatar_url ? '' : esc((cleanName(p.name || '?')[0] || '?').toUpperCase())}</span>`).join('')}${n0(on.total) > 4 ? `<span>+${n0(on.total) - 4}</span>` : ''}</span></div>
        <span class="h-small">${esc(byDept || 'Nobody yet')}${n0(on.on_break) ? ` · ${n0(on.on_break)} on a break` : ''}</span></div>` : ''}
    </div></section>`;
  el.querySelector('#h-copy').onclick = async (e) => { try { await navigator.clipboard.writeText(live.join_code || s.code || joinCode); e.target.textContent = 'Copied'; } catch { /* on screen */ } };
  wireHomeShift(el);
}
// Department picker + busy buttons for the home shift controls (Bravo, matches the 0.15.1 Shifts page).
// One department: no picker, just "Start shift". Several: a chip per department, the first picked.
function homeDeptPicker() {
  if (myDepartments.length < 2) return '';
  return `<div class="h-pick" role="radiogroup" aria-label="Department">${myDepartments.map((d, i) => `<button type="button" role="radio" aria-checked="${i === 0}" class="h-opt${i === 0 ? ' on' : ''}" data-dept="${esc(d)}" style="--dept:${(DEPARTMENTS.find((x) => x.name === d) || {}).color || '#3a82d0'}"><span class="h-sw" aria-hidden="true"></span>${esc(d)}</button>`).join('')}</div>`;
}
function wireHomeShift(el) {
  el.querySelectorAll('.h-opt').forEach((b) => b.addEventListener('click', () => {
    el.querySelectorAll('.h-opt').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', x === b); });
  }));
  const act = async (btn, fn, args, busy) => {
    const all = el.querySelectorAll('#h-start, #h-break, #h-end');
    all.forEach((b) => { b.disabled = true; });
    const was = btn.textContent;
    btn.textContent = busy;
    const { error } = await sb.rpc(fn, args || {});
    if (error) { all.forEach((b) => { b.disabled = false; }); btn.textContent = was; alert(error.message); return; }
    renderHome();
  };
  const brk = el.querySelector('#h-break'), end = el.querySelector('#h-end'), start = el.querySelector('#h-start');
  brk?.addEventListener('click', () => act(brk, 'shift_break', null, 'Saving…'));
  end?.addEventListener('click', () => { if (confirm('End your shift?')) act(end, 'shift_end', null, 'Ending…'); });
  start?.addEventListener('click', () => act(start, 'shift_start',
    { department: el.querySelector('.h-opt.on')?.dataset.dept || myDepartments[0] }, 'Starting…'));
}
// No session running (0.14.6): a quiet light bar in the same place, so your shift and the session are always one
// glance away. The bold Session active block above takes over while a session is live.
function drawIdle(el, h, s) {
  const me = h.my_shift, staff = canSee('staff');
  const code = s.code || joinCode;
  const sessText = s.next ? `Next session ${esc(whenAhead(s.next.scheduled_for))}${s.next.host_name ? ' with ' + esc(s.next.host_name) : ''}` : 'No session running';
  const sessHref = canSee('sessions') ? (canSee('director') ? '#directors/sessions' : '#admin/sessions') : '';
  const shiftPart = !staff ? '' : me
    ? `<div class="h-idle-part"><span class="h-plabel-d">YOUR SHIFT \u00b7 ${esc(me.department).toUpperCase()}</span>
        <div class="h-row"><strong class="h-idle-clock" data-tick="live-clock">${clock(shiftSecs(me))}</strong>
        <button class="ghost small-btn" id="h-break">${me.status === 'break' ? 'End break' : 'Take a break'}</button><button class="refresh small-btn" id="h-end">End shift</button></div></div>`
    : myDepartments.length
      ? `<div class="h-idle-part"><span class="h-plabel-d">YOUR SHIFT</span><div class="h-row"><span class="h-idle-off">Off shift</span>
          ${homeDeptPicker()}<button class="refresh small-btn" id="h-start">Start shift</button></div></div>`
      : '';
  el.innerHTML = `<section class="h-idle" aria-label="Session and shift">
      <div class="h-idle-part"><span class="h-plabel-d"><span class="h-idle-dot${s.next ? ' next' : ''}"></span>SESSION</span>
        <div class="h-row"><span class="h-idle-sess">${sessText}</span><span class="h-idle-code">Join code <strong>${esc(code)}</strong></span>
        ${sessHref ? `<a class="ghost small-btn h-idle-link" href="${sessHref}">${s.next ? 'Sessions' : 'Start a session'}</a>` : ''}</div></div>
      ${shiftPart}
    </section>`;
  wireHomeShift(el);
}
function tickHome() {
  clearInterval(homeTimer);
  homeTimer = setInterval(() => {
    const box = $('home');
    if (box.hidden) return;
    const me = HC && HC.my_shift, s = (HC && HC.session) || currentSession;
    const set = (k, v) => box.querySelectorAll(`[data-tick="${k}"]`).forEach((el) => { if (el.textContent !== v) el.textContent = v; });
    if (me) { set('live-clock', clock(shiftSecs(me))); set('pin-clock', clock(shiftSecs(me))); set('shift-line', `You’re on: ${hrs(shiftSecs(me))}`); }
    if (s && s.live && s.live.started_at) set('sess-len', hrs((Date.now() - new Date(s.live.started_at)) / 1000));
  }, 1000);
}

// ---------- smart suggestions ----------
function drawSuggestions(tools) {
  const h = HC || {}, has = (k) => tools.find((t) => t.key === k), out = [];
  const s = h.session || currentSession || {};
  if (n0(h.failed_mine)) out.push({ cls: 'bad', text: `${plural(n0(h.failed_mine), 'action')} didn’t go through: see why`, href: '#admin/cases' });
  if (h.my_shift) out.push({ cls: 'teal', text: `End shift · ${hrs(shiftSecs(h.my_shift))} so far`, run: async () => { if (confirm('End your shift?')) { const { error } = await sb.rpc('shift_end'); if (error) alert(error.message); renderHome(); } } });
  const appsTool = has('admin/applications') || has('review');
  if (n0(h.apps_waiting) && appsTool) out.push({ cls: 'warm', text: `Review ${plural(n0(h.apps_waiting), 'application')}`, href: appsTool.href });
  const tk = has('admin/tickets') || has('tickets');
  if (n0(h.tickets_open) && tk) out.push({ text: h.tickets_latest && h.tickets_latest.name ? `Reply to ${cleanName(h.tickets_latest.name)}’s ticket` : `${plural(n0(h.tickets_open), 'open ticket')}`, href: tk.href });
  if (s.live) out.push({ text: `Copy join code ${s.live.join_code || s.code || joinCode}`, run: async (b) => { try { await navigator.clipboard.writeText(s.live.join_code || s.code || joinCode); b.textContent = 'Copied'; } catch { /* on screen */ } } });
  else if (canSee('sessions') && !s.next) out.push({ text: 'Schedule a session', href: canSee('director') ? '#directors/sessions' : '#admin/sessions' });
  if (!h.my_shift && myDepartments.length && canSee('staff')) out.push({ text: `Start my shift in ${myDepartments[0]}`, run: async () => { const { error } = await sb.rpc('shift_start', { department: myDepartments[0] }); if (error) alert(error.message); renderHome(); } });
  const last = has('admin/records') && lastRecord();
  if (last) out.push({ text: `Open ${last.name}’s record`, run: () => openRecord(last.id) });
  const list = out.slice(0, 4);
  const el = $('h-sugg');
  el.innerHTML = list.map((x, i) => x.href ? `<a class="h-chip ${x.cls || ''}" href="${x.href}">${esc(x.text)}</a>` : `<button type="button" class="h-chip ${x.cls || ''}" data-i="${i}">${esc(x.text)}</button>`).join('');
  el.querySelectorAll('button[data-i]').forEach((b) => { b.onclick = () => list[+b.dataset.i].run(b); });
}

// ---------- search ----------
let pendingRecord = null, pendingCase = null;
// Open someone's record. If we're already on Records, redraw now; otherwise the hash change does it (once).
// (0.14.1: calling route() right after setting the hash ran it twice: the first run used up pendingRecord and the
// hashchange run then showed the empty Records page.)
function openRecord(id) {
  pendingRecord = id;
  if (location.hash === '#admin/records') route(); else location.hash = '#admin/records';
}
function startCase(action, person) { pendingCase = { action, person }; if (location.hash === '#admin/cases') route(); else location.hash = '#admin/cases'; }
function searchActions() {
  const a = [], h = HC || {};
  if (canSee('staff') && myDepartments.length) {
    if (h.my_shift) a.push({ title: 'End my shift', words: 'end shift clock out', run: async () => { if (confirm('End your shift?')) { await sb.rpc('shift_end'); renderHome(); } } },
      { title: h.my_shift.status === 'break' ? 'End my break' : 'Take a break', words: 'break pause', run: async () => { await sb.rpc('shift_break'); renderHome(); } });
    else for (const d of myDepartments) a.push({ title: 'Start my shift', sub: 'in ' + d, words: 'start shift clock in on duty ' + d, run: async () => { const { error } = await sb.rpc('shift_start', { department: d }); if (error) alert(error.message); renderHome(); } });
  }
  if (canSee('sessions')) {
    const href = canSee('director') ? '#directors/sessions' : '#admin/sessions';
    a.push({ title: 'Start a session now', words: 'session start host maple', href }, { title: 'Schedule a session', sub: 'for Maple Hospital', words: 'session schedule plan', href });
  }
  if (canSee('admin')) a.push({ title: 'New mod action', words: 'warn timeout kick ban unban punish', href: '#admin/cases' });
  if (canSee('exec')) a.push({ title: 'Change the join code', sub: 'Bot settings', words: 'join code maple settings', href: '#exec/settings' });
  a.push({ title: 'Contact a team', words: 'help support ticket', href: '#contact' });
  return a;
}
const matchScore = (text, q) => { const t = text.toLowerCase(); if (t.startsWith(q)) return 3; if (t.split(/\s+/).some((w) => w.startsWith(q))) return 2; return t.includes(q) ? 1 : 0; };

function wireSearch() {
  const q = $('h-q'), res = $('h-results');
  let items = [], active = 0, timer = null, seq = 0;
  const go = (it) => { close(); if (it.run) it.run(); else if (it.href) location.hash = it.href; };
  const close = () => { res.hidden = true; q.setAttribute('aria-expanded', 'false'); };
  const draw = (people) => {
    const term = q.value.trim().toLowerCase();
    if (!term) { close(); return; }
    const tools = myTools().map((t) => ({ t, s: Math.max(matchScore(t.def.title, term), matchScore(SEARCH_WORDS[t.key] || '', term) && 1, matchScore(FOLDERS.find((f) => f.id === t.folder).title, term) && 1) }))
      .filter((x) => x.s).sort((a, b) => b.s - a.s).slice(0, 5).map((x) => ({ kind: 'tool', title: x.t.def.title, sub: FOLDERS.find((f) => f.id === x.t.folder).title, href: x.t.href, grad: toolGrad(x.t) }));
    const acts = searchActions().map((x) => ({ x, s: Math.max(matchScore(x.title, term), matchScore(x.words || '', term) && 1) })).filter((y) => y.s)
      .sort((a, b) => b.s - a.s).slice(0, 4).map((y) => ({ kind: 'act', ...y.x }));
    const ppl = (people || []).map((p) => ({ kind: 'person', p }));
    items = [...ppl, ...acts, ...tools];
    active = Math.min(active, Math.max(items.length - 1, 0));
    let idx = -1;
    const row = (it) => {
      idx++;
      const on = idx === active ? ' on' : '';
      if (it.kind === 'person') {
        const p = it.p;
        return `<button type="button" role="option" class="hs-row hs-person${on}" data-i="${idx}" aria-selected="${!!on}">
          <img class="avatar" src="${esc(sized(p.avatar_url || '', 64))}" alt="" onerror="this.style.visibility='hidden'">
          <span class="hs-main"><strong>${esc(cleanName(p.display_name || p.username || p.discord_id))}</strong>
          <span class="muted">${p.username ? '@' + esc(p.username) : ''}${p.summary ? ' · ' + esc(p.summary) : ''}${p.on_shift ? ' · on shift' : ''}${p.warnings ? ' · ' + plural(p.warnings, 'warning') : ''}</span></span>
          ${on ? `<span class="hs-hint">Enter to open</span>` : ''}</button>
          ${canSee('admin') ? `<div class="hs-acts"><button type="button" data-case="warn" data-p="${idx}">Warn</button><button type="button" data-case="timeout" data-p="${idx}">Time out</button><button type="button" data-rec="${idx}">Record</button></div>` : ''}`;
      }
      if (it.kind === 'act') return `<button type="button" role="option" class="hs-row${on}" data-i="${idx}" aria-selected="${!!on}"><span class="hs-arrow" aria-hidden="true"></span><span class="hs-main one"><strong>${esc(it.title)}</strong>${it.sub ? ` <span class="muted">${esc(it.sub)}</span>` : ''}</span></button>`;
      return `<button type="button" role="option" class="hs-row${on}" data-i="${idx}" aria-selected="${!!on}"><span class="hs-sw" style="background:${it.grad}" aria-hidden="true"></span><span class="hs-main one"><strong>${esc(it.title)}</strong> <span class="muted">· ${esc(it.sub)}</span></span></button>`;
    };
    const group = (label, list) => (list.length ? `<span class="hs-label">${label}</span>${list.map(row).join('')}` : '');
    res.innerHTML = (group('People', items.filter((i) => i.kind === 'person')) + group('Do something', items.filter((i) => i.kind === 'act')) + group('Tools', items.filter((i) => i.kind === 'tool')))
      || `<p class="muted small hs-empty">Nothing matches “${esc(q.value.trim())}”.</p>`;
    res.insertAdjacentHTML('beforeend', '<div class="hs-keys"><span>↑ ↓ to move</span><span>Enter to open</span><span>Press / anywhere to search</span></div>');
    res.hidden = false;
    q.setAttribute('aria-expanded', 'true');
  };
  const personOpen = (p) => { if (canSee('admin')) { rememberRecord(p.discord_id, cleanName(p.display_name || p.username || p.discord_id)); openRecord(p.discord_id); } else location.hash = '#roster'; };
  let people = [];
  q.oninput = () => {
    clearTimeout(timer); active = 0;
    const term = q.value.trim();
    draw(term.length >= 2 ? people.filter((p) => (p.display_name || '').toLowerCase().includes(term.toLowerCase())) : []);
    if (term.length < 2 || !canSee('staff')) { people = []; return; }
    const my = ++seq;
    timer = setTimeout(async () => {
      let { data, error } = await sb.rpc('people_search', { q: term });
      if (error && canSee('admin')) ({ data, error } = await sb.rpc('mod_member_search', { q: term }));
      if (my !== seq) return;
      people = error ? [] : (data || []).slice(0, 6);
      draw(people);
    }, 180);
  };
  q.onkeydown = (e) => {
    if (res.hidden || !items.length) { if (e.key === 'Escape') q.blur(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; draw(people); }
    else if (e.key === 'Enter') { e.preventDefault(); const it = items[active]; if (it.kind === 'person') { close(); personOpen(it.p); } else go(it); }
    else if (e.key === 'Escape') { close(); }
  };
  q.onfocus = () => { if (q.value.trim()) draw(people); };
  res.onclick = (e) => {
    const c = e.target.closest('[data-case]'), r = e.target.closest('[data-rec]'), b = e.target.closest('[data-i]');
    if (c) { close(); startCase(c.dataset.case, items[+c.dataset.p].p); return; }
    if (r) { close(); personOpen(items[+r.dataset.rec].p); return; }
    if (b) { const it = items[+b.dataset.i]; if (it.kind === 'person') { close(); personOpen(it.p); } else go(it); }
  };
  document.addEventListener('click', (e) => { if (!e.target.closest('#h-search')) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !$('home').hidden && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) { e.preventDefault(); q.focus(); }
  });
}

// ---------- folder pages (#f/<id>) ----------
async function renderFolder(body, f) {
  const tools = myTools().filter((t) => t.folder === f.id);
  const h = HC || {};
  const l = h.logs_today || {};
  const stats = {
    moderation: [canSee('admin') && ['Actions this week', n0(h.actions_week)], canSee('admin') && ['Active warnings', n0(h.active_warnings)], ['Open tickets', n0(h.tickets_open)], canSee('admin') && ['Deleted messages today', n0(l.deleted)]],
    people: [['Members', n0(h.members_total)], ['Applications waiting', n0(h.apps_waiting)], h.on_shift && ['On shift now', n0(h.on_shift.total)]],
    operations: [h.on_shift && ['On shift now', n0(h.on_shift.total)], ['Your hours this week', hrs(n0(h.my_week_hours) * 3600)], canSee('exec') && ['Hospital hours this week', n0(h.hospital_hours_week).toFixed(1)]],
    help: [],
  }[f.id].filter(Boolean);
  const depts = tools.filter((t) => t.def.layout === 'dept'), rest = tools.filter((t) => t.def.layout !== 'dept');
  body.innerHTML = `
    <div class="fp-head">
      <span class="h-fico big" style="--g1:${f.g[0]};--g2:${f.g[1]};--icon:${iconUrl(f.icon)}" aria-hidden="true"></span>
      <div class="fp-title"><h1>${f.title}</h1><span class="muted">${f.blurb}</span></div>
      ${f.id === 'moderation' && canSee('admin') ? `<div class="fp-quick"><button class="ghost" data-q="warn">Warn</button><button class="ghost" data-q="timeout">Time out</button><button class="ghost" data-q="kick">Kick</button><button class="refresh" data-q="new">New action</button></div>` : ''}
    </div>
    ${stats.length ? `<div class="fp-stats">${stats.map(([k, v]) => `<div class="card tight stat"><span class="muted small-meta">${k}</span><strong>${v}</strong></div>`).join('')}</div>` : ''}
    <div class="fp-cards">${rest.map((t) => cardHtml(t, true)).join('')}</div>
    ${depts.length ? `<h2 class="h-label">Departments</h2><div class="fp-cards four">${depts.map((t) => cardHtml(t, true)).join('')}</div>` : ''}
    ${f.id === 'moderation' && canSee('admin') ? '<h2 class="h-label">Latest actions</h2><div class="card" id="fp-latest"><p class="muted small">Loading…</p></div>' : ''}`;
  body.querySelectorAll('[data-q]').forEach((b) => { b.onclick = () => startCase(b.dataset.q, null); });
  if (!HC) { await loadHomeData(); if (body.isConnected) renderFolder(body, f); return; }
  const latest = body.querySelector('#fp-latest');
  if (latest) {
    const { data } = await sb.from('mod_cases').select('*').neq('status', 'failed').is('revoked_at', null).neq('source', 'in_game').order('created_at', { ascending: false }).limit(5);
    latest.innerHTML = (data || []).length ? data.map((c) => `<div class="row-item case"><span class="act act-${esc(c.action)}">${esc(ACTION_LABEL[c.action] || c.action)}</span>
      <div class="case-main"><strong>${esc(c.target_name || '')}</strong><span class="muted small-meta">${esc(c.reason)} · ${when(c.created_at)}</span></div></div>`).join('') : '<p class="muted small">No actions yet.</p>';
  }
}
