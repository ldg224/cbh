// Courses (department pages, "Courses" tab). Owner-approved mockup, 19 Nov 2026. Back end: 0048 (courses, quizzes,
// evaluations), 0051 (private course-files bucket). Answer keys never reach the page: quiz questions come from
// quiz_start without keys, marking happens in the database, and a quiz with anything for a person to mark is held
// ("Submitted") until it's all marked. Reading/watching steps are ticked by the page (progress, not proof).
// Builders: courses.manage ("Edit courses"). Assessors: courses.assess ("Assess courses").
// Loaded after app.js (hasPerm, myDepartments, DEPARTMENTS, iconUrl, sized), faces.js and applications.js
// (appSetHash). Code is prefixed cr / CR_ to keep clear of other pages (one shared global scope).
const CR_LEVELS = ['Not yet', 'Developing', 'Standard', 'Exceeding'];
const CR_COLOURS = ['#2ED3C6', '#3A82D0', '#5C72FF', '#6A4FD6', '#FF3D7E', '#FF5533', '#FFAA00', '#0D7D74'];
const CR_KINDS = { lesson: 'Written lesson', slides: 'Google Slides', link: 'Link', video: 'YouTube', file: 'File', quiz: 'Quiz', eval: 'Practical evaluation' };
const CR_ICON = { lesson: '✎', slides: 'S', link: '↗', video: '▶', file: 'PDF', quiz: '?', eval: '★' };
const crDept = (name) => DEPARTMENTS.find((d) => d.name === name) || { name, id: '', color: '#3a82d0' };
let crMine = false;   // true while a course is open inside My courses (#courses/<cid>), e.g. for someone outside its department
const crRoute = (dept, rest = '') => (crMine ? `#courses${rest ? '/' + rest : ''}` : `#directors/${crDept(dept).id}/courses${rest ? '/' + rest : ''}`);
const crSetHash = (h) => { try { history.replaceState(null, '', h); } catch { /* fine */ } };
const crCanEdit = (dept) => hasPerm('courses.manage', dept);
const crCanAssess = (dept) => hasPerm('courses.assess', dept);
const crMember = (dept) => (typeof inMyDept === 'function' ? inMyDept(dept) : (myDepartments || []).includes(dept));
const crDate = (iso) => (iso ? new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' }) : '');
const crUid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const crItems = (c) => (c.modules || []).flatMap((m) => m.items || []);

// Safe little markdown for written lessons: # headings, - lists, **bold**, *italic*, [text](https://link), images
// ![alt](https://…), blank-line paragraphs. Everything is escaped first.
function crMarkdown(src) {
  const inline = (t) => esc(t)
    .replace(/!\[([^\]]*)\]\((https:\/\/[^\s)]+)\)/g, '<img src="$2" alt="$1" loading="lazy">')
    .replace(/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return String(src || '').split(/\n{2,}/).map((block) => {
    const lines = block.split('\n');
    if (/^#{1,3} /.test(block)) { const lv = block.match(/^#+/)[0].length + 1; return `<h${lv}>${inline(block.replace(/^#+ /, ''))}</h${lv}>`; }
    if (lines.every((l) => /^\s*[-*] /.test(l))) return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*] /, ''))}</li>`).join('')}</ul>`;
    if (lines.every((l) => /^\s*\d+\. /.test(l))) return `<ol>${lines.map((l) => `<li>${inline(l.replace(/^\s*\d+\. /, ''))}</li>`).join('')}</ol>`;
    return `<p>${lines.map(inline).join('<br>')}</p>`;
  }).join('');
}
const crYouTubeId = (u) => (String(u).match(/(?:v=|embed\/|shorts\/|youtu\.be\/)([A-Za-z0-9_-]{6,})/) || [])[1];
const crSlidesId = (u) => (String(u).match(/presentation\/d\/([A-Za-z0-9_-]+)/) || [])[1];
const crDocEmbed = (u) => {
  const m = String(u).match(/^https:\/\/docs\.google\.com\/(document|spreadsheets)\/d\/([A-Za-z0-9_-]+)/);
  return m ? `https://docs.google.com/${m[1]}/d/${m[2]}/preview` : null;
};
async function crSigned(path) {
  const { data, error } = await sb.storage.from('course-files').createSignedUrl(path, 600);
  if (error) throw error;
  return data.signedUrl;
}

// ===================================================================== the tab
window.DEPT_TABS = window.DEPT_TABS || [];
window.DEPT_TABS.push({
  id: 'courses', label: 'Courses',
  show: (dept) => crMember(dept) || hasPerm('dept.view', dept) || crCanEdit(dept) || crCanAssess(dept),
  count: async (dept) => ((await sb.rpc('course_list', { dept })).data || []).filter((c) => c.mine && !c.lock && !c.complete).length,
  render: (el, dept, sub) => crTab(el, dept, sub || ''),
});
window.DEPT_MEMBER_EXTRAS = window.DEPT_MEMBER_EXTRAS || [];
window.DEPT_MEMBER_EXTRAS.push({
  id: 'courses', label: 'Course Progress',
  load: async (dept) => {
    const { data } = await sb.rpc('course_member_summary', { dept });
    return new Map(Object.entries(data || {}).map(([id, s]) => [id, {
      html: `<span class="cr-chip${s.done >= s.total ? ' done' : ''}">${s.done >= s.total ? 'Courses done' : `Courses ${s.done}/${s.total}`}</span>`,
      sort: s.total ? s.done / s.total : 0, title: `${s.done} of ${s.total} courses finished` }]));
  },
});

function crTab(el, dept, sub) {
  crMine = false;
  const [a, b] = String(sub).split('/');
  if (a === 'marking' && crCanAssess(dept)) return crMarking(el, dept);
  if (a === 'edit' && b && crCanEdit(dept)) return crEditor(el, dept, b);
  if (a === 'manage' && crCanEdit(dept)) return crManage(el, dept);
  if (/^[0-9a-f-]{36}$/.test(a || '')) return crCourse(el, dept, a, b || '');
  return crGrid(el, dept);
}

// ---------- course blocks ----------
async function crGrid(el, dept) {
  if (crMine) { crSetHash('#courses'); return LIVE.mycourses(el); }
  crSetHash(crRoute(dept));
  el.innerHTML = '<div class="card"><p class="muted small">Loading courses…</p></div>';
  const [{ data, error }, marking] = await Promise.all([sb.rpc('course_list', { dept }).then(async (r) => { await crLoadRanks(dept); return r; }),
    crCanAssess(dept) ? sb.rpc('course_marking', { dept }).then((r) => r.data || [], () => []) : Promise.resolve([])]);
  if (error) { el.innerHTML = ''; return liveError(el, error); }
  const list = data || [];
  const mine = list.filter((c) => c.mine), others = list.filter((c) => !c.mine);
  el.innerHTML = `
    <div class="cr-bar">
      ${crCanAssess(dept) ? `<button type="button" class="ghost" data-go="marking">Marking${marking.length ? ` <span class="cr-n">${marking.length}</span>` : ''}</button>` : ''}
      ${crCanEdit(dept) ? '<button type="button" class="ghost" data-go="manage">Manage courses</button><button type="button" class="refresh" data-go="new">New Course</button>' : ''}
    </div>
    ${mine.length ? `<section class="cr-sec"><h2 class="ma-day">Your Courses</h2><div class="cr-grid">${mine.map(crBlock).join('')}</div></section>` : ''}
    ${others.length ? `<section class="cr-sec"><h2 class="ma-day">${mine.length ? 'Other' : 'All'} ${esc(dept)} courses</h2><div class="cr-grid">${others.map(crBlock).join('')}</div></section>` : ''}
    ${!list.length ? `<div class="card ma-empty"><strong>No courses yet.</strong>${crCanEdit(dept) ? '<span>Create one with New course.</span>' : ''}</div>` : ''}`;
  el.onclick = async (e) => {
    const g = e.target.closest('[data-go]');
    if (g) {
      if (g.dataset.go === 'new') {
        const { data: id, error: er } = await sb.rpc('course_create', { dept, title: 'New course' });
        if (er) return el.insertAdjacentHTML('afterbegin', `<p class="error">${esc(er.message)}</p>`);
        return crEditor(el, dept, id);
      }
      return crTab(el, dept, g.dataset.go);
    }
    const c = e.target.closest('[data-course]');
    if (c) crCourse(el, dept, c.dataset.course, '');
  };

  function crBlock(c) {
    const due = c.due_at && !c.complete ? new Date(c.due_at) : null;
    const late = due && due < new Date(), soon = due && !late && due - new Date() < 3 * 864e5;
    const pct = c.counts && c.counts.total ? Math.round((c.counts.done / c.counts.total) * 100) : 0;
    const lock = c.mine ? c.lock : null;
    return `<button type="button" class="cr-block${lock ? ' locked' : ''}" data-course="${esc(c.id)}" style="--c:${esc(c.color || '#2ED3C6')};--dept:${crDept(dept).color}">
      <span class="cr-top"><span class="cr-kind">${esc(c.kind || 'Course')}</span></span>
      <span class="cr-body">
        <span class="cr-pills">${crAudience(c, dept)}${c.complete ? '<span class="cr-pill done">Completed</span>'
          : lock === 'date' ? `<span class="cr-pill soon">Opens ${esc(crDate(c.opens_at))}</span>`
            : lock === 'prereq' ? `<span class="cr-pill soon">Finish ${esc(c.prereq || 'another course')} first</span>`
              : c.mine ? '<span class="cr-pill open">Open</span>' : ''}${due ? `<span class="cr-pill ${late ? 'late' : soon ? 'due' : 'soon'}">${late ? 'Overdue' : 'Due ' + esc(crDate(c.due_at))}</span>` : ''}</span>
        <strong class="cr-title">${esc(c.title)}</strong>
        ${c.mine && !lock ? `<span class="cr-progress"><i style="width:${pct}%"></i></span>` : ''}
        <span class="cr-foot"><span>${c.mine ? `${c.counts?.done || 0} of ${c.counts?.total || 0} steps` : `${c.counts?.total || 0} steps`}</span><span>${lock ? 'Locked' : c.complete ? 'Review' : c.mine ? 'Continue ›' : 'Open ›'}</span></span>
      </span>
    </button>`;
  }
}
function crAudience(c, dept) {
  const ranks = c.audience_ranks || [];
  if (!ranks.length) return '<span class="cr-pill aud">Everyone</span>';
  const names = ranks.map((id) => (crRanksCache[dept] || []).find((r) => r.id === id)?.rank_label).filter(Boolean);
  return `<span class="cr-pill aud">${esc(names.length ? names.join(', ') : 'Chosen ranks')}</span>`;
}
const crRanksCache = {};
async function crLoadRanks(dept) {
  if (!crRanksCache[dept]) crRanksCache[dept] = (await sb.rpc('app_dept_ranks', { dept })).data || [];
  return crRanksCache[dept];
}

