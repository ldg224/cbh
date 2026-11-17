// CareBeyond staff dashboard. Discord login through Supabase Auth.
// Staff-only access is enforced in the database (row level security), not here.
//
// The page never redraws by itself. It loads once after login, then quietly checks for changes
// (every 30 s while the tab is open, and when you come back to the tab). If something you can see
// has changed, it shows "Things have changed. [Refresh]" and only redraws when that button is pressed.
const sb = supabase.createClient(CBH_CONFIG.supabaseUrl, CBH_CONFIG.supabaseKey);
const $ = (id) => document.getElementById(id);
const CHECK_EVERY_MS = 30_000;
$('version').textContent = 'v' + window.CBH_VERSION;

let currentUserId;        // whose data is on screen (undefined until the first login check)
let shownSig = null;      // fingerprint of what is on screen
let pending = null;       // newer data waiting for the Refresh button
let checking = false;

// ---------- data ----------

const ROLE_FIELDS = 'id, name, color, position, kind, department, rank_label, rank_order, badge_color';

// Your own member row (the database only returns yours), your roles (highest first) and the department roles
// (for department colours, in case someone has a rank but not the hidden division role).
async function fetchMine() {
  const { data: me, error } = await sb.from('members').select('discord_id, display_name, avatar_url, role_ids, is_staff').maybeSingle();
  if (error) throw error;
  if (!me) return { me: null, roles: [], departments: [] };
  const ids = me.role_ids.length ? me.role_ids.join(',') : '0';
  const { data: rows, error: e2 } = await sb.from('roles').select(ROLE_FIELDS).or(`id.in.(${ids}),kind.eq.department`);
  if (e2) throw e2;
  const mine = new Set(me.role_ids);
  const roles = rows.filter((r) => mine.has(r.id)).sort((a, b) => b.position - a.position);
  const departments = rows.filter((r) => r.kind === 'department');
  const [acc, sess, perms] = await Promise.all([
    sb.rpc('my_access').then((r) => r.data || null, () => null),
    fetchSession(),
    // Rank permissions per department (migration 0027): {"Nursing": ["dept.view", ...]}. Directors and execs have all.
    sb.rpc('my_perms').then((r) => r.data || {}, () => ({})),
  ]);
  return { me, roles, departments, access: acc, session: sess, perms };
}

// The banner: a live session, else the next scheduled one, plus the join code (from the session or settings).
async function fetchSession() {
  try {
    const nowIso = new Date().toISOString();
    const [live, next, code] = await Promise.all([
      sb.from('sessions').select('id, status, note, host_name, started_at, scheduled_for, join_code').eq('status', 'live').order('started_at', { ascending: false }).limit(1),
      sb.from('sessions').select('id, status, note, host_name, started_at, scheduled_for, join_code').eq('status', 'scheduled').gt('scheduled_for', nowIso).order('scheduled_for').limit(5),
      sb.from('settings').select('value').eq('key', 'join_code').maybeSingle(),
    ]);
    return { live: live.data?.[0] || null, next: next.data?.[0] || null, upcoming: next.data || [], code: code.data?.value || null };
  } catch { return null; }
}

// Only what the page shows, so timestamps from the bot's routine resync don't count as a change.
// The page shows your name, photo and badges, so only those count (a new ping role, say, changes nothing on screen).
function fingerprint({ me, roles, departments, session }) {
  if (!me) return 'not-in-server';
  return JSON.stringify([me.display_name, me.avatar_url, buildBadges(roles, departments), session]);
}

// ---------- badges ----------
// Who someone is, at a glance, from their roles (the bot labels every role; see cbh/roles.py in the bot), most
// important first: leadership titles (Hospital Director...) > each department + its rank (Nursing Department,
// Year 5) > Executive > Verified. Someone with none of these gets a plain "Member" badge. Only one line shows;
// the rest go behind "+N" (fitBadges), so this order decides what people see first.
const hex = (n) => '#' + n.toString(16).padStart(6, '0');

// Badge icons (Icons8 ios_filled, see icons8.json), tinted with the role colour by CSS.
// Leadership roles by role ID (IDs never change when a role is renamed); any other leadership role gets the star.
const LEADERSHIP_ICON = {
  '1464007138882883725': 'crown',      // Hospital Director
  '1472796994316534005': 'briefcase',  // Chief Operations Officer
  '1472811961770049657': 'conference', // Board of Directors
};
const DEPARTMENT_ICON = {
  'Administration': 'clipboard',
  'Community Engagement': 'handshake',
  'Nursing': 'nurse',
  'Paramedicine': 'ambulance',
};

function buildBadges(roles, departments) {
  const out = [];
  for (const r of roles.filter((x) => x.kind === 'leadership')) {
    out.push({ label: r.name, color: r.badge_color, icon: LEADERSHIP_ICON[r.id] || 'star' });
  }
  const deptColour = Object.fromEntries(departments.map((d) => [d.department, d.badge_color]));
  const depts = [...new Set(roles.filter((x) => x.department).map((x) => x.department))];
  // most senior department first (by best rank held)
  const best = (d) => Math.max(0, ...roles.filter((x) => x.kind === 'rank' && x.department === d).map((x) => x.rank_order));
  depts.sort((a, b) => best(b) - best(a));
  for (const d of depts) {
    out.push({ label: d + ' Department', color: deptColour[d], icon: DEPARTMENT_ICON[d] });
    const rank = roles.filter((x) => x.kind === 'rank' && x.department === d).sort((a, b) => b.rank_order - a.rank_order)[0];
    if (rank) out.push({ label: rank.rank_label, color: rank.badge_color, joined: true });
  }
  if (roles.some((x) => x.kind === 'executive')) {
    const r = roles.find((x) => x.kind === 'executive');
    out.push({ label: 'Executive', color: r.badge_color, icon: 'star' });
  }
  if (roles.some((x) => x.kind === 'verified')) {
    out.push({ label: 'Verified', color: roles.find((x) => x.kind === 'verified').badge_color, icon: 'verified' });
  }
  if (!out.length) out.push({ label: 'Member', color: null, icon: 'user' });
  return out;
}

// Builds the badge elements as "units": a single badge, or a department + its year/rank pair (never split).
function badgeUnits(badges) {
  const units = [];
  let pair = null;
  for (const [i, b] of badges.entries()) {
    const el = document.createElement('span');
    el.className = 'rbadge' + (b.joined ? ' joined' : '');
    if (b.color) el.style.setProperty('--c', hex(b.color));
    if (b.icon) {
      const ic = document.createElement('span');
      ic.className = 'ri';
      ic.setAttribute('aria-hidden', 'true');
      ic.style.setProperty('--icon', `url("assets/icons/${b.icon}.png")`);
      el.append(ic);
    }
    const label = document.createElement('span');
    label.className = 'rl';
    label.textContent = b.label;
    el.append(label);
    if (badges[i + 1] && badges[i + 1].joined) {
      pair = document.createElement('span');
      pair.className = 'pair';
      pair.append(el);
      units.push(pair);
    } else if (b.joined && pair) {
      pair.append(el);
    } else {
      units.push(el);
    }
  }
  return units;
}

let badgeUnitsShown = [];   // all units for the person on screen, in priority order
let hiddenUnits = [];       // the ones behind "+N"

function drawBadges(badges) {
  closePop();
  badgeUnitsShown = badgeUnits(badges);
  $('badges').hidden = false;
  fitBadges();
}

// Show as many units as fit on one line, in order; the rest go behind a "+N" chip. Runs on draw, on resize and
// when the font finishes loading, so N is right at every width.
function fitBadges() {
  const row = $('badges');
  if (row.hidden || !badgeUnitsShown.length) return;
  const fits = () => row.scrollWidth <= row.clientWidth + 1;
  badgeUnitsShown.forEach((u) => u.classList.remove('shrink'));
  row.replaceChildren(...badgeUnitsShown);
  hiddenUnits = [];
  if (fits()) return;
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'more';
  more.setAttribute('aria-haspopup', 'dialog');
  more.setAttribute('aria-expanded', 'false');
  more.addEventListener('click', togglePop);
  for (let k = badgeUnitsShown.length - 1; k >= 1; k--) {
    badgeUnitsShown[k].remove();
    hiddenUnits.unshift(badgeUnitsShown[k]);
    more.textContent = '+' + hiddenUnits.length;
    more.setAttribute('aria-label', `${hiddenUnits.length} more badge${hiddenUnits.length > 1 ? 's' : ''}`);
    row.append(more);
    if (fits()) return;
  }
  // Even the most important badge alone doesn't fit (very narrow screen): let it shorten with "…".
  badgeUnitsShown[0].classList.add('shrink');
}

// ---------- "+N" popover ----------
function togglePop(e) {
  if ($('more-pop').hidden) openPop(e.currentTarget); else closePop();
}

function openPop(button) {
  const pop = $('more-pop');
  pop.replaceChildren(...hiddenUnits.map((u) => u.cloneNode(true)));
  pop.hidden = false;
  const r = button.getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight;
  const left = Math.min(Math.max(12, r.left), window.innerWidth - w - 12);
  const below = r.bottom + 8 + h <= window.innerHeight - 12;
  pop.style.left = left + 'px';
  pop.style.top = (below ? r.bottom + 8 : Math.max(12, r.top - 8 - h)) + 'px';
  button.setAttribute('aria-expanded', 'true');
  pop._button = button;
  pop.focus();
}

function closePop(returnFocus) {
  const pop = $('more-pop');
  if (pop.hidden) return;
  pop.hidden = true;
  if (pop._button) {
    pop._button.setAttribute('aria-expanded', 'false');
    if (returnFocus) pop._button.focus();
  }
}

document.addEventListener('pointerdown', (e) => {
  const pop = $('more-pop');
  if (!pop.hidden && !pop.contains(e.target) && e.target !== pop._button) closePop();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePop(true); });
$('more-pop').addEventListener('focusout', (e) => {
  const pop = $('more-pop');
  if (e.relatedTarget && !pop.contains(e.relatedTarget) && e.relatedTarget !== pop._button) closePop();
});
window.addEventListener('scroll', () => closePop(), { passive: true });
new ResizeObserver(() => { closePop(); fitBadges(); }).observe($('badges'));
if (document.fonts) document.fonts.ready.then(() => { closePop(); fitBadges(); });

// ---------- photo ----------
// The Discord profile photo (synced by the bot; server photo first), with the login's photo as a fallback.
let loginAvatar = null;

function sized(url, px) {
  try { const u = new URL(url); u.searchParams.set('size', String(px)); return u.toString(); } catch { return url; }
}

function setPhoto(url) {
  const src = url || loginAvatar;
  for (const [id, px] of [['photo', 256], ['avatar', 64]]) {
    const img = $(id);
    if (!src) { img.hidden = true; continue; }
    img.onerror = () => { img.hidden = true; };
    img.src = sized(src, px);
    img.hidden = false;
  }
}

// Names are shown without emoji: Discord's colourful emoji clash with the brand, and a person's badges already
// say who they are (e.g. the crown icon on Hospital Director). Falls back to the raw name if it was all emoji.
function cleanName(s) {
  const t = (s || '').replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\u{1F3FB}-\u{1F3FF}️‍⃣]/gu, '')
    .replace(/\s+/g, ' ').trim();
  return t || s || '';
}

// ---------- drawing ----------

function draw(data) {
  $('changed').hidden = true;
  pending = null;
  shownSig = fingerprint(data);
  const { me, roles, departments } = data;
  homeReady = !!me;
  if (!me) {
    $('badges').hidden = true;
    note("We couldn't find you in the CareBeyond - Hospital server. Join it with this Discord account, then refresh.");
    return;
  }
  $('welcome-name').textContent = cleanName(me.display_name);
  $('name').textContent = cleanName(me.display_name);
  setPhoto(me.avatar_url);
  // Who they are is shown only by badges (never as a sentence like "CareBeyond staff").
  drawBadges(buildBadges(roles, departments));
  myDiscordId = me.discord_id;
  myDepartments = (data.access && (data.access.shift_teams || data.access.teams)) || [...new Set(roles.filter((r) => r.department).map((r) => r.department))];
  myPerms = data.perms || {};
  setAccess(me, roles, data.access);
  buildSessionBanner(data.session);
  buildMenu();
  loadFailNotices();
  route();
  // No "how this page works" text: the note only appears for loading and errors.
  note('');
}

function note(text) {
  $('note').textContent = text;
  $('note').hidden = !text;
}

async function loadAndDraw() {
  note('Loading…');
  $('badges').hidden = true;
  try {
    draw(await fetchMine());
  } catch (err) {
    note("Couldn't load your details: " + (err.message || err));
  }
}

// ---------- change check (never redraws) ----------

async function checkForChanges() {
  if (!currentUserId || shownSig === null || checking || document.hidden) return;
  checking = true;
  try {
    const data = await fetchMine();
    loadFailNotices();
    if (fingerprint(data) !== shownSig) {
      pending = data;
      $('changed').hidden = false;
    }
  } catch {
    // offline or a hiccup: try again next time
  } finally {
    checking = false;
  }
}

$('refresh').addEventListener('click', () => {
  if (pending) draw(pending); else loadAndDraw();
});
setInterval(checkForChanges, CHECK_EVERY_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForChanges(); });

