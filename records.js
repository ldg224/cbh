// Records (#admin/records), redesigned 0.15.x (owner decisions in chat, 17 Nov 2026):
// - start screen: search, Recently opened (this device), Recently actioned, Most warnings
// - a record: profile column (photo, name, badges, numbers, quick Warn / Time out / Kick / Ban that open the New
//   action panel filled in, Write up an incident; executives also Unban) and one timeline of warnings, actions
//   (with supervisor reviews) and incidents, with filter chips; Messages as its own tab; Details folded away
// - Incidents (migration 0019): written write-ups against a person, editable by the author or an executive
// Back end: mod_member_search, member_record, mod_cases, incidents, remove_incident, revoke_warning,
// discord_messages, member_faces / roblox_avatars (faces.js). Uses openCasePanel() from cases.js.

const shortDate = (iso) => (iso ? new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const REC_RECENT_KEY = 'cbh-recent-records';
function recentRecords() { try { return JSON.parse(localStorage.getItem(REC_RECENT_KEY) || '[]').slice(0, 8); } catch { return []; } }
function pushRecent(id, name) {
  try {
    const list = recentRecords().filter((x) => x.id !== id);
    list.unshift({ id, name, at: Date.now() });
    localStorage.setItem(REC_RECENT_KEY, JSON.stringify(list.slice(0, 8)));
  } catch { /* fine without it */ }
}

async function renderRecords(body) {
  body.innerHTML = `
    <div class="rc-search picker">
      <label class="ma-search rc-box"><span class="h-glass" aria-hidden="true"></span>
        <input id="rec-q" type="search" placeholder="Find someone by name, username or Discord ID" autocomplete="off" aria-controls="rec-sugg" aria-label="Find someone"></label>
      <div class="sugg" id="rec-sugg" role="listbox" hidden></div>
    </div>
    <div id="rec-body"></div>`;
  const q = body.querySelector('#rec-q'), sugg = body.querySelector('#rec-sugg'), box = body.querySelector('#rec-body');
  let timer = null, results = [], active = 0;
  const open = (m) => {
    sugg.hidden = true; q.value = '';
    const name = cleanName(m.display_name || m.username || m.discord_id);
    rememberRecord(m.discord_id, name); pushRecent(m.discord_id, name);
    showRecord(box, m.discord_id);
  };
  const draw = () => {
    const id = q.value.trim(), raw = /^\d{15,22}$/.test(id) && !results.some((m) => m.discord_id === id);
    sugg.innerHTML = results.map((m, i) => `<button type="button" role="option" class="sg${i === active ? ' on' : ''}" data-i="${i}">
        ${face({ name: m.display_name || m.username || m.discord_id, discordId: m.discord_id, avatarUrl: m.avatar_url, size: 's' })}
        <span class="pk-main"><strong>${esc(cleanName(m.display_name || m.username || m.discord_id))}</strong>
        <span class="muted small-meta">${m.username ? '@' + esc(m.username) + ' · ' : ''}${esc(m.discord_id)}${warnText(m.warnings)}</span></span>
        ${m.banned ? '<span class="st sub-denied">Banned</span>' : ''}</button>`).join('')
      + (raw ? `<button type="button" class="sg" data-raw="${esc(id)}"><span class="pk-main"><strong>Open record for ID ${esc(id)}</strong><span class="muted small-meta">For someone who has left the server</span></span></button>` : '');
    if (!sugg.innerHTML && id.length >= 2) sugg.innerHTML = '<p class="muted small sg-empty">Nobody found. Someone who has left can be found by their Discord ID.</p>';
    sugg.hidden = !sugg.innerHTML;
    paintFaces(sugg);
  };
  q.oninput = () => {
    clearTimeout(timer);
    const term = q.value.trim();
    if (term.length < 2) { results = []; sugg.hidden = true; return; }
    timer = setTimeout(async () => {
      const { data, error } = await sb.rpc('mod_member_search', { q: term });
      if (q.value.trim() !== term) return;
      if (error) { sugg.hidden = false; sugg.innerHTML = `<p class="error sg-empty">${esc(error.message)}</p>`; return; }
      results = data || []; active = 0; draw();
    }, 200);
  };
  q.onkeydown = (e) => {
    if (sugg.hidden || !results.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length; draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); open(results[active]); }
    else if (e.key === 'Escape') sugg.hidden = true;
  };
  sugg.onclick = (e) => { const b = e.target.closest('.sg'); if (b) open(b.dataset.raw ? { discord_id: b.dataset.raw } : results[+b.dataset.i]); };
  document.addEventListener('click', (e) => { if (body.isConnected && !e.target.closest('.rc-search')) sugg.hidden = true; });
  box.addEventListener('click', (e) => {
    const p = e.target.closest('[data-person]');
    if (p) { pushRecent(p.dataset.person, p.dataset.name || ''); rememberRecord(p.dataset.person, p.dataset.name || ''); showRecord(box, p.dataset.person); window.scrollTo(0, 0); }
  });

  if (pendingRecord) { const id = pendingRecord; pendingRecord = null; showRecord(box, id); return; }
  startScreen(box);
  q.focus();
}

