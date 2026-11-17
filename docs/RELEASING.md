# Versions and releases

Every change that goes live is a numbered version, so we always know what's running and can go back to any earlier
one quickly. The dashboard (this repo) and the CareBeyond Helper bot (`C:\CareBeyondBot`, local only) share **one**
version number.

## Version numbers: MAJOR.MINOR.PATCH

| Bump | When | Example |
|---|---|---|
| **Patch** 0.1.**1** | Fixes and small tweaks: wording, spacing, a bug. Nothing new for people to use. | 0.1.0 → 0.1.1 fixed a badge colour |
| **Minor** 0.**2**.0 | Something new: a page, a feature, a bot command, a new kind of data. | 0.1.0 → 0.2.0 added tickets |
| **Major** **1**.0.0 | 1.0.0 = the rebuilt bot and dashboard fully replace the old bots (Dyno, Tickets and the rest). After that, only for changes that break old data or links. | |

While we're on 0.x, minor versions can change things freely.

## Releasing a version

1. Pull first (`git pull --rebase`); the owner sometimes edits on github.com.
2. Pick the number (table above).
3. Set it in **both** places:
   - `version.js` here (`window.CBH_VERSION`), which the dashboard shows in the footer;
   - `C:\CareBeyondBot\cbh\version.py` (`VERSION`), which the bot logs when it starts.
4. Add it to the top of **`CHANGELOG.md`**: number, date, and what changed under Added / Changed / Fixed / Removed, in
   plain words, covering both the dashboard and the bot. Say whether there is a database change.
   (The bot's `CHANGES.md` stays the detailed internal log; add to it as usual.)
5. Commit with the version in the message, e.g. `0.2.1: fix the badge colour`, in both repos, and push this one.
6. Tag both repos and publish the release here:
   ```powershell
   git tag -a v0.2.1 -m "0.2.1"; git push origin v0.2.1            # this repo
   gh release create v0.2.1 --title "0.2.1" --notes "<that version's changelog section>"
   git -C C:\CareBeyondBot tag -a v0.2.1 -m "0.2.1"                  # bot (no remote)
   ```
7. If the bot changed, restart it (`tools\restart.ps1`) and check `bot.log` shows the new version.
8. Check the live site once Pages has rebuilt (about 30 s): the footer shows the new number. If
   `gh api repos/ldg224/cbh/pages/builds/latest` still shows the previous commit after a couple of minutes, start the
   build yourself: `gh api -X POST repos/ldg224/cbh/pages/builds`.

One version per release. Several commits can go into one version; tag the last one.

## Something broke: going back

Find the last good version in `CHANGELOG.md` or with `git tag`.

- **Undo one version** (the usual fix): revert its commits (`git revert <commits>`), so history stays intact, then
  release that as a new patch version.
- **Look at an old version:** `git checkout v0.1.0` (then `git checkout main` to come back).
- Database changes (`supabase/migrations/`) are not undone by a revert. Migrations are kept additive so older
  versions keep working.