// ---------- login state ----------

// Called on every login event. Only redraws when the logged-in person actually changes
// (log in, log out, different account), not on background token renewals or tab switches.
function onSession(session) {
  $('loading').hidden = true;
  const user = session && session.user;
  const id = user ? user.id : null;
  if (id === currentUserId) return;
  currentUserId = id;
  shownSig = null;
  $('signed-out').hidden = !!user;
  $('signed-in').hidden = !user;
  $('who').hidden = !user;
  $('changed').hidden = true;
  $('menu').hidden = true;
  $('home').hidden = true;
  homeReady = false;
  $('page').hidden = true;
  $('session').hidden = true;
  $('session-admin').hidden = true;
  stopCodeLogin();
  showLoginView('main');
  if (!user) return;
  const meta = user.user_metadata || {};
  const name = meta.full_name || meta.custom_claims?.global_name || meta.name || 'staff member';
  $('name').textContent = cleanName(name);
  $('welcome-name').textContent = cleanName(name);
  loginAvatar = meta.avatar_url || null;
  setPhoto(null);
  loadAndDraw();
}

$('login').addEventListener('click', async () => {
  $('login-error').hidden = true;
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'discord',
    options: { redirectTo: location.origin + location.pathname, scopes: 'identify' },
  });
  if (error) {
    $('login-error').textContent = "Couldn't start Discord login: " + error.message;
    $('login-error').hidden = false;
  }
});

// ---------- home menu, hubs and pages ----------
// The owner's rules (Plans/CareBeyond/RESEARCH.md §6): as few pages as possible, tools grouped into HUBS, each
// person sees only what they can use, ordered Executive > Admin > Staff > Everyone, and each audience has its own
// colour. Pages are TEMPLATES for now (layout + placeholder blocks) until the back end for each lands.
const AUDIENCES = [
  { id: 'exec',     label: 'Executive' },
  { id: 'director', label: 'Directors' },
  { id: 'admin',    label: 'Admin' },
  { id: 'staff',    label: 'Staff' },
  { id: 'everyone', label: 'Everyone' },
];
// id = route (#id); hubs hold tools (#hub/tool). `photo`: a Roblox screenshot in assets/photos/ (tinted by CSS).
const DEPARTMENTS = [
  { id: 'administration', name: 'Administration', icon: 'clipboard', color: '#5c72ff' },
  { id: 'nursing', name: 'Nursing', icon: 'nurse', color: '#ff3d7e' },
  { id: 'paramedicine', name: 'Paramedicine', icon: 'ambulance', color: '#ff5533' },
  { id: 'community', name: 'Community Engagement', icon: 'handshake', color: '#ffaa00' },
];
const PAGES = [
  { id: 'exec', aud: 'exec', title: 'Executive hub', icon: 'crown', wide: true, tools: [
    { id: 'reports',  title: 'Activity',      icon: 'bar-chart', layout: 'reports' },
    { id: 'strikes',  title: 'Strikes',       icon: 'error',     layout: 'list', building: true },
    { id: 'announce', title: 'Announcements', icon: 'megaphone', layout: 'form', building: true },
    { id: 'settings', title: 'Bot settings',  icon: 'settings',  layout: 'settings' },
  ] },
  // Directors hub: sessions, plus one page per department for its Director (execs see all four).
  { id: 'directors', aud: 'director', title: 'Directors hub', icon: 'org-chart', wide: true, tools: [
    { id: 'sessions', title: 'Sessions', icon: 'calendar', layout: 'sessions', wide: true },   // pinned on top
    ...DEPARTMENTS.map((d) => ({ id: d.id, title: d.name, icon: d.icon, layout: 'dept', dept: d.name, aud: 'dir:' + d.name, color: d.color })),
  ] },
  { id: 'admin', aud: 'admin', title: 'Admin hub', icon: 'shield', wide: true, tools: [
    { id: 'sessions',     title: 'Sessions',     icon: 'calendar', layout: 'sessions' },
    { id: 'cases',        title: 'Mod actions',  icon: 'law',     layout: 'cases' },
    { id: 'logs',         title: 'Discord logs', icon: 'history', layout: 'logs' },
    { id: 'records',      title: 'Records',      icon: 'user-folder', layout: 'records' },
    { id: 'tickets',      title: 'Tickets',      icon: 'inbox',   layout: 'tickets' },
    { id: 'applications', title: 'Applications', icon: 'resume',  layout: 'review', aud: 'reviewer' },
  ] },
  { id: 'shifts',   aud: 'staff',    title: 'Shifts',         icon: 'clock',   layout: 'shifts' },
  { id: 'roster',   aud: 'staff',    title: 'Staff & roster', icon: 'people',  layout: 'people' },
  { id: 'rules',    aud: 'everyone', title: 'Rules & info',   icon: 'book',    layout: 'doc', building: true },
  { id: 'tickets',  aud: 'leads',    title: 'Team tickets',   icon: 'inbox',   layout: 'tickets' },   // leads who aren't admins
  { id: 'review',   aud: 'reviewer-lead', title: 'Applications', icon: 'resume', layout: 'review' },   // review-team leads who aren't admins
  { id: 'contact',  aud: 'everyone', title: 'Contact a team', icon: 'chat',    layout: 'contact' },
  { id: 'apply',    aud: 'everyone', title: 'Apply',          icon: 'resume',  layout: 'apply' },
  { id: 'commands', aud: 'everyone', title: 'Commands',       icon: 'console', layout: 'commands' },
];
// Who can see what. Derived from role kinds (cbh/roles.py): exec = leadership or Executive; admin = the
// Administration department, or exec; staff = the bot's is_staff flag.
let access = { exec: false, admin: false, staff: false, everyone: true };
let myDiscordId = null;
let myDepartments = [];   // departments I can start a shift in (from my roles)
function setAccess(me, roles, acc) {
  if (acc) {   // my_access() in Supabase: the same rules the database uses (RLS)
    access = { exec: !!acc.exec, admin: !!acc.admin, staff: !!acc.team || !!me.is_staff, everyone: true,
      leads: !acc.admin && (acc.leads || []).length > 0,
      // Applications: execs, Directors (has_perm always passes) and ranks granted applications.review (0027)
      reviewer: !!acc.exec || (acc.directs || []).length > 0 || Object.values(myPerms).some((p) => (p || []).includes('applications.review')) };
    access['reviewer-lead'] = access.reviewer && !acc.admin;
    setDirectorAccess(acc.directs, roles, !!acc.exec, acc.run_sessions);
    return;
  }
  const exec = roles.some((r) => r.kind === 'leadership' || r.kind === 'executive');
  const admin = exec || roles.some((r) => r.department === 'Administration');
  access = { exec, admin, staff: !!me.is_staff || admin, everyone: true };
  setDirectorAccess(null, roles, exec);
}
// Directors hub: departments I direct (my_access().directs; worked out from my roles until the database says).
let myDirects = [];
let myPerms = {};   // rank permissions per department (my_perms(), 0027); a department page opens with 'dept.view'
const hasPerm = (perm, dept) => !!access.exec || myDirects.includes(dept) || (myPerms[dept] || []).includes(perm);
function setDirectorAccess(directs, roles, exec, runSessions) {
  myDirects = directs || (exec ? DEPARTMENTS.map((d) => d.name)
    : roles.filter((r) => r.kind === 'rank' && r.rank_label === 'Director').map((r) => r.department));
  // A department page opens for its Director/execs, or anyone holding a permission there that gives them a tab
  // (the page then shows only those tabs; dept.js). activity.view / members.edit alone need dept.view to show anything.
  const PAGE_PERMS = ['dept.view', 'history.view', 'meetings.manage', 'meetings.attendance', 'courses.manage', 'applications.review', 'applications.settings'];
  for (const d of DEPARTMENTS) access['dir:' + d.name] = myDirects.includes(d.name) || (myPerms[d.name] || []).some((x) => PAGE_PERMS.includes(x));
  access.director = exec || DEPARTMENTS.some((d) => access['dir:' + d.name]);
  access.sessions = runSessions ?? (access.director || access.admin);
  // Sessions sit in both hubs; show them once, in the Directors hub, to people who can see it.
  access['sessions-admin'] = access.sessions && !access.director;
}
const canSee = (aud) => !!access[aud];
// A tool's access key (Sessions in the Admin hub has its own) and the audience colour its tile wears.
const toolAud = (page, t) => (t.layout === 'sessions' && page.id === 'admin') ? 'sessions-admin' : (t.layout === 'sessions' ? 'sessions' : (t.aud || page.aud));
const tileAud = (page, t) => t.aud === 'reviewer' ? 'exec' : (AUDIENCES.some((x) => x.id === t.aud) ? t.aud : page.aud);
const iconUrl = (name) => `url('assets/icons/${name}.png')`;   // single quotes: also used inside style="..."

function tileEl(href, p, aud, extra = '') {
  const a = document.createElement('a');
  a.className = `tile aud-${aud}${p.wide ? ' wide' : ''}${p.photo ? ' has-photo' : ''} ${extra}`;
  a.href = href;
  a.style.setProperty('--icon', iconUrl(p.icon));
  if (p.photo) {
    const img = document.createElement('img');
    img.className = 'tile-photo';
    img.src = p.photo;
    img.alt = '';
    img.loading = 'lazy';
    a.append(img);
  }
  a.insertAdjacentHTML('beforeend',
    '<span class="tile-mark" aria-hidden="true"></span><span class="tile-badge" aria-hidden="true"><span></span></span>');
  const t = document.createElement('span');
  t.className = 'tile-title';
  t.textContent = p.title;
  a.append(t);
  if (p.building) a.insertAdjacentHTML('beforeend', '<span class="tile-flag building">Being built</span>');
  return a;
}

// Home (0.13.0, owner): no hubs. One clearly separated block per audience, most important first, holding every tool
// that person can use. Hub tools keep their routes (#admin/records); hub pages themselves just lead home.
function menuItems(audId) {
  const items = [];
  for (const hub of PAGES.filter((p) => p.tools && p.aud === audId && canSee(p.aud))) {
    for (const t of hub.tools.filter((x) => canSee(toolAud(hub, x)))) items.push({ href: `#${hub.id}/${t.id}`, def: t, aud: tileAud(hub, t), hub });
  }
  for (const p of PAGES.filter((x) => !x.tools && canSee(x.aud) && (x.aud === audId || (audId === 'staff' && ['leads', 'reviewer-lead'].includes(x.aud))))) {
    items.push({ href: '#' + p.id, def: p, aud: audId });
  }
  return items;
}
function buildMenu() {
  const nav = $('menu');
  nav.replaceChildren();
  for (const aud of AUDIENCES) {
    const items = menuItems(aud.id);
    if (!items.length) continue;
    const group = document.createElement('section');
    group.className = `menu-group sect aud-${aud.id}`;
    group.innerHTML = `<h2 class="menu-label"><span class="aud-dot"></span>${aud.label}</h2>`;
    const grid = document.createElement('div');
    const plain = items.filter((i) => !i.def.wide);
    grid.className = aud.id === 'director' ? 'menu-grid hub-dir' : 'menu-grid' + (plain.length === 2 ? ' n2' : [3, 5, 6].includes(plain.length) ? ' n3' : '');
    for (const it of items) {
      const a = tileEl(it.href, it.def, it.aud, 'tool');
      if (it.def.color) a.style.setProperty('--dept', it.def.color);
      if (it.def.aud === 'reviewer') a.insertAdjacentHTML('beforeend', '<span class="tile-flag">Execs & team leads</span>');
      if (it.def.layout === 'sessions' && currentSession && (currentSession.live || currentSession.next)) {
        const live = currentSession.live;
        a.insertAdjacentHTML('beforeend', `<span class="tile-flag${live ? ' live' : ''}">${live ? 'Live now' : esc('Next: ' + whenAhead(currentSession.next.scheduled_for))}</span>`);
      }
      grid.append(a);
    }
    group.append(grid);
    nav.append(group);
  }
}

// Placeholder building blocks for the templates.
const sk = (w, h, extra = '') => `<span class="sk ${extra}" style="width:${w};height:${h}px"></span>`;
const lines = (...ws) => ws.map((w) => sk(w, 12)).join('<span style="display:block;height:9px"></span>');
const rows = (n, right) => `<div class="card">${Array.from({ length: n }, () =>
  `<div class="row-item">${sk('34px', 34, 'round')}<div style="flex:1">${lines('42%', '24%')}</div>${right}</div>`).join('')}</div>`;
const stat3 = () => `<div class="grid-3">${[0, 1, 2].map(() =>
  `<div class="card tight">${sk('45%', 11)}<div style="height:12px"></div>${sk('58%', 30)}</div>`).join('')}</div>`;
