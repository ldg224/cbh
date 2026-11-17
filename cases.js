// Mod actions (#admin/cases), redesigned 0.15.x (owner decisions in chat, 17 Nov 2026):
// - header stats that filter the list; a toolbar with search, type chips, Discord / In game and Only mine
// - the list grouped by day, one tidy row per action with a ⋯ menu (Open record, Remove timeout, Unban,
//   Remove warning for executives, Copy details, Send for supervisor review)
// - supervisors see "Waiting for review" and resolve requests (upheld / changed / overturned)
// - your failed actions sit at the top with Try again / Dismiss
// - New action is a 3-step side panel: Who (with their history) → What (with a gentle next-step hint) → Why
//   (quick reasons, on-page review and confirm). Nothing uses the browser's confirm().
// Back end: mod_cases (+ review columns, migration 0017), mod_member_search, member_record, roblox-user,
// revoke_warning, request_review, resolve_review, is_supervisor, dismiss_failed, home_counts.

const MA_TYPES = [
  { id: 'all', label: 'All' }, { id: 'warn', label: 'Warnings' }, { id: 'timeout', label: 'Timeouts' },
  { id: 'kick', label: 'Kicks' }, { id: 'ban', label: 'Bans' }, { id: 'unban', label: 'Unbans' }, { id: 'note', label: 'Notes' },
];
const MA_SOURCE = { discord: 'Discord', website: 'Discord', in_game: 'In game' };
const MA_REASONS = ['Spam / flooding', 'Disrespect / harassment', 'Inappropriate content', 'Breaking roleplay / trolling'];
const MA_ACTION_INFO = {
  warn: { label: 'Warn', blurb: 'Sends them a warning by DM and records it.' },
  timeout: { label: 'Timeout', blurb: 'They can’t talk or react for a while.' },
  untimeout: { label: 'Remove timeout', blurb: 'Ends a timeout early.' },
  kick: { label: 'Kick', blurb: 'Removes them from the server. They can rejoin with an invite.', strong: true },
  ban: { label: 'Ban', blurb: 'Removes them and stops them rejoining.', strong: true },
  unban: { label: 'Unban', blurb: 'Lets a banned person rejoin.' },
  note: { label: 'Note', blurb: 'A record only. Nothing happens in game or on Discord.' },
};
const MA_GAME_INFO = {
  warn: 'Record a warning given in Maple Hospital.', kick: 'Record a kick from the Maple Hospital server.',
  ban: 'Record a ban from the Maple Hospital server.', note: 'A note about this player. Nothing else happens.',
};
const MA_OUTCOME = { upheld: 'Upheld', changed: 'Changed', overturned: 'Overturned' };
const MA_PAGE = 40;
let maWatch = null;
let maSupervisor = null;   // is_supervisor(), asked once

const dayKey = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
function dayLabel(iso) {
  const d = new Date(iso), t = new Date(), y = new Date(Date.now() - 864e5);
  if (dayKey(iso) === dayKey(t.toISOString())) return 'Today';
  if (dayKey(iso) === dayKey(y.toISOString())) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
}
const timeOf = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const lenText = (m) => (TIMEOUT_LENGTHS.find(([v]) => v === m) || [0, m >= 1440 ? `${Math.round(m / 1440)} days` : `${m} min`])[1];
const initialOf = (s) => (cleanName(s || '?').trim()[0] || '?').toUpperCase();
const pgSafe = (s) => s.replace(/[%,()*\\]/g, ' ').trim();

