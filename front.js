// Public front page (0.38.0, Alpha): the logged-out screen. Static content lives in index.html so Google can read it;
// this file only wires the buttons. Loaded after app.js (uses robloxJoinUrl).
(() => {
  // The join code is one constant in config.js (publicJoinCode). No code set: hide the server card.
  const code = String(window.CBH_CONFIG?.publicJoinCode || '').trim();
  const card = document.getElementById('fp-join'), game = document.getElementById('fp-join-game'), slot = document.getElementById('fp-code');
  if (!code) { if (card) card.hidden = true; }
  else {
    if (slot) slot.textContent = code;
    if (game && typeof robloxJoinUrl === 'function') game.href = robloxJoinUrl(code);
  }
  // "Log in" brings the login card into view (it sits below the intro on phones) and highlights it.
  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-fp-login]'); if (!a) return;
    e.preventDefault();
    const box = document.getElementById('log-in'); if (!box) return;
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    box.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'center' });
    box.focus({ preventScroll: true });
    box.classList.remove('fp-flash'); void box.offsetWidth; box.classList.add('fp-flash');
  });
})();