const LAYOUTS = {
  stats: () => stat3() + `<div class="card">${sk('30%', 14)}<div style="height:18px"></div>${sk('100%', 180)}</div>` + rows(4, sk('64px', 22, 'pill')),
  list: () => `<div class="toolbar">${sk('220px', 38, 'pill')}${sk('120px', 38, 'pill')}</div>` + rows(6, sk('72px', 22, 'pill')),
  log: () => `<div class="toolbar">${['70px', '90px', '80px', '110px'].map((w) => sk(w, 30, 'pill')).join('')}</div>` +
    `<div class="card">${Array.from({ length: 8 }, () => `<div class="row-item">${sk('52px', 12)}<div style="flex:1">${lines('65%')}</div>${sk('40px', 12)}</div>`).join('')}</div>`,
  form: () => `<div class="card form-sk">${sk('30%', 12)}${sk('100%', 42)}${sk('30%', 12)}${sk('100%', 120)}<div style="display:flex;justify-content:flex-end">${sk('140px', 42, 'pill')}</div></div>`,
  settings: () => `<div class="card">${Array.from({ length: 5 }, () => `<div class="row-item"><div style="flex:1">${lines('35%', '55%')}</div>${sk('46px', 26, 'pill')}</div>`).join('')}</div>`,
  shifts: () => `<div class="card" style="display:flex;align-items:center;gap:18px;flex-wrap:wrap">${sk('64px', 64, 'round')}<div style="flex:1;min-width:160px">${lines('35%', '55%')}</div>${sk('150px', 44, 'pill')}</div>` + stat3() + rows(4, sk('70px', 14)),
  people: () => `<div class="toolbar">${['90px', '120px', '110px', '130px'].map((w) => sk(w, 30, 'pill')).join('')}</div>` +
    `<div class="grid-people">${Array.from({ length: 8 }, () => `<div class="card person">${sk('64px', 64, 'round')}${sk('70%', 13)}${sk('55%', 22, 'pill')}</div>`).join('')}</div>`,
  doc: () => Array.from({ length: 4 }, () => `<div class="card">${sk('38%', 16)}<div style="height:14px"></div>${lines('100%', '94%', '70%')}</div>`).join(''),
  contact: () => `<div class="team-pick">${Array.from({ length: 4 }, () => `<div class="card tight team-sk">${sk('40px', 40, 'round')}${sk('70%', 13)}</div>`).join('')}</div>` +
    `<div class="card form-sk">${sk('25%', 12)}${sk('100%', 120)}<div style="display:flex;justify-content:flex-end">${sk('140px', 42, 'pill')}</div></div>`,
  commands: () => commandsPage(),
};

const BUILDING_NOTE = (title) => `<div class="card building-note"><span class="t-ico" style="--c:#3a82d0;--icon:${iconUrl('settings')}" aria-hidden="true"></span>
  <div class="case-main"><strong>${esc(title)} is being built</strong><span class="muted small-meta">This is the layout it will have. Nothing here works yet.</span></div></div>`;

// Bot commands, grouped by who can use them (from Bravo; bot replies are private to the person who ran it).
// Static for now; Bravo tells us about changes. Later the bot may sync this list to Supabase.
const COMMAND_GROUPS = [
  { aud: 'everyone', title: 'Everyone', cmds: [
    ['/login', 'code', 'Log in to this website with the code from "Log in with a code".'],
  ] },
  { aud: 'admin', title: 'Admins · moderation', note: 'Each is saved as a case (see Mod actions), posted to #server-logs, and the member gets a DM where possible. You can\u2019t act on someone with the same or a higher role.', cmds: [
    ['/warn', 'member reason', 'Warn a member.'],
    ['/timeout', 'member length reason', 'Time out for 10 minutes, 1 hour, 6 hours, 1 day, 3 days or 1 week.'],
    ['/untimeout', 'member [reason]', 'Remove a timeout.'],
    ['/kick', 'member reason', 'Kick a member.'],
    ['/ban', 'member reason [delete_messages]', 'Ban a member, optionally deleting their last 1 or 7 days of messages.'],
    ['/unban', 'user_id reason', 'Unban someone by their Discord ID.'],
  ] },
];
// Owner's rule: Discord keeps only these 7 commands; everything else is done on this website.
function commandsPage() {
  return COMMAND_GROUPS.map((g) => `
    <section class="cmd-group aud-${g.aud}">
      <h2 class="menu-label"><span class="aud-dot"></span>${esc(g.title)}</h2>
      ${g.note ? `<p class="muted small cmd-note">${esc(g.note)}</p>` : ''}
      <div class="card">${g.cmds.map(([name, args, what]) => `
        <div class="row-item cmd-row">
          <code class="cmd">${esc(name)}${args ? ` <span class="cmd-args">${esc(args)}</span>` : ''}</code>
          <div class="cmd-what">${esc(what)}</div>
        </div>`).join('')}</div>
    </section>`).join('');
}

// #exec, #admin/logs, #shifts… Anything else = home. Only while logged in, and only pages this person may see.
let homeReady = false;   // the new home (home.js) shows once your member row has loaded
function findRoute() {
  // The bot links every application to #admin/applications/<id>; reviewers outside Admin use #review/<id>.
  if (location.hash.startsWith('#admin/applications') && !canSee('admin') && canSee('reviewer-lead')) {
    location.replace('#review' + location.hash.slice('#admin/applications'.length)); return null;
  }
  const [a, b] = location.hash.slice(1).split('/');
  if (a === 'f') {   // a folder opened as its own page (home.js)
    const folder = FOLDERS.find((f) => f.id === b);
    return folder && myTools().some((t) => t.folder === folder.id) ? { folder } : null;
  }
  const page = PAGES.find((p) => p.id === a && canSee(p.aud));
  if (!page) return null;
  if (!b) return { page };
  const tool = (page.tools || []).find((t) => t.id === b && canSee(toolAud(page, t)));
  return tool ? { page, tool } : { page };
}

function setPageTitle(icon, text, aud) {
  const h = $('page-title');
  h.className = `page-title aud-${aud}`;
  h.innerHTML = `<span class="pt-ico" style="--icon:${iconUrl(icon)}" aria-hidden="true"></span>`;
  h.append(document.createTextNode(text));
}

function route() {
  if (!currentUserId) return;
  closePop();
  const r = findRoute();
  // 0.14.0: the home page is home.js (search, Session active, pins, folders). The old Welcome card only shows
  // while loading or when something is wrong (its note), and the old menu and session banner are retired.
  $('signed-in').hidden = !!r || homeReady;
  $('session').hidden = true;
  $('session-admin').hidden = true;
  $('menu').hidden = true;
  $('home').hidden = !!r || !homeReady;
  $('page').hidden = !r;
  $('page-title').hidden = false;
  if (!r) { document.title = 'CareBeyond'; if (homeReady) renderHome(); return; }
  const back = $('page').querySelector('.back');
  back.href = '#';
  back.lastChild.textContent = 'Home';
  if (r.folder) {
    $('page-title').hidden = true;
    $('page-body').classList.remove('is-building');
    document.title = r.folder.title + ' · CareBeyond';
    renderFolder($('page-body'), r.folder);
    window.scrollTo(0, 0);
    return;
  }
  const { page, tool } = r;
  if (page.tools && !tool) { location.replace('#'); return; }   // no hub pages any more (0.13.0)
  const body = $('page-body');
  body.classList.remove('is-building');
  if (tool) {
    setPageTitle(tool.icon, tool.title, tileAud(page, tool));
    if (LIVE[tool.layout]) LIVE[tool.layout](body, tool);
    else { body.innerHTML = (tool.building ? BUILDING_NOTE(tool.title) : '') + LAYOUTS[tool.layout](); body.classList.toggle('is-building', !!tool.building); }
  } else if (page.tools) {
    setPageTitle(page.icon, page.title, page.aud);
    const grid = document.createElement('div');
    grid.className = 'hub-grid' + (page.id === 'directors' ? ' hub-dir' : '');
    for (const t of page.tools.filter((x) => canSee(toolAud(page, x)))) {
      const a = tileEl(`#${page.id}/${t.id}`, t, tileAud(page, t), 'tool');
      if (t.color) a.style.setProperty('--dept', t.color);   // department tiles: Directors violet into the department's colour
      if (t.layout === 'sessions' && currentSession) {
        const live = currentSession.live, next = currentSession.next;
        if (live || next) a.insertAdjacentHTML('beforeend', `<span class="tile-flag${live ? ' live' : ''}">${live ? 'Live now' : esc('Next: ' + whenAhead(next.scheduled_for))}</span>`);
      }
      if (t.aud && t.aud !== page.aud && AUDIENCES.some((x) => x.id === t.aud) || t.aud === 'reviewer') {
        a.insertAdjacentHTML('beforeend', `<span class="tile-flag">${t.aud === 'reviewer' ? 'Execs & team leads' : AUDIENCES.find((x) => x.id === t.aud).label + ' only'}</span>`);
      }
      grid.append(a);
    }
    body.replaceChildren(grid);
  } else {
    setPageTitle(page.icon, page.title, ['leads', 'reviewer-lead'].includes(page.aud) ? 'staff' : page.aud);
    if (LIVE[page.layout]) LIVE[page.layout](body);
    else { body.innerHTML = (page.building ? BUILDING_NOTE(page.title) : '') + LAYOUTS[page.layout](); body.classList.toggle('is-building', !!page.building); }
  }
  document.title = (tool ? tool.title : page.title) + ' · CareBeyond';
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

// ---------- live pages (data from Supabase; back end by Bravo, migration 0004) ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function when(iso) {
  if (!iso) return '';
  const d = new Date(iso), now = Date.now(), diff = (now - d) / 1000;
  if (diff >= 0 && diff < 60) return 'just now';
  if (diff >= 0 && diff < 3600) return Math.floor(diff / 60) + ' min ago';
  if (diff >= 0 && diff < 86400 && d.getDate() === new Date().getDate()) return 'today ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function whenAhead(iso) {
  const d = new Date(iso);
  const day = d.toDateString() === new Date().toDateString() ? 'Today' : d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  return `${day} at ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

function liveError(body, err) {
  body.insertAdjacentHTML('beforeend', `<p class="error">Couldn't load this: ${esc(err.message || err)}</p>`);
}

// ----- Mod actions (#admin/cases) -----
// Discord: pick a member (by ID, nickname or username); CareBeyond Helper carries the action out (DM, then the action,
// then #server-logs) and marks it Done or Failed. In game: a record only, against a real, full Roblox username.
// Back end (Bravo, migration 0012): mod_member_search, mod_cases.status/error, the roblox-user Edge Function.
const DISCORD_ACTIONS = [
  { id: 'warn', label: 'Warn' }, { id: 'timeout', label: 'Timeout' }, { id: 'untimeout', label: 'Remove timeout' },
  { id: 'kick', label: 'Kick' }, { id: 'ban', label: 'Ban' }, { id: 'unban', label: 'Unban' },
];
const TIMEOUT_LENGTHS = [[10, '10 minutes'], [60, '1 hour'], [360, '6 hours'], [1440, '1 day'], [4320, '3 days'], [10080, '1 week']];
const GAME_ACTIONS = [{ id: 'warn', label: 'Warn' }, { id: 'kick', label: 'Kick' }, { id: 'ban', label: 'Ban' }, { id: 'note', label: 'Note' }];
const CASE_FILTERS = [{ id: 'all', label: 'All' }, { id: 'warn', label: 'Warn' }, { id: 'timeout', label: 'Timeout' }, { id: 'kick', label: 'Kick' },
  { id: 'ban', label: 'Ban' }, { id: 'unban', label: 'Unban' }, { id: 'note', label: 'Note' }];
const ACTION_LABEL = { warn: 'Warn', timeout: 'Timeout', untimeout: 'Timeout removed', kick: 'Kick', ban: 'Ban', unban: 'Unban', note: 'Note' };
const ACTION_VERB = { warn: 'Warn', timeout: 'Time out', untimeout: 'Remove timeout for', kick: 'Kick', ban: 'Ban', unban: 'Unban' };
const SOURCE_LABEL = { discord: 'Discord', website: 'Discord (website)', in_game: 'In game' };
const CASE_STATUS = { pending: ['sub-pending', 'Pending'], failed: ['sub-denied', 'Failed'] };
let caseWatch = null;

// renderCases (Mod actions) lives in cases.js since the 0.15.x redesign.

// ----- Failed Mod actions: a red notice at the top for the person who asked, closed with X (gone for good) -----
const warnText = (n) => (n ? ` · ${n} warning${n == 1 ? '' : 's'}` : '');
async function loadFailNotices() {
  // 0.15.x: one calm line ("2 of your actions didn't go through") that expands, instead of a stack of red bars.
  // Mod actions shows these in its own list, so the line hides there.
  const box = $('fail-notes');
  if (!myDiscordId || !access.admin || location.hash === '#admin/cases') { box.hidden = true; return; }
  const { data, error } = await sb.from('mod_cases').select('id, action, target_name, error')
    .eq('status', 'failed').eq('moderator_discord_id', myDiscordId).is('dismissed_at', null).order('id', { ascending: false }).limit(10);
  if (error) return;   // e.g. before the database has dismissed_at: show nothing rather than an error
  const ids = (data || []).map((c) => c.id).join();
  if (box.dataset.ids === ids && !box.hidden === !!ids) return;   // nothing new: leave it alone
  box.dataset.ids = ids;
  box.hidden = !(data || []).length;
  if (box.hidden) { box.innerHTML = ''; return; }
  const open = box.querySelector('.fn-sum')?.getAttribute('aria-expanded') === 'true';
  box.innerHTML = `<div class="fail-note" role="status">
      <span class="fn-ico" aria-hidden="true"></span>
      <button type="button" class="fn-sum" aria-expanded="${open}" aria-controls="fn-list">${data.length === 1 ? '1 of your actions' : data.length + ' of your actions'} didn\u2019t go through</button>
      <a class="fn-go" href="#admin/cases">Open Mod actions</a>
      <button type="button" class="fn-x" aria-label="Dismiss all">&times;</button></div>
    <ul class="fn-list" id="fn-list" ${open ? '' : 'hidden'}>${data.map((c) => `<li><strong>${esc(ACTION_LABEL[c.action] || c.action)} on ${esc(cleanName(c.target_name || ''))}:</strong> ${esc(c.error || 'it didn\u2019t go through.')}</li>`).join('')}</ul>`;
  box.querySelector('.fn-sum').onclick = (e) => {
    const on = e.currentTarget.getAttribute('aria-expanded') !== 'true';
    e.currentTarget.setAttribute('aria-expanded', String(on));
    box.querySelector('.fn-list').hidden = !on;
  };
  box.querySelector('.fn-go').onclick = () => { box.hidden = true; };
  box.querySelector('.fn-x').onclick = async () => {
    box.hidden = true; box.innerHTML = ''; box.dataset.ids = '';
    await Promise.all(data.map((c) => sb.rpc('dismiss_failed', { case_id: c.id })));
  };
}

