// Patient pages (Alpha, CBH Chart rebuild): online check-in and the private visit page, with NO account.
//   #visit          the check-in form (or the right "closed / paused" screen)
//   #visit/<token>  the private visit page: live status, then the discharge papers and one rating
// The token is in the URL fragment (never sent to a server) and kept in this browser (localStorage) so the patient
// can come back. Everything goes through Bravo's five anon RPCs (BACKEND-PLAN §4.7): chart_public_status,
// chart_checkin_anon, chart_visit, chart_visit_rate, chart_visit_cancel (shapes: chart/CONTRACT.md §6). Refusals come
// back as {ok:false, refused, message, hospital}, not as errors. The page shows over everything, logged in or
// out, and never touches app.js routing. Launch flag: CBH_CONFIG.patientCheckinLive (false = "Launching soon").
(() => {
  const CFG = window.CBH_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const host = $('visit-page'); if (!host) return;
  const e = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = { get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: the link still works */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* fine */ } } };
  const KEY = 'cbh-visit', CLIENT = 'cbh-visit-client';
  const clientKey = () => { let k = store.get(CLIENT); if (!k) { const b = new Uint8Array(16); crypto.getRandomValues(b);
    k = btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); store.set(CLIENT, k); } return k; };

  // ---- the five anon RPCs (argument names in one place, to match Bravo's contract) ----
  const rpc = async (fn, args) => { const { data, error } = await sb.rpc(fn, args || {}); if (error) throw new Error(error.message || 'Something went wrong. Try again.'); return data; };
  const API = {
    status: () => rpc('chart_public_status'),
    // Fields agreed with Bravo (20 Nov): roleplay name, age, symptoms, pain 1-10, and the optional details.
    checkin: (f) => rpc('chart_checkin_anon', { p_roblox_username: f.user, p_name: f.name, p_age: f.age, p_symptoms: f.symptoms, p_pain: f.pain,
      p_onset: f.onset || null, p_allergies: f.allergies || null, p_history: f.history || null, p_notes: f.notes || null, p_client_key: clientKey() }),
    visit: (token) => rpc('chart_visit', { p_token: token }),
    rate: (token, rating, comment) => rpc('chart_visit_rate', { p_token: token, p_rating: rating, p_comment: comment || null }),
    cancel: (token) => rpc('chart_visit_cancel', { p_token: token }),
  };

  // ---- words (patient view; professional but plain, FLOW-AUDIT §4) ----
  const OUTCOME = { home: 'Discharged home', follow_up: 'Discharged with follow-up', admitted: 'Admitted', transferred: 'Transferred',
    lbbs: 'Left before being seen', left_before_seen: 'Left before being seen', ama: 'Left against medical advice', left: 'Left against medical advice',
    deceased: 'Your visit has ended', died: 'Your visit has ended', session_ended: 'Closed at the end of the session', ended: 'Closed at the end of the session' };
  const nth = (n) => n + (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th');
  const when = (iso) => { if (!iso) return ''; const d = new Date(iso);
    return d.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); };
  const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '');
  const ROBLOX = /^(?=.{3,20}$)[A-Za-z0-9]+(_[A-Za-z0-9]+)?$/;   // Roblox's rule: letters, digits, one inner underscore

  // ---- shared blocks ----
  const discordUrl = () => CFG.discordInvite || 'https://discord.gg/xxqTP4shRA';
  const joinBlock = (h) => { const code = (h && h.join_code) || CFG.publicJoinCode || '';
    if (!code) return '';
    const url = typeof robloxJoinUrl === 'function' ? robloxJoinUrl(code) : 'https://www.roblox.com/games/8704997000/Maple-Hospital';
    return `<div class="vp-join"><a class="vp-btn vp-teal" href="${e(url)}" target="_blank" rel="noopener">Join game</a>
      <div class="vp-code"><span>Or type the join code in Maple Hospital</span><b>${e(code)}</b><button type="button" class="vp-btn vp-ghost vp-sm" data-vcopy="${e(code)}">Copy</button></div></div>`; };
  const discordBtn = (label = 'Join our Discord') => `<a class="vp-btn vp-discord" href="${e(discordUrl())}" target="_blank" rel="noopener">${label}</a>`;
  const shell = (inner, wide) => `<div class="vp-wrap${wide ? ' wide' : ''}"><a class="vp-back" href="#">CareBeyond Hospital</a>${inner}</div>`;
  const state = (title, body, extra = '', icon = '') => `<section class="vp-card vp-state">${icon.startsWith('place:') ? `<span class="vp-place" aria-hidden="true">${nth(+icon.slice(6))}</span>` : icon ? `<span class="vp-ic ${icon}" aria-hidden="true"></span>` : ''}<h1>${title}</h1>${body ? `<p>${body}</p>` : ''}${extra}</section>`;
  const errBox = (m) => (m ? `<p class="vp-err" role="alert">${e(m)}</p>` : '');

  // ---- check-in form ----
  // The form is drawn ONCE per screen. Typing never redraws it: warnings, the tag list, the Roblox card, the pain
  // scale and the button state are updated in place (user, 20 Nov: the box lost focus and took one letter at a time).
  const F = { user: '', name: '', age: '', tags: [], pain: null, onset: null, allergies: '', history: '', notes: '', busy: false, err: '',
    rbx: { state: 'idle', for: '', data: null, ok: false } };   // idle | looking | found | missing | off ; ok = they said "Yes, that's me"
  let H = null, formShown = '';   // the latest hospital block; which form screen is on the page
  const ONSET = [['just_now', 'Just now'], ['today', 'Today'], ['days', 'A few days'], ['longer', 'Longer']];
  const PAIN_HUE = [140, 118, 96, 72, 52, 42, 32, 22, 10, 0];   // 1 green → yellow → orange → 10 red
  const painCol = (n) => `hsl(${PAIN_HUE[n - 1]} 78% ${n >= 4 && n <= 6 ? 46 : 44}%)`;
  const painWord = (n) => (n <= 3 ? 'Mild' : n <= 6 ? 'Moderate' : 'Severe');
  const formScreen = () => (!CFG.patientCheckinLive ? 'soon' : !H ? 'loading' : H.state === 'closed' ? 'closed' : H.state === 'walk_ins_only' ? 'walk' : 'open');
  function formView() {
    const scr = formScreen();
    if (scr === 'soon') return state('Online check-in is launching soon', 'Soon you’ll be able to check in before you arrive, with no account: just your Roblox username. Until then, walk in and check in at reception in game.', `${joinBlock(H)}${discordBtn('Join our Discord to hear first')}`, 'soon');
    if (scr === 'loading') return `<section class="vp-card"><p class="vp-muted">Loading…</p></section>`;
    if (scr === 'closed') return state('Online check-in is closed', `No staff are on shift right now.${H.next_session_at ? ` Next session: <b>${e(when(H.next_session_at))}</b>.` : ''}`, `${discordBtn()}<p class="vp-muted vp-sm-t">See when the next sessions are.</p>`, 'closed');
    if (scr === 'walk') return state('Online check-in is paused', 'The front desk is busy. Please check in at reception in game.', joinBlock(H), 'paused');
    return `<section class="vp-card vp-form"><h1>Check in</h1><p class="vp-sub" id="vp-sub">${subLine()}</p>
      <label class="vp-f"><span>Your Roblox username</span><input id="vp-user" value="${e(F.user)}" placeholder="Exactly as it shows above your head" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="20">
        <small class="vp-bad" id="vp-user-bad" hidden>3 to 20 letters or numbers, with at most one underscore in the middle.</small></label>
      <div id="vp-rbx" class="vp-rbx" aria-live="polite" hidden></div>
      <div class="vp-row2"><label class="vp-f"><span>Roleplay name</span><input id="vp-name" value="${e(F.name)}" placeholder="Your character, e.g. Anna Smith" autocomplete="off" maxlength="40"></label>
        <label class="vp-f vp-age"><span>Age</span><input id="vp-age" type="number" inputmode="numeric" min="1" max="120" value="${e(F.age)}" placeholder="e.g. 25"></label></div>
      <small class="vp-hint" id="vp-age-hint" hidden>Under 18: you'll be seen in our Paediatric rooms.</small>
      <div class="vp-f"><span>Symptoms <em>type each one, then Add</em></span><div class="vp-tags" id="vp-tags"></div>
        <div class="vp-row"><input id="vp-sym" placeholder="e.g. headache" autocomplete="off" maxlength="80" enterkeyhint="done"><button type="button" class="vp-btn vp-ghost" data-va="symadd">Add</button></div></div>
      <div class="vp-f"><span id="vp-pain-l">Pain <em id="vp-pain-w"></em></span>
        <div class="vp-pain" role="radiogroup" aria-labelledby="vp-pain-l">${Array.from({ length: 10 }, (_, i) => i + 1).map((n) => `<button type="button" role="radio" aria-checked="false" aria-label="Pain ${n} of 10${n === 1 ? ', no pain' : n === 10 ? ', worst pain' : ''}" data-vpain="${n}" style="--pc:${painCol(n)}">${n}</button>`).join('')}</div>
        <div class="vp-pain-ends"><span>1 No pain</span><span>10 Worst pain</span></div></div>
      <details class="vp-more"${F.onset || F.allergies || F.history || F.notes ? ' open' : ''}><summary>More details <em>optional</em></summary>
        <div class="vp-f"><span>When did it start?</span><div class="vp-chips four" role="radiogroup" aria-label="When did it start?">${ONSET.map(([k, l]) => `<button type="button" role="radio" aria-checked="false" class="vp-chip" data-vonset="${k}">${l}</button>`).join('')}</div></div>
        <label class="vp-f"><span>Allergies</span><input id="vp-allergies" value="${e(F.allergies)}" placeholder="e.g. penicillin, or none" autocomplete="off" maxlength="200"></label>
        <label class="vp-f"><span>Any medical history</span><input id="vp-history" value="${e(F.history)}" placeholder="e.g. asthma" autocomplete="off" maxlength="300"></label>
        <label class="vp-f"><span>Notes or care needs</span><textarea id="vp-notes" rows="2" maxlength="300" placeholder="e.g. uses a wheelchair, needs a translator, anxious about needles">${e(F.notes)}</textarea></label></details>
      <p class="vp-note">This is roleplay. Don't share real health or personal information.</p><p class="vp-err" id="vp-err" role="alert" hidden></p>
      <button type="button" class="vp-btn vp-primary vp-big" data-va="go" id="vp-go" disabled>Check in</button></section>`;
  }
  const subLine = () => `CareBeyond Hospital · staff are on shift · no account needed${H && H.wait_hint != null ? ` · about ${e(H.wait_hint)} min wait` : ''}`;
  const ageOk = () => { const a = +F.age; return F.age !== '' && Number.isInteger(a) && a >= 1 && a <= 120; };
  const formOk = () => ROBLOX.test(F.user.trim()) && F.name.trim().length >= 2 && ageOk() && F.tags.length && F.pain && !F.busy;
  // Update everything that changes while someone types, in place.
  function syncForm() {
    if (!$('vp-go')) return;
    const u = F.user.trim();
    $('vp-user-bad').hidden = !u || ROBLOX.test(u) || document.activeElement === $('vp-user');   // warn after they leave the box
    $('vp-age-hint').hidden = !(ageOk() && +F.age < 18);
    $('vp-tags').innerHTML = F.tags.map((t, i) => `<span class="vp-tag">${e(t)}<button type="button" data-vtagrm="${i}" aria-label="Remove ${e(t)}">×</button></span>`).join('');
    host.querySelectorAll('[data-vpain]').forEach((b) => { const on = +b.dataset.vpain === F.pain; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
    $('vp-pain-w').textContent = F.pain ? `${F.pain} of 10 · ${painWord(F.pain)}` : 'tap a number';
    host.querySelectorAll('[data-vonset]').forEach((b) => { const on = b.dataset.vonset === F.onset; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
    $('vp-err').hidden = !F.err; $('vp-err').textContent = F.err;
    $('vp-go').disabled = !formOk(); $('vp-go').textContent = F.busy ? 'Checking in…' : 'Check in';
    rbxCard();
  }
  // "Is this you?": the Roblox avatar for the username, so a typo is caught before staff look for the wrong person.
  // An anon-safe lookup (Bravo's roblox-lookup Edge Function). If it's missing or down, the form just carries on.
  let rbxT = null;
  const lookupSoon = (now) => { clearTimeout(rbxT); const u = F.user.trim();
    if (!ROBLOX.test(u) || F.rbx.state === 'off') { if (F.rbx.for !== u) F.rbx = { ...F.rbx, state: F.rbx.state === 'off' ? 'off' : 'idle', for: '', data: null, ok: false }; rbxCard(); return; }
    if (F.rbx.for.toLowerCase() === u.toLowerCase() && F.rbx.state !== 'idle') return;
    rbxT = setTimeout(lookup, now ? 0 : 700); };
  async function lookup() {
    const u = F.user.trim(); F.rbx = { state: 'looking', for: u, data: null, ok: false }; rbxCard();
    try {
      const r = await fetch(`${CFG.supabaseUrl}/functions/v1/roblox-lookup`, { method: 'POST', headers: { 'content-type': 'application/json', apikey: CFG.supabaseKey }, body: JSON.stringify({ username: u }) });
      if (F.user.trim() !== u) return;   // they kept typing
      if (!r.ok) { F.rbx = { state: r.status === 404 || r.status >= 500 ? 'off' : 'idle', for: u, data: null, ok: false }; rbxCard(); return; }
      const j = await r.json();
      F.rbx = j && j.found ? { state: 'found', for: u, data: j, ok: false } : { state: 'missing', for: u, data: null, ok: false };
    } catch { F.rbx = { state: 'off', for: u, data: null, ok: false }; }
    rbxCard();
  }
  function rbxCard() {
    const box = $('vp-rbx'); if (!box) return; const x = F.rbx, d = x.data;
    const html = x.state === 'looking' ? '<span class="vp-muted">Looking you up on Roblox…</span>'
      : x.state === 'missing' ? '<span class="vp-bad">We couldn’t find that Roblox user. Check the spelling.</span>'
      : x.state === 'found' && x.ok ? `<span class="vp-rbx-ok">${d.headshot_url ? `<img src="${e(d.headshot_url)}" alt="" width="28" height="28">` : ''}<b>${e(d.display_name || d.name)}</b><span>@${e(d.name)}</span><button type="button" class="vp-link-btn" data-va="rbxno">Change</button></span>`
      : x.state === 'found' ? `<div class="vp-rbx-ask">${d.headshot_url ? `<img src="${e(d.headshot_url)}" alt="" width="56" height="56">` : '<span class="vp-rbx-ph" aria-hidden="true"></span>'}<div><b>Is this you?</b><span>${e(d.display_name || d.name)} · @${e(d.name)}</span></div>
          <div class="vp-rbx-btns"><button type="button" class="vp-btn vp-primary vp-sm" data-va="rbxyes">Yes, that's me</button><button type="button" class="vp-btn vp-ghost vp-sm" data-va="rbxno">No, change it</button></div></div>` : '';
    if (box.dataset.html !== html) { box.innerHTML = html; box.dataset.html = html; }
    box.hidden = !html;
  }
  async function submit() {
    const sym = $('vp-sym'); if (sym && sym.value.trim()) { addTag(sym.value); sym.value = ''; }
    if (!formOk()) { syncForm(); return; }
    F.busy = true; F.err = ''; syncForm();
    try {
      const r = await API.checkin({ user: F.user.trim(), name: F.name.trim(), age: +F.age, symptoms: F.tags.join(', ').slice(0, 300), pain: F.pain,
        onset: F.onset, allergies: F.allergies.trim(), history: F.history.trim(), notes: F.notes.trim() });
      if (r && r.hospital) H = r.hospital;
      if (!r || !r.ok || !r.token) { F.busy = false;
        if (r && (r.refused === 'closed' || r.refused === 'walk_ins_only')) { F.err = ''; formShown = ''; draw(); return; }
        F.err = (r && r.message) || 'Online check-in isn’t available right now. Please check in at reception in game.'; syncForm(); return; }
      store.set(KEY, { token: r.token, at: Date.now() });
      Object.assign(F, { user: '', name: '', age: '', tags: [], pain: null, onset: null, allergies: '', history: '', notes: '', busy: false, rbx: { state: 'idle', for: '', data: null, ok: false } });
      location.hash = '#visit/' + r.token;
    } catch (err) { F.busy = false; F.err = err.message; syncForm(); }
  }
  const addTag = (v) => { v = String(v || '').replace(/[\u0000-\u001f]/g, '').trim(); if (!v || F.tags.length >= 8) return;
    if (/https?:|www\.|discord\.gg/i.test(v)) { F.err = 'Please don’t add links.'; return; } F.err = ''; F.tags.push(v.slice(0, 80)); };

  // ---- the visit page ----
  let V = null, vErr = '', vTok = '', rate = { stars: 0, comment: '', busy: false }, copied = false;
  function visitView() {
    const linkBox = `<div class="vp-link"><b>Your visit</b><span>Keep this page open, or bookmark it, to follow your visit. It's private: only people with this link can see it.</span>
      <button type="button" class="vp-btn vp-ghost vp-sm" data-va="copylink">${copied ? 'Link copied' : 'Copy link'}</button></div>`;
    if (vErr) return state('We couldn’t load your visit', e(vErr), '<button type="button" class="vp-btn vp-primary" data-va="retry">Try again</button>');
    if (!V) return `<section class="vp-card"><p class="vp-muted">Loading your visit…</p></section>`;
    if (!V.ok || !V.visit) return state('This visit has ended or the link is wrong', 'If you still need care, check in again.', `<button type="button" class="vp-btn vp-primary" data-va="again">Check in again</button>`, 'ended');
    const v = V.visit, h = V.hospital || H, who = v.carer || 'Your nurse';
    let body;
    if (v.state === 'checked_in') body = state('You’re checked in', 'The front desk will confirm you in a moment.', `<p class="vp-do">Go to <b>the Waiting Room</b> in game.</p>${joinBlock(h)}${cancelBtn()}`, 'ok');
    else if (v.state === 'waiting' || v.state === 'waiting_in_room') body = state(`You’re ${nth(v.place || 1)} in line`, v.room ? `Please stay in <b>${e(roomName(v.room))}</b>. Someone will be with you soon.` : `Wait in <b>the Waiting Room</b>. We'll show you here when someone is ready.${v.wait_hint != null ? ` About ${e(v.wait_hint)} min.` : ''}`, `${joinBlock(h)}${cancelBtn()}`, 'place:' + (v.place || 1));
    else if (v.state === 'assigned') body = state('You’re next', `A nurse is getting ready for you. Stay in <b>${e(roomName(v.room) || 'the Waiting Room')}</b>.`, '', 'next');
    else if (v.state === 'called') body = state(`${e(who)} is ready for you`, '', `<p class="vp-do big">Go to <b>${e(roomName(v.room) || 'the front desk')}</b> now.</p>`, 'go');
    else if (v.state === 'in_care') body = state('In treatment', `${e(who)} is looking after you${v.room ? ` in <b>${e(roomName(v.room))}</b>` : ''}.`, '', 'care');
    else if (v.state === 'discharged') body = papersView(v);
    else body = closedView(v);
    return `${linkBox}${body}`;
  }
  const roomName = (r) => (r && /^\d/.test(r) ? 'Room ' + r : r);   // '103' → 'Room 103'; 'Pre-Op (2nd floor)' stays
  const cancelBtn = () => (V && V.visit && V.visit.can_cancel === false ? '' : `<button type="button" class="vp-link-btn" data-va="cancel">I don't need care any more</button>`);
  function closedView(v) {
    const o = v.state;   // left_before_seen, left_during_care, died, session_ended: the patient sees a calm "Visit ended"
    if (o === 'session_ended') return state('This session has ended', 'Please check in again next session.', discordBtn('See when the next session is'), 'ended');
    if (o === 'left_before_seen') return state('Your visit has ended', v.cancelled ? 'You left the queue.' : 'You left before being seen. If you still need care, check in again.', `<button type="button" class="vp-btn vp-primary" data-va="again">Check in again</button>`, 'ended');
    return state('Your visit has ended', 'Thank you for visiting CareBeyond Hospital.', '', 'ended');
  }
  function papersView(v) {
    const p = v.papers || {};
    const rows = [['Patient', v.name], ['Arrived', p.arrived_at ? `${clock(p.arrived_at)}` : ''], ['Outcome', p.outcome_label || OUTCOME[v.outcome] || 'Discharged'],
      ['Diagnosis', p.diagnosis], ['Care given', (p.care_given || []).join(', ')], ['Advice', p.advice], ['Follow-up', p.follow_up], ['Treated by', Array.isArray(p.treated_by) ? p.treated_by.join(', ') : p.treated_by]].filter((r) => r[1]);
    const rated = v.rating ? `<div class="vp-rated"><span>${v.rating_source === 'reception' ? 'Your rating, given at the front desk' : 'Your rating. Thank you!'}</span>${stars(v.rating, true)}</div>` : '';
    const rateForm = !v.rating && v.can_rate ? `<div class="vp-rate"><h2>How was your care?</h2>${stars(rate.stars, false)}
      <textarea id="vp-comment" rows="2" maxlength="500" placeholder="Anything you'd like to tell us? (optional)">${e(rate.comment)}</textarea>
      <button type="button" class="vp-btn vp-primary" data-va="rate"${rate.stars && !rate.busy ? '' : ' disabled'}>${rate.busy ? 'Sending…' : 'Send rating'}</button></div>` : '';
    return `<section class="vp-card"><span class="vp-ic ok" aria-hidden="true"></span><h1>You've been discharged</h1><p>Here are your discharge papers. Thank you for visiting CareBeyond Hospital.</p>
      <div class="vp-papers"><div class="vp-pp-h"><img src="assets/cbh-icon.svg" alt="" width="22" height="22"><b>CareBeyond Hospital</b><span>Discharge papers</span></div>
      <dl>${rows.map(([k, val]) => `<dt>${k}</dt><dd>${e(val)}</dd>`).join('')}</dl></div>${rated}${rateForm}</section>`;
  }
  const stars = (n, ro) => `<div class="vp-stars${ro ? ' ro' : ''}"${ro ? ` role="img" aria-label="${n} of 5"` : ' role="radiogroup" aria-label="Rating"'}>${[1, 2, 3, 4, 5].map((i) => ro
    ? `<span class="${n >= i ? 'on' : ''}">★</span>` : `<button type="button" role="radio" aria-checked="${n === i}" class="${n >= i ? 'on' : ''}" data-vstar="${i}" aria-label="${i} of 5">★</button>`).join('')}</div>`;

  // ---- routing, drawing and polling ----
  let poll = null, mode = null;
  const route = () => { const m = location.hash.match(/^#visit(?:\/([A-Za-z0-9_-]{3,100}))?$/); return m ? { token: m[1] || null } : null; };
  const typing = () => host.contains(document.activeElement) && /INPUT|TEXTAREA/.test(document.activeElement.tagName);
  function draw(force) {
    const r = route(); if (!r) return;
    if (!r.token) {   // the form: drawn once per screen, then only updated in place
      const scr = formScreen();
      if (scr === formShown && scr === 'open') { $('vp-sub') && ($('vp-sub').innerHTML = subLine()); syncForm(); return; }
      formShown = scr; host.innerHTML = shell(formView()); syncForm(); return;
    }
    formShown = '';
    if (typing() && !force) return;   // never redraw under someone typing a rating comment
    host.innerHTML = shell(visitView());
  }
  async function loadStatus() { try { const r = await API.status(); H = (r && r.hospital) || r; } catch { H = H || { state: 'closed' }; } draw(); }
  async function loadVisit() {
    try { V = await API.visit(vTok); vErr = ''; if (V && V.hospital) H = V.hospital; }
    catch (err) { vErr = err.message; }
    draw();
    if (V && V.visit && ['discharged', 'closed'].includes(V.visit.state) && V.visit.rating) stopPoll();
  }
  const stopPoll = () => { clearInterval(poll); poll = null; };
  function enter() {
    const r = route();
    document.documentElement.classList.toggle('visit-on', !!r);
    host.hidden = !r; stopPoll();
    if (!r) { mode = null; return; }
    window.scrollTo(0, 0);
    document.title = (r.token ? 'Your visit' : 'Check in') + ' · CareBeyond Hospital';
    if (r.token) {
      mode = 'visit'; if (vTok !== r.token) { V = null; vErr = ''; rate = { stars: 0, comment: '', busy: false }; } vTok = r.token;
      store.set(KEY, { token: r.token, at: Date.now() }); draw(); loadVisit();
      poll = setInterval(() => { if (!document.hidden) loadVisit(); }, 10000);
    } else {
      // Already have a visit on this device? Go back to it.
      const saved = store.get(KEY);
      if (CFG.patientCheckinLive && saved && saved.token && Date.now() - saved.at < 36 * 3600e3) { location.replace('#visit/' + saved.token); return; }
      mode = 'form'; draw(); if (CFG.patientCheckinLive) { loadStatus(); poll = setInterval(() => { if (!document.hidden) loadStatus(); }, 30000); }
    }
  }
  host.addEventListener('click', async (ev) => {
    const b = ev.target.closest('button, [data-vstar]'); if (!b) return;
    const d = b.dataset;
    if (d.vpain) { F.pain = +d.vpain; syncForm(); return; }
    if (d.vonset) { F.onset = F.onset === d.vonset ? null : d.vonset; syncForm(); return; }
    if (d.vtagrm) { F.tags.splice(+d.vtagrm, 1); syncForm(); return; }
    if (d.vstar) { rate.stars = +d.vstar; rate.comment = ($('vp-comment') || {}).value || rate.comment; draw(true); return; }
    if (d.vcopy) { try { await navigator.clipboard.writeText(d.vcopy); b.textContent = 'Copied'; } catch { /* the code is on screen */ } return; }
    const a = d.va;
    if (a === 'symadd') { const s2 = $('vp-sym'); addTag(s2.value); s2.value = ''; syncForm(); s2.focus(); }
    if (a === 'rbxyes') { F.rbx.ok = true; rbxCard(); $('vp-name')?.focus(); }
    if (a === 'rbxno') { F.user = ''; F.rbx = { state: 'idle', for: '', data: null, ok: false }; const u = $('vp-user'); u.value = ''; syncForm(); u.focus(); }
    if (a === 'go') submit();
    if (a === 'retry') loadVisit();
    if (a === 'again') { store.del(KEY); location.hash = '#visit'; }
    if (a === 'copylink') { try { await navigator.clipboard.writeText(location.href); copied = true; draw(true); setTimeout(() => { copied = false; draw(true); }, 2500); } catch { /* the link is in the address bar */ } }
    if (a === 'cancel') { if (!window.confirm('Leave the queue? Your place will be lost.')) return; try { const r = await API.cancel(vTok); if (r && r.ok === false && r.message) window.alert(r.message); } catch (err) { vErr = err.message; } loadVisit(); }
    if (a === 'rate') { rate.comment = ($('vp-comment') || {}).value || ''; rate.busy = true; draw(true);
      try { const r = await API.rate(vTok, rate.stars, rate.comment.trim()); if (r && r.ok === false && r.message) window.alert(r.message); } catch (err) { window.alert(err.message); }
      rate.busy = false; loadVisit(); }
  });
  // Typing only updates F and the bits around the box (syncForm); the box itself is never replaced.
  const FIELD = { 'vp-user': 'user', 'vp-name': 'name', 'vp-age': 'age', 'vp-allergies': 'allergies', 'vp-history': 'history', 'vp-notes': 'notes' };
  host.addEventListener('input', (ev) => { const k = FIELD[ev.target.id]; if (!k) return; F[k] = ev.target.value; if (F.err) F.err = '';
    if (k === 'user') { if (F.rbx.state !== 'off') F.rbx = { state: 'idle', for: '', data: null, ok: false }; lookupSoon(); } syncForm(); });
  host.addEventListener('focusout', (ev) => { if (ev.target.id === 'vp-user') { setTimeout(syncForm, 0); lookupSoon(true); } });
  host.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && ev.target.id === 'vp-sym') { ev.preventDefault(); addTag(ev.target.value); ev.target.value = ''; syncForm(); } });
  window.addEventListener('hashchange', enter);
  enter();
  // For the front page's "Check in online" button.
  window.cbhVisitLive = () => !!CFG.patientCheckinLive;
})();
