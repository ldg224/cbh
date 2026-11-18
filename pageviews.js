// Anonymous page views (migration 0071, owner approved 18 Nov 2026). Counts which page is opened, the hour, phone or desktop.
// No user id, no exact time: the database stores only per-hour counts of route PATTERNS (ids replaced). Debounced, so
// quickly flicking through pages counts the page you land on. Failures are ignored; this must never get in the way.
(function () {
  let timer = null, last = '';
  const device = () => (window.matchMedia('(max-width: 760px)').matches || /iPhone|iPad|Android|Mobi/i.test(navigator.userAgent) ? 'phone' : 'desktop');
  // Same rules as the database's page_view_route(): ids -> :id, the department after "directors" -> :dept, at most 4 parts.
  const pattern = (hash) => {
    const segs = String(hash || '').replace(/^[#/]+/, '').toLowerCase().split('/').slice(0, 4).filter(Boolean);
    const out = segs.map((s, i) => (/^\d+$/.test(s) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s) ? ':id'
      : i === 1 && segs[0] === 'directors' ? ':dept' : /^[a-z0-9_-]{1,30}$/.test(s) ? s : ':x'));
    return out.join('/') || 'home';
  };
  function track(tries = 0) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        if (typeof sb === 'undefined') return;
        if (typeof currentUserId === 'undefined' || !currentUserId) { if (tries < 5) track(tries + 1); return; }   // still signing in
        const r = pattern(location.hash);
        if (r === last) return;   // a redraw of the same page isn't a new view
        last = r;
        sb.rpc('page_view', { route: r, device: device() }).then(() => {}, () => {});
      } catch { /* never break the page */ }
    }, 1500);
  }
  window.addEventListener('hashchange', () => track());
  // Department tabs, Courses and Applications change the address with history.replaceState, which fires no hashchange.
  ['replaceState', 'pushState'].forEach((k) => {
    const orig = history[k];
    if (typeof orig !== 'function') return;
    history[k] = function () { const out = orig.apply(this, arguments); try { track(); } catch { /* never break the page */ } return out; };
  });
  window.addEventListener('load', () => track());   // the first page, once the login check has run
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { last = ''; track(); } });  // coming back counts again
})();
