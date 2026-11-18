// Office access (R2, Bravo; owner approved option B, 18 Nov 2026): on a department's "Ranks & permissions" tab, the
// Director (or an executive) chooses which ranks open the department's office and lets extra people in by name, with
// an optional end date. CareBeyond Helper keeps the 🔑 key role in step (bot office_keys cog, migration 0058).
// dept.js calls window.deptOfficeCard(pane, dept, ranks) at the end of drawRanks.
window.deptOfficeCard = async function (pane, dept, ranks) {
  const [kq, mq] = await Promise.all([
    sb.from('office_keys').select('department, role_id, ranks, active').eq('department', dept).maybeSingle(),
    sb.rpc('office_key_list', { department: dept }),
  ]);
  const key = kq.data;
  if (!key || !pane.isConnected) return;
  const extras = mq.data || [];
  const ids = extras.map((x) => x.discord_id);
  const on = new Set(key.ranks || []);
  const day = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  const card = document.createElement('div');
  card.className = 'card dp-office';
  card.innerHTML = `<div class="dp-head"><h2>Office access</h2><span class="muted small-meta">Who can open the ${esc(dept)} Office in Discord. CareBeyond Helper gives and takes the key.</span></div>
    ${key.active ? '' : '<p class="dp-office-note">Switched on when the new Discord roles go live. You can set it up now.</p>'}
    <p class="error" id="of-err" hidden></p>
    <h3 class="dp-office-h">Ranks that always have it</h3>
    <div class="dp-office-ranks">${ranks.slice().sort((a, b) => b.rank_order - a.rank_order).map((r) => `<label class="dp-ochip" style="--c:${r.badge_color ? hex(r.badge_color) : '#9aa9c4'}">
      <input type="checkbox" data-orank="${esc(r.id)}"${on.has(r.id) ? ' checked' : ''}><span>${esc(r.rank_label)}</span></label>`).join('')}</div>
    <h3 class="dp-office-h">Also let in</h3>
    <div class="dp-office-list">${extras.length ? extras.map((x) => { const nm = cleanName(x.display_name || 'Someone who left');
      return `<div class="dp-orow">${face({ name: nm, discordId: x.discord_id, avatarUrl: x.avatar_url, size: 's' })}
        <span class="dp-otxt"><b>${esc(nm)}</b><small>${x.until ? 'Until ' + esc(day(x.until)) : 'No end date'}${x.added_by_name ? ' · ' + esc(cleanName(x.added_by_name)) : ''}</small></span>
        <button type="button" class="ghost small-btn" data-ogo="${esc(x.discord_id)}">Remove</button></div>`; }).join('') : '<p class="muted small">Nobody else yet.</p>'}</div>
    <div class="dp-oadd">
      <label class="f"><span>Add someone</span><input type="search" id="of-q" placeholder="Search by name" autocomplete="off"></label>
      <label class="f"><span>Until <em>(optional)</em></span><input type="date" id="of-until" min="${new Date(Date.now() + 864e5).toISOString().slice(0, 10)}"></label>
    </div>
    <div class="dp-office-found" id="of-found"></div>`;
  pane.appendChild(card);
  loadFaces(card);
  const err = card.querySelector('#of-err');
  const fail = (m) => { err.textContent = m; err.hidden = !m; };
  const redraw = () => { card.remove(); window.deptOfficeCard(pane, dept, ranks); };

  card.querySelectorAll('[data-orank]').forEach((cb) => cb.onchange = async () => {
    fail('');
    const next = [...card.querySelectorAll('[data-orank]')].filter((x) => x.checked).map((x) => x.dataset.orank);
    card.querySelectorAll('[data-orank]').forEach((x) => { x.disabled = true; });
    const { error } = await sb.rpc('office_key_set_ranks', { department: dept, ranks: next });
    card.querySelectorAll('[data-orank]').forEach((x) => { x.disabled = false; });
    if (error) { cb.checked = !cb.checked; fail(error.message); }
  });
  card.querySelector('.dp-office-list').onclick = async (e) => {
    const b = e.target.closest('[data-ogo]'); if (!b) return;
    b.disabled = true; fail('');
    const { error } = await sb.rpc('office_key_remove', { department: dept, discord_id: b.dataset.ogo });
    if (error) { b.disabled = false; return fail(error.message); }
    redraw();
  };
  const q = card.querySelector('#of-q'), found = card.querySelector('#of-found');
  let t = null;
  q.oninput = () => { clearTimeout(t); t = setTimeout(async () => {
    const term = q.value.trim();
    if (term.length < 2) { found.innerHTML = ''; return; }
    const { data, error } = await sb.rpc('member_search', { q: term });
    if (q.value.trim() !== term) return;
    if (error) { found.innerHTML = `<p class="error">${esc(error.message)}</p>`; return; }
    const list = (data || []).filter((m) => !ids.includes(m.discord_id)).slice(0, 6);
    found.innerHTML = list.length ? list.map((m) => `<div class="dp-orow">${face({ name: m.display_name, discordId: m.discord_id, avatarUrl: m.avatar_url, size: 's' })}
      <span class="dp-otxt"><b>${esc(cleanName(m.display_name))}</b></span><button type="button" class="dp-oadd-btn small-btn" data-oadd="${esc(m.discord_id)}">Let in</button></div>`).join('')
      : '<p class="muted small">Nobody found.</p>';
    loadFaces(found);
  }, 250); };
  found.onclick = async (e) => {
    const b = e.target.closest('[data-oadd]'); if (!b) return;
    const until = card.querySelector('#of-until').value;
    b.disabled = true; fail('');
    const { error } = await sb.rpc('office_key_add', { department: dept, discord_id: b.dataset.oadd, until: until ? new Date(until + 'T23:59:00').toISOString() : null });
    if (error) { b.disabled = false; return fail(error.message); }
    redraw();
  };
};
