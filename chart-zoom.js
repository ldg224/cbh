// CBH Chart: zoom and pan on the desktop floor plan (Delta, 21 Nov 2026; the user: "make the map zoomable with
// little icons and a slider, and it's draggable with the mouse drag and click"). Loads after chart.js.
//
// The plan box (.plan .floor-wrap) keeps scrolling natively, so chart.js's own scroll keeping and its "centre the
// Trauma call room" code work unchanged; this file only scales the drawing (CSS zoom on .floor) inside a box of fixed
// height, and adds:
//   - controls in the box's corner: − / slider / + and Fit (the whole plan in view);
//   - Ctrl + wheel (and trackpad pinch) zooms around the pointer; the plain wheel still scrolls;
//   - click and drag on the floor pans (grab cursor). Pointer-downs on faces, patients, beds in use, buttons and
//     anything draggable are left alone, so Alpha's drag and drop and every click keep working.
// The zoom is kept per device and per map (localStorage). Phones keep their own zoom (chart-phone.css / fpz).
// Hook: chart.js calls CBHZoom.attach(wrap) after drawing and before it restores the plan's scroll; a watcher also
// attaches by itself if that call is missing.
(() => {
  const KEY = 'cbh-chart-zoom', MAX = 3, STEP = 1.25;
  const NOPAN = 'button, a, input, select, textarea, label, [contenteditable], [draggable="true"], [data-dragsid], [data-drag], [data-hsid], [data-open], .bed.used, .bed.hb, .staff-drop, .q-chip, .zm-ctl';
  const saved = (() => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } })();
  const keep = () => { try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch { /* private window: fine */ } };
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const phone = () => document.body.classList.contains('phone');
  let cur = null;   // { wrap, floor, box, ctl, map, z, fit }

  const ctlHtml = () => `<div class="zm-ctl" role="group" aria-label="Zoom the floor plan">`
    + `<button type="button" class="zm-b" data-zm="out" aria-label="Zoom out" title="Zoom out"><i class="zm-i out"></i></button>`
    + `<input type="range" class="zm-r" min="0" max="100" step="1" aria-label="Zoom">`
    + `<button type="button" class="zm-b" data-zm="in" aria-label="Zoom in" title="Zoom in"><i class="zm-i in"></i></button>`
    + `<span class="zm-sep" aria-hidden="true"></span>`
    + `<button type="button" class="zm-b" data-zm="fit" aria-label="Fit the whole plan" title="Fit the whole plan"><i class="zm-i fit"></i></button></div>`;

  // The slider is logarithmic between Fit and 3×, so each notch feels the same.
  const toR = (z, s) => Math.round(100 * Math.log(z / s.fit) / Math.log(MAX / s.fit) || 0);
  const fromR = (r, s) => s.fit * Math.pow(MAX / s.fit, r / 100);

  function measure(s) {
    const { wrap, floor } = s;
    floor.style.zoom = ''; wrap.style.height = ''; floor.style.width = ''; floor.style.height = '';
    // Pin the drawing's size in px at 1×: its CSS width is a % of the box, which CSS zoom would cancel out.
    const fw = floor.offsetWidth, fh = floor.offsetHeight; floor.style.width = `${fw}px`; floor.style.height = `${fh}px`;
    const cs = getComputedStyle(wrap), padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight), padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    s.h = wrap.offsetHeight; wrap.style.height = `${s.h}px`;
    s.fit = Math.min(1, (wrap.clientWidth - padX) / fw, (wrap.clientHeight - padY) / fh);
    s.fit = Math.max(0.3, Math.floor(s.fit * 100) / 100);
  }
  function show(s) {
    const r = s.ctl.querySelector('.zm-r'); r.value = toR(s.z, s);
    r.setAttribute('aria-valuetext', `${Math.round(s.z * 100)}%`); s.ctl.querySelector('[data-zm="fit"]').classList.toggle('on', s.z <= s.fit + 0.005);
    s.ctl.querySelector('[data-zm="out"]').disabled = s.z <= s.fit + 0.005; s.ctl.querySelector('[data-zm="in"]').disabled = s.z >= MAX - 0.005;
    s.wrap.classList.toggle('can-pan', s.wrap.scrollWidth > s.wrap.clientWidth + 1 || s.wrap.scrollHeight > s.wrap.clientHeight + 1);
  }
  // Zoom to z keeping the floor point under (cx, cy) (screen coordinates; default the box's centre) where it was.
  function zoomTo(s, z, cx, cy) {
    z = clamp(z, s.fit, MAX); const { wrap, floor } = s, r = wrap.getBoundingClientRect();
    const px = (cx == null ? r.left + wrap.clientWidth / 2 : cx) - r.left, py = (cy == null ? r.top + wrap.clientHeight / 2 : cy) - r.top;
    const fx = (wrap.scrollLeft + px - floor.offsetLeft) / s.z, fy = (wrap.scrollTop + py - floor.offsetTop) / s.z;
    s.z = z; floor.style.zoom = z === 1 ? '' : String(z);
    wrap.scrollLeft = fx * z + floor.offsetLeft - px; wrap.scrollTop = fy * z + floor.offsetTop - py;
    saved[s.map] = Math.round(z * 100) / 100; keep(); show(s);
  }

  function attach(wrap) {
    if (!wrap || wrap.__zm || phone()) return;
    const floor = wrap.querySelector('.floor'); if (!floor) return;
    let box = wrap.parentElement;
    if (!box.classList.contains('zm-box')) { box = document.createElement('div'); box.className = 'zm-box'; wrap.before(box); box.appendChild(wrap); }
    box.insertAdjacentHTML('beforeend', ctlHtml());
    const s = { wrap, floor, box, ctl: box.querySelector('.zm-ctl'), map: wrap.classList.contains('er') ? 'main_er' : 'main', z: 1, fit: 1 };
    wrap.__zm = s; wrap.classList.add('zm'); cur = s;
    measure(s);
    s.z = clamp(saved[s.map] || 1, s.fit, MAX); floor.style.zoom = s.z === 1 ? '' : String(s.z); show(s);

    s.ctl.addEventListener('click', (e) => { const b = e.target.closest('[data-zm]'); if (!b) return;
      const k = b.dataset.zm; zoomTo(s, k === 'fit' ? s.fit : k === 'in' ? s.z * STEP : s.z / STEP); });
    s.ctl.querySelector('.zm-r').addEventListener('input', (e) => zoomTo(s, fromR(+e.target.value, s)));
    wrap.addEventListener('wheel', (e) => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault();
      zoomTo(s, s.z * Math.exp(-clamp(e.deltaY, -60, 60) * 0.004), e.clientX, e.clientY); }, { passive: false });
    wrap.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse' || e.button !== 0 || e.target.closest(NOPAN) || !wrap.classList.contains('can-pan')) return;
      const x0 = e.clientX, y0 = e.clientY, l0 = wrap.scrollLeft, t0 = wrap.scrollTop; let moved = false;
      const mv = (m) => { if (!moved && Math.hypot(m.clientX - x0, m.clientY - y0) < 4) return;
        if (!moved) { moved = true; wrap.classList.add('panning'); try { wrap.setPointerCapture(e.pointerId); } catch { /* fine */ } }
        wrap.scrollLeft = l0 - (m.clientX - x0); wrap.scrollTop = t0 - (m.clientY - y0); };
      const up = () => { wrap.removeEventListener('pointermove', mv); wrap.classList.remove('panning');
        if (moved) wrap.addEventListener('click', (c) => { c.preventDefault(); c.stopPropagation(); }, { capture: true, once: true }); };
      wrap.addEventListener('pointermove', mv); wrap.addEventListener('pointerup', up, { once: true }); wrap.addEventListener('pointercancel', up, { once: true });
    });
  }
  // A window resize changes how much fits: measure again, keep the zoom (raised to Fit if needed).
  let rt = 0;
  addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { const s = cur; if (!s || !s.wrap.isConnected || phone()) return;
    const z = s.z; measure(s); s.z = 1; zoomTo(s, Math.max(z, s.fit)); }, 150); });
  // Fallback if chart.js doesn't call attach: pick up each newly drawn plan.
  new MutationObserver(() => { const w = document.querySelector('.chx .plan .floor-wrap'); if (w && !w.__zm) attach(w); })
    .observe(document.documentElement, { childList: true, subtree: true });

  // Centre an element (a room) in the plan box at the current zoom.
  function centre(el) { const w = el && el.closest('.floor-wrap'); if (!w) return; const a = w.getBoundingClientRect(), b = el.getBoundingClientRect();
    w.scrollLeft += (b.left - a.left) - (w.clientWidth - b.width) / 2; w.scrollTop += (b.top - a.top) - (w.clientHeight - b.height) / 2; }
  window.CBHZoom = { attach, centre, zoom: () => (cur ? cur.z : 1) };
})();
