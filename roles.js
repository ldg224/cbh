// Roles (#exec/roles): the website role editor (R1, Bravo; owner approved 18 Nov 2026). Executives only.
// Discord-style: the server's roles down the left in Discord's order (colour, name, member count, search); the open
// role on the right with tabs. This phase: Website (what the role can see and do on the site: hospital powers for any
// role, department powers and the change window for department ranks) and Members. Display, Bot commands, Discord
// permissions and History arrive in the next phases (the bot applies those in Discord).
// Back end: role_overview, role_members (0052); role_permissions + set_role_hperm (0050); rank_permissions +
// set_rank_perm / set_rank_window (0027-0039). The database enforces every rule; this page only shows them.
const RO_HOSP = [
  ['hosp.mod', 'Mod actions', 'Warn, time out, kick and ban, and see past actions'],
  ['hosp.records', 'Records', 'Look people up: their record, messages and photos'],
  ['hosp.logs', 'Discord logs', 'Joins, leaves, edits and deletes'],
  ['hosp.incidents', 'Incidents', 'Write up and read incident reports'],
  ['hosp.sessions', 'Run sessions', 'Start, schedule and end game sessions'],
];
const RO_DEPT = [
  ['dept.view', 'See this page', 'Overview and members'],
  ['activity.view', 'See activity', 'Hours and inactivity'],
  ['members.edit', 'Edit members', 'Ranks, add, remove'],
  ['history.view', 'See history', 'Changes and reasons'],
  ['meetings.manage', 'Run meetings', 'Schedule and cancel'],
  ['meetings.attendance', 'Attendance', 'Attendance and notes'],
  ['applications.review', 'Review applications', 'Review and decide'],
  ['applications.settings', 'Edit applications', 'Forms, settings, stages'],
  ['courses.manage', 'Edit courses', 'Create and edit courses'],
  ['courses.assess', 'Assess courses', 'Practical evaluations'],
];
const RO_TABS = [['website', 'Website'], ['members', 'Members'], ['display', 'Display', true], ['commands', 'Bot commands', true], ['discord', 'Discord', true], ['history', 'History', true]];
const roState = { open: null, tab: 'website', q: '' };

