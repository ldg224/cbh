# Changelog

Every published version of CBH (the CareBeyond Hospital staff dashboard and the CareBeyond Helper bot, which share one
version number). Newest first. How versions work and how to roll back: `docs/RELEASING.md`.

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