// Records (#admin/records) lives in records.js since the 0.15.x redesign.

// Discord logs (#admin/logs) lives in logs.js since the 0.16.x redesign.

const LIVE = {};   // logs, cases and records: added by logs.js, cases.js and records.js

// ----- Contact a team (#contact) and team tickets (#admin/tickets, #tickets) -----
// Back end by Bravo (migration 0005): a ticket opens a private thread in the team's Discord channel; replies flow
// both ways (Discord thread / DMs <-> website).
const TEAMS = [
  { id: 'Administration', label: 'Administration', sub: 'Support', icon: 'clipboard', color: 0x5C72FF },
  { id: 'Nursing', label: 'Nursing', sub: '', icon: 'nurse', color: 0xFF3D7E },
  { id: 'Paramedicine', label: 'Paramedicine', sub: '', icon: 'ambulance', color: 0xFF5533 },
  { id: 'Community Engagement', label: 'Community Engagement', sub: 'Partnerships', icon: 'handshake', color: 0xFFAA00 },
];
const STATUS_LABEL = { open: 'Open', claimed: 'Claimed', closed: 'Closed' };
const teamOf = (id) => TEAMS.find((t) => t.id === id) || TEAMS[0];

function ticketRow(t, showOpener) {
  const team = teamOf(t.team);
  return `<button class="row-item ticket" data-id="${t.id}">
    <span class="t-ico" style="--c:${hex(team.color)};--icon:${iconUrl(team.icon)}" aria-hidden="true"></span>
    <span class="case-main">
      <strong>${esc(t.subject)}</strong>
      <span class="muted small-meta">${esc(team.label)}${showOpener ? ` · from ${esc(t.opener_name || 'unknown')}` : ''}${t.claimed_by_name ? ` · ${esc(t.claimed_by_name)} has it` : ''} · ${when(t.created_at)}</span>
    </span>
    <span class="st st-${esc(t.status)}">${esc(STATUS_LABEL[t.status] || t.status)}</span>
  </button>`;
}

// One conversation. `staff`: show Claim / Close and send replies as staff.
async function renderThread(body, ticket, { staff, back }) {
  const team = teamOf(ticket.team);
  body.innerHTML = `
    <button class="back inline-back" type="button"><span class="back-ico" aria-hidden="true"></span>All tickets</button>
    <div class="card thread-head">
      <span class="t-ico" style="--c:${hex(team.color)};--icon:${iconUrl(team.icon)}" aria-hidden="true"></span>
      <div class="case-main"><strong class="thread-subject">${esc(ticket.subject)}</strong>
        <span class="muted small-meta">${esc(team.label)}${staff ? ` · from ${esc(ticket.opener_name || 'unknown')}` : ''} · ${when(ticket.created_at)}</span></div>
      <span class="st st-${esc(ticket.status)}">${esc(STATUS_LABEL[ticket.status])}</span>
    </div>
    ${staff && ticket.status !== 'closed' ? `<div class="toolbar">${ticket.status === 'open' ? '<button class="ghost" id="t-claim">Claim</button>' : ''}<button class="ghost" id="t-close">Close ticket</button></div>` : ''}
    <div class="card msgs" id="t-msgs"><p class="muted small">Loading…</p></div>
    ${ticket.status !== 'closed' ? `<form class="card reply" id="t-reply">
      <textarea id="t-body" rows="3" maxlength="2000" required placeholder="Write a reply"></textarea>
      <p class="error" id="t-err" hidden></p>
      <div class="f-actions"><button class="refresh" type="submit">Send</button></div></form>` : ''}`;
  body.querySelector('.inline-back').onclick = back;
  const msgs = body.querySelector('#t-msgs');
  async function load() {
    const { data, error } = await sb.from('ticket_messages').select('*').eq('ticket_id', ticket.id).order('created_at');
    if (error) { msgs.innerHTML = ''; return liveError(msgs, error); }
    msgs.innerHTML = data.length ? data.map((m) => `
      <div class="msg${m.from_staff ? ' staff' : ''}${m.author_discord_id === myDiscordId ? ' mine' : ''}">
        <div class="msg-meta">${esc(m.author_name || 'Unknown')}${m.from_staff ? ' · ' + esc(team.label) : ''} · ${when(m.created_at)}</div>
        <div class="msg-body">${esc(m.body)}</div>
      </div>`).join('') : '<p class="muted small">No messages yet.</p>';
  }
  const form = body.querySelector('#t-reply');
  if (form) form.onsubmit = async (e) => {
    e.preventDefault();
    const text = body.querySelector('#t-body').value.trim();
    if (!text) return;
    const row = { ticket_id: ticket.id, author_discord_id: myDiscordId, author_name: $('name').textContent, body: text };
    if (staff) row.from_staff = true;
    const { error } = await sb.from('ticket_messages').insert(row);
    const err = body.querySelector('#t-err');
    if (error) { err.textContent = "Couldn't send: " + error.message; err.hidden = false; return; }
    err.hidden = true; form.reset(); load();
  };
  const upd = async (patch) => {
    const { error } = await sb.from('tickets').update(patch).eq('id', ticket.id);
    if (error) return liveError(body, error);
    Object.assign(ticket, patch);
    renderThread(body, ticket, { staff, back });
  };
  body.querySelector('#t-claim')?.addEventListener('click', () =>
    upd({ status: 'claimed', claimed_by_discord_id: myDiscordId, claimed_by_name: $('name').textContent }));
  body.querySelector('#t-close')?.addEventListener('click', () => {
    if (confirm('Close this ticket? The Discord thread will be archived.')) upd({ status: 'closed', closed_at: new Date().toISOString() });
  });
  load();
}

async function renderContact(body) {
  body.innerHTML = `
    <form class="card case-form" id="c-form">
      <div class="team-pick" id="c-team">${TEAMS.map((t, i) => `
        <button type="button" class="team${i === 0 ? ' on' : ''}" data-t="${esc(t.id)}" style="--c:${hex(t.color)}">
          <span class="t-ico" style="--icon:${iconUrl(t.icon)}" aria-hidden="true"></span>
          <span class="team-name">${esc(t.label)}</span>${t.sub ? `<span class="team-sub">${esc(t.sub)}</span>` : ''}
        </button>`).join('')}</div>
      <label class="f"><span>Subject</span><input id="c-subject" required maxlength="120"></label>
      <label class="f"><span>Message</span><textarea id="c-body" required maxlength="2000" rows="4"></textarea></label>
      <p class="error" id="c-err" hidden></p>
      <div class="f-actions"><button class="refresh" type="submit">Send</button></div>
    </form>
    <h2 class="menu-label aud-everyone"><span class="aud-dot"></span>Your tickets</h2>
    <div class="card" id="c-list"><p class="muted small">Loading…</p></div>`;
  let team = TEAMS[0].id;
  body.querySelector('#c-team').onclick = (e) => {
    const b = e.target.closest('.team'); if (!b) return;
    team = b.dataset.t;
    body.querySelectorAll('#c-team .team').forEach((x) => x.classList.toggle('on', x === b));
  };
  body.querySelector('#c-form').onsubmit = async (e) => {
    e.preventDefault();
    const err = body.querySelector('#c-err'); err.hidden = true;
    const subject = body.querySelector('#c-subject').value.trim(), text = body.querySelector('#c-body').value.trim();
    const { data: t, error } = await sb.from('tickets').insert({ team, subject, opener_discord_id: myDiscordId, opener_name: $('name').textContent }).select().single();
    if (error) { err.textContent = "Couldn't send: " + error.message; err.hidden = false; return; }
    const { error: e2 } = await sb.from('ticket_messages').insert({ ticket_id: t.id, author_discord_id: myDiscordId, author_name: $('name').textContent, body: text });
    if (e2) { err.textContent = "Your ticket was opened but the message didn't send: " + e2.message; err.hidden = false; return; }
    renderThread(body, t, { staff: false, back: () => renderContact(body) });
  };
  const list = body.querySelector('#c-list');
  const { data, error } = await sb.from('tickets').select('*').eq('opener_discord_id', myDiscordId).order('created_at', { ascending: false });
  if (error) { list.innerHTML = ''; return liveError(list, error); }
  list.innerHTML = data.length ? data.map((t) => ticketRow(t, false)).join('') : '<p class="muted small">You haven’t contacted a team yet.</p>';
  list.onclick = (e) => {
    const b = e.target.closest('.ticket'); if (!b) return;
    renderThread(body, data.find((x) => String(x.id) === b.dataset.id), { staff: false, back: () => renderContact(body) });
  };
}

async function renderTeamTickets(body) {
  let filter = 'active';
  body.innerHTML = `
    <div class="toolbar"><div class="chips" id="tk-filter">
      <button class="chip on" data-f="active">Open</button><button class="chip" data-f="closed">Closed</button></div></div>
    <div class="card" id="tk-list"><p class="muted small">Loading…</p></div>`;
  body.querySelector('#tk-filter').onclick = (e) => {
    const b = e.target.closest('.chip'); if (!b) return;
    filter = b.dataset.f;
    body.querySelectorAll('#tk-filter .chip').forEach((x) => x.classList.toggle('on', x === b));
    load();
  };
  const list = body.querySelector('#tk-list');
  async function load() {
    let q = sb.from('tickets').select('*').order('created_at', { ascending: false }).limit(100);
    q = filter === 'closed' ? q.eq('status', 'closed') : q.in('status', ['open', 'claimed']);
    const { data, error } = await q;
    if (error) { list.innerHTML = ''; return liveError(list, error); }
    list.innerHTML = data.length ? data.map((t) => ticketRow(t, true)).join('') : `<p class="muted small">${filter === 'closed' ? 'No closed tickets.' : 'No open tickets.'}</p>`;
    list.onclick = (e) => {
      const b = e.target.closest('.ticket'); if (!b) return;
      renderThread(body, data.find((x) => String(x.id) === b.dataset.id), { staff: true, back: () => renderTeamTickets(body) });
    };
  }
  load();
}

LIVE.contact = renderContact;
LIVE.tickets = renderTeamTickets;

// ----- Apply (#apply) and Applications (#admin/applications, #review): applications.js (0028). -----
// Questions come from the forms table, edited by executives on the Applications page.

function questionField(q) {
  const id = `q-${esc(q.id)}`, req = q.required ? 'required' : '';
  const label = `<span>${esc(q.label)}${q.required ? '' : ' <em>(optional)</em>'}</span>`;
  switch (q.type) {
    case 'long': return `<label class="f">${label}<textarea id="${id}" rows="4" maxlength="4000" ${req}></textarea></label>`;
    case 'number': return `<label class="f">${label}<input id="${id}" type="number" ${req}></label>`;
    case 'choice': return `<label class="f">${label}<select id="${id}" ${req}><option value="">Choose…</option>${(q.options || []).map((o) => `<option>${esc(o)}</option>`).join('')}</select></label>`;
    case 'yesno': return `<div class="f">${label}<div class="seg" data-yesno="${id}"><button type="button" class="seg-btn" data-v="Yes">Yes</button><button type="button" class="seg-btn" data-v="No">No</button></div></div>`;
    default: return `<label class="f">${label}<input id="${id}" maxlength="300" ${req}></label>`;
  }
}

// The Apply and Applications pages live in applications.js since the 0.19.x redesign (questionField stays here).

// ----- Shifts (#shifts) -----
const shiftSecs = (s, now = Date.now()) => Math.max(0, ((s.ended_at ? new Date(s.ended_at) : now) - new Date(s.started_at)) / 1000
  - (s.break_seconds || 0) - (s.status === 'break' && s.break_started_at ? (now - new Date(s.break_started_at)) / 1000 : 0));
