// Applications v2 (owner, 19 Nov 2026): every department's applications live in its department page, as an
// "Applications" tab (dept.js DEPT_TABS hook, Bravo): To review, Forms (the builder) and Decided. Apply (#apply) is the
// applicant side. Back end: 0028, 0032 (audiences, drafts, builder), 0035, 0037 (reviewer roles, approvals), 0038.
// Permissions (0027): applications.review = the queue; applications.settings = the builder. Who reviews a form, how
// many approvals it needs and whether an exec gives the final Accept: execs and the department's Director only.
// Loaded after app.js (questionField, DEPARTMENTS, iconUrl, hasPerm, myDirects), faces.js and cases.js.
// Every department (app.js DEPARTMENTS, from the departments table, 0060). A getter, so it follows the table once loaded.
const APP_DEPTS = { filter: (f) => DEPARTMENTS.map((d) => d.name).filter(f), find: (f) => DEPARTMENTS.map((d) => d.name).find(f) };
const appDept = (name) => DEPARTMENTS.find((d) => d.name === name) || { name, id: '', color: '#3a82d0', icon: 'resume' };
const appDate = (iso) => new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
const appAgo = (iso) => { const d = Math.floor((Date.now() - new Date(iso)) / 864e5); return d < 1 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`; };
const appLater = (iso) => iso && iso !== 'infinity' && new Date(iso) > new Date();
function appStatus(s) {
  if (s.status === 'pending') return { cls: 'pending', label: s.stage || 'Received' };
  return { accepted: { cls: 'accepted', label: 'Accepted' }, denied: { cls: 'denied', label: 'Not accepted' },
    withdrawn: { cls: 'withdrawn', label: 'Withdrawn' } }[s.status] || { cls: 'pending', label: s.status };
}
const appCanReview = (dept) => hasPerm('applications.review', dept);
const appCanEdit = (dept) => hasPerm('applications.settings', dept);
const appCanReviewers = (dept) => !!access.exec || (typeof myDirects !== 'undefined' && myDirects.includes(dept));
const appTag = (text, dept) => `<span class="app-dtag" style="--c:${appDept(dept).color}">${esc(text)}</span>`;
const appThumbs = (up, down) => (up || down) ? `<span class="app-votes">${up ? `<span class="app-v up"><span class="app-vi" style="--icon:${iconUrl('thumb-up')}" aria-hidden="true"></span>${up}</span>` : ''}${down ? `<span class="app-v down"><span class="app-vi" style="--icon:${iconUrl('thumb-down')}" aria-hidden="true"></span>${down}</span>` : ''}</span>` : '';
const appRoute = (dept, rest = '') => `#directors/${appDept(dept).id}/applications${rest ? '/' + rest : ''}`;
const appSetHash = (h) => { try { history.replaceState(null, '', h); } catch { /* fine */ } };

function appSteps(stages, cur, status) {
  const steps = ['Received', ...(stages || []), status === 'accepted' ? 'Accepted' : status === 'denied' ? 'Not accepted' : 'Decision'];
  const at = status === 'pending' ? Math.max(0, steps.indexOf(cur || 'Received')) : steps.length - 1;
  return `<ol class="app-steps${status === 'denied' ? ' denied' : ''}">${steps.map((s, i) =>
    `<li class="${i < at ? 'done' : i === at ? 'on' : ''}"><span class="app-step-dot" aria-hidden="true"></span><span class="app-step-l">${esc(s)}</span></li>`).join('')}</ol>`;
}

// A form's questions for an applicant: section items become headings.
function appQuestionsHtml(qs) {
  return (qs || []).map((q) => (q.type === 'section' ? `<h3 class="ap-sec">${esc(q.label)}</h3>` : questionField(q))).join('');
}

// ===================================================================== Apply (#apply)
async function renderApplyPage(body) {
  body.innerHTML = '<div class="card"><p class="muted small">Loading…</p></div>';
  const { data, error } = await sb.rpc('app_my_forms');
  if (error) { body.innerHTML = ''; return liveError(body, error); }
  const forms = (data || []).filter((f) => f.department);
  if (!forms.length) { body.innerHTML = '<div class="card"><p class="muted small">There’s nothing for you to apply to right now.</p></div>'; return; }
  const depts = APP_DEPTS.filter((d) => forms.some((f) => f.department === d));
  body.innerHTML = depts.map((dn) => {
    const d = appDept(dn), mine = forms.filter((f) => f.department === dn);
    const secs = [...new Set(mine.map((f) => f.section || 'General'))];
    return `<section class="ap-dept" style="--c:${d.color}">
      <h2 class="ap-dept-h"><span class="ap-ico" style="--icon:${iconUrl(d.icon || 'resume')}" aria-hidden="true"></span>${esc(dn)}</h2>
      ${secs.map((s) => `${secs.length > 1 ? `<h3 class="ma-day ap-sec-h">${esc(s)}</h3>` : ''}<div class="ap-grid">${mine.filter((f) => (f.section || 'General') === s).map(card).join('')}</div>`).join('')}
    </section>`;
  }).join('');

  function card(f) {
    const L = f.latest;
    let state;
    if (L && L.status === 'pending') {
      state = `<div class="ap-state">
        <div class="ap-state-h"><span class="app-st app-st-pending">${esc(L.stage || 'Received')}</span><span class="muted">Applied ${esc(appDate(L.created_at))}</span></div>
        ${appSteps(f.stages, L.stage, 'pending')}
        <div class="ap-withdraw"><button type="button" class="ghost small-btn" data-ask="${L.id}">Withdraw</button></div>
      </div>`;
    } else if (L && L.status === 'accepted') {
      state = `<div class="ap-state"><div class="ap-state-h"><span class="app-st app-st-accepted">Accepted</span><span class="muted">${esc(appDate(L.reviewed_at || L.created_at))}</span></div>
        ${L.review_note ? `<blockquote class="ap-note">${esc(L.review_note)}</blockquote>` : ''}</div>`;
    } else {
      state = `<div class="ap-state">
        ${L && L.status === 'denied' ? `<div class="ap-state-h"><span class="app-st app-st-denied">Not accepted</span><span class="muted">${esc(appDate(L.reviewed_at || L.created_at))}</span></div>
          ${L.review_note ? `<blockquote class="ap-note">${esc(L.review_note)}</blockquote>` : ''}` : ''}
        ${!f.open ? '<p class="ap-closed">Applications are closed.</p>'
          : !f.can_apply ? '<p class="ap-closed">This application isn’t open to you any more.</p>'
            : appLater(f.next_allowed) ? `<p class="ap-closed">You can apply again on ${esc(appDate(f.next_allowed))}.</p>`
              : `<button type="button" class="refresh ap-go" data-apply="${esc(f.key)}">Apply</button>`}
      </div>`;
    }
    return `<article class="card ap-card">
      <div class="ap-top"><div class="ap-head"><h2>${esc(f.title)}</h2>${f.description ? `<p>${esc(f.description)}</p>` : ''}</div>
        <span class="ap-flag ${f.open ? 'open' : ''}">${f.open ? 'Open' : 'Closed'}</span></div>
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

// The applicant's form. preview: show it without sending (the builder's Preview).
function applyForm(body, f, preview) {
  const d = appDept(f.department);
  if (!preview) body.onclick = null;
  body.innerHTML = `
    ${preview ? '<p class="app-preview-flag">Preview: this is what applicants see. Nothing is sent.</p>' : '<button class="back inline-back" type="button"><span class="back-ico" aria-hidden="true"></span>All applications</button>'}
    <form class="card case-form ap-form" id="ap-form" style="--c:${d.color}">
      <div class="ap-form-h"><span class="ap-ico" style="--icon:${iconUrl(d.icon || 'resume')}" aria-hidden="true"></span>
        <div><h2 class="form-title">${esc(f.title || 'Untitled application')}</h2>${f.description ? `<p class="muted">${esc(f.description)}</p>` : ''}</div></div>
      ${appQuestionsHtml(f.questions) || '<p class="muted small">No questions yet.</p>'}
      <p class="error" id="ap-err" hidden></p>
      <div class="f-actions"><button class="refresh" type="submit"${preview ? ' disabled' : ''}>Send application</button></div>
    </form>`;
  if (preview) return;
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
    for (const q of (f.questions || []).filter((x) => x.type !== 'section')) {
      const id = `q-${q.id}`;
      const v = q.type === 'yesno' ? yesno[id] : body.querySelector('#' + CSS.escape(id))?.value.trim();
      if (q.required && !v) { err.textContent = `Please answer “${q.label}”.`; err.hidden = false; return; }
      if (v) answers[q.id] = q.type === 'number' ? Number(v) : v;
    }
    const btn = e.submitter; if (btn) btn.disabled = true;
    const { error } = await sb.from('form_submissions').insert({ form_key: f.key, submitter_discord_id: myDiscordId, answers });
    if (error) { if (btn) btn.disabled = false; err.textContent = error.message; err.hidden = false; return; }
    body.innerHTML = `<div class="card center sent"><span class="t-ico big" style="--c:#2ed3c6;--icon:${iconUrl('verified')}" aria-hidden="true"></span>
      <h2 class="form-title">Application sent</h2><p class="muted">You’ll get a DM from CareBeyond Helper with the decision.</p>
      <button class="ghost" id="ap-done">Done</button></div>`;
    body.querySelector('#ap-done').onclick = () => renderApplyPage(body);
  };
}

// ===================================================================== old links
// #admin/applications[/<id>] and #review[/<id>] (0.19 and old Discord posts) open the right department tab.
async function appLegacyLink(id) {
  if (id) {
    const { data } = await sb.rpc('app_detail', { sub_id: id });
    if (data && data.form) { location.replace(appRoute(data.form.department, id)); return; }
  }
  const d = APP_DEPTS.find((x) => appCanReview(x) || appCanEdit(x));
  location.replace(d ? appRoute(d) : '#');
}

// ===================================================================== the department tab
window.DEPT_TABS = window.DEPT_TABS || [];
window.DEPT_TABS.push({
  id: 'applications', label: 'Applications',
  show: (dept) => appCanReview(dept) || appCanEdit(dept),
  count: async (dept) => (appCanReview(dept) ? ((await sb.rpc('app_review_queue', { include_done: false, dept })).data || []).length : 0),
  render: (el, dept, sub) => appTab(el, dept, sub || ''),
});

function appTab(el, dept, sub) {
  const views = [...(appCanReview(dept) ? [['review', 'To review']] : []), ...(appCanEdit(dept) ? [['forms', 'Forms']] : []),
    ...(appCanReview(dept) ? [['decided', 'Decided']] : [])];
  const [a, b] = String(sub).split('/');
  if (/^\d+$/.test(a)) return appDetail(el, dept, +a);
  if (a === 'forms' && b && appCanEdit(dept)) return appBuilder(el, dept, b);
  const view = views.some(([v]) => v === a) ? a : views[0][0];
  appSetHash(appRoute(dept, view === views[0][0] ? '' : view));
  el.innerHTML = `
    <div class="app-sub">
      ${views.length > 1 ? `<div class="ma-seg" role="group" aria-label="Show">${views.map(([v, l]) => `<button type="button" data-view="${v}" aria-pressed="${v === view}">${l}${v === 'review' ? '<span class="count" id="app-n"></span>' : ''}</button>`).join('')}</div>` : '<span></span>'}
      ${view === 'forms' ? '<button type="button" class="refresh" id="app-new">New application</button>' : ''}
    </div>
    <div id="app-body"><div class="card"><p class="muted small">Loading…</p></div></div>`;
  el.querySelector('.app-sub').onclick = (e) => { const v = e.target.closest('[data-view]'); if (v) appTab(el, dept, v.dataset.view); };
  const box = el.querySelector('#app-body');
  if (view === 'forms') return appFormsList(el, box, dept);
  return appQueue(el, box, dept, view === 'decided');
}

async function appQueue(el, box, dept, done) {
  const { data, error } = await sb.rpc('app_review_queue', { include_done: done, dept });
  if (error) { box.innerHTML = ''; return liveError(box, error); }
  const all = data || [];
  const n = el.querySelector('#app-n'); if (n) n.textContent = all.filter((r) => r.status === 'pending').length || '';
  const rows = done ? all.filter((r) => r.status !== 'pending').sort((x, y) => new Date(y.reviewed_at || y.created_at) - new Date(x.reviewed_at || x.created_at))
    : all.filter((r) => r.status === 'pending');
  if (!rows.length) { box.innerHTML = `<div class="card ma-empty"><strong>${done ? 'Nothing decided in the last 180 days.' : 'No applications waiting.'}</strong></div>`; return; }
  let groups;
  if (done) groups = [{ label: 'Decided', rows }];
  else {
    const order = ['Received'];
    rows.forEach((r) => (r.stages || []).forEach((s) => order.includes(s) || order.push(s)));
    rows.forEach((r) => order.includes(r.stage || 'Received') || order.push(r.stage));
    groups = order.map((label) => ({ label, rows: rows.filter((r) => (r.stage || 'Received') === label).sort((x, y) => new Date(x.created_at) - new Date(y.created_at)) })).filter((g) => g.rows.length);
  }
  box.innerHTML = groups.map((g) => `<section class="ma-section"><h2 class="ma-day">${esc(g.label)} <span class="count">${g.rows.length}</span></h2>
    <div class="card app-group">${g.rows.map((r) => {
      const s = appStatus(r), name = cleanName(r.submitter_name || 'Unknown'), need = +r.approvals_needed || 1;
      return `<button type="button" class="app-row" data-open="${r.id}">
        ${face({ name, discordId: r.submitter_discord_id, avatarUrl: r.avatar_url, size: 'm' })}
        <span class="app-row-main"><span class="app-row-1"><strong>${esc(name)}</strong>${appTag(r.form_title, dept)}</span>
          <span class="app-row-2">${done ? `${esc(s.label)}${r.reviewer_name ? ` by ${esc(cleanName(r.reviewer_name))}` : ''} · ${esc(appDate(r.reviewed_at || r.created_at))}` : `Applied ${esc(appAgo(r.created_at))}`}</span></span>
        <span class="app-row-r">${!done && need > 1 ? `<span class="app-appr${+r.approvals >= need ? ' met' : ''}">${+r.approvals} of ${need} approvals</span>` : ''}${appThumbs(+r.up, +r.down)}${+r.notes ? `<span class="app-ncount">${plural(+r.notes, 'note')}</span>` : ''}${done ? `<span class="app-st app-st-${s.cls}">${esc(s.label)}</span>` : ''}</span>
      </button>`;
    }).join('')}</div></section>`).join('');
  loadFaces(box);
  box.onclick = (e) => { const o = e.target.closest('[data-open]'); if (o) appDetail(el, dept, +o.dataset.open); };
}

// ---------- one application ----------
async function appDetail(el, dept, id) {
  appSetHash(appRoute(dept, id));
  el.innerHTML = '<div class="card"><p class="muted small">Loading the application…</p></div>';
  const { data: d, error } = await sb.rpc('app_detail', { sub_id: id });
  const back = '<button type="button" class="back inline-back" id="app-back"><span class="back-ico" aria-hidden="true"></span>All applications</button>';
  if (error) { el.innerHTML = back; liveError(el, error); } else if (!d) el.innerHTML = `${back}<div class="card"><p class="muted small">This application doesn’t exist or isn’t yours to review.</p></div>`;
  if (error || !d) { el.querySelector('#app-back').onclick = () => appTab(el, dept, ''); return; }
  const s = d.sub, f = d.form, a = d.applicant || {}, stat = appStatus(s);
  const name = cleanName(a.display_name || s.submitter_name || 'Unknown');
  const qs = (f.questions || []).filter((q) => q.type !== 'section'), asked = new Set(qs.map((q) => q.id));
  const answers = [];
  (f.questions || []).forEach((q) => { if (q.type === 'section') answers.push(['§', q.label]); else if (s.answers && s.answers[q.id] != null) answers.push([q.label, s.answers[q.id]]); });
  Object.entries(s.answers || {}).filter(([k]) => !asked.has(k)).forEach((x) => answers.push(x));
  const ups = d.notes.filter((n) => n.vote === 1).length, downs = d.notes.filter((n) => n.vote === -1).length;
  const myVote = (d.notes.filter((n) => n.mine && n.vote).pop() || {}).vote || 0;
  const own = s.submitter_discord_id === myDiscordId;
  const need = +d.approvals_needed || 1, appr = +d.approvals_count || 0;
  const myAppr = ((d.approvals || []).find((x) => x.mine) || {}).decision || 0;
  const accAge = a.account_created_at ? Math.floor((Date.now() - new Date(a.account_created_at)) / 864e5) : null;

  el.innerHTML = `${back}
    <div class="app-detail">
      <div class="app-col">
        <section class="card app-who" style="--c:${appDept(dept).color}">
          ${face({ name, discordId: s.submitter_discord_id, avatarUrl: a.avatar_url, size: 'l' })}
          <div class="app-who-main">
            <h2>${access.admin ? `<button type="button" class="ma-name" data-rec="${esc(s.submitter_discord_id)}" data-name="${esc(name)}">${esc(name)}</button>` : esc(name)}</h2>
            <div class="app-who-tags">${appTag(f.title, dept)}<span class="app-st app-st-${stat.cls}">${esc(stat.label)}</span></div>
          </div>
          <dl class="app-facts">
            <div><dt>Applied</dt><dd>${esc(appDate(s.created_at))}</dd></div>
            <div><dt>Account</dt><dd>${accAge == null ? '–' : accAge < 30 ? `<strong class="app-warn">${plural(accAge, 'day')} old</strong>` : accAge < 365 ? `${plural(Math.floor(accAge / 30), 'month')} old` : `${plural(Math.floor(accAge / 365), 'year')} old`}</dd></div>
            <div><dt>In the server</dt><dd>${a.joined_at ? `since ${esc(appDate(a.joined_at))}` : '<span class="app-warn">Not in the server</span>'}</dd></div>
            <div><dt>Before</dt><dd>${d.history.length ? d.history.map((h) => `<span class="app-hist">${esc(h.form_title || 'Application')} · <span class="app-st app-st-${appStatus(h).cls}">${esc(appStatus(h).label)}</span> · ${esc(appDate(h.created_at))}</span>`).join('') : 'First application'}</dd></div>
          </dl>
        </section>
        <section class="card app-progress">
          <h3 class="app-h">Progress</h3>
          ${appSteps(f.stages, s.stage, s.status)}
          ${s.status === 'pending' && (f.stages || []).length ? `<div class="app-move">${['', ...(f.stages || [])].map((x) =>
            `<button type="button" class="chip${(s.stage || '') === x ? ' on' : ''}" data-stage="${esc(x)}">${esc(x || 'Received')}</button>`).join('')}</div>` : ''}
        </section>
        <section class="card app-answers">
          <h3 class="app-h">Answers</h3>
          ${answers.map(([q, v]) => (q === '§' ? `<h4 class="app-asec">${esc(v)}</h4>` : `<div class="answer"><div class="answer-q">${esc(q)}</div><div class="answer-a">${esc(v)}</div></div>`)).join('') || '<p class="muted small">No answers.</p>'}
        </section>
      </div>
      <div class="app-col app-side">
        ${need > 1 ? `<section class="card app-approvals">
          <div class="app-notes-h"><h3 class="app-h">Approvals</h3><span class="app-appr${appr >= need ? ' met' : ''}">${appr} of ${need}</span></div>
          <div class="app-appr-bar" aria-hidden="true"><span style="width:${Math.min(100, (appr / need) * 100)}%"></span></div>
          <ul class="app-appr-list">${(d.approvals || []).map((x) => `<li${x.eligible === false ? ' class="stale"' : ''}><span class="app-appr-d ${x.decision > 0 ? 'up' : 'down'}">${x.decision > 0 ? 'Approved' : 'Rejected'}</span>${esc(cleanName(x.name || 'Someone'))}<span class="muted"> · ${x.eligible === false ? 'no longer a reviewer' : esc(when(x.at))}</span></li>`).join('') || '<li class="muted">No one yet.</li>'}</ul>
          ${s.status === 'pending' && !own ? `<div class="app-appr-btns">
            <button type="button" class="${myAppr === 1 ? 'refresh' : 'ghost'}" data-appr="${myAppr === 1 ? 0 : 1}">${myAppr === 1 ? 'Approved ✓' : 'Approve'}</button>
            <button type="button" class="ghost${myAppr === -1 ? ' on-reject' : ''}" data-appr="${myAppr === -1 ? 0 : -1}">${myAppr === -1 ? 'Rejected' : 'Reject'}</button></div>` : ''}
        </section>` : ''}
        <section class="card app-decide" id="app-decide">${decideHtml()}</section>
        <section class="card app-notes">
          <div class="app-notes-h"><h3 class="app-h">Team notes</h3>${appThumbs(ups, downs)}</div>
          <div class="app-note-list">${d.notes.map((n) => `
            <div class="app-note${n.body ? '' : ' vote-only'}">
              <div class="app-note-meta"><strong>${esc(cleanName(n.author_name || 'Someone'))}</strong>${n.vote ? `<span class="app-v ${n.vote > 0 ? 'up' : 'down'}"><span class="app-vi" style="--icon:${iconUrl(n.vote > 0 ? 'thumb-up' : 'thumb-down')}" aria-label="${n.vote > 0 ? 'Thumbs up' : 'Thumbs down'}"></span></span>` : ''}
                <span class="muted">${esc(when(n.created_at))}</span>${n.mine ? `<button type="button" class="app-x" data-del="${n.id}">Delete</button>` : ''}</div>
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
  loadFaces(el);
  const $e = (q) => el.querySelector(q);
  const reload = () => appDetail(el, dept, id);
  $e('#app-back').onclick = () => appTab(el, dept, '');

  function decideHtml() {
    if (s.status !== 'pending') {
      return `<h3 class="app-h">Decision</h3><p class="app-dec"><span class="app-st app-st-${stat.cls}">${esc(stat.label)}</span>
        ${s.reviewer_name ? `by <strong>${esc(cleanName(s.reviewer_name))}</strong>` : ''} · ${esc(appDate(s.reviewed_at || s.withdrawn_at || s.created_at))}</p>
        ${s.review_note ? `<blockquote class="ap-note">${esc(s.review_note)}</blockquote>` : ''}`;
    }
    if (own) return '<h3 class="app-h">Decision</h3><p class="muted small">Someone else decides your own application.</p>';
    // The final Accept counts as the decider's own approval (0044), so it opens one approval early.
    const withMe = appr + (myAppr === 1 ? 0 : 1);
    const waiting = need > 1 && withMe < need, execOnly = d.final_by_exec && !d.is_exec;
    return `<h3 class="app-h">Decision</h3>
      ${need > 1 ? `<p class="app-dec-note">${need} approvals needed, including yours when you Accept (${appr} so far).</p>` : ''}
      ${execOnly ? '<p class="app-dec-note">An executive gives the final Accept.</p>' : ''}
      <div class="app-dec-btns"><button type="button" class="refresh" data-dec="accept"${waiting || execOnly ? ' disabled' : ''}>Accept</button>
      <button type="button" class="ghost" data-dec="deny">Not accept</button></div>`;
  }

  async function openDecide(accept) {
    const box = $e('#app-decide');
    const canRoles = appCanEdit(dept);
    const choices = accept ? ((await sb.rpc('app_role_choices', { dept })).data || []) : [];
    const ranks = choices.filter((r) => r.kind === 'rank'), extras = choices.filter((r) => r.kind !== 'rank' && r.kind !== 'department');
    const roleName = (rid) => (choices.find((r) => r.id === rid) || {}).name || 'Unknown role';
    const onForm = (rid) => rid === f.accept_rank_role_id || (f.accept_role_ids || []).includes(rid);
    box.innerHTML = `<h3 class="app-h">${accept ? 'Accept' : 'Not accept'} ${esc(name)}</h3>
      <form class="app-dec-form" id="app-dec-form">
        <label class="f"><span>Message to ${esc(name)} <em>(sent in their DM)</em></span>
          <textarea id="app-msg" rows="3" maxlength="1000" placeholder="${accept ? 'Welcome to the team…' : 'Thanks for applying…'}"></textarea></label>
        ${accept ? `<div class="f"><span>Roles they get</span>
          ${canRoles ? `<select id="app-rank" aria-label="Rank">${ranks.map((r) => `<option value="${esc(r.id)}"${r.id === f.accept_rank_role_id ? ' selected' : ''}${!r.can_give && !onForm(r.id) ? ' disabled' : ''}>${esc(r.name)}${!r.can_give && !onForm(r.id) ? ' (ask the Director)' : ''}</option>`).join('')}</select>
            <div class="app-roles">${extras.map((r) => `<label class="app-role"><input type="checkbox" value="${esc(r.id)}"${(f.accept_role_ids || []).includes(r.id) ? ' checked' : ''}><span>${esc(cleanName(r.name))}</span></label>`).join('')}</div>`
            : `<div class="app-roles ro">${[f.accept_rank_role_id, ...(f.accept_role_ids || [])].filter(Boolean).map((rid) => `<span class="app-role-ro">${esc(cleanName(roleName(rid)))}</span>`).join('') || '<span class="muted">No roles</span>'}</div>`}
          <span class="app-hint">Plus the ${esc(dept)} role. The bot gives them within a minute.</span></div>` : ''}
        <p class="error" id="app-dec-err" hidden></p>
        <div class="f-actions"><button type="button" class="ghost" id="app-dec-cancel">Cancel</button>
          <button type="submit" class="refresh${accept ? '' : ' danger-fill'}">${accept ? 'Accept' : 'Not accept'}</button></div>
      </form>`;
    $e('#app-dec-cancel').onclick = () => { box.innerHTML = decideHtml(); };
    $e('#app-dec-form').onsubmit = async (ev) => {
      ev.preventDefault();
      const btn = ev.submitter; if (btn) btn.disabled = true;
      const args = { sub_id: id, accept, note: $e('#app-msg').value.trim() || null };
      if (accept && canRoles) {
        args.rank_role_id = $e('#app-rank')?.value || null;
        args.role_ids = [...box.querySelectorAll('.app-role input:checked')].map((x) => x.value);
      }
      const { error: err } = await sb.rpc('app_decide', args);
      if (err) { if (btn) btn.disabled = false; const p = $e('#app-dec-err'); p.textContent = err.message; p.hidden = false; return; }
      reload();
    };
  }

  let vote = 0;
  el.onclick = async (e) => {
    const r = e.target.closest('[data-rec]');
    if (r) { rememberRecord(r.dataset.rec, r.dataset.name); openRecord(r.dataset.rec); return; }
    const dec = e.target.closest('[data-dec]');
    if (dec && !dec.disabled) return openDecide(dec.dataset.dec === 'accept');
    const ap = e.target.closest('[data-appr]');
    if (ap) {
      ap.disabled = true;
      const { error: err } = await sb.rpc('app_approve', { sub_id: id, decision: +ap.dataset.appr });
      if (err) { ap.disabled = false; return ap.parentElement.insertAdjacentHTML('afterend', `<p class="error">${esc(err.message)}</p>`); }
      return reload();
    }
    const stg = e.target.closest('[data-stage]');
    if (stg && !stg.classList.contains('on')) {
      const { error: err } = await sb.rpc('app_set_stage', { sub_id: id, new_stage: stg.dataset.stage });
      if (err) return stg.parentElement.insertAdjacentHTML('afterend', `<p class="error">${esc(err.message)}</p>`);
      return reload();
    }
    const v = e.target.closest('[data-vote]');
    if (v) {
      vote = vote === +v.dataset.vote ? 0 : +v.dataset.vote;
      el.querySelectorAll('[data-vote]').forEach((x) => { const on = +x.dataset.vote === vote; x.classList.toggle('on', on); x.setAttribute('aria-pressed', String(on)); });
      return;
    }
    const del = e.target.closest('[data-del]');
    if (del) { await sb.rpc('app_note_delete', { note_id: +del.dataset.del }); reload(); }
  };
  $e('#app-compose').onsubmit = async (e) => {
    e.preventDefault();
    const text = $e('#app-note').value.trim(), err = $e('#app-note-err');
    if (!text && !vote) { err.textContent = 'Write a note or choose thumbs up or down.'; err.hidden = false; return; }
    const { error: er } = await sb.rpc('app_note', { sub_id: id, p_note: text || null, p_vote: vote || null });
    if (er) { err.textContent = er.message; err.hidden = false; return; }
    reload();
  };
}

// ---------- Forms: the department's applications ----------
async function appFormsList(el, box, dept) {
  const [{ data, error }, { data: roles }] = await Promise.all([sb.rpc('app_forms_admin', { dept }), sb.rpc('app_role_choices', { dept })]);
  if (error) { box.innerHTML = ''; return liveError(box, error); }
  const forms = data || [], rn = (id) => cleanName(((roles || []).find((r) => r.id === id) || {}).name || '');
  const ranksOf = (f) => (f.audience_ranks || []).map((id) => rn(id) || 'a rank').join(', ');
  const secs = [...new Set(forms.map((f) => f.section || 'General'))];
  box.innerHTML = forms.length ? secs.map((s) => `<section class="ma-section"><h2 class="ma-day">${esc(s)}</h2><div class="card app-group">${forms.filter((f) => (f.section || 'General') === s).map((f) => `
    <div class="af-row">
      <div class="af-main"><div class="af-t">${esc(f.title)}</div>
        <div class="af-s">${f.published_at ? `Who can apply: ${f.audience_ranks && f.audience_ranks.length ? esc(ranksOf(f)) : `everyone not in ${esc(dept)}`}${(f.stages || []).length ? ` · Stages: ${(f.stages || []).map(esc).join(' › ')}` : ''}${f.accept_rank_role_id ? ` · Gives ${esc(rn(f.accept_rank_role_id))}` : ''}${+f.approvals_needed > 1 ? ` · ${f.approvals_needed} approvals` : ''}` : 'Not published yet'}</div></div>
      <div class="af-pills">${f.published_at ? `<span class="ap-flag ${f.open ? 'open' : ''}">${f.open ? 'Open' : 'Closed'}</span>` : ''}${f.draft ? `<span class="ap-flag draft">${f.published_at ? 'Unpublished changes' : 'Draft'}</span>` : ''}</div>
      <div class="af-pills">${+f.waiting ? `<span class="app-ncount">${f.waiting} waiting</span>` : ''}<button type="button" class="ghost small-btn" data-edit="${esc(f.key)}">Edit</button></div>
    </div>`).join('')}</div></section>`).join('')
    : `<div class="card ma-empty"><strong>No applications yet.</strong><span>Create one with New application.</span></div>`;
  box.onclick = (e) => { const b = e.target.closest('[data-edit]'); if (b) appBuilder(el, dept, b.dataset.edit); };
  const nb = el.querySelector('#app-new');
  if (nb) nb.onclick = () => {
    nb.outerHTML = `<form class="app-newf" id="app-newf"><input id="app-newt" maxlength="80" placeholder="Name, e.g. Become a Leader" aria-label="Application name" required>
      <button type="submit" class="refresh">Create</button><button type="button" class="ghost" id="app-newx">Cancel</button></form>`;
    const fm = el.querySelector('#app-newf'); fm.querySelector('input').focus();
    el.querySelector('#app-newx').onclick = () => appTab(el, dept, 'forms');
    fm.onsubmit = async (e) => {
      e.preventDefault();
      const { data: key, error: er } = await sb.rpc('app_form_create', { dept, title: fm.querySelector('input').value.trim() });
      if (er) return fm.insertAdjacentHTML('afterend', `<p class="error">${esc(er.message)}</p>`);
      appBuilder(el, dept, key);
    };
  };
}

// ---------- the builder ----------
// Works on a draft (forms.draft), autosaved ~0.8 s after each change, with a copy in this browser in case the tab
// closes before it reaches the server. Publish checks it and makes it live (app_form_publish).
const APP_TYPES = [['text', 'Short answer'], ['long', 'Long answer'], ['number', 'Number'], ['choice', 'Choice'], ['yesno', 'Yes or no']];
const appUid = () => 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const appLocalKey = (k) => 'cbh-appdraft-' + k;

async function appBuilder(el, dept, key) {
  appSetHash(appRoute(dept, 'forms/' + key));
  el.innerHTML = '<div class="card"><p class="muted small">Opening the application…</p></div>';
  const [{ data: forms, error }, { data: choices }, { data: ranks }, { data: revChoices }] = await Promise.all([
    sb.rpc('app_forms_admin', { dept }), sb.rpc('app_role_choices', { dept }), sb.rpc('app_dept_ranks', { dept }), sb.rpc('app_reviewer_choices', { dept })]);
  if (error) { el.innerHTML = ''; return liveError(el, error); }
  const f = (forms || []).find((x) => x.key === key);
  if (!f) { el.innerHTML = '<div class="card"><p class="muted small">This application no longer exists.</p></div>'; return; }
  const live = { title: f.title, description: f.description || '', section: f.section || 'General', audience_ranks: f.audience_ranks || [], open: !!f.open,
    questions: f.questions || [], stages: f.stages || [], accept_rank_role_id: f.accept_rank_role_id, accept_role_ids: f.accept_role_ids || [],
    cooldown_days: f.cooldown_days ?? 14, reviewer_roles: f.reviewer_roles || [], approvals_needed: f.approvals_needed || 1, final_by_exec: !!f.final_by_exec };
  let draft = JSON.parse(JSON.stringify(Object.assign({}, live, f.draft || {})));
  let local = null;
  try { local = JSON.parse(localStorage.getItem(appLocalKey(key)) || 'null'); } catch { /* fine */ }
  let dirty = false;
  if (local && local.at && (!f.draft_saved_at || new Date(local.at) > new Date(f.draft_saved_at))) { draft = local.draft; dirty = true; }
  const sections = [...new Set((forms || []).map((x) => x.section || 'General').concat('General'))];
  const rankChoices = (choices || []).filter((r) => r.kind === 'rank'), extraChoices = (choices || []).filter((r) => r.kind !== 'rank' && r.kind !== 'department');
  const onLive = (rid) => rid === live.accept_rank_role_id || live.accept_role_ids.includes(rid);
  const canRev = appCanReviewers(dept);
  let saveT = null, saving = false, savedAt = f.draft_saved_at, failed = false;

  el.innerHTML = `
    <div class="bd-top">
      <button type="button" class="back inline-back" id="bd-back"><span class="back-ico" aria-hidden="true"></span>Forms</button>
      <span class="bd-saved" id="bd-saved" aria-live="polite"></span>
      <span class="bd-acts"><button type="button" class="ghost" id="bd-preview">Preview</button><button type="button" class="ghost" id="bd-discard">Discard draft</button><button type="button" class="refresh" id="bd-publish">Publish</button></span>
    </div>
    <p class="error" id="bd-err" hidden></p>
    <div class="bd">
      <div class="app-col">
        <section class="card bd-title">
          <input id="bd-t" class="bd-t" maxlength="80" placeholder="Application name" aria-label="Application name">
          <textarea id="bd-d" class="bd-d" rows="2" maxlength="300" placeholder="A short description for applicants (optional)" aria-label="Description"></textarea>
        </section>
        <section class="card bd-qs">
          <h3 class="app-h">Questions</h3>
          <div id="bd-list" class="bd-list"></div>
          <div class="bd-add"><button type="button" class="ghost small-btn" data-add="q">+ Question</button><button type="button" class="ghost small-btn" data-add="s">+ Section</button></div>
        </section>
      </div>
      <div class="app-col">
        <section class="card app-fs bd-side">
          <h3 class="app-h">Who can see and apply</h3>
          <label class="bd-radio"><input type="radio" name="bd-aud" value="all"> Everyone not in ${esc(dept)}</label>
          <label class="bd-radio"><input type="radio" name="bd-aud" value="ranks"> Only these ranks</label>
          <div class="app-roles bd-ranks" id="bd-ranks">${(ranks || []).map((r) => `<label class="app-role"><input type="checkbox" value="${esc(r.id)}"><span>${esc(r.rank_label || r.name)}</span></label>`).join('')}</div>
          <label class="app-switch"><input type="checkbox" id="bd-open"> Open for applications</label>
          <label class="f"><span>Group</span><input id="bd-sec" list="bd-secs" maxlength="40" placeholder="General"><datalist id="bd-secs">${sections.map((s) => `<option value="${esc(s)}">`).join('')}</datalist></label>
        </section>
        <section class="card app-fs bd-side">
          <h3 class="app-h">Review</h3>
          <div class="f"><span>Stages <em>(between Received and the decision)</em></span><div id="bd-stages" class="as-stages"></div>
            <div class="as-add"><input id="bd-newstage" maxlength="40" placeholder="New stage, e.g. Interview" aria-label="New stage"><button type="button" class="ghost small-btn" id="bd-addstage">Add</button></div></div>
          <label class="f"><span>Rank when accepted</span><select id="bd-rank"><option value="">No rank</option>${rankChoices.map((r) => `<option value="${esc(r.id)}"${!r.can_give && !onLive(r.id) ? ' disabled' : ''}>${esc(r.name)}${!r.can_give && !onLive(r.id) ? ' (ask the Director)' : ''}</option>`).join('')}</select>
            ${f.rank_set_by_name && f.accept_rank_role_id ? `<span class="app-hint">Gives ${esc(cleanName(((choices || []).find((r) => r.id === f.accept_rank_role_id) || {}).name || 'a rank'))} · set by ${esc(cleanName(f.rank_set_by_name))}</span>` : ''}</label>
          <div class="f"><span>Extra roles <em>(optional)</em></span><div class="app-roles" id="bd-extra">${extraChoices.map((r) => `<label class="app-role"><input type="checkbox" value="${esc(r.id)}"><span>${esc(cleanName(r.name))}</span></label>`).join('')}</div></div>
          <label class="f as-wait"><span>Wait before reapplying after “Not accepted”</span><span class="as-days"><input id="bd-wait" type="number" min="0" max="365"> days</span></label>
        </section>
        <section class="card app-fs bd-side${canRev ? '' : ' bd-locked'}">
          <h3 class="app-h">Who reviews</h3>
          <p class="app-hint">${canRev ? 'Directors and executives can always change this list.' : `Only executives and the ${esc(dept)} Director can change this.`}</p>
          <label class="bd-radio"><input type="radio" name="bd-rev" value="dept"${canRev ? '' : ' disabled'}> Everyone who can review ${esc(dept)} applications</label>
          <label class="bd-radio"><input type="radio" name="bd-rev" value="roles"${canRev ? '' : ' disabled'}> Only these roles</label>
          <div class="app-roles" id="bd-revroles">${(revChoices || []).map((r) => `<label class="app-role"><input type="checkbox" value="${esc(r.id)}"${canRev ? '' : ' disabled'}><span>${esc(cleanName(r.name))}</span></label>`).join('')}</div>
          <label class="f as-wait"><span>Approvals needed before Accept</span><span class="as-days"><input id="bd-need" type="number" min="1" max="10"${canRev ? '' : ' disabled'}> including whoever accepts</span></label>
          <label class="app-switch"><input type="checkbox" id="bd-final"${canRev ? '' : ' disabled'}> An executive gives the final Accept</label>
          ${f.review_set_by_name ? `<span class="app-hint">Set by ${esc(cleanName(f.review_set_by_name))}</span>` : ''}
        </section>
        <div class="bd-danger"><button type="button" class="app-x" id="bd-archive">Remove this application</button></div>
      </div>
    </div>`;
  const $e = (q) => el.querySelector(q);

  // ----- fill the fields from the draft -----
  function fill() {
    $e('#bd-t').value = draft.title || ''; $e('#bd-d').value = draft.description || '';
    $e('#bd-sec').value = draft.section || 'General'; $e('#bd-open').checked = !!draft.open;
    const byRanks = (draft.audience_ranks || []).length > 0;
    el.querySelector(`[name=bd-aud][value=${byRanks ? 'ranks' : 'all'}]`).checked = true;
    $e('#bd-ranks').hidden = !byRanks;
    $e('#bd-ranks').querySelectorAll('input').forEach((x) => { x.checked = (draft.audience_ranks || []).includes(x.value); });
    $e('#bd-rank').value = draft.accept_rank_role_id || '';
    $e('#bd-extra').querySelectorAll('input').forEach((x) => { x.checked = (draft.accept_role_ids || []).includes(x.value); });
    $e('#bd-wait').value = draft.cooldown_days ?? 14;
    const byRoles = (draft.reviewer_roles || []).length > 0;
    el.querySelector(`[name=bd-rev][value=${byRoles ? 'roles' : 'dept'}]`).checked = true;
    $e('#bd-revroles').hidden = !byRoles;
    $e('#bd-revroles').querySelectorAll('input').forEach((x) => { x.checked = (draft.reviewer_roles || []).includes(x.value); });
    $e('#bd-need').value = draft.approvals_needed || 1; $e('#bd-final').checked = !!draft.final_by_exec;
    drawStages(); drawList();
  }
  function drawStages() {
    $e('#bd-stages').innerHTML = (draft.stages || []).length ? draft.stages.map((x, i) => `<span class="as-stage"><span class="as-n">${i + 1}</span>${esc(x)}
      <button type="button" data-sup="${i}" aria-label="Move ${esc(x)} earlier"${i ? '' : ' disabled'}>↑</button><button type="button" data-srm="${i}" aria-label="Remove ${esc(x)}">×</button></span>`).join('')
      : '<span class="muted small">No stages: straight from Received to the decision.</span>';
  }
  function drawList() {
    const qs = draft.questions || [];
    $e('#bd-list').innerHTML = qs.map((q, i) => (q.type === 'section' ? `
      <div class="bd-item bd-sec" data-i="${i}" draggable="true">
        <span class="bd-grip" aria-hidden="true"></span>
        <input class="bd-l" maxlength="120" value="${esc(q.label)}" placeholder="Section title" aria-label="Section title">
        <span class="bd-btns"><button type="button" data-up="${i}" aria-label="Move up"${i ? '' : ' disabled'}>↑</button><button type="button" data-dn="${i}" aria-label="Move down"${i < qs.length - 1 ? '' : ' disabled'}>↓</button><button type="button" data-rm="${i}" aria-label="Remove section">×</button></span>
      </div>` : `
      <div class="bd-item bd-q" data-i="${i}" draggable="true">
        <span class="bd-grip" aria-hidden="true"></span>
        <input class="bd-l" maxlength="300" value="${esc(q.label)}" placeholder="Question" aria-label="Question ${i + 1}">
        <select class="bd-ty" aria-label="Answer type">${APP_TYPES.map(([v, l]) => `<option value="${v}"${q.type === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
        <label class="as-qr"><input type="checkbox" class="bd-req"${q.required ? ' checked' : ''}> Required</label>
        <span class="bd-btns"><button type="button" data-up="${i}" aria-label="Move up"${i ? '' : ' disabled'}>↑</button><button type="button" data-dn="${i}" aria-label="Move down"${i < qs.length - 1 ? '' : ' disabled'}>↓</button><button type="button" data-rm="${i}" aria-label="Remove question">×</button></span>
        ${q.type === 'choice' ? `<div class="bd-opts">${(q.options || []).map((o, j) => `<span class="bd-opt">${esc(o)}<button type="button" data-orm="${i}:${j}" aria-label="Remove ${esc(o)}">×</button></span>`).join('')}
          <input class="bd-newopt" data-i="${i}" maxlength="80" placeholder="Add a choice, then Enter" aria-label="Add a choice"></div>` : ''}
      </div>`)).join('') || '<p class="muted small">No questions yet. Add a question or a section.</p>';
  }

  // ----- saving -----
  function status(text, cls = '') { const s = $e('#bd-saved'); if (s) { s.textContent = text; s.className = 'bd-saved ' + cls; } }
  function showSaved() {
    if (failed) return status('Couldn’t save. Trying again…', 'bad');
    if (dirty || saving) return status('Saving…');
    if (!f.draft && !savedAt) return status(f.published_at ? 'No changes since it was published' : 'Not published yet');
    status(`Draft saved · ${savedAt ? when(savedAt) : 'just now'}`, 'ok');
  }
  function changed() {
    dirty = true; failed = false;
    try { localStorage.setItem(appLocalKey(key), JSON.stringify({ at: new Date().toISOString(), draft })); } catch { /* fine */ }
    showSaved();
    clearTimeout(saveT); saveT = setTimeout(save, 800);
  }
  async function save() {
    if (!dirty || saving) return;
    saving = true; dirty = false;
    const { data, error: er } = await sb.rpc('app_form_draft_save', { form_key: key, draft });
    saving = false;
    if (er) { failed = true; dirty = true; showSaved(); clearTimeout(saveT); saveT = setTimeout(save, 4000); return; }
    savedAt = data || new Date().toISOString(); f.draft = draft;
    if (!dirty) { try { localStorage.removeItem(appLocalKey(key)); } catch { /* fine */ } }
    showSaved();
    if (dirty) { clearTimeout(saveT); saveT = setTimeout(save, 800); }
  }
  const flush = async () => { clearTimeout(saveT); while (saving) await new Promise((r) => setTimeout(r, 100)); if (dirty) await save(); };
  const stillHere = () => el.isConnected && location.hash.includes('/forms/' + key);
  const ticker = setInterval(() => { if (!stillHere()) clearInterval(ticker); else if (!dirty && !saving) showSaved(); }, 30000);
  window.addEventListener('beforeunload', () => { if (dirty) try { localStorage.setItem(appLocalKey(key), JSON.stringify({ at: new Date().toISOString(), draft })); } catch { /* fine */ } }, { once: true });

  // ----- edits -----
  const qOf = (node) => draft.questions[+node.closest('[data-i]').dataset.i];
  el.addEventListener('input', (e) => {
    const t = e.target;
    if (t.id === 'bd-t') draft.title = t.value;
    else if (t.id === 'bd-d') draft.description = t.value;
    else if (t.id === 'bd-sec') draft.section = t.value;
    else if (t.id === 'bd-wait') draft.cooldown_days = Math.max(0, Math.min(365, +t.value || 0));
    else if (t.id === 'bd-need') { const n = Math.max(1, Math.min(10, +t.value || 1)); if (n > 1 && (draft.approvals_needed || 1) <= 1) { draft.final_by_exec = true; $e('#bd-final').checked = true; } draft.approvals_needed = n; }
    else if (t.classList.contains('bd-l')) qOf(t).label = t.value;
    else return;
    changed();
  });
  el.addEventListener('change', (e) => {
    const t = e.target;
    if (t.name === 'bd-aud') { $e('#bd-ranks').hidden = t.value !== 'ranks'; if (t.value === 'all') draft.audience_ranks = []; }
    else if (t.closest('#bd-ranks')) draft.audience_ranks = [...$e('#bd-ranks').querySelectorAll('input:checked')].map((x) => x.value);
    else if (t.id === 'bd-open') draft.open = t.checked;
    else if (t.id === 'bd-rank') draft.accept_rank_role_id = t.value || null;
    else if (t.closest('#bd-extra')) draft.accept_role_ids = [...$e('#bd-extra').querySelectorAll('input:checked')].map((x) => x.value);
    else if (t.name === 'bd-rev') { $e('#bd-revroles').hidden = t.value !== 'roles'; if (t.value === 'dept') draft.reviewer_roles = []; }
    else if (t.closest('#bd-revroles')) draft.reviewer_roles = [...$e('#bd-revroles').querySelectorAll('input:checked')].map((x) => x.value);
    else if (t.id === 'bd-final') draft.final_by_exec = t.checked;
    else if (t.classList.contains('bd-ty')) { const q = qOf(t); q.type = t.value; if (q.type === 'choice') q.options = q.options || []; else delete q.options; drawList(); }
    else if (t.classList.contains('bd-req')) qOf(t).required = t.checked;
    else return;
    changed();
  });
  el.addEventListener('keydown', (e) => {
    const t = e.target;
    if (e.key !== 'Enter') return;
    if (t.classList.contains('bd-newopt')) {
      e.preventDefault();
      const v = t.value.trim(), q = draft.questions[+t.dataset.i];
      if (v && !(q.options || []).includes(v)) { q.options = [...(q.options || []), v]; drawList(); changed(); el.querySelector(`.bd-newopt[data-i="${t.dataset.i}"]`)?.focus(); }
    } else if (t.id === 'bd-newstage') { e.preventDefault(); $e('#bd-addstage').click(); }
  });
  const move = (from, to) => { const qs = draft.questions; if (to < 0 || to >= qs.length) return; const [x] = qs.splice(from, 1); qs.splice(to, 0, x); drawList(); changed(); };
  el.addEventListener('click', async (e) => {
    const t = e.target.closest('button'); if (!t) return;
    const d = t.dataset;
    if (t.id === 'bd-back') { await flush(); return appTab(el, dept, 'forms'); }
    if (d.add) {
      draft.questions = draft.questions || [];
      draft.questions.push(d.add === 's' ? { id: appUid(), type: 'section', label: '' } : { id: appUid(), type: 'text', label: '', required: true });
      drawList(); changed(); el.querySelector('.bd-item:last-child .bd-l')?.focus(); return;
    }
    if (d.up) return move(+d.up, +d.up - 1);
    if (d.dn) return move(+d.dn, +d.dn + 1);
    if (d.rm) { draft.questions.splice(+d.rm, 1); drawList(); return changed(); }
    if (d.orm) { const [i, j] = d.orm.split(':').map(Number); draft.questions[i].options.splice(j, 1); drawList(); return changed(); }
    if (t.id === 'bd-addstage') { const v = $e('#bd-newstage').value.trim(); if (v && !draft.stages.includes(v) && draft.stages.length < 8) { draft.stages.push(v); $e('#bd-newstage').value = ''; drawStages(); changed(); } return; }
    if (d.sup) { const i = +d.sup; [draft.stages[i - 1], draft.stages[i]] = [draft.stages[i], draft.stages[i - 1]]; drawStages(); return changed(); }
    if (d.srm) { draft.stages.splice(+d.srm, 1); drawStages(); return changed(); }
    if (t.id === 'bd-preview') return appPreview(draft, dept);
    if (t.id === 'bd-discard') {
      t.outerHTML = '<span class="bd-confirm">Throw away the draft? <button type="button" class="ghost small-btn danger-text" id="bd-discard-yes">Discard</button><button type="button" class="ghost small-btn" id="bd-discard-no">Keep</button></span>';
      return;
    }
    if (t.id === 'bd-discard-no') return appBuilder(el, dept, key);
    if (t.id === 'bd-discard-yes') {
      clearTimeout(saveT); dirty = false;
      try { localStorage.removeItem(appLocalKey(key)); } catch { /* fine */ }
      await sb.rpc('app_form_discard', { form_key: key });
      return f.published_at ? appBuilder(el, dept, key) : appTab(el, dept, 'forms');
    }
    if (t.id === 'bd-publish') {
      const err = $e('#bd-err'); err.hidden = true;
      t.disabled = true; await flush();
      if (failed) { t.disabled = false; err.textContent = 'The draft couldn’t be saved, so it can’t be published yet.'; err.hidden = false; return; }
      const { error: er } = await sb.rpc('app_form_publish', { form_key: key });
      t.disabled = false;
      if (er) { err.textContent = er.message; err.hidden = false; return; }
      try { localStorage.removeItem(appLocalKey(key)); } catch { /* fine */ }
      return appTab(el, dept, 'forms');
    }
    if (t.id === 'bd-archive') {
      t.outerHTML = '<span class="bd-confirm">Remove it from the department? <button type="button" class="ghost small-btn danger-text" id="bd-arch-yes">Remove</button><button type="button" class="ghost small-btn" id="bd-arch-no">Keep</button></span>';
      return;
    }
    if (t.id === 'bd-arch-no') return appBuilder(el, dept, key);
    if (t.id === 'bd-arch-yes') {
      const { error: er } = await sb.rpc('app_form_archive', { form_key: key });
      if (er) { const err = $e('#bd-err'); err.textContent = er.message; err.hidden = false; return; }
      return appTab(el, dept, 'forms');
    }
  });

  // drag to reorder (the arrow buttons do the same for keyboards and phones)
  let dragFrom = null;
  el.addEventListener('dragstart', (e) => { const it = e.target.closest?.('.bd-item'); if (!it) return; dragFrom = +it.dataset.i; it.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
  el.addEventListener('dragend', (e) => { e.target.closest?.('.bd-item')?.classList.remove('dragging'); el.querySelectorAll('.drop-over').forEach((x) => x.classList.remove('drop-over')); });
  el.addEventListener('dragover', (e) => { const it = e.target.closest?.('.bd-item'); if (dragFrom == null || !it) return; e.preventDefault(); el.querySelectorAll('.drop-over').forEach((x) => x !== it && x.classList.remove('drop-over')); it.classList.add('drop-over'); });
  el.addEventListener('drop', (e) => { const it = e.target.closest?.('.bd-item'); if (dragFrom == null || !it) return; e.preventDefault(); const to = +it.dataset.i; const from = dragFrom; dragFrom = null; if (from !== to) move(from, to); });

  fill(); showSaved();
  if (dirty) { status('Recovered unsaved changes from this browser. Saving…'); save(); }
}

// The builder's Preview: the applicant's form in a panel over the page.
function appPreview(draft, dept) {
  document.querySelector('.app-pv')?.remove();
  const wrap = document.createElement('div');
  wrap.className = 'app-pv';
  wrap.innerHTML = '<div class="app-pv-box" role="dialog" aria-modal="true" aria-label="Preview"><button type="button" class="app-pv-x" aria-label="Close preview">Close</button><div class="app-pv-body"></div></div>';
  document.body.append(wrap);
  applyForm(wrap.querySelector('.app-pv-body'), { ...draft, department: dept }, true);
  const close = () => { wrap.remove(); document.removeEventListener('keydown', esc_); };
  const esc_ = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', esc_);
  wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('.app-pv-x')) close(); });
  wrap.querySelector('.app-pv-x').focus();
}

LIVE.apply = renderApplyPage;
// The old Applications page (#admin/applications, #review: home tiles and pins) opens a department's tab instead.
LIVE.review = () => appLegacyLink(0);
