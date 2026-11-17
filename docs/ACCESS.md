# Who sees what

The rules for what each person can see and do on the CBH dashboard. **The database is the source of truth:** row level
security and the `security definer` functions in `supabase/migrations/` decide what anyone can read or write. The
website (`app.js`, `home.js`) only hides what the database would refuse anyway, using `my_access()`.

## Audiences

Worked out from Discord roles (the bot's `cbh/roles.py` gives each role a kind). The SQL helpers live in migrations
0004, 0005 and 0011.

| Audience | Who | SQL |
|---|---|---|
| Member | anyone in the CareBeyond - Hospital server | `is_member()` |
| Staff ("team") | anyone with a department or rank role, or an exec | `is_team()` |
| Lead of a team | that department's Director, Leader, Year 5 or Year 4 (execs: every team) | `leads_team(dept)` |
| Director of a department | that department's Director rank (execs: all four) | `directs_dept(dept)` |
| Admin | exec, or anyone in Administration | `is_admin()` |
| Exec | Hospital Director, COO, Board of Directors or Executive | `is_exec()` |

`my_access()` returns all of these for the logged-in person in one call (plus `teams`, `leads`, `directs`,
`shift_teams`, `run_sessions`). The website must use it rather than working access out itself.

## Kept to the person's own department(s)

Staff only see these for their own departments (execs see all):

- shifts (their department's shifts; their own always)
- Directors hub department pages, `dept_roster()`, rank changes (`role_changes`, `dept_set_rank/add/remove`)
- tickets and ticket messages (teams they lead; the person who opened a ticket always sees their own)
- applications to review (forms whose `review_team` they lead)
- starting a shift (`shift_start`: only in their own departments)

## Hospital-wide for all staff (owner decision, 17 Nov 2026: do not "fix")

A visibility audit (`docs/visibility-audit.json`, local only) found that staff can see people in **other**
departments in three places. The owner reviewed this and **chose to keep them hospital-wide for all staff**:

1. **Staff & roster** (`roster()`): everyone in a department, with name, photo and role IDs.
2. **On shift now** on the home page (`home_counts().on_shift`, `dept_members`, `dept_on_now`) and the roster's on-shift
   dots (`on_shift_now()`, migration 0018): who's on shift in every department, and member counts per department.
3. **People search** (`people_search()`): finds anyone in the server.

Conditions that must stay true:

- **Non-staff members see none of it.** All three return nothing (empty or null) unless `is_team()`.
- **People search never exposes Records data.** It returns only: Discord ID, display name, username, photo, a role
  summary (e.g. "Nursing Year 2"), and whether they're on shift. Warning counts are filled in for admins only (null
  for everyone else). The person's record (`member_record()`: cases, message history, stats) is admin-only and is
  refused for everyone else. Don't add fields to `people_search()` that come from `mod_cases`, `discord_messages`,
  `discord_logs` or `member_record()` unless they are admin-gated the same way `warnings` is.

## Admin and exec only

- Admin: mod cases and Mod actions, Discord logs, message history (`discord_messages`), Records
  (`member_record()`, `mod_member_search()`), all-team ticket counts on the Admin side.
- Exec: hours report (`shift_report()`), bot settings (`set_setting()`), removing warnings (`revoke_warning()`),
  making someone a Director and changing Directors or execs.
- Sessions can be run by admins, Directors and execs (`can_run_sessions()`).

## Never readable directly

`login_codes` and `user_prefs` have no access for logged-in users; they're only used through their functions or
the `login-code` Edge Function.

## Checking it

Test access with real queries as a real member inside a transaction that is rolled back (temporary auth user,
`request.jwt.claims`, `set local role authenticated`). Never delete a real person's login account while testing.
