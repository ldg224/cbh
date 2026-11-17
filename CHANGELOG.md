# Changelog

Every published version of CBH (the CareBeyond Hospital staff dashboard and the CareBeyond Helper bot, which share one
version number). Newest first. How versions work and how to roll back: `docs/RELEASING.md`.

## 0.21.0 (2026-11-18)

**Added:**
- **CareBeyond Desk**, a new layout. One sidebar with search, **Home**, **My stuff** (My shift, Sessions, My courses, Contact a team, Apply, Staff directory), **Departments** as coloured folders that open into their pages, **Hospital tools** and **Help**. The live session card with the join code and **Copy**, and **Clock in**, **Clock out** and **Log out** by your name. On phones: a drawer, a top bar and bottom tabs.
- **New Home:** greeting and search, the session and shift bar, **Needs you**, **Departments** (one row each, opening the full department page) and your pins.
- **To do:** red badges on your departments, and **Needs you** lists what's waiting on you there: applications to review, meetings needing attendance, members inactive for 14 days, and rank changes that didn't go through. Each has a button that goes straight to it, and only what you're allowed to act on is shown.

Bot: no change.
Database change: yes, migration 0045 (the To do summary; already applied).

## 0.20.0 (2026-11-18)

**Added:**
- **Applications** now live inside each department page, in an **Applications** tab with **To review**, **Forms** and **Decided**.
- Departments can have **several applications**, under groups they name (e.g. General, Promotions).
- A **form builder**: questions in titled sections, reorder by dragging, question types, required, choices and **Preview**. Changes save as a draft while you type and only go live when you press **Publish**.
- Each application chooses **who can see and apply**: everyone not in the department yet, or chosen ranks (e.g. **Become a Leader** for Trainees and Team Members).
- Each application has its own stages, the rank and extra roles given on accept (Leader allowed, never Director), and its reapply wait.
- Executives and Directors can **limit who reviews** an application (e.g. Board of Directors only), **require several approvals**, and have an executive give the final Accept. Pressing **Accept** counts as your approval.

**Changed:**
- **Apply** groups applications by department and only shows the ones open to you.
- Old Applications links, home tiles and older Discord posts open the department's Applications tab.
- Setting or changing the rank an application gives needs the right to give that rank; the form shows who set it.
- **Administration Trainees** no longer count as admins (no Records, Mod actions, Discord logs, messages or incidents).

**Fixed:**
- **Records:** Warn, Time out, Kick and Ban on a record now show the person's history and the "check a ban is the right step" warning, and the record page no longer scrolls sideways on phones.
- Applications can only be decided through the proper checks, applicants can't fill in review fields, session co-hosts can't take over a session, rank change windows can't reach the rank itself or above, and other security fixes from testing (already live).

**Bot:**
- Application posts link straight to the application in its department page.
- Administration Trainees can't use the moderation commands.

Database change: yes, migrations 0032 to 0044 (applications v2, reviewers and approvals, security fixes, Trainee access; already applied) and 0034 (drafts hidden; applied with this release).

## 0.19.2 (2026-11-18)

**Added:**
- **Rank permissions:** a new **See history** permission. A department's **History** (rank changes and their reasons) now needs it; **See this page** covers Overview and Members only. It starts ticked only for ranks that can already edit members.

**Changed:**
- **Rank permissions:** shorter names (See this page, See activity, Edit members, See history, Run meetings, Attendance, Review applications, Edit applications, Edit courses) with short hints.
- Having **any** permission in a department opens its page, but you only see the tabs your permissions allow.

**Bot:**
- An accepted application may now give a **Leader** rank (never Director), for promotion applications.

Database change: yes, migration 0033 (See history; already applied).

## 0.19.1 (2026-11-18)

**Changed:**
- **Rank permissions** for a department can now only be read by executives, that department's Director and its own members (before, any signed-in member could see every department's).

**Bot:**
- **Privileged role watch:** when someone is given a Director, Leader, leadership, office or Executive role in Discord instead of through the website, the bot posts a red alert in **#server-logs** (who, which role and who gave it) and keeps a record that only executives can see. It also checks after every restart for roles given while it was offline. Nothing is blocked or undone.