const clock = (sec) => { sec = Math.floor(sec); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), x = sec % 60; return `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}`; };
const hrs = (sec) => { const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60); return h ? `${h}h ${m}m` : `${m}m`; };
function weekStartSydney() {
  // Monday 00:00 in Sydney, as an ISO time.
  const parts = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  const dow = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday'));
  const offsetMin = -new Date(new Date().toLocaleString('en-US', { timeZone: 'UTC' })).getTime() / 60000 + new Date(new Date().toLocaleString('en-US', { timeZone: 'Australia/Sydney' })).getTime() / 60000;
  const local = Date.UTC(+get('year'), +get('month') - 1, +get('day') - dow);
  return new Date(local - offsetMin * 60000).toISOString();
}

// Shifts page (0.15.x redesign, Bravo): your shift as one card (status, live timer, department, actions, this week /
// last 30 days), who's on now grouped by department with photos, and your history grouped by week.
// Back end: shift_start / shift_break / shift_end RPCs; the bot does the status roles, #shift-logs and auto-end.
const deptOf = (name) => DEPARTMENTS.find((d) => d.name === name) || { name, color: '#3a82d0', icon: 'clock' };
const shiftTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function weekLabel(startIso, thisWeek) {
  const s = new Date(startIso), last = new Date(new Date(thisWeek) - 7 * 864e5);
  if (s >= new Date(thisWeek)) return 'This week';
  if (s >= last) return 'Last week';
  return 'Week of ' + s.toLocaleDateString([], { day: 'numeric', month: 'short' });
}
function weekStartOf(iso, thisWeek) {
  // The Monday (Sydney) on or before this time, counting back from this week's Monday.
  let w = new Date(thisWeek).getTime();
  const t = new Date(iso).getTime();
  while (t < w) w -= 7 * 864e5;
  return new Date(w).toISOString();
}

async function renderShifts(body) {
  if (!body.querySelector('.sh-card')) body.innerHTML = '<div class="card"><p class="muted small">Loading your shifts…</p></div>';
  const week = weekStartSydney();
  const since30 = new Date(Date.now() - 30 * 864e5).toISOString();
  const [on, mine, ros] = await Promise.all([
    sb.from('shifts').select('*').neq('status', 'ended').order('started_at'),
    sb.from('shifts').select('*').eq('discord_id', myDiscordId).gte('started_at', since30 < week ? since30 : week)
      .order('started_at', { ascending: false }).limit(60),
    sb.rpc('roster').then((r) => r, () => ({ data: [] })),
  ]);
  if (on.error || mine.error) { body.innerHTML = ''; return liveError(body, on.error || mine.error); }
  const photo = Object.fromEntries((ros.data || []).map((p) => [p.discord_id, p.avatar_url]));
  const myNow = (on.data || []).find((s) => s.discord_id === myDiscordId);
  const past = (mine.data || []).filter((s) => s.status === 'ended');
  const sumSince = (from) => past.filter((s) => s.started_at >= from).reduce((a, s) => a + shiftSecs(s), 0);
  const pastWeek = sumSince(week), past30 = sumSince(since30);
  const liveExtra = () => (myNow ? shiftSecs(myNow) : 0);
  const state = myNow ? (myNow.status === 'break' ? 'break' : 'on') : 'off';
  const d = myNow ? deptOf(myNow.department) : null;

  const actions = myNow
    ? `<button class="ghost" id="sh-break">${myNow.status === 'break' ? 'End break' : 'Take a break'}</button>
       <button class="refresh" id="sh-end">End shift</button>`
    : (myDepartments.length
      ? `${myDepartments.length > 1 ? `<div class="sh-pick" role="radiogroup" aria-label="Department">${myDepartments.map((n, i) => `
          <button type="button" role="radio" aria-checked="${i === 0}" class="sh-opt${i === 0 ? ' on' : ''}" data-dept="${esc(n)}" style="--dept:${deptOf(n).color}">
            <span class="sh-swatch" aria-hidden="true"></span>${esc(n)}</button>`).join('')}</div>` : ''}
         <button class="refresh sh-go" id="sh-start">Start shift${myDepartments.length === 1 ? ' in ' + esc(myDepartments[0]) : ''}</button>`
      : '');

  const groups = DEPARTMENTS.map((dep) => ({ dep, list: (on.data || []).filter((s) => s.department === dep.name) })).filter((g) => g.list.length);
  const onCount = (on.data || []).length;
  const breaks = (on.data || []).filter((s) => s.status === 'break').length;

  const weeks = [];
  for (const s of past) {
    const k = weekStartOf(s.started_at, week);
    let g = weeks.find((w) => w.k === k);
    if (!g) weeks.push(g = { k, label: weekLabel(k, week), list: [], secs: 0 });
    g.list.push(s); g.secs += shiftSecs(s);
  }

  body.innerHTML = `<div class="pg-shifts">
    <section class="card sh-card sh-${state}"${d ? ` style="--dept:${d.color}"` : ''}>
      <div class="sh-top">
        <span class="sh-state"><span class="sh-led" aria-hidden="true"></span>${state === 'on' ? 'On shift' : state === 'break' ? 'On a break' : 'Off shift'}</span>
        ${d ? `<span class="sh-dept-chip"><span class="sh-swatch" aria-hidden="true"></span>${esc(d.name)}</span>` : ''}
      </div>
      <div class="sh-main">
        <div class="sh-clock">
          ${myNow ? `<div class="sh-timer" data-tick="me" aria-label="Time on shift">${clock(shiftSecs(myNow))}</div>
            <div class="sh-sub muted">Since ${shiftTime(myNow.started_at)}${myNow.status === 'break'
              ? ` · break <span data-tick="brk">${clock((Date.now() - new Date(myNow.break_started_at)) / 1000)}</span>`
              : (myNow.break_seconds ? ` · ${hrs(myNow.break_seconds)} on breaks` : '')}</div>`
            : `<div class="sh-timer idle">0:00:00</div>
               <div class="sh-sub muted">${myDepartments.length ? 'Not on shift' : 'You need a department role to start a shift.'}</div>`}
        </div>
        <dl class="sh-stats">
          <div><dt>This week</dt><dd data-tick="week">${hrs(pastWeek + (myNow && myNow.started_at >= week ? liveExtra() : 0))}</dd></div>
          <div><dt>Last 30 days</dt><dd data-tick="month">${hrs(past30 + liveExtra())}</dd></div>
        </dl>
      </div>
      ${actions ? `<div class="sh-actions">${actions}</div>` : ''}
      <p class="error" id="sh-err" hidden></p>
    </section>

    <h2 class="menu-label aud-staff"><span class="aud-dot"></span>On now${onCount ? ` <span class="sh-count">${onCount}${breaks ? ` · ${breaks} on a break` : ''}</span>` : ''}</h2>
    ${groups.length ? `<div class="sh-board">${groups.map(({ dep, list }) => `
      <div class="card sh-team" style="--dept:${dep.color}">
        <div class="sh-team-head"><span class="sh-swatch" aria-hidden="true"></span><strong>${esc(dep.name)}</strong><span class="muted">${list.length}</span></div>
        ${list.map((s) => `<div class="sh-person${s.discord_id === myDiscordId ? ' me' : ''}">
          <span class="sh-face"><img class="avatar" src="${esc(sized(photo[s.discord_id] || '', 64))}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
            <span class="sh-dot ${s.status === 'break' ? 'brk' : 'on'}" aria-hidden="true"></span></span>
          <span class="sh-who"><strong>${esc(cleanName(s.name))}${s.discord_id === myDiscordId ? ' <span class="sh-you">You</span>' : ''}</strong>
            <span class="muted">${s.status === 'break' ? 'On a break' : 'Since ' + shiftTime(s.started_at)}</span></span>
          <span class="sh-len" data-tick="on-${s.id}">${hrs(shiftSecs(s))}</span>
        </div>`).join('')}
      </div>`).join('')}</div>`
      : '<div class="card"><p class="muted small">Nobody is on shift right now.</p></div>'}

    <h2 class="menu-label aud-staff"><span class="aud-dot"></span>Your shifts</h2>
    ${weeks.length ? weeks.map((w) => `
      <div class="card sh-week">
        <div class="sh-week-head"><strong>${esc(w.label)}</strong><span>${hrs(w.secs)} · ${w.list.length} ${w.list.length === 1 ? 'shift' : 'shifts'}</span></div>
        ${w.list.map((s) => { const dd = deptOf(s.department); return `<div class="sh-row" style="--dept:${dd.color}">
          <span class="sh-day"><strong>${new Date(s.started_at).toLocaleDateString([], { weekday: 'short' })}</strong>
            <span class="muted">${new Date(s.started_at).toLocaleDateString([], { day: 'numeric', month: 'short' })}</span></span>
          <span class="sh-what"><span class="sh-dept-chip small"><span class="sh-swatch" aria-hidden="true"></span>${esc(dd.name)}</span>
            <span class="muted">${shiftTime(s.started_at)}–${shiftTime(s.ended_at)}${s.break_seconds ? ` · ${hrs(s.break_seconds)} break` : ''}</span>
            ${s.ended_by === 'auto' ? '<span class="st sh-auto">Ended automatically</span>' : ''}</span>
          <strong class="sh-len">${hrs(shiftSecs(s))}</strong>
        </div>`; }).join('')}
      </div>`).join('') : '<div class="card"><p class="muted small">No shifts in the last 30 days.</p></div>'}</div>`;

  wireShiftButtons(body);
  // Live timers: only these numbers change each second; nothing else redraws.
  clearInterval(shiftTicker);
  shiftTicker = setInterval(() => {
    if (!body.isConnected || !body.querySelector('[data-tick]')) { clearInterval(shiftTicker); return; }
    const set = (k, v) => { const el = body.querySelector(`[data-tick="${k}"]`); if (el && el.textContent !== v) el.textContent = v; };
    if (myNow) {
      set('me', clock(shiftSecs(myNow)));
      if (myNow.status === 'break') set('brk', clock((Date.now() - new Date(myNow.break_started_at)) / 1000));
      if (myNow.started_at >= week) set('week', hrs(pastWeek + liveExtra()));
      set('month', hrs(past30 + liveExtra()));
    }
    for (const s of on.data || []) set('on-' + s.id, hrs(shiftSecs(s)));
  }, 1000);
}
let shiftTicker = null;

async function shiftAction(body, btn, fn, args, busyText) {
  const all = body.querySelectorAll('.sh-actions button');
  all.forEach((b) => { b.disabled = true; });
  const was = btn.textContent;
  btn.textContent = busyText;
  const { error } = await sb.rpc(fn, args || {});
  if (error) {
    all.forEach((b) => { b.disabled = false; });
    btn.textContent = was;
    const e = body.querySelector('#sh-err'); e.textContent = error.message; e.hidden = false;
    return;
  }
  renderShifts(body);
}
function wireShiftButtons(body) {
  body.querySelectorAll('.sh-opt').forEach((b) => b.addEventListener('click', () => {
    body.querySelectorAll('.sh-opt').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', x === b); });
  }));
  const start = body.querySelector('#sh-start');
  start?.addEventListener('click', () => shiftAction(body, start, 'shift_start',
    { department: body.querySelector('.sh-opt.on')?.dataset.dept || myDepartments[0] }, 'Starting…'));
  const brk = body.querySelector('#sh-break');
  brk?.addEventListener('click', () => shiftAction(body, brk, 'shift_break', null, 'Saving…'));
  const end = body.querySelector('#sh-end');
  end?.addEventListener('click', () => { if (confirm('End your shift?')) shiftAction(body, end, 'shift_end', null, 'Ending…'); });
}

// ----- Bot settings (#exec/settings) — execs; saved with set_setting(key, value); the bot applies them -----
const SETTINGS = [
  { key: 'join_code', label: 'Maple Hospital join code', help: 'Shown on the session banner and in the USE CODE channel name (the channel can take a few minutes to update).', type: 'text', placeholder: '4920-4087' },
  { key: 'shift_auto_end_hours', label: 'End forgotten shifts after', help: 'Hours. A shift still running after this long is ended automatically.', type: 'number', suffix: 'hours', min: 1, max: 24 },
];
async function renderSettings(body) {
  body.innerHTML = '<div class="card"><p class="muted small">Loading…</p></div>';
  const { data, error } = await sb.from('settings').select('key, value');
  if (error) { body.innerHTML = ''; return liveError(body, error); }
  const cur = Object.fromEntries((data || []).map((r) => [r.key, r.value]));
  body.innerHTML = `<div class="card settings">${SETTINGS.map((st) => `
    <form class="row-item setting" data-key="${st.key}">
      <div class="case-main"><strong>${esc(st.label)}</strong><span class="muted small-meta">${esc(st.help)}</span></div>
      <div class="setting-ctl">
        <input class="set-in" type="${st.type}" ${st.min ? `min="${st.min}" max="${st.max}"` : ''} placeholder="${esc(st.placeholder || '')}" value="${esc(cur[st.key] ?? '')}" required>
        ${st.suffix ? `<span class="muted small-meta">${esc(st.suffix)}</span>` : ''}
        <button class="refresh" type="submit">Save</button>
      </div>
      <span class="set-msg small-meta" hidden></span>
    </form>`).join('')}</div>`;
  body.querySelectorAll('.setting').forEach((f) => f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const st = SETTINGS.find((x) => x.key === f.dataset.key), raw = f.querySelector('.set-in').value.trim();
    const value = st.type === 'number' ? Number(raw) : raw;
    const { error } = await sb.rpc('set_setting', { setting: st.key, val: value });
    const msg = f.querySelector('.set-msg');
    msg.hidden = false;
    msg.className = 'set-msg small-meta ' + (error ? 'error' : 'ok');
    msg.textContent = error ? "Couldn't save: " + error.message : 'Saved.';
  }));
}

