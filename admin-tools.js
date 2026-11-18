// Hospital tools inside Administration (0.29.0, Bravo; owner approved the merge, 18 Nov 2026).
// The old "Hospital tools" folder is gone. Each tool is a tab on the Administration department page, after a divider,
// shown to anyone holding ITS permission (never "is in Administration"): an Admin Trainee sees none of them, and
// someone given Records in the role editor sees just Records. Owner-only tools stay owner-only (is_exec()).
// Old links (#admin/cases, #exec/roles, …) are redirected by app.js redirectHubLink() to #directors/administration/<tab>.
const ADMIN_DEPT = 'Administration';
const hp = (perm) => !!access.exec || (window.myHperms || []).includes(perm);
// Tickets for Administration: leads_team('Administration') in the database (0065: Director, Leader and Team Member).
const adminTicketLead = () => !!access.exec || (window.myRanks || []).some((r) => r.department === ADMIN_DEPT && ['Director', 'Leader', 'Team Member'].includes(r.rank_label));
const ADMIN_TOOLS = [
  { id: 'cases',    label: 'Mod actions',     icon: 'law',         layout: 'cases',    old: ['#admin/cases'],    can: () => hp('hosp.mod') || hp('hosp.records') },
  { id: 'records',  label: 'Records',         icon: 'user-folder', layout: 'records',  old: ['#admin/records'],  can: () => hp('hosp.records') || hp('hosp.incidents') },
  { id: 'logs',     label: 'Discord logs',    icon: 'history',     layout: 'logs',     old: ['#admin/logs'],     can: () => hp('hosp.logs') },
  { id: 'tickets',  label: 'Tickets',         icon: 'inbox',       layout: 'tickets',  old: ['#admin/tickets'],  can: adminTicketLead },
  { id: 'staff',    label: 'Staff directory', icon: 'people',      layout: 'people',   old: [],                  can: () => !!access.exec || (window.myRanks || []).some((r) => r.department === ADMIN_DEPT) },
  { id: 'activity', label: 'Activity',        icon: 'bar-chart',   layout: 'reports',  old: ['#exec/reports'],   can: () => !!access.exec, owner: true },
  { id: 'settings', label: 'Bot settings',    icon: 'settings',    layout: 'settings', old: ['#exec/settings'],  can: () => !!access.exec, owner: true },
  { id: 'roles',    label: 'Roles',           icon: 'star',        layout: 'roles',    old: ['#exec/roles'],     can: () => !!access.exec, owner: true },
];
const adminHref = (tab) => '#directors/administration/' + tab;
const anyAdminTool = () => ADMIN_TOOLS.some((t) => { try { return t.can(); } catch { return false; } });

for (const t of ADMIN_TOOLS) {
  (window.DEPT_TABS = window.DEPT_TABS || []).push({
    id: t.id, label: t.label, icon: t.icon, tool: true,
    show: (dept) => dept === ADMIN_DEPT && t.can(),
    render: (el) => {
      el.classList.add('dp-toolpane');
      if (LIVE[t.layout]) LIVE[t.layout](el, { id: t.id, title: t.label, icon: t.icon, layout: t.layout });
      else el.innerHTML = `<div class="card"><p class="muted small">${esc(t.label)} isn’t available.</p></div>`;
    },
  });
}

// #admin/<x>[/rest] and #exec/<x>[/rest] → the Administration tab. Returns true if it redirected.
function redirectHubLink() {
  const m = location.hash.match(/^#(admin|exec)\/([a-z]+)(\/.*)?$/);
  if (!m) return false;
  const t = ADMIN_TOOLS.find((x) => x.old.includes(`#${m[1]}/${m[2]}`));
  if (!t) return false;
  location.replace(adminHref(t.id) + (m[3] || ''));
  return true;
}
