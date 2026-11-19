// Roles (#exec/roles): the website role editor (R1, Bravo; owner: "works like Discord's: all the roles in the server,
// categorised, and you can literally go in and change everything, with tabs like Display, Members and Permissions").
// Executives only. The server's roles down the left (grouped, Discord order, colour, member count, search); the open
// role on the right with four tabs:
//   Display      name, colour, shown separately, mentionable, and moving it up or down
//   Permissions  Website (hospital tools; department powers and change window for ranks), Bot commands, Discord
//   Members      who has it; give it to someone or take it away
//   History      every change: website switches (role_log) and Discord changes with their result (role_edits)
// Discord changes go through request_role_edit() into a queue that CareBeyond Helper applies (0053, bot role_editor);
// website switches save straight away (set_role_hperm 0050, set_role_cmd 0053, set_rank_perm/set_rank_window).
// The database enforces every rule; this page only shows them.
const RO_HOSP = [
  ['hosp.mod', 'Mod actions', 'Warn, time out, kick and ban, and see past actions'],
  ['hosp.records', 'Records', 'Look people up: their record, messages and photos'],
  ['hosp.logs', 'Discord logs', 'Joins, leaves, edits and deletes'],
  ['hosp.incidents', 'Incidents', 'Write up and read incident reports'],
  ['hosp.sessions', 'Run sessions', 'Start, schedule and end game sessions'],
  ['hosp.supervise', 'Supervise sessions', 'Run the Chart floor plan: assign patients, give rooms, end the session'],
];
const RO_DEPT = [
  ['dept.view', 'See this page', 'Overview and members'],
  ['activity.view', 'See activity', 'Hours and inactivity'],
  ['members.edit', 'Edit members', 'Ranks, add, remove'],
  ['history.view', 'See history', 'Changes and reasons'],
  ['meetings.manage', 'Run meetings', 'Schedule and cancel'],
  ['meetings.attendance', 'Attendance', 'Attendance and notes'],
  ['posts.manage', 'Post updates', 'Post as From the Director'],
  ['applications.review', 'Review applications', 'Review and decide'],
  ['applications.settings', 'Edit applications', 'Forms, settings, stages'],
  ['courses.manage', 'Edit courses', 'Create and edit courses'],
  ['courses.assess', 'Assess courses', 'Practical evaluations'],
  ['chart.history_edit', 'Edit chart history', 'Correct or delete Chart records'],
];
const RO_CMDS = [
  ['warn', '/warn', 'Give someone a warning'], ['timeout', '/timeout', 'Time someone out'],
  ['untimeout', '/untimeout', 'End a timeout early'], ['kick', '/kick', 'Kick someone from the server'],
  ['ban', '/ban', 'Ban someone'], ['unban', '/unban', 'Lift a ban'],
];
// Discord permissions, grouped as Discord shows them. [bit, name, hint, dangerous]
const RO_DISCORD = [
  ['General', [[10, 'View channels', 'See channels by default'], [4, 'Manage channels', 'Create, edit and delete channels', 1],
    [28, 'Manage roles', 'Create and edit roles below their own', 1], [30, 'Manage expressions', 'Emoji, stickers and sounds', 1],
    [7, 'View audit log', 'See who changed what'], [29, 'Manage webhooks', 'Create and edit webhooks', 1], [5, 'Manage server', 'Server name, region and settings', 1]]],
  ['Members', [[0, 'Create invite', 'Invite new people'], [26, 'Change nickname', 'Their own nickname'], [27, 'Manage nicknames', 'Other people’s nicknames', 1],
    [1, 'Kick members', 'Remove people from the server', 1], [2, 'Ban members', 'Ban people from the server', 1], [40, 'Time out members', 'Stop people talking for a while', 1]]],
  ['Text', [[11, 'Send messages', 'In text channels'], [38, 'Send messages in threads', ''], [35, 'Create public threads', ''], [36, 'Create private threads', ''],
    [14, 'Embed links', 'Link previews'], [15, 'Attach files', 'Upload images and files'], [6, 'Add reactions', ''], [18, 'Use external emoji', ''],
    [17, 'Mention @everyone, @here and all roles', 'Ping the whole server', 1], [13, 'Manage messages', 'Delete and pin other people’s messages', 1],
    [34, 'Manage threads', 'Rename, archive and delete threads'], [16, 'Read message history', ''], [31, 'Use application commands', 'Slash commands']]],
  ['Voice', [[20, 'Connect', 'Join voice channels'], [21, 'Speak', ''], [9, 'Video', ''], [22, 'Mute members', 'In voice'], [23, 'Deafen members', 'In voice'],
    [24, 'Move members', 'Between voice channels'], [8, 'Priority speaker', '']]],
  ['Advanced', [[3, 'Administrator', 'Every permission, and bypasses every channel setting. Give it with great care.', 1]]],
];
const RO_TABS = [['display', 'Display'], ['perms', 'Permissions'], ['members', 'Members'], ['history', 'History']];
const roState = { open: null, tab: 'display', q: '' };
const roBit = (perms, bit) => ((BigInt(perms || '0') >> BigInt(bit)) & 1n) === 1n;