// Activity (#exec/reports, was Reports) lives in activity.js since the 0.16.x redesign.

// ----- Staff & roster (#roster) -----
// Compact badges for person cards: a department + its rank stay one block ("Nursing · Year 5" style, shortened).
// Roster badges: one plain badge per role, never a joined pair, so nothing runs off a narrow card. In a department's
// own section the department is implied, so its rank reads just "Year 5"; other departments say "Community
// Engagement Leader". Leadership titles first, then each department (most senior first), then Executive.
function rosterBadges(roles, depts, here) {
  const deptColour = Object.fromEntries(depts.map((d) => [d.department, d.badge_color]));
  const out = roles.filter((r) => r.kind === 'leadership').sort((a, b) => b.position - a.position)
    .map((r) => ({ label: r.name, color: r.badge_color, icon: LEADERSHIP_ICON[r.id] || 'star' }));
  const ranks = roles.filter((r) => r.kind === 'rank').sort((a, b) => (b.department === here) - (a.department === here) || b.rank_order - a.rank_order);
  const seen = new Set();
  for (const r of ranks) {
    if (seen.has(r.department)) continue;
    seen.add(r.department);
    out.push({ label: r.department === here ? r.rank_label : `${r.department} ${r.rank_label}`, color: r.badge_color, icon: DEPARTMENT_ICON[r.department] });
  }
  for (const r of roles.filter((x) => x.kind === 'department' && !seen.has(x.department))) {
    seen.add(r.department);
    out.push({ label: r.department, color: deptColour[r.department], icon: DEPARTMENT_ICON[r.department] });
  }
  const ex = roles.find((r) => r.kind === 'executive');
  if (ex) out.push({ label: 'Executive', color: ex.badge_color, icon: 'star' });
  return out;
}
function personBadges(badges) {
  return badges.map((b) => `<span class="rbadge" style="--c:${b.color ? hex(b.color) : '#9aa9c4'}">${b.icon ? `<span class="ri" style="--icon:${iconUrl(b.icon)}"></span>` : ''}<span class="rl">${esc(b.label)}</span></span>`).join('');
}
// Staff & roster (0.15.x redesign, Bravo; owner chose "compact rows"). Hospital-wide for staff (docs/ACCESS.md):
// everyone in a department as one row each, in department sections, with search, department filter and on-shift dots
// (on_shift_now(), migration 0018). Never shows Records data; admins can open a person's record from their row.
// Roster labels (owner: "which role belongs to this section?"). In a department section the person's rank THERE is
// the main label; their other departments are secondary (owner chose this design, option A).
function rosterLabels(p, here, deptColour) {
  const lead = p.roles.filter((r) => r.kind === 'leadership').sort((a, b) => b.position - a.position);
  const ranks = p.roles.filter((r) => r.kind === 'rank').sort((a, b) => b.rank_order - a.rank_order);
  const best = (d) => ranks.find((r) => r.department === d);
  const depts = [...new Set(p.roles.filter((r) => r.department && (r.kind === 'rank' || r.kind === 'department')).map((r) => r.department))];
  const mainRank = here !== 'Leadership' && here !== 'Other' ? best(here) : null;
  const others = depts.filter((d) => d !== here).map((d) => ({ d, rank: best(d) }));
  const exec = p.roles.some((r) => r.kind === 'executive');
  const col = (d) => deptColour(d) || '#3a82d0';
  // Leadership + the section rank as solid chips; other departments as small muted chips with a colour dot.
  const chips = [
    ...lead.map((r) => `<span class="ro-chip solid" style="--bg:${readableColour(hex(r.badge_color || 3834576))}">${esc(r.name)}</span>`),
    ...(mainRank ? [`<span class="ro-chip solid" style="--bg:${readableColour(col(here))}">${esc(mainRank.rank_label)}</span>`] : []),
    ...others.map((o) => `<span class="ro-chip muted" style="--dept:${col(o.d)}"><span class="ro-cdot"></span>${esc(o.d)}${o.rank ? ' · ' + esc(o.rank.rank_label) : ''}</span>`),
    ...(exec ? ['<span class="ro-chip muted ex">Executive</span>'] : []),
  ];
  return { side: `<span class="ro-chips2">${chips.join('')}</span>`, under: '' };
}
// A role colour darkened toward navy only as far as needed to reach 4.5:1 contrast on white (WCAG AA for text).
function readableColour(hexStr) {
  const n = parseInt(hexStr.slice(1), 16), c = [(n >> 16) & 255, (n >> 8) & 255, n & 255], navy = [11, 30, 74];
  const lum = (rgb) => rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; })
    .reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
  for (let k = 1; k >= 0; k -= 0.02) {
    const m = c.map((v, i) => Math.round(v * k + navy[i] * (1 - k)));
    if (1.05 / (lum(m) + 0.05) >= 4.5) return `rgb(${m.join(',')})`;
  }
  return '#0b1e4a';
}
const initials = (n) => cleanName(n).split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
async function renderRoster(body) {
  body.innerHTML = '<div class="card"><p class="muted small">Loading the roster…</p></div>';
  const [{ data: people, error }, { data: allRoles }, onq] = await Promise.all([
    sb.rpc('roster'), sb.from('roles').select('id, name, color, position, kind, department, rank_label, rank_order, badge_color'),
    sb.rpc('on_shift_now').then((r) => r, () => ({ data: [] })),
  ]);
  if (error) { body.innerHTML = ''; return liveError(body, error); }
  const byId = Object.fromEntries((allRoles || []).map((r) => [r.id, r]));
  const depts = (allRoles || []).filter((r) => r.kind === 'department');
  const onNow = Object.fromEntries((onq.data || []).map((s) => [s.discord_id, s]));
  const colour = (name) => (DEPARTMENTS.find((d) => d.name === name) || {}).color;
  const SECTIONS = ['Leadership', 'Administration', 'Nursing', 'Paramedicine', 'Community Engagement', 'Other'];
  const everyone = (people || []).map((p) => {
    const roles = (p.role_ids || []).map((id) => byId[id]).filter(Boolean);
    const lead = roles.filter((r) => r.kind === 'leadership');
    const ranks = roles.filter((r) => r.kind === 'rank').sort((a, b) => b.rank_order - a.rank_order);
    const main = lead.length ? 'Leadership' : (ranks[0]?.department || roles.find((r) => r.kind === 'department')?.department || 'Other');
    const name = cleanName(p.display_name);
    // Name colour = their highest coloured role, like Discord shows it (darkened in CSS so it reads on white).
    const top = roles.filter((r) => r.color).sort((a, b) => b.position - a.position)[0];
    return { ...p, roles, main, name, key: name.toLowerCase(), nameColour: top ? hex(top.color) : null,
      leadPos: lead.length ? Math.max(...lead.map((r) => r.position)) : 0 };
  });
  const inDept = (p, d) => d === 'Leadership' ? p.main === 'Leadership' : d === 'Other' ? p.main === 'Other' : p.roles.some((r) => r.department === d);
  const rankIn = (p, d) => d === 'Leadership' ? p.leadPos
    : Math.max(0, ...p.roles.filter((r) => r.kind === 'rank' && r.department === d).map((r) => r.rank_order));
  const present = SECTIONS.filter((d) => everyone.some((p) => inDept(p, d)));
  const state = { dept: 'all', q: '', onOnly: false };

  body.innerHTML = `<div class="pg-roster">
    <div class="ro-bar">
      <label class="ro-search">
        <input id="ro-q" type="search" placeholder="Search ${everyone.length} staff" autocomplete="off" aria-label="Search staff"></label>
      <div class="chips ro-chips" id="ro-filter">
        <button class="chip on" data-d="all">Everyone <span class="count">${everyone.length}</span></button>
        ${present.map((d) => `<button class="chip" data-d="${esc(d)}"${colour(d) ? ` style="--dept:${colour(d)}"` : ''}>${colour(d) ? '<span class="ro-sw" aria-hidden="true"></span>' : ''}${esc(d)} <span class="count">${everyone.filter((p) => inDept(p, d)).length}</span></button>`).join('')}
        <button class="chip ro-onchip" data-on="1"><span class="ro-led" aria-hidden="true"></span>On shift <span class="count">${Object.keys(onNow).length}</span></button>
      </div>
    </div>
    <div id="ro-list"></div></div>`;

  const row = (p, d) => {
    const s = onNow[p.discord_id];
    const me = p.discord_id === myDiscordId;
    const tag = access.admin ? 'button' : 'div';
    const lab = rosterLabels(p, d, colour);
    return `<${tag} class="ro-row${me ? ' me' : ''}"${access.admin ? ` type="button" data-rec="${esc(p.discord_id)}" title="Open record"` : ''}>
      <span class="ro-face" style="--dept:${colour(p.main) || '#3a82d0'}">
        <span class="ro-init" aria-hidden="true">${esc(initials(p.display_name))}</span>
        ${p.avatar_url ? `<img src="${esc(sized(p.avatar_url, 64))}" alt="" loading="lazy" onerror="this.remove()">` : ''}
        ${s ? `<span class="ro-dot ${s.status === 'break' ? 'brk' : 'on'}" title="${s.status === 'break' ? 'On a break' : 'On shift'}"></span>` : ''}
      </span>
      <span class="ro-name"><span class="ro-line"><strong${p.nameColour ? ` style="color:${readableColour(p.nameColour)}"` : ''}>${esc(p.name)}</strong>${me ? '<span class="ro-you">You</span>' : ''}</span>
        ${lab.under}${s ? `<span class="ro-status ${s.status === 'break' ? 'brk' : 'on'}">${s.status === 'break' ? 'On a break' : 'On shift'}${s.department !== d ? ' · ' + esc(s.department) : ''}</span>` : ''}</span>
      <span class="ro-badges">${lab.side}</span>
    </${tag}>`;
  };

  const draw = () => {
    const q = state.q.trim().toLowerCase();
    const match = (p) => (!q || p.key.includes(q) || (p.username || '').toLowerCase().includes(q)) && (!state.onOnly || onNow[p.discord_id]);
    // Everyone: each person once, in their main section. A department picked: everyone in it.
    const sections = (state.dept === 'all' ? present.map((d) => [d, everyone.filter((p) => p.main === d)])
      : [[state.dept, everyone.filter((p) => inDept(p, state.dept))]])
      .map(([d, list]) => [d, list.filter(match).sort((a, b) => rankIn(b, d) - rankIn(a, d) || a.name.localeCompare(b.name))])
      .filter(([, list]) => list.length);
    body.querySelector('#ro-list').innerHTML = sections.map(([d, list]) => {
      const on = list.filter((p) => onNow[p.discord_id]).length;
      return `<section class="ro-sec"${colour(d) ? ` style="--dept:${colour(d)}"` : ''}>
        <h2 class="ro-head">${colour(d) ? '<span class="ro-sw" aria-hidden="true"></span>' : ''}<span>${esc(d)}</span>
          <span class="ro-n">${list.length}${on ? ` · <span class="ro-on">${on} on shift</span>` : ''}</span></h2>
        <div class="card ro-card">${list.map((p) => row(p, d)).join('')}</div></section>`;
    }).join('') || `<div class="card"><p class="muted small">${q ? `Nobody matches “${esc(state.q.trim())}”.` : (state.onOnly ? 'Nobody is on shift right now.' : 'Nobody to show.')}</p></div>`;
  };

  body.querySelector('#ro-filter').onclick = (e) => {
    const b = e.target.closest('.chip'); if (!b) return;
    if (b.dataset.on) { state.onOnly = !state.onOnly; b.classList.toggle('on', state.onOnly); }
    else {
      state.dept = b.dataset.d;
      body.querySelectorAll('#ro-filter .chip[data-d]').forEach((x) => x.classList.toggle('on', x === b));
    }
    draw();
  };
  body.querySelector('#ro-q').addEventListener('input', (e) => { state.q = e.target.value; draw(); });
  body.querySelector('#ro-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-rec]'); if (!b || !access.admin) return;
    const p = everyone.find((x) => x.discord_id === b.dataset.rec);
    if (typeof rememberRecord === 'function') rememberRecord(p.discord_id, p.name);
    if (typeof openRecord === 'function') openRecord(p.discord_id);
  });
  draw();
}

// ----- Department pages (#directors/<dept>): dept.js / dept.css (0.17.x redesign, Bravo) -----

Object.assign(LIVE, { shifts: renderShifts, people: renderRoster, settings: renderSettings, sessions: renderSessions });

// ---------- running sessions (admins) ----------
// Sessions are run from the website only (the /session commands were removed). The website writes the sessions
// row; the bot notices within ~10 s and does the Discord side (announcement with Session Ping, "Session Ended").
function sydneyToIso(date, time) {
  const guess = new Date(`${date}T${time}:00Z`);
  const tz = (zone) => new Date(guess.toLocaleString('en-US', { timeZone: zone }));
  return new Date(guess - (tz('Australia/Sydney') - tz('UTC'))).toISOString();
}
function sydneyToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date());   // YYYY-MM-DD
}

