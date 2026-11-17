// Discord logs (#admin/logs), 0.16.x redesign. Loaded after cases.js (uses dayKey, dayLabel, timeOf, pgSafe) and
// faces.js. Data: discord_logs (admins only), saved by the bot's modlog cog. The page loads once; new entries are
// counted quietly every 30 s and only shown when the "new" button is pressed.
const LOG_GROUPS = [
  { id: 'all', label: 'All', types: null },
  { id: 'messages', label: 'Messages', types: ['message_delete', 'message_edit'] },
  { id: 'members', label: 'Joins & leaves', types: ['member_join', 'member_leave'] },
  { id: 'roles', label: 'Roles & names', types: ['roles_change', 'nickname_change'] },
  { id: 'mod', label: 'Moderation', types: ['member_ban', 'member_unban', 'timeout'] },
];
const LOG_LABEL = {
  message_delete: 'Message deleted', message_edit: 'Message edited', member_join: 'Joined', member_leave: 'Left',
  member_ban: 'Banned', member_unban: 'Unbanned', roles_change: 'Roles changed', nickname_change: 'Nickname changed', timeout: 'Timed out',
};
const LOG_PAGE = 50;
const LOG_BURST_MS = 30 * 60e3;   // one person's role or nickname changes this close together share one row
let lgWatch = null;
let lgRoles = null;               // role name -> colour, asked once

const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const hexOf = (n) => (n ? '#' + Number(n).toString(16).padStart(6, '0') : '');