async function renderRoles(body) {
  body.innerHTML = '<div class="card"><p class="muted small">Loading roles…</p></div>';
  const [ov, hp, rp, cp, okq, stq] = await Promise.all([
    sb.rpc('role_overview'),
    sb.from('role_permissions').select('role_id, perm'),
    sb.from('rank_permissions').select('role_id, perm, window_lo, window_hi'),
    sb.from('role_cmd_perms').select('role_id, command'),
    sb.from('office_keys').select('department, role_id, active'),   // R2 (0058): bot-managed office keys
    sb.from('status_roles').select('role_id'),                      // R2 (0058): bot-managed On Shift / On Break
  ]);
  // Roles CareBeyond Helper hands out by itself: giving or taking them here would just be undone.
  const autoKey = Object.fromEntries((okq.data || []).filter((k) => k.active).map((k) => [k.role_id, k.department]));
  const autoStatus = new Set((stq.data || []).map((x) => x.role_id));
  if (ov.error) { body.innerHTML = ''; return liveError(body, ov.error); }
  const roles = (ov.data || []).filter((r) => r.name !== '@everyone');
  const byId = Object.fromEntries(roles.map((r) => [r.id, r]));
  const hset = new Set((hp.data || []).map((x) => x.role_id + '|' + x.perm));
  const cset = new Set((cp.data || []).map((x) => x.role_id + '|' + x.command));
  const dmap = Object.fromEntries((rp.data || []).map((x) => [x.role_id + '|' + x.perm, x]));
  const colour = (r) => (r.color ? hex(r.color) : r.badge_color ? hex(r.badge_color) : '#9aa9c4');
  const kindLabel = (r) => r.kind === 'rank' ? `${r.department} rank` : r.kind === 'department' ? `${r.department} (hidden division role)`
    : ({ leadership: 'Leadership', executive: 'Executive', verified: 'Verified', bot: 'Bot', community: 'Server Booster', status: 'Status', ping: 'Ping role' }[r.kind] || 'Other role');
  const editable = (r) => !r.managed && r.bot_can_edit === true;
  const lockWhy = (r) => r.managed ? 'This role belongs to a bot or to Discord, so only they can change it.'
    : r.bot_can_edit === false ? 'This role is above CareBeyond Helper’s own role, so the bot can’t change it in Discord. To edit it here, move CareBeyond Helper higher in Discord (Server Settings, Roles).'
    : 'CareBeyond Helper hasn’t reported this role yet. Try again in a minute.';
  if (!roState.open || !byId[roState.open]) roState.open = roles[0]?.id || null;
  let pending = [];   // this role's waiting Discord changes
  let poll = null;

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
        <span class="ro-dot"></span><span class="ro-nm">${esc(cleanName(r.name) || r.name)}</span>${editable(r) ? '' : '<span class="ro-lock" title="CareBeyond Helper can’t change this role in Discord" aria-label="Locked"></span>'}<span class="ro-cnt">${r.members}</span></button>`).join('')}` : '';
    }).join('') || '<p class="muted small">No role matches that.</p>';
  }
  const err = (msg) => { const e = main.querySelector('#ro-err'); if (!e) return; e.textContent = msg || ''; e.hidden = !msg; };

  async function loadPending(r) {
    const { data } = await sb.from('role_edits').select('id, kind, summary, status, error, created_at').eq('role_id', r.id)
      .gte('created_at', new Date(Date.now() - 10 * 60e3).toISOString()).order('id', { ascending: false }).limit(10);
    const rows = data || [];
    pending = rows.filter((x) => x.status === 'pending');
    const failed = rows.filter((x) => x.status === 'failed').slice(0, 1);
    const box = main.querySelector('#ro-queue');
    if (box) box.innerHTML = pending.length ? `<div class="ro-wait"><span class="ro-spin" aria-hidden="true"></span><div><b>Sending ${pending.length === 1 ? 'a change' : pending.length + ' changes'} to Discord…</b>
        <small>${pending.map((x) => esc(x.summary || x.kind)).join(' · ')}</small></div></div>`
      : failed.length ? `<div class="ro-fail"><b>That didn’t work in Discord:</b> ${esc(failed[0].summary || '')}. ${esc(failed[0].error || '')}</div>` : '';
    clearTimeout(poll);
    if (pending.length) poll = setTimeout(async () => {
      if (!document.body.contains(main) || roState.open !== r.id) return;
      const before = pending.length; await loadPending(r);
      if (pending.length < before) refreshRoles();
    }, 4000);
  }
  async function refreshRoles() {   // after the bot applies a change, pull the role again (name, colour, members…)
    const { data } = await sb.rpc('role_overview');
    (data || []).forEach((x) => { if (byId[x.id]) Object.assign(byId[x.id], x); });
    drawList(); if (roState.tab !== 'members' && roState.tab !== 'history') drawMain();
  }
  async function send(r, kind, payload, confirm) {
    err('');
    const { error } = await sb.rpc('request_role_edit', { role_id: r.id, kind, payload, confirm: confirm || null });
    if (error) { err(error.message); return false; }
    await loadPending(r); return true;
  }

  function drawMain() {
    const r = byId[roState.open];
    if (!r) { main.innerHTML = '<p class="muted">Pick a role.</p>'; return; }
    main.innerHTML = `<header class="ro-head" style="--c:${colour(r)}"><span class="ro-swatch" aria-hidden="true"></span>
        <div><h2>${esc(cleanName(r.name) || r.name)}</h2><span class="muted small-meta">${esc(kindLabel(r))} · ${r.members} member${r.members === 1 ? '' : 's'}</span></div></header>
      <div class="dp-tabs ro-tabs" role="tablist">${RO_TABS.map(([id, l]) => `<button type="button" role="tab" data-rtab="${id}" aria-selected="${roState.tab === id}">${l}</button>`).join('')}</div>
      <div id="ro-queue"></div>
      <p class="error" id="ro-err" hidden></p>
      <div id="ro-pane"></div>`;
    const pane = main.querySelector('#ro-pane');
    ({ display: drawDisplay, perms: drawPerms, members: drawMembers, history: drawHistory })[roState.tab](r, pane);
    loadPending(r);
  }
  const sw = (key, on, label, hint, disabled, danger) => `<label class="ro-sw${disabled ? ' off' : ''}${danger ? ' danger' : ''}"><input type="checkbox" data-perm="${key}"${on ? ' checked' : ''}${disabled ? ' disabled' : ''}>
      <span class="dp-sw" aria-hidden="true"></span><span class="ro-swl"><b>${esc(label)}${danger ? ' <span class="ro-dz">Dangerous</span>' : ''}</b>${hint ? `<small>${esc(hint)}</small>` : ''}</span></label>`;
  const lockNote = (r) => editable(r) ? '' : `<p class="ro-note ro-locknote">${esc(lockWhy(r))}</p>`;

  // ---------- Display ----------
  function drawDisplay(r, pane) {
    const ed = editable(r), c = r.color ? hex(r.color) : '#99aab5';
    const sorted = roles.slice().sort((a, b) => b.position - a.position), i = sorted.findIndex((x) => x.id === r.id);
    const above = sorted[i - 1], below = sorted[i + 1];
    const canUp = ed && above && editable(above), canDown = ed && !!below;
    pane.innerHTML = `${lockNote(r)}
      <form class="card ro-sec ro-disp" id="ro-disp">
        <label class="f"><span>Role name</span><input name="name" maxlength="100" value="${esc(r.name)}" ${ed ? '' : 'disabled'} required></label>
        <div class="f"><span>Colour</span><div class="ro-colour">
          <input type="color" name="color" value="${c}" ${ed ? '' : 'disabled'} aria-label="Pick a colour">
          <input name="hex" value="${c}" maxlength="7" pattern="#[0-9a-fA-F]{6}" ${ed ? '' : 'disabled'} aria-label="Colour code">
          ${ed ? '<button type="button" class="ghost small-btn" data-nocolour>No colour</button>' : ''}</div></div>
        ${sw('hoist', !!r.hoist, 'Show separately', 'List people with this role on their own in the member list', !ed)}
        ${sw('mentionable', !!r.mentionable, 'Anyone can @mention this role', 'Otherwise only people who can mention all roles can', !ed)}
        ${ed ? '<div class="ro-act"><button type="submit" class="primary">Save changes</button></div>' : ''}
      </form>
      <section class="card ro-sec"><div class="ro-sh"><h3>Order</h3><span class="muted small-meta">Higher roles show first and outrank lower ones</span></div>
        <div class="ro-order">
          <span class="muted small">${above ? 'Above it: <b>' + esc(cleanName(above.name) || above.name) + '</b>' : 'This is the top role'}</span>
          <span class="muted small">${below ? 'Below it: <b>' + esc(cleanName(below.name) || below.name) + '</b>' : 'This is the lowest role'}</span>
          <div class="ro-act"><button type="button" class="ghost" data-move="up" ${canUp ? '' : 'disabled'}>Move up</button>
          <button type="button" class="ghost" data-move="down" ${canDown ? '' : 'disabled'}>Move down</button></div></div></section>`;
    if (!ed) return;
    const f = pane.querySelector('#ro-disp');
    f.color.oninput = () => { f.hex.value = f.color.value; delete f.dataset.nocolour; };
    f.hex.oninput = () => { if (/^#[0-9a-f]{6}$/i.test(f.hex.value)) { f.color.value = f.hex.value; delete f.dataset.nocolour; } };
    pane.querySelector('[data-nocolour]').onclick = () => { f.hex.value = '#000000'; f.color.value = '#000000'; f.dataset.nocolour = '1'; };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const p = {};
      if (f.name.value.trim() !== r.name) p.name = f.name.value.trim();
      const col = f.dataset.nocolour ? 0 : parseInt(f.hex.value.slice(1), 16);
      if ((f.dataset.nocolour || /^#[0-9a-f]{6}$/i.test(f.hex.value)) && col !== (r.color || 0)) p.color = col;
      const ho = f.querySelector('[data-perm="hoist"]').checked, me = f.querySelector('[data-perm="mentionable"]').checked;
      if (ho !== !!r.hoist) p.hoist = ho;
      if (me !== !!r.mentionable) p.mentionable = me;
      if (!Object.keys(p).length) return err('Nothing has changed.');
      const b = f.querySelector('[type=submit]'); b.disabled = true;
      await send(r, 'display', p); b.disabled = false;
    };
    pane.querySelectorAll('[data-move]').forEach((b) => { b.onclick = async () => {
      b.disabled = true;
      await send(r, 'position', { position: b.dataset.move === 'up' ? above.position : Math.max(1, below.position) });
    }; });
  }

  // ---------- Permissions ----------
  function drawPerms(r, pane) {
    const all = OWNER_ROLES.includes(r.id), none = r.kind === 'bot' || r.kind === 'community' || r.managed;
    const isRank = r.kind === 'rank', isDir = isRank && r.rank_label === 'Director';
    const ranks = roles.filter((x) => x.kind === 'rank' && x.department === r.department && x.rank_label !== 'Director').sort((a, b) => a.rank_order - b.rank_order);
    const w = dmap[r.id + '|members.edit'], ed = editable(r);
    pane.innerHTML = `
      <section class="card ro-sec"><div class="ro-sh"><h3>Website</h3><span class="muted small-meta">Hospital tools</span></div>
        ${all ? '<p class="ro-note">The Hospital Director and Chief Operations Officer can always do everything.</p>' : none ? '<p class="ro-note">Bot and booster roles can’t be given website permissions.</p>' : ''}
        <div class="ro-grid">${RO_HOSP.map(([k, l, h]) => sw('h:' + k, all || hset.has(r.id + '|' + k), l, h, all || none)).join('')}</div></section>
      ${isRank ? `<section class="card ro-sec"><div class="ro-sh"><h3>${esc(r.department)}</h3><span class="muted small-meta">What this rank can do on the ${esc(r.department)} page</span></div>
        ${isDir ? `<p class="ro-note">The ${esc(r.department)} Director can always do everything in their department.</p>` : ''}
        <div class="ro-grid">${RO_DEPT.map(([k, l, h]) => sw('d:' + k, isDir || !!dmap[r.id + '|' + k], l, h, isDir || (k === 'members.edit' && r.rank_order <= Math.min(...ranks.map((x) => x.rank_order))))).join('')}</div>
        ${!isDir && w ? `<div class="ro-win">Can change members from <select data-win="lo">${ranks.filter((x) => x.rank_order < r.rank_order).map((x) => `<option value="${x.rank_order}"${x.rank_order === w.window_lo ? ' selected' : ''}>${esc(x.rank_label)}</option>`).join('')}</select>
          to <select data-win="hi">${ranks.filter((x) => x.rank_order < r.rank_order).map((x) => `<option value="${x.rank_order}"${x.rank_order === w.window_hi ? ' selected' : ''}>${esc(x.rank_label)}</option>`).join('')}</select></div>` : ''}</section>` : ''}
      <section class="card ro-sec"><div class="ro-sh"><h3>Bot Commands</h3><span class="muted small-meta">CareBeyond Helper’s moderation commands in Discord</span></div>
        ${all ? '<p class="ro-note">The Hospital Director and Chief Operations Officer can always use every command.</p>' : none ? '<p class="ro-note">Bot and booster roles can’t be given commands.</p>' : ''}
        <div class="ro-grid">${RO_CMDS.map(([k, l, h]) => sw('c:' + k, all || cset.has(r.id + '|' + k), l, h, all || none)).join('')}</div></section>
      <form class="card ro-sec" id="ro-disc"><div class="ro-sh"><h3>Discord</h3><span class="muted small-meta">The role’s permissions across the server. CareBeyond Helper applies them.</span></div>
        ${lockNote(r)}
        ${RO_DISCORD.map(([g, list]) => `<h4 class="ro-dg">${g}</h4><div class="ro-grid">${list.map(([bit, l, h, dz]) => sw('x:' + bit, roBit(r.permissions, bit), l, h, !ed, dz)).join('')}</div>`).join('')}
        ${ed ? `<div class="ro-confirm" id="ro-confirm" hidden><p><b>You’re turning on a dangerous permission.</b> Type the role’s name, <b>${esc(r.name)}</b>, to confirm.</p>
            <input name="confirm" autocomplete="off" aria-label="Type the role’s name to confirm"></div>
          <div class="ro-act ro-sticky" id="ro-dact" hidden><span class="muted small" id="ro-dsum"></span><button type="button" class="ghost" data-dreset>Undo</button><button type="submit" class="primary">Save Discord permissions</button></div>` : ''}
      </form>`;
    const f = pane.querySelector('#ro-disc');
    const chosen = () => { let v = BigInt(r.permissions || '0'); f.querySelectorAll('[data-perm^="x:"]').forEach((c) => { const b = 1n << BigInt(c.dataset.perm.slice(2)); v = c.checked ? v | b : v & ~b; }); return v; };
    const diff = () => {
      const now = chosen().toString(), on = [], off = [], dz = [];
      RO_DISCORD.forEach(([, list]) => list.forEach(([bit, l, , d]) => {
        const was = roBit(r.permissions, bit), is = roBit(now, bit);
        if (is && !was) { on.push(l); if (d) dz.push(l); } else if (!is && was) off.push(l);
      }));
      return { on, off, dz };
    };
    if (ed) {
      f.querySelector('[data-dreset]').onclick = () => drawMain();
      f.onsubmit = async (e) => {
        e.preventDefault();
        const { on, off, dz } = diff();
        if (dz.length && f.confirm.value.trim() !== r.name) return err(`Type ${r.name} exactly to turn on ${dz.join(', ')}.`);
        const b = f.querySelector('[type=submit]'); b.disabled = true;
        const summary = [on.length ? 'Turned on ' + on.join(', ') : '', off.length ? 'Turned off ' + off.join(', ') : ''].filter(Boolean).join('; ');
        await send(r, 'permissions', { allow: chosen().toString(), summary }, dz.length ? f.confirm.value.trim() : null);
        b.disabled = false;
      };
    }
    pane.onchange = async (e) => {
      const cb = e.target.closest('[data-perm]'), win = e.target.closest('[data-win]');
      if (cb && cb.dataset.perm.startsWith('x:')) {   // Discord: collect, then save together
        const { on, off, dz } = diff();
        f.querySelector('#ro-dact').hidden = !(on.length || off.length);
        f.querySelector('#ro-dsum').textContent = [on.length ? 'Turning on ' + on.join(', ') : '', off.length ? 'Turning off ' + off.join(', ') : ''].filter(Boolean).join('. ');
        f.querySelector('#ro-confirm').hidden = !dz.length;
        return;
      }
      if (cb) {   // website and bot command switches save straight away
        err('');
        const scope = cb.dataset.perm[0], perm = cb.dataset.perm.slice(2);
        cb.disabled = true;
        const { error } = scope === 'h' ? await sb.rpc('set_role_hperm', { role_id: r.id, perm, allow: cb.checked })
          : scope === 'c' ? await sb.rpc('set_role_cmd', { role_id: r.id, command: perm, allow: cb.checked })
          : await sb.rpc('set_rank_perm', { role_id: r.id, perm, allow: cb.checked });
        cb.disabled = false;
        if (error) { cb.checked = !cb.checked; return err(error.message); }
        if (scope === 'h') cb.checked ? hset.add(r.id + '|' + perm) : hset.delete(r.id + '|' + perm);
        else if (scope === 'c') cb.checked ? cset.add(r.id + '|' + perm) : cset.delete(r.id + '|' + perm);
        else {
          const { data } = await sb.from('rank_permissions').select('role_id, perm, window_lo, window_hi').eq('role_id', r.id);
          Object.keys(dmap).filter((k) => k.startsWith(r.id + '|')).forEach((k) => delete dmap[k]);
          (data || []).forEach((x) => { dmap[x.role_id + '|' + x.perm] = x; });
          drawMain();
        }
      }
      if (win) {
        const lo = +pane.querySelector('[data-win="lo"]').value, hi = +pane.querySelector('[data-win="hi"]').value;
        if (lo > hi) return err('The lowest rank must be at or below the highest.');
        const { error } = await sb.rpc('set_rank_window', { role_id: r.id, lo, hi });
        if (error) return err(error.message);
        dmap[r.id + '|members.edit'] = { ...dmap[r.id + '|members.edit'], window_lo: lo, window_hi: hi };
      }
    };
  }

  // ---------- Members ----------
  async function drawMembers(r, pane) {
    const keyDept = autoKey[r.id], dep = keyDept && DEPARTMENTS.find((d) => d.name === keyDept);
    const auto = keyDept ? `CareBeyond Helper gives this key to the ranks and people chosen under Office access on the <a href="#directors/${dep ? dep.id : ''}/ranks">${esc(keyDept)} Ranks &amp; permissions</a> page. Change who has it there.`
      : autoStatus.has(r.id) ? 'CareBeyond Helper gives and takes this role automatically when people start, pause and end shifts on the website.' : '';
    const ed = editable(r) && !auto;
    pane.innerHTML = `${auto ? `<p class="ro-note">${auto}</p>` : lockNote(r)}${ed ? `<div class="card ro-sec ro-add"><label class="f"><span>Give this role to someone</span>
        <input type="search" id="ro-find" placeholder="Search by name" autocomplete="off"></label><div id="ro-found" class="ro-found"></div></div>` : ''}
      <div class="card ro-mem" id="ro-mlist"><p class="muted small">Loading…</p></div>
      ${r.kind === 'rank' ? `<p class="muted small ro-foot">Promotions with a reason are best done on the <a href="#directors/${DEPARTMENTS.find((d) => d.name === r.department)?.id || ''}/members">${esc(r.department)} Members page</a>, which keeps the department’s history.</p>` : ''}`;
    const { data, error } = await sb.rpc('role_members', { role_id: r.id });
    const listEl = pane.querySelector('#ro-mlist');
    if (error) { listEl.innerHTML = `<p class="error">${esc(error.message)}</p>`; return; }
    const list = data || [], have = new Set(list.map((m) => m.discord_id));
    listEl.innerHTML = list.length ? list.map((m) => `<div class="ro-mrow">${face({ name: m.display_name, discordId: m.discord_id, avatarUrl: m.avatar_url, size: 's' })}<span>${esc(cleanName(m.display_name))}</span>
        ${ed ? `<button type="button" class="ghost small-btn" data-take="${esc(m.discord_id)}">Remove</button>` : ''}</div>`).join('') : '<p class="muted small">Nobody has this role.</p>';
    loadFaces(listEl);
    listEl.onclick = async (e) => {
      const b = e.target.closest('[data-take]'); if (!b) return;
      b.disabled = true; b.textContent = 'Removing…';
      if (!(await send(r, 'member_remove', { discord_id: b.dataset.take }))) { b.disabled = false; b.textContent = 'Remove'; }
    };
    if (!ed) return;
    const find = pane.querySelector('#ro-find'), found = pane.querySelector('#ro-found');
    let t = null;
    find.oninput = () => { clearTimeout(t); t = setTimeout(async () => {
      const q = find.value.trim();
      if (q.length < 2) { found.innerHTML = ''; return; }
      const { data: hits, error: e2 } = await sb.rpc('mod_member_search', { q });
      if (e2) { found.innerHTML = `<p class="error">${esc(e2.message)}</p>`; return; }
      found.innerHTML = (hits || []).slice(0, 6).map((m) => `<div class="ro-mrow">${face({ name: m.display_name, discordId: m.discord_id, avatarUrl: m.avatar_url, size: 's' })}<span>${esc(cleanName(m.display_name))}</span>
        ${have.has(m.discord_id) ? '<span class="muted small">Has it</span>' : `<button type="button" class="primary small-btn" data-give="${esc(m.discord_id)}">Give role</button>`}</div>`).join('') || '<p class="muted small">Nobody found.</p>';
      loadFaces(found);
    }, 250); };
    found.onclick = async (e) => {
      const b = e.target.closest('[data-give]'); if (!b) return;
      b.disabled = true; b.textContent = 'Giving…';
      if (await send(r, 'member_add', { discord_id: b.dataset.give })) b.textContent = 'Sent';
      else { b.disabled = false; b.textContent = 'Give role'; }
    };
  }

  // ---------- History ----------
  async function drawHistory(r, pane) {
    pane.innerHTML = '<div class="card"><p class="muted small">Loading…</p></div>';
    const [ed, lg] = await Promise.all([
      sb.from('role_edits').select('id, summary, kind, status, error, requested_by_name, created_at').eq('role_id', r.id).order('created_at', { ascending: false }).limit(50),
      sb.from('role_log').select('id, what, by_name, created_at').eq('role_id', r.id).order('created_at', { ascending: false }).limit(50),
    ]);
    const rows = [
      ...(ed.data || []).map((x) => ({ at: x.created_at, text: x.summary || x.kind, by: x.requested_by_name, where: 'Discord', status: x.status, error: x.error })),
      ...(lg.data || []).map((x) => ({ at: x.created_at, text: x.what, by: x.by_name, where: 'Website' })),
    ].sort((a, b) => new Date(b.at) - new Date(a.at));
    const ST = { pending: ['Waiting', 'sub-pending'], done: ['Done', 'sub-done'], failed: ['Failed', 'sub-failed'] };
    pane.innerHTML = `<div class="card ro-hist">${rows.length ? rows.map((x) => `<div class="ro-hrow"><div><b>${esc(x.text)}</b>
        <span class="muted small-meta">${x.by ? 'By ' + esc(cleanName(x.by)) + ' · ' : ''}${esc(new Date(x.at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }))} · ${x.where}${x.error ? ' · ' + esc(x.error) : ''}</span></div>
        ${x.status ? `<span class="st ${ST[x.status][1]}">${ST[x.status][0]}</span>` : ''}</div>`).join('') : '<p class="muted small">No changes yet.</p>'}</div>`;
  }

  body.querySelector('#ro-q').oninput = (e) => { roState.q = e.target.value; drawList(); };
  listEl.onclick = (e) => { const b = e.target.closest('[data-role]'); if (!b) return; roState.open = b.dataset.role; drawList(); drawMain(); };
  main.onclick = (e) => { const t = e.target.closest('[data-rtab]'); if (t) { roState.tab = t.dataset.rtab; drawMain(); } };
  drawList(); drawMain();
}
LIVE.roles = renderRoles;