async function renderRoles(body) {
  body.innerHTML = '<div class="card"><p class="muted small">Loading roles…</p></div>';
  const [ov, hp, rp] = await Promise.all([
    sb.rpc('role_overview'),
    sb.from('role_permissions').select('role_id, perm, granted_by, granted_at'),
    sb.from('rank_permissions').select('role_id, perm, window_lo, window_hi'),
  ]);
  if (ov.error) { body.innerHTML = ''; return liveError(body, ov.error); }
  const roles = (ov.data || []).filter((r) => r.name !== '@everyone');
  const byId = Object.fromEntries(roles.map((r) => [r.id, r]));
  const hset = new Set((hp.data || []).map((x) => x.role_id + '|' + x.perm));
  const dmap = Object.fromEntries((rp.data || []).map((x) => [x.role_id + '|' + x.perm, x]));
  const colour = (r) => (r.color ? hex(r.color) : r.badge_color ? hex(r.badge_color) : '#9aa9c4');
  const kindLabel = (r) => r.kind === 'rank' ? `${r.department} rank` : r.kind === 'department' ? `${r.department} (hidden division role)`
    : ({ leadership: 'Leadership', executive: 'Executive', verified: 'Verified', bot: 'Bot', community: 'Server Booster', status: 'Status', ping: 'Ping role' }[r.kind] || 'Other role');
  if (!roState.open || !byId[roState.open]) roState.open = roles[0]?.id || null;

  // Groups, like Discord's list but sorted into what they are.
  const groups = [
    ['Leadership', roles.filter((r) => r.kind === 'leadership' || r.kind === 'executive')],
    ...DEPARTMENTS.map((d) => [d.name, roles.filter((r) => r.department === d.name).sort((a, b) => (b.kind === 'department') - (a.kind === 'department') || (b.rank_order || 0) - (a.rank_order || 0))]),
    ['Other roles', roles.filter((r) => !r.department && !['leadership', 'executive', 'bot', 'community'].includes(r.kind))],
    ['Bots and boosters', roles.filter((r) => r.kind === 'bot' || r.kind === 'community')],
  ].filter(([, l]) => l.length);

  body.innerHTML = `<div class="ro-wrap">
    <aside class="ro-list" aria-label="Roles">
      <label class="ro-search"><span class="h-glass" aria-hidden="true"></span><input type="search" id="ro-q" placeholder="Find a role" autocomplete="off" aria-label="Find a role" value="${esc(roState.q)}"></label>
      <div class="ro-groups" id="ro-groups"></div>
    </aside>
    <section class="ro-main" id="ro-main" aria-live="polite"></section></div>`;
  const listEl = body.querySelector('#ro-groups'), main = body.querySelector('#ro-main');

  function drawList() {
    const q = roState.q.trim().toLowerCase();
    listEl.innerHTML = groups.map(([g, list]) => {
      const rows = list.filter((r) => !q || r.name.toLowerCase().includes(q));
      return rows.length ? `<div class="ro-g">${esc(g)}</div>${rows.map((r) => `<button type="button" class="ro-item" data-role="${esc(r.id)}" aria-current="${r.id === roState.open}" style="--c:${colour(r)}">
        <span class="ro-dot"></span><span class="ro-nm">${esc(cleanName(r.name) || r.name)}</span><span class="ro-cnt">${r.members}</span></button>`).join('')}` : '';
    }).join('') || '<p class="muted small">No role matches that.</p>';
  }
  function drawMain() {
    const r = byId[roState.open];
    if (!r) { main.innerHTML = '<p class="muted">Pick a role.</p>'; return; }
    main.innerHTML = `<header class="ro-head" style="--c:${colour(r)}"><span class="ro-swatch" aria-hidden="true"></span>
        <div><h2>${esc(cleanName(r.name) || r.name)}</h2><span class="muted small-meta">${esc(kindLabel(r))} · ${r.members} member${r.members === 1 ? '' : 's'}</span></div></header>
      <div class="dp-tabs ro-tabs" role="tablist">${RO_TABS.map(([id, l, soon]) => `<button type="button" role="tab" data-rtab="${id}" aria-selected="${roState.tab === id}"${soon ? ' class="soon"' : ''}>${l}${soon ? ' <span class="dp-soon">Soon</span>' : ''}</button>`).join('')}</div>
      <p class="error" id="ro-err" hidden></p>
      <div id="ro-pane"></div>`;
    const pane = main.querySelector('#ro-pane');
    if (roState.tab === 'website') drawWebsite(r, pane);
    else if (roState.tab === 'members') drawMembers(r, pane);
    else pane.innerHTML = `<div class="card"><p class="muted">${{ display: 'Change the role’s name, colour and order here. CareBeyond Helper will apply it in Discord.',
      commands: 'Choose which bot commands (/warn, /timeout, /kick, /ban, /unban) this role can use.',
      discord: 'The role’s Discord permissions. Dangerous ones (Administrator, Ban, Manage Roles…) will need you to type the role’s name to confirm.',
      history: 'Every change to this role: who, what and when.' }[roState.tab]}</p><p class="muted small">Coming in the next part of the role editor.</p></div>`;
  }
  const sw = (key, on, label, hint, disabled) => `<label class="ro-sw${disabled ? ' off' : ''}"><input type="checkbox" data-perm="${key}"${on ? ' checked' : ''}${disabled ? ' disabled' : ''}>
      <span class="dp-sw" aria-hidden="true"></span><span class="ro-swl"><b>${esc(label)}</b><small>${esc(hint)}</small></span></label>`;
  function drawWebsite(r, pane) {
    const all = r.kind === 'leadership' || r.kind === 'executive', none = r.kind === 'bot' || r.kind === 'community';
    const isRank = r.kind === 'rank', isDir = isRank && r.rank_label === 'Director';
    const ranks = roles.filter((x) => x.kind === 'rank' && x.department === r.department && x.rank_label !== 'Director').sort((a, b) => a.rank_order - b.rank_order);
    const w = dmap[r.id + '|members.edit'];
    pane.innerHTML = `
      <section class="card ro-sec"><div class="ro-sh"><h3>Hospital</h3><span class="muted small-meta">Tools for the whole hospital</span></div>
        ${all ? '<p class="ro-note">Leadership and executive roles can always do everything.</p>' : none ? '<p class="ro-note">Bot and booster roles can’t be given website permissions.</p>' : ''}
        <div class="ro-grid">${RO_HOSP.map(([k, l, h]) => sw('h:' + k, all || hset.has(r.id + '|' + k), l, h, all || none)).join('')}</div></section>
      ${isRank ? `<section class="card ro-sec"><div class="ro-sh"><h3>${esc(r.department)}</h3><span class="muted small-meta">What this rank can do on the ${esc(r.department)} page</span></div>
        ${isDir ? `<p class="ro-note">The ${esc(r.department)} Director can always do everything in their department.</p>` : ''}
        <div class="ro-grid">${RO_DEPT.map(([k, l, h]) => sw('d:' + k, isDir || !!dmap[r.id + '|' + k], l, h, isDir || (k === 'members.edit' && r.rank_order <= Math.min(...ranks.map((x) => x.rank_order)))))
          .join('')}</div>
        ${!isDir && w ? `<div class="ro-win">Can change members from <select data-win="lo">${ranks.filter((x) => x.rank_order < r.rank_order).map((x) => `<option value="${x.rank_order}"${x.rank_order === w.window_lo ? ' selected' : ''}>${esc(x.rank_label)}</option>`).join('')}</select>
          to <select data-win="hi">${ranks.filter((x) => x.rank_order < r.rank_order).map((x) => `<option value="${x.rank_order}"${x.rank_order === w.window_hi ? ' selected' : ''}>${esc(x.rank_label)}</option>`).join('')}</select></div>` : ''}</section>`
      : r.kind === 'department' ? `<section class="card ro-sec"><p class="ro-note">This hidden role only marks membership of ${esc(r.department)}. Department powers are set on its ranks.</p></section>` : ''}`;
  }
  async function drawMembers(r, pane) {
    pane.innerHTML = '<div class="card"><p class="muted small">Loading…</p></div>';
    const { data, error } = await sb.rpc('role_members', { role_id: r.id });
    if (error) { pane.innerHTML = `<p class="error">${esc(error.message)}</p>`; return; }
    const list = data || [];
    pane.innerHTML = `<div class="card ro-mem">${list.length ? list.map((m) => `<div class="ro-mrow">${face({ name: m.display_name, discordId: m.discord_id, avatarUrl: m.avatar_url, size: 's' })}<span>${esc(cleanName(m.display_name))}</span></div>`).join('') : '<p class="muted small">Nobody has this role.</p>'}</div>
      <p class="muted small ro-foot">${r.kind === 'rank' ? `Add, promote or remove people on the <a href="#directors/${DEPARTMENTS.find((d) => d.name === r.department)?.id || ''}/members">${esc(r.department)} Members page</a>.` : 'Adding and removing people here comes in the next part of the role editor.'}</p>`;
    loadFaces(pane);
  }

  // events
  body.querySelector('#ro-q').oninput = (e) => { roState.q = e.target.value; drawList(); };
  listEl.onclick = (e) => { const b = e.target.closest('[data-role]'); if (!b) return; roState.open = b.dataset.role; drawList(); drawMain(); };
  main.onclick = (e) => { const t = e.target.closest('[data-rtab]'); if (t) { roState.tab = t.dataset.rtab; drawMain(); } };
  main.onchange = async (e) => {
    const r = byId[roState.open], err = main.querySelector('#ro-err'); err.hidden = true;
    const cb = e.target.closest('[data-perm]'), win = e.target.closest('[data-win]');
    if (cb) {
      const [scope, perm] = [cb.dataset.perm.slice(0, 1), cb.dataset.perm.slice(2)];
      cb.disabled = true;
      const { error } = scope === 'h' ? await sb.rpc('set_role_hperm', { role_id: r.id, perm, allow: cb.checked })
        : await sb.rpc('set_rank_perm', { role_id: r.id, perm, allow: cb.checked });
      cb.disabled = false;
      if (error) { cb.checked = !cb.checked; err.textContent = error.message; err.hidden = false; return; }
      if (scope === 'h') { cb.checked ? hset.add(r.id + '|' + perm) : hset.delete(r.id + '|' + perm); }
      else {
        const { data } = await sb.from('rank_permissions').select('role_id, perm, window_lo, window_hi').eq('role_id', r.id);
        Object.keys(dmap).filter((k) => k.startsWith(r.id + '|')).forEach((k) => delete dmap[k]);
        (data || []).forEach((x) => { dmap[x.role_id + '|' + x.perm] = x; });
        drawMain();
      }
    }
    if (win) {
      const lo = +main.querySelector('[data-win="lo"]').value, hi = +main.querySelector('[data-win="hi"]').value;
      if (lo > hi) { err.textContent = 'The lowest rank must be at or below the highest.'; err.hidden = false; return; }
      const { error } = await sb.rpc('set_rank_window', { role_id: r.id, lo, hi });
      if (error) { err.textContent = error.message; err.hidden = false; return; }
      dmap[r.id + '|members.edit'] = { ...dmap[r.id + '|members.edit'], window_lo: lo, window_hi: hi };
    }
  };
  drawList(); drawMain();
}
LIVE.roles = renderRoles;
