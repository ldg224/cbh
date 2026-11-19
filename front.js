// Public front page (0.38.0, Alpha): the logged-out screen. Static content lives in index.html so Google can read it;
// this file only wires the buttons. Loaded after app.js (uses robloxJoinUrl).
(() => {
  const game = document.getElementById('fp-join-game');
  const code = (document.getElementById('fp-code')?.textContent || '').trim();
  if (game && code && typeof robloxJoinUrl === 'function') game.href = robloxJoinUrl(code);
  // "Staff login" brings the login card into view (it sits below the intro on phones) and highlights it.
  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-fp-login]'); if (!a) return;
    e.preventDefault();
    const box = document.getElementById('staff-login'); if (!box) return;
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    box.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'center' });
    box.focus({ preventScroll: true });
    box.classList.remove('fp-flash'); void box.offsetWidth; box.classList.add('fp-flash');
  });
})();