// Sessions page (#directors/sessions, #admin/sessions). 0.15.x redesign (Bravo; owner's choices): a live panel (timer,
// host, join code, who's on shift), a 7-day calendar, an upcoming list, one form for start / schedule / edit with
// session types, a Session Ping switch and an optional Discord message, and Session history (Alpha's
// sessions-history.js, mounted in #sess-history). Back end: migration 0020; the bot does every Discord post.
const SESSION_TYPES = [
  { id: 'regular', label: 'Regular session', color: '#0d9488' },
  { id: 'training', label: 'Training', color: '#3a82d0' },
  { id: 'event', label: 'Event', color: '#e09a00' },
  { id: 'department', label: 'Department session', color: '#6a4fd6' },
];
function sessionType(s) {
  const t = SESSION_TYPES.find((x) => x.id === (s.kind || 'regular')) || SESSION_TYPES[0];
  if (t.id === 'department' && s.department) {
    const d = DEPARTMENTS.find((x) => x.name === s.department);
    return { ...t, label: `${s.department} session`, color: d ? d.color : t.color };
  }
  return t;
}
const sessPlace = (s) => (s.location_kind === 'in_game' && s.location_text ? s.location_text : 'Discord only');
const sessHosts = (s, extra) => [cleanName(s.host_name || 'staff'), ...(extra[s.id] || []).map((h) => cleanName(h.name || ''))].filter(Boolean);
const sessTag = (s) => { const t = sessionType(s); return `<span class="ss-tag" style="--t:${t.color}">${esc(t.label)}</span>`; };
const sydDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(d);   // YYYY-MM-DD
const sydTime = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Australia/Sydney', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);

async function renderSessions(body) {
  body.innerHTML = '<div class="card"><p class="muted small">Loading sessions…</p></div>';
  const until = new Date(Date.now() + 60 * 864e5).toISOString();
  const [liveQ, upQ, codeQ, ros, onq] = await Promise.all([
    sb.from('sessions').select('*').eq('status', 'live').order('started_at', { ascending: false }).limit(1),
    sb.from('sessions').select('*').eq('status', 'scheduled').gt('scheduled_for', new Date(Date.now() - 3600e3).toISOString())
      .lt('scheduled_for', until).order('scheduled_for'),
    sb.from('settings').select('value').eq('key', 'join_code').maybeSingle(),
    sb.rpc('roster').then((r) => r, () => ({ data: [] })),
    sb.rpc('on_shift_now').then((r) => r, () => ({ data: [] })),
  ]);
  if (liveQ.error || upQ.error) { body.innerHTML = ''; return liveError(body, liveQ.error || upQ.error); }
  const live = (liveQ.data || [])[0] || null;
  const upcoming = upQ.data || [];
  const ids = [...(live ? [live.id] : []), ...upcoming.map((u) => u.id)];
  const hq = ids.length ? await sb.from('session_hosts').select('session_id, discord_id, name').in('session_id', ids).then((r) => r, () => ({ data: [] })) : { data: [] };
  const coHosts = {};
  for (const h of hq.data || []) (coHosts[h.session_id] ||= []).push(h);
  const code = (live && live.join_code) || (codeQ.data && codeQ.data.value) || joinCode;
  const people = Object.fromEntries((ros.data || []).map((p) => [p.discord_id, p]));
  const onNow = onq.data || [];

  // 7 days from today (Sydney)
  const days = [...Array(7)].map((_, i) => { const d = new Date(Date.now() + i * 864e5); return { key: sydDate(d), d }; });
  const byDay = (k) => upcoming.filter((u) => sydDate(new Date(u.scheduled_for)) === k);

  const liveBlock = live ? (() => {
    const since = new Date(live.started_at);
    return `<section class="card ss-live" style="--t:${sessionType(live).color}">
      <div class="ss-live-top"><span class="ss-led" aria-hidden="true"></span><span class="ss-live-label">Live now</span>${sessTag(live)}
        <span class="ss-live-host">Hosted by <strong>${esc(sessHosts(live, coHosts).join(', '))}</strong></span></div>
      <div class="ss-live-main">
        <div><div class="ss-timer" data-tick="ss-live">${clock((Date.now() - since) / 1000)}</div>
          <div class="muted ss-sub">Since ${since.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · <span class="ss-place">${esc(sessPlace(live))}</span>${live.note ? ' · ' + esc(live.note) : ''}</div></div>
        <div class="ss-code"><span class="ss-code-l">Join code</span><strong>${esc(code)}</strong><button class="ghost small-btn" id="ss-copy">Copy</button></div>
      </div>
      <div class="ss-crew"><span class="ss-crew-l">On shift <strong>${onNow.length}</strong></span>
        <span class="ss-faces">${onNow.slice(0, 12).map((o) => { const p = people[o.discord_id] || {}; const dc = (DEPARTMENTS.find((x) => x.name === o.department) || {}).color || '#3a82d0';
          return `<span class="ss-face${o.status === 'break' ? ' brk' : ''}" style="--dept:${dc}" title="${esc(cleanName(p.display_name || ''))} · ${esc(o.department)}${o.status === 'break' ? ' · on a break' : ''}">${p.avatar_url ? `<img src="${esc(sized(p.avatar_url, 64))}" alt="" onerror="this.remove()">` : ''}<span>${esc(initials(p.display_name || '?'))}</span></span>`; }).join('')}${onNow.length > 12 ? `<span class="ss-more">+${onNow.length - 12}</span>` : ''}</span>
        ${onNow.length ? '' : '<span class="muted">Nobody yet</span>'}</div>
      <div class="ss-actions"><button class="ghost danger" id="ss-end">End session</button></div>
    </section>`;
  })() : `<section class="card ss-idle"><div><strong class="ss-idle-t">No session running</strong>
      <span class="muted">${upcoming[0] ? 'Next: ' + esc(whenAhead(upcoming[0].scheduled_for)) : 'Nothing scheduled'} · Join code <strong>${esc(code)}</strong></span></div>
      <div class="ss-actions"><button class="ghost" id="ss-new-sched">Schedule</button><button class="refresh" id="ss-new-live">Start a session now</button></div></section>`;

  body.innerHTML = `<div class="pg-sess">
    ${liveBlock}
    <div class="ss-form-slot" id="ss-form-slot"></div>
    <h2 class="menu-label aud-director"><span class="aud-dot"></span>Next 7 days</h2>
    <div class="ss-week">${days.map((dd, i) => `<div class="ss-day${i === 0 ? ' today' : ''}">
      <div class="ss-day-h"><strong>${i === 0 ? 'Today' : dd.d.toLocaleDateString([], { weekday: 'short', timeZone: 'Australia/Sydney' })}</strong>
        <span>${dd.d.toLocaleDateString([], { day: 'numeric', month: 'short', timeZone: 'Australia/Sydney' })}</span></div>
      ${byDay(dd.key).map((u) => `<button class="ss-slot" data-edit="${u.id}" style="--t:${sessionType(u).color}"><strong>${sydTime(new Date(u.scheduled_for))}</strong><span>${esc(sessionType(u).label)}</span><span class="ss-slot-loc">${esc(sessPlace(u))}</span></button>`).join('')}
      <button class="ss-add" data-day="${dd.key}" aria-label="Schedule on ${dd.d.toDateString()}">+</button></div>`).join('')}</div>
    <h2 class="menu-label aud-director"><span class="aud-dot"></span>Upcoming</h2>
    <div class="card ss-list">${upcoming.length ? upcoming.map((u) => `<div class="ss-row">
      <div class="ss-when"><strong>${esc(whenAhead(u.scheduled_for))}</strong>${sessTag(u)}</div>
      <div class="ss-meta muted">With ${esc(sessHosts(u, coHosts).join(', '))} · <span class="ss-place">${esc(sessPlace(u))}</span>${u.note ? ' · ' + esc(u.note) : ''}${u.ping === false ? ' · no ping' : ''}</div>
      <div class="ss-row-act"><button class="ghost small-btn" data-edit="${u.id}">Edit</button>${live ? '' : `<button class="ghost small-btn" data-golive="${u.id}">Start now</button>`}<button class="ghost small-btn danger" data-cancel="${u.id}">Cancel</button></div>
    </div>`).join('') : '<p class="muted small">No sessions scheduled. Use + on a day above to plan one.</p>'}</div>
    <p class="error" id="ss-err" hidden></p>
    <div id="sess-history"></div>
  </div>`;

  const fail = (msg) => { const e = body.querySelector('#ss-err'); e.textContent = msg; e.hidden = false; e.scrollIntoView({ block: 'nearest' }); };
  const slot = body.querySelector('#ss-form-slot');
  const openForm = (mode, opts = {}) => sessionForm(slot, mode, { ...opts, coHosts: opts.row ? (coHosts[opts.row.id] || []).map((h) => h.discord_id) : [] },
    { people: ros.data || [], done: () => renderSessions(body) });
  body.querySelector('#ss-new-live')?.addEventListener('click', () => openForm('live'));
  body.querySelector('#ss-new-sched')?.addEventListener('click', () => openForm('scheduled'));
  body.querySelectorAll('[data-day]').forEach((b) => b.addEventListener('click', () => openForm('scheduled', { date: b.dataset.day })));
  body.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () =>
    openForm('edit', { row: upcoming.find((u) => String(u.id) === b.dataset.edit) })));
  body.querySelector('#ss-copy')?.addEventListener('click', async (e) => { try { await navigator.clipboard.writeText(code); e.target.textContent = 'Copied'; } catch { /* visible anyway */ } });
  body.querySelector('#ss-end')?.addEventListener('click', async (e) => {
    if (!confirm('End the live session? The Discord announcement will change to "Session Ended".')) return;
    e.target.disabled = true; e.target.textContent = 'Ending…';
    const { error } = await sb.from('sessions').update({ status: 'ended', ended_at: new Date().toISOString() }).eq('id', live.id).eq('status', 'live');
    if (error) { e.target.disabled = false; e.target.textContent = 'End session'; return fail("Couldn't end it: " + error.message); }
    renderSessions(body);
  });
  body.querySelectorAll('[data-golive]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true; b.textContent = 'Starting…';
    const { error } = await sb.from('sessions').update({ status: 'live' }).eq('id', b.dataset.golive).eq('status', 'scheduled');
    if (error) { b.disabled = false; b.textContent = 'Start now'; return fail(error.code === '23505' ? 'A session is already live.' : "Couldn't start it: " + error.message); }
    renderSessions(body);
  }));
  body.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Cancel this scheduled session? Its post in Discord will show it as cancelled.')) return;
    b.disabled = true;
    const { error } = await sb.from('sessions').update({ status: 'cancelled' }).eq('id', b.dataset.cancel).eq('status', 'scheduled');
    if (error) { b.disabled = false; return fail("Couldn't cancel it: " + error.message); }
    renderSessions(body);
  }));
  // live timer
  clearInterval(sessTicker);
  if (live) sessTicker = setInterval(() => {
    const el = body.querySelector('[data-tick="ss-live"]');
    if (!el || !el.isConnected) { clearInterval(sessTicker); return; }
    el.textContent = clock((Date.now() - new Date(live.started_at)) / 1000);
  }, 1000);
  // Session history (Alpha's part, sessions-history.js)
  const hist = body.querySelector('#sess-history');
  if (typeof window.renderSessionHistory === 'function') window.renderSessionHistory(hist);
}
let sessTicker = null;