Database change: yes, migration 0031 (rank permissions read limited to the department; the privileged role record).

## 0.19.0 (2026-11-18)

**Added:**
- **Apply:** one application for each department (Administration, Nursing, Paramedicine, Community Engagement), each open or closed. Nursing and Paramedicine start closed with placeholder questions until an executive edits and opens them.
- **Apply:** see your application's stage as it moves, withdraw it, and read the decision message. One waiting application per department, and a wait before reapplying after **Not accepted**.
- **Applications:** waiting applications grouped by stage, with the applicant's account age, time in the server and past applications; private team notes with thumbs up or down; move between stages; **Accept** or **Not accept** with a message sent in their DM.
- **Applications:** accepting gives the department's chosen roles automatically (starting rank plus any extra roles; never leadership or executive roles).
- **Applications:** each department sets its own review stages, roles on accept and reapply wait; executives edit the questions and open or close each form.
- **Rank permissions:** a **Ranks & permissions** tab on each Department page, where the Director (or an executive) chooses what each rank can see and do: view the department, see activity, change members, manage meetings, take attendance, review applications and change application settings.
- **Rank permissions:** **Change members** has a window for each rank (e.g. Year 3 can manage Year 1 to Year 2), checked by the database too. The Department page and Applications show only what your rank is allowed to do.

**Changed:**
- The **Incident Report** form is no longer on Apply (Records has Incidents).
- The **#form-submissions** post has a **Review on the website** button instead of Accept/Deny; old posts' buttons point to the website.

