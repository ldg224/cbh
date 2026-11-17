# CareBeyond Dashboard

Staff dashboard for the CareBeyond - Hospital Discord server, used alongside the CareBeyond Helper bot.

- Live at https://ldg224.github.io/carebeyond-dashboard/ (GitHub Pages, deployed from `main`).
- Plain HTML, CSS and JS. No build step.
- Login is Discord through Supabase Auth (project `ycrwcwfknqikezynzgyv`, Sydney).
- The page talks only to Supabase. The bot reads and writes the same database from the owner's PC, so dashboard actions are carried out by the bot.
- `config.js` holds the project URL and the **publishable** key. Both are public by design: staff-only access is enforced by row level security in the database. Never put a secret or service key in this repo.
