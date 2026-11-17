// Session history (Alpha, for Bravo's Sessions page, 0.16.0). Bravo's renderSessions mounts it on
// <div id="sess-history"> at the bottom of #directors/sessions and #admin/sessions:
//   window.renderSessionHistory(el)
// Draws past sessions grouped by week: when, type tag, host, length, how many staff were on shift (up to 5 photos)
// and the note. Data: sb.rpc('session_history', { max_rows }) (migration 0020, Bravo), session runners only.
// No timers: like every page, it never redraws by itself.
(function () {
  const KIND = {
    regular: { label: 'Regular session', color: '#2ed3c6' },
    training: { label: 'Training', color: '#3a82d0' },
    event: { label: 'Event', color: '#e09a00' },
  };
  const STEP = 30;

  const mondayOf = (iso) => {
    const d = new Date(iso);
    const m = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    m.setDate(m.getDate() - ((m.getDay() + 6) % 7));
    return m;
  };
  function weekLabel(monday) {
    const thisMon = mondayOf(new Date().toISOString());
    const diff = Math.round((thisMon - monday) / (7 * 864e5));
    if (diff <= 0) return 'This week';
    if (diff === 1) return 'Last week';
    return 'Week of ' + monday.toLocaleDateString([], { day: 'numeric', month: 'long' });
  }
  const mins = (m) => {
    m = Math.max(0, Math.round(Number(m) || 0));
    const h = Math.floor(m / 60), r = m % 60;
    return h ? (r ? `${h}h ${r}m` : `${h}h`) : `${r}m`;
  };
  function tag(s) {
    if (s.kind === 'department') {
      const d = (typeof DEPARTMENTS !== 'undefined' ? DEPARTMENTS : []).find((x) => x.name === s.department);
      return { label: `${s.department || 'Department'} session`, color: d ? d.color : '#5c72ff' };
    }
    return KIND[s.kind] || KIND.regular;
  }
  // Photos straight from session_history (no lookups); initials when there's no photo.
  const faceOf = (p) => `<span class="face face-s${p.avatar_url ? ' has-img' : ''}" title="${esc(cleanName(p.name || ''))}">`
    + (p.avatar_url ? `<img class="face-img" src="${esc(sized(p.avatar_url, 64))}" alt="" loading="lazy" onerror="this.parentNode.classList.remove('has-img');this.remove()">` : '')
    + `<span class="face-i">${esc((cleanName(p.name || '?')[0] || '?').toUpperCase())}</span></span>`;

  function row(s) {
    const t = tag(s);
    const start = new Date(s.started_at), end = s.ended_at ? new Date(s.ended_at) : null;
    const day = start.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
    const time = start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + (end ? '–' + end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '');
    const staff = s.staff || [];
    const n = Number(s.staff_count || 0);
    return `<article class="sh-hrow">
      <div class="sh-hwhen"><strong>${esc(day)}</strong><span>${esc(time)}</span></div>
      <div class="sh-hmain">
        <div class="sh-hline"><span class="sh-htag" style="--c:${esc(t.color)}">${esc(t.label)}</span><span class="sh-hhost">${s.host_name ? 'Hosted by ' + esc(cleanName(s.host_name)) : 'Host not recorded'}</span></div>
        ${s.note ? `<p class="sh-hnote">${esc(s.note)}</p>` : ''}
      </div>
      <div class="sh-hstats">
        <span class="sh-hlen" title="Length">${esc(mins(s.minutes))}</span>
        <span class="sh-hstaff" title="${n ? esc(staff.map((p) => cleanName(p.name || '')).join(', ')) : 'Nobody was on shift'}">
          <span class="sh-hfaces">${staff.slice(0, 5).map(faceOf).join('')}</span>
          <span>${n ? `${n} staff${s.staff_hours ? ' · ' + Number(s.staff_hours).toFixed(1) + ' h' : ''}` : 'No staff on shift'}</span></span>
      </div>
    </article>`;
  }

  async function renderSessionHistory(el) {
    if (!el) return;
    let max = STEP;
    el.classList.add('sh-history');
    el.innerHTML = `<h2 class="sh-htitle">Past sessions</h2><div class="sh-hbody"><div class="card sh-hload">${typeof lines === 'function' ? lines('40%', '70%', '55%') : '<p class="muted small">Loading…</p>'}</div></div>`;
    const body = el.querySelector('.sh-hbody');
    async function load() {
      const { data, error } = await sb.rpc('session_history', { max_rows: max });
      if (!el.isConnected) return;
      if (error) {
        body.innerHTML = `<div class="card sh-hempty"><strong>Couldn’t load past sessions.</strong><span>${esc(error.message)}</span><button type="button" class="ghost small-btn" data-retry>Try again</button></div>`;
        body.querySelector('[data-retry]').onclick = load;
        return;
      }
      const rows = (data || []).filter((s) => s.started_at);
      if (!rows.length) {
        body.innerHTML = '<div class="card sh-hempty"><strong>No past sessions yet.</strong><span>Sessions appear here once they’ve ended.</span></div>';
        return;
      }
      const weeks = [];
      for (const s of rows) {
        const mon = mondayOf(s.started_at), k = mon.getTime();
        if (!weeks.length || weeks[weeks.length - 1].k !== k) weeks.push({ k, mon, items: [] });
        weeks[weeks.length - 1].items.push(s);
      }
      body.innerHTML = weeks.map((w) => {
        const total = w.items.reduce((a, s) => a + Number(s.minutes || 0), 0);
        return `<section class="sh-hweek"><div class="sh-hweekh"><h3>${esc(weekLabel(w.mon))}</h3><span>${w.items.length} session${w.items.length === 1 ? '' : 's'} · ${esc(mins(total))}</span></div>
          <div class="card sh-hlist">${w.items.map(row).join('')}</div></section>`;
      }).join('') + (rows.length >= max ? '<div class="sh-hmore"><button type="button" class="ghost" data-more>Show more</button></div>' : '');
      body.querySelector('[data-more]')?.addEventListener('click', (e) => { e.target.disabled = true; e.target.textContent = 'Loading…'; max += STEP; load(); });
    }
    load();
  }
  window.renderSessionHistory = renderSessionHistory;
}());
