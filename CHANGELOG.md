# Changelog

Every published version of CBH (the CareBeyond Hospital staff dashboard and the CareBeyond Helper bot, which share one
version number). Newest first. How versions work and how to roll back: `docs/RELEASING.md`.

## 0.51.1 (2026-11-22)

**Fixed:**
- **Pop-out windows now have the People list**, so you can drag nurses and doctors onto beds there too (drag within the window that shows the room).

Database change: no.

## 0.51.0 (2026-11-22)

**Added:**
- **Pop out a floor plan view into its own window** (like vatSys). Pick a view and press **Pop out**: it opens in its own window with just the plan, live and signed in, with its own zoom. Drag it to another screen and open more, e.g. one window per zone. Only the main Chart window plays sounds and full-screen alerts. Computers only.
- **View tabs over the floor plan:** All, 1st floor, 2nd floor, or one zone. A tab only changes what the map shows, on that device; Up next still follows "You cover".

**Changed:**
- **The 2nd floor is drawn like the main ward:** main-ward-sized rooms packed round short corridors, a wall all round each area, and the main ward's grey hatching for spaces with no patients (no more blank boxes or white gaps). Every room and doorway connects as before. The main ward and Emergency look the same.

Database change: no.

## 0.50.0 (2026-11-22)

**Added:**
- **The CBH Chart covers the whole hospital, in four zones.** Zone 1 the main ward, Zone 2 Emergency, Zone 3 Surgery & ICU (Pre-Op with 4 beds, OR 1-3, PACU 1-3, ICU 1-6) and Zone 4 Pediatrics & Med-Surg (201-204 for children, 205-209). The session turns each zone on or off, so one supervisor can run both floors, two can split them, or one can run a single zone. The 1st floor is drawn above the 2nd at the same scale. Pre-Op, the ORs and PACU are Surgical; ICU and Med-Surg are Medical; Pediatrics is Nursing, children only.
- **"You cover".** With two or more zones open, each supervisor ticks the zones they cover; their map, Up next and bed count show only those.
- **Book out the Medical Classroom.** Tap the Classroom on the 2nd floor to book it for the session and again to hand it back (whoever booked it, or a supervisor). It never takes patients. The booking ends with the session or when Zone 3 closes.

**Changed:**
- The "Main ward / With Emergency" switch is now the four zone buttons. A zone can't be closed while one of its beds is held or has a patient.
- Bigger maps open with their full width in view and scroll down; on a phone in full screen they keep the Emergency map's room size and scroll instead of shrinking. The main ward and the main ward with Emergency look exactly as before.

Database change: yes (0105: the four zones, the 2nd-floor rooms and the classroom booking; additive).

## 0.49.0 (2026-11-21)

**Added:**
- **Delete a chart made by mistake.** "Delete chart" at the end of a patient's record (and under the phone patient sheet). Supervisors and executives can delete any open chart, with a short reason; whoever made it can delete their own while it's fresh (no notes, care or requests yet, under 10 minutes). It comes off the Chart for everyone, frees the bed and clears requests, orders, visits and any trauma call; a record stays in the log. **Undo** for 10 seconds puts it back.

Database change: yes (0104: delete and undo a chart; additive).

## 0.48.1 (2026-11-21)

**Changed:**
- **The CBH Chart handles 50 people at once.** Chart refreshes no longer wait in line behind each other, and what's the same for everyone is worked out once per change instead of once per person. In a 50-account test: typical refresh 0.1 s (was 12 s with 31 accounts), no timeouts (was 16).
- The Chart refreshes every 3 s while you're using it, about every 9 s after 2 minutes idle, and about every 25 s in a hidden tab (straight away when you come back). A ringing Trauma siren always keeps it at 3 s.

Database change: yes (0103: faster Chart refresh; already applied; additive).

## 0.48.0 (2026-11-21)

