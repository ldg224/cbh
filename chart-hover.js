// CBH Chart: hover cards and the Admins on shift box (Delta, 21 Nov 2026; Supervisor v2 spec §5 and §6,
// Plans/CareBeyond/chart/supervisor-v2.md). Loads right after chart.js, which owns the data and all drag and drop.
//
// Hook (agreed with Alpha): chart.js sets window.CBHChart = { person(sid), admins(), canDrag() }. person() returns
// display-ready fields: name, avatar_url, rank, department, colour, role_name, beds, status, visit, admin_kind,
// shift_started_at. This file adds:
//   CBHChart.renderAdmins()     -> the "Admins on shift" box (HTML), or '' when nobody is on. Alpha puts it under People.
//   CBHHover.reasonLabel(code)  -> 'Patient complaint' etc.
// A card shows for any [data-hsid] or .staff-drop[data-sid]: mouse hover after a short pause (fine pointers only),
// keyboard focus (Tab only, not a click), or a long press on touch screens, which also cancels that tap.
(() => {
  const REASONS = { help: 'Help with patient', complaint: 'Patient complaint', check_staff: 'Check on staff',
    second_opinion: 'Second opinion', medical: 'Medical request' };
  const KIND = { exec: 'Executive', director: 'Director', admin: 'Administration' };
  const DEPT = { Nursing: '#FF3D7E', Paramedicine: '#FF5533', Administration: '#5C72FF', 'Community Engagement': '#FFAA00',
    Medical: '#3A82D0', Surgical: '#16A34A' };
  const h = (s) => (typeof esc === 'function' ? esc(s == null ? '' : String(s))
    : String(s == null ? '' : s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`));
  const nameOf = (s) => (typeof cleanName === 'function' ? cleanName(s || '') : s || '') || 'Someone';
  const pic = (url, px) => (url && typeof sized === 'function' ? sized(url, px) : url);
  const api = () => window.CBHChart || {};
  const who = (sid) => { try { return (api().person && api().person(sid)) || null; } catch { return null; } };
  const colourOf = (p) => p.colour || DEPT[p.department] || '#9aa9c4';

  const reasonLabel = (code, note) => (code === 'custom' ? note || 'Visit' : REASONS[code] || note || 'Visit');
  // A visit in words: "On my way to 102: Patient complaint"
  function visitLine(v) {
    if (!v) return '';
    const room = v.room_name || v.room || '', why = v.reason_words || reasonLabel(v.reason, v.note);
    const lead = v.state === 'arrived' ? 'Visiting' : v.state === 'on_way' ? 'On my way to' : 'Sent to';
    return `${lead} ${room}: ${why}`;
  }
  function onShift(iso) {
    const t = iso ? Date.parse(iso) : NaN; if (!Number.isFinite(t)) return '';
    const m = Math.max(0, Math.floor((Date.now() - t) / 60000));
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
  }
  // A face: the Discord picture when there is one (it falls back to the initial if it fails), else the initial.
  function faceHtml(p, px, cls = '') {
    const n = nameOf(p.name), url = pic(p.avatar_url, px * 2);
    return `<span class="hv-face${cls}" style="--dc:${colourOf(p)};width:${px}px;height:${px}px" aria-hidden="true">`
      + `<i>${h((n.trim()[0] || '?').toUpperCase())}</i>${url ? `<img src="${h(url)}" alt="" loading="lazy" onerror="this.remove()">` : ''}</span>`;
  }

  // ---------- the card ----------
  function cardHtml(p) {
    const sub = [p.rank, p.department].filter(Boolean).join(' · ');
    const role = [p.role_name || (p.admin_kind ? KIND[p.admin_kind] : ''), (p.beds || []).join(', ')].filter(Boolean).join(' · ');
    const v = visitLine(p.visit), t = onShift(p.shift_started_at);
    return `<div class="hv-top">${faceHtml(p, 44)}<div class="hv-id"><b>${h(nameOf(p.name))}${p.you ? ' <em>you</em>' : ''}</b>`
      + `${sub ? `<small>${h(sub)}</small>` : ''}</div></div>`
      + `<dl class="hv-rows">${role ? `<div><dt>Role</dt><dd>${h(role)}</dd></div>` : ''}`
      + `${p.status ? `<div><dt>Now</dt><dd><span class="hv-st">${h(p.status)}</span></dd></div>` : ''}`
      + `${v ? `<div class="hv-vis${p.visit.state === 'arrived' ? ' here' : ''}"><dt>Visit</dt><dd>${h(v)}</dd></div>` : ''}`
      + `${t ? `<div><dt>On shift</dt><dd>${h(t)}</dd></div>` : ''}</dl>`;
  }
  let card = null, anchor = null, timer = 0, press = 0, swallow = false;
  const cardEl = () => {
    if (!card || !card.isConnected) {
      card = document.createElement('div'); card.className = 'hv-card'; card.id = 'cbh-hover-card'; card.setAttribute('role', 'tooltip'); card.hidden = true;
      document.body.appendChild(card);
    }
    return card;
  };
  const sidOf = (el) => el.dataset.hsid || el.dataset.sid || '';
  const target = (n) => (n && n.closest ? n.closest('[data-hsid], .staff-drop[data-sid]') : null);
  // No card while something else is on top: a drag, an open face panel or room settings.
  const busy = () => !!document.querySelector('.chx .popover, .chx .room-pop, .drag-src, .drag-ghost, body.dragging');
  function place() {
    if (!card || !anchor) return;
    const r = anchor.getBoundingClientRect(), w = card.offsetWidth, ht = card.offsetHeight, gap = 8;
    let x = r.left + r.width / 2 - w / 2, y = r.bottom + gap;
    if (anchor.closest('.plan-s, .adm-box')) { x = r.left - w - gap; y = r.top + r.height / 2 - ht / 2; }   // beside the People list, not over it
    else if (y + ht > innerHeight - 8) y = r.top - ht - gap;
    if (y + ht > innerHeight - 8) y = innerHeight - ht - 8;
    x = Math.max(8, Math.min(x, innerWidth - w - 8)); y = Math.max(8, y);
    card.style.left = `${Math.round(x)}px`; card.style.top = `${Math.round(y)}px`;
  }
  function show(el) {
    const p = who(sidOf(el)); if (!p || busy()) return;
    hide(); anchor = el; const c = cardEl();
    c.innerHTML = cardHtml(p); c.style.setProperty('--dc', colourOf(p)); c.hidden = false;
    el.setAttribute('aria-describedby', c.id); place();
  }
  function hide() {
    clearTimeout(timer); timer = 0;
    if (anchor) anchor.removeAttribute('aria-describedby');
    anchor = null; if (card) card.hidden = true;
  }
  const fine = () => matchMedia('(hover: hover) and (pointer: fine)').matches;

  document.addEventListener('mouseover', (e) => {
    if (!fine()) return; const el = target(e.target);
    if (el === anchor || (el && el.contains(e.relatedTarget))) return;
    clearTimeout(timer);
    if (!el) { if (anchor && !anchor.contains(e.target)) hide(); return; }
    timer = setTimeout(() => { if (el.isConnected && el.matches(':hover')) show(el); }, anchor ? 80 : 300);
  });
  document.addEventListener('mouseout', (e) => { if (anchor && !target(e.relatedTarget)) { clearTimeout(timer); timer = setTimeout(hide, 120); } });
  document.addEventListener('focusin', (e) => { const el = target(e.target); if (el && el.matches(':focus-visible')) show(el); else if (anchor) hide(); });
  document.addEventListener('focusout', () => { if (anchor && !anchor.matches(':hover')) hide(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && anchor) hide(); });
  document.addEventListener('scroll', () => { if (anchor) hide(); }, true);
  addEventListener('resize', hide);
  // Mouse down starts a click or a drag: the card goes and stays away until the pointer moves to someone else.
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') { hide(); return; }
    const el = target(e.target); hide(); if (!el) return;
    const x0 = e.clientX, y0 = e.clientY;
    const stop = () => { clearTimeout(press); removeEventListener('pointermove', mv, true); };
    const mv = (m) => { if (Math.hypot(m.clientX - x0, m.clientY - y0) > 8) stop(); };
    addEventListener('pointermove', mv, true);
    addEventListener('pointerup', stop, { once: true, capture: true }); addEventListener('pointercancel', stop, { once: true, capture: true });
    press = setTimeout(() => { stop(); swallow = true; show(el); }, 500);
  }, true);
  // The tap that ends a long press only shows the card (it doesn't open the face panel underneath).
  document.addEventListener('click', (e) => { if (swallow) { swallow = false; e.preventDefault(); e.stopPropagation(); } }, true);
  document.addEventListener('contextmenu', (e) => { if (anchor && target(e.target) === anchor) e.preventDefault(); });
  // A redraw replaces the faces: drop a card whose face is gone, refresh one that is still there.
  document.addEventListener('cbh-chart-poll', () => {
    if (!anchor) return; if (!anchor.isConnected) { hide(); return; }
    const p = who(sidOf(anchor)); if (!p) { hide(); return; } card.innerHTML = cardHtml(p); place();
  });

  // ---------- Admins on shift (§5) ----------
  function renderAdmins() {
    let xs = []; try { xs = (api().admins && api().admins()) || []; } catch { xs = []; }
    if (!xs.length) return '';
    const drag = !!(api().canDrag && api().canDrag());
    const chip = (p) => { const sid = h(p.sid || p.discord_id), v = p.visit;
      const line = v ? visitLine(v) : p.role_name && p.role !== 'off' ? (p.status || p.role_name) : KIND[p.admin_kind] || 'On shift';
      return `<button type="button" class="adm-chip${drag ? ' can-drag' : ''}${v ? (v.state === 'arrived' ? ' vis-here' : ' vis-going') : ''}" data-sid="${sid}" data-hsid="${sid}"`
        + `${drag ? ` data-dragsid="${sid}"` : ''} aria-label="${h(nameOf(p.name))}, ${h(line)}">${faceHtml(p, 28)}`
        + `<span><b>${h(nameOf(p.name))}</b><small>${h(line)}</small></span></button>`; };
    // Folded by default to one slim row (the user, 21 Nov 2026: "a little toggleable box to expand it if we need").
    const stack = xs.slice(0, 3).map((p) => faceHtml(p, 20)).join('') + (xs.length > 3 ? `<span class="adm-more">+${xs.length - 3}</span>` : '');
    return `<section class="adm-box${admOpen ? ' open' : ''}" aria-label="Admins on shift">`
      + `<button type="button" class="adm-tg" aria-expanded="${admOpen}" aria-controls="adm-list">`
      + `<span class="ps-l">Admins on shift <i>${xs.length}</i></span><span class="adm-stack" aria-hidden="true">${stack}</span><span class="adm-chev" aria-hidden="true"></span></button>`
      + `<div class="adm-fold"><div class="adm-list" id="adm-list">${xs.map(chip).join('')}</div></div></section>`;
  }
  // Open or closed is kept per device. The toggle is direct (no redraw); the next redraw draws the same state.
  let admOpen = (() => { try { return localStorage.getItem('cbh-chart-admins-open') === '1'; } catch { return false; } })();
  document.addEventListener('click', (e) => {
    const t = e.target.closest && e.target.closest('.adm-tg'); if (!t) return;
    e.stopPropagation(); admOpen = !admOpen; try { localStorage.setItem('cbh-chart-admins-open', admOpen ? '1' : '0'); } catch { /* fine */ }
    document.querySelectorAll('.chx .adm-box').forEach((b) => { b.classList.toggle('open', admOpen);
      b.querySelector('.adm-tg').setAttribute('aria-expanded', String(admOpen)); });
  });

  window.CBHHover = { reasonLabel, visitLine, hide, REASONS };
  window.CBHChart = Object.assign(window.CBHChart || {}, { renderAdmins });
})();