// ---------- inside a course ----------
async function crCourse(el, dept, cid, stepId) {
  await crLoadRanks(dept);
  const { data: c, error } = await sb.rpc('course_view', { cid });
  if (error || !c) { el.innerHTML = `<button type="button" class="back inline-back" id="cr-back"><span class="back-ico" aria-hidden="true"></span>${crMine ? 'My courses' : 'Courses'}</button><div class="card"><p class="muted small">This course isn’t available to you.</p></div>`; el.querySelector('#cr-back').onclick = () => crGrid(el, dept); return; }
  if (stepId && !c.lock) { const it = crItems(c).find((x) => x.id === stepId); if (it) return crStep(el, dept, c, it); }
  crSetHash(crRoute(dept, cid));
  const staff = c.can_edit || c.can_assess;
  const done = new Set(c.done || []);
  const passedQuiz = (id) => (c.attempts || []).some((a) => a.item_id === id && a.passed);
  const heldQuiz = (id) => (c.attempts || []).some((a) => a.item_id === id && a.status === 'marking');
  const evalOf = (id) => (c.evaluations || []).find((e) => e.item_id === id);
  const isDone = (it) => (it.kind === 'quiz' ? passedQuiz(it.id) : it.kind === 'eval' ? !!evalOf(it.id)?.passed : done.has(it.id));
  const next = !c.lock && c.mine ? crItems(c).find((it) => !isDone(it)) : null;
  const due = c.due_at ? new Date(c.due_at) : null;
  let tab = 'contents';
  el.innerHTML = `
    <button type="button" class="back inline-back" id="cr-back"><span class="back-ico" aria-hidden="true"></span>${crMine ? 'My courses' : 'Courses'}</button>
    <section class="cr-hero" style="--c:${esc(c.color || '#2ED3C6')};--dept:${crDept(dept).color}">
      <div class="cr-pills">${crAudience(c, dept).replace('cr-pill aud', 'cr-pill hero')}<span class="cr-pill hero">${esc(c.kind || 'Course')}</span></div>
      <h2>${esc(c.title)}</h2>
      ${c.description ? `<p>${esc(c.description)}</p>` : ''}
      ${c.assigned?.note ? `<p class="cr-asg-note"><b>Note from ${esc(cleanName(c.assigned.by || 'your department'))}:</b> ${esc(c.assigned.note)}</p>` : ''}
      <div class="cr-facts">
        ${c.assigned ? `<div class="cr-fact">Assigned by<b>${esc(cleanName(c.assigned.by || 'your department'))}</b></div>` : ''}
        ${c.opens_at ? `<div class="cr-fact">${new Date(c.opens_at) > new Date() ? 'Opens' : 'Opened'}<b>${esc(crDate(c.opens_at))}</b></div>` : ''}
        ${due ? `<div class="cr-fact">Due<b>${esc(crDate(c.due_at))}</b></div>` : ''}
        ${c.mine ? `<div class="cr-fact">Your progress<b>${c.complete ? 'Completed' : `${c.counts.done} of ${c.counts.total} steps`}</b></div>` : ''}
        ${c.prereq ? `<div class="cr-fact">Needs first<b>${esc(c.prereq.title)}</b></div>` : ''}
      </div>
      <div class="cr-hero-acts">
        ${c.lock === 'date' ? `<span class="cr-pill hero">Opens ${esc(crDate(c.opens_at))}</span>` : c.lock === 'prereq' ? `<span class="cr-pill hero">Finish ${esc(c.prereq?.title || 'the course before')} first</span>`
          : next ? `<button type="button" class="cr-continue" data-step="${esc(next.id)}">Continue: ${esc(next.title)}</button>` : ''}
        ${staff ? '<button type="button" class="cr-ghost" id="cr-assign">Assign</button>' : ''}
        ${c.can_edit ? '<button type="button" class="cr-ghost" id="cr-edit">Edit course</button>' : ''}
      </div>
    </section>
    ${staff ? `<div class="dp-tabs cr-tabs" role="tablist"><button type="button" role="tab" data-ctab="contents" aria-selected="true">Contents</button><button type="button" role="tab" data-ctab="progress" aria-selected="false">Progress</button></div>` : ''}
    <div id="cr-pane"></div>`;
  const pane = el.querySelector('#cr-pane');
  function drawContents() {
    if (!c.modules) { pane.innerHTML = `<div class="card"><p class="muted small">${c.lock === 'date' ? `This course opens on ${esc(crDate(c.opens_at))}.` : `Finish ${esc(c.prereq?.title || 'the course before')} first.`}</p></div>`; return; }
    pane.innerHTML = `<div class="cr-mods">${c.modules.map((m, mi) => {
      const items = m.items || [], nDone = items.filter(isDone).length, all = items.length && nDone === items.length;
      return `<details class="cr-mod${all ? ' done' : ''}"${all && c.mine ? '' : ' open'}>
        <summary class="cr-mod-h">${all ? '<span class="cr-tick" aria-hidden="true">✓</span>' : ''}<span>${mi + 1}. ${esc(m.title)}</span><span class="cr-mod-n">${c.mine ? `${nDone} of ${items.length} done` : `${items.length} steps`}</span></summary>
        <div class="cr-items">${items.map((it) => {
          const d = isDone(it), held = it.kind === 'quiz' && heldQuiz(it.id), ev = it.kind === 'eval' ? evalOf(it.id) : null;
          return `<button type="button" class="cr-item${next && next.id === it.id ? ' now' : ''}" data-step="${esc(it.id)}"${c.lock && !staff ? ' disabled' : ''}>
            <span class="cr-ico${d ? ' done' : ''}" aria-hidden="true">${d ? '✓' : esc(CR_ICON[it.kind] || '•')}</span>
            <span class="cr-item-main"><span class="cr-item-t">${esc(it.title)}</span><span class="cr-item-s">${esc(crStepNote(it))}</span></span>
            <span class="cr-item-r">${d ? '<span class="cr-pill done">Done</span>' : held ? '<span class="cr-pill due">Submitted</span>' : ev ? '<span class="cr-pill due">Not passed yet</span>' : ''}</span>
          </button>`;
        }).join('') || '<p class="muted small cr-empty">No steps yet.</p>'}</div>
      </details>`;
    }).join('')}</div>`;
  }
  async function drawProgress() {
    pane.innerHTML = '<div class="card"><p class="muted small">Loading progress…</p></div>';
    const [{ data: rows, error: er }, { data: asg }] = await Promise.all([sb.rpc('course_progress_report', { cid }), sb.rpc('course_assignments_report', { cid })]);
    if (er) { pane.innerHTML = ''; return liveError(pane, er); }
    const quizzes = crItems(c).filter((i) => i.kind === 'quiz'), evals = crItems(c).filter((i) => i.kind === 'eval');
    pane.innerHTML = (rows || []).length ? `<div class="card cr-table-wrap"><table class="cr-table"><thead><tr><th>Member</th><th>Rank</th><th>Progress</th>${quizzes.map((q) => `<th>${esc(q.title)}</th>`).join('')}${evals.map((e) => `<th>${esc(e.title)}</th>`).join('')}</tr></thead><tbody>
      ${rows.map((r) => {
        const pct = r.counts.total ? Math.round((r.counts.done / r.counts.total) * 100) : 0;
        return `<tr><td><strong>${esc(cleanName(r.name || r.discord_id))}</strong></td><td>${esc(r.rank || '–')}</td>
          <td><span class="cr-mini"><i style="width:${pct}%"></i></span>${r.counts.done} / ${r.counts.total}${r.complete ? ' <span class="cr-pill done">Done</span>' : ''}</td>
          ${quizzes.map((q) => { const t = (r.quizzes || []).filter((x) => x.item_id === q.id); const best = t.filter((x) => x.status === 'marked').sort((x, y) => (y.score || 0) - (x.score || 0))[0];
            const ended = t.filter((x) => x.status === 'ended'), locked = t.filter((x) => x.lock && x.lock !== 'off');
            return `<td>${t.some((x) => x.status === 'marking') ? '<span class="cr-pill due">To mark</span>' : best ? `${best.score} / ${best.max_score}${best.passed ? '' : ' <span class="cr-pill late">Not passed</span>'}` : '–'}${ended.length ? ` <span class="cr-pill late" title="${esc(ended.map((x) => x.ended_reason).join('; '))}">${ended.length} ended</span>` : ''}${locked.length && (c.can_assess || c.can_edit) ? ` <button type="button" class="linkish cr-try" data-log="${locked[locked.length - 1].id}">Exit Log</button>` : ''}${c.can_assess || c.can_edit ? ` <button type="button" class="linkish cr-try" data-try="${esc(q.id)}:${esc(r.discord_id)}" title="Give another try">+1 try</button>` : ''}</td>`; }).join('')}
          ${evals.map((e) => { const ev = (r.evaluations || []).find((x) => x.item_id === e.id && x.status === 'submitted');
            return `<td>${ev ? `<span class="cr-pill ${ev.passed ? 'done' : 'due'}">${ev.passed ? 'Passed' : 'Not yet'}</span>` : '–'}${c.can_assess ? ` <button type="button" class="linkish" data-eval="${esc(e.id)}:${esc(r.discord_id)}">${ev ? 'View' : 'Evaluate'}</button>` : ''}</td>`; }).join('')}
        </tr>`;
      }).join('')}</tbody></table></div>` : '<div class="card"><p class="muted small">Nobody is on this course yet.</p></div>';
    pane.insertAdjacentHTML('afterbegin', crAssignedCard(asg || []));
    loadFaces(pane);
  }
  drawContents();
  el.querySelector('#cr-back').onclick = () => crGrid(el, dept);
  el.onclick = async (e) => {
    const t = e.target.closest('[data-ctab]');
    if (t) { tab = t.dataset.ctab; el.querySelectorAll('[data-ctab]').forEach((x) => x.setAttribute('aria-selected', String(x === t))); return tab === 'progress' ? drawProgress() : drawContents(); }
    if (e.target.closest('#cr-edit')) return crEditor(el, dept, cid);
    if (e.target.closest('#cr-assign, [data-assign]')) return crAssignDialog(c, dept, () => { if (tab === 'progress') drawProgress(); });
    const un = e.target.closest('[data-unassign]');
    if (un) {
      if (!un.classList.contains('sure')) { un.classList.add('sure'); un.textContent = 'Unassign?'; return; }
      un.disabled = true;
      const { error: er } = await sb.rpc('course_unassign', { cid, who: un.dataset.unassign });
      if (er) { un.disabled = false; un.textContent = er.message; return; }
      return drawProgress();
    }
    const lg = e.target.closest('[data-log]');
    if (lg) return crAttemptLog(+lg.dataset.log);
    const tr = e.target.closest('[data-try]');
    if (tr) { const [iid, who] = tr.dataset.try.split(':'); const { error: er } = await sb.rpc('course_grant_try', { cid, iid, who }); tr.textContent = er ? er.message : 'Given'; return; }
    const ev = e.target.closest('[data-eval]');
    if (ev) { const [iid, who] = ev.dataset.eval.split(':'); return crEvalForm(el, dept, c, crItems(c).find((x) => x.id === iid), who); }
    const s = e.target.closest('[data-step]');
    if (s && !s.disabled) { const it = crItems(c).find((x) => x.id === s.dataset.step); if (it) crStep(el, dept, c, it); }
  };
}
function crStepNote(it) {
  switch (it.kind) {
    case 'lesson': return 'Written lesson · read to the end';
    case 'slides': return 'Google Slides';
    case 'video': return 'YouTube · watch to the end';
    case 'link': return 'Link';
    case 'file': return /pdf$/i.test(it.mime || it.path || '') ? 'PDF · go to the last page' : /presentation/.test(it.mime || '') ? 'PowerPoint · download' : 'Image';
    case 'quiz': return `${it.exam ? 'Exam' : 'Quiz'} · ${it.question_count || 0} questions · pass ${it.pass_pct ?? 80}% · ${it.tries ?? 3} ${(it.tries ?? 3) === 1 ? 'try' : 'tries'}`;
    case 'eval': return 'Practical evaluation · marked by an assessor';
    default: return '';
  }
}

// ---------- one step ----------
async function crStep(el, dept, c, it) {
  crSetHash(crRoute(dept, c.id + '/' + it.id));
  const all = crItems(c), idx = all.findIndex((x) => x.id === it.id), nxt = all[idx + 1];
  const done = (c.done || []).includes(it.id);
  el.innerHTML = `
    <div class="cr-step-top"><button type="button" class="back inline-back" id="cr-back"><span class="back-ico" aria-hidden="true"></span>${esc(c.title)}</button>
      <span class="muted small">Step ${idx + 1} of ${all.length}</span></div>
    <section class="card cr-step"><h2 class="cr-step-h">${esc(it.title)}</h2><div id="cr-body"></div>
      <div class="cr-step-foot"><span id="cr-done-flag" class="cr-pill done"${done ? '' : ' hidden'}>Done</span><span class="sp"></span>
        <button type="button" class="ghost" id="cr-finish" hidden>I’ve finished</button>
        ${nxt ? `<button type="button" class="refresh" id="cr-next">Next: ${esc(nxt.title)}</button>` : ''}</div>
    </section>`;
  const body = el.querySelector('#cr-body');
  let marked = done;
  const markDone = async () => {
    if (marked || !c.mine || c.lock) return;
    marked = true;
    const { error } = await sb.rpc('course_item_done', { cid: c.id, iid: it.id });
    if (error) { marked = false; return; }
    (c.done = c.done || []).push(it.id);
    el.querySelector('#cr-done-flag').hidden = false;
    el.querySelector('#cr-finish').hidden = true;
  };
  const finishBtn = () => { const b = el.querySelector('#cr-finish'); if (c.mine && !marked) { b.hidden = false; b.onclick = markDone; } };
  el.querySelector('#cr-back').onclick = () => crCourse(el, dept, c.id, '');
  const nb = el.querySelector('#cr-next'); if (nb) nb.onclick = () => crStep(el, dept, c, nxt);
  if (it.kind === 'lesson') {
    body.innerHTML = `<div class="cr-lesson">${crMarkdown(it.body)}</div><div class="cr-end" aria-hidden="true"></div>`;
    const io = new IntersectionObserver((ents) => { if (ents.some((x) => x.isIntersecting)) { io.disconnect(); markDone(); } });
    io.observe(body.querySelector('.cr-end'));
  } else if (it.kind === 'slides') {
    const id = crSlidesId(it.url);
    body.innerHTML = `<div class="vw vw-slides" tabindex="-1"><div class="vw-stage vw-embed"><iframe src="https://docs.google.com/presentation/d/${esc(id)}/embed?start=false&loop=false&delayms=60000" allowfullscreen loading="lazy" title="${esc(it.title)}"></iframe></div>
      <div class="vw-bar" role="toolbar" aria-label="Slide controls"><span class="vw-note">Move between slides with the arrows under them.</span><span class="vw-gap"></span>
        <a class="vw-btn ghost" href="https://docs.google.com/presentation/d/${esc(id)}/present" target="_blank" rel="noopener">Open in Google Slides</a>
        <button type="button" class="vw-btn ghost" data-fs aria-label="Full screen"><span class="vw-fs-ico" aria-hidden="true"></span><span class="vw-lab">Full screen</span></button></div></div>
      <p class="muted small">Press I’ve finished when you reach the last slide.</p>`;
    crViewerChrome(body.querySelector('.vw'));
    finishBtn();
  } else if (it.kind === 'video') {
    const id = crYouTubeId(it.url);
    body.innerHTML = `<div class="cr-frame"><div id="cr-yt"></div></div>`;
    crYouTube('cr-yt', id, markDone, finishBtn);
  } else if (it.kind === 'link') {
    const emb = crDocEmbed(it.url);
    body.innerHTML = emb ? `<div class="cr-frame tall"><iframe src="${esc(emb)}" loading="lazy" title="${esc(it.title)}"></iframe></div><p class="muted small"><a href="${esc(it.url)}" target="_blank" rel="noopener">Open in Google</a></p>`
      : `<p><a class="refresh cr-open" href="${esc(it.url)}" target="_blank" rel="noopener">Open the link</a></p><p class="muted small">${esc(it.url)}</p>`;
    finishBtn();
  } else if (it.kind === 'file') {
    body.innerHTML = '<p class="muted small">Opening the file…</p>';
    let url;
    try { url = await crSigned(it.path); } catch (e) { body.innerHTML = `<p class="error">Couldn’t open the file: ${esc(e.message)}</p>`; return; }
    if (/pdf$/i.test(it.mime || it.path)) crPdf(body, url, markDone);
    else if (/^image\//.test(it.mime || '') || /\.(png|jpe?g|webp|gif)$/i.test(it.path)) { crImage(body, url, it.title); markDone(); }
    else { body.innerHTML = `<p><a class="refresh cr-open" href="${esc(url)}" target="_blank" rel="noopener">Download ${esc(it.name || 'the file')}</a></p><p class="muted small">PowerPoint files can’t be shown inside the site. Open it, go through it, then press I’ve finished.</p>`; finishBtn(); }
  } else if (it.kind === 'quiz') {
    crQuiz(el, body, dept, c, it);
  } else if (it.kind === 'eval') {
    const ev = (c.evaluations || []).find((x) => x.item_id === it.id);
    body.innerHTML = ev ? crEvalResult(it, ev) : `<p class="muted">An assessor will observe you and fill in this evaluation. You’ll see the result here.</p>
      <ul class="cr-comps">${(it.competencies || []).map((k) => `<li>${esc(k.text)}</li>`).join('')}</ul>`;
    if (c.can_assess) body.insertAdjacentHTML('beforeend', '<p class="muted small">Assessors: open the Progress tab to evaluate someone.</p>');
  }
}

// YouTube: watched to the end counts. Falls back to "I've finished" if the player can't load.
function crYouTube(elId, vid, onEnd, fallback) {
  const make = () => {
    try {
      // eslint-disable-next-line no-new
      new window.YT.Player(elId, { videoId: vid, playerVars: { rel: 0, modestbranding: 1 }, events: { onStateChange: (e) => { if (e.data === 0) onEnd(); } } });
    } catch { fallback(); }
  };
  if (window.YT && window.YT.Player) return make();
  const prev = window.onYouTubeIframeAPIReady;
  window.onYouTubeIframeAPIReady = () => { if (prev) prev(); make(); };
  if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
    const s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api'; s.onerror = fallback; document.head.append(s);
  }
  setTimeout(() => { if (!(window.YT && window.YT.Player)) fallback(); }, 8000);
}