async function renderLogs(body) {
  clearInterval(lgWatch);
  const st = { group: 'all', q: '', offset: 0, rows: [], done: false, topId: 0, open: new Set() };
  const names = new Map();        // discord_id -> display name, for entries saved without one
  const msgs = new Map();         // message_id -> saved message, for deletes the bot couldn't see the text of

  body.innerHTML = `
    <div class="lg-tools">
      <label class="ma-search"><span class="h-glass" aria-hidden="true"></span><input id="lg-q" type="search" placeholder="Search a name, channel or message" aria-label="Search Discord logs" autocomplete="off"></label>
      <div class="ma-chips" id="lg-filter" role="group" aria-label="Show">${LOG_GROUPS.map((g) =>
        `<button type="button" class="chip${g.id === 'all' ? ' on' : ''}" data-g="${g.id}"${g.id === 'all' ? '' : ' hidden'}>${g.label}<span class="count"></span></button>`).join('')}</div>
    </div>
    <button type="button" class="lg-new" id="lg-new" hidden></button>
    <div id="lg-list"><div class="card lg-group"><p class="muted small lg-loading">Loading the logs…</p></div></div>
    <div class="center"><button type="button" class="ghost" id="lg-more" hidden>Load more</button></div>`;
  const $b = (s) => body.querySelector(s);
  const list = $b('#lg-list');

  // ---------- data ----------
  function query(head) {
    let q = head ? sb.from('discord_logs').select('id', { count: 'exact', head: true })
      : sb.from('discord_logs').select('*').order('at', { ascending: false }).order('id', { ascending: false });
    const g = LOG_GROUPS.find((x) => x.id === st.group);
    if (g.types) q = q.in('type', g.types);
    const s = pgSafe(st.q);
    if (s) q = /^\d{15,22}$/.test(s) ? q.eq('user_discord_id', s)
      : q.or(`user_name.ilike.*${s}*,channel_name.ilike.*${s}*,details->>content.ilike.*${s}*,details->>after.ilike.*${s}*`);
    return q;
  }

  async function load(fresh) {
    if (fresh) { st.offset = 0; st.rows = []; st.done = false; st.open.clear(); }
    const { data, error } = await query(false).range(st.offset, st.offset + LOG_PAGE - 1);
    if (error) { list.innerHTML = ''; return liveError(list, error); }
    st.rows.push(...data); st.offset += data.length; st.done = data.length < LOG_PAGE;
    if (fresh) { st.topId = data.reduce((m, l) => Math.max(m, l.id), 0); $b('#lg-new').hidden = true; }
    await fillGaps(data);
    draw();
    $b('#lg-more').hidden = st.done;
  }

  // Names for entries saved without one, the text of deleted messages from message history, and role colours.
  async function fillGaps(rows) {
    const ids = [...new Set(rows.filter((l) => l.user_discord_id && !l.user_name && !names.has(l.user_discord_id)).map((l) => l.user_discord_id))];
    const mids = [...new Set(rows.filter((l) => l.type === 'message_delete' && l.details?.message_id && l.details?.content == null && !msgs.has(l.details.message_id)).map((l) => l.details.message_id))];
    await Promise.all([
      ids.length && sb.rpc('member_faces', { ids }).then(({ data }) => (data || []).forEach((m) => m.display_name && names.set(m.discord_id, m.display_name)), () => {}),
      mids.length && sb.from('discord_messages').select('message_id, author_id, author_name, content, attachments').in('message_id', mids)
        .then(({ data }) => { mids.forEach((id) => msgs.set(id, null)); (data || []).forEach((m) => msgs.set(m.message_id, m)); }, () => {}),
      lgRoles || sb.from('roles').select('name, color, badge_color').then(({ data }) => {
        lgRoles = new Map((data || []).map((r) => [r.name, hexOf(r.badge_color || r.color)]));
      }, () => { lgRoles = new Map(); }),
    ]);
  }

  // Filter chips: only kinds that have entries, each with its count.
  async function counts() {
    const res = await Promise.all(LOG_GROUPS.map((g) => {
      let q = sb.from('discord_logs').select('id', { count: 'exact', head: true });
      if (g.types) q = q.in('type', g.types);
      return q.then((r) => r.count ?? 0, () => 0);
    }));
    LOG_GROUPS.forEach((g, i) => {
      const b = $b(`#lg-filter [data-g="${g.id}"]`);
      b.hidden = g.id !== 'all' && !res[i] && st.group !== g.id;
      b.querySelector('.count').textContent = res[i] ? res[i] : '';
    });
  }

  // ---------- drawing ----------
  // Who an entry is about. Deletes the bot only saw as an ID take the author from message history.
  function who(l) {
    const m = l.type === 'message_delete' && l.details?.message_id ? msgs.get(l.details.message_id) : null;
    const id = l.user_discord_id || m?.author_id || '';
    const raw = l.user_name || names.get(id) || m?.author_name || '';
    return { id, name: raw ? cleanName(raw) : '', msg: m };
  }

  // Consecutive role or nickname changes for one person, close in time, become one row.
  function bursts(rows) {
    const out = [];
    for (const l of rows) {
      const prev = out[out.length - 1], last = prev?.items[prev.items.length - 1];
      if (prev && (l.type === 'roles_change' || l.type === 'nickname_change') && last.type === l.type
        && l.user_discord_id && last.user_discord_id === l.user_discord_id && new Date(last.at) - new Date(l.at) < LOG_BURST_MS
        && dayKey(last.at) === dayKey(l.at)) prev.items.push(l);
      else out.push({ items: [l] });
    }
    return out;
  }

  function draw() {
    if (!st.rows.length) {
      const filtered = st.group !== 'all' || st.q;
      list.innerHTML = `<div class="card ma-empty"><strong>${filtered ? 'Nothing matches.' : 'Nothing logged yet.'}</strong>
        ${filtered ? '<span>Try a different search or filter.</span><button type="button" class="ghost small-btn" id="lg-clear">Clear filters</button>' : ''}</div>`;
      $b('#lg-clear')?.addEventListener('click', clearFilters);
      return;
    }
    const groups = [];
    for (const b of bursts(st.rows)) {
      const k = dayKey(b.items[0].at);
      if (!groups.length || groups[groups.length - 1].k !== k) groups.push({ k, label: dayLabel(b.items[0].at), rows: [] });
      groups[groups.length - 1].rows.push(b);
    }
    list.innerHTML = groups.map((g) => `<section class="ma-section"><h2 class="ma-day">${esc(g.label)}</h2><div class="card lg-group">${g.rows.map(rowHtml).join('')}</div></section>`).join('');
    loadFaces(list);
  }

  function rowHtml(b) {
    const l = b.items[0], p = who(l), key = l.id;
    const name = p.name || (p.id ? 'Unknown member' : l.type === 'message_delete' ? 'Unknown author' : 'Unknown');
    const nameEl = p.id ? `<button type="button" class="ma-name" data-rec="${esc(p.id)}" data-name="${esc(name)}">${esc(name)}</button>`
      : `<span class="ma-name plain${p.name ? '' : ' unknown'}">${esc(name)}</span>`;
    const many = b.items.length > 1, open = st.open.has(key);
    const shown = many && !open ? [l] : b.items;
    const detail = many
      ? `<div class="lg-steps">${shown.map((x) => `<div class="lg-step"><span class="lg-step-t">${timeOf(x.at)}</span><div>${detailHtml(x, p)}</div></div>`).join('')}</div>
         <button type="button" class="lg-more-steps" data-open="${key}" aria-expanded="${open}">${open ? 'Show less' : `Show ${plural(b.items.length - 1, 'earlier change')}`}</button>`
      : detailHtml(l, p);
    const meta = [l.channel_name ? `#${esc(l.channel_name)}` : '', many
      ? `${timeOf(b.items[b.items.length - 1].at)} – ${timeOf(l.at)}` : timeOf(l.at)].filter(Boolean).join(' · ');
    return `<div class="lg-row" data-id="${l.id}">
      ${face({ name: p.id || p.name ? name : '?', discordId: p.id, size: 'm' })}
      <div class="lg-main">
        <div class="lg-line1">${nameEl}<span class="lg-tag t-${esc(l.type)}">${esc(LOG_LABEL[l.type] || l.type)}</span>${many ? `<span class="ma-len">${plural(b.items.length, 'change')}</span>` : ''}</div>
        ${detail}
        <div class="lg-meta">${meta}</div>
      </div>
    </div>`;
  }

  function roleChip(name, sign) {
    const c = lgRoles?.get(name);
    return `<span class="lg-role ${sign === '+' ? 'add' : 'rem'}"${c ? ` style="--rc:${c}"` : ''}><span class="lg-sign" aria-label="${sign === '+' ? 'Added' : 'Removed'}">${sign === '+' ? '+' : '−'}</span><span class="lg-dot" aria-hidden="true"></span>${esc(name)}</span>`;
  }

  function quote(text, cls = '') {
    return text ? `<div class="lg-quote ${cls}">${esc(text)}</div>` : '';
  }

  function detailHtml(l, p) {
    const d = l.details || {};
    switch (l.type) {
      case 'message_delete': {
        const text = d.content ?? p.msg?.content;
        const files = d.attachments?.length ? d.attachments : (p.msg?.attachments || []).map((a) => a.name);
        if (text == null && !files.length) return '<div class="lg-note">The message wasn’t saved, so its text isn’t known.</div>';
        return `${quote(text)}${files.length ? `<div class="lg-files">${files.map((f) => `<span class="lg-file">${esc(f)}</span>`).join('')}</div>` : ''}`;
      }
      case 'message_edit':
        return `<div class="lg-edit"><span class="lg-lbl">Before</span>${quote(d.before || '(no text)', 'was')}<span class="lg-lbl">After</span>${quote(d.after || '(no text)')}</div>`
          + (d.url ? `<a class="lg-link" href="${esc(d.url)}" target="_blank" rel="noopener">Open in Discord</a>` : '');
      case 'roles_change':
        return `<div class="lg-roles">${(d.added || []).map((r) => roleChip(r, '+')).join('')}${(d.removed || []).map((r) => roleChip(r, '-')).join('')}</div>`;
      case 'nickname_change':
        return `<div class="lg-nick"><span class="was">${esc(cleanName(d.before || '') || 'No nickname')}</span><span class="lg-arrow" aria-label="to">→</span><strong>${esc(cleanName(d.after || '') || 'No nickname')}</strong></div>`;
      case 'member_join':
        return d.account_age_days != null ? `<div class="lg-sub">Account ${d.account_age_days < 1 ? 'made today' : plural(d.account_age_days, 'day') + ' old'}${d.account_age_days < 7 ? ' <span class="lg-flag">New account</span>' : ''}</div>` : '';
      case 'timeout':
        return d.until ? `<div class="lg-sub">Until ${esc(whenAhead(d.until))}</div>` : '';
      default: return '';
    }
  }

  // ---------- events ----------
  function clearFilters() {
    st.group = 'all'; st.q = ''; $b('#lg-q').value = '';
    body.querySelectorAll('#lg-filter .chip').forEach((x) => x.classList.toggle('on', x.dataset.g === 'all'));
    counts(); load(true);
  }
  $b('#lg-filter').onclick = (e) => {
    const b = e.target.closest('.chip'); if (!b || b.dataset.g === st.group) return;
    st.group = b.dataset.g;
    body.querySelectorAll('#lg-filter .chip').forEach((x) => x.classList.toggle('on', x === b));
    load(true);
  };
  let qt;
  $b('#lg-q').oninput = (e) => { clearTimeout(qt); qt = setTimeout(() => { st.q = e.target.value.trim(); load(true); }, 250); };
  $b('#lg-more').onclick = () => load(false);
  $b('#lg-new').onclick = () => { counts(); load(true); };
  list.onclick = (e) => {
    const r = e.target.closest('[data-rec]');
    if (r) { rememberRecord(r.dataset.rec, r.dataset.name); openRecord(r.dataset.rec); return; }
    const o = e.target.closest('[data-open]');
    if (o) { const k = +o.dataset.open; st.open.has(k) ? st.open.delete(k) : st.open.add(k); draw(); }
  };

  // New entries since the list was loaded, counted quietly; shown only when asked.
  lgWatch = setInterval(async () => {
    if (!body.isConnected || location.hash !== '#admin/logs') { clearInterval(lgWatch); return; }
    if (document.hidden || !st.topId) return;
    const { count } = await query(true).gt('id', st.topId);
    const b = $b('#lg-new');
    b.hidden = !count;
    if (count) b.innerHTML = `<span class="lg-pulse" aria-hidden="true"></span>${plural(count, 'new entry', 'new entries')}<span class="lg-new-go">Show</span>`;
  }, CHECK_EVERY_MS);

  counts();
  await load(true);
}

LIVE.logs = renderLogs;