// One form for: start now (live), schedule, and edit a scheduled session.
function sessionForm(slot, mode, opts, ctx) {
  const row = opts.row || {};
  const kind = row.kind || 'regular';
  const when = row.scheduled_for ? new Date(row.scheduled_for) : null;
  const title = mode === 'live' ? 'Start a session' : mode === 'edit' ? 'Edit session' : 'Schedule a session';
  slot.innerHTML = `<form class="card ss-form" novalidate>
    <div class="ss-form-h"><strong>${title}</strong><button type="button" class="linkish" data-close>Close</button></div>
    <div class="f"><span>Type</span><div class="ss-types" role="radiogroup">${SESSION_TYPES.map((t) => `
      <button type="button" role="radio" aria-checked="${t.id === kind}" class="ss-type${t.id === kind ? ' on' : ''}" data-kind="${t.id}" style="--t:${t.color}"><span class="ss-sw"></span>${esc(t.label)}</button>`).join('')}</div></div>
    <div class="f ss-dept-f"${kind === 'department' ? '' : ' hidden'}><span>Department</span><div class="ss-types">${DEPARTMENTS.map((d) => `
      <button type="button" class="ss-type ss-dpt${row.department === d.name ? ' on' : ''}" data-dept="${esc(d.name)}" style="--t:${d.color}"><span class="ss-sw"></span>${esc(d.name)}</button>`).join('')}</div></div>
    ${mode !== 'live' ? `<div class="f-row">
      <label class="f"><span>Date</span><input type="date" name="date" value="${esc(opts.date || (when ? sydDate(when) : sydneyToday()))}" min="${sydneyToday()}"></label>
      <label class="f"><span>Time (Sydney)</span><input type="time" name="time" step="300" value="${when ? sydTime(when) : '19:00'}"></label></div>` : ''}
    ${mode === 'edit' ? `<label class="f"><span>Host</span><select name="host">${ctx.people.slice().sort((a, b) => cleanName(a.display_name).localeCompare(cleanName(b.display_name)))
      .map((p) => `<option value="${esc(p.discord_id)}"${p.discord_id === row.host_discord_id ? ' selected' : ''}>${esc(cleanName(p.display_name))}</option>`).join('')}</select></label>` : ''}
    <div class="f"><span>Location</span><div class="ss-types ss-loc" role="radiogroup">
      <button type="button" role="radio" class="ss-type${(row.location_kind || 'discord') === 'discord' ? ' on' : ''}" data-loc="discord" style="--t:#5865f2"><span class="ss-sw"></span>Discord only</button>
      <button type="button" role="radio" class="ss-type${row.location_kind === 'in_game' ? ' on' : ''}" data-loc="in_game" style="--t:#0d9488"><span class="ss-sw"></span>In game</button></div>
      <input name="location_text" maxlength="80" placeholder="Where in Maple Hospital? e.g. Main Hospital, Floor 2" value="${esc(row.location_text || '')}"${row.location_kind === 'in_game' ? '' : ' hidden'}></div>
    <div class="f"><span>Co-hosts <em>(optional)</em></span><div class="ss-hosts" data-hosts></div>
      <select name="addhost"><option value="">Add a co-host…</option>${ctx.people.slice().sort((a, b) => cleanName(a.display_name).localeCompare(cleanName(b.display_name)))
        .map((p) => `<option value="${esc(p.discord_id)}">${esc(cleanName(p.display_name))}</option>`).join('')}</select></div>
    <label class="f"><span>Note <em>(optional, shown on the website)</em></span><input name="note" maxlength="200" value="${esc(row.note || '')}" placeholder="e.g. All departments welcome"></label>
    <label class="f"><span>Discord message <em>(optional)</em></span><textarea name="announcement" rows="2" maxlength="500" placeholder="Leave empty to use the note">${esc(row.announcement || '')}</textarea></label>
    <label class="ss-switch"><input type="checkbox" name="ping"${row.ping === false ? '' : ' checked'}><span class="ss-knob" aria-hidden="true"></span>
      <span>Ping <strong>Session Ping</strong> ${mode === 'live' ? 'in the announcement' : 'in the 15-minute reminder and when it starts'}${mode === 'live' ? '' : ' (hosts are always pinged in the reminder)'}</span></label>
    <p class="error" data-err hidden></p>
    <div class="f-actions"><button type="button" class="linkish" data-close>Cancel</button>
      <button class="refresh" type="submit">${mode === 'live' ? 'Start session' : mode === 'edit' ? 'Save changes' : 'Schedule'}</button></div>
  </form>`;
  const f = slot.querySelector('form');
  let k = kind, dept = row.department || null;
  const err = (m) => { const e = f.querySelector('[data-err]'); e.textContent = m; e.hidden = false; };
  f.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => { slot.innerHTML = ''; }));
  f.querySelectorAll('.ss-type[data-kind]').forEach((b) => b.addEventListener('click', () => {
    k = b.dataset.kind;
    f.querySelectorAll('.ss-type[data-kind]').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', x === b); });
    f.querySelector('.ss-dept-f').hidden = k !== 'department';
  }));
  let loc = row.location_kind || 'discord';
  f.querySelectorAll('[data-loc]').forEach((b) => b.addEventListener('click', () => {
    loc = b.dataset.loc;
    f.querySelectorAll('[data-loc]').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', x === b); });
    f.elements.location_text.hidden = loc !== 'in_game';
    if (loc === 'in_game') f.elements.location_text.focus();
  }));
  const lead = () => (mode === 'edit' && f.elements.host ? f.elements.host.value : (row.host_discord_id || myDiscordId));
  let cohosts = (opts.coHosts || []).slice();
  const drawHosts = () => {
    f.querySelector('[data-hosts]').innerHTML = cohosts.filter((id) => id !== lead()).map((id) => {
      const p = ctx.people.find((x) => x.discord_id === id);
      return `<span class="ss-host">${esc(cleanName(p ? p.display_name : id))}<button type="button" data-rm="${esc(id)}" aria-label="Remove">×</button></span>`;
    }).join('');
  };
  f.elements.addhost.addEventListener('change', (e) => {
    const id = e.target.value; e.target.value = '';
    if (id && id !== lead() && !cohosts.includes(id) && cohosts.length < 8) { cohosts.push(id); drawHosts(); }
  });
  f.querySelector('[data-hosts]').addEventListener('click', (e) => {
    const b = e.target.closest('[data-rm]'); if (!b) return;
    cohosts = cohosts.filter((x) => x !== b.dataset.rm); drawHosts();
  });
  f.elements.host?.addEventListener('change', drawHosts);
  drawHosts();
  f.querySelectorAll('.ss-dpt').forEach((b) => b.addEventListener('click', () => {
    dept = b.dataset.dept; f.querySelectorAll('.ss-dpt').forEach((x) => x.classList.toggle('on', x === b));
  }));
  f.onsubmit = async (e) => {
    e.preventDefault();
    if (k === 'department' && !dept) return err('Pick the department.');
    const v = (n) => (f.elements[n] ? f.elements[n].value.trim() : '');
    const data = { kind: k, department: k === 'department' ? dept : null, note: v('note') || null,
      announcement: v('announcement') || null, ping: f.elements.ping.checked,
      location_kind: loc, location_text: loc === 'in_game' ? v('location_text') : null };
    if (loc === 'in_game' && !data.location_text) return err('Type where in the game the session is.');
    if (mode !== 'live') {
      if (!v('date') || !v('time')) return err('Pick a date and a time.');
      data.scheduled_for = sydneyToIso(v('date'), v('time'));
      if (new Date(data.scheduled_for) <= new Date()) return err('That time has already passed.');
    }
    if (mode === 'edit') {
      const h = ctx.people.find((p) => p.discord_id === v('host'));
      if (h) { data.host_discord_id = h.discord_id; data.host_name = cleanName(h.display_name); }
    }
    const btn = f.querySelector('[type=submit]'); btn.disabled = true; const was = btn.textContent; btn.textContent = 'Saving…';
    const q = mode === 'edit'
      ? sb.from('sessions').update(data).eq('id', row.id).eq('status', 'scheduled').select()
      : sb.from('sessions').insert({ ...data, status: mode, host_discord_id: myDiscordId, host_name: $('name').textContent }).select().single();
    const { data: saved, error } = await q;
    if (error) {
      btn.disabled = false; btn.textContent = was;
      return err(error.code === '23505' ? 'A session is already live.' : "Couldn't save: " + error.message);
    }
    const sid = mode === 'edit' ? row.id : (saved && saved.id);
    const before = (opts.coHosts || []).slice().sort().join(), after = cohosts.filter((id) => id !== lead()).sort().join();
    if (sid && before !== after) {
      const { error: he } = await sb.rpc('set_session_hosts', { sid, host_ids: cohosts.filter((id) => id !== lead()) });
      if (he) { btn.disabled = false; btn.textContent = was; return err('Saved, but the co-hosts weren\u2019t: ' + he.message); }
    }
    ctx.done();
  };
  f.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ---------- session banner ----------
// Under the Welcome card: the Maple Hospital custom server and its join code (pinned; the owner will say if it
// changes). Live / next-session status comes once the sessions back end is ready.
let joinCode = '4920-4087';   // fallback; the live value comes from settings or the session
let currentSession = null;   // what the home banner shows; the Sessions tile repeats it
function buildSessionBanner(sess) {
  currentSession = sess;
  const live = sess && sess.live, next = sess && sess.next;
  joinCode = (live && live.join_code) || (sess && sess.code) || joinCode;
  $('join-code').textContent = joinCode;
  const banner = $('session'), label = $('session-label'), status = $('session-status');
  banner.classList.toggle('is-live', !!live);
  if (live) {
    label.textContent = 'Session live now';
    status.textContent = [live.host_name && `Hosted by ${live.host_name}`, live.started_at && `since ${new Date(live.started_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`].filter(Boolean).join(' · ');
  } else if (next) {
    label.textContent = 'Next session';
    status.textContent = [whenAhead(next.scheduled_for), next.host_name && `with ${next.host_name}`].filter(Boolean).join(' · ');
  } else {
    label.textContent = 'Maple Hospital server';
    status.textContent = '';
  }
  status.hidden = !status.textContent;
}
$('copy-join').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(joinCode);
    $('copy-join').textContent = 'Copied';
    setTimeout(() => { $('copy-join').textContent = 'Copy'; }, 1500);
  } catch { /* the code is on screen */ }
});

// ---------- log in with a code ----------
// The site gets a short code from the login-code function; the person types /login CODE in the Discord server; the
// bot confirms; the next poll hands back a session (once). The secret stays in memory only (never stored).
const CODE_POLL_MS = 2000;
let codeLogin = null;   // { code, secret, expiresAt, timer, poller }

async function loginCodeApi(body) {
  const r = await fetch(`${CBH_CONFIG.supabaseUrl}/functions/v1/login-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: CBH_CONFIG.supabaseKey },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

function showLoginView(which) {
  $('login-main').hidden = which !== 'main';
  $('login-code').hidden = which !== 'code';
}

function stopCodeLogin() {
  if (!codeLogin) return;
  clearInterval(codeLogin.timer);
  clearInterval(codeLogin.poller);
  codeLogin = null;
}

function codeError(text, offerNew) {
  stopCodeLogin();
  $('code-box').classList.add('dead');
  $('code-timer').textContent = '';
  $('copy-cmd').disabled = true;
  $('code-error').textContent = text;
  $('code-error').hidden = false;
  $('new-code').hidden = !offerNew;
}

async function startCodeLogin() {
  stopCodeLogin();
  showLoginView('code');
  $('code-box').classList.remove('dead');
  $('code-error').hidden = true;
  $('new-code').hidden = true;
  $('copy-cmd').disabled = true;
  $('code-text').textContent = '···-···';
  $('code-cmd').textContent = '/login';
  $('code-timer').textContent = '';
  let res;
  try {
    res = await loginCodeApi({ action: 'start' });
  } catch {
    return codeError("Couldn't reach CareBeyond. Check your connection and try again.", true);
  }
  if (res.status === 429) return codeError('Lots of people are logging in right now. Try again in a minute.', true);
  if (res.status !== 200 || !res.data.code) return codeError("Couldn't get a code. Try again in a moment.", true);
  const { code, secret, expires_in } = res.data;
  $('code-text').textContent = code;
  $('code-cmd').textContent = '/login ' + code;
  $('copy-cmd').disabled = false;
  $('copy-cmd').textContent = 'Copy';
  codeLogin = { code, secret, expiresAt: Date.now() + expires_in * 1000 };
  const tick = () => {
    const left = Math.max(0, Math.round((codeLogin.expiresAt - Date.now()) / 1000));
    $('code-timer').textContent = `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    if (!left) codeError('This code has expired.', true);
  };
  tick();
  codeLogin.timer = setInterval(tick, 1000);
  codeLogin.poller = setInterval(pollCodeLogin, CODE_POLL_MS);
}

let polling = false;
async function pollCodeLogin() {
  if (!codeLogin || polling || document.hidden) return;
  polling = true;
  const { code, secret } = codeLogin;
  try {
    const { status, data } = await loginCodeApi({ action: 'poll', code, secret });
    if (!codeLogin || codeLogin.code !== code) return;          // cancelled meanwhile
    if (status !== 200) return;                                // a hiccup: try again next time
    if (data.status === 'expired') return codeError('This code has expired.', true);
    if (data.status === 'not_member') {
      return codeError("We couldn't find you in the CareBeyond - Hospital server. Join it with your Discord account, then get a new code.", true);
    }
    if (data.status === 'done' && data.session) {
      stopCodeLogin();
      const { error } = await sb.auth.setSession(data.session);   // onSession then loads the dashboard
      if (error) codeError("Couldn't log you in: " + error.message, true);
    }
  } catch {
    // offline for a moment: keep trying until the code expires
  } finally {
    polling = false;
  }
}

$('code-login').addEventListener('click', startCodeLogin);
$('new-code').addEventListener('click', startCodeLogin);
$('code-back').addEventListener('click', () => { stopCodeLogin(); showLoginView('main'); });
$('copy-cmd').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('code-cmd').textContent);
    $('copy-cmd').textContent = 'Copied';
    setTimeout(() => { $('copy-cmd').textContent = 'Copy'; }, 1500);
  } catch {
    // clipboard blocked: the command is on screen to type
  }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && codeLogin) pollCodeLogin(); });

$('logout').addEventListener('click', async () => {
  await sb.auth.signOut();
  onSession(null);
});

// A failed Discord login comes back with ?error_description=... in the address. Show it, then tidy the address.
(function showLoginError() {
  const params = new URLSearchParams(location.search + '&' + location.hash.slice(1));
  const desc = params.get('error_description');
  if (!desc) return;
  $('login-error').textContent = "Discord login didn't work: " + desc + '. Ask the Hospital Director to check the dashboard setup.';
  $('login-error').hidden = false;
  history.replaceState(null, '', location.pathname);
})();

sb.auth.onAuthStateChange((_event, session) => onSession(session));
sb.auth.getSession().then(({ data }) => onSession(data.session));