// ---------- start screen ----------
async function startScreen(box) {
  const recent = recentRecords();
  box.innerHTML = `<div class="rc-start">
    ${recent.length ? `<section class="rc-sec"><h2 class="ma-day">Recently opened</h2><div class="rc-chips">${recent.map((r) => `<button type="button" class="rc-chip" data-person="${esc(r.id)}" data-name="${esc(r.name)}">${face({ name: r.name, discordId: r.id, size: 's' })}<span>${esc(r.name)}</span></button>`).join('')}</div></section>` : ''}
    <div class="rc-two">
      <section class="rc-sec"><h2 class="ma-day">Recently actioned</h2><div class="card rc-list" id="rc-acted"><p class="muted small">Loading…</p></div></section>
      <section class="rc-sec"><h2 class="ma-day">Most warnings</h2><div class="card rc-list" id="rc-warned"><p class="muted small">Loading…</p></div></section>
    </div></div>`;
  paintFaces(box);
  const since = new Date(Date.now() - 7 * 864e5).toISOString();
  const [acted, warns] = await Promise.all([
    sb.from('mod_cases').select('target_discord_id, target_name, action, created_at').neq('source', 'in_game').eq('status', 'done').is('revoked_at', null).not('target_discord_id', 'is', null).gte('created_at', since).order('created_at', { ascending: false }).limit(60),
    sb.from('mod_cases').select('target_discord_id, target_name, created_at').eq('action', 'warn').eq('status', 'done').is('revoked_at', null).not('target_discord_id', 'is', null).order('created_at', { ascending: false }).limit(1000),
  ]);
  const actedBox = box.querySelector('#rc-acted'), warnBox = box.querySelector('#rc-warned');
  if (!actedBox) return;
  const seen = new Set(), people = [];
  for (const c of acted.data || []) { if (seen.has(c.target_discord_id)) continue; seen.add(c.target_discord_id); people.push(c); if (people.length >= 8) break; }
  actedBox.innerHTML = acted.error ? `<p class="error">Couldn’t load: ${esc(acted.error.message)}</p>`
    : people.length ? people.map((c) => personRow(c.target_discord_id, c.target_name, `<span class="ma-act act act-${esc(c.action)}">${esc(ACTION_LABEL[c.action] || c.action)}</span><span class="muted small-meta">${when(c.created_at)}</span>`)).join('')
      : '<p class="muted small">No actions in the last 7 days.</p>';
  const counts = new Map();
  for (const w of warns.data || []) { const x = counts.get(w.target_discord_id) || { n: 0, name: w.target_name, last: w.created_at }; x.n += 1; counts.set(w.target_discord_id, x); }
  const top = [...counts.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 8);
  warnBox.innerHTML = warns.error ? `<p class="error">Couldn’t load: ${esc(warns.error.message)}</p>`
    : top.length ? top.map(([id, x]) => personRow(id, x.name, `<span class="rc-count">${plural(x.n, 'warning')}</span><span class="muted small-meta">last ${when(x.last)}</span>`)).join('')
      : '<p class="muted small">Nobody has an active warning.</p>';
  loadFaces(box);
}
const personRow = (id, name, right) => `<button type="button" class="rc-row" data-person="${esc(id)}" data-name="${esc(cleanName(name || id))}">
  ${face({ name: name || id, discordId: id, size: 's' })}<strong>${esc(cleanName(name || id))}</strong><span class="rc-right">${right}</span></button>`;