// PDF slides in our own viewer (pdf.js, loaded once): arrows, keys and swipe; done at the last page.
let crPdfLib = null;
function crLoadPdfJs() {
  if (crPdfLib) return crPdfLib;
  crPdfLib = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'; res(window.pdfjsLib); };
    s.onerror = rej; document.head.append(s);
  });
  return crPdfLib;
}
// A proper viewer (owner, 0.24.1): an always-visible control bar on a dark strip under the page, with ◀ ▶,
// "Page 3 of 12" with a page box to jump, zoom out / Fit / zoom in, and full screen. Arrow keys, Page Up/Down,
// Home/End and +/- work while it's on screen, and swiping works on phones (at Fit).
const crSvg = {
  prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.5 4.5 8 12l7.5 7.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 4.5 16 12l-7.5 7.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
// Full screen: the real thing where the browser allows it, otherwise the viewer fills the window (iPhone).
function crViewerChrome(vw, onResize) {
  const fs = vw.querySelector('[data-fs]');
  const isFull = () => document.fullscreenElement === vw || document.webkitFullscreenElement === vw || vw.classList.contains('vw-max');
  const label = () => {
    if (!fs) return;
    const on = isFull();
    fs.querySelector('.vw-lab').textContent = on ? 'Exit full screen' : 'Full screen';
    fs.setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen');
    vw.classList.toggle('vw-full', on);
  };
  if (fs) fs.onclick = async () => {
    if (isFull()) {
      if (vw.classList.contains('vw-max')) { vw.classList.remove('vw-max'); document.body.classList.remove('vw-lock'); }
      else await (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else if (vw.requestFullscreen || vw.webkitRequestFullscreen) {
      try { await (vw.requestFullscreen || vw.webkitRequestFullscreen).call(vw); } catch { vw.classList.add('vw-max'); document.body.classList.add('vw-lock'); }
    } else { vw.classList.add('vw-max'); document.body.classList.add('vw-lock'); }
    label(); if (onResize) setTimeout(onResize, 60);
  };
  const changed = () => { if (!vw.isConnected) return; label(); if (onResize) setTimeout(onResize, 60); };
  document.addEventListener('fullscreenchange', changed);
  document.addEventListener('webkitfullscreenchange', changed);
  let rt;
  window.addEventListener('resize', () => { if (vw.isConnected && onResize) { clearTimeout(rt); rt = setTimeout(onResize, 120); } });
  document.addEventListener('keydown', function esc_(e) {
    if (!vw.isConnected) return document.removeEventListener('keydown', esc_);
    if (e.key === 'Escape' && vw.classList.contains('vw-max')) fs.click();
  });
}

function crImage(box, url, title) {
  box.innerHTML = `<div class="vw vw-image" tabindex="-1"><div class="vw-stage"><img src="${esc(url)}" alt="${esc(title)}"></div>
    <div class="vw-bar" role="toolbar" aria-label="Picture controls"><span class="vw-gap"></span>
      <span class="vw-zoom"><button type="button" class="vw-btn ghost" data-z="-1" aria-label="Zoom out">−</button><button type="button" class="vw-btn ghost vw-fit" data-z="0" aria-label="Fit to the screen">Fit</button><button type="button" class="vw-btn ghost" data-z="1" aria-label="Zoom in">+</button></span>
      <button type="button" class="vw-btn ghost" data-fs aria-label="Full screen"><span class="vw-fs-ico" aria-hidden="true"></span><span class="vw-lab">Full screen</span></button></div></div>`;
  const vw = box.querySelector('.vw'), img = vw.querySelector('img'), stage = vw.querySelector('.vw-stage');
  let zoom = 1;
  const apply = () => {
    img.style.width = zoom === 1 ? '' : `${zoom * 100}%`;
    img.style.maxWidth = zoom === 1 ? '100%' : 'none';
    stage.classList.toggle('zoomed', zoom > 1);
    vw.querySelector('[data-z="-1"]').disabled = zoom <= 1;
    vw.querySelector('[data-z="1"]').disabled = zoom >= 4;
    vw.querySelector('.vw-fit').classList.toggle('on', zoom === 1);
  };
  vw.querySelector('.vw-bar').addEventListener('click', (e) => {
    const z = e.target.closest('[data-z]'); if (!z || z.disabled) return;
    zoom = +z.dataset.z === 0 ? 1 : Math.max(1, Math.min(4, zoom * (+z.dataset.z > 0 ? 1.5 : 1 / 1.5)));
    if (zoom < 1.05) zoom = 1;
    apply();
  });
  crViewerChrome(vw); apply();
}

async function crPdf(box, url, onLast) {
  box.innerHTML = `<div class="vw vw-pdf" tabindex="0" aria-label="Slides">
    <div class="vw-stage"><canvas hidden></canvas><p class="vw-loading">Loading the slides…</p></div>
    <div class="vw-track" aria-hidden="true"><i></i></div>
    <div class="vw-bar" role="toolbar" aria-label="Slide controls">
      <button type="button" class="vw-btn nav" data-p="-1" aria-label="Previous page">${crSvg.prev}</button>
      <label class="vw-pageno"><span class="vw-word">Page</span> <input class="vw-page" type="number" min="1" value="1" inputmode="numeric" aria-label="Go to page"> <span class="vw-of">of <b class="vw-total">–</b></span></label>
      <button type="button" class="vw-btn nav" data-p="1" aria-label="Next page">${crSvg.next}</button>
      <span class="vw-gap"></span>
      <span class="vw-zoom"><button type="button" class="vw-btn ghost" data-z="-1" aria-label="Zoom out">−</button><button type="button" class="vw-btn ghost vw-fit" data-z="0" aria-label="Fit to the screen">Fit</button><button type="button" class="vw-btn ghost" data-z="1" aria-label="Zoom in">+</button></span>
      <button type="button" class="vw-btn ghost" data-fs aria-label="Full screen"><span class="vw-fs-ico" aria-hidden="true"></span><span class="vw-lab">Full screen</span></button>
    </div></div>`;
  const vw = box.querySelector('.vw'), stage = vw.querySelector('.vw-stage'), canvas = vw.querySelector('canvas'), inp = vw.querySelector('.vw-page');
  let lib;
  try { lib = await crLoadPdfJs(); } catch { box.innerHTML = `<p><a class="refresh cr-open" href="${esc(url)}" target="_blank" rel="noopener">Open the PDF</a></p>`; return; }
  let doc;
  try { doc = await lib.getDocument(url).promise; } catch (e) { stage.innerHTML = `<p class="vw-loading">Couldn’t open the PDF: ${esc(e.message || 'unknown error')}</p>`; return; }
  vw.querySelector('.vw-loading').remove(); canvas.hidden = false;
  const N = doc.numPages;
  vw.querySelector('.vw-total').textContent = N;
  inp.max = N; inp.style.width = `${String(N).length + 2.4}em`;
  let page = 1, zoom = 1, busy = false, again = false, reached = false;
  async function draw() {
    if (busy) { again = true; return; }
    busy = true;
    const p = await doc.getPage(page);
    const vp0 = p.getViewport({ scale: 1 });
    const full = vw.classList.contains('vw-full');
    const availW = stage.clientWidth || 800, availH = full ? (stage.clientHeight || window.innerHeight - 90) : Infinity;
    const fit = Math.min(availW / vp0.width, availH / vp0.height);
    const css = fit * zoom, dpr = window.devicePixelRatio || 1, vp = p.getViewport({ scale: css * dpr });
    canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
    canvas.style.width = `${Math.floor(vp0.width * css)}px`; canvas.style.height = `${Math.floor(vp0.height * css)}px`;
    await p.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    inp.value = page;
    vw.querySelector('.vw-track i').style.width = `${(page / N) * 100}%`;
    vw.querySelector('[data-p="-1"]').disabled = page <= 1;
    vw.querySelector('[data-p="1"]').disabled = page >= N;
    vw.querySelector('[data-z="-1"]').disabled = zoom <= 1;
    vw.querySelector('[data-z="1"]').disabled = zoom >= 4;
    vw.querySelector('.vw-fit').classList.toggle('on', zoom === 1);
    stage.classList.toggle('zoomed', zoom > 1);
    if (page === N && !reached) { reached = true; onLast(); }
    busy = false;
    if (again) { again = false; draw(); }
  }
  const go = (n) => { n = Math.max(1, Math.min(N, n)); if (n !== page) { page = n; stage.scrollTop = 0; draw(); } else inp.value = page; };
  const setZoom = (d) => { zoom = d === 0 ? 1 : Math.max(1, Math.min(4, +(zoom * (d > 0 ? 1.25 : 0.8)).toFixed(2))); if (zoom < 1.05) zoom = 1; draw(); };
  vw.querySelector('.vw-bar').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b || b.disabled) return;
    if (b.dataset.p) go(page + Number(b.dataset.p));
    else if (b.dataset.z !== undefined) setZoom(Number(b.dataset.z));
  });
  inp.addEventListener('change', () => go(parseInt(inp.value, 10) || page));
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(parseInt(inp.value, 10) || page); inp.select(); } e.stopPropagation(); });
  const key = (e) => {
    if (!vw.isConnected) return document.removeEventListener('keydown', key);
    if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable]')) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); go(page + 1); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go(page - 1); }
    else if (e.key === 'Home') { e.preventDefault(); go(1); }
    else if (e.key === 'End') { e.preventDefault(); go(N); }
    else if (e.key === '+' || e.key === '=') setZoom(1);
    else if (e.key === '-') setZoom(-1);
  };
  document.addEventListener('keydown', key);
  let x0 = null;
  stage.addEventListener('touchstart', (e) => { x0 = zoom === 1 && e.touches.length === 1 ? e.touches[0].clientX : null; }, { passive: true });
  stage.addEventListener('touchend', (e) => { if (x0 == null) return; const dx = e.changedTouches[0].clientX - x0; if (Math.abs(dx) > 45) go(page + (dx < 0 ? 1 : -1)); x0 = null; });
  crViewerChrome(vw, draw);
  draw();
}

