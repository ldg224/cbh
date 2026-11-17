# Changelog

Every published version of CBH (the CareBeyond Hospital staff dashboard and the CareBeyond Helper bot, which share one
version number). Newest first. How versions work and how to roll back: `docs/RELEASING.md`.

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
