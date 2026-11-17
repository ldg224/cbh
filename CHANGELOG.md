# Changelog

Every published version of CBH (the CareBeyond Hospital staff dashboard and the CareBeyond Helper bot, which share one
version number). Newest first. How versions work and how to roll back: `docs/RELEASING.md`.

## 0.8.0 (2026-11-17)

**Added:** **run sessions from the website.** Admins see **Start session now** and **Schedule a session** under the session banner on the home page (date and time in Sydney time, optional note), a list of upcoming sessions with **Start now** and **Cancel**, and **End session** while one is live. CareBeyond Helper posts the announcement in #server-starts with the Session Ping when a session goes live, and changes it to "Session Ended" when it ends.

**Changed:**
- Pages that aren't built yet (Strikes, Announcements, Bot settings, Rules & info) now carry a **Being built** tag and say so on the page, instead of a shimmer that looked like it was stuck loading.
- The `/session` commands are gone: sessions are run from the website. `/joincode` stays.

Bot (by Bravo): a watcher does the Discord side of website sessions within about 10 seconds.
Database change: yes, migration 0007 (admins can start, schedule, end and cancel sessions; one live session at a time).

## 0.7.1 (2026-11-17)

**Fixed:** who can review applications now comes from the forms themselves. If a form is added for another team (e.g. Nursing), that team's leads can review it automatically.
Database change: none.

## 0.7.0 (2026-11-17)

**Added:**
- **Apply:** apply for the Administration or Community Engagement team on the website (and admins can file an **Incident Report**). See the status of what you've sent; you also get a DM when it's reviewed.
- **Applications** for execs and the leads of those teams: read each application, then **Accept** or **Deny** with an optional note (reports are marked **Reviewed**). Also posted to #form-submissions with buttons.
- **Shifts:** whether you're on shift, your hours this week, who's on now (and on a break), and your recent shifts. Shifts are started and ended in Discord with `/shift start | break | end | status`.
- **Reports** (Executive hub): hours this week, last week or the last 30 days, by department and by person.
- **Staff & roster:** everyone in a department or leadership, grouped by department with photos and badges, filterable.

**Changed:** Commands lists the `/shift` commands. The form questions are placeholders until the real ones are added.
Bot (by Bravo): forms and shifts cogs (auto-ending forgotten shifts), application posts with Accept/Deny buttons.
Database change: yes, migration 0006 (forms, form submissions, shifts, shift report, roster).

## 0.6.0 (2026-11-17)