// ---------- quizzes and exams ----------
// Can this browser put a page into full screen? (No on iPhone Safari and Discord's iPhone browser.)
const crCanFullscreen = () => !!(document.fullscreenEnabled || document.webkitFullscreenEnabled) && !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen);
function crEndedHtml(why) {
  return `<div class="cr-ended" role="alert"><strong>Your exam has ended.</strong><span>${esc(String(why || 'You left the exam screen').replace(/\.?$/, '.'))} This used one try.</span>
    <span class="muted small">If you think this was a mistake, ask your department: an assessor can give you another try.</span></div>`;
}
async function crQuiz(el, body, dept, c, it) {
  const tries = (c.attempts || []).filter((a) => a.item_id === it.id);
  const last = tries[tries.length - 1];
  const locked = it.lock === 'phones' || it.lock === 'fullscreen';
  const fsOk = crCanFullscreen();
  const blocked = it.lock === 'fullscreen' && !fsOk;
  const facts = `${it.exam ? 'Exam' : 'Quiz'} · ${it.question_count || 0} questions · pass mark ${it.pass_pct ?? 80}% · ${it.tries ?? 3} ${(it.tries ?? 3) === 1 ? 'try' : 'tries'}${it.time_limit_min ? ` · ${it.time_limit_min} minutes` : ''}`;
  const startBtn = (label) => (c.mine && !c.lock && !blocked ? `<button type="button" class="refresh cr-start-btn" id="cr-start">${label}</button>` : '');
  const intro = (extra = '', label = locked ? 'Start exam' : 'Start') => locked ? `<div class="cr-lockrules">
      <p class="cr-lockfacts">${facts}</p>
      <h3>Before You Start</h3>
      <ul>
        ${fsOk ? '<li>The exam opens in <strong>full screen</strong>. Stay in full screen until you send your answers.</li>'
          : '<li>Your browser can’t go full screen, so <strong>stay on this page</strong> until you send your answers. Don’t switch apps or tabs.</li>'}
        <li>If you leave (${fsOk ? 'exit full screen, ' : ''}switch tab or app, or reload), you get <strong>one warning</strong> and 30 seconds to come back.</li>
        <li>Leaving <strong>a second time</strong>, or being away for <strong>30 seconds</strong>, ends your exam. It uses a try and isn’t marked.</li>
        <li>Turn on Do Not Disturb so notifications don’t pull you out.</li>
      </ul>
      ${blocked ? '<p class="cr-lockblock">This exam has to be taken on a computer, in full screen. Open this page on a computer to start.</p>' : ''}
      ${extra}${startBtn(label)}</div>`
    : `<div class="cr-quiz-intro"><p>${facts}</p>${extra}${startBtn(label)}</div>`;
  if (last && last.status === 'marking') {
    body.innerHTML = `<div class="cr-held"><strong>Submitted.</strong><span>Results usually within ${esc(it.results_in || 'a few days')}. You’ll get a DM from CareBeyond Helper when it’s marked.</span></div>`;
    return;
  }
  if (last && last.status === 'marked') {
    const { data: r } = await sb.rpc('quiz_result', { attempt_id: last.id });
    body.innerHTML = crResultHtml(r) + (r && !r.passed ? intro() : '');
  } else if (last && last.status === 'ended') {
    body.innerHTML = crEndedHtml(last.ended_reason) + intro('', 'Start again');
  } else if (last && last.status === 'in_progress') {
    body.innerHTML = intro(`<p class="muted small">You have ${locked ? 'an exam' : 'a try'} in progress. Your answers were saved.${locked ? ' Coming back counts as leaving the exam once.' : ''}</p>`, 'Carry on');
  } else body.innerHTML = intro();
  const sb2 = body.querySelector('#cr-start');
  if (!sb2) return;
  sb2.onclick = async () => {
    sb2.disabled = true;
    const box = body.closest('.cr-step') || body;
    // Full screen has to be asked for straight from the tap, before anything else waits.
    if (locked && fsOk) { try { await (box.requestFullscreen || box.webkitRequestFullscreen).call(box); } catch { /* the guard treats it as not in full screen */ } }
    const { data: q, error } = await sb.rpc('quiz_start', { cid: c.id, iid: it.id });
    if (error) { crLockExit(); sb2.disabled = false; return body.insertAdjacentHTML('beforeend', `<p class="error">${esc(error.message)}</p>`); }
    crQuizRun(body, q, async () => { const { data: v } = await sb.rpc('course_view', { cid: c.id }); if (v) { Object.assign(c, v); } }, box);
  };
}
function crResultHtml(r) {
  if (!r) return '';
  if (r.status === 'marking') return `<div class="cr-held"><strong>Submitted.</strong><span>Results usually within ${esc(r.results_in || 'a few days')}.</span></div>`;
  if (r.status === 'ended') return crEndedHtml(r.ended_reason);
  return `<div class="cr-score"><b>${r.score} / ${r.max_score}</b><span class="cr-pill ${r.passed ? 'done' : 'late'}">${r.passed ? 'Passed' : 'Not passed'}</span><span class="muted">Pass mark ${r.pass_pct}%</span></div>
    ${r.review ? `<div class="cr-review">${r.review.map((q, i) => {
      const opts = (q.options || []), key = new Set((q.key || []).map(String)), ans = Array.isArray(q.answer) ? q.answer.map(String) : q.answer != null ? [String(q.answer)] : [];
      return `<div class="cr-rq"><div class="cr-rq-h"><strong>${i + 1}. ${esc(q.text)}</strong><span class="muted small">${q.got ?? 0} / ${q.points}</span></div>
        ${opts.length ? `<ul>${opts.map((o) => `<li class="${key.has(String(o.id)) ? 'right' : ans.includes(String(o.id)) ? 'wrong' : ''}">${esc(o.text)}${key.has(String(o.id)) ? ' ✓' : ''}${ans.includes(String(o.id)) ? ' <em>(your answer)</em>' : ''}</li>`).join('')}</ul>`
          : `<p class="muted small">Your answer: ${esc(q.answer || '–')}${(q.accepted || []).length ? ` · Accepted: ${esc(q.accepted.join(', '))}` : ''}</p>`}</div>`;
    }).join('')}</div>` : ''}`;
}
function crQuizRun(body, q, after, lockBox) {
  if (q.ended) { crLockExit(); body.innerHTML = crEndedHtml(q.ended_reason); after(); return; }
  const answers = Object.assign({}, q.answers || {});
  const qs = q.questions || [];
  let saveT;
  const save = () => { clearTimeout(saveT); saveT = setTimeout(() => sb.rpc('quiz_save', { attempt_id: q.attempt_id, answers }), 600); };
  const ends = q.time_limit_min ? new Date(new Date(q.started_at).getTime() + q.time_limit_min * 60000) : null;
  let n = 0;
  body.innerHTML = `<form class="cr-quiz" id="cr-quiz">${ends ? '<p class="cr-timer" id="cr-timer"></p>' : ''}${qs.map((x) => {
    if (x.type === 'section') return `<h3 class="cr-qsec">${esc(x.text)}</h3>`;
    n += 1;
    const name = 'q-' + x.id, a = answers[x.id];
    let inp;
    if (x.type === 'single' || x.type === 'truefalse') inp = (x.options || []).map((o) => `<label class="cr-opt"><input type="radio" name="${esc(name)}" value="${esc(o.id)}"${a === o.id ? ' checked' : ''}><span>${esc(o.text)}</span></label>`).join('');
    else if (x.type === 'multi') inp = (x.options || []).map((o) => `<label class="cr-opt"><input type="checkbox" name="${esc(name)}" value="${esc(o.id)}"${Array.isArray(a) && a.includes(o.id) ? ' checked' : ''}><span>${esc(o.text)}</span></label>`).join('') + '<span class="muted small">Tick every right answer.</span>';
    else if (x.type === 'short') inp = `<input class="cr-text" name="${esc(name)}" maxlength="300" value="${esc(a || '')}">`;
    else inp = `<textarea class="cr-text" name="${esc(name)}" rows="5" maxlength="5000">${esc(a || '')}</textarea>`;
    return `<fieldset class="cr-q" data-q="${esc(x.id)}" data-type="${esc(x.type)}"><legend><span class="cr-qn">${n}.</span> ${esc(x.text)} <span class="muted small">(${x.points} ${x.points === 1 ? 'point' : 'points'})</span></legend>${inp}</fieldset>`;
  }).join('')}
    <p class="error" id="cr-qerr" hidden></p>
    <div class="cr-step-foot"><span class="muted small">Answers save as you go.</span><span class="sp"></span><button type="submit" class="refresh">Send answers</button></div></form>`;
  const form = body.querySelector('#cr-quiz');
  const guard = q.lock && q.lock !== 'off' ? crExamGuard(lockBox || body, q, (r) => { clearTimeout(saveT); clearInterval(timer); body.innerHTML = crEndedHtml(r.ended_reason); after(); }) : null;
  form.addEventListener('input', (e) => {
    const fs = e.target.closest('[data-q]'); if (!fs) return;
    const id = fs.dataset.q, ty = fs.dataset.type;
    if (ty === 'multi') answers[id] = [...fs.querySelectorAll('input:checked')].map((x) => x.value);
    else if (ty === 'single' || ty === 'truefalse') answers[id] = fs.querySelector('input:checked')?.value;
    else answers[id] = e.target.value;
    save();
  });
  var timer;
  if (ends) {
    const tick = () => { const s = Math.max(0, Math.round((ends - Date.now()) / 1000)); const t = body.querySelector('#cr-timer'); if (!t) return clearInterval(timer);
      t.textContent = `Time left: ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; if (s === 0) { clearInterval(timer); form.requestSubmit(); } };
    tick(); timer = setInterval(tick, 1000);
  }
  form.onsubmit = async (e) => {
    e.preventDefault(); clearTimeout(saveT); clearInterval(timer);
    const btn = form.querySelector('[type=submit]'); btn.disabled = true;
    if (guard) guard.stop();
    const { data: r, error } = await sb.rpc('quiz_submit', { attempt_id: q.attempt_id, answers });
    if (error) { btn.disabled = false; const p = form.querySelector('#cr-qerr'); p.textContent = error.message; p.hidden = false; return; }
    crLockExit();
    body.innerHTML = crResultHtml(r);
    after();
  };
}

// Leave full screen quietly (after sending answers, or when the exam ends).
function crLockExit() {
  try { if (document.fullscreenElement || document.webkitFullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch { /* fine */ }
}
// The exam guard (0055): watches for leaving (full screen, tab or app, window, the page) and reports each exit and
// return to the server, which decides when the try ends. The page shows one big warning with a 30-second countdown.
function crExamGuard(box, q, onEnded) {
  const fsMode = crCanFullscreen() && q.lock !== 'off';
  let out = false, done = false, tick = null, overlay = null;
  const inFull = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
  async function report(kind, detail) {
    const { data, error } = await sb.rpc('quiz_lock_event', { attempt_id: q.attempt_id, kind, detail: detail || null });
    if (error || !data) return null;
    if (data.ended) { end(data); return data; }
    return data;
  }
  function end(data) {
    if (done) return;
    done = true; stopListening(); hideWarning(); crLockExit(); onEnded(data || {});
  }
  async function exit(detail) {
    if (done || out) return;
    out = true;
    const r = await report('exit', detail);
    if (done) return;
    showWarning(r && r.seconds_left != null ? r.seconds_left : 30);
  }
  async function back() {
    if (done) return;
    if (fsMode && !inFull()) { try { await (box.requestFullscreen || box.webkitRequestFullscreen).call(box); } catch { return; } }
    out = false; hideWarning();
    await report('return');
  }
  function showWarning(secs) {
    hideWarning();
    overlay = document.createElement('div');
    overlay.className = 'cr-lockwarn';
    overlay.setAttribute('role', 'alertdialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-labelledby', 'cr-lw-h');
    overlay.innerHTML = `<div class="cr-lw-box"><span class="cr-lw-n" id="cr-lw-n">${secs}</span>
      <h2 id="cr-lw-h">You Left the Exam</h2>
      <p>Return ${fsMode ? 'to full screen ' : ''}within <strong><span id="cr-lw-s">${secs}</span> seconds</strong> or your exam ends.</p>
      <p class="cr-lw-only">This is your only warning. Leaving again ends your exam.</p>
      <button type="button" class="cr-lw-btn" id="cr-lw-back">${fsMode ? 'Return to full screen' : 'I’m back'}</button></div>`;
    (inFull() ? document.fullscreenElement || document.webkitFullscreenElement : document.body).append(overlay);
    overlay.querySelector('#cr-lw-back').onclick = back;
    overlay.querySelector('#cr-lw-back').focus();
    let left = secs;
    tick = setInterval(async () => {
      left -= 1;
      const n = overlay && overlay.querySelector('#cr-lw-n'), s2 = overlay && overlay.querySelector('#cr-lw-s');
      if (n) n.textContent = Math.max(0, left); if (s2) s2.textContent = Math.max(0, left);
      if (left <= 0) { clearInterval(tick); const r = await report('return', 'timer ran out'); if (r && !r.ended) end({ ended_reason: 'Out of the exam screen for more than 30 seconds' }); }
    }, 1000);
  }
  function hideWarning() { clearInterval(tick); if (overlay) overlay.remove(); overlay = null; }
  // What counts as leaving.
  const onFs = () => { if (fsMode && !inFull()) exit('Left full screen'); else if (fsMode && inFull() && out) back(); };
  const onVis = () => { if (document.hidden) exit('Switched tab or app'); };
  let blurT;
  const onBlur = () => { clearTimeout(blurT); blurT = setTimeout(() => { if (!document.hasFocus() && !document.hidden) exit('Left the exam window'); }, 400); };
  const onHash = () => { if (!box.isConnected) exit('Left the exam page'); };
  const onHide = () => { exit('Closed or reloaded the page'); };
  document.addEventListener('fullscreenchange', onFs); document.addEventListener('webkitfullscreenchange', onFs);
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('blur', onBlur);
  window.addEventListener('hashchange', onHash);
  window.addEventListener('pagehide', onHide);
  function stopListening() {
    document.removeEventListener('fullscreenchange', onFs); document.removeEventListener('webkitfullscreenchange', onFs);
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('blur', onBlur); window.removeEventListener('hashchange', onHash); window.removeEventListener('pagehide', onHide);
    clearTimeout(blurT);
  }
  box.classList.add('cr-locked');
  report('start', fsMode ? (inFull() ? 'Full screen' : 'Full screen refused') : 'Stay on this page');
  // Came back to a try that was already out (reload): the server counted it, so show the warning straight away.
  if (q.resumed && q.out_since) { out = true; showWarning(q.seconds_left != null ? q.seconds_left : 30); }
  else if (fsMode && !inFull()) exit('Not in full screen');
  return { stop() { done = true; stopListening(); hideWarning(); box.classList.remove('cr-locked'); } };
}

// Assessors: one try's exit log.
async function crAttemptLog(aid) {
  const { data: d, error } = await sb.rpc('course_attempt_log', { attempt_id: aid });
  document.querySelector('.app-pv')?.remove();
  const wrap = document.createElement('div');
  wrap.className = 'app-pv';
  const label = { start: 'Started', exit: 'Left the exam', return: 'Came back', resume: 'Opened again', ended: 'Ended', timeout: 'Away 30 seconds' };
  wrap.innerHTML = `<div class="app-pv-box" role="dialog" aria-modal="true" aria-label="Exit log"><button type="button" class="app-pv-x">Close</button>
    <div class="card cr-step"><h2 class="cr-step-h">Exit Log</h2>
    ${error || !d ? `<p class="error">${esc(error ? error.message : 'Not available.')}</p>` : `
      <p class="muted small">${d.lock === 'fullscreen' ? 'Computer only (full screen)' : 'Allow phones (stay on this page)'} · left ${d.exits} ${d.exits === 1 ? 'time' : 'times'}${d.status === 'ended' ? ` · <strong class="danger-text">Ended: ${esc(d.ended_reason || '')}</strong>` : ''}</p>
      <ol class="cr-log">${(d.events || []).map((e) => `<li><span class="cr-log-t">${esc(new Date(e.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }))}</span><strong>${esc(label[e.kind] || e.kind)}</strong>${e.detail ? ` <span class="muted">· ${esc(e.detail)}</span>` : ''}</li>`).join('')}</ol>
      ${d.status === 'ended' ? `<h3 class="cr-qsec">Answers Given (Not Marked)</h3>${(d.questions || []).filter((x) => x.type !== 'section').map((x, i) => { const a = (d.answers || {})[x.id]; const shown = Array.isArray(a) ? a.map((id) => (x.options || []).find((o) => o.id === id)?.text || id).join(', ') : (x.options || []).find((o) => o.id === a)?.text || a; return `<div class="cr-rq"><strong>${i + 1}. ${esc(x.text)}</strong><p class="cr-ans">${esc(shown || '–')}</p></div>`; }).join('')}` : ''}`}
    </div></div>`;
  document.body.append(wrap);
  const close = () => wrap.remove();
  wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('.app-pv-x')) close(); });
  wrap.querySelector('.app-pv-x').focus();
}


// ---------- assigning a course to people (0056) ----------
// Owner: "assign certain courses to certain members". On top of the course's ranks: assigned people can open it,
// but open dates and prerequisites still apply. They get a DM, it shows in My courses and as a To do.
function crAssignedCard(list) {
  if (!list.length) return '';
  const now = Date.now(), done = list.filter((a) => a.complete).length;
  return `<div class="card cr-asg">
    <div class="cr-asg-h"><strong>Assigned: ${list.length} · done: ${done}</strong><button type="button" class="ghost" data-assign>Assign more</button></div>
    <ul class="cr-asg-list">${list.map((a) => {
      const late = !a.complete && a.due_at && new Date(a.due_at) < now;
      return `<li>
        ${face({ name: a.name, discordId: a.discord_id, avatarUrl: a.avatar_url, size: 's' })}
        <span class="cr-asg-who"><strong>${esc(cleanName(a.name))}</strong><span class="muted small">${a.counts ? `${a.counts.done} of ${a.counts.total} steps · ` : ''}by ${esc(cleanName(a.assigned_by || ''))} ${esc(crDate(a.at))}${a.note ? ` · “${esc(a.note)}”` : ''}</span></span>
        <span class="cr-asg-st">${a.complete ? '<span class="cr-pill done">Done</span>' : late ? `<span class="cr-pill late">Overdue, due ${esc(crDate(a.due_at))}</span>` : a.due_at ? `<span class="cr-pill due">Due ${esc(crDate(a.due_at))}</span>` : '<span class="cr-pill soon">No due date</span>'}
          <button type="button" class="linkish cr-try" data-unassign="${esc(a.discord_id)}">Unassign</button></span>
      </li>`;
    }).join('')}</ul></div>`;
}

async function crAssignDialog(c, dept, after) {
  const ranks = await crLoadRanks(dept);
  document.querySelector('.app-pv')?.remove();
  const wrap = document.createElement('div');
  wrap.className = 'app-pv';
  const picked = new Map();   // discord_id -> { name, avatar_url }
  wrap.innerHTML = `<div class="app-pv-box" role="dialog" aria-modal="true" aria-label="Assign ${esc(c.title)}"><button type="button" class="app-pv-x">Close</button>
    <form class="card cr-step cr-as" novalidate>
      <h2 class="cr-step-h">Assign ${esc(c.title)}</h2>
      <p class="muted small cr-as-rule">They can open it even if it isn’t for their rank. Open dates and prerequisites still apply.</p>
      <label class="f"><span>People</span><input type="search" id="cr-as-q" placeholder="Search by name" autocomplete="off"></label>
      <div class="cr-as-res" id="cr-as-res" role="listbox" aria-label="Search results"></div>
      ${ranks.length ? `<div class="f"><span>Or everyone with a rank</span><div class="cr-as-ranks">${ranks.map((r) => `<button type="button" class="chip" data-rank="${esc(r.id)}">${esc(r.rank_label || r.name)}</button>`).join('')}</div></div>` : ''}
      <div class="cr-as-picked" id="cr-as-picked"></div>
      <div class="cr-as-row">
        <label class="f"><span>Due (optional)</span><input type="date" id="cr-as-due" min="${new Date().toISOString().slice(0, 10)}"></label>
      </div>
      <label class="f"><span>Note (optional)</span><textarea id="cr-as-note" rows="2" maxlength="500" placeholder="e.g. Finish this before your first shift"></textarea></label>
      <p class="error" hidden></p>
      <div class="f-actions"><button type="button" class="linkish" data-x>Cancel</button><button class="refresh" type="submit" disabled>Assign</button></div>
    </form></div>`;
  document.body.append(wrap);
  const f = wrap.querySelector('form'), q = f.querySelector('#cr-as-q'), res = f.querySelector('#cr-as-res'), box = f.querySelector('#cr-as-picked');
  const go = f.querySelector('[type=submit]'), err = f.querySelector('.error');
  const close = () => wrap.remove();
  wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('.app-pv-x, [data-x]')) close(); });
  wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  function drawPicked() {
    box.innerHTML = picked.size ? `<span class="muted small">${picked.size} ${picked.size === 1 ? 'person' : 'people'}</span>${[...picked].map(([id, p]) =>
      `<span class="cr-as-chip">${face({ name: p.name, discordId: id, avatarUrl: p.avatar_url, size: 's' })}${esc(cleanName(p.name))}<button type="button" data-drop="${esc(id)}" aria-label="Remove ${esc(cleanName(p.name))}">×</button></span>`).join('')}` : '';
    loadFaces(box);
    go.disabled = !picked.size;
    go.textContent = picked.size ? `Assign to ${picked.size} ${picked.size === 1 ? 'person' : 'people'}` : 'Assign';
  }
  let timer = null;
  q.oninput = () => {
    clearTimeout(timer);
    const term = q.value.trim();
    if (term.length < 2) { res.innerHTML = ''; return; }
    timer = setTimeout(async () => {
      const { data, error } = await sb.rpc('course_assign_people', { cid: c.id, q: term });
      if (q.value.trim() !== term) return;
      if (error) { res.innerHTML = `<p class="error">${esc(error.message)}</p>`; return; }
      res.innerHTML = (data || []).length ? data.map((m) => `<button type="button" class="dp-pick${picked.has(m.discord_id) ? ' on' : ''}" data-id="${esc(m.discord_id)}" data-name="${esc(m.name)}" data-av="${esc(m.avatar_url || '')}"${m.assigned ? ' disabled title="Already assigned"' : ''}>
          ${face({ name: m.name, discordId: m.discord_id, avatarUrl: m.avatar_url, size: 's' })}<span>${esc(cleanName(m.name))}${m.assigned ? ' · assigned' : ''}</span></button>`).join('')
        : '<p class="muted small">Nobody found.</p>';
      loadFaces(res);
    }, 250);
  };
  f.onclick = async (e) => {
    const p = e.target.closest('.dp-pick');
    if (p && !p.disabled) { picked.set(p.dataset.id, { name: p.dataset.name, avatar_url: p.dataset.av }); p.classList.add('on'); drawPicked(); return; }
    const d = e.target.closest('[data-drop]');
    if (d) { picked.delete(d.dataset.drop); res.querySelector(`.dp-pick[data-id="${CSS.escape(d.dataset.drop)}"]`)?.classList.remove('on'); drawPicked(); return; }
    const r = e.target.closest('[data-rank]');
    if (r) {
      r.disabled = true;
      const { data, error } = await sb.rpc('course_assign_people', { cid: c.id, rank_id: r.dataset.rank });
      r.disabled = false;
      if (error) { err.hidden = false; err.textContent = error.message; return; }
      const fresh = (data || []).filter((m) => !m.assigned);
      fresh.forEach((m) => picked.set(m.discord_id, { name: m.name, avatar_url: m.avatar_url }));
      r.classList.add('on');
      r.textContent = `${r.textContent.replace(/ · .*$/, '')} · ${fresh.length ? `+${fresh.length}` : 'nobody new'}`;
      drawPicked();
    }
  };
  f.onsubmit = async (e) => {
    e.preventDefault();
    if (!picked.size) return;
    const day = f.querySelector('#cr-as-due').value, note = f.querySelector('#cr-as-note').value.trim();
    go.disabled = true; err.hidden = true;
    const { data: n, error } = await sb.rpc('course_assign', { cid: c.id, ids: [...picked.keys()], due_at: day ? new Date(`${day}T23:59:00`).toISOString() : null, note: note || null });
    if (error) { go.disabled = false; err.hidden = false; err.textContent = error.message; return; }
    f.innerHTML = `<h2 class="cr-step-h">Assigned</h2><p>${esc(c.title)} is now assigned to ${n} ${n === 1 ? 'person' : 'people'}. They’ll get a DM from the bot.</p><div class="f-actions"><button type="button" class="refresh" data-x>Done</button></div>`;
    f.querySelector('[data-x]').focus();
    if (after) after();
  };
  q.focus();
}

// ---------- practical evaluations ----------
function crEvalResult(it, ev) {
  return `<div class="cr-score"><span class="cr-pill ${ev.passed ? 'done' : 'due'}">${ev.passed ? 'Passed' : 'Not passed yet'}</span><span class="muted">Assessed by ${esc(cleanName(ev.assessor || ''))}${ev.submitted_at ? ' · ' + esc(crDate(ev.submitted_at)) : ''}</span></div>
    <div class="cr-table-wrap"><table class="cr-table"><thead><tr><th>Competency</th><th>Level</th><th>Comment</th></tr></thead><tbody>
    ${(it.competencies || []).map((k) => { const lv = +(ev.levels || {})[k.id]; return `<tr><td>${esc(k.text)}</td><td><span class="cr-lvl l${lv}">${esc(CR_LEVELS[lv - 1] || '–')}</span></td><td class="muted">${esc((ev.comments || {})[k.id] || '')}</td></tr>`; }).join('')}
    </tbody></table></div>${(ev.comments || {})._overall ? `<p class="cr-overall">${esc(ev.comments._overall)}</p>` : ''}`;
}
async function crEvalForm(el, dept, c, it, who) {
  const { data: ex } = await sb.rpc('course_eval_get', { cid: c.id, iid: it.id, who });
  const { data: rows } = await sb.rpc('course_progress_report', { cid: c.id });
  const person = (rows || []).find((r) => r.discord_id === who) || {};
  const levels = Object.assign({}, ex && ex.status === 'draft' ? ex.levels : {}), comments = Object.assign({}, ex && ex.status === 'draft' ? ex.comments : {});
  const done = ex && ex.status === 'submitted';
  const need = it.pass_level || 3;
  el.innerHTML = `<button type="button" class="back inline-back" id="cr-back"><span class="back-ico" aria-hidden="true"></span>${esc(c.title)}</button>
    <section class="card cr-step"><div class="cr-eval-h"><h2 class="cr-step-h">${esc(it.title)}</h2><span class="cr-pill aud">${esc(cleanName(person.name || who))}${person.rank ? ' · ' + esc(person.rank) : ''}</span></div>
    ${done ? crEvalResult(it, Object.assign({ assessor: ex.assessor_name }, ex)) : `
    <div class="cr-table-wrap"><table class="cr-table cr-rubric"><thead><tr><th>Competency</th>${CR_LEVELS.map((l) => `<th>${l}</th>`).join('')}</tr></thead><tbody>
      ${(it.competencies || []).map((k) => `<tr data-k="${esc(k.id)}"><td><strong>${esc(k.text)}</strong><textarea class="cr-cmt" rows="1" maxlength="500" placeholder="Comment (optional)">${esc(comments[k.id] || '')}</textarea></td>
        ${CR_LEVELS.map((l, i) => `<td><button type="button" class="cr-lvl-btn l${i + 1}${+levels[k.id] === i + 1 ? ' on' : ''}" data-lv="${i + 1}" aria-pressed="${+levels[k.id] === i + 1}">${l}</button></td>`).join('')}</tr>`).join('')}
    </tbody></table></div>
    <label class="f"><span>Overall comment <em>(optional)</em></span><textarea id="cr-overall" rows="2" maxlength="1000">${esc(comments._overall || '')}</textarea></label>
    <p class="error" id="cr-everr" hidden></p>
    <div class="cr-step-foot"><span id="cr-evstate" class="cr-pill due"></span><span class="sp"></span><button type="button" class="ghost" id="cr-evsave">Save as draft</button><button type="button" class="refresh" id="cr-evsubmit">Submit report</button></div>`}
    </section>`;
  el.querySelector('#cr-back').onclick = () => crCourse(el, dept, c.id, '');
  if (done) return;
  const state = () => { const below = (it.competencies || []).filter((k) => !levels[k.id] || +levels[k.id] < need).length; el.querySelector('#cr-evstate').textContent = below ? `Not passed yet: ${below} below ${CR_LEVELS[need - 1]}` : 'Passes'; el.querySelector('#cr-evstate').className = 'cr-pill ' + (below ? 'due' : 'done'); };
  state();
  el.onclick = async (e) => {
    const b = e.target.closest('[data-lv]');
    if (b) { const k = b.closest('[data-k]').dataset.k; levels[k] = +b.dataset.lv; b.closest('tr').querySelectorAll('[data-lv]').forEach((x) => { const on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-pressed', String(on)); }); state(); return; }
    const sv = e.target.closest('#cr-evsave, #cr-evsubmit');
    if (!sv) return;
    el.querySelectorAll('[data-k]').forEach((r) => { comments[r.dataset.k] = r.querySelector('.cr-cmt').value.trim(); });
    comments._overall = el.querySelector('#cr-overall').value.trim();
    sv.disabled = true;
    const { error } = await sb.rpc('course_eval_save', { cid: c.id, iid: it.id, who, levels, comments, submit: sv.id === 'cr-evsubmit', observed_on: null });
    sv.disabled = false;
    const er = el.querySelector('#cr-everr');
    if (error) { er.textContent = error.message; er.hidden = false; return; }
    if (sv.id === 'cr-evsubmit') return crCourse(el, dept, c.id, '');
    sv.textContent = 'Saved';
  };
}

// ---------- marking queue (Assess courses) ----------
async function crMarking(el, dept) {
  crSetHash(crRoute(dept, 'marking'));
  el.innerHTML = '<div class="card"><p class="muted small">Loading…</p></div>';
  const { data, error } = await sb.rpc('course_marking', { dept });
  if (error) { el.innerHTML = ''; return liveError(el, error); }
  const list = data || [];
  el.innerHTML = `<button type="button" class="back inline-back" id="cr-back"><span class="back-ico" aria-hidden="true"></span>Courses</button>
    ${list.length ? list.map((a) => `<section class="card cr-mark" data-a="${a.id}">
      <div class="cr-eval-h"><h2 class="cr-step-h">${esc(a.quiz)} <span class="muted small">· ${esc(a.course)}</span></h2><span class="cr-pill aud">${esc(cleanName(a.name))}</span><span class="muted small">Sent ${esc(when(a.submitted_at))}</span></div>
      ${(a.questions || []).filter((q) => q.type !== 'section').map((q, i) => {
        const auto = a.marks && q.id in a.marks, ans = (a.answers || {})[q.id];
        const shown = Array.isArray(ans) ? ans.map((id) => (q.options || []).find((o) => o.id === id)?.text || id).join(', ') : (q.options || []).find((o) => o.id === ans)?.text || ans;
        return `<div class="cr-rq"><div class="cr-rq-h"><strong>${i + 1}. ${esc(q.text)}</strong><span class="muted small">${q.points ?? 1} pts</span></div>
          <p class="cr-ans">${esc(shown || '–')}</p>
          ${auto ? `<p class="muted small">Marked automatically: ${a.marks[q.id]} / ${q.points ?? 1}</p>` : `${q.model ? `<p class="muted small">Model answer: ${esc(q.model)}</p>` : ''}
            <label class="cr-markin">Mark <input type="number" min="0" max="${q.points ?? 1}" step="0.5" data-mq="${esc(q.id)}" required> / ${q.points ?? 1}</label>`}</div>`;
      }).join('')}
      <p class="error" hidden></p>
      <div class="cr-step-foot"><span class="sp"></span><button type="button" class="refresh" data-submit="${a.id}">Send marks</button></div></section>`).join('')
    : '<div class="card ma-empty"><strong>Nothing to mark.</strong></div>'}`;
  el.querySelector('#cr-back').onclick = () => crGrid(el, dept);
  el.onclick = async (e) => {
    const b = e.target.closest('[data-submit]'); if (!b) return;
    const card = b.closest('[data-a]'), marks = {};
    card.querySelectorAll('[data-mq]').forEach((i) => { if (i.value !== '') marks[i.dataset.mq] = +i.value; });
    b.disabled = true;
    const { error: er } = await sb.rpc('course_mark_attempt', { attempt_id: +b.dataset.submit, marks });
    if (er) { b.disabled = false; const p = card.querySelector('.error'); p.textContent = er.message; p.hidden = false; return; }
    card.innerHTML = '<p class="cr-markdone">Marked. They’ve been sent their result.</p>';
  };
}

// ---------- builders: list ----------
async function crManage(el, dept) {
  crSetHash(crRoute(dept, 'manage'));
  const { data, error } = await sb.rpc('course_admin_list', { dept });
  if (error) { el.innerHTML = ''; return liveError(el, error); }
  el.innerHTML = `<div class="cr-bar"><button type="button" class="back inline-back" id="cr-back"><span class="back-ico" aria-hidden="true"></span>Courses</button><span class="sp"></span><button type="button" class="refresh" id="cr-new">New Course</button></div>
    <div class="card app-group">${(data || []).map((c) => `<div class="af-row"><div class="af-main"><div class="af-t">${esc(c.title)}</div><div class="af-s">${esc(c.kind || '')}${c.opens_at ? ' · opens ' + esc(crDate(c.opens_at)) : ''}</div></div>
      <div class="af-pills"><span class="ap-flag ${c.status === 'published' ? 'open' : ''}">${c.status === 'published' ? 'Published' : 'Not published'}</span>${c.has_draft && c.status === 'published' ? '<span class="ap-flag draft">Unpublished changes</span>' : ''}</div>
      <div class="af-pills"><button type="button" class="ghost small-btn" data-edit="${esc(c.id)}">Edit</button></div></div>`).join('') || '<p class="muted small">No courses yet.</p>'}</div>`;
  el.querySelector('#cr-back').onclick = () => crGrid(el, dept);
  el.onclick = async (e) => {
    const ed = e.target.closest('[data-edit]'); if (ed) return crEditor(el, dept, ed.dataset.edit);
    if (e.target.closest('#cr-new')) { const { data: id, error: er } = await sb.rpc('course_create', { dept, title: 'New course' }); if (!er) crEditor(el, dept, id); }
  };
}

// ---------- builders: the course editor ----------
// The whole course is one draft document, autosaved (and copied to this browser in case the tab closes);
// Publish checks it in the database and makes it live.
async function crEditor(el, dept, cid) {
  crSetHash(crRoute(dept, 'edit/' + cid));
  el.innerHTML = '<div class="card"><p class="muted small">Opening the course…</p></div>';
  const [{ data: d, error }, ranks] = await Promise.all([sb.rpc('course_admin_get', { cid }), crLoadRanks(dept)]);
  if (error || !d) { el.innerHTML = ''; return liveError(el, error || { message: 'This course no longer exists.' }); }
  const lkey = 'cbh-coursedraft-' + cid;
  let draft = JSON.parse(JSON.stringify(d.draft || d.content || {}));
  let local = null; try { local = JSON.parse(localStorage.getItem(lkey) || 'null'); } catch { /* fine */ }
  let dirty = false, saving = false, failed = false, savedAt = d.draft_saved_at, saveT;
  if (local && local.at && (!d.draft_saved_at || new Date(local.at) > new Date(d.draft_saved_at))) { draft = local.draft; dirty = true; }
  draft.modules = draft.modules || [];
  let open = null;   // the step being edited: "m:i"
  el.innerHTML = `
    <div class="bd-top"><button type="button" class="back inline-back" id="ce-back"><span class="back-ico" aria-hidden="true"></span>Courses</button>
      <span class="bd-saved" id="ce-saved" aria-live="polite"></span>
      <span class="bd-acts"><button type="button" class="ghost" id="ce-discard">${d.status === 'published' ? 'Discard changes' : 'Delete draft'}</button><button type="button" class="refresh" id="ce-publish">Publish</button></span></div>
    <p class="error" id="ce-err" hidden></p>
    <div class="bd">
      <div class="app-col">
        <section class="card bd-title"><input id="ce-t" class="bd-t" maxlength="100" placeholder="Course name" aria-label="Course name">
          <textarea id="ce-d" class="bd-d" rows="2" maxlength="1000" placeholder="What this course covers (optional)" aria-label="Description"></textarea></section>
        <div id="ce-mods" class="ce-mods"></div>
        <button type="button" class="ghost small-btn" id="ce-addmod">+ Module</button>
      </div>
      <div class="app-col">
        <section class="card app-fs bd-side">
          <h3 class="app-h">Who It’s For</h3>
          <div class="app-roles" id="ce-aud">${ranks.map((r) => `<label class="app-role"><input type="checkbox" value="${esc(r.id)}"><span>${esc(r.rank_label || r.name)}</span></label>`).join('')}</div>
          <span class="app-hint">None ticked = everyone in ${esc(dept)}.</span>
          <label class="f"><span>Kind</span><input id="ce-kind" maxlength="40" list="ce-kinds"><datalist id="ce-kinds"><option value="General skills"><option value="Evaluation course"><option value="Induction"><option value="Promotion"></datalist></label>
          <label class="f"><span>Opens <em>(optional)</em></span><input id="ce-open" type="date"></label>
          <label class="f"><span>Due, days after it opens <em>(optional)</em></span><input id="ce-due" type="number" min="1" max="365"></label>
          <label class="f"><span>Finish first <em>(optional)</em></span><select id="ce-pre"><option value="">Nothing</option>${(d.others || []).map((o) => `<option value="${esc(o.id)}">${esc(o.title)}</option>`).join('')}</select></label>
          <div class="f"><span>Colour</span><div class="ce-sw" id="ce-sw">${CR_COLOURS.map((cl) => `<button type="button" class="ce-swb" data-col="${cl}" style="background:${cl}" aria-label="Colour ${cl}"></button>`).join('')}<input type="color" id="ce-colour" aria-label="Any colour"></div></div>
          <p class="app-hint">To pass: every step done, every quiz passed and every evaluation at Standard or above.</p>
        </section>
        <div class="bd-danger"><button type="button" class="app-x" id="ce-archive">Remove this course</button></div>
      </div>
    </div>`;
  const $e = (q) => el.querySelector(q);
  function fillSide() {
    $e('#ce-t').value = draft.title || ''; $e('#ce-d').value = draft.description || '';
    $e('#ce-kind').value = draft.kind || ''; $e('#ce-open').value = draft.opens_at ? String(draft.opens_at).slice(0, 10) : '';
    $e('#ce-due').value = draft.due_days || ''; $e('#ce-pre').value = draft.prereq || '';
    $e('#ce-aud').querySelectorAll('input').forEach((x) => { x.checked = (draft.audience_ranks || []).includes(x.value); });
    $e('#ce-colour').value = draft.color || '#2ED3C6';
    $e('#ce-sw').querySelectorAll('[data-col]').forEach((b) => b.classList.toggle('on', (draft.color || '#2ED3C6').toLowerCase() === b.dataset.col.toLowerCase()));
  }
  function drawMods() {
    $e('#ce-mods').innerHTML = draft.modules.map((m, mi) => `<section class="card ce-mod" data-m="${mi}">
      <div class="ce-mod-h"><input class="ce-mt" maxlength="120" value="${esc(m.title)}" placeholder="Module title" aria-label="Module title">
        <span class="bd-btns"><button type="button" data-mup="${mi}"${mi ? '' : ' disabled'} aria-label="Move module up">↑</button><button type="button" data-mrm="${mi}" aria-label="Remove module">×</button></span></div>
      <div class="ce-items">${(m.items || []).map((it, ii) => `<div class="ce-item${open === mi + ':' + ii ? ' open' : ''}" data-i="${mi}:${ii}">
        <button type="button" class="ce-item-h" data-toggle="${mi}:${ii}"><span class="cr-ico" aria-hidden="true">${esc(CR_ICON[it.kind])}</span><span class="ce-item-t">${esc(it.title || 'Untitled')}</span><span class="muted small">${esc(CR_KINDS[it.kind])}</span></button>
        <span class="bd-btns"><button type="button" data-up="${mi}:${ii}"${ii ? '' : ' disabled'} aria-label="Move up">↑</button><button type="button" data-dn="${mi}:${ii}"${ii < m.items.length - 1 ? '' : ' disabled'} aria-label="Move down">↓</button><button type="button" data-rm="${mi}:${ii}" aria-label="Remove step">×</button></span>
        ${open === mi + ':' + ii ? `<div class="ce-item-body">${crItemEditor(it)}</div>` : ''}
      </div>`).join('') || '<p class="muted small">No steps yet.</p>'}</div>
      <div class="addmenu">${Object.entries(CR_KINDS).map(([k, l]) => `<button type="button" class="ghost small-btn" data-add="${mi}:${k}">+ ${l}</button>`).join('')}</div>
    </section>`).join('');
  }
  const status = (t, cls = '') => { const s = $e('#ce-saved'); if (s) { s.textContent = t; s.className = 'bd-saved ' + cls; } };
  const showSaved = () => (failed ? status('Couldn’t save. Trying again…', 'bad') : dirty || saving ? status('Saving…') : status(savedAt ? `Draft saved · ${when(savedAt)}` : d.status === 'published' ? 'No changes since it was published' : 'Not published yet', savedAt ? 'ok' : ''));
  function changed() {
    dirty = true; failed = false;
    try { localStorage.setItem(lkey, JSON.stringify({ at: new Date().toISOString(), draft })); } catch { /* fine */ }
    showSaved(); clearTimeout(saveT); saveT = setTimeout(save, 800);
  }
  async function save() {
    if (!dirty || saving) return;
    saving = true; dirty = false;
    const { data: t, error: er } = await sb.rpc('course_draft_save', { cid, draft });
    saving = false;
    if (er) { failed = true; dirty = true; showSaved(); clearTimeout(saveT); saveT = setTimeout(save, 4000); return; }
    savedAt = t; if (!dirty) { try { localStorage.removeItem(lkey); } catch { /* fine */ } }
    showSaved(); if (dirty) { clearTimeout(saveT); saveT = setTimeout(save, 800); }
  }
  const flush = async () => { clearTimeout(saveT); while (saving) await new Promise((r) => setTimeout(r, 100)); if (dirty) await save(); };
  const itemAt = (key) => { const [mi, ii] = key.split(':').map(Number); return draft.modules[mi].items[ii]; };

  el.addEventListener('input', (e) => {
    const t = e.target;
    if (t.id === 'ce-t') draft.title = t.value;
    else if (t.id === 'ce-d') draft.description = t.value;
    else if (t.id === 'ce-kind') draft.kind = t.value;
    else if (t.id === 'ce-due') draft.due_days = t.value ? Math.max(1, Math.min(365, +t.value)) : null;
    else if (t.id === 'ce-colour') { draft.color = t.value.toUpperCase(); fillSide(); }
    else if (t.classList.contains('ce-mt')) draft.modules[+t.closest('[data-m]').dataset.m].title = t.value;
    else if (t.dataset.f) { crItemInput(itemAt(t.closest('[data-i]').dataset.i), t); if (t.dataset.redraw) drawMods(); }
    else return;
    changed();
  });
  el.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.closest('#ce-aud')) draft.audience_ranks = [...$e('#ce-aud').querySelectorAll('input:checked')].map((x) => x.value);
    else if (t.id === 'ce-open') draft.opens_at = t.value ? new Date(t.value + 'T00:00:00').toISOString() : null;
    else if (t.id === 'ce-pre') draft.prereq = t.value || null;
    else if (t.type === 'file' && t.dataset.upload) {
      const it = itemAt(t.closest('[data-i]').dataset.i), f = t.files[0]; if (!f) return;
      const okType = ['application/pdf', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(f.type);
      const note = t.closest('.ce-item-body').querySelector('.ce-upnote');
      if (!okType) { note.textContent = 'Use a PDF, PowerPoint (.pptx) or image (PNG, JPG, WebP, GIF).'; return; }
      if (f.size > 50 * 1024 * 1024) { note.textContent = 'That file is over 50 MB.'; return; }
      const safe = f.name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '').slice(-80) || 'file';
      const path = `${crDept(dept).id}/${cid}/${Math.random().toString(36).slice(2, 8)}-${safe}`;
      note.textContent = 'Uploading…';
      const { error: er } = await sb.storage.from('course-files').upload(path, f, { contentType: f.type, upsert: false });
      if (er) { note.textContent = 'Upload failed: ' + er.message; return; }
      Object.assign(it, { path, mime: f.type, name: f.name }); if (!it.title) it.title = f.name.replace(/\.[^.]+$/, '');
      drawMods();
    } else if (t.dataset.f) { crItemInput(itemAt(t.closest('[data-i]').dataset.i), t); drawMods(); }
    else return;
    changed();
  });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.dataset.addopt) { e.preventDefault(); e.target.closest('.ce-item-body').querySelector('[data-optadd]')?.click(); }
  });
  el.onclick = async (e) => {
    const t = e.target.closest('button'); if (!t) return;
    const ds = t.dataset;
    if (t.id === 'ce-back') { await flush(); return crGrid(el, dept); }
    if (ds.col) { draft.color = ds.col; fillSide(); return changed(); }
    if (t.id === 'ce-addmod') { draft.modules.push({ id: crUid('m'), title: `Module ${draft.modules.length + 1}`, items: [] }); drawMods(); return changed(); }
    if (ds.mup) { const i = +ds.mup; [draft.modules[i - 1], draft.modules[i]] = [draft.modules[i], draft.modules[i - 1]]; drawMods(); return changed(); }
    if (ds.mrm) { if (draft.modules[+ds.mrm].items.length && !t.classList.contains('confirm')) { t.classList.add('confirm'); t.textContent = '?'; t.title = 'Tap again to remove the module and its steps'; return; } draft.modules.splice(+ds.mrm, 1); drawMods(); return changed(); }
    if (ds.add) { const [mi, k] = ds.add.split(':'); const it = crNewItem(k); draft.modules[+mi].items.push(it); open = `${mi}:${draft.modules[+mi].items.length - 1}`; drawMods(); return changed(); }
    if (ds.toggle) { open = open === ds.toggle ? null : ds.toggle; return drawMods(); }
    if (ds.up || ds.dn) { const [mi, ii] = (ds.up || ds.dn).split(':').map(Number), to = ii + (ds.up ? -1 : 1), arr = draft.modules[mi].items; [arr[ii], arr[to]] = [arr[to], arr[ii]]; open = null; drawMods(); return changed(); }
    if (ds.rm) { const [mi, ii] = ds.rm.split(':').map(Number); draft.modules[mi].items.splice(ii, 1); open = null; drawMods(); return changed(); }
    const key = t.closest('[data-i]')?.dataset.i;
    if (key && crItemClick(itemAt(key), ds)) { drawMods(); return changed(); }
    if (t.id === 'ce-publish') {
      const er = $e('#ce-err'); er.hidden = true; t.disabled = true; await flush();
      const { error: pe } = await sb.rpc('course_publish', { cid }); t.disabled = false;
      if (pe) { er.textContent = pe.message; er.hidden = false; return; }
      try { localStorage.removeItem(lkey); } catch { /* fine */ }
      return crCourse(el, dept, cid, '');
    }
    if (t.id === 'ce-discard') { t.outerHTML = '<span class="bd-confirm">Sure? <button type="button" class="ghost small-btn danger-text" id="ce-discard-yes">Yes</button><button type="button" class="ghost small-btn" id="ce-discard-no">Keep</button></span>'; return; }
    if (t.id === 'ce-discard-no') return crEditor(el, dept, cid);
    if (t.id === 'ce-discard-yes') { clearTimeout(saveT); dirty = false; try { localStorage.removeItem(lkey); } catch { /* fine */ } await sb.rpc('course_discard', { cid }); return d.status === 'published' ? crEditor(el, dept, cid) : crGrid(el, dept); }
    if (t.id === 'ce-archive') { t.outerHTML = '<span class="bd-confirm">Remove the course and its files? <button type="button" class="ghost small-btn danger-text" id="ce-arch-yes">Remove</button><button type="button" class="ghost small-btn" id="ce-arch-no">Keep</button></span>'; return; }
    if (t.id === 'ce-arch-no') return crEditor(el, dept, cid);
    if (t.id === 'ce-arch-yes') {
      const folder = `${crDept(dept).id}/${cid}`;
      const { data: files } = await sb.storage.from('course-files').list(folder, { limit: 1000 });
      if (files && files.length) await sb.storage.from('course-files').remove(files.map((f) => `${folder}/${f.name}`));
      const { error: ae } = await sb.rpc('course_archive', { cid });
      if (ae) { const er = $e('#ce-err'); er.textContent = ae.message; er.hidden = false; return; }
      return crGrid(el, dept);
    }
  };
  fillSide(); drawMods(); showSaved();
  if (dirty) { status('Recovered unsaved changes from this browser. Saving…'); save(); }
}

function crNewItem(kind) {
  const it = { id: crUid('s'), kind, title: '' };
  if (kind === 'lesson') it.body = '';
  if (['slides', 'link', 'video'].includes(kind)) it.url = '';
  if (kind === 'quiz') Object.assign(it, { exam: false, pass_pct: 80, tries: 3, wait_hours: 0, reveal: 'after', results_in: '3 days', questions: [crNewQ('single')] });
  if (kind === 'eval') Object.assign(it, { pass_level: 3, competencies: [{ id: crUid('k'), text: '' }] });
  return it;
}
function crNewQ(type) {
  const q = { id: crUid('q'), type, text: '', points: 1 };
  if (type === 'single' || type === 'multi') { q.options = [{ id: crUid('o'), text: '' }, { id: crUid('o'), text: '' }]; q.key = []; }
  if (type === 'truefalse') { q.options = [{ id: 'true', text: 'True' }, { id: 'false', text: 'False' }]; q.key = ['true']; }
  if (type === 'short') q.accepted = [];
  if (type === 'long') q.model = '';
  return q;
}
const CR_QTYPES = [['single', 'One answer'], ['multi', 'Several answers'], ['truefalse', 'True or false'], ['short', 'Short answer'], ['long', 'Written answer (marked by a person)']];

// The editor for one step (data-f fields are read by crItemInput).
function crItemEditor(it) {
  const f = (name, label, val, extra = '') => `<label class="f"><span>${label}</span><input data-f="${name}" value="${esc(val ?? '')}" ${extra}></label>`;
  let x = f('title', 'Title', it.title, 'maxlength="160"');
  if (it.kind === 'lesson') x += `<label class="f"><span>Lesson <em>(# heading, - list, **bold**, [link](https://…), ![picture](https://…))</em></span><textarea data-f="body" rows="10" maxlength="60000">${esc(it.body || '')}</textarea></label>`;
  if (it.kind === 'slides') x += f('url', 'Google Slides link', it.url, 'placeholder="https://docs.google.com/presentation/d/…" inputmode="url"') + '<p class="app-hint">The deck must be shared as “Anyone with the link can view”. For a private deck, export it to PDF and add it as a File instead.</p>';
  if (it.kind === 'video') x += f('url', 'YouTube link', it.url, 'placeholder="https://www.youtube.com/watch?v=…" inputmode="url"');
  if (it.kind === 'link') x += f('url', 'Link', it.url, 'placeholder="https://…" inputmode="url"') + '<p class="app-hint">Google Docs links show inside the site when shared “Anyone with the link”. Members press I’ve finished.</p>';
  if (it.kind === 'file') x += `<div class="f"><span>File <em>(PDF, PowerPoint .pptx or image, up to 50 MB)</em></span><input type="file" data-upload="1" accept=".pdf,.pptx,image/png,image/jpeg,image/webp,image/gif"><span class="app-hint ce-upnote">${it.path ? 'Uploaded: ' + esc(it.name || it.path.split('/').pop()) : 'PDFs show slide by slide and count when they reach the last page. PowerPoints download (export to PDF to show them in the site).'}</span></div>`;
  if (it.kind === 'eval') {
    x += `<label class="f"><span>Pass level</span><select data-f="pass_level">${CR_LEVELS.map((l, i) => `<option value="${i + 1}"${(it.pass_level || 3) === i + 1 ? ' selected' : ''}>${l} or above</option>`).join('')}</select></label>
      <div class="f"><span>Competencies</span>${(it.competencies || []).map((k, i) => `<div class="ce-row"><input data-f="comp" data-k="${i}" value="${esc(k.text)}" maxlength="200" placeholder="e.g. Records evidence"><button type="button" class="app-x" data-comprm="${i}">Remove</button></div>`).join('')}
      <button type="button" class="ghost small-btn" data-compadd="1">+ Competency</button></div>`;
  }
  if (it.kind === 'quiz') {
    x += `<div class="ce-qset">
      <label class="app-switch"><input type="checkbox" data-f="exam"${it.exam ? ' checked' : ''}> Formal exam</label>
      <label class="f"><span>Exam lock</span><select data-f="lock"><option value="off"${(it.lock || 'off') === 'off' ? ' selected' : ''}>Off</option><option value="phones"${it.lock === 'phones' ? ' selected' : ''}>On: allow phones (stay on this page)</option><option value="fullscreen"${it.lock === 'fullscreen' ? ' selected' : ''}>On: computer only (full screen)</option></select></label>
      <label class="f"><span>Pass mark %</span><input type="number" min="0" max="100" data-f="pass_pct" value="${it.pass_pct ?? 80}"></label>
      <label class="f"><span>Tries</span><input type="number" min="1" max="20" data-f="tries" value="${it.tries ?? 3}"></label>
      <label class="f"><span>Wait between tries (hours)</span><input type="number" min="0" max="720" data-f="wait_hours" value="${it.wait_hours ?? 0}"></label>
      <label class="f"><span>Time limit (minutes, optional)</span><input type="number" min="1" max="600" data-f="time_limit_min" value="${it.time_limit_min ?? ''}"></label>
      <label class="f"><span>Show answers</span><select data-f="reveal"><option value="now"${it.reveal === 'now' ? ' selected' : ''}>Straight after (auto-marked)</option><option value="after"${(it.reveal || 'after') === 'after' ? ' selected' : ''}>Once marked</option><option value="never"${it.reveal === 'never' ? ' selected' : ''}>Never</option></select></label>
      <label class="f"><span>“Results usually within”</span><input data-f="results_in" maxlength="40" value="${esc(it.results_in || '3 days')}"></label></div>
      <p class="app-hint">If any answer needs a person to mark it, the whole result is held until it’s marked. Marking happens under Courses › Marking.</p>
      <p class="app-hint">Exam lock: leaving the exam (full screen, another tab or app, or reloading) gives one 30-second warning; a second time, or 30 seconds away, ends the try. Phones can’t go full screen, so “allow phones” uses stay-on-this-page there.</p>
      <div class="ce-qs">${(it.questions || []).map((q, qi) => crQEditor(q, qi)).join('')}</div>
      <div class="addmenu">${CR_QTYPES.map(([t, l]) => `<button type="button" class="ghost small-btn" data-qadd="${t}">+ ${l}</button>`).join('')}<button type="button" class="ghost small-btn" data-qadd="section">+ Section</button></div>`;
  }
  return x;
}
function crQEditor(q, qi) {
  if (q.type === 'section') return `<div class="ce-q sec" data-q="${qi}"><input data-f="qtext" value="${esc(q.text)}" placeholder="Section title" maxlength="200"><span class="bd-btns"><button type="button" data-qup="${qi}"${qi ? '' : ' disabled'}>↑</button><button type="button" data-qrm="${qi}">×</button></span></div>`;
  const opts = q.options || [];
  return `<div class="ce-q" data-q="${qi}">
    <div class="ce-q-h"><span class="ce-qt">${esc((CR_QTYPES.find(([t]) => t === q.type) || [])[1] || q.type)}</span><label class="ce-pts">Points <input type="number" min="0" max="100" step="0.5" data-f="qpoints" value="${q.points ?? 1}"></label>
      <span class="bd-btns"><button type="button" data-qup="${qi}"${qi ? '' : ' disabled'} aria-label="Move up">↑</button><button type="button" data-qrm="${qi}" aria-label="Remove question">×</button></span></div>
    <textarea data-f="qtext" rows="2" maxlength="2000" placeholder="Question">${esc(q.text)}</textarea>
    ${['single', 'multi', 'truefalse'].includes(q.type) ? `<div class="ce-opts">${opts.map((o, oi) => `<div class="ce-opt"><button type="button" class="ce-right${(q.key || []).includes(o.id) ? ' on' : ''}" data-right="${oi}" data-qi="${qi}" aria-pressed="${(q.key || []).includes(o.id)}" title="Right answer">✓</button>
        ${q.type === 'truefalse' ? `<span>${esc(o.text)}</span>` : `<input data-f="opt" data-o="${oi}" value="${esc(o.text)}" maxlength="500" placeholder="Choice ${oi + 1}"><button type="button" class="app-x" data-optrm="${oi}" data-qi="${qi}">Remove</button>`}</div>`).join('')}
      ${q.type === 'truefalse' ? '' : `<button type="button" class="ghost small-btn" data-optadd="1" data-qi="${qi}">+ Choice</button>`}<span class="app-hint">Tick the right answer${q.type === 'multi' ? 's' : ''} (the answer key).</span></div>` : ''}
    ${q.type === 'short' ? `<label class="f"><span>Accepted answers <em>(comma separated; leave empty for a person to mark)</em></span><input data-f="accepted" value="${esc((q.accepted || []).join(', '))}" maxlength="500"></label>` : ''}
    ${q.type === 'long' ? `<label class="f"><span>Model answer for markers <em>(optional, never shown to candidates)</em></span><textarea data-f="model" rows="2" maxlength="2000">${esc(q.model || '')}</textarea></label>` : ''}
  </div>`;
}
function crItemInput(it, t) {
  const f = t.dataset.f, qi = t.closest('[data-q]') ? +t.closest('[data-q]').dataset.q : null, q = qi != null ? it.questions[qi] : null;
  const num = (v) => (v === '' ? null : +v);
  switch (f) {
    case 'title': case 'body': case 'url': case 'results_in': case 'reveal': it[f] = t.value; break;
    case 'exam': it.exam = t.checked; if (it.exam && (!it.lock || it.lock === 'off')) it.lock = 'phones'; break;
    case 'lock': it.lock = t.value; break;
    case 'pass_pct': case 'tries': case 'wait_hours': case 'time_limit_min': it[f] = num(t.value); break;
    case 'pass_level': it.pass_level = +t.value; break;
    case 'comp': it.competencies[+t.dataset.k].text = t.value; break;
    case 'qtext': q.text = t.value; break;
    case 'qpoints': q.points = num(t.value) ?? 1; break;
    case 'opt': q.options[+t.dataset.o].text = t.value; break;
    case 'accepted': q.accepted = t.value.split(',').map((s) => s.trim()).filter(Boolean); break;
    case 'model': q.model = t.value; break;
    default: break;
  }
}
// Buttons inside a step's editor; true = something changed.
function crItemClick(it, ds) {
  if (ds.compadd) { it.competencies.push({ id: crUid('k'), text: '' }); return true; }
  if (ds.comprm) { it.competencies.splice(+ds.comprm, 1); return true; }
  if (ds.qadd) { it.questions.push(ds.qadd === 'section' ? { id: crUid('q'), type: 'section', text: '' } : crNewQ(ds.qadd)); return true; }
  if (ds.qup) { const i = +ds.qup; [it.questions[i - 1], it.questions[i]] = [it.questions[i], it.questions[i - 1]]; return true; }
  if (ds.qrm) { it.questions.splice(+ds.qrm, 1); return true; }
  if (ds.right || ds.optadd || ds.optrm) {
    const q = it.questions[+ds.qi];
    if (!q) return false;
    if (ds.optadd) { q.options.push({ id: crUid('o'), text: '' }); return true; }
    if (ds.optrm) { const o = q.options.splice(+ds.optrm, 1)[0]; q.key = (q.key || []).filter((k) => k !== o.id); return true; }
    const o = q.options[+ds.right];
    if (q.type === 'multi') q.key = (q.key || []).includes(o.id) ? q.key.filter((k) => k !== o.id) : [...(q.key || []), o.id];
    else q.key = [o.id];
    return true;
  }
  return false;
}

// ---------- My courses (sidebar "My stuff"): its own page, every course I'm on across my departments ----------
// Owner (0.25.0): status, open date, due date and a Continue button for each; due soon first; filter by department.
const crMyDepts = () => DEPARTMENTS.filter((d) => crMember(d.name));
// Shown for anyone in a department, or with an assigned course outside one (my_todo's courses_list, Bravo's desk.js).
function crMyCoursesHref() { return crMyDepts().length || Object.values(window.deskTodo || {}).some((t) => (t.courses_list || []).length) ? '#courses' : null; }
PAGES.push({ id: 'courses', aud: 'everyone', title: 'My Courses', icon: 'graduation-cap', layout: 'mycourses' });

// Where I am on a course: Passed, Waiting for marking, Not passed, In progress, Not started, or locked.
function crMyStatus(c, v) {
  if (c.complete) return { key: 'passed', label: 'Passed', cls: 'done' };
  if (c.lock === 'date') return { key: 'locked', label: `Opens ${crDate(c.opens_at)}`, cls: 'soon' };
  if (c.lock === 'prereq') return { key: 'locked', label: `Finish ${c.prereq || 'another course'} first`, cls: 'soon' };
  const at = (v && v.attempts) || [];
  if (at.some((a) => a.status === 'marking')) return { key: 'marking', label: 'Waiting for marking', cls: 'due' };
  const latest = {};
  at.forEach((a) => { latest[a.item_id] = a; });
  if (Object.values(latest).some((a) => a.status === 'ended' || (a.status === 'marked' && !a.passed))) return { key: 'failed', label: 'Not passed', cls: 'late' };
  if ((c.counts && c.counts.done) || at.length || ((v && v.done) || []).length) return { key: 'progress', label: 'In progress', cls: 'open' };
  return { key: 'new', label: 'Not started', cls: 'soon' };
}

LIVE.mycourses = async (body) => {
  crMine = true;
  const [, sub, step] = location.hash.slice(1).split('/');
  if (/^[0-9a-f-]{36}$/.test(sub || '')) {   // #courses/<cid>[/<step>]: open the course here (DM and To do links)
    body.innerHTML = '<div class="card"><p class="muted small">Loading the course…</p></div>';
    const { data: v } = await sb.rpc('course_view', { cid: sub });
    return crCourse(body, (v && v.department) || '', sub, step || '');
  }
  body.innerHTML = '<div class="card"><p class="muted small">Loading your courses…</p></div>';
  const [lists, assigned] = await Promise.all([Promise.all(crMyDepts().map(async (d) => {
    await crLoadRanks(d.name);
    const list = ((await sb.rpc('course_list', { dept: d.name })).data || []).filter((c) => c.mine);
    list.forEach((c) => { c._d = d; });
    return list;
  })), sb.rpc('course_my_assigned').then((r) => r.data || [], () => [])]);
  const all = lists.flat();
  // Assigned courses in departments I'm not in (the rest already came with their department's list).
  assigned.filter((a) => !all.some((c) => c.id === a.id)).forEach((a) => all.push(Object.assign(a, { _d: crDept(a.department) })));
  // The detail (tries, marking) only for open courses I haven't finished.
  await Promise.all(all.map(async (c) => { if (!c.lock && !c.complete) c._v = (await sb.rpc('course_view', { cid: c.id })).data; }));
  all.forEach((c) => { c._s = crMyStatus(c, c._v); });
  const ds = [...new Map(all.map((c) => [c._d.name, c._d])).values()];
  if (!all.length) { body.innerHTML = '<div class="card ma-empty"><strong>You have no courses yet.</strong><span>When your department gives you a course, it shows here.</span></div>'; return; }
  const now = Date.now(), week = 7 * 864e5;
  const dueSoon = (c) => !c.complete && !c.lock && c.due_at && new Date(c.due_at) - now < week;
  const rank = { progress: 2, marking: 3, failed: 2, new: 2, locked: 5, passed: 6 };
  const asgOpen = (c) => !!c.assigned && !c.complete;
  const order = (c) => (asgOpen(c) ? -1 : dueSoon(c) ? 0 : rank[c._s.key] ?? 4);
  all.sort((a, b) => order(a) - order(b) || (a.due_at ? +new Date(a.due_at) : Infinity) - (b.due_at ? +new Date(b.due_at) : Infinity) || a.title.localeCompare(b.title));
  let dept = 'all';
  function draw() {
    const rows = all.filter((c) => dept === 'all' || c._d.name === dept);
    const groups = [
      ['Assigned to you', rows.filter(asgOpen)],
      ['Due soon', rows.filter((c) => !asgOpen(c) && dueSoon(c))],
      ['To do', rows.filter((c) => !asgOpen(c) && !dueSoon(c) && ['progress', 'new', 'failed', 'marking'].includes(c._s.key))],
      ['Not open yet', rows.filter((c) => !asgOpen(c) && c._s.key === 'locked')],
      ['Finished', rows.filter((c) => c._s.key === 'passed')],
    ].filter(([, r]) => r.length);
    body.innerHTML = `
      ${ds.length > 1 ? `<div class="ma-chips mc-chips" role="group" aria-label="Department">${['all', ...ds.map((d) => d.name)].map((n) =>
        `<button type="button" class="chip${dept === n ? ' on' : ''}" data-mcd="${esc(n)}" aria-pressed="${dept === n}">${n === 'all' ? 'All departments' : esc(n)}<span class="count">${(n === 'all' ? all : all.filter((c) => c._d.name === n)).length}</span></button>`).join('')}</div>` : ''}
      ${groups.map(([label, r]) => `<section class="cr-sec"><h2 class="ma-day">${label} <span class="count">${r.length}</span></h2><div class="card mc-list">${r.map(row).join('')}</div></section>`).join('')}`;
  }
  function row(c) {
    const d = c._d, s = c._s, pct = c.counts && c.counts.total ? Math.round((c.counts.done / c.counts.total) * 100) : 0;
    const due = c.due_at && !c.complete ? new Date(c.due_at) : null, late = due && due < now;
    const href = `#courses/${c.id}`;
    return `<div class="mc-row" style="--c:${esc(c.color || '#2ED3C6')};--dept:${d.color}">
      <span class="mc-bar" aria-hidden="true"></span>
      <div class="mc-main">
        <div class="mc-top"><a class="mc-title" href="${href}">${esc(c.title)}</a><span class="cr-pill ${s.cls}">${esc(s.label)}</span>${c.assigned ? `<span class="cr-pill asg">Assigned by ${esc(cleanName(c.assigned.by || 'your department'))}</span>` : ''}</div>
        <div class="mc-meta"><span class="app-dtag" style="--c:${d.color}">${esc(d.name)}</span>${esc(c.kind || '')}${c.opens_at && !c.lock ? ` · opened ${esc(crDate(c.opens_at))}` : ''}${due ? ` · <span class="${late ? 'danger-text' : ''}">${late ? 'Overdue, was due' : 'Due'} ${esc(crDate(c.due_at))}</span>` : ''}</div>
        ${c.assigned?.note && !c.complete ? `<div class="mc-note">“${esc(c.assigned.note)}”</div>` : ''}
        ${c.lock ? '' : `<div class="mc-prog"><span class="cr-progress"><i style="width:${pct}%"></i></span><span class="muted small">${c.counts?.done || 0} of ${c.counts?.total || 0} ${(c.counts?.total || 0) === 1 ? 'step' : 'steps'}</span></div>`}
      </div>
      <div class="mc-act">${c.lock ? '<span class="muted small">Locked</span>' : `<a class="${s.key === 'passed' ? 'ghost' : 'refresh'} mc-go" href="${href}">${s.key === 'passed' ? 'Review' : s.key === 'new' ? 'Start' : 'Continue'}</a>`}</div>
    </div>`;
  }
  body.onclick = (e) => { const b = e.target.closest('[data-mcd]'); if (b) { dept = b.dataset.mcd; draw(); } };
  draw();
};
