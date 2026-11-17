// Discord logs (#admin/logs). Owner, 18 Nov 2026: "just a full list of logs and a small find bar". One compact line
// per entry, newest first: time, what happened, who (links to their record), where, and the message text or
// before/after when there is any. Find searches names, channels and message text. Paged with Load more.
// Data: discord_logs (admins only), saved by the bot's modlog cog. Uses pgSafe from cases.js.
const LOG_LABEL = {
  message_delete: 'Message deleted', message_edit: 'Message edited', member_join: 'Joined', member_leave: 'Left',
  member_ban: 'Banned', member_unban: 'Unbanned', roles_change: 'Roles changed', nickname_change: 'Nickname changed', timeout: 'Timed out',
};
const LOG_PAGE = 100;

// "7:19 pm" today, "Yesterday 7:19 pm", "17 Nov 7:19 pm", and the year when it isn't this one.
function logWhen(iso) {
  const d = new Date(iso), now = new Date(), y = new Date(Date.now() - 864e5);
  const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return t;
  if (d.toDateString() === y.toDateString()) return `Yesterday ${t}`;
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) })} ${t}`;
}

async function renderLogs(body) {
  const st = { q: '', offset: 0, done: false, seq: 0 };
  const names = new Map();   // discord_id -> display name, for entries saved without one
  const msgs = new Map();    // message_id -> saved message, for deletes the bot couldn't see the text of

  body.innerHTML = `
    <div class="lg-bar">
      <label class="lg-find"><span class="h-glass" aria-hidden="true"></span><input id="lg-q" type="search" placeholder="Find" aria-label="Find in the logs" autocomplete="off"></label>
      <span class="lg-count" id="lg-count" aria-live="polite"></span>
    </div>
    <div class="card lg-list" id="lg-list"><p class="lg-msg">Loading the logs…</p></div>
    <div class="center"><button type="button" class="ghost" id="lg-more" hidden>Load more</button></div>`;
  const $b = (s) => body.querySelector(s);
  const list = $b('#lg-list');

  function query() {
    let q = sb.from('discord_logs').select('*').order('at', { ascending: false }).order('id', { ascending: false });
    const s = pgSafe(st.q);
    if (s) q = /^\d{15,22}$/.test(s) ? q.eq('user_discord_id', s)
      : q.or(`user_name.ilike.*${s}*,channel_name.ilike.*${s}*,details->>content.ilike.*${s}*,details->>before.ilike.*${s}*,details->>after.ilike.*${s}*`);
    return q;
  }

  async function load(fresh) {
    const seq = ++st.seq;
    if (fresh) { st.offset = 0; st.done = false; }
    const { data, error } = await query().range(st.offset, st.offset + LOG_PAGE - 1);
    if (seq !== st.seq) return;   // a newer search started
    if (error) { list.innerHTML = ''; return liveError(list, error); }
    await fillGaps(data);
    if (seq !== st.seq) return;
    st.offset += data.length; st.done = data.length < LOG_PAGE;
    if (fresh) list.innerHTML = data.length ? '' : `<p class="lg-msg">${st.q ? `Nothing found for “${esc(st.q)}”.` : 'Nothing logged yet.'}</p>`;
    list.insertAdjacentHTML('beforeend', data.map(line).join(''));
    $b('#lg-count').textContent = st.q && st.offset ? `${st.offset}${st.done ? '' : '+'} found` : '';
    $b('#lg-more').hidden = st.done;
  }

  // Names for entries saved without one, and the text of deleted messages from message history.
  async function fillGaps(rows) {
    const ids = [...new Set(rows.filter((l) => l.user_discord_id && !l.user_name && !names.has(l.user_discord_id)).map((l) => l.user_discord_id))];
    const mids = [...new Set(rows.filter((l) => l.type === 'message_delete' && l.details?.message_id && l.details?.content == null && !msgs.has(l.details.message_id)).map((l) => l.details.message_id))];
    await Promise.all([
      ids.length && sb.rpc('member_faces', { ids }).then(({ data }) => (data || []).forEach((m) => m.display_name && names.set(m.discord_id, m.display_name)), () => {}),
      mids.length && sb.from('discord_messages').select('message_id, author_id, author_name, content, attachments').in('message_id', mids)
        .then(({ data }) => { mids.forEach((id) => msgs.set(id, null)); (data || []).forEach((m) => msgs.set(m.message_id, m)); }, () => {}),
    ]);
  }

  function line(l) {
    const d = l.details || {};
    const m = l.type === 'message_delete' && d.message_id ? msgs.get(d.message_id) : null;
    const id = l.user_discord_id || m?.author_id || '';
    const raw = l.user_name || names.get(id) || m?.author_name || '';
    const name = raw ? cleanName(raw) : id ? 'Unknown member' : 'Unknown';
    const who = id ? `<button type="button" class="lg-who" data-rec="${esc(id)}" data-name="${esc(name)}">${esc(name)}</button>` : `<span class="lg-who plain">${esc(name)}</span>`;
    return `<div class="lg-line">
      <time class="lg-t" datetime="${esc(l.at)}">${esc(logWhen(l.at))}</time>
      <span class="lg-ev t-${esc(l.type)}">${esc(LOG_LABEL[l.type] || l.type)}</span>
      <div class="lg-body"><span class="lg-head">${who}${l.channel_name ? `<span class="lg-ch">#${esc(l.channel_name)}</span>` : ''}</span>${detail(l, d, m)}</div>
    </div>`;
  }

  function detail(l, d, m) {
    const txt = (s) => `<span class="lg-txt">${esc(s)}</span>`;
    switch (l.type) {
      case 'message_delete': {
        const text = d.content ?? m?.content;
        const files = d.attachments?.length ? d.attachments : (m?.attachments || []).map((a) => a.name);
        if (text == null && !files.length) return '<span class="lg-txt none">Text not saved</span>';
        return (text ? txt(text) : '') + (files.length ? `<span class="lg-files">${files.map(esc).join(', ')}</span>` : '');
      }
      case 'message_edit':
        return `<span class="lg-txt was">${esc(d.before || '(no text)')}</span><span class="lg-to" aria-label="changed to">→</span>${txt(d.after || '(no text)')}`
          + (d.url ? ` <a class="lg-jump" href="${esc(d.url)}" target="_blank" rel="noopener">Open</a>` : '');
      case 'roles_change':
        return `<span class="lg-roles">${(d.added || []).map((r) => `<span class="lg-r add">+ ${esc(r)}</span>`).join('')}${(d.removed || []).map((r) => `<span class="lg-r rem">− ${esc(r)}</span>`).join('')}</span>`;
      case 'nickname_change':
        return `<span class="lg-txt was">${esc(cleanName(d.before || '') || 'No nickname')}</span><span class="lg-to" aria-label="changed to">→</span>${txt(cleanName(d.after || '') || 'No nickname')}`;
      case 'member_join':
        return d.account_age_days != null ? `<span class="lg-txt dim">Account ${d.account_age_days < 1 ? 'made today' : `${d.account_age_days} day${d.account_age_days === 1 ? '' : 's'} old`}</span>${d.account_age_days < 7 ? '<span class="lg-flag">New account</span>' : ''}` : '';
      case 'timeout':
        return d.until ? `<span class="lg-txt dim">until ${esc(whenAhead(d.until))}</span>` : '';
      default: return '';
    }
  }

  let qt;
  $b('#lg-q').oninput = (e) => { clearTimeout(qt); qt = setTimeout(() => { st.q = e.target.value.trim(); load(true); }, 250); };
  $b('#lg-more').onclick = () => load(false);
  list.onclick = (e) => {
    const r = e.target.closest('[data-rec]');
    if (r) { rememberRecord(r.dataset.rec, r.dataset.name); openRecord(r.dataset.rec); }
  };
  load(true);
}

LIVE.logs = renderLogs;
