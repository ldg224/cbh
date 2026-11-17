// Applications: Apply (#apply, everyone) and reviewing (#admin/applications, #review), one flow (owner, 18 Nov 2026).
// Back end: migration 0028 (app_* functions) on rank permissions (0027: has_perm 'applications.review' and
// 'applications.settings'; execs and the department's Director always pass). The bot (Bravo) gives the roles from
// role_changes, DMs the result and keeps the #form-submissions post up to date.
// Loaded after app.js (questionField, DEPARTMENTS, iconUrl, hasPerm), faces.js and cases.js (dayKey).
const APP_DEPTS = ['Administration', 'Nursing', 'Paramedicine', 'Community Engagement'];
const appDept = (name) => DEPARTMENTS.find((d) => d.name === name) || { name, color: '#3a82d0', icon: 'resume' };
const appDate = (iso) => new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
const appAgo = (iso) => { const d = Math.floor((Date.now() - new Date(iso)) / 864e5); return d < 1 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`; };
const appLater = (iso) => iso && iso !== 'infinity' && new Date(iso) > new Date();
function appStatus(s) {
  if (s.status === 'pending') return { cls: 'pending', label: s.stage || 'Received' };
  return { accepted: { cls: 'accepted', label: 'Accepted' }, denied: { cls: 'denied', label: 'Not accepted' },
    withdrawn: { cls: 'withdrawn', label: 'Withdrawn' } }[s.status] || { cls: 'pending', label: s.status };
}
const appCanSettings = (dept) => hasPerm('applications.settings', dept);
const appReviewDepts = () => APP_DEPTS.filter((d) => hasPerm('applications.review', d));
const appTag = (dept) => `<span class="app-dtag" style="--c:${appDept(dept).color}">${esc(dept)}</span>`;
const appThumbs = (up, down) => (up || down) ? `<span class="app-votes">${up ? `<span class="app-v up"><span class="app-vi" style="--icon:${iconUrl('thumb-up')}" aria-hidden="true"></span>${up}</span>` : ''}${down ? `<span class="app-v down"><span class="app-vi" style="--icon:${iconUrl('thumb-down')}" aria-hidden="true"></span>${down}</span>` : ''}</span>` : '';

// The steps an application goes through: Received, the department's stages, then the decision.
function appSteps(stages, cur, status) {
  const steps = ['Received', ...(stages || []), status === 'accepted' ? 'Accepted' : status === 'denied' ? 'Not accepted' : 'Decision'];
  const at = status === 'pending' ? Math.max(0, steps.indexOf(cur || 'Received')) : steps.length - 1;
  return `<ol class="app-steps${status === 'denied' ? ' denied' : ''}">${steps.map((s, i) =>
    `<li class="${i < at ? 'done' : i === at ? 'on' : ''}"><span class="app-step-dot" aria-hidden="true"></span><span class="app-step-l">${esc(s)}</span></li>`).join('')}</ol>`;
}

// ===================================================================== Apply
async function renderApplyPage(body) {
  body.innerHTML = '<div class="card"><p class="muted small">Loading…</p></div>';
  const { data, error } = await sb.rpc('app_my_forms');
  if (error) { body.innerHTML = ''; return liveError(body, error); }
  const forms = (data || []).filter((f) => f.department);
  body.innerHTML = `<div class="ap-grid">${forms.map(card).join('') || '<div class="card"><p class="muted small">Nothing open right now.</p></div>'}</div>`;

  function card(f) {
    const d = appDept(f.department), L = f.latest;
    let state;
    if (L && L.status === 'pending') {
      state = `<div class="ap-state">
        <div class="ap-state-h"><span class="app-st app-st-pending">${esc(L.stage || 'Received')}</span><span class="muted">Applied ${esc(appDate(L.created_at))}</span></div>
        ${appSteps(f.stages, L.stage, 'pending')}
        <div class="ap-withdraw" data-wd="${L.id}"><button type="button" class="ghost small-btn" data-ask="${L.id}">Withdraw</button></div>
      </div>`;
    } else if (L && L.status === 'accepted') {
      state = `<div class="ap-state"><div class="ap-state-h"><span class="app-st app-st-accepted">Accepted</span><span class="muted">${esc(appDate(L.reviewed_at || L.created_at))}</span></div>
        ${L.review_note ? `<blockquote class="ap-note">${esc(L.review_note)}</blockquote>` : ''}</div>`;
    } else {
      const wait = appLater(f.next_allowed);
      state = `<div class="ap-state">
        ${L && L.status === 'denied' ? `<div class="ap-state-h"><span class="app-st app-st-denied">Not accepted</span><span class="muted">${esc(appDate(L.reviewed_at || L.created_at))}</span></div>
          ${L.review_note ? `<blockquote class="ap-note">${esc(L.review_note)}</blockquote>` : ''}` : ''}
        ${!f.open ? '<p class="ap-closed">Applications are closed.</p>'
          : wait ? `<p class="ap-closed">You can apply again on ${esc(appDate(f.next_allowed))}.</p>`
            : `<button type="button" class="refresh ap-go" data-apply="${esc(f.key)}">Apply</button>`}
      </div>`;
    }
    return `<article class="card ap-card" style="--c:${d.color}">
      <div class="ap-top">
        <span class="ap-ico" style="--icon:${iconUrl(d.icon || 'resume')}" aria-hidden="true"></span>
        <div class="ap-head"><h2>${esc(f.department)}</h2>${f.description ? `<p>${esc(f.description)}</p>` : ''}</div>
        <span class="ap-flag ${f.open ? 'open' : ''}">${f.open ? 'Open' : 'Closed'}</span>
      </div>
      ${state}
    </article>`;
  }

  body.onclick = async (e) => {
    const go = e.target.closest('[data-apply]');
    if (go) return applyForm(body, forms.find((f) => f.key === go.dataset.apply));
    const ask = e.target.closest('[data-ask]');
    if (ask) {
      ask.parentElement.innerHTML = `<span class="ap-confirm">Withdraw your application?</span>
        <button type="button" class="ghost small-btn danger-text" data-wdyes="${ask.dataset.ask}">Withdraw</button>
        <button type="button" class="ghost small-btn" data-wdno>Keep it</button>`;
      return;
    }
    if (e.target.closest('[data-wdno]')) return renderApplyPage(body);
    const yes = e.target.closest('[data-wdyes]');
    if (yes) {
      yes.disabled = true;
      const { error: err } = await sb.rpc('app_withdraw', { sub_id: +yes.dataset.wdyes });
      if (err) { yes.disabled = false; return yes.parentElement.insertAdjacentHTML('beforeend', `<p class="error">${esc(err.message)}</p>`); }
      renderApplyPage(body);
    }
  };
}

function applyForm(body, f) {
  const d = appDept(f.department);
  body.onclick = null;
  body.innerHTML = `
    <button class="back inline-back" type="button"><span class="back-ico" aria-hidden="true"></span>All applications</button>
    <form class="card case-form ap-form" id="ap-form" style="--c:${d.color}">
      <div class="ap-form-h"><span class="ap-ico" style="--icon:${iconUrl(d.icon || 'resume')}" aria-hidden="true"></span>
        <div><h2 class="form-title">${esc(f.title)}</h2>${f.description ? `<p class="muted">${esc(f.description)}</p>` : ''}</div></div>
      ${(f.questions || []).map(questionField).join('')}
      <p class="error" id="ap-err" hidden></p>
      <div class="f-actions"><button class="refresh" type="submit">Send application</button></div>
    </form>`;
  body.querySelector('.inline-back').onclick = () => renderApplyPage(body);
  const yesno = {};
  body.querySelectorAll('[data-yesno]').forEach((g) => g.addEventListener('click', (e) => {
    const b = e.target.closest('.seg-btn'); if (!b) return;
    yesno[g.dataset.yesno] = b.dataset.v;
    g.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('on', x === b));
  }));
  body.querySelector('#ap-form').onsubmit = async (e) => {
    e.preventDefault();
    const err = body.querySelector('#ap-err'); err.hidden = true;
    const answers = {};
    for (const q of f.questions || []) {
      const id = `q-${q.id}`;
      const v = q.type === 'yesno' ? yesno[id] : body.querySelector('#' + CSS.escape(id))?.value.trim();
      if (q.required && !v) { err.textContent = `Please answer “${q.label}”.`; err.hidden = false; return; }
      if (v) answers[q.id] = q.type === 'number' ? Number(v) : v;
    }
    const btn = e.submitter; if (btn) btn.disabled = true;
    const { error } = await sb.from('form_submissions').insert({ form_key: f.key, submitter_discord_id: myDiscordId, submitter_name: $('name').textContent, answers });
    if (error) { if (btn) btn.disabled = false; err.textContent = error.message; err.hidden = false; return; }
    body.innerHTML = `<div class="card center sent"><span class="t-ico big" style="--c:#2ed3c6;--icon:${iconUrl('verified')}" aria-hidden="true"></span>
      <h2 class="form-title">Application sent</h2><p class="muted">You’ll get a DM from CareBeyond Helper with the decision.</p>
      <button class="ghost" id="ap-done">Done</button></div>`;
    body.querySelector('#ap-done').onclick = () => renderApplyPage(body);
  };
}

// ===================================================================== Review
async function renderApplications(body) {
  const base = location.hash.startsWith('#review') ? '#review' : '#admin/applications';
  const id = +(location.hash.split('/')[base === '#review' ? 1 : 2] || 0);
  if (id) return appDetail(body, id, base);
  const depts = appReviewDepts();
  const st = { dept: 'all', done: false };
  body.innerHTML = `
    <div class="app-bar">
      <div class="ma-chips" id="app-depts"${depts.length > 1 ? '' : ' hidden'}>${['all', ...depts].map((d) => `<button type="button" class="chip${d === 'all' ? ' on' : ''}" data-d="${esc(d)}">${d === 'all' ? 'All departments' : esc(d)}<span class="count"></span></button>`).join('')}</div>
      <div class="app-bar-r">
        <div class="ma-seg" id="app-seg" role="group" aria-label="Show"><button type="button" data-done="0" aria-pressed="true">Waiting</button><button type="button" data-done="1" aria-pressed="false">Decided</button></div>
        <button type="button" class="gear" id="app-gear" aria-label="Application settings" hidden></button>
      </div>
    </div>
    <div id="app-settings"></div>
    <div id="app-list"><div class="card"><p class="muted small">Loading applications…</p></div></div>`;
  const $b = (s) => body.querySelector(s);
  const list = $b('#app-list');
  const [{ data: rows, error }, { data: forms }] = await Promise.all([sb.rpc('app_review_list', { include_done: true }), sb.from('forms').select('*').eq('kind', 'application')]);
  if (error) { list.innerHTML = ''; return liveError(list, error); }
  const all = rows || [];
  const formOf = (dept) => (forms || []).find((f) => (f.department || f.review_team) === dept);
  body.querySelectorAll('#app-depts [data-d]').forEach((b) => {
    const n = all.filter((r) => r.status === 'pending' && (b.dataset.d === 'all' || r.department === b.dataset.d)).length;
    b.querySelector('.count').textContent = n || '';
  });

  function gear() { $b('#app-gear').hidden = !(st.dept !== 'all' && appCanSettings(st.dept) && formOf(st.dept)); }
  function draw() {
    gear();
    const mine = all.filter((r) => (st.dept === 'all' || r.department === st.dept) && (st.done ? r.status !== 'pending' : r.status === 'pending'));
    if (!mine.length) { list.innerHTML = `<div class="card ma-empty"><strong>${st.done ? 'Nothing decided in the last 180 days.' : 'No applications waiting.'}</strong></div>`; return; }
    let groups;
    if (st.done) groups = [{ label: 'Decided', rows: mine.sort((a, b) => new Date(b.reviewed_at || b.created_at) - new Date(a.reviewed_at || a.created_at)) }];
    else {
      const order = ['Received'];
      (forms || []).filter((f) => st.dept === 'all' || (f.department || f.review_team) === st.dept).forEach((f) => (f.stages || []).forEach((s) => order.includes(s) || order.push(s)));
      mine.forEach((r) => order.includes(r.stage || 'Received') || order.push(r.stage));
      groups = order.map((label) => ({ label, rows: mine.filter((r) => (r.stage || 'Received') === label).sort((a, b) => new Date(a.created_at) - new Date(b.created_at)) })).filter((g) => g.rows.length);
    }
    list.innerHTML = groups.map((g) => `<section class="ma-section"><h2 class="ma-day">${esc(g.label)} <span class="count">${g.rows.length}</span></h2>
      <div class="card app-group">${g.rows.map(row).join('')}</div></section>`).join('');
    loadFaces(list);
  }
  function row(r) {
    const s = appStatus(r), name = cleanName(r.submitter_name || 'Unknown');
    return `<a class="app-row" href="${base}/${r.id}">
      ${face({ name, discordId: r.submitter_discord_id, avatarUrl: r.avatar_url, size: 'm' })}
      <span class="app-row-main"><span class="app-row-1"><strong>${esc(name)}</strong>${st.dept === 'all' ? appTag(r.department) : ''}</span>
        <span class="app-row-2">${st.done ? `${esc(s.label)}${r.reviewer_name ? ` by ${esc(cleanName(r.reviewer_name))}` : ''} · ${esc(appDate(r.reviewed_at || r.created_at))}` : `Applied ${esc(appAgo(r.created_at))}`}</span></span>
      <span class="app-row-r">${appThumbs(+r.up, +r.down)}${+r.notes ? `<span class="app-ncount">${plural(+r.notes, 'note')}</span>` : ''}${st.done ? `<span class="app-st app-st-${s.cls}">${esc(s.label)}</span>` : ''}</span>
    </a>`;
  }
  $b('#app-depts').onclick = (e) => {
    const b = e.target.closest('[data-d]'); if (!b) return;
    st.dept = b.dataset.d; $b('#app-settings').innerHTML = '';
    body.querySelectorAll('#app-depts [data-d]').forEach((x) => x.classList.toggle('on', x === b));
    draw();
  };
  $b('#app-seg').onclick = (e) => {
    const b = e.target.closest('[data-done]'); if (!b) return;
    st.done = b.dataset.done === '1';
    body.querySelectorAll('#app-seg [data-done]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    draw();
  };
  $b('#app-gear').onclick = () => {
    const box = $b('#app-settings');
    if (box.innerHTML) { box.innerHTML = ''; return; }
    appSettings(box, formOf(st.dept), () => renderApplications(body));
  };
  if (depts.length === 1) $b(`#app-depts [data-d="${CSS.escape(depts[0])}"]`)?.click(); else draw();
}