**Added:**
- **Session banner** under the Welcome card shows **Session live now** (who's hosting and since when) or the **next scheduled session**, with the join code and a Copy button. Admins run sessions with `/session start | end | schedule | cancel`; execs change the code with `/joincode`.
- **Admin hub → Mod reports:** every warn, timeout, kick and ban in one list, filterable by type. **New report** logs something done in game (e.g. "I banned X in Maple Hospital").
- **Admin hub → Discord logs:** deleted and edited messages, joins and leaves (new accounts flagged), role and nickname changes, bans and timeouts, filterable and kept for 90 days.
- **Contact a team:** pick Administration (support), Nursing, Paramedicine or Community Engagement (partnerships), write a message and follow the conversation on the site. Replies also reach you by DM. Also works in Discord with `/contact`.
- **Tickets** for team leads (in the Admin hub for admins; a **Team tickets** tile for other leads): reply, claim and close.
- **Commands** lists every bot command, grouped by who can use it.

**Changed:** who sees which pages now comes from the same access rules the database uses.
Bot (by Bravo): `/session`, `/joincode`, `/warn`, `/timeout`, `/untimeout`, `/kick`, `/ban`, `/unban`, `/cases`, `/contact`, and Discord logging.
Database change: yes, migrations 0004 (access helpers, sessions, settings, mod cases, Discord logs) and 0005 (tickets).

## 0.5.0 (2026-11-17)

**Added:**
- A home menu under the Welcome card, grouped by who it's for, most important first: **Executive**, **Admin**, **Staff**, **Everyone**. Each group has its own colour, and you only see what you can use.
- **Executive hub** (Reports, Strikes, Announcements, Bot settings) and **Admin hub** (Mod reports, Discord logs, Tickets, plus Applications for executives).
- Staff: **Shifts** and **Staff & roster**. Everyone: **Rules & info**, **Contact a team**, **Apply** and **Commands**.
- A **Maple Hospital server** banner with the join code and a Copy button.

Most pages are layouts for now and fill in as each feature is built. Commands already lists `/login`.
Database change: none.

## 0.4.1 (2026-11-17)

**Fixed:** adding the dashboard to an iPhone home screen now shows the CareBeyond icon on the brand blue, named "CareBeyond", instead of a blank grey "C". Android's "Add to Home screen" gets the same icon. If you added it before, remove it from your home screen and add it again to get the new icon.
Database change: none.

## 0.4.0 (2026-11-17)

**Added:** **Log in with a code**, handy on a phone or a computer where you're not signed in to Discord in the browser. Press "Log in with a code" under "Log in with Discord", then type the command it shows (e.g. `/login K7P-4QX`) in the CareBeyond - Hospital server. CareBeyond Helper asks you to confirm, and the website logs you in by itself. Codes last 5 minutes and work once. There's a Copy button for the command, and "Get a new code" if one runs out.

Behind it: the bot's new `/login` command, the `login-code` function and database migration 0003 (built by Bravo).
Database change: yes, a new `login_codes` table (migration 0003).

## 0.3.0 (2026-11-17)

**Added:**
- Your Discord profile photo on the Welcome card (on the right on computers, beside your name on phones) and in the header, with the CareBeyond teal ring and glow.
- The Welcome card is always the same size. Badges show on one line, most important first (leadership title, then department and year, then Executive, then Verified). Any that don't fit go behind a **+N** button that opens them in a small pop-up. It closes when you tap or click outside it, or press Esc.

**Changed:** the "Staff dashboard" label is gone from the header and the login screen, which now says "Welcome to CareBeyond".
Database change: none.

## 0.2.2 (2026-11-17)

**Changed:**
- The "CareBeyond Hospital" wordmark in the header is now real text in Montserrat, so it's sharp and easy to read on big screens and phones (it was a small picture before).
- Every badge has a bold icon in its role colour: a crown for Hospital Director, a briefcase for COO, a group for the Board, a star for Executive, a clipboard, handshake, nurse or ambulance for each department, a seal for Verified and a person for Member.
- Names are shown without emoji, which clashed with the CareBeyond look (badges already say who you are).
- Phones and big screens each get their own spacing and sizes. A department and its year always stay together on one line.

**Added:** "Icons by Icons8" credit in the footer.
Database change: none.

## 0.2.1 (2026-11-17)

**Removed:** the "Your server roles" list. Your badges already show who you are.
**Changed:** the "Things have changed" bar now only appears when your name or badges change.
Database change: none.

## 0.2.0 (2026-11-17)

**Added:** badges under your name that show who you are, each in its role's colour:
- leadership titles such as **Hospital Director**, in their Discord colours
- **Executive**
- your **department** (e.g. **Nursing Department**, in Nursing's colour) with your **year or rank** joined on in that rank's own colour (e.g. **Year 5**, **Leader**, **Director**)
- **Verified**, with a tick

Someone with none of these gets a **Member** badge.

**Changed:** the **Staff** badge is replaced by these badges.

Bot: CareBeyond Helper now knows what every server role means (leadership, department, rank and year, status, pings, office keys) and saves that with each role, ready for future pages.
Database change: new columns on `roles` (kind, department, rank label and order, badge colour).

## 0.1.1 (2026-11-17)

**Removed:** the "Loaded … You'll see a Refresh button here if anything changes" line under your roles. Notes there now only appear while loading, when something goes wrong, or when you have no roles.
Database change: none.

## 0.1.0 (2026-11-17)

The first version of the rebuilt CareBeyond Hospital tools.

**Added:**
- The staff dashboard at https://ldg224.github.io/cbh/, in the CareBeyond Hospital brand: the logo and icon, a light page in whites, blues and teal, and Montserrat (the logo's font) throughout.
- Log in with your Discord account.
- After logging in, you see your server roles in their Discord colours, highest first, with a **Staff** or **Member** badge next to your name.
- The page never changes by itself. If something changes (your roles, name or staff status), a "Things have changed" bar appears with a **Refresh** button.
- Bot: CareBeyond Helper copies everyone's server roles to the dashboard when it starts, every 30 minutes, and within seconds of any role change.

**Removed:** the old bot's `/shift` and `/session` commands, ahead of rebuilding the bot from the ground up.

Database change: new `roles` and `members` tables (each person can only read their own row).
