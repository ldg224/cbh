// Public front page (0.38.0, Alpha): the logged-out screen. Static content lives in index.html so Google can read it;
// this file only wires the buttons. Loaded after app.js (uses robloxJoinUrl and the login buttons app.js wires up).
(() => {
  const $ = (id) => document.getElementById(id);
  // The join code is one constant in config.js (publicJoinCode). No code set: hide the server card.
  const code = String(window.CBH_CONFIG?.publicJoinCode || '').trim();
  const card = $('fp-join'), game = $('fp-join-game'), slot = $('fp-code');
  if (!code) { if (card) card.hidden = true; }
  else {
    if (slot) slot.textContent = code;
    if (game && typeof robloxJoinUrl === 'function') game.href = robloxJoinUrl(code);
  }
  // "Check in online" is launching soon: the big button opens a short note (Discord to hear first, walk in meanwhile).
  const ci = $('fp-checkin'), note = $('fp-soon-note');
  ci?.addEventListener('click', () => {
    if (!note) return;
    note.hidden = !note.hidden;
    ci.setAttribute('aria-expanded', String(!note.hidden));
  });

  // Members (0.38.1): "Log in with Discord" in the hero goes straight to Discord. When this device remembers the
  // last account, it becomes "Continue as <name>" (app.js's own login-again button decides, so the logic stays there).
  const again = $('login-again'), go = $('fp-member-go');
  const mirror = () => {
    if (!go || !again) return;
    const on = !again.hidden, img = $('login-again-img'), mimg = $('fp-member-img');
    $('fp-member-label').textContent = on ? `Continue as ${$('login-again-name').textContent}` : 'Log in with Discord';
    mimg.hidden = !(on && img && !img.hidden && img.src);
    if (!mimg.hidden) mimg.src = img.src;
  };
  if (again) { mirror(); new MutationObserver(mirror).observe(again, { attributes: true, attributeFilter: ['hidden'], subtree: false }); }
  go?.addEventListener('click', () => ((again && !again.hidden) ? again : $('login'))?.click());

  // The login card opens in place, in a dialog (top-bar "Log in", "Use a login code"). The card itself is moved into
  // the dialog while it's open and back afterwards, so app.js keeps its ids and handlers.
  const dlg = $('fp-login-dlg'), box = $('log-in');
  const home = box && { parent: box.parentNode, next: box.nextSibling };
  const openLogin = (withCode) => {
    if (!dlg || !box) return;
    if (typeof dlg.showModal !== 'function') { box.scrollIntoView({ block: 'center' }); return; }   // very old browsers
    $('fp-dlg-slot').appendChild(box);
    if (!dlg.open) dlg.showModal();
    if (withCode && $('login-code')?.hidden) $('code-login')?.click();
  };
  dlg?.addEventListener('close', () => {
    if ($('login-code') && !$('login-code').hidden) $('code-back')?.click();   // stop the code login's polling
    if (home) home.parent.insertBefore(box, home.next);
  });
  dlg?.addEventListener('click', (e) => { if (e.target === dlg || e.target.closest('[data-fp-close]')) dlg.close(); });
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-fp-dialog]')) { e.preventDefault(); openLogin(false); return; }
    if (e.target.closest('[data-fp-code]')) { e.preventDefault(); openLogin(true); }
  });
})();
