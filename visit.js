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
    checkin: (name, symptoms, said) => rpc('chart_checkin_anon', { p_roblox_username: name, p_symptoms: symptoms, p_said: said, p_client_key: clientKey() }),
    visit: (token) => rpc('chart_visit', { p_token: token }),
    rate: (token, rating, comment) => rpc('chart_visit_rate', { p_token: token, p_rating: rating, p_comment: comment || null }),
    cancel: (token) => rpc('chart_visit_cancel', { p_token: token }),
  };

  // ---- words (patient view; professional but plain, FLOW-AUDIT §4) ----
  const SAID = [['a_little', 'A little'], ['quite_bad', 'Quite bad'], ['very_bad', 'Very bad']];
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
  const F = { name: '', tags: [], said: null, busy: false, err: '' };
  let H = null;   // the latest hospital block
  function formView() {
    if (!CFG.patientCheckinLive) return state('Online check-in is launching soon', 'Soon you’ll be able to check in before you arrive, with no account: just your Roblox username. Until then, walk in and check in at reception in game.', `${joinBlock(H)}${discordBtn('Join our Discord to hear first')}`, 'soon');
    if (!H) return `<section class="vp-card"><p class="vp-muted">Loading…</p></section>`;
    if (H.state === 'closed') return state('Online check-in is closed', `No staff are on shift right now.${H.next_session_at ? ` Next session: <b>${e(when(H.next_session_at))}</b>.` : ''}`, `${discordBtn()}<p class="vp-muted vp-sm-t">See when the next sessions are.</p>`, 'closed');
    if (H.state === 'walk_ins_only') return state('Online check-in is paused', 'The front desk is busy. Please check in at reception in game.', joinBlock(H), 'paused');
    const ok = ROBLOX.test(F.name.trim()) && F.tags.length && F.said && !F.busy;
    return `<section class="vp-card vp-form"><h1>Check in</h1><p class="vp-sub">CareBeyond Hospital · staff are on shift · no account needed${H.wait_hint != null ? ` · about ${e(H.wait_hint)} min wait` : ''}</p>
      <label class="vp-f"><span>Your Roblox username</span><input id="vp-name" value="${e(F.name)}" placeholder="Exactly as it shows above your head" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="20" inputmode="text">
        ${F.name && !ROBLOX.test(F.name.trim()) ? '<small class="vp-bad">3 to 20 letters or numbers, with at most one underscore in the middle.</small>' : ''}</label>
      <div class="vp-f"><span>What's wrong? <em>Type each thing, then Add</em></span>
        ${F.tags.length ? `<div class="vp-tags">${F.tags.map((t, i) => `<span class="vp-tag">${e(t)}<button type="button" data-vtagrm="${i}" aria-label="Remove ${e(t)}">×</button></span>`).join('')}</div>` : ''}
        <div class="vp-row"><input id="vp-sym" placeholder="e.g. my arm hurts" autocomplete="off" maxlength="80" enterkeyhint="done"><button type="button" class="vp-btn vp-ghost" data-va="symadd">Add</button></div></div>
      <div class="vp-f"><span>How bad is it?</span><div class="vp-chips" role="radiogroup" aria-label="How bad is it?">${SAID.map(([k, l]) => `<button type="button" role="radio" aria-checked="${F.said === k}" class="vp-chip${F.said === k ? ' on' : ''}" data-vsaid="${k}">${l}</button>`).join('')}</div></div>
      <p class="vp-note">This is roleplay. Don't share real health or personal information.</p>${errBox(F.err)}
      <button type="button" class="vp-btn vp-primary vp-big" data-va="go"${ok ? '' : ' disabled'}>${F.busy ? 'Checking in…' : 'Check in'}</button></section>`;
  }
  async function submit() {
    const sym = $('vp-sym'); if (sym && sym.value.trim()) addTag(sym.value);
    const name = F.name.trim(), text = F.tags.join(', ').slice(0, 300);
    if (!ROBLOX.test(name) || !text || !F.said) return;
    F.busy = true; F.err = ''; draw();
    try {
      const r = await API.checkin(name, text, F.said);
      if (r && r.hospital) H = r.hospital;
      if (!r || !r.ok || !r.token) { F.busy = false; F.err = (r && r.message) || 'Online check-in isn’t available right now. Please check in at reception in game.';
        if (r && (r.refused === 'closed' || r.refused === 'walk_ins_only')) F.err = ''; draw(); return; }
      store.set(KEY, { token: r.token, at: Date.now() });
      F.name = ''; F.tags = []; F.said = null; F.busy = false;
      location.hash = '#visit/' + r.token;
    } catch (err) { F.busy = false; F.err = err.message; draw(); }
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
  function draw() {
    const r = route(); if (!r) return;
    const keep = document.activeElement && document.activeElement.id, pos = keep && document.activeElement.selectionStart;
    host.innerHTML = shell(r.token ? visitView() : formView());
    if (keep && $(keep)) { const el = $(keep); el.focus(); try { el.setSelectionRange(pos, pos); } catch { /* fine */ } }
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
    if (d.vsaid) { F.said = d.vsaid; draw(); return; }
    if (d.vtagrm) { F.tags.splice(+d.vtagrm, 1); draw(); return; }
    if (d.vstar) { rate.stars = +d.vstar; rate.comment = ($('vp-comment') || {}).value || rate.comment; draw(); return; }
    if (d.vcopy) { try { await navigator.clipboard.writeText(d.vcopy); b.textContent = 'Copied'; } catch { /* the code is on screen */ } return; }
    const a = d.va;
    if (a === 'symadd') { addTag(($('vp-sym') || {}).value); draw(); $('vp-sym')?.focus(); }
    if (a === 'go') submit();
    if (a === 'retry') loadVisit();
    if (a === 'again') { store.del(KEY); location.hash = '#visit'; }
    if (a === 'copylink') { try { await navigator.clipboard.writeText(location.href); copied = true; draw(); setTimeout(() => { copied = false; draw(); }, 2500); } catch { /* the link is in the address bar */ } }
    if (a === 'cancel') { if (!window.confirm('Leave the queue? Your place will be lost.')) return; try { const r = await API.cancel(vTok); if (r && r.ok === false && r.message) window.alert(r.message); } catch (err) { vErr = err.message; } loadVisit(); }
    if (a === 'rate') { rate.comment = ($('vp-comment') || {}).value || ''; rate.busy = true; draw();
      try { const r = await API.rate(vTok, rate.stars, rate.comment.trim()); if (r && r.ok === false && r.message) window.alert(r.message); } catch (err) { window.alert(err.message); }
      rate.busy = false; loadVisit(); }
  });
  host.addEventListener('input', (ev) => { if (ev.target.id === 'vp-name') { const was = ROBLOX.test(F.name.trim()); F.name = ev.target.value; if (was !== ROBLOX.test(F.name.trim()) || !F.name) draw(); } });
  host.addEventListener('change', (ev) => { if (ev.target.id === 'vp-name') draw(); });
  host.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && ev.target.id === 'vp-sym') { ev.preventDefault(); addTag(ev.target.value); draw(); $('vp-sym')?.focus(); } });
  window.addEventListener('hashchange', enter);
  enter();
  // For the front page's "Check in online" button.
  window.cbhVisitLive = () => !!CFG.patientCheckinLive;
})();