async function renderCases(body) {
  clearInterval(maWatch);
  const st = { type: 'all', source: 'all', mine: false, pendingOnly: false, review: false, q: '', offset: 0, rows: [], done: false };
  if (maSupervisor === null) maSupervisor = await sb.rpc('is_supervisor').then((r) => !r.error && !!r.data, () => false);

  body.innerHTML = `
    <div class="ma-top">
      <div class="ma-stats" id="ma-stats">${['This week', 'Active warnings', 'Pending', maSupervisor ? 'Waiting for review' : 'Didn’t go through']
        .map((l, i) => `<button type="button" class="ma-stat" data-stat="${i}"><span class="ma-stat-n">–</span><span class="ma-stat-l">${l}</span></button>`).join('')}</div>
      <button type="button" class="refresh ma-new" id="ma-new">New action</button>
    </div>
    <div class="ma-tools">
      <label class="ma-search"><span class="h-glass" aria-hidden="true"></span><input id="ma-q" type="search" placeholder="Search a name or reason" aria-label="Search mod actions" autocomplete="off"></label>
      <div class="ma-chips" role="group" aria-label="Type">${MA_TYPES.map((t) => `<button type="button" class="chip${t.id === 'all' ? ' on' : ''}" data-type="${t.id}" aria-pressed="${t.id === 'all'}">${t.label}</button>`).join('')}</div>
      <div class="ma-filters">
        <div class="ma-seg" role="group" aria-label="Where">${[['all', 'Everywhere'], ['discord', 'Discord'], ['in_game', 'In game']].map(([v, l]) => `<button type="button" data-src="${v}" aria-pressed="${v === 'all'}">${l}</button>`).join('')}</div>
        <label class="ma-toggle"><input type="checkbox" id="ma-mine"><span class="pm-track" aria-hidden="true"></span>Only mine</label>
      </div>
    </div>
    <div id="ma-failed"></div>
    <div id="ma-list" class="ma-list" aria-live="polite"></div>
    <div class="ma-more"><button type="button" class="ghost" id="ma-more" hidden>Load more</button></div>`;

  const $b = (s) => body.querySelector(s);
  const list = $b('#ma-list');

  // ---------- stats ----------
  (async () => {
    const [hc, pend, rev] = await Promise.all([
      sb.rpc('home_counts').then((r) => r.data || {}, () => ({})),
      sb.from('mod_cases').select('id', { count: 'exact', head: true }).eq('status', 'pending').then((r) => r.count || 0, () => 0),
      maSupervisor ? sb.from('mod_cases').select('id', { count: 'exact', head: true }).eq('review_status', 'requested').then((r) => r.count || 0, () => 0) : Promise.resolve(null),
    ]);
    const vals = [hc.actions_week, hc.active_warnings, pend, maSupervisor ? rev : hc.failed_mine];
    body.querySelectorAll('.ma-stat').forEach((b, i) => {
      b.querySelector('.ma-stat-n').textContent = Number(vals[i] || 0);
      b.classList.toggle('alert', i === 3 && Number(vals[i] || 0) > 0);
    });
  })();
  $b('#ma-stats').onclick = (e) => {
    const b = e.target.closest('.ma-stat'); if (!b) return;
    const i = +b.dataset.stat;
    st.pendingOnly = i === 2 ? !st.pendingOnly : false;
    st.review = i === 3 && maSupervisor ? !st.review : false;
    if (i === 1) setType('warn');
    if (i === 0) setType('all');
    if (i === 3 && !maSupervisor) { $b('#ma-failed').scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
    body.querySelectorAll('.ma-stat').forEach((x) => x.classList.toggle('on', (x.dataset.stat === '2' && st.pendingOnly) || (x.dataset.stat === '3' && st.review)));
    load(true);
  };

  // ---------- toolbar ----------
  const setType = (t) => {
    st.type = t;
    body.querySelectorAll('[data-type]').forEach((x) => { x.classList.toggle('on', x.dataset.type === t); x.setAttribute('aria-pressed', String(x.dataset.type === t)); });
  };
  $b('.ma-chips').onclick = (e) => { const b = e.target.closest('[data-type]'); if (!b) return; setType(b.dataset.type); load(true); };
  $b('.ma-seg').onclick = (e) => {
    const b = e.target.closest('[data-src]'); if (!b) return;
    st.source = b.dataset.src;
    body.querySelectorAll('[data-src]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    load(true);
  };
  $b('#ma-mine').onchange = (e) => { st.mine = e.target.checked; load(true); };
  let qTimer = null;
  $b('#ma-q').oninput = (e) => { clearTimeout(qTimer); qTimer = setTimeout(() => { st.q = pgSafe(e.target.value); load(true); }, 250); };
  $b('#ma-more').onclick = () => load(false);
  $b('#ma-new').onclick = () => openCasePanel({}, () => load(true));

  // ---------- your failed actions ----------
  async function loadFailed() {
    const box = $b('#ma-failed');
    const { data, error } = await sb.from('mod_cases').select('*').eq('status', 'failed').eq('moderator_discord_id', myDiscordId).is('dismissed_at', null).order('id', { ascending: false }).limit(10);
    if (error || !(data || []).length) { box.innerHTML = ''; return; }
    box.innerHTML = `<section class="ma-failbox" aria-label="Didn't go through">
      <h2 class="ma-day bad">Didn’t go through <span class="count">${data.length}</span></h2>
      ${data.map((c) => `<div class="ma-frow" data-id="${c.id}">
        <span class="ma-act act act-${esc(c.action)}">${esc(ACTION_LABEL[c.action] || c.action)}</span>
        <div class="ma-main"><strong>${esc(cleanName(c.target_name || ''))}</strong><span class="ma-ferr">${esc(c.error || 'It didn’t go through.')}</span></div>
        <div class="ma-fbtns"><button type="button" class="ghost small-btn" data-retry="${c.id}">Try again</button><button type="button" class="linkish small-btn" data-dismiss="${c.id}">Dismiss</button></div></div>`).join('')}
    </section>`;
    box.querySelectorAll('[data-dismiss]').forEach((b) => { b.onclick = async () => { b.closest('.ma-frow').remove(); await sb.rpc('dismiss_failed', { case_id: +b.dataset.dismiss }); if (!box.querySelector('.ma-frow')) box.innerHTML = ''; loadFailNotices(); }; });
    box.querySelectorAll('[data-retry]').forEach((b) => {
      b.onclick = async () => {
        const c = data.find((x) => x.id === +b.dataset.retry);
        b.disabled = true;
        const { error: e } = await sb.from('mod_cases').insert({ action: c.action, target_name: c.target_name, target_discord_id: c.target_discord_id,
          reason: c.reason, duration_minutes: c.duration_minutes, source: 'website', status: 'pending', moderator_discord_id: myDiscordId, moderator_name: $('name').textContent }).select().single();
        if (e) { b.disabled = false; b.closest('.ma-frow').querySelector('.ma-ferr').textContent = 'Couldn’t try again: ' + e.message; return; }
        await sb.rpc('dismiss_failed', { case_id: c.id });
        loadFailed(); loadFailNotices(); load(true);
      };
    });
  }

  // ---------- the list ----------
  async function load(fresh) {
    if (fresh) { st.offset = 0; st.rows = []; list.innerHTML = skeletonRows(); }
    let q = sb.from('mod_cases').select('*').neq('status', 'failed').is('revoked_at', null).order('created_at', { ascending: false }).range(st.offset, st.offset + MA_PAGE - 1);
    if (st.type === 'timeout') q = q.in('action', ['timeout', 'untimeout']);
    else if (st.type !== 'all') q = q.eq('action', st.type);
    if (st.source === 'discord') q = q.in('source', ['discord', 'website']);
    else if (st.source === 'in_game') q = q.eq('source', 'in_game');
    if (st.mine) q = q.eq('moderator_discord_id', myDiscordId);
    if (st.pendingOnly) q = q.eq('status', 'pending');
    if (st.review) q = q.eq('review_status', 'requested');
    if (st.q) q = q.or(`target_name.ilike.%${st.q}%,reason.ilike.%${st.q}%`);
    const { data, error } = await q;
    if (error) { list.innerHTML = `<div class="card ma-empty"><strong>Couldn’t load mod actions.</strong><span>${esc(error.message)}. Check your connection, then try again.</span><button type="button" class="ghost small-btn" id="ma-retry">Try again</button></div>`; $b('#ma-retry').onclick = () => load(true); return; }
    st.rows = fresh ? data : st.rows.concat(data);
    st.offset += data.length;
    $b('#ma-more').hidden = data.length < MA_PAGE;
    draw();
    watchPending();
  }
  function skeletonRows() {
    return `<div class="card ma-group">${Array.from({ length: 5 }, () => `<div class="ma-row"><span class="sk round" style="width:38px;height:38px"></span><div style="flex:1">${lines('30%', '62%')}</div></div>`).join('')}</div>`;
  }
  function draw() {
    if (!st.rows.length) {
      const filtered = st.type !== 'all' || st.source !== 'all' || st.mine || st.q || st.pendingOnly || st.review;
      list.innerHTML = `<div class="card ma-empty"><strong>${filtered ? 'Nothing matches these filters.' : 'No mod actions yet.'}</strong>
        <span>${filtered ? 'Try a different search or filter.' : 'Actions you take here, with slash commands or in game show up in this list.'}</span>
        ${filtered ? '<button type="button" class="ghost small-btn" id="ma-clear">Clear filters</button>' : '<button type="button" class="refresh small-btn" id="ma-first">New action</button>'}</div>`;
      $b('#ma-clear')?.addEventListener('click', clearFilters);
      $b('#ma-first')?.addEventListener('click', () => openCasePanel({}, () => load(true)));
      return;
    }
    const groups = [];
    for (const c of st.rows) {
      const k = dayKey(c.created_at);
      if (!groups.length || groups[groups.length - 1].k !== k) groups.push({ k, label: dayLabel(c.created_at), rows: [] });
      groups[groups.length - 1].rows.push(c);
    }
    list.innerHTML = groups.map((g) => `<section class="ma-section"><h2 class="ma-day">${esc(g.label)}</h2><div class="card ma-group">${g.rows.map(rowHtml).join('')}</div></section>`).join('');
  }
  function clearFilters() {
    Object.assign(st, { type: 'all', source: 'all', mine: false, q: '', pendingOnly: false, review: false });
    setType('all'); $b('#ma-q').value = ''; $b('#ma-mine').checked = false;
    body.querySelectorAll('[data-src]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.src === 'all')));
    body.querySelectorAll('.ma-stat').forEach((x) => x.classList.remove('on'));
    load(true);
  }
  function rowHtml(c) {
    const name = cleanName(c.target_name || c.target_discord_id || 'Unknown');
    const nameEl = c.target_discord_id ? `<button type="button" class="ma-name" data-rec="${c.id}">${esc(name)}</button>`
      : c.target_roblox_id ? `<a class="ma-name" href="https://www.roblox.com/users/${encodeURIComponent(c.target_roblox_id)}/profile" target="_blank" rel="noopener">${esc(name)}</a>`
        : `<span class="ma-name plain">${esc(name)}</span>`;
    const review = c.review_status === 'requested' ? '<span class="ma-flag review">Waiting for review</span>'
      : c.review_status === 'reviewed' ? `<span class="ma-flag ${c.review_outcome}">${MA_OUTCOME[c.review_outcome] || 'Reviewed'}</span>` : '';
    return `<div class="ma-row" data-id="${c.id}">
      <span class="ma-av" aria-hidden="true">${esc(initialOf(name))}</span>
      <div class="ma-main">
        <div class="ma-line1">${nameEl}<span class="ma-act act act-${esc(c.action)}">${esc(ACTION_LABEL[c.action] || c.action)}</span>${c.duration_minutes ? `<span class="ma-len">${esc(lenText(c.duration_minutes))}</span>` : ''}${review}</div>
        <div class="ma-reason">${esc(c.reason || '')}</div>
        <div class="ma-meta">by ${esc(cleanName(c.moderator_name || 'unknown'))} · ${esc(MA_SOURCE[c.source] || c.source)} · ${timeOf(c.created_at)}</div>
        ${c.review_status === 'requested' ? `<div class="ma-rnote"><strong>${esc(cleanName(c.review_requested_by_name || 'An admin'))} asked for a review:</strong> ${esc(c.review_note || '')}</div>` : ''}
        ${c.review_status === 'reviewed' ? `<div class="ma-rnote done"><strong>${MA_OUTCOME[c.review_outcome] || 'Reviewed'} by ${esc(cleanName(c.reviewed_by_name || 'a supervisor'))}:</strong> ${esc(c.review_result_note || '')}</div>` : ''}
        <div class="ma-inline" hidden></div>
      </div>
      <div class="ma-side">
        ${c.status === 'pending' ? '<span class="ma-pending"><span class="ma-spin" aria-hidden="true"></span>Pending</span>' : ''}
        <button type="button" class="ma-dots" aria-label="More for ${esc(name)}" aria-haspopup="menu" aria-expanded="false" data-menu="${c.id}"><span></span></button>
      </div>
    </div>`;
  }

  // ---------- row menu ----------
  list.addEventListener('click', (e) => {
    const rec = e.target.closest('[data-rec]');
    if (rec) { const c = st.rows.find((x) => x.id === +rec.dataset.rec); rememberRecord(c.target_discord_id, cleanName(c.target_name || c.target_discord_id)); openRecord(c.target_discord_id); return; }
    const dots = e.target.closest('[data-menu]');
    if (dots) { openMenu(dots, st.rows.find((x) => x.id === +dots.dataset.menu)); }
  });
  function menuItems(c) {
    const items = [];
    if (c.target_discord_id) items.push(['record', 'Open record']);
    const tLeft = c.action === 'timeout' && c.status === 'done' && c.duration_minutes && (new Date(c.created_at).getTime() + c.duration_minutes * 6e4 > Date.now());
    if (tLeft && c.target_discord_id) items.push(['untimeout', 'Remove timeout']);
    if (c.action === 'ban' && c.status === 'done' && c.target_discord_id) items.push(['unban', 'Unban']);
    if (c.action === 'warn' && c.status === 'done' && access.exec && !c.revoked_at) items.push(['unwarn', 'Remove warning']);
    items.push(['copy', 'Copy details']);
    if (c.status === 'done' && c.review_status !== 'requested') items.push(['review', 'Send for supervisor review']);
    if (maSupervisor && c.review_status === 'requested' && c.moderator_discord_id !== myDiscordId && c.review_requested_by !== myDiscordId) items.push(['resolve', 'Review this action']);
    return items;
  }
  function openMenu(btn, c) {
    closeMenus();
    const m = document.createElement('div');
    m.className = 'ma-menu';
    m.setAttribute('role', 'menu');
    m.innerHTML = menuItems(c).map(([k, l]) => `<button type="button" role="menuitem" data-do="${k}"${k === 'unwarn' || k === 'unban' ? ' class="warnish"' : ''}>${l}</button>`).join('');
    btn.setAttribute('aria-expanded', 'true');
    btn.closest('.ma-side').append(m);
    m.querySelector('button')?.focus();
    m.onclick = (e) => { const b = e.target.closest('[data-do]'); if (!b) return; closeMenus(); doAction(b.dataset.do, c); };
    m.onkeydown = (e) => {
      const bs = [...m.querySelectorAll('button')], i = bs.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); bs[(i + 1) % bs.length].focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); bs[(i - 1 + bs.length) % bs.length].focus(); }
      if (e.key === 'Escape') { closeMenus(); btn.focus(); }
    };
  }
  function closeMenus() {
    body.querySelectorAll('.ma-menu').forEach((x) => x.remove());
    body.querySelectorAll('.ma-dots[aria-expanded="true"]').forEach((x) => x.setAttribute('aria-expanded', 'false'));
  }
  document.addEventListener('click', (e) => { if (body.isConnected && !e.target.closest('.ma-menu') && !e.target.closest('.ma-dots')) closeMenus(); });

  function inlineForm(c, { title, label, placeholder, button, danger, extra = '' }, submit) {
    const box = list.querySelector(`.ma-row[data-id="${c.id}"] .ma-inline`);
    box.hidden = false;
    box.innerHTML = `<form class="ma-iform"><strong>${title}</strong>${extra}
      <label class="f"><span>${label}</span><textarea rows="2" maxlength="1000" required placeholder="${esc(placeholder)}"></textarea></label>
      <p class="error" hidden></p>
      <div class="f-actions"><button type="button" class="linkish" data-x>Cancel</button><button type="submit" class="${danger ? 'refresh danger-fill' : 'refresh'}">${button}</button></div></form>`;
    const f = box.querySelector('form');
    f.querySelector('textarea').focus();
    f.querySelector('[data-x]').onclick = () => { box.hidden = true; box.innerHTML = ''; };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const er = f.querySelector('.error'), sbm = f.querySelector('[type=submit]');
      sbm.disabled = true; er.hidden = true;
      const msg = await submit(f.querySelector('textarea').value.trim(), f);
      if (msg) { er.textContent = msg; er.hidden = false; sbm.disabled = false; return; }
      box.hidden = true; box.innerHTML = '';
      load(true);
    };
  }
  async function newCase(c, action, reason) {
    const { error } = await sb.from('mod_cases').insert({ action, target_name: c.target_name, target_discord_id: c.target_discord_id, reason,
      source: 'website', status: 'pending', moderator_discord_id: myDiscordId, moderator_name: $('name').textContent }).select().single();
    return error ? error.message : null;
  }
  async function doAction(k, c) {
    const name = cleanName(c.target_name || '');
    if (k === 'record') { rememberRecord(c.target_discord_id, name); openRecord(c.target_discord_id); return; }
    if (k === 'copy') {
      const text = `${ACTION_LABEL[c.action] || c.action}: ${name}${c.duration_minutes ? ' (' + lenText(c.duration_minutes) + ')' : ''}\nReason: ${c.reason || ''}\nBy: ${cleanName(c.moderator_name || '')} · ${MA_SOURCE[c.source] || c.source} · ${new Date(c.created_at).toLocaleString()}\nCase ${c.id}${c.target_discord_id ? ' · Discord ID ' + c.target_discord_id : ''}`;
      const row = list.querySelector(`.ma-row[data-id="${c.id}"] .ma-meta`);
      try { await navigator.clipboard.writeText(text); flash(row, 'Copied'); } catch { flash(row, 'Couldn’t copy. Select the text instead.'); }
      return;
    }
    if (k === 'untimeout') inlineForm(c, { title: `Remove ${name}’s timeout?`, label: 'Reason', placeholder: 'e.g. Cooled down, apologised', button: 'Remove timeout' }, (r) => newCase(c, 'untimeout', r));
    if (k === 'unban') inlineForm(c, { title: `Unban ${name}?`, label: 'Reason', placeholder: 'e.g. Appeal accepted', button: 'Unban', danger: false }, (r) => newCase(c, 'unban', r));
    if (k === 'unwarn') inlineForm(c, { title: 'Remove this warning?', label: 'Why remove it?', placeholder: 'e.g. Given by mistake', button: 'Remove warning' },
      async (r) => { const { error } = await sb.rpc('revoke_warning', { case_id: c.id, reason: r }); return error ? error.message : null; });
    if (k === 'review') inlineForm(c, { title: 'Send for supervisor review', label: 'What should the supervisor look at?', placeholder: 'e.g. Not sure a ban was needed here', button: 'Send for review' },
      async (r) => { const { error } = await sb.rpc('request_review', { case_id: c.id, note: r }); return error ? (/function|does not exist/i.test(error.message) ? 'Supervisor review isn’t switched on yet.' : error.message) : null; });
    if (k === 'resolve') {
      inlineForm(c, { title: 'Your decision', label: 'Note for the record', placeholder: 'e.g. Right call, the messages were spam', button: 'Save decision',
        extra: `<div class="ma-seg ma-outcome" role="group" aria-label="Outcome">${Object.entries(MA_OUTCOME).map(([v, l], i) => `<button type="button" data-out="${v}" aria-pressed="${i === 0}">${l}</button>`).join('')}</div>` },
      async (r, f) => {
        const out = f.querySelector('[data-out][aria-pressed="true"]').dataset.out;
        const { error } = await sb.rpc('resolve_review', { case_id: c.id, outcome: out, note: r });
        return error ? error.message : null;
      });
      const seg = list.querySelector(`.ma-row[data-id="${c.id}"] .ma-outcome`);
      seg.onclick = (e) => { const b = e.target.closest('[data-out]'); if (!b) return; seg.querySelectorAll('[data-out]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); };
    }
  }
  function flash(el, text) {
    if (!el) return;
    const s = document.createElement('span'); s.className = 'ma-flash'; s.textContent = text; el.append(s);
    setTimeout(() => s.remove(), 1800);
  }

  // ---------- pending rows update in place ----------
  function watchPending() {
    clearInterval(maWatch);
    const ids = st.rows.filter((c) => c.status === 'pending').map((c) => c.id);
    if (!ids.length) return;
    maWatch = setInterval(async () => {
      if (!body.isConnected || location.hash !== '#admin/cases') { clearInterval(maWatch); return; }
      const { data } = await sb.from('mod_cases').select('*').in('id', ids);
      let changed = false;
      for (const c of data || []) {
        if (c.status === 'pending') continue;
        changed = true;
        const i = st.rows.findIndex((x) => x.id === c.id);
        const el = list.querySelector(`.ma-row[data-id="${c.id}"]`);
        if (c.status === 'failed') { st.rows.splice(i, 1); el?.remove(); }
        else { st.rows[i] = c; if (el) el.outerHTML = rowHtml(c); }
      }
      if (changed) { loadFailed(); loadFailNotices(); watchPending(); }
    }, 3000);
  }

  // ---------- start ----------
  loadFailed();
  await load(true);
  if (pendingCase) {   // from the home search or the Moderation folder's quick buttons
    const pc = pendingCase; pendingCase = null;
    openCasePanel({ action: pc.action, person: pc.person }, () => load(true));
  }
}

// ---------- New action: a 3-step side panel ----------
function openCasePanel(preset, onDone) {
  document.querySelector('.ma-panel-wrap')?.remove();
  const s = { step: 1, where: 'discord', action: DISCORD_ACTIONS.some((a) => a.id === preset.action) ? preset.action : null,
    person: null, roblox: null, history: null, len: 60, gameLen: '', reason: '' };
  const wrap = document.createElement('div');
  wrap.className = 'ma-panel-wrap';
  wrap.innerHTML = `<div class="ma-scrim"></div>
    <aside class="ma-panel" role="dialog" aria-modal="true" aria-labelledby="map-title">
      <div class="ma-phead"><h2 id="map-title">New action</h2><button type="button" class="h-x" aria-label="Close">&times;</button></div>
      <ol class="ma-steps">${['Who', 'What', 'Why'].map((l, i) => `<li data-step="${i + 1}"><span>${i + 1}</span>${l}</li>`).join('')}</ol>
      <div class="ma-pbody" id="map-body"></div>
      <div class="ma-pfoot" id="map-foot"></div>
    </aside>`;
  document.body.append(wrap);
  const opener = document.activeElement;
  const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); opener?.focus?.(); };
  const onKey = (e) => { if (e.key === 'Escape' && !wrap.querySelector('.ma-sugg:not([hidden])')) close(); };
  document.addEventListener('keydown', onKey);
  wrap.querySelector('.ma-scrim').onclick = close;
  wrap.querySelector('.h-x').onclick = close;
  const bodyEl = wrap.querySelector('#map-body'), foot = wrap.querySelector('#map-foot');
  const nameOf = () => s.where === 'discord' ? cleanName(s.person?.display_name || s.person?.username || s.person?.discord_id || '') : (s.roblox?.name || '');

  async function loadHistory() {
    s.history = null;
    if (s.where === 'discord' && s.person) {
      const [rec, lastWarn] = await Promise.all([
        sb.rpc('member_record', { discord_id: s.person.discord_id }).then((r) => r.data || null, () => null),
        sb.from('mod_cases').select('created_at').eq('target_discord_id', s.person.discord_id).eq('action', 'warn').eq('status', 'done').is('revoked_at', null).order('created_at', { ascending: false }).limit(1).then((r) => r.data?.[0] || null, () => null),
      ]);
      s.history = rec ? { warnings: +rec.warnings || 0, timeouts: +rec.timeouts || 0, kicks: +rec.kicks || 0, bans: +rec.bans || 0, banned: !!rec.banned, lastWarn: lastWarn?.created_at } : null;
    } else if (s.where === 'in_game' && s.roblox) {
      const { data } = await sb.from('mod_cases').select('action').eq('source', 'in_game').ilike('target_name', s.roblox.name);
      const n = (a) => (data || []).filter((x) => x.action === a).length;
      s.history = { warnings: n('warn'), kicks: n('kick'), bans: n('ban'), timeouts: 0 };
    }
    if (s.step === 1) draw();
  }
  const historyCard = () => {
    if (!s.person && !s.roblox) return '';
    const h = s.history;
    const who = s.where === 'discord'
      ? `<span class="ma-av big" aria-hidden="true">${esc(initialOf(nameOf()))}</span><span class="ma-hwho"><strong>${esc(nameOf())}</strong><span>${s.person.username ? '@' + esc(s.person.username) + ' · ' : ''}${esc(s.person.discord_id)}${s.person.banned ? ' · banned' : ''}</span></span>`
      : `<span class="ma-av big" aria-hidden="true">${esc(initialOf(nameOf()))}</span><span class="ma-hwho"><strong>${esc(s.roblox.displayName || s.roblox.name)}</strong><span>@${esc(s.roblox.name)} · Roblox</span></span>`;
    const facts = !h ? '<span class="muted small">Checking their history…</span>'
      : [h.warnings ? `${plural(h.warnings, 'warning')}${h.lastWarn ? ` (last ${when(h.lastWarn)})` : ''}` : 'No warnings',
        h.timeouts ? plural(h.timeouts, 'timeout') : '', h.kicks ? plural(h.kicks, 'kick') : '', h.bans ? plural(h.bans, 'ban') : ''].filter(Boolean).join(' · ');
    return `<div class="ma-hist">${who}<button type="button" class="ghost small-btn" id="map-change">Change</button><span class="ma-hfacts">${facts}</span></div>`;
  };
  function hint() {
    const h = s.history; if (!h || !s.action) return '';
    let t = '';
    if (s.action === 'warn' && h.warnings >= 2) t = `${esc(nameOf())} already has ${h.warnings} warnings. A timeout may be the next step.`;
    else if (s.action === 'timeout' && h.timeouts >= 2) t = `${esc(nameOf())} has been timed out ${h.timeouts} times. A kick may be the next step.`;
    else if (s.action === 'kick' && h.kicks >= 1) t = `${esc(nameOf())} has been kicked before. A ban may be the next step.`;
    else if (s.action === 'ban' && !h.warnings && !h.timeouts && !h.kicks) t = `${esc(nameOf())} has no warnings, timeouts or kicks on record. Check a ban is the right step.`;
    return t ? `<p class="ma-hint">${t}</p>` : '';
  }
  function draw() {
    wrap.querySelectorAll('.ma-steps li').forEach((li) => { const n = +li.dataset.step; li.classList.toggle('on', n === s.step); li.classList.toggle('done', n < s.step); });
    if (s.step === 1) {
      bodyEl.innerHTML = `
        <div class="f"><span>Where did it happen?</span><div class="ma-seg wide" role="group" aria-label="Where">
          <button type="button" data-w="discord" aria-pressed="${s.where === 'discord'}">Discord</button><button type="button" data-w="in_game" aria-pressed="${s.where === 'in_game'}">In game (Maple Hospital)</button></div></div>
        ${s.person || s.roblox ? historyCard() : s.where === 'discord'
          ? `<div class="f picker"><label for="map-q">Who</label><input id="map-q" placeholder="Name, username or Discord ID" autocomplete="off"><div class="sugg ma-sugg" id="map-sugg" role="listbox" hidden></div></div>`
          : `<label class="f"><span>Full Roblox username</span><input id="map-rb" maxlength="20" placeholder="e.g. Builderman" spellcheck="false" autocapitalize="off"><span class="field-note" id="map-rbn" hidden></span></label>`}`;
      foot.innerHTML = `<span></span><button type="button" class="refresh" id="map-next" ${s.person || s.roblox ? '' : 'disabled'}>Next</button>`;
      bodyEl.querySelectorAll('[data-w]').forEach((b) => { b.onclick = () => { if (s.where === b.dataset.w) return; s.where = b.dataset.w; s.person = null; s.roblox = null; s.history = null; s.action = null; draw(); }; });
      bodyEl.querySelector('#map-change')?.addEventListener('click', () => { s.person = null; s.roblox = null; s.history = null; draw(); });
      if (!s.person && !s.roblox) (s.where === 'discord' ? wirePicker : wireRoblox)();
    } else if (s.step === 2) {
      const acts = s.where === 'discord' ? ['warn', 'timeout', 'untimeout', 'kick', 'ban', ...(s.person?.banned ? ['unban'] : [])] : ['warn', 'kick', 'ban', 'note'];
      if (s.person?.banned && s.where === 'discord' && !s.action) s.action = 'unban';
      bodyEl.innerHTML = `${historyCard()}
        <div class="ma-tiles" role="radiogroup" aria-label="Action">${acts.map((a) => `<button type="button" role="radio" aria-checked="${s.action === a}" class="ma-tile${MA_ACTION_INFO[a].strong ? ' strong' : ''}" data-a="${a}">
          <strong>${MA_ACTION_INFO[a].label}</strong><span>${esc(s.where === 'in_game' ? MA_GAME_INFO[a] : MA_ACTION_INFO[a].blurb)}</span></button>`).join('')}</div>
        ${s.action === 'timeout' && s.where === 'discord' ? `<div class="f"><span>How long</span><div class="ma-lens">${TIMEOUT_LENGTHS.map(([v, l]) => `<button type="button" class="chip${s.len === v ? ' on' : ''}" data-len="${v}" aria-pressed="${s.len === v}">${l}</button>`).join('')}</div></div>` : ''}
        ${s.action === 'ban' && s.where === 'in_game' ? `<label class="f"><span>Length in minutes <em>(optional)</em></span><input id="map-glen" type="number" min="1" max="525600" value="${esc(s.gameLen)}" placeholder="Leave empty for permanent"></label>` : ''}
        ${hint()}`;
      foot.innerHTML = `<button type="button" class="linkish" id="map-back">Back</button><button type="button" class="refresh" id="map-next" ${s.action ? '' : 'disabled'}>Next</button>`;
      bodyEl.querySelectorAll('[data-a]').forEach((b) => { b.onclick = () => { s.action = b.dataset.a; draw(); bodyEl.querySelector(`[data-a="${s.action}"]`)?.focus(); }; });
      bodyEl.querySelectorAll('[data-len]').forEach((b) => { b.onclick = () => { s.len = +b.dataset.len; draw(); }; });
      bodyEl.querySelector('#map-glen')?.addEventListener('input', (e) => { s.gameLen = e.target.value; });
      bodyEl.querySelector('#map-change')?.addEventListener('click', () => { s.step = 1; s.person = null; s.roblox = null; s.history = null; draw(); });
    } else if (s.step === 3) {
      const nm = esc(nameOf());
      const summary = s.where === 'discord'
        ? { warn: `Warn ${nm} by DM and record it.`, timeout: `Time out ${nm} for ${esc(lenText(s.len))}.`, untimeout: `End ${nm}’s timeout.`, kick: `Kick ${nm} from the Discord server.`, ban: `Ban ${nm} from the Discord server.`, unban: `Unban ${nm}.` }[s.action]
        : `Record: ${MA_ACTION_INFO[s.action].label.toLowerCase()} ${nm} in Maple Hospital${s.action === 'ban' && +s.gameLen > 0 ? ` for ${esc(s.gameLen)} minutes` : ''}.`;
      bodyEl.innerHTML = `${historyCard()}
        <div class="f"><span>Quick reasons</span><div class="ma-lens">${MA_REASONS.map((r) => `<button type="button" class="chip" data-r="${esc(r)}">${esc(r)}</button>`).join('')}</div></div>
        <label class="f"><span>Reason</span><textarea id="map-why" rows="4" maxlength="1000" placeholder="What happened? This is shown to staff${s.where === 'discord' && ['warn', 'timeout', 'kick', 'ban'].includes(s.action) ? ' and sent to them by DM' : ''}.">${esc(s.reason)}</textarea><span class="field-note" id="map-count">${s.reason.length} / 1000</span></label>
        <div class="ma-review${MA_ACTION_INFO[s.action].strong ? ' strong' : ''}"><span class="ma-plabel">Review</span><strong>${summary}</strong></div>
        <p class="error" id="map-err" hidden></p>`;
      const btnText = s.where === 'discord' ? { warn: `Warn ${nm}`, timeout: `Time out ${nm}`, untimeout: 'Remove timeout', kick: `Kick ${nm}`, ban: `Ban ${nm}`, unban: `Unban ${nm}` }[s.action] : 'Save record';
      foot.innerHTML = `<button type="button" class="linkish" id="map-back">Back</button><button type="button" class="refresh${MA_ACTION_INFO[s.action].strong && s.where === 'discord' ? ' danger-fill' : ''}" id="map-go">${btnText}</button>`;
      const ta = bodyEl.querySelector('#map-why');
      ta.oninput = () => { s.reason = ta.value; bodyEl.querySelector('#map-count').textContent = `${ta.value.length} / 1000`; };
      bodyEl.querySelectorAll('[data-r]').forEach((b) => { b.onclick = () => { ta.value = ta.value.trim() ? `${ta.value.trim()} · ${b.dataset.r}` : b.dataset.r; ta.dispatchEvent(new Event('input')); ta.focus(); }; });
      foot.querySelector('#map-go').onclick = submit;
      ta.focus();
    } else {
      bodyEl.innerHTML = `<div class="ma-sent"><span class="ma-sent-ico" aria-hidden="true"></span><strong>${s.where === 'discord' ? 'Sent' : 'Saved'}</strong>
        <span>${s.where === 'discord' ? 'CareBeyond Helper is carrying it out. The list shows Pending, then Done. If it can’t, you’ll see why at the top of Mod actions.' : 'The record is saved and posted to #server-logs.'}</span></div>`;
      foot.innerHTML = `<button type="button" class="ghost" id="map-again">New action</button><button type="button" class="refresh" id="map-done">Done</button>`;
      foot.querySelector('#map-done').onclick = close;
      foot.querySelector('#map-again').onclick = () => { Object.assign(s, { step: 1, action: null, person: null, roblox: null, history: null, reason: '', gameLen: '' }); draw(); };
      foot.querySelector('#map-done').focus();
    }
    foot.querySelector('#map-back')?.addEventListener('click', () => { s.step -= 1; draw(); });
    foot.querySelector('#map-next')?.addEventListener('click', () => { s.step += 1; draw(); });
  }
  async function submit() {
    const er = bodyEl.querySelector('#map-err'), go = foot.querySelector('#map-go');
    const reason = s.reason.trim();
    if (!reason) { er.textContent = 'Add a reason. It’s kept on their record.'; er.hidden = false; bodyEl.querySelector('#map-why').focus(); return; }
    go.disabled = true; er.hidden = true;
    const row = s.where === 'discord'
      ? { action: s.action, target_name: s.person.display_name || s.person.username || s.person.discord_id, target_discord_id: s.person.discord_id, reason,
        duration_minutes: s.action === 'timeout' ? s.len : null, source: 'website', status: 'pending' }
      : { action: s.action, target_name: s.roblox.name, target_roblox_id: s.roblox.id ? String(s.roblox.id) : null, reason,
        duration_minutes: s.action === 'ban' && +s.gameLen > 0 ? +s.gameLen : null, source: 'in_game', status: 'done' };
    Object.assign(row, { moderator_discord_id: myDiscordId, moderator_name: $('name').textContent });
    const { error } = await sb.from('mod_cases').insert(row).select().single();
    if (error) { go.disabled = false; er.textContent = 'Couldn’t send it: ' + error.message; er.hidden = false; return; }
    s.step = 4; draw(); onDone && onDone();
  }
  function wirePicker() {
    const q = bodyEl.querySelector('#map-q'), sugg = bodyEl.querySelector('#map-sugg');
    let timer = null, results = [], active = 0;
    const pick = (m) => { s.person = m; draw(); loadHistory(); setTimeout(() => foot.querySelector('#map-next')?.focus(), 0); };
    const show = () => {
      const id = q.value.trim(), raw = /^\d{15,22}$/.test(id) && !results.some((m) => m.discord_id === id);
      sugg.innerHTML = results.map((m, i) => `<button type="button" role="option" class="sg${i === active ? ' on' : ''}" data-i="${i}">
          <span class="ma-av" aria-hidden="true">${esc(initialOf(m.display_name || m.username || m.discord_id))}</span>
          <span class="pk-main"><strong>${esc(cleanName(m.display_name || m.username || m.discord_id))}</strong><span class="muted small-meta">${m.username ? '@' + esc(m.username) + ' · ' : ''}${esc(m.discord_id)}${warnText(m.warnings)}</span></span>
          ${m.banned ? '<span class="st sub-denied">Banned</span>' : ''}</button>`).join('')
        + (raw ? `<button type="button" class="sg" data-raw="${esc(id)}"><span class="pk-main"><strong>Use ID ${esc(id)}</strong><span class="muted small-meta">Someone not in the server</span></span></button>` : '')
        + (!results.length && !raw && id.length >= 2 ? '<p class="muted small sg-empty">Nobody found. Try their username or Discord ID.</p>' : '');
      sugg.hidden = !sugg.innerHTML.trim();
    };
    q.oninput = () => {
      clearTimeout(timer);
      const term = q.value.trim();
      if (term.length < 2) { results = []; sugg.hidden = true; return; }
      timer = setTimeout(async () => {
        const { data, error } = await sb.rpc('mod_member_search', { q: term });
        if (q.value.trim() !== term) return;
        results = error ? [] : data || []; active = 0; show();
      }, 200);
    };
    q.onkeydown = (e) => {
      if (sugg.hidden || !results.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length; show(); }
      else if (e.key === 'Enter') { e.preventDefault(); pick(results[active]); }
      else if (e.key === 'Escape') { e.stopPropagation(); sugg.hidden = true; }
    };
    sugg.onclick = (e) => { const b = e.target.closest('.sg'); if (!b) return; pick(b.dataset.raw ? { discord_id: b.dataset.raw, display_name: 'ID ' + b.dataset.raw } : results[+b.dataset.i]); };
    q.focus();
  }
  function wireRoblox() {
    const inp = bodyEl.querySelector('#map-rb'), note = bodyEl.querySelector('#map-rbn');
    let t = null;
    const say = (cls, text) => { note.className = 'field-note ' + cls; note.textContent = text; note.hidden = !text; };
    inp.oninput = () => {
      clearTimeout(t); s.roblox = null;
      const name = inp.value.trim();
      if (!name) return say('', '');
      if (!/^[A-Za-z0-9_]{3,20}$/.test(name)) return say('bad', 'Roblox usernames are 3–20 letters, numbers or _ (no spaces). Use the username, not the display name.');
      say('', 'Checking…');
      t = setTimeout(async () => {
        const { data, error } = await sb.functions.invoke('roblox-user', { body: { username: name } });
        if (inp.value.trim() !== name) return;
        if (error || !data || !data.name) {
          let msg = 'Couldn’t check Roblox right now. Try again in a moment.';
          try { const j = await error.context.json(); if (j && j.error) msg = j.error; } catch { /* keep */ }
          return say('bad', msg);
        }
        s.roblox = data; draw(); loadHistory();
      }, 450);
    };
    inp.focus();
  }

  if (preset.person) { s.person = preset.person; s.step = s.action ? 3 : 2; loadHistory(); }
  draw();
  if (s.step > 1) loadHistory();
}

LIVE.cases = renderCases;