**Bot:**
- Gives the roles chosen on an accepted application, checking each one itself first (never leadership, executive, office, moderator or admin roles, or roles above the bot's own).
- Sends the result DM (**Accepted** or **Not accepted**, with the reviewer's message) and keeps the #form-submissions post up to date as the application moves.

Database change: yes, migrations 0027 (rank permissions), 0028 (applications), 0029 (department checks use rank permissions, change windows) and 0030 (keeping Discord posts in step).

## 0.18.0 (2026-11-18)

**Added:**
- **Meetings** on each Department page (a new **Meetings** tab).
  - Directors and executives schedule, edit, start, end and cancel department meetings, with a title, time, length, agenda and a **ping** switch.
  - **Where:** pick one of the server's voice channels (grouped by category) or type somewhere else. If the channel is deleted, the meeting is flagged until another is picked.
  - **Reschedule or move** with one button; the meeting shows where and when it moved from.
  - **Attendance:** Present, Late or Absent for the department's members, plus **guests** from other departments (guests don't count toward their own department's activity). **Meeting notes** too.
  - The **Overview** shows the next meeting, and attending a meeting (Present or Late) counts as active for the Inactive flag.

**Changed:**
- The **Administration** and **Community Engagement** "Member" rank now shows as **Team Member**.

**Bot:**
- Each department's meetings are posted in its own channel, and the post updates when the meeting is edited, moved, cancelled, started or ended (a moved meeting says **Moved** and where and when it moved from). The channel is a link people can click to join.
- A reminder 15 minutes before pings the department's role (only if ping is on), and a **Meeting Starting** message when it starts. Never @everyone, never posted twice.
- The bot keeps the list of voice channels for the website's picker up to date.

Database change: yes, migrations 0025 (meetings and attendance) and 0026 (voice channels, moving meetings, guests).

## 0.17.1 (2026-11-18)

**Changed:**
- **Reports** is now called **Activity**.

**Added:**
- **Activity:** pick **This week**, **Last week** or **Last 30 days**, with each number compared to the period before.
- **Activity:** hours on shift (breaks not counted), shifts, sessions run and mod actions, as headline numbers and for each department.
- **Activity:** a staff list with each person's hours, shifts, sessions hosted and mod actions, sorted by any of them; tap a department to see only its staff.
- **Activity:** a **No shifts** list of staff who haven't done a shift in the period.

Bot: no change.
Database change: yes, migration 0024 (the Activity report, executives only).

## 0.17.0 (2026-11-18)

**Added:**
- **Department pages** (Administration, Community Engagement, Nursing, Paramedicine) are redesigned.
  - A new banner and tabs: **Overview**, **Members** and **History** (**Courses** and **Meetings** are coming).
  - The member list has search, filters, each person's hours over the last 4 weeks and a flag for inactive members.
  - Every year or rank change, add and removal can take an optional **reason**, shown in History.

Bot: no change.
Database change: yes, migration 0023 (reasons on rank changes, weekly hours per department).

## 0.16.2 (2026-11-18)

**Changed:**
- **Discord logs** is now one plain, full list with a compact line per entry (time, what happened, who, channel, and the message text or before and after), newest first.
- **Discord logs:** a small **Find** bar searches names, channels and message text, including edits.

**Removed:**
- **Discord logs:** photos, day headings, merged rows, filter chips and the new-entries bar.

Bot: no change. Database change: no.

## 0.16.1 (2026-11-18)

**Added:**
- **Discord logs:** search by name, channel, message text or Discord ID.
- **Discord logs:** each person's photo, and clicking a name opens their record.
- **Discord logs:** when there are new entries, a **new entries** bar appears that you press to show them.
- **Discord logs:** deleted messages show their text from message history when the bot missed it.

**Changed:**
- **Discord logs:** entries are grouped by day, and one person's role or nickname changes close together share one row.
- **Discord logs:** each changed role is a chip in its Discord colour, and edited messages show their before and after text with an **Open in Discord** link.
- **Discord logs:** filters only appear for kinds of entries that exist, each with a count; the line explaining gaps in the log is gone.

Bot: no change. Database change: no.

## 0.16.0 (2026-11-17)

**Added:**
- **Sessions** is redesigned.
  - A **live panel** for the running session, a **7-day calendar** and an **Upcoming** list with **Edit**, **Start** and **Cancel**.
  - One form to start, schedule or edit a session: type, department, date and time, **location** (Discord only, or an in-game place), **lead host and co-hosts**, a note, the Discord message and a **ping** switch.
  - Ended and cancelled sessions can no longer be edited.
- **Past sessions** on the Sessions page: every ended session grouped by week (with the week's total), showing the date and time, a coloured type tag, where it ran, every host with the lead first, how long it ran (breaks not counted), how many staff were on shift (with photos and hours) and the note. **Show more** loads older ones.
- **Records** is redesigned.
  - **Start screen:** a big search, **Recently opened** (on this device), **Recently actioned** (last 7 days) and **Most warnings**.
  - **A person's record:** their photo, badges and five numbers (Warnings, Actions, Incidents, Messages over 90 days, Shift hours over 30 days) beside one **Timeline** of warnings, mod actions (with supervisor review results) and incidents, grouped by day with filters, plus a **Messages** tab.
  - **Quick actions:** **Warn**, **Time out**, **Kick** and **Ban** open the New action panel already filled in with that person (and **Unban** if they're banned).
- **Incidents:** write up an incident against someone, with a title, what happened, when, and up to 10 evidence links (web links only). The writer or an executive can edit or remove it; removed incidents disappear from the record but executives can still see them.
- **Photos** in Mod actions and Records: everyone's Discord photo (initials when there isn't one), the photo of whoever took each action, and the Roblox character for in-game records.

**Changed:**
- The shift buttons in the home page's **Session and shift** bar now match the Shifts page: department chips instead of a dropdown, and buttons that show they're working.
- **Staff & roster** makes it clear which role belongs to the section someone is listed under: their rank in that section is a solid chip in the section's colour, and their roles in other departments are small grey chips (e.g. "Nursing · Year 1").

**Bot:**
- Scheduled sessions get a post in Discord that updates when the session is edited or cancelled.
- A reminder 15 minutes before a session pings the Session Ping role and the hosts. It never posts twice, even after a restart.
- The start announcement shows the session type, location and hosts, and only pings when the ping switch is on (never @everyone).

Database change: yes, migrations 0019 (incidents), 0020 (sessions), 0021 (photos), 0022 (session fixes, location and co-hosts), and a new Roblox picture lookup.
## 0.15.3 (2026-11-17)

**Changed:** the **Staff & roster** page is redesigned.
- One neat row per person instead of big cards, so many more people fit on screen. Rows sit in sections (Leadership, then each department with its colour), and each section says how many people it has and how many are on shift.
- A **search box** to find someone by name, buttons to show one department, and an **On shift** button to see only who's working now.
- A green dot (or amber for a break) on the photo of everyone on shift, in every department. People without a photo get their initials.
- Names are coloured by the person's highest Discord role, darkened just enough to stay easy to read.
- Admins and executives can tap a person to open their record. Everyone else sees only the roster, never record details.

Database change: yes, `on_shift_now()` (migration 0018), which tells staff who is on shift in every department.

## 0.15.2 (2026-11-17)

**Changed:** **Mod actions** is redesigned.
- **At a glance:** four numbers across the top: this week, active warnings, pending, and either **Waiting for review** (supervisors) or **Didn't go through** (everyone else). Click one to filter the list.
- **Find things fast:** search by name or reason, filter by type (Warnings, Timeouts, Kicks, Bans, Unbans, Notes), choose **Everywhere**, **Discord** or **In game**, or switch on **Only mine**. **Load more** at the bottom.
- **A tidier list:** grouped under Today, Yesterday and earlier dates. Each row shows the person, a fixed-size action tag, the length of any timeout, the reason, and who did it, where and when. Names open the person's record (Roblox names open their Roblox profile). Pending actions update by themselves without the list flickering.
- **A ⋯ menu on every row:** **Open record**, **Remove timeout** (while it's still running), **Unban**, **Remove warning** (executives), **Copy details**, and **Send for supervisor review**.
- **Supervisor review (new):** any admin can send an action for review with a note. Supervisors (executives and whoever directs Administration) see a **Waiting for review** count and decide **Upheld**, **Changed** or **Overturned** with a note. Nobody can review their own action or their own request, and everything is kept on the case.
- **New action** opens in a side panel (full screen on phones) in three steps: **Who** (with their history, e.g. "2 warnings, last today"), **What** (each action explained, timeout lengths as buttons, and a gentle hint such as "already has 2 warnings, a timeout may be the next step"), and **Why** (quick reasons: Spam / flooding, Disrespect / harassment, Inappropriate content, Breaking roleplay / trolling), then an on-page review and confirm. Kicks and bans are shown in red. No more browser pop-ups.
- **Your actions that didn't go through** sit at the top of Mod actions with **Try again** and **Dismiss**.

**Changed (every page):** failed actions no longer stack up as red bars. You now see one calm line, e.g. "2 of your actions didn't go through", which opens to show why, with a link to Mod actions and × to dismiss them all.

Bot: no change.
Database change: yes, migration 0017 (supervisor review).

## 0.15.1 (2026-11-17)

**Changed:** the **Shifts** page is redesigned.
- Your shift is one card: whether you're on shift, on a break or off, your department, a big live timer, when you started and how long you've had on breaks, and your hours this week and over the last 30 days. Take a break, End shift and Start shift sit inside the card. If you're in more than one department, tap the one you're working in first.
- **On now** is grouped by department, in each department's colour, with everyone's photo and a green or amber dot for on shift or on a break.
- **Your shifts** are grouped by week with each week's total, and shifts the bot ended for you are marked "Ended automatically".
- Buttons show they're working ("Starting…") so a double tap can't start two shifts.

Database change: none.

## 0.15.0 (2026-11-17)

**Changed:** a new **CareBeyond** wordmark in the header, chosen from three options. It's one line: a lighter "Care" flowing into a bold "Beyond", then a thin divider and "HOSPITAL" in spaced teal. On phones the divider and "Hospital" drop away so the name never feels crowded.

Bot: no change.
Database change: none.

## 0.14.6 (2026-11-17)

**Added:** a **Session and shift** bar on the home page, in the same spot as the Session active block (above **Pinned**), for when no session is running. It shows "No session running" or when the next session is, the join code, and a **Start a session** button for people who run sessions. For staff it also shows **your shift**: the live timer with **Take a break** and **End shift**, or **Off shift** with **Start shift** (pick a department if you're in more than one). The bold navy **Session active** block still takes over while a session is live.

Bot: no change.
Database change: none.

## 0.14.5 (2026-11-17)

**Fixed:** with lots of pins (up to 7), titles like **Administration** or **Community Engagement** no longer run off the edge of their tile. Pins never get narrower than a long name needs: extra pins move onto a second row instead of squeezing (about five across on a computer, four on a tablet and two on a phone), and long names can take two lines. Every pin is now the same size. **Sessions** used to stretch across the whole row when pinned.

Bot: no change.
Database change: none.

## 0.14.4 (2026-11-17)

**Fixed:** **Pinned** tiles look like the CareBeyond tiles again: each has its icon in a frosted square, a big faint icon in the background and its gradient (each folder's colour, or the department's colour for department pages). Live badges such as **Live now**, **3 waiting** or your shift time sit in the top corner. 0.14.0 had drawn them as plain coloured blocks with just a title.

Bot: no change.
Database change: none.

## 0.14.3 (2026-11-17)

**Changed:** three home headings were reworded to sound calmer and more professional: "What would you like to review, …?", "Which record do you need, …?" and "What can I open for you, …?". There are still 50 in total.

**Fixed:** the **New action** button on the Moderation page was a plain square. It now has rounded corners like every other button. It was the only button built as a link, and links didn't get the button shape.

Bot: no change.
Database change: none.

## 0.14.2 (2026-11-17)

**Changed:** nothing on the site. This release was meant to reword three home headings, but the change didn't make it in. It's in 0.14.3.

Bot: no change.
Database change: none.

## 0.14.1 (2026-11-17)

**Fixed:** picking a person in the home search (with Enter, a click or **Record**) now opens **their record**. Before, it landed on the empty Records search page. The "Open …'s record" suggestion had the same problem and is fixed too.

**Changed:** the home page heading now types itself out once when the page opens. It's one of 50 calm greetings or questions with your name, such as "Welcome back, Dr. Turtle." or "Where are we starting today, Dr. Turtle?". "Good morning / afternoon / evening" only appears at the right time of day. If your device is set to reduce motion, it appears straight away. Search works while it types.

Bot: no change.
Database change: none.

## 0.14.0 (2026-11-17)

**A new home page** (the design chosen on the mockup canvas).

**Added:**
- **Search** at the top ("What do you need?"). Type a name, username or Discord ID to find **people**: admins get **Warn**, **Time out** and **Record** right there, and Enter opens their record. It also finds **things to do** (start or end your shift, start or schedule a session, new mod action, change the join code) and **every tool**. Use the arrow keys and Enter, and press **/** anywhere to jump to search.
- **Smart suggestions** under the search (up to 4), based on what's happening for you: an action that didn't go through, ending or starting your shift, applications to review, a ticket to reply to, copying the join code during a session, scheduling one when none is planned, or reopening the last record you looked at.
- **Session active**: a block that appears only while a session is running. It shows who's hosting and for how long, the **join code** with Copy, **your shift** (live timer with Take a break and End shift, or Start shift), and **who's on shift** with photos and a count per department. When no session is running but one is scheduled, a small line shows when.
- **Pins**: choose your own pinned tools. **Edit pins** lets you turn pins on or off, pick how many (2 to 7), put them in order, remove them and swap others in. Saved to your account, so they follow you between phone and computer.
- **Everything you can use**, in four folders: **Moderation**, **People**, **Operations** and **Help and info**. Each tool is a card with a live line ("6 this week", "3 waiting", "Live", "You're on: 1h 18m"), and each folder shows what needs you.
- **Folder pages**: the **›** button on a folder opens it as its own page with its stats and bigger cards. Moderation also gets **Warn**, **Time out**, **Kick** and **New action** buttons and the latest actions.

**Changed:** the old Welcome card, session banner and menu blocks are replaced by the new home. Back on every page now says **Home**. Every person still only sees the tools they can use.

Bot: no change.
Database change: yes, migration 0016 (by Bravo: saved pins, home counts, people search).

## 0.13.2 (2026-11-17)

**Changed:** in **Records**, **Incidents** is now **Actions**: only mod actions taken on that person's Discord account (timeouts, kicks, bans, unbans). Role changes, joins and leaves no longer appear there, and in-game records don't show on anyone's record. Incidents are meant for explicit write-ups only.

Bot: no change.
Database change: none.

## 0.13.1 (2026-11-17)

**Fixed:** a removed warning now disappears completely. It no longer shows (crossed out) in **Records** or in the **Mod actions** list, and it doesn't count towards anyone's warnings.

Bot: no change.
Database change: none.

## 0.13.0 (2026-11-17)

**Changed:** **no more hubs.** The home page is now one clearly separated block per group, most important first: **Executive**, **Directors**, **Admin**, **Staff** and **Everyone**. Each block holds every tool for that group, one tap away. You only see the blocks you can use: an admin sees Admin, Staff and Everyone, while executives see them all. **Back** on every page now goes straight to the menu.

**Added:** executive controls in **Records**, behind a small settings button that only executives see:
- **Remove warning**: on any warning, give a reason and remove it. It stays on the record struck through under **Removed** (who removed it, when and why) and no longer counts towards their warnings. CareBeyond Helper posts it to #server-logs and lets the member know by DM.
- **Unban**: on the profile of someone who is banned, give a reason and CareBeyond Helper unbans them.

Bot (by Bravo): posts removed warnings and DMs the member. **Needs the bot updated on Wispbyte.**
Database change: yes, migration 0014 (by Bravo).

## 0.12.0 (2026-11-17)

**Added:**
- **Records** (Admin hub): find anyone by name, username or Discord ID (people who have left can be found by their ID) and see:
  - their photo, name, username, ID, when they joined the server and when their account was made, and all their role badges;
  - **Warnings**, **Incidents**, **Messages (90 days)** and **Shift hours (30 days)** at a glance;
  - **Warnings**: every warning with the reason, who gave it and when;
  - **Incidents**: timeouts, kicks, bans and notes, plus joins, leaves, role and nickname changes from the Discord logs;
  - **Messages**: every message they've sent, newest first, with the channel, **Edited** and **Deleted** tags, attachments, a search box and **Load older messages**;
  - **Details**: shift totals, timeout/kick/ban counts, last message and the full list of roles.
- **Warning counts** next to people's names when you search in Mod actions and Records.

**Changed:** failed Mod actions no longer appear in the Mod actions list. Instead, only the admin who asked sees a red notice at the top of the site saying it didn't go through and why. Press **×** to close it for good.

Bot (by Bravo): saves every message in the server from now on (kept 90 days; edits and deletes are marked), and records when each account was made. **Needs the bot updated on Wispbyte.**
Database change: yes, migration 0013 (by Bravo).

## 0.11.0 (2026-11-17)

**Added:** **Mod actions** (was Mod reports, in the Admin hub) now **carries out** what you choose in Discord, the same way the slash commands do.
- **New action** → pick **Discord** or **In game (Maple Hospital)**.
- **Discord:** Warn, Timeout (10 minutes to 1 week), Remove timeout, Kick, Ban or Unban. Start typing in **Who** and people appear by nickname, username or Discord ID. Pick one with a click or the arrow keys and Enter. Banned people show a **Banned** tag so you can unban them. The button says exactly what will happen (e.g. **Ban Maia Acey**), and kicks and bans ask you to confirm. CareBeyond Helper DMs the person, carries out the action and posts it to #server-logs. The list shows **Pending**, then **Done** or **Failed** with the reason, without reloading.
- **In game:** Warn, Kick, Ban or Note, saved as a record. You must enter their **full Roblox username**. It's checked with Roblox as you type ("Found: … @name"), and the exact username from Roblox is what's saved.

**Changed:** "Mod reports" is renamed **Mod actions**, and "New report" is now **New action**.
Bot (by Bravo): carries out actions from the website with the same rules as the slash commands (not on yourself, bots, the owner, or anyone with the same or a higher role), and catches up after time offline. **Needs the bot updated on Wispbyte.**
Database change: yes, migration 0012 and a new Roblox username check (by Bravo).

## 0.10.3 (2026-11-17)

**Fixed:** department pages in the **Directors hub** no longer need reloading after you change someone's year or rank, add someone or remove someone. While a change is **Pending**, the page checks every few seconds. Once CareBeyond Helper has made the change, the page shows **Done** (or **Failed** with the reason) and the member's new year or rank, usually within about 10 seconds.

Bot: no change.
Database change: none.

## 0.10.2 (2026-11-17)

**Changed:** the department tiles in the **Directors hub** show their department colour much more strongly. The Directors violet now only tints the top corner, and the rest of each tile is the department's own colour.

Bot: no change.
Database change: none.

## 0.10.1 (2026-11-17)

**Changed:** the **Directors hub** has a new layout. **Sessions** is a big block pinned across the top, showing **Live now** or when the next session is. Under it, **Administration**, **Nursing**, **Paramedicine** and **Community Engagement** sit four across (two by two on phones), each fading from the Directors violet into that department's own colour.

Bot: no change.
Database change: none.

## 0.10.0 (2026-11-17)

**Added:**
- **Directors hub**, on the home menu between Executive and Admin, in its own violet colour. Department Directors see it; executives see all of it.
- **Department pages** in the hub for **Administration**, **Nursing**, **Paramedicine** and **Community Engagement**. Each Director runs their own department; executives can run all four. Each page shows:
  - members, who's on shift now, and the department's hours this week;
  - every member with their hours this week, shifts in the last 30 days and last shift;
  - **change someone's year or rank**, **Remove** them from the department, or **Add someone** (search the server, pick a starting year or rank);
  - **Recent changes**, each marked **Pending**, **Done** or **Failed** (with the reason). CareBeyond Helper makes the Discord role changes.
- **Sessions** page in the Directors hub (and in the Admin hub for the Admin team): start a session now, schedule one, start or cancel upcoming sessions, and end the live one.

**Changed:**
- Session controls have moved off the home page into the **Sessions** page. Everyone still sees the session banner and join code on the home page.
- Directors and executives can now run sessions as well as the Admin team.

Rules (checked by the database): a Director can't change their own rank, change another Director, executive or leadership member, or make someone a Director. Only executives can.

Bot (by Bravo): a new part carries out role changes requested on the website (also catching up after time offline) and posts each one to #server-logs. **The bot needs uploading to Wispbyte** before changes go through; until then they wait as **Pending**.
Database change: yes, migration 0011 (by Bravo).

## 0.9.2 (2026-11-17)

**Added:** a **live shift timer**. While you're on shift, the Shifts page shows your time counting up each second (hours:minutes:seconds), with the time you started. On a break the timer stops and your break time counts up instead. **This week** and the times in **On now** keep up by themselves too.

Bot: no change.
Database change: none.

## 0.9.1 (2026-11-17)

**Fixed:**
- **Anyone in CareBeyond can start their own shift**, with or without a session running. Executives and leadership with no department role (e.g. a Hospital Director) had no **Start shift** button; now they pick any of the four departments.
- **Staff & roster:** names and badges no longer run off their cards. Long badges wrap neatly inside the card.

**Changed:** **Staff & roster** shows every department role a person has, each as its own badge (e.g. **Hospital Director** and **Community Engagement Leader**). Inside a department's section the department is left out, so it reads **Year 5** instead of **Nursing Year 5**. Picking a department shows everyone in it, including people listed elsewhere (e.g. under Leadership).

Bot: no change.
Database change: yes, migration 0010 (by Bravo: executives can start shifts in any department).

## 0.9.0 (2026-11-17)

**Added:**
- **Shifts on the website:** **Start shift** (pick a department if you're in more than one), **Take a break** / **End break**, and **End shift**. CareBeyond Helper still sets your In Game / On Call / On Break role and posts to #shift-logs.
- **Bot settings** (Executive hub) is now a real page: change the **Maple Hospital join code** (the banner and the USE CODE channel update) and how long before a **forgotten shift ends automatically**.

**Changed:**
- **Discord commands are down to seven:** `/ban`, `/kick`, `/timeout`, `/untimeout`, `/warn`, `/unban` and `/login`. Everything else is done on the website.
- **Nothing is lost while the bot is offline.** Anything done on the website while it's off (sessions, tickets, applications, mod reports, shifts, join code) is carried out as soon as it's back. Forgotten shifts no longer count offline time as worked.
- Mod reports filed on the website are now also posted to #server-logs.
- Discord logs explain that gaps mean the bot was offline.

Bot (by Bravo): `/cases`, `/contact`, `/joincode` and `/shift` removed; every part catches up on startup.
Database change: yes, migrations 0008 (shift and settings actions) and 0009 (catch-up tracking).

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
