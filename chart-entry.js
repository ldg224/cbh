// CBH Chart entry points OUTSIDE the Chart page (Alpha). Loaded after chart.js. desk.js calls these hooks:
//   window.chartNav(link)    the "CBH Chart" link in the side menu, with a red count of what's waiting on me
//   window.chartLogBtn('ds') the item in the top-right "you" menu while on shift: Open the CBH Chart, or Accept <patient>
//   window.checkinNav(link)  retired: patients check in with no account (#visit), so the staff menu shows nothing
// The Home tile and search come from chart.js's PAGES entry. Everything follows CBHChart.visible() (launch).
// Data: window.CBHChart.summary() (Delta, chart.js) from the Chart's own poll; no second poll here. The menu is only
// redrawn when a count actually changes (the poll runs every few seconds).
(() => {
  // Visible = Delta's CBHChart.visible(): false until the first poll, then owners + Supervise holders before launch and
  // all staff after the DATABASE launch (ops.launched). CBH_CHART_OFF is only the emergency kill now.
  const off = () => !!window.CBH_CHART_OFF || !window.CBHChart || typeof window.CBHChart.summary !== 'function'
    || (typeof window.CBHChart.visible === 'function' && !window.CBHChart.visible());
  const sum = () => { try { return off() ? null : window.CBHChart.summary(); } catch { return null; } };
  const e = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // What's waiting on me: a patient to accept, requests I can take, online check-ins to confirm (desk), and for a
  // Supervisor the people waiting in Up next. A Code Blue anywhere counts too.
  const waiting = (s) => (s ? (s.assigned || []).length + (s.open_requests_for_me || 0) + (s.to_confirm || 0) + (s.role === 'supervisor' ? s.queue || 0 : 0) + (s.codes || 0) : 0);

  window.chartNav = (link) => {
    if (off()) return '';
    const n = waiting(sum());
    return link({ href: '#chart', label: 'CBH Chart', icon: 'stethoscope', n: n || 0 });
  };

  window.chartLogBtn = (where) => {
    if (off() || where !== 'ds') return '';
    const s = sum(), a = s && (s.assigned || [])[0];
    const ico = (n) => `<span style="-webkit-mask:url('assets/icons/${n}.png') center/contain no-repeat;mask:url('assets/icons/${n}.png') center/contain no-repeat;background:currentColor;width:18px;height:18px;display:inline-block" aria-hidden="true"></span>`;
    if (a) return `<button class="dt-mi plain cx-entry hot" type="button" role="menuitem" data-cx-open="${e(a.id)}">${ico('stethoscope')}Accept ${e(a.short_name)}</button>`;
    return `<a class="dt-mi plain cx-entry" role="menuitem" href="#chart">${ico('stethoscope')}Open the CBH Chart</a>`;
  };

  // A patient waiting for me stands out in the menu (one rule, kept with the hook that draws it).
  const st = document.createElement('style');
  st.textContent = '.dt-mi.cx-entry.hot{background:var(--teal-wash);color:var(--teal-ink)}.dt-mi.cx-entry.hot:hover{background:#d4f4f0}';
  document.head.appendChild(st);

  window.checkinNav = () => '';   // patients don't need an account any more: they use #visit

  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-cx-open]'); if (!b) return;
    ev.preventDefault();
    if (window.CBHChart && window.CBHChart.open) window.CBHChart.open(+b.dataset.cxOpen); else location.hash = '#chart';
  });

  // Redraw the menus only when what they show changes.
  let last = '';
  document.addEventListener('cbh-chart-poll', () => {
    const s = sum(), sig = s ? JSON.stringify([waiting(s), (s.assigned || []).map((x) => x.id), s.on_shift]) : off() ? 'off' : '';
    if (sig === last) return;
    last = sig;
    if (typeof window.deskRefresh === 'function') window.deskRefresh();
  });
})();