// ---------- one application ----------
async function appDetail(body, id, base) {
  body.innerHTML = '<div class="card"><p class="muted small">Loading the application…</p></div>';
  const { data: d, error } = await sb.rpc('app_detail', { sub_id: id });
  if (error) { body.innerHTML = ''; return liveError(body, error); }
  if (!d) { body.innerHTML = `<a class="back inline-back" href="${base}"><span class="back-ico" aria-hidden="true"></span>All applications</a><div class="card"><p class="muted small">This application doesn’t exist or isn’t yours to review.</p></div>`; return; }
  const s = d.sub, f = d.form, a = d.applicant || {}, dept = f.department, stat = appStatus(s);
  const name = cleanName(a.display_name || s.submitter_name || 'Unknown');
  const qs = f.questions || [];
  const asked = new Set(qs.map((q) => q.id));
  const answers = [...qs.filter((q) => s.answers && s.answers[q.id] != null).map((q) => [q.label, s.answers[q.id]]),
    ...Object.entries(s.answers || {}).filter(([k]) => !asked.has(k))];
  const ups = d.notes.filter((n) => n.vote === 1).length, downs = d.notes.filter((n) => n.vote === -1).length;
  const myVote = (d.notes.filter((n) => n.mine && n.vote).pop() || {}).vote || 0;
  const own = s.submitter_discord_id === myDiscordId;
  const formTitle = (k) => ({ 'admin-application': 'Administration', 'ce-application': 'Community Engagement', 'nursing-application': 'Nursing', 'paramedicine-application': 'Paramedicine' }[k] || k);
  const accAge = a.account_created_at ? Math.floor((Date.now() - new Date(a.account_created_at)) / 864e5) : null;

  body.innerHTML = `
    <a class="back inline-back" href="${base}"><span class="back-ico" aria-hidden="true"></span>All applications</a>
    <div class="app-detail">
      <div class="app-col">
        <section class="card app-who" style="--c:${appDept(dept).color}">
          ${face({ name, discordId: s.submitter_discord_id, avatarUrl: a.avatar_url, size: 'l' })}
          <div class="app-who-main">
            <h2>${access.admin ? `<button type="button" class="ma-name" data-rec="${esc(s.submitter_discord_id)}" data-name="${esc(name)}">${esc(name)}</button>` : esc(name)}</h2>
            <div class="app-who-tags">${appTag(dept)}<span class="app-st app-st-${stat.cls}">${esc(stat.label)}</span></div>
          </div>
          <dl class="app-facts">
            <div><dt>Applied</dt><dd>${esc(appDate(s.created_at))}</dd></div>
            <div><dt>Account</dt><dd>${accAge == null ? '–' : accAge < 30 ? `<strong class="app-warn">${plural(accAge, 'day')} old</strong>` : accAge < 365 ? `${plural(Math.floor(accAge / 30), 'month')} old` : `${plural(Math.floor(accAge / 365), 'year')} old`}</dd></div>
            <div><dt>In the server</dt><dd>${a.joined_at ? `since ${esc(appDate(a.joined_at))}` : '<span class="app-warn">Not in the server</span>'}</dd></div>
            <div><dt>Before</dt><dd>${d.history.length ? d.history.map((h) => `<span class="app-hist">${esc(formTitle(h.form_key))} · <span class="app-st app-st-${appStatus(h).cls}">${esc(appStatus(h).label)}</span> · ${esc(appDate(h.created_at))}</span>`).join('') : 'First application'}</dd></div>
          </dl>
        </section>

        <section class="card app-progress">
          <h3 class="app-h">Progress</h3>
          ${appSteps(f.stages, s.stage, s.status)}
          ${s.status === 'pending' ? `<div class="app-move">${['', ...(f.stages || [])].map((x) =>
            `<button type="button" class="chip${(s.stage || '') === x ? ' on' : ''}" data-stage="${esc(x)}">${esc(x || 'Received')}</button>`).join('')}</div>` : ''}
        </section>

        <section class="card app-answers">
          <h3 class="app-h">Answers</h3>
          ${answers.map(([q, v]) => `<div class="answer"><div class="answer-q">${esc(q)}</div><div class="answer-a">${esc(v)}</div></div>`).join('') || '<p class="muted small">No answers.</p>'}
        </section>
      </div>

      <div class="app-col app-side">
        <section class="card app-decide" id="app-decide">${decideHtml()}</section>
        <section class="card app-notes">
          <div class="app-notes-h"><h3 class="app-h">Team notes</h3>${appThumbs(ups, downs)}</div>
          <div class="app-note-list">${d.notes.map((n) => `
            <div class="app-note${n.body ? '' : ' vote-only'}">
              <div class="app-note-meta"><strong>${esc(cleanName(n.author_name || 'Someone'))}</strong>${n.vote ? `<span class="app-v ${n.vote > 0 ? 'up' : 'down'}"><span class="app-vi" style="--icon:${iconUrl(n.vote > 0 ? 'thumb-up' : 'thumb-down')}" aria-label="${n.vote > 0 ? 'Thumbs up' : 'Thumbs down'}"></span></span>` : ''}
                <span class="muted">${esc(when(n.created_at))}</span>${n.mine ? `<button type="button" class="app-x" data-del="${n.id}" aria-label="Delete">Delete</button>` : ''}</div>
              ${n.body ? `<div class="app-note-b">${esc(n.body)}</div>` : ''}
            </div>`).join('') || '<p class="muted small">No notes yet.</p>'}</div>
          <form class="app-compose" id="app-compose">
            <textarea id="app-note" rows="2" maxlength="2000" placeholder="Add a note for the team" aria-label="Note for the team"></textarea>
            <div class="app-compose-r">
              <div class="app-thumbs" role="group" aria-label="Your vote">
                <button type="button" class="app-tb up${myVote === 1 ? ' on' : ''}" data-vote="1" aria-pressed="${myVote === 1}" aria-label="Thumbs up"><span class="app-vi" style="--icon:${iconUrl('thumb-up')}"></span></button>
                <button type="button" class="app-tb down${myVote === -1 ? ' on' : ''}" data-vote="-1" aria-pressed="${myVote === -1}" aria-label="Thumbs down"><span class="app-vi" style="--icon:${iconUrl('thumb-down')}"></span></button>
              </div>
              <button type="submit" class="refresh small-btn">Add note</button>
            </div>
            <p class="error" id="app-note-err" hidden></p>
          </form>
        </section>
      </div>
    </div>`;
  loadFaces(body);
  const $b = (q) => body.querySelector(q);
  const reload = () => appDetail(body, id, base);

  function decideHtml() {
    if (s.status !== 'pending') {
      return `<h3 class="app-h">Decision</h3><p class="app-dec"><span class="app-st app-st-${stat.cls}">${esc(stat.label)}</span>
        ${s.reviewer_name ? `by <strong>${esc(cleanName(s.reviewer_name))}</strong>` : ''} · ${esc(appDate(s.reviewed_at || s.withdrawn_at || s.created_at))}</p>
        ${s.review_note ? `<blockquote class="ap-note">${esc(s.review_note)}</blockquote>` : ''}`;
    }
    if (own) return '<h3 class="app-h">Decision</h3><p class="muted small">Someone else decides your own application.</p>';
    return `<h3 class="app-h">Decision</h3><div class="app-dec-btns">
      <button type="button" class="refresh" data-dec="accept">Accept</button>
      <button type="button" class="ghost" data-dec="deny">Not accept</button></div>`;
  }

  async function openDecide(accept) {
    const box = $b('#app-decide');
    const canRoles = appCanSettings(dept);
    let choices = [];
    if (accept) choices = (await sb.rpc('app_role_choices', { dept })).data || [];
    const ranks = choices.filter((r) => r.kind === 'rank'), extras = choices.filter((r) => r.kind !== 'rank' && r.kind !== 'department');
    const roleName = (rid) => (choices.find((r) => r.id === rid) || {}).name || 'Unknown role';
    box.innerHTML = `<h3 class="app-h">${accept ? 'Accept' : 'Not accept'} ${esc(name)}</h3>
      <form class="app-dec-form" id="app-dec-form">
        <label class="f"><span>Message to ${esc(name)} <em>(sent in their DM)</em></span>
          <textarea id="app-msg" rows="3" maxlength="1000" placeholder="${accept ? 'Welcome to the team…' : 'Thanks for applying…'}"></textarea></label>
        ${accept ? `<div class="f"><span>Roles they get</span>
          ${canRoles ? `<select id="app-rank" aria-label="Starting rank">${ranks.map((r) => `<option value="${esc(r.id)}"${r.id === f.accept_rank_role_id ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}</select>
            <div class="app-roles">${extras.map((r) => `<label class="app-role"><input type="checkbox" value="${esc(r.id)}"${(f.accept_role_ids || []).includes(r.id) ? ' checked' : ''}><span>${esc(cleanName(r.name))}</span></label>`).join('')}</div>`
            : `<div class="app-roles ro">${[f.accept_rank_role_id, ...(f.accept_role_ids || [])].filter(Boolean).map((rid) => `<span class="app-role-ro">${esc(cleanName(roleName(rid)))}</span>`).join('') || '<span class="muted">No roles</span>'}</div>`}
          <span class="app-hint">Plus the ${esc(dept)} role. The bot gives them within a minute.</span></div>` : ''}
        <p class="error" id="app-dec-err" hidden></p>
        <div class="f-actions"><button type="button" class="ghost" id="app-dec-cancel">Cancel</button>
          <button type="submit" class="refresh${accept ? '' : ' danger-fill'}">${accept ? 'Accept' : 'Not accept'}</button></div>
      </form>`;
    $b('#app-dec-cancel').onclick = () => { box.innerHTML = decideHtml(); };
    $b('#app-dec-form').onsubmit = async (e) => {
      e.preventDefault();
      const btn = e.submitter; if (btn) btn.disabled = true;
      const args = { sub_id: id, accept, note: $b('#app-msg').value.trim() || null };
      if (accept && canRoles) {
        args.rank_role_id = $b('#app-rank')?.value || null;
        args.role_ids = [...box.querySelectorAll('.app-role input:checked')].map((x) => x.value);
      }
      const { error: err } = await sb.rpc('app_decide', args);
      if (err) { if (btn) btn.disabled = false; const p = $b('#app-dec-err'); p.textContent = err.message; p.hidden = false; return; }
      reload();
    };
  }

  let vote = 0;
  body.onclick = async (e) => {
    const r = e.target.closest('[data-rec]');
    if (r) { rememberRecord(r.dataset.rec, r.dataset.name); openRecord(r.dataset.rec); return; }
    const dec = e.target.closest('[data-dec]');
    if (dec) return openDecide(dec.dataset.dec === 'accept');
    const stg = e.target.closest('[data-stage]');
    if (stg && !stg.classList.contains('on')) {
      const { error: err } = await sb.rpc('app_set_stage', { sub_id: id, new_stage: stg.dataset.stage });
      if (err) return stg.parentElement.insertAdjacentHTML('afterend', `<p class="error">${esc(err.message)}</p>`);
      return reload();
    }
    const v = e.target.closest('[data-vote]');
    if (v) {
      vote = vote === +v.dataset.vote ? 0 : +v.dataset.vote;
      body.querySelectorAll('[data-vote]').forEach((x) => { const on = +x.dataset.vote === vote; x.classList.toggle('on', on); x.setAttribute('aria-pressed', String(on)); });
      return;
    }
    const del = e.target.closest('[data-del]');
    if (del) { await sb.rpc('app_note_delete', { note_id: +del.dataset.del }); reload(); }
  };
  $b('#app-compose').onsubmit = async (e) => {
    e.preventDefault();
    const text = $b('#app-note').value.trim(), err = $b('#app-note-err');
    if (!text && !vote) { err.textContent = 'Write a note or choose thumbs up or down.'; err.hidden = false; return; }
    const { error: er } = await sb.rpc('app_note', { sub_id: id, p_note: text || null, p_vote: vote || null });
    if (er) { err.textContent = er.message; err.hidden = false; return; }
    reload();
  };
}

// ---------- department settings (gear) ----------
// Executives: open/closed, title, description, questions. applications.settings: stages, roles, wait.
async function appSettings(box, f, done) {
  const dept = f.department || f.review_team, ex = access.exec;
  const choices = (await sb.rpc('app_role_choices', { dept })).data || [];
  const ranks = choices.filter((r) => r.kind === 'rank'), extras = choices.filter((r) => r.kind !== 'rank' && r.kind !== 'department');
  let qs = JSON.parse(JSON.stringify(f.questions || []));
  let stages = [...(f.stages || [])];
  const TYPES = [['text', 'Short answer'], ['long', 'Long answer'], ['number', 'Number'], ['choice', 'Choice'], ['yesno', 'Yes or no']];

  box.innerHTML = `<form class="card app-set" id="app-set">
    <div class="app-set-h"><h2 class="app-h">${esc(dept)} application settings</h2><button type="button" class="app-x" id="app-set-close">Close</button></div>
    ${ex ? `<fieldset class="app-fs"><legend>Form</legend>
      <label class="app-switch"><input type="checkbox" id="as-open"${f.open ? ' checked' : ''}><span>Open for applications</span></label>
      <label class="f"><span>Title</span><input id="as-title" maxlength="80" value="${esc(f.title)}"></label>
      <label class="f"><span>Description <em>(optional)</em></span><input id="as-desc" maxlength="200" value="${esc(f.description || '')}"></label>
      <div class="f"><span>Questions</span><div id="as-qs" class="as-qs"></div><button type="button" class="ghost small-btn" id="as-addq">Add a question</button></div>
    </fieldset>` : ''}
    <fieldset class="app-fs"><legend>Review</legend>
      <div class="f"><span>Stages <em>(between Received and the decision)</em></span><div id="as-stages" class="as-stages"></div>
        <div class="as-add"><input id="as-newstage" maxlength="40" placeholder="New stage, e.g. Interview" aria-label="New stage"><button type="button" class="ghost small-btn" id="as-addstage">Add</button></div></div>
      <label class="f"><span>Starting rank when accepted</span><select id="as-rank">${ranks.map((r) => `<option value="${esc(r.id)}"${r.id === f.accept_rank_role_id ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label>
      <div class="f"><span>Extra roles when accepted <em>(optional)</em></span><div class="app-roles">${extras.map((r) => `<label class="app-role"><input type="checkbox" value="${esc(r.id)}"${(f.accept_role_ids || []).includes(r.id) ? ' checked' : ''}><span>${esc(cleanName(r.name))}</span></label>`).join('')}</div></div>
      <label class="f as-wait"><span>Wait before reapplying after “Not accepted”</span><span class="as-days"><input id="as-wait" type="number" min="0" max="365" value="${f.cooldown_days ?? 14}"> days</span></label>
    </fieldset>
    <p class="error" id="as-err" hidden></p>
    <div class="f-actions"><button type="button" class="ghost" id="as-cancel">Cancel</button><button type="submit" class="refresh">Save</button></div>
  </form>`;
  const $s = (q) => box.querySelector(q);

  function drawStages() {
    $s('#as-stages').innerHTML = stages.length ? stages.map((x, i) => `<span class="as-stage"><span class="as-n">${i + 1}</span>${esc(x)}
      <button type="button" data-sup="${i}" aria-label="Move ${esc(x)} earlier"${i ? '' : ' disabled'}>↑</button><button type="button" data-srm="${i}" aria-label="Remove ${esc(x)}">×</button></span>`).join('')
      : '<span class="muted small">No stages: straight from Received to the decision.</span>';
  }
  function drawQs() {
    if (!ex) return;
    $s('#as-qs').innerHTML = qs.map((q, i) => `<div class="as-q" data-i="${i}">
      <input class="as-ql" maxlength="200" value="${esc(q.label)}" aria-label="Question ${i + 1}" placeholder="Question">
      <select class="as-qt" aria-label="Answer type">${TYPES.map(([v, l]) => `<option value="${v}"${q.type === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
      <label class="as-qr"><input type="checkbox" class="as-qreq"${q.required ? ' checked' : ''}> Required</label>
      <span class="as-qbtns"><button type="button" data-qup="${i}" aria-label="Move up"${i ? '' : ' disabled'}>↑</button><button type="button" data-qrm="${i}" aria-label="Remove">×</button></span>
      ${q.type === 'choice' ? `<input class="as-qo" maxlength="400" value="${esc((q.options || []).join(', '))}" placeholder="Choices, separated by commas" aria-label="Choices">` : ''}
    </div>`).join('') || '<span class="muted small">No questions yet.</span>';
  }
  function readQs() {
    if (!ex) return;
    box.querySelectorAll('.as-q').forEach((el) => {
      const q = qs[+el.dataset.i];
      q.label = el.querySelector('.as-ql').value.trim(); q.type = el.querySelector('.as-qt').value; q.required = el.querySelector('.as-qreq').checked;
      const o = el.querySelector('.as-qo'); if (o) q.options = o.value.split(',').map((x) => x.trim()).filter(Boolean); else delete q.options;
    });
  }
  drawStages(); drawQs();
  box.onchange = (e) => { if (e.target.classList.contains('as-qt')) { readQs(); drawQs(); } };
  box.onclick = (e) => {
    const t = e.target;
    if (t.id === 'app-set-close' || t.id === 'as-cancel') { box.innerHTML = ''; return; }
    if (t.id === 'as-addstage') { const v = $s('#as-newstage').value.trim(); if (v && !stages.includes(v) && stages.length < 8) { stages.push(v); $s('#as-newstage').value = ''; drawStages(); } return; }
    if (t.dataset.sup) { const i = +t.dataset.sup; [stages[i - 1], stages[i]] = [stages[i], stages[i - 1]]; drawStages(); return; }
    if (t.dataset.srm) { stages.splice(+t.dataset.srm, 1); drawStages(); return; }
    if (t.id === 'as-addq') { readQs(); qs.push({ id: 'q' + Date.now().toString(36), type: 'text', label: '', required: true }); drawQs(); box.querySelector('.as-q:last-child .as-ql')?.focus(); return; }
    if (t.dataset.qup) { readQs(); const i = +t.dataset.qup; [qs[i - 1], qs[i]] = [qs[i], qs[i - 1]]; drawQs(); return; }
    if (t.dataset.qrm) { readQs(); qs.splice(+t.dataset.qrm, 1); drawQs(); }
  };
  $s('#as-newstage').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $s('#as-addstage').click(); } };
  $s('#app-set').onsubmit = async (e) => {
    e.preventDefault();
    readQs();
    const err = $s('#as-err'); err.hidden = true;
    const patch = { stages, accept_rank_role_id: $s('#as-rank').value || null,
      accept_role_ids: [...box.querySelectorAll('.app-role input:checked')].map((x) => x.value), cooldown_days: Math.max(0, Math.min(365, +$s('#as-wait').value || 0)) };
    if (ex) {
      if (qs.some((q) => !q.label)) { err.textContent = 'Every question needs some text.'; err.hidden = false; return; }
      if (qs.some((q) => q.type === 'choice' && !(q.options || []).length)) { err.textContent = 'Choice questions need at least one choice.'; err.hidden = false; return; }
      Object.assign(patch, { open: $s('#as-open').checked, title: $s('#as-title').value.trim(), description: $s('#as-desc').value.trim(), questions: qs });
    }
    const btn = e.submitter; if (btn) btn.disabled = true;
    const { error } = await sb.rpc('app_form_save', { form_key: f.key, patch });
    if (error) { if (btn) btn.disabled = false; err.textContent = error.message; err.hidden = false; return; }
    done();
  };
}

LIVE.apply = renderApplyPage;
LIVE.review = renderApplications;