// ---------- one person's record ----------
const REC_FILTERS = [['all', 'Everything'], ['warn', 'Warnings'], ['action', 'Actions'], ['incident', 'Incidents']];
async function showRecord(box, id) {
  box.innerHTML = `<div class="rc-layout"><aside class="card rc-profile"><span class="sk round" style="width:88px;height:88px"></span>${lines('60%', '40%')}</aside><div class="card">${lines('80%', '70%', '75%')}</div></div>`;
  const [rec, roleQ, casesQ, incQ] = await Promise.all([
    sb.rpc('member_record', { discord_id: id }),
    sb.from('roles').select(ROLE_FIELDS),
    sb.from('mod_cases').select('*').eq('target_discord_id', id).neq('source', 'in_game').neq('status', 'failed').is('revoked_at', null).order('created_at', { ascending: false }).limit(300),
    sb.from('incidents').select('*').eq('target_discord_id', id).order('happened_at', { ascending: false }).limit(200),
  ]);
  if (rec.error || !rec.data) {
    box.innerHTML = `<div class="card ma-empty"><strong>Couldn’t open this record.</strong><span>${esc(rec.error ? rec.error.message : 'Only Administration and executives can see records.')}</span></div>`;
    return;
  }
  const r = rec.data, all = roleQ.data || [];
  const mine = new Set(r.role_ids || []);
  const roles = all.filter((x) => mine.has(x.id)).sort((a, b) => b.position - a.position);
  const depts = all.filter((x) => x.kind === 'department');
  const cases = casesQ.data || [];
  const incidents = incQ.error ? [] : (incQ.data || []);
  const name = cleanName(r.display_name || r.username || id);
  const person = { discord_id: id, display_name: r.display_name || name, username: r.username, avatar_url: r.avatar_url, banned: !!r.banned };
  const visibleInc = incidents.filter((i) => !i.removed_at);
  const actions = cases.filter((c) => c.action !== 'warn');
  const warns = cases.filter((c) => c.action === 'warn');
  let filter = 'all', tab = 'timeline';

  const badges = roles.length ? personBadges(rosterBadges(roles, depts, null).concat(roles.some((x) => x.kind === 'verified') ? [{ label: 'Verified', color: roles.find((x) => x.kind === 'verified').badge_color, icon: 'verified' }] : [])) : '';
  const stat = (n, l, cls = '') => `<div class="rc-stat ${cls}"><strong>${n}</strong><span>${l}</span></div>`;
  box.innerHTML = `<div class="rc-layout">
    <aside class="card rc-profile">
      ${face({ name, discordId: id, avatarUrl: r.avatar_url, size: 'xl' })}
      <h2 class="rc-name">${esc(name)}</h2>
      <span class="rc-sub">${r.username ? '@' + esc(r.username) + ' · ' : ''}${esc(id)}</span>
      <div class="rc-tags">${r.banned ? '<span class="st sub-denied">Banned</span>' : ''}${r.in_server === false && !r.banned ? '<span class="st">Not in the server</span>' : ''}</div>
      ${badges ? `<div class="person-badges rc-badges">${badges}</div>` : ''}
      <div class="rc-stats">
        ${stat(Number(r.warnings ?? warns.length), 'Warnings', Number(r.warnings ?? warns.length) ? 'warn' : '')}
        ${stat(actions.length, 'Actions')}
        ${stat(Number(r.incidents ?? visibleInc.length), 'Incidents', Number(r.incidents ?? visibleInc.length) ? 'warn' : '')}
        ${stat(Number(r.messages_90d || 0), 'Messages, 90 days')}
        ${stat(Number(r.shift_hours_30d || 0).toFixed(1), 'Shift hours, 30 days')}
      </div>
      ${access.admin ? `<div class="rc-acts">
        ${r.in_server !== false ? ['warn', 'timeout', 'kick', 'ban'].map((a) => `<button type="button" class="ghost${a === 'kick' || a === 'ban' ? ' rc-strong' : ''}" data-act="${a}">${{ warn: 'Warn', timeout: 'Time out', kick: 'Kick', ban: 'Ban' }[a]}</button>`).join('') : ''}
        ${r.banned ? '<button type="button" class="ghost" data-act="unban">Unban</button>' : ''}
        <button type="button" class="refresh rc-wide" id="rc-incident">Write up an incident</button></div>` : ''}
      <details class="rc-details"><summary>Details</summary><dl class="rec-dl">
        ${r.joined_at ? `<dt>Joined the server</dt><dd>${esc(shortDate(r.joined_at))}</dd>` : ''}
        ${r.account_created_at ? `<dt>Account made</dt><dd>${esc(shortDate(r.account_created_at))}</dd>` : ''}
        <dt>Last message</dt><dd>${r.last_message_at ? esc(when(r.last_message_at)) : 'None in the last 90 days'}</dd>
        <dt>Shifts</dt><dd>${Number(r.shifts_total || 0)} in total · ${Number(r.shift_hours_total || 0).toFixed(1)} hours${r.last_shift_at ? ' · last ' + esc(when(r.last_shift_at)) : ''}</dd>
        <dt>Roles</dt><dd>${roles.length ? roles.filter((x) => x.kind !== 'bot').map((x) => esc(x.name)).join(', ') : 'None'}</dd>
      </dl></details>
    </aside>
    <section class="rc-mainc">
      <div class="rc-tabs" role="tablist"><button type="button" role="tab" aria-selected="true" data-tab="timeline">Timeline</button><button type="button" role="tab" aria-selected="false" data-tab="messages">Messages</button></div>
      <div id="rc-incform"></div>
      <div id="rc-tab"></div>
    </section></div>`;
  loadFaces(box);
  const tabEl = box.querySelector('#rc-tab');

  // Quick actions: the New action panel, filled in with this person.
  box.querySelectorAll('[data-act]').forEach((b) => { b.onclick = () => openCasePanel({ action: b.dataset.act, person }, () => showRecord(box, id)); });
  box.querySelector('#rc-incident')?.addEventListener('click', () => incidentForm(null));

  function timeline() {
    const items = [
      ...cases.map((c) => ({ kind: c.action === 'warn' ? 'warn' : 'action', at: c.created_at, c })),
      ...incidents.map((i) => ({ kind: 'incident', at: i.happened_at, i })),
    ].filter((x) => filter === 'all' || x.kind === filter).sort((a, b) => new Date(b.at) - new Date(a.at));
    const counts = { all: cases.length + visibleInc.length, warn: warns.length, action: actions.length, incident: visibleInc.length };
    let html = `<div class="ma-chips rc-filter" role="group" aria-label="Show">${REC_FILTERS.map(([k, l]) => `<button type="button" class="chip${filter === k ? ' on' : ''}" aria-pressed="${filter === k}" data-f="${k}">${l} <span class="count">${counts[k]}</span></button>`).join('')}</div>`;
    if (!items.length) html += `<div class="card ma-empty"><strong>${filter === 'all' ? `Nothing on ${esc(name)}’s record.` : 'None of these.'}</strong><span>${filter === 'all' ? 'Warnings, mod actions and incidents will show here.' : 'Try another filter.'}</span></div>`;
    else {
      let lastKey = '';
      html += '<div class="rc-tl">';
      for (const x of items) {
        const k = dayKey(x.at);
        if (k !== lastKey) { html += `<h3 class="rc-date">${esc(dayLabel(x.at))}</h3>`; lastKey = k; }
        html += x.kind === 'incident' ? incidentItem(x.i) : caseItem(x.c);
      }
      html += '</div>';
    }
    tabEl.innerHTML = html;
    loadFaces(tabEl);
    tabEl.querySelector('.rc-filter').onclick = (e) => { const b = e.target.closest('[data-f]'); if (b) { filter = b.dataset.f; timeline(); } };
  }
  function caseItem(c) {
    const review = c.review_status === 'requested' ? '<span class="ma-flag review">Waiting for review</span>'
      : c.review_status === 'reviewed' ? `<span class="ma-flag ${c.review_outcome}">${MA_OUTCOME[c.review_outcome] || 'Reviewed'}</span>` : '';
    return `<article class="rc-item ${c.action === 'warn' ? 'k-warn' : 'k-action'}" data-case="${c.id}">
      <div class="rc-ihead"><span class="ma-act act act-${esc(c.action)}">${esc(ACTION_LABEL[c.action] || c.action)}</span>${c.duration_minutes ? `<span class="ma-len">${esc(lenText(c.duration_minutes))}</span>` : ''}${review}
        ${c.status === 'pending' ? '<span class="ma-pending"><span class="ma-spin" aria-hidden="true"></span>Pending</span>' : ''}
        <span class="rc-when">${timeOf(c.created_at)}</span></div>
      <p class="rc-text">${esc(c.reason || '')}</p>
      <div class="ma-meta">${face({ name: c.moderator_name, discordId: c.moderator_discord_id, size: 'xs' })}by ${esc(cleanName(c.moderator_name || 'unknown'))} · ${esc(MA_SOURCE[c.source] || c.source)}</div>
      ${c.review_status === 'reviewed' ? `<div class="ma-rnote done"><strong>${MA_OUTCOME[c.review_outcome] || 'Reviewed'} by ${esc(cleanName(c.reviewed_by_name || 'a supervisor'))}:</strong> ${esc(c.review_result_note || '')}</div>` : ''}
      ${c.action === 'warn' && c.status === 'done' && access.exec ? `<div class="rc-ilinks"><button type="button" data-unwarn="${c.id}">Remove warning</button></div><div class="rc-iform" hidden></div>` : ''}
    </article>`;
  }
  function incidentItem(i) {
    const canEdit = !i.removed_at && (i.created_by === myDiscordId || access.exec);
    return `<article class="rc-item k-incident${i.removed_at ? ' removed' : ''}" data-inc="${i.id}">
      <div class="rc-ihead"><span class="rc-inc-tag">Incident</span>${i.removed_at ? '<span class="st">Removed</span>' : ''}<span class="rc-when">${timeOf(i.happened_at)}</span></div>
      <h4 class="rc-ititle">${esc(i.title)}</h4>
      <p class="rc-text">${esc(i.body)}</p>
      ${(i.evidence || []).length ? `<div class="rc-evid">${i.evidence.map((u, n) => `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">Evidence ${n + 1}</a>`).join('')}</div>` : ''}
      <div class="ma-meta">${face({ name: i.created_by_name, discordId: i.created_by, size: 'xs' })}written by ${esc(cleanName(i.created_by_name || 'an admin'))}${i.edited_at ? ' · edited' : ''}${i.removed_at ? ` · removed by ${esc(cleanName(i.removed_by_name || 'someone'))} ${esc(when(i.removed_at))}` : ''}</div>
      ${canEdit ? `<div class="rc-ilinks"><button type="button" data-iedit="${i.id}">Edit</button><button type="button" class="warnish" data-iremove="${i.id}">Remove</button></div><div class="rc-iform" hidden></div>` : ''}
    </article>`;
  }

  // Timeline actions: remove a warning (executives), edit or remove an incident (author or executive).
  tabEl.addEventListener('click', async (e) => {
    const uw = e.target.closest('[data-unwarn]'), ed = e.target.closest('[data-iedit]'), rm = e.target.closest('[data-iremove]');
    if (uw) {
      const f = uw.closest('.rc-item').querySelector('.rc-iform');
      f.hidden = false;
      f.innerHTML = `<form class="ma-iform"><strong>Remove this warning?</strong><label class="f"><span>Why remove it?</span><textarea rows="2" required maxlength="500" placeholder="e.g. Given by mistake"></textarea></label><p class="error" hidden></p>
        <div class="f-actions"><button type="button" class="linkish" data-x>Cancel</button><button type="submit" class="refresh">Remove warning</button></div></form>`;
      f.querySelector('textarea').focus();
      f.querySelector('[data-x]').onclick = () => { f.hidden = true; f.innerHTML = ''; };
      f.querySelector('form').onsubmit = async (ev) => {
        ev.preventDefault();
        const { error } = await sb.rpc('revoke_warning', { case_id: +uw.dataset.unwarn, reason: f.querySelector('textarea').value.trim() });
        if (error) { const er = f.querySelector('.error'); er.textContent = error.message; er.hidden = false; return; }
        showRecord(box, id);
      };
    }
    if (ed) incidentForm(incidents.find((x) => x.id === +ed.dataset.iedit));
    if (rm) {
      const f = rm.closest('.rc-item').querySelector('.rc-iform');
      f.hidden = false;
      f.innerHTML = `<div class="ma-iform"><strong>Remove this incident?</strong><span class="muted small">It disappears from this record. Executives can still see it.</span><p class="error" hidden></p>
        <div class="f-actions"><button type="button" class="linkish" data-x>Cancel</button><button type="button" class="refresh danger-fill" data-yes>Remove</button></div></div>`;
      f.querySelector('[data-x]').onclick = () => { f.hidden = true; f.innerHTML = ''; };
      f.querySelector('[data-yes]').onclick = async () => {
        const { error } = await sb.rpc('remove_incident', { incident_id: +rm.dataset.iremove });
        if (error) { const er = f.querySelector('.error'); er.textContent = error.message; er.hidden = false; return; }
        showRecord(box, id);
      };
    }
  });

  // Write up (or edit) an incident.
  function incidentForm(inc) {
    const holder = box.querySelector('#rc-incform');
    const local = (iso) => { const d = iso ? new Date(iso) : new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
    holder.innerHTML = `<form class="card rc-incf" novalidate>
      <div class="rc-incf-head"><strong>${inc ? 'Edit incident' : `Write up an incident about ${esc(name)}`}</strong><button type="button" class="h-x" aria-label="Close">&times;</button></div>
      <label class="f"><span>Title</span><input id="ri-title" maxlength="120" required value="${esc(inc ? inc.title : '')}" placeholder="e.g. Abusive in voice chat"></label>
      <label class="f"><span>What happened</span><textarea id="ri-body" rows="5" maxlength="4000" required placeholder="Describe what happened, who was involved and what was done.">${esc(inc ? inc.body : '')}</textarea></label>
      <div class="f-row"><label class="f"><span>When</span><input id="ri-when" type="datetime-local" value="${local(inc && inc.happened_at)}" required></label>
        <label class="f"><span>Evidence links <em>(optional, one per line)</em></span><textarea id="ri-ev" rows="2" placeholder="https://…">${esc(inc ? (inc.evidence || []).join('\n') : '')}</textarea></label></div>
      <p class="error" id="ri-err" hidden></p>
      <div class="f-actions"><button type="button" class="linkish" data-x>Cancel</button><button type="submit" class="refresh">${inc ? 'Save changes' : 'Save incident'}</button></div></form>`;
    const f = holder.querySelector('form'), err = holder.querySelector('#ri-err');
    const close = () => { holder.innerHTML = ''; };
    f.querySelector('.h-x').onclick = close; f.querySelector('[data-x]').onclick = close;
    f.querySelector('#ri-title').focus();
    holder.scrollIntoView({ behavior: 'smooth', block: 'start' });
    f.onsubmit = async (e) => {
      e.preventDefault();
      const title = f.querySelector('#ri-title').value.trim(), bodyText = f.querySelector('#ri-body').value.trim(), w = f.querySelector('#ri-when').value;
      const ev = f.querySelector('#ri-ev').value.split(/\s+/).map((x) => x.trim()).filter(Boolean);
      const bad = ev.find((u) => !/^https?:\/\/\S+$/i.test(u));
      const say = (m) => { err.textContent = m; err.hidden = false; };
      if (!title) return say('Give it a short title.');
      if (!bodyText) return say('Describe what happened.');
      if (!w) return say('Say when it happened.');
      if (bad) return say(`"${bad}" isn’t a web link. Links must start with http:// or https://.`);
      if (ev.length > 10) return say('Add up to 10 links.');
      const row = { title, body: bodyText, happened_at: new Date(w).toISOString(), evidence: ev };
      const sub = f.querySelector('[type=submit]'); sub.disabled = true; err.hidden = true;
      const { error } = inc
        ? await sb.from('incidents').update(row).eq('id', inc.id)
        : await sb.from('incidents').insert({ ...row, target_discord_id: id, target_name: r.display_name || name, created_by: myDiscordId });
      if (error) { sub.disabled = false; return say('Couldn’t save it: ' + error.message); }
      showRecord(box, id);
    };
  }

  box.querySelector('.rc-tabs').onclick = (e) => {
    const b = e.target.closest('[data-tab]'); if (!b) return;
    tab = b.dataset.tab;
    box.querySelectorAll('.rc-tabs [data-tab]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    if (tab === 'messages') showMessages(tabEl, id); else timeline();
  };
  timeline();
}

// Messages they've sent (kept 90 days), newest first, 50 at a time, with a search.
async function showMessages(tab, id) {
  const PAGE = 50;
  let cursor = null, term = '', timer = null;
  tab.innerHTML = `<label class="ma-search rc-msearch"><span class="h-glass" aria-hidden="true"></span><input id="msg-q" type="search" placeholder="Search their messages" autocomplete="off" aria-label="Search their messages"></label>
    <div class="card rmsg-list" id="msg-list"><p class="muted small">Loading…</p></div>
    <div class="ma-more"><button type="button" class="ghost" id="msg-more" hidden>Load older messages</button></div>
    <p class="muted small rc-note">Saved from 17 Nov 2026 and kept for 90 days. Gaps mean the bot was offline.</p>`;
  const list = tab.querySelector('#msg-list'), more = tab.querySelector('#msg-more');
  async function load(fresh) {
    if (fresh) cursor = null;
    let qy = sb.from('discord_messages').select('*').eq('author_id', id).order('created_at', { ascending: false }).limit(PAGE);
    if (cursor) qy = qy.lt('created_at', cursor);
    if (term) qy = qy.ilike('content', `%${term.replace(/[%_]/g, '\\$&')}%`);
    const { data, error } = await qy;
    if (fresh) list.innerHTML = '';
    if (error) return liveError(list, error);
    if (fresh && !data.length) list.innerHTML = `<p class="muted small">${term ? 'No messages match that.' : 'No messages in the last 90 days.'}</p>`;
    list.insertAdjacentHTML('beforeend', data.map((m) => `<div class="rmsg${m.deleted_at ? ' is-deleted' : ''}">
        <div class="rmsg-meta"><strong>#${esc(m.channel_name || m.channel_id)}</strong><span class="muted">${when(m.created_at)}</span>
          ${m.edited_at ? '<span class="st">Edited</span>' : ''}${m.deleted_at ? '<span class="st sub-denied">Deleted</span>' : ''}</div>
        ${m.content ? `<div class="rmsg-text">${esc(m.content)}</div>` : ''}
        ${(m.attachments || []).length ? `<div class="rmsg-files">${m.attachments.map((a) => `<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.name || 'Attachment')}</a>`).join('')}</div>` : ''}
      </div>`).join(''));
    if (data.length) cursor = data[data.length - 1].created_at;
    more.hidden = data.length < PAGE;
  }
  tab.querySelector('#msg-q').oninput = (e) => { clearTimeout(timer); timer = setTimeout(() => { term = e.target.value.trim(); load(true); }, 300); };
  more.onclick = () => load(false);
  load(true);
}

LIVE.records = renderRecords;