**Added:**
- **Smarter Supervisor drag and drop.** Every case is handled: dropping a nurse onto a waiting patient gives them the bed AND the patient ("Max R. is waiting for you"); onto someone else's patient sends them to help; onto a bed someone holds asks "Share the room / Give this bed to… / Cancel"; On call doctors become the accepted doctor for that patient; closed rooms are refused with the reason; people on a break or at a trauma call are asked about first.
- **Dragging patients.** Drop an Up next patient on a free bed (marked "Needs a nurse" if nobody can take them yet), onto a bed another nurse holds ("Hand to… / Keep their nurse"), or drag an incoming ambulance onto a bed to **reserve** it ("Reserved: Zoe R. · ambulance 4 min"). **Change nurse** in the record, or drop a nurse's face onto the patient.
- **Trauma call, start to finish.** A call for an incoming patient reserves its bay, and the patient goes straight in on arrival; "Place in Trauma Bay 1" for a call with no patient yet; patients can be dropped onto the red bay; the first Nursing team member to arrive (or the bay's nurse) becomes their nurse; the call follows the patient if they're moved and ends if they leave.
- **Orders, visits and trauma calls reach you on any CBH page** while you're on shift, not just on the Chart.
- An adult can be sent into a children's room after a "Send anyway?" question.

**Fixed:**
- A nurse still on "Pick your room" can no longer undo the Supervisor's placement: the Supervisor wins.
- Discharging a patient now ends helpers' visits and doctors' orders for them; only a person's newest order stands; a Supervisor placement cancels their own partner request; a nurse handed a patient can press Got it; ending a session frees beds, orders and visits.
- The Admins on shift box was invisible when the People list was folded down.

Database change: yes (0098–0102, already applied; additive).

## 0.47.1 (2026-11-21)

**Changed:**
- **Admins on shift folds away.** It's a slim "Admins on shift" row with a few faces; click to open the full list. Each device remembers it. Admins who are already working a Chart role stay in the list, greyed, with their role ("On Room · 105 A"), and are moved from their role group instead.

**Fixed:**
- Anyone working on the Chart who is also an admin, executive or Director showed their shift's department (e.g. everyone "Nursing") instead of their Chart department, in People, hover cards and the department-clash question.

Database change: no.

## 0.47.0 (2026-11-21)

**Added:**
- **Supervisor v2 on the CBH Chart.** Supervisors can drag a nurse's face onto a bed to move them. If they already have a bed it asks "Move here / Give this bed too", if patients are still in their old bed it asks first (with "Hand them to…"), and a department clash asks each time. Double-click a face to take someone off a bed.
- **Supervisor orders are a full orange screen** for the person moved ("SUPERVISOR ORDER · Room 104 · Nina Ross moved you here"), with a softer alarm that repeats until seen and stays until OK.
- **Visits:** drag an admin, executive, Director or On call doctor onto a room and pick a reason (Help with patient, Patient complaint, Check on staff, Second opinion, Medical request, or your own message). They get the orange screen, then Arrived → Done, and show on the room with one short tag.
- **Partner requests:** picking a bed in a room someone else holds asks them to share (Accept / No, 60 seconds). You keep your old bed until they say yes.
- **Admins on shift** box under People (Administration, executives and Directors on shift), draggable onto rooms for visits.
- **Hover cards:** hover (or long-press on phones) on anyone for their Discord picture, name, rank, role and bed, what they're doing, any visit and time on shift. Faces use Discord pictures where available.
- **Zoom on the computer floor plan:** − / slider / + / Fit controls, Ctrl+wheel or trackpad pinch to zoom, drag the empty floor to pan. Each device remembers its zoom.

**Changed:**
- **One bed per person.** Nurses pick one bed; the Supervisor can give a second. An Open-room offer gives one bed.

Database change: yes (0097: one-bed rule, moves, orders, visits, partner requests, admins in the Chart; additive).

## 0.46.0 (2026-11-21)

**Added:**
- **Collapsing side menu (computers).** A "Collapse menu" button at the foot of the left menu folds it to a slim icon rail, like the Chart's own menu: badges stay on the icons, hovering opens it over the page, and the page widens. Each device remembers the choice. Phones are unchanged.
- **"Click to turn on alarm sounds"** strip when the browser is blocking sound; any click turns it on.
- Reception now gets an alarm when a new patient needs calling in.

**Changed:**
- **Chart alarms are much louder** and each has its own pattern; Code Blue and the Trauma call are the most urgent. An alert that arrives while you're not looking at the tab repeats every 3–4 seconds until you look at it or click the page, and the tab title and icon flash until then.

**Fixed:**
- The Trauma call siren, flashing title and red tab icon now stop as soon as you answer (On my way, Can't come or Join), and when the call is cancelled, including in other open Chart tabs.
- Phones: the Code Blue bar is one tidy full-width line instead of a tall block covering the role banner.
- Browsers now load the latest Chart files straight after an update (cache tags were stuck on 0.43.0).

Database change: no.

## 0.45.0 (2026-11-21)

**Added:**
- **Trauma call on the CBH Chart.** Supervisors can call a whole team to a room at once: a "Trauma call" button on incoming ambulance patients, on a patient's record, in room settings and on the Trauma Bays. Set how many are needed from Medical, Surgical, Paramedicine and Nursing, tick names (or drag faces onto the bay), and any places left go out as an open call that free staff in that department can join.
- People called get a red full-screen alert with a siren (and a buzz on phones) until they press **On my way** or **Can't come** (which reopens their place and tells the Supervisor), then a "Going to" bar with **Arrived**.
- The called room turns red on the floor plan with "TRAUMA CALL · 4 of 7", a row per department and the faces coming, and the plan scrolls to it. Supervisors can add or remove people, change the numbers, finish or cancel.
- Busy staff can be called: their own beds stay theirs and show "Away: at trauma". The call closes by itself when the session ends or the patient leaves, and people who clock out are taken off it.

**Fixed:**
- The floor plan with Emergency no longer jumps back to the left edge every time it refreshes.

Database change: yes (0096: trauma calls; additive).

## 0.44.0 (2026-11-21)

**Added:**
- **Emergency wing on the CBH Chart floor plan.** A second map, "Main ward + Emergency", adds the ER wing through the doorway between 109 and 110: Trauma Bays 1 and 2, ER 1–6, Minor Triage (3 chairs), plus Emergency Dispatch and Storage as labels, with the ambulance parking and drop-off above. 11 new spots; ER rooms default to Medical, Trauma Bays to Surgical (supervisors can change them).
- **Choosing the map.** Hosts pick the Floor plan (Main ward / Main ward + Emergency) when making an in-game session. Supervisors can switch it any time from the floor plan header ("Main ward / With Emergency"). Switching back is refused while a patient is still in an ER bed. The Main ward stays the default and looks as before.
- The floor plan with Emergency keeps the main ward at full size and scrolls inside its box on computers; phones zoom and pan as before.

Database change: yes (0095: session map choice, Emergency rooms and beds, chart_set_map; additive).

## 0.43.0 (2026-11-20)

**Added:**
- **Allow NPC patients during a session.** A new supervisor switch, "Allow NPC patients" (Session menu on computers; Session settings on the phone's Floor Plan tab). While it's on, Room staff get "+ NPC patient" during sessions too, and the top bar shows "NPC patients allowed". It stays as set until a supervisor turns it off. Off by default, so nothing changes until someone turns it on.
- Phones: Supervisors get Session settings on the Floor Plan tab (Allow Reception, Online check-in, Allow NPC patients, End session), which phones didn't have before.

**Fixed:**
- The Session menu's switches now look like on/off switches (they were plain grey buttons, so you couldn't tell which were on).

Database change: yes (0094: the NPC switch; additive).

## 0.42.2 (2026-11-20)

**Fixed:**
- CBH Chart: the top bar said a green "Reception open" whenever Reception was allowed, even with nobody at the desk. It's now green only when someone is on Reception ("Reception: Nina"); otherwise it says "Nobody on Reception" (or "Reception closed"). The supervisor's switch in the Session menu is now called "Allow Reception".

Database change: no.

## 0.42.1 (2026-11-20)

**Fixed:**
- **Your shift shows on every device.** Start (or pause, or end) a shift on one device and the top bar's timer and End shift button now appear on your others within 20 seconds, or as soon as you come back to the tab. Shift Manager updates with it.
- **Closed rooms stay closed until someone opens them.** Changing a room's department or who can go in used to re-send the room's whole state as that device last saw it, which could quietly reopen a room another supervisor had just closed. Now only the setting being changed is sent. A closed room stays closed across sessions until someone presses "Open the room".

Database change: no.

## 0.42.0 (2026-11-20)

**Changed:**
- **The floor plan on phones is now zoom and pan.** The map sits upright right on the Floor Plan tab, with no turning the phone. Pinch or use + and − to zoom, drag to move around, and Fit to see the whole ward. It opens zoomed in enough to read, starting from the left (rooms 101–107). Tap someone in Up next, then a lit bed, to give them out; tap a patient's bed for Open record, Move or Give to someone. Those choices, room settings and people open in a sheet at the bottom of the screen. Dragging or pinching never counts as a tap.
- Room role: Pick your room on phones uses the same zoomable map (the list is still underneath).
- The sideways full-screen view is still there behind the map's "Full screen" button.

Database change: no.

## 0.41.4 (2026-11-20)

**Fixed:**
- CBH Chart on phones: the full-screen floor plan squashed into the left side of the screen on iPhone (Safari and Discord's browser). The plan is now sized to fit the screen exactly, upright or sideways, and resizes when the phone turns.

Database change: no.

## 0.41.3 (2026-11-20)

**Fixed:**
- CBH Chart on computers: with a patient's record open beside the floor plan, the beds show the patient's name again (the bed letter was pushing it out of sight), and Paediatric rooms say "Child" so the tag no longer runs under the room's pencil.
- CBH Chart on tablets: the ward picture on the Floor Plan tab sits beside the Open button instead of filling the screen.
- CBH Chart: removed the "Nothing typed before yet…" line under Care given.

Database change: no.

## 0.41.2 (2026-11-20)

**Fixed:**
- Phones: Records' Recently Actioned and Most Warnings show the whole name, with the tag and date underneath (names were cut to "Jor…").
- Sessions: the Join game button is its normal size instead of a bar across the card, and centred wherever it is stretched.
- Courses: the empty list just says "No courses yet." (no extra explanation line).

Database change: no.

## 0.41.1 (2026-11-20)

**Fixed:**
- Phones: Staff & Roster no longer runs off the right edge of the screen (the Rank Editor's styles were leaking into it; they now only apply to the Rank Editor). Every page is also kept to the screen's width.
- Phones: on Home's "Needs You" and a department's "Needs Your Attention", the button now sits under the text, so long titles aren't cut short or squeezed into one word per line.
- Computers: a department's menu column now runs to the bottom of the window instead of stopping where the page's content ends.
- Shift Manager: "Your Shifts" has the same space above it as the other sections.
- Smaller laptops: the top bar's search label stays on one line.
- A department's Shifts tab no longer breaks if the server sends back nothing.

Database change: no.

## 0.41.0 (2026-11-20)

**Added:**
- **The floor plan on phones.** Supervisors get a Floor Plan tab with a small picture of the ward; tap it to open the full floor plan full screen and sideways (Android locks to landscape; on iPhone and in Discord's browser the plan turns itself, so just turn the phone). Tap someone in Up next, then a lit bed, to give them out; tap a patient's bed to open their record, move them or give them to someone; tap a room's pencil for its settings and a person for their role.
- **Pick your room on the floor plan** on phones (Room role), as well as from the list.
- Moving a patient on the floor plan (computer too): the free beds they can go to now light up as "Move here".

**Changed:**
- Phones: the big role card is now one slim bar with Change, sound and alert settings, so each screen has more room.
- Phones held sideways now get the phone layout instead of a squashed computer layout.
- The CBH Chart's own menu shows its stethoscope mark instead of a plain teal square.

**Fixed:**
- Phones: names in Up next on the Ward Board and Front Desk were in spaced capitals.
- Phones: the Send to the ER button sat on top of the bottom tabs.

Database change: no.

## 0.40.0 (2026-11-19)

**Added:**
- **Correct or delete Chart records.** A new department permission, "Edit chart history" (Directors and owners have it), lets people correct details and entries on past records, strike out entries, or delete a whole record. Every change needs a reason and shows on the record with who made it. Nothing is erased: owners can show deleted records and restore them.

**Fixed:**
- The Chart keeps titles in names ("Dr. Turtle", not "Dr. T.").
- People given "Post department news" now see it everywhere, not just on the Overview.

Database change: yes (0093).

## 0.39.7 (2026-11-19)

**Added:**
- **Chart History** in each clinical department: every closed patient record, newest first, with search and filters (dates, outcome, who treated them). Open one to read the full record: symptoms, vitals, care given, orders and results, diagnosis, discharge papers, colour history and timeline. Directors and owners see the whole department; staff see the patients they treated.

Database change: yes (0092).

## 0.39.6 (2026-11-19)

**Added:**
- CBH Chart: add symptoms when logging an NPC patient, and "+ Add symptoms" on any patient's record (phones too).

Database change: no.

## 0.39.5 (2026-11-19)

**Fixed:**
- The CBH Chart no longer gets stuck on "Loading the Chart" when you open it directly; if it ever can't load, it says so and tries again by itself.
- On call doctors can accept requests (the request steps stay open until you've accepted).

Database change: no.

## 0.39.4 (2026-11-19)

**Fixed:**
- The CBH Chart got stuck on "Loading the chart" after 0.39.3 (its stylesheet was accidentally emptied). Restored.

Database change: no.

## 0.39.3 (2026-11-19)

**Fixed:**
- CBH Chart: picking your room works (tap your beds, then Done).
- CBH Chart: when the Chart refuses something it always says why.
- Ending the last shift of the day now tidies up the Chart properly, and supervisors can give someone a room.

**Changed:**
- The Chart is open: the Launch / Pause controls are removed.

Database change: yes (0091, already applied).

## 0.39.2 (2026-11-19)

**Changed:**
- Departments in the side menu have their own icon on a gradient tile.
- The CBH Chart's role card and role screen have icons: Reception, Patient Care (Room, On call, Road) and Supervisor, and each department button shows its icon.

Database change: no.

## 0.39.1 (2026-11-19)

**Changed:**
- The top-bar shift button shows your time on shift as it ticks ("1:12:04 | End shift", or "On break").

**Fixed:**
- The CBH Chart's End session only shows while a session is running.
- Removed test-only buttons from the Chart's front desk.

Database change: no.

## 0.39.0 (2026-11-19)

**Added (ready to launch; switched on by an owner):**
- **The new CBH Chart.** Pick your role for the session (Reception, Patient Care: Room / On call / Road, or Supervisor). Reception checks patients in and calls them; nurses take their rooms, press Ready and are given patients; doctors and surgeons answer requests; paramedics bring in incoming cases; supervisors run the session from a live floor plan of the hospital. Every patient gets a proper record (triage colour, vitals, care given, orders, results, discharge papers), with sounds and alerts so nobody has to keep checking.
- **Online check-in with no account:** patients enter their Roblox username and symptoms, see live wait times for adults and children, and follow their visit on a private page.
- A new "Supervise sessions" permission in the Rank Editor.
- Owners launch (and can pause) the Chart from the Session menu; until then only owners and supervisors can open it.

Database change: yes (0084-0090). Function: roblox-lookup.

## 0.38.1 (2026-11-19)

**Changed:**
- The front page shows what the site does for members: department pages, Shift Manager, leaderboards, sessions and events, courses, applications, and the CBH Chart (launching soon).
- Members can log in right from the top of the front page (one click with Discord, or "Continue as" on a device you've used before), and the login opens in place instead of scrolling to the bottom.

Database change: no.

## 0.38.0 (2026-11-19)

**Added:**
- **A public front page** for CareBeyond Hospital: what we are, how a visit works (online check-in is launching soon), our departments, how to join, a big Join our Discord button and the join code with Join game. Log in is for team members; patients don't need an account.
- The site can now be found on Google (title, description, link preview, sitemap).

Database change: no.

## 0.37.1 (2026-11-19)

**Fixed:**
- Security: tightened which database functions signed-in users can call. Nothing changes on screen.

Database change: yes (0083, function permissions).

## 0.37.0 (2026-11-19)

**Changed:**
- The CBH Chart and Check In are switched off while they're rebuilt from scratch. Their pages, buttons and badges are hidden, and old links go Home. Nothing is deleted.
- Bot: check-in is removed from Discord (the check-in panel, staff desk, patient DMs and rating DMs, and the Check in button on session posts).

Database change: no.

## 0.36.1 (2026-11-19)

**Fixed:**
- In the application builder, moving a stage up could blank its name and lose its buttons. Stages saved without a name now show as boxes to fill in, and empty stages are never saved.

Database change: no.

## 0.36.0 (2026-11-19)

**Changed:**
- **Ranks & Permissions is now a Rank Editor:** pick a rank on the left and switch its permissions on the right, grouped and described in plain words. Each rank's office key and weekly target sit at the top; the department target and office guests have their own entry. On phones, tap a rank to open it.
- Clearer permission names, such as See the whole department, Post department news, Change ranks (from X up to Y), Run meetings and Take attendance.

Database change: no.

## 0.35.0 (2026-11-19)

**Added:**
- Owners get an **Exec** switch in the top bar: turn it off to see the site as your own ranks (your departments, tabs, counts and tools), and back on for the full view. It only changes what you see, and it's remembered on each browser.

Database change: no.

## 0.34.0 (2026-11-19)

**Changed:**
- **Department Overview redesigned:** your own header with your Discord photo, one clear Next up, Department News, your team with photos, and Your Week as a graph against the weekly target. Empty sections stay hidden for members, and invite the people who can fill them.
- Real Discord profile pictures now show for everyone on the Overview, not just admins.

Database change: yes (0082, my_department_overview: additive).

## 0.33.1 (2026-11-19)

**Fixed:**
- The department Overview link always opens Overview, instead of the last tab you had open.
- The greeting keeps titles like Dr. with your name ("Good morning, Dr. Turtle").

Database change: no.

## 0.33.0 (2026-11-19)

**Changed:**
- **Departments have one menu:** Overview, Roster, Shifts, Events and Courses, and for leaders Applications, Sessions, Tickets and Manage.
- Members is now part of Roster (leaders keep every control there), Meetings is part of Events, and History with Ranks & Permissions is Manage, each as toggles at the top of one page.
- The side-menu Views are gone: Roster has rank toggles at the top, and old links still work.
- You only see the departments you're in (owners see every department).

**Added:**
- **Shifts** in every department: who's on now, your week against the target with your shift log (leaders see the whole team), and a Leaderboard for the whole department (Most Minutes or Top Performing, this week or the last 30 days).

Database change: yes (0081 dept_shifts, additive).

## 0.32.5 (2026-11-19)

**Added:**
- Anonymous page view counts, so the owners can see which pages are used and when. Only counts are kept (hour, page, phone or desktop, staff or not): no names, no IPs, no exact times.

**Fixed:**
- Logging in with a code from the bot now uses the same account as "Sign in with Discord", instead of making a second one.
- A check-in helper function can no longer be called by people who aren't signed in.

Database change: yes (0071 page views, 0072 check-in function access). Function: login-code.

## 0.32.4 (2026-11-19)

**Changed:**
- Departments open without the "Loading…" flash: the banner shows straight away, and the tabs and Overview show quiet outlines until their data arrives. The Overview now loads at the same time as the department, so the wait is about half as long.

Database change: no.

## 0.32.3 (2026-11-18)

**Changed:**
- Pages use the whole width of the window and stay centred, so Home and other pages no longer hug the left on big screens.

Database change: no.

## 0.32.2 (2026-11-18)

**Changed:**
- **A tidier outer menu:** Home, CBH Chart, Check In, Shift Manager and Apply, then your departments, then Help (Rules & Info and Support Tickets).
- **Sessions and Tickets now live inside each department**, in the Leaders part of its menu. Sessions are for the people who run them; Tickets shows only that team's tickets.
- Courses and the Staff Directory are no longer in the outer menu; courses are in each department.
- Bot Commands are now part of Rules & Info.
- "My shift" is now **Shift Manager**, and "Contact a team" is now **Support Tickets**, with a quick "Report a website problem" option.
- Every menu label and page title is in Title Case.
- Old links still work.

Database change: no.

## 0.32.1 (2026-11-18)

**Fixed:**
- Pages outside a department (My shift, Sessions, Courses and others) now fill the space instead of sitting in the middle with a gap on the left.
- Opening a department slides its menu in from the left; leaving slides it out. It switches instantly if you've turned on reduced motion.

Database change: no.

## 0.32.0 (2026-11-18)

**Changed:**
- **A new, calmer layout:** a simple top bar (with Start / End shift and your avatar menu) and a plain left menu. On phones it's a slide-out menu.
- **Each department opens in its own window** with its own menu: Overview, Roster, Events and saved views, plus a Leaders section for leaders.
- Removed the old folder sidebar, the session and shift cards, the phone bottom tabs, Home's duplicate shift controls, and the department banner stats and hours chart.

**Added:**
- **Department Overview for everyone in the department:**
  - What's on (sessions, meetings, trainings and events, with Going buttons)
  - From the Director
  - My progress
  - My week against the weekly target
  - On now
- **Events:**
  - Leaders can create trainings, drills, socials, ceremonies and other events.
  - The bot posts them with Going / Maybe / Can't buttons and reminds the people who are going.
  - Hospital-wide events post in #event-news and ping only Events Ping.
- **"From the Director" posts**, copied to the department's announcements channel. Directors can give other ranks the new "Post updates" permission.
- **Roster views** (Most minutes, Top performing, each Year) for leaders, and a weekly minutes target per department.

Database change: yes, migrations 0075 to 0080 (events, department posts, targets, overview and roster views); already applied.

## 0.31.0 (2026-11-18)

**Added:**
- **CBH Check-in:** players who want to be patients check in from Discord (#check-in) or the website while a session is live.
  - Required: character name, age, Roblox username, symptoms. Optional: pain, when it started, allergies, history, last meal.
  - "Your visit" shows their place in line, who's coming and their room.
  - Status DMs, a live waiting board, a discharge summary, and a 1 to 5 rating.

**Changed:**
- **The CBH Chart is now for live patients only.** Every case starts from a check-in, and NPCs aren't charted.
  - The Chart page is a live Queue (Waiting, In care, Discharged today) with a recommended next patient.
  - Staff on shift tap Take patient and confirm or correct the patient's answers.
  - Vitals follow the game's order, and CO2 and Pulse are added.
  - New: orders with results, a diagnosis, and discharge advice the patient receives.
- Staff see their own average rating. Directors see their department's, and owners see everything.
- "Log a patient" is replaced by the Queue: in the sidebar, on the shift card ("Take next") and on the phone tab.

Database change: yes, migrations 0067 to 0070 (Chart v2 and Check-in); already applied.

## 0.30.0 (2026-11-18)

**Added:**
- **CBH Chart v1:** a quick patient log for clinical staff (Nursing, Paramedicine, Medical and Surgical).
  - One shared Case per patient visit that every department adds to.
  - Log a patient in about 30 seconds: patient, complaint, how they arrived, ESI triage, vitals on a keypad, treatments and medicines matched to Maple Hospital, an optional SBAR handover, and the outcome.
  - Anything above your rank is saved as "needs cosign", and seniors cosign it from a queue.
  - Mistakes are marked "entered in error", never deleted.
- "CBH Chart" in the sidebar for clinical staff, Administration (read-only, for quality checks) and owners.
- "+ Log a patient" on the Home shift bar and the sidebar shift card, and a + tab on phones, while you're on shift.
- Cases are linked to your shift and session automatically.

Database change: yes, migrations 0062 to 0064 (CBH Chart); already applied.

## 0.29.1 (2026-11-18)

**Fixed:**
- Department pages with many tabs now have arrow buttons to scroll the tab row, and the mouse wheel scrolls it too. The tab you're on is centred when the page opens.

Database change: no.

## 0.29.0 (2026-11-18)

**Changed:**
- Hospital tools now live in Administration: Mod actions, Records, Discord logs, Tickets and the Staff directory are tabs on the Administration page, shown to whoever has permission for each. The Hospital Director and COO also see Activity, Bot settings and Roles there.
- Old links still work.
- The Staff directory is still in My stuff for all staff.

**Fixed:**
- Administration Team Members can now handle Administration tickets.

Database change: yes, migration 0065 (Administration tickets); already applied.

## 0.28.0 (2026-11-18)

**Added:**
- Two new departments: **Medical** (blue) and **Surgical** (green), each with a Director and Year 1 to Year 5, their own department page, meetings, courses, office access and an application form (closed until it's opened).
  - Medical: Medical Director, Attending Physician, Medical Fellow, Resident Physician, Medical Intern, Medical Student.
  - Surgical: Surgical Director, Attending Surgeon, Chief Resident, Surgical Resident, Surgical Assistant, Surgical Technician.

**Changed:**
- Departments now come from one list, so new ones can be added quickly.
- Administration's colour is now purple (#7B61FF).

**Bot:**
- Knows the Medical and Surgical ranks, pings them for meetings and gives their Directors Board of Directors.

Database change: yes, migrations 0060 (one departments list) and 0061 (Medical and Surgical); already applied.

## 0.27.2 (2026-11-18)

**Fixed:**
- The sidebar's **Join game** button now always fits inside the session card.

Bot: no change. Database change: no.

## 0.27.1 (2026-11-18)

**Added:**
- **Join game:** one tap from the website (next to every join code) or from a session post in Discord loads you straight into the CareBeyond server in Maple Hospital. On phones, the Roblox app opens it.

**Bot:**
- A **🎮 Join game** button on session announcements, the 15-minute reminder and scheduled-session posts; it's removed when the session ends or is cancelled.

Database change: no.

## 0.27.0 (2026-11-18)

**Changed:**
- **Full access** (every department, Hospital tools, the Roles page) is now only for the **Hospital Director** and the **Chief Operations Officer**. Department Directors see and run their own department; any extra hospital tool can be switched on for them on the Roles page.
- The **Executive** role is being replaced by **Board of Directors**, which CareBeyond Helper gives to every department Director automatically (and takes away if they stop being a Director). It opens the leaders' channels in Discord and gives nothing extra on the website.

**Fixed:**
- The department banner's numbers no longer push the page sideways on phones.

**Bot:**
- Treats only the Hospital Director and COO as full access, and keeps Board of Directors in step with the Director ranks.

Database change: yes, migration 0059 (owners-only full access).

## 0.26.0 (2026-11-18)

**Added:**
- **Assign a course:** people who can edit or assess courses can assign a course to anyone (by name, or everyone with a rank), with an optional due date and note. The person gets a DM, it shows first in **My courses** under **Assigned to you**, and on **Home** and the badges while it's due. The course's Progress tab shows who's assigned and done, with **Unassign**.
- **Office access** on each department's Ranks & permissions tab (Directors and executives): choose which ranks always have the office key and add extra people, with an end date if you like. CareBeyond Helper keeps the key roles in step.
- **🟢 On Shift** and **☕ On Break** roles for every department, set automatically from Clock in, Break and Clock out on the website.

**Changed:**
- Departments now come from ranks alone (the hidden department roles are going), and meetings ping the department's ranks.
- On the Roles page, office keys and status roles say they're managed automatically.

**Bot:**
- DMs when a course is assigned to you; keeps office keys and the On Shift / On Break roles in step; meetings ping ranks.

Database change: yes, migrations 0056 (course assignments), 0057 (assigned courses in To do) and 0058 (status roles and office keys).

## 0.25.0 (2026-11-18)

**Added:**
- **Exam lock** for quizzes and exams: **Start exam** goes full screen. Leaving once shows a big warning with a 30-second countdown; leaving again, or staying away for 30 seconds or more, ends the exam ("Your exam has ended"). Reloading the page counts as leaving. An ended exam uses a try, can't be submitted, and its answers are kept unmarked (Not passed). The server decides, so editing the page can't get round it.
- Each exam chooses **Allow phones** (stay on this page; the default for formal exams) or **Computer only** (full screen required). A website can't truly lock a device: this detects leaving and enforces the rules.
- Assessors see an **exit log** on every attempt, and Progress shows ended attempts.
- **My courses** is now its own page listing every course you're enrolled in, across all your departments.

Bot: no change.
Database change: yes, migration 0055 (exam lock; already applied).

## 0.24.1 (2026-11-18)

**Changed:**
- **Course viewer:** a solid control bar under every PDF slide: big ◀ ▶ buttons, **Page 3 of 12** with a box to jump to a page, zoom and **Full screen**. Arrow keys, Page Up/Down, Home and End work on a computer; on phones the controls are big and swiping still turns pages.
- Slides stand out on a light grey surround, Google Slides lessons get **Full screen** and **Open in Google Slides**, and pictures can be zoomed and shown full screen.

Bot: no change. Database change: no.

## 0.24.0 (2026-11-18)

**Added:**
- **Roles** now works like Discord's role editor (executives). Pick any role and use four tabs:
  - **Display:** name, colour, show separately, @mentionable, and move it up or down.
  - **Permissions:** website tools, department powers, which **bot commands** it can use, and **every Discord permission**, grouped as Discord shows them.
  - **Members:** give the role to someone or take it away.
  - **History:** every change, who made it and whether it worked.
- CareBeyond Helper makes the Discord changes within seconds and logs each one in **#server-logs**. Dangerous permissions (e.g. Administrator, Ban) need the role's name typed first. Roles above the bot's own role are locked, with a note saying why.

**Changed:**
- Who can use **/warn**, **/timeout**, **/kick**, **/ban** and the rest (in Discord and on the website) is now set per role on the Roles page. Nothing changed today: the same Administration ranks and executives as before.

**Bot:**
- Applies role edits from the website, posts role changes to #server-logs, and checks moderation commands against each role's permissions.
- Course DMs (from 0.23.0) go live with this update.

Database change: yes, migrations 0053 (role editor) and 0054 (command permissions on website mod actions); already applied.

## 0.23.0 (2026-11-18)

**Added:**
- **Courses** on each department page. Big course blocks made of modules and steps: written lessons, **Google Slides** shown in the site, YouTube, Google Docs and links, uploaded **PDFs** (a slide-by-slide viewer), PowerPoints (download) and images.
- Reading steps count when you reach the end (the PDF's last page, the end of a YouTube video, the bottom of a lesson); Slides, Docs and PowerPoints use **I've finished**.
- **Quizzes and formal exams** with an answer key, points, tries, a wait between tries, a time limit and an answer-reveal setting. Multiple choice marks itself; written answers go to a **Marking** page (Assess courses), and until everything is marked you only see "Submitted. Results usually within…".
- **Practical evaluations** marked Not yet / Developing / Standard / Exceeding per competency.
- Who a course is for (e.g. Trainees only), its open date, courses to finish first and its due date are all enforced by the database. Files are private to the course's people once it opens.
- The course editor autosaves a draft, and **Publish** makes it live. A progress table per course, and a **Courses 2/3** chip on Members.
- **My courses** in the sidebar opens your courses.
- Department members can now open their department page and see the parts meant for them (e.g. Courses).

**Bot:**
- DMs when a course opens for you, is due soon or overdue, or when your result is ready.

Database change: yes, migrations 0048 (courses) and 0051 (private course files); already applied.

## 0.22.2 (2026-11-18)

**Fixed:**
- **Desk:** the sidebar stays where you scrolled it when you open a page, on computers and in the phone menu.

Bot: no change. Database change: no.

## 0.22.1 (2026-11-18)

**Fixed:**
- **Hospital tools** only lists what you can open (no more **Applications** link sending reviewers back to Home or duplicating the department link).
- The sidebar scrolls above the session card, with a soft edge when there's more below.
- **Commands** no longer scrolls sideways on phones.
- A department's **Overview** now lists applications to review and meetings needing attendance, so it matches the sidebar badge.

Bot: no change. Database change: no.

## 0.22.0 (2026-11-18)

**Added:**
- **Roles** (executives, under Hospital tools): a new role editor. Every server role is listed in Discord's order, grouped by Leadership, each department and other roles, with its colour, member count and a search.
- Open a role to switch on what it can do on the website: **Mod actions**, **Records**, **Discord logs**, **Incidents** and **Run sessions**, and for a department rank its department powers and change window. **Members** lists who holds it.
- Display, Bot commands, Discord permissions and History are coming next (editing roles in Discord through CareBeyond Helper).

**Changed:**
- Admin access is now set per role instead of being fixed. Nothing changed for anyone today: Administration Director, Leader and Team Member keep the hospital tools, Trainees don't, executives have everything.

Bot: no change.
Database change: yes, migrations 0050 (hospital permissions per role) and 0052 (role list reads); already applied.

## 0.21.4 (2026-11-18)

**Added:**
- **Clear pings:** **Dealt with**, **Snooze 30 days** or **On leave until** a date for quiet members (on Home and the Members tab); **Dismiss** for failed rank changes (in History).
- A switch by your name (the cog) to turn **quiet-member notes** off just for you.

Applications and attendance still clear only when the work is done.

Bot: no change.
Database change: yes, migration 0049 (dismissals and the notes switch; already applied).

## 0.21.3 (2026-11-18)

**Changed:**
- **To do badges:** open a department and the count moves onto the page that needs you (Members, Meetings, Applications, History).
- **Red** means it needs doing now; **orange** is a note: members quiet for 14 to 59 days (red from 60 days).
- **Home** splits **Needs you** from **Notes**.

Bot: no change.
Database change: yes, migration 0046 (badge severities; already applied).

## 0.21.2 (2026-11-18)

**Fixed:**
- Phones and Discord's browser now load the newest version of the site straight after an update, instead of an older saved copy for up to 10 minutes (this kept the 0.21.1 login fix from reaching some people).

Bot: no change. Database change: no.

## 0.21.1 (2026-11-18)

**Fixed:**
- Logging in with Discord inside **Discord's own browser** (and other in-app browsers) now works; you're no longer sent back to the login screen.

**Added:**
- **Continue as <your name>** for the last account used on this device, plus **Not you? Use another account**.
- Logging in brings you back to the page you were on.

**Changed:**
- A clear message if a login doesn't finish, pointing to **Log in with a code**.

Bot: no change. Database change: no.

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
