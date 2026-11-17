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
  const [acc, sess, reviewTeams] = await Promise.all([
    sb.rpc('my_access').then((r) => r.data || null, () => null),
    fetchSession(),
    // Teams that review a form (forms.review_team): their leads may review submissions. null = execs only.
    sb.from('forms').select('review_team').then((r) => [...new Set((r.data || []).map((f) => f.review_team).filter(Boolean))], () => []),
  ]);
  return { me, roles, departments, access: acc, session: sess, reviewTeams };
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
  setAccess(me, roles, data.access, data.reviewTeams);
  buildMenu();
  buildSessionBanner(data.session);
  buildSessionAdmin(data.session);
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
  { id: 'admin',    label: 'Admin' },
  { id: 'staff',    label: 'Staff' },
  { id: 'everyone', label: 'Everyone' },
];
// id = route (#id); hubs hold tools (#hub/tool). `photo`: a Roblox screenshot in assets/photos/ (tinted by CSS).
const PAGES = [
  { id: 'exec', aud: 'exec', title: 'Executive hub', icon: 'crown', wide: true, tools: [
    { id: 'reports',  title: 'Reports',       icon: 'bar-chart', layout: 'reports' },
    { id: 'strikes',  title: 'Strikes',       icon: 'error',     layout: 'list', building: true },
    { id: 'announce', title: 'Announcements', icon: 'megaphone', layout: 'form', building: true },
    { id: 'settings', title: 'Bot settings',  icon: 'settings',  layout: 'settings', building: true },
  ] },
  { id: 'admin', aud: 'admin', title: 'Admin hub', icon: 'shield', wide: true, tools: [
    { id: 'cases',        title: 'Mod reports',  icon: 'law',     layout: 'cases' },
    { id: 'logs',         title: 'Discord logs', icon: 'history', layout: 'logs' },
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
function setAccess(me, roles, acc, reviewTeams = []) {
  if (acc) {   // my_access() in Supabase: the same rules the database uses (RLS)
    access = { exec: !!acc.exec, admin: !!acc.admin, staff: !!acc.team || !!me.is_staff, everyone: true,
      leads: !acc.admin && (acc.leads || []).length > 0,
      reviewer: !!acc.exec || (acc.leads || []).some((d) => reviewTeams.includes(d)) };
    access['reviewer-lead'] = access.reviewer && !acc.admin;
    return;
  }
  const exec = roles.some((r) => r.kind === 'leadership' || r.kind === 'executive');
  const admin = exec || roles.some((r) => r.department === 'Administration');
  access = { exec, admin, staff: !!me.is_staff || admin, everyone: true };
}
const canSee = (aud) => !!access[aud];
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

function buildMenu() {
  const nav = $('menu');
  nav.replaceChildren();
  for (const aud of AUDIENCES) {
    const pages = PAGES.filter((p) => (p.aud === aud.id && canSee(p.aud)) || (aud.id === 'staff' && ['leads', 'reviewer-lead'].includes(p.aud) && canSee(p.aud)));
    if (!pages.length) continue;
    const group = document.createElement('section');
    group.className = `menu-group aud-${aud.id}`;
    group.innerHTML = `<h2 class="menu-label"><span class="aud-dot"></span>${aud.label}</h2>`;
    const grid = document.createElement('div');
    grid.className = 'menu-grid' + (pages.filter((p) => !p.wide).length === 2 ? ' n2' : '');
    for (const p of pages) grid.append(tileEl('#' + p.id, p, aud.id));
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
    ['/contact', 'team subject message', 'Contact a team: Administration (support), Nursing, Paramedicine or Community Engagement (partnerships). Replies come by DM; reply by DMing the bot.'],
  ] },
  { aud: 'staff', title: 'Department members · shifts', cmds: [
    ['/shift start', '[department]', 'Start a shift (pick a department if you’re in more than one).'],
    ['/shift break', '', 'Start or end a break.'],
    ['/shift end', '', 'End your shift.'],
    ['/shift status', '', 'Your current shift and this week’s hours.'],
  ] },
  { aud: 'admin', title: 'Admins · moderation', note: 'Each is saved as a case, posted to #server-logs, and the member gets a DM where possible. You can’t act on someone with the same or a higher role.', cmds: [
    ['/warn', 'member reason', 'Warn a member.'],
    ['/timeout', 'member length reason', 'Time out for 10 minutes, 1 hour, 6 hours, 1 day, 3 days or 1 week.'],
    ['/untimeout', 'member [reason]', 'Remove a timeout.'],
    ['/kick', 'member reason', 'Kick a member.'],
    ['/ban', 'member reason [delete_messages]', 'Ban a member, optionally deleting their last 1 or 7 days of messages.'],
    ['/unban', 'user_id reason', 'Unban someone by their Discord ID.'],
    ['/cases', 'member', 'Their last 10 cases.'],
  ] },
  { aud: 'exec', title: 'Executives', cmds: [
    ['/joincode', 'code', 'Change the Maple Hospital server join code (the website banner and the USE CODE channel update).'],
  ] },
];
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
function findRoute() {
  const [a, b] = location.hash.slice(1).split('/');
  const page = PAGES.find((p) => p.id === a && canSee(p.aud));
  if (!page) return null;
  if (!b) return { page };
  const tool = (page.tools || []).find((t) => t.id === b && canSee(t.aud || page.aud));
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
  $('signed-in').hidden = !!r;
  $('session').hidden = !!r;
  $('session-admin').hidden = !!r || !access.admin;
  $('menu').hidden = !!r;
  $('page').hidden = !r;
  if (!r) { document.title = 'CareBeyond Dashboard'; fitBadges(); return; }
  const { page, tool } = r;
  const back = $('page').querySelector('.back');
  back.href = tool ? '#' + page.id : '#';
  back.lastChild.textContent = tool ? page.title : 'Menu';
  const body = $('page-body');
  body.classList.remove('is-building');
  if (tool) {
    setPageTitle(tool.icon, tool.title, tool.aud === 'reviewer' ? 'exec' : (tool.aud || page.aud));
    if (LIVE[tool.layout]) LIVE[tool.layout](body);
    else { body.innerHTML = (tool.building ? BUILDING_NOTE(tool.title) : '') + LAYOUTS[tool.layout](); body.classList.toggle('is-building', !!tool.building); }
  } else if (page.tools) {
    setPageTitle(page.icon, page.title, page.aud);
    const grid = document.createElement('div');
    grid.className = 'hub-grid';
    for (const t of page.tools.filter((x) => canSee(x.aud || page.aud))) {
      const a = tileEl(`#${page.id}/${t.id}`, t, t.aud === 'reviewer' ? 'exec' : (t.aud || page.aud), 'tool');
      if (t.aud && t.aud !== page.aud) {
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

// ----- Mod reports (#admin/cases) -----
const CASE_ACTIONS = [
  { id: 'warn', label: 'Warn' }, { id: 'timeout', label: 'Timeout' }, { id: 'kick', label: 'Kick' },
  { id: 'ban', label: 'Ban' }, { id: 'unban', label: 'Unban' }, { id: 'note', label: 'Note' },
];
const ACTION_LABEL = { warn: 'Warn', timeout: 'Timeout', untimeout: 'Timeout removed', kick: 'Kick', ban: 'Ban', unban: 'Unban', note: 'Note' };
const SOURCE_LABEL = { discord: 'Discord', website: 'Website', in_game: 'In game' };

async function renderCases(body) {
  let filter = 'all';
  body.innerHTML = `
    <div class="toolbar">
      <button class="refresh" id="case-new">New report</button>
      <div class="chips" id="case-filter">${[{ id: 'all', label: 'All' }, ...CASE_ACTIONS].map((a) =>
        `<button class="chip${a.id === 'all' ? ' on' : ''}" data-f="${a.id}">${a.label}</button>`).join('')}</div>
    </div>
    <form class="card case-form" id="case-form" hidden>
      <div class="seg" id="case-action">${CASE_ACTIONS.map((a, i) =>
        `<button type="button" class="seg-btn${i === 0 ? ' on' : ''}" data-a="${a.id}">${a.label}</button>`).join('')}</div>
      <div class="f-row">
        <label class="f"><span>Who</span><input id="case-target" required maxlength="100" placeholder="Their Discord or Roblox name"></label>
        <label class="f"><span>Discord ID <em>(optional)</em></span><input id="case-target-id" inputmode="numeric" pattern="[0-9]{15,22}" placeholder="e.g. 1142255844453523527"></label>
      </div>
      <div class="f-row">
        <label class="f" id="case-dur-wrap" hidden><span>Length (minutes)</span><input id="case-dur" type="number" min="1" max="40320" placeholder="60"></label>
        <label class="f"><span>Where</span><select id="case-source"><option value="in_game">In game (Maple Hospital)</option><option value="website">Discord / other</option></select></label>
      </div>
      <label class="f"><span>Reason</span><textarea id="case-reason" required maxlength="1000" rows="3"></textarea></label>
      <p class="error" id="case-error" hidden></p>
      <div class="f-actions"><button type="button" class="linkish" id="case-cancel">Cancel</button><button class="refresh" type="submit">Save report</button></div>
    </form>
    <div class="card" id="case-list"><p class="muted small">Loading…</p></div>`;

  const form = body.querySelector('#case-form');
  let action = 'warn';
  const showDur = () => { body.querySelector('#case-dur-wrap').hidden = !['timeout', 'ban'].includes(action); };
  body.querySelector('#case-new').onclick = () => { form.hidden = !form.hidden; if (!form.hidden) body.querySelector('#case-target').focus(); };
  body.querySelector('#case-cancel').onclick = () => { form.hidden = true; };
  body.querySelector('#case-action').onclick = (e) => {
    const b = e.target.closest('.seg-btn'); if (!b) return;
    action = b.dataset.a;
    body.querySelectorAll('#case-action .seg-btn').forEach((x) => x.classList.toggle('on', x === b));
    showDur();
  };
  body.querySelector('#case-filter').onclick = (e) => {
    const b = e.target.closest('.chip'); if (!b) return;
    filter = b.dataset.f;
    body.querySelectorAll('#case-filter .chip').forEach((x) => x.classList.toggle('on', x === b));
    load();
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = body.querySelector('#case-error');
    err.hidden = true;
    const dur = parseInt(body.querySelector('#case-dur').value, 10);
    const row = {
      action,
      target_name: body.querySelector('#case-target').value.trim(),
      target_discord_id: body.querySelector('#case-target-id').value.trim() || null,
      reason: body.querySelector('#case-reason').value.trim(),
      duration_minutes: ['timeout', 'ban'].includes(action) && dur > 0 ? dur : null,
      source: body.querySelector('#case-source').value,
      moderator_discord_id: myDiscordId,
      moderator_name: $('name').textContent,
    };
    const { error } = await sb.from('mod_cases').insert(row);
    if (error) { err.textContent = "Couldn't save the report: " + error.message; err.hidden = false; return; }
    form.reset(); form.hidden = true; load();
  };

  async function load() {
    const list = body.querySelector('#case-list');
    let q = sb.from('mod_cases').select('*').order('created_at', { ascending: false }).limit(100);
    if (filter !== 'all') q = q.eq('action', filter);
    const { data, error } = await q;
    if (error) { list.innerHTML = ''; return liveError(list, error); }
    if (!data.length) { list.innerHTML = `<p class="muted small">${filter === 'all' ? 'No reports yet.' : 'None of these yet.'}</p>`; return; }
    list.innerHTML = data.map((c) => `
      <div class="row-item case">
        <span class="act act-${esc(c.action)}">${esc(ACTION_LABEL[c.action] || c.action)}</span>
        <div class="case-main">
          <div><strong>${esc(c.target_name || c.target_discord_id || 'Unknown')}</strong>${c.duration_minutes ? ` <span class="muted">· ${c.duration_minutes} min</span>` : ''}</div>
          <div class="case-reason">${esc(c.reason)}</div>
          <div class="muted small-meta">by ${esc(c.moderator_name || 'unknown')} · ${esc(SOURCE_LABEL[c.source] || c.source)} · ${when(c.created_at)}</div>
        </div>
      </div>`).join('');
  }
  load();
}

// ----- Discord logs (#admin/logs) -----
const LOG_GROUPS = [
  { id: 'all', label: 'All', types: null },
  { id: 'messages', label: 'Messages', types: ['message_delete', 'message_edit'] },
  { id: 'members', label: 'Joins & leaves', types: ['member_join', 'member_leave'] },
  { id: 'roles', label: 'Roles & names', types: ['roles_change', 'nickname_change'] },
  { id: 'mod', label: 'Moderation', types: ['member_ban', 'member_unban', 'timeout'] },
];
const LOG_LABEL = {
  message_delete: 'Message deleted', message_edit: 'Message edited', member_join: 'Joined', member_leave: 'Left',
  member_ban: 'Banned', member_unban: 'Unbanned', roles_change: 'Roles changed', nickname_change: 'Nickname changed', timeout: 'Timed out',
};
function logDetail(l) {
  const d = l.details || {};
  switch (l.type) {
    case 'message_delete': return `<div class="log-quote">${esc(d.content || '(no text)')}</div>${d.attachments?.length ? `<div class="muted small-meta">${d.attachments.length} attachment(s)</div>` : ''}`;
    case 'message_edit': return `<div class="log-quote was">${esc(d.before || '')}</div><div class="log-quote">${esc(d.after || '')}</div>`;
    case 'roles_change': return `<div class="small-meta">${(d.added || []).map((r) => `<span class="rchip add">+ ${esc(r)}</span>`).join('')}${(d.removed || []).map((r) => `<span class="rchip rem">− ${esc(r)}</span>`).join('')}</div>`;
    case 'nickname_change': return `<div class="small-meta">${esc(d.before || '(none)')} → ${esc(d.after || '(none)')}</div>`;
    case 'member_join': return d.account_age_days != null ? `<div class="muted small-meta">Account ${d.account_age_days} days old${d.account_age_days < 7 ? ' · <strong class="warn-text">new account</strong>' : ''}</div>` : '';
    default: return '';
  }
}

async function renderLogs(body) {
  const PAGE = 50;
  let group = 'all', offset = 0;
  body.innerHTML = `
    <div class="toolbar"><div class="chips" id="log-filter">${LOG_GROUPS.map((g) =>
      `<button class="chip${g.id === 'all' ? ' on' : ''}" data-g="${g.id}">${g.label}</button>`).join('')}</div></div>
    <div class="card" id="log-list"><p class="muted small">Loading…</p></div>
    <div class="center"><button class="ghost" id="log-more" hidden>Load more</button></div>`;
  const list = body.querySelector('#log-list');
  body.querySelector('#log-filter').onclick = (e) => {
    const b = e.target.closest('.chip'); if (!b) return;
    group = b.dataset.g; offset = 0;
    body.querySelectorAll('#log-filter .chip').forEach((x) => x.classList.toggle('on', x === b));
    load(true);
  };
  body.querySelector('#log-more').onclick = () => load(false);
  async function load(fresh) {
    let q = sb.from('discord_logs').select('*').order('at', { ascending: false }).range(offset, offset + PAGE - 1);
    const g = LOG_GROUPS.find((x) => x.id === group);
    if (g.types) q = q.in('type', g.types);
    const { data, error } = await q;
    if (fresh) list.innerHTML = '';
    if (error) return liveError(list, error);
    if (fresh && !data.length) list.innerHTML = '<p class="muted small">Nothing logged yet.</p>';
    list.insertAdjacentHTML('beforeend', data.map((l) => `
      <div class="row-item log">
        <span class="log-type t-${esc(l.type)}">${esc(LOG_LABEL[l.type] || l.type)}</span>
        <div class="case-main">
          <div><strong>${esc(l.user_name || l.user_discord_id || 'Unknown')}</strong>${l.channel_name ? ` <span class="muted">in #${esc(l.channel_name)}</span>` : ''}</div>
          ${logDetail(l)}
        </div>
        <span class="muted small-meta when">${when(l.at)}</span>
      </div>`).join(''));
    offset += data.length;
    body.querySelector('#log-more').hidden = data.length < PAGE;
  }
  load(true);
}

const LIVE = { cases: renderCases, logs: renderLogs };

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

// ----- Apply (#apply) and Applications review (#admin/applications, #review) — back end: Bravo, migration 0006 -----
// Questions come from the forms table (placeholders until the owner sends the real ones), never hard-coded here.
const SUB_STATUS = { pending: 'Waiting', accepted: 'Accepted', denied: 'Not accepted', reviewed: 'Reviewed' };
const formAllowed = (f) => f.open && (f.audience === 'member' || (f.audience === 'team' && access.staff) || (f.audience === 'admin' && access.admin));

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

async function renderApply(body) {
  body.innerHTML = '<div class="card"><p class="muted small">Loading…</p></div>';
  const [{ data: forms, error }, { data: mine }] = await Promise.all([
    sb.from('forms').select('*').order('sort'),
    sb.from('form_submissions').select('id, form_key, status, review_note, created_at').eq('submitter_discord_id', myDiscordId).order('created_at', { ascending: false }),
  ]);
  if (error) { body.innerHTML = ''; return liveError(body, error); }
  const list = forms.filter(formAllowed);
  const title = (k) => (forms.find((f) => f.key === k) || {}).title || k;
  body.innerHTML = `
    <div class="form-list">${list.map((f) => `
      <button class="card form-card" data-k="${esc(f.key)}">
        <span class="t-ico" style="--c:${f.kind === 'report' ? '#5c72ff' : '#3a82d0'};--icon:${iconUrl(f.kind === 'report' ? 'law' : 'resume')}" aria-hidden="true"></span>
        <span class="case-main"><strong>${esc(f.title)}</strong>${f.description ? `<span class="muted small-meta">${esc(f.description)}</span>` : ''}</span>
        <span class="go" aria-hidden="true">›</span>
      </button>`).join('') || '<div class="card"><p class="muted small">Nothing open right now.</p></div>'}</div>
    ${mine && mine.length ? `<h2 class="menu-label aud-everyone"><span class="aud-dot"></span>Your submissions</h2>
      <div class="card">${mine.map((s) => `
        <div class="row-item"><div class="case-main"><strong>${esc(title(s.form_key))}</strong>
          <span class="muted small-meta">${when(s.created_at)}${s.review_note ? ` · “${esc(s.review_note)}”` : ''}</span></div>
          <span class="st sub-${esc(s.status)}">${esc(SUB_STATUS[s.status] || s.status)}</span></div>`).join('')}</div>` : ''}`;
  body.querySelector('.form-list').onclick = (e) => {
    const b = e.target.closest('.form-card'); if (!b) return;
    renderForm(body, list.find((f) => f.key === b.dataset.k));
  };
}

function renderForm(body, form) {
  body.innerHTML = `
    <button class="back inline-back" type="button"><span class="back-ico" aria-hidden="true"></span>All forms</button>
    <form class="card case-form" id="ap-form">
      <div><h2 class="form-title">${esc(form.title)}</h2>${form.description ? `<p class="muted">${esc(form.description)}</p>` : ''}</div>
      ${(form.questions || []).map(questionField).join('')}
      <p class="error" id="ap-err" hidden></p>
      <div class="f-actions"><button class="refresh" type="submit">${form.kind === 'report' ? 'Send report' : 'Send application'}</button></div>
    </form>`;
  body.querySelector('.inline-back').onclick = () => renderApply(body);
  const yesno = {};
  body.querySelectorAll('[data-yesno]').forEach((g) => g.addEventListener('click', (e) => {
    const b = e.target.closest('.seg-btn'); if (!b) return;
    yesno[g.dataset.yesno] = b.dataset.v;
    g.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('on', x === b));
  }));
  body.querySelector('#ap-form').onsubmit = async (e) => {
    e.preventDefault();
    const err = body.querySelector('#ap-err'); err.hidden = true;
    const answers = {};
    for (const q of form.questions || []) {
      const id = `q-${q.id}`;
      const v = q.type === 'yesno' ? yesno[id] : body.querySelector('#' + CSS.escape(id))?.value.trim();
      if (q.required && !v) { err.textContent = `Please answer “${q.label}”.`; err.hidden = false; return; }
      if (v) answers[q.id] = q.type === 'number' ? Number(v) : v;
    }
    const { error } = await sb.from('form_submissions').insert({ form_key: form.key, submitter_discord_id: myDiscordId, submitter_name: $('name').textContent, answers });
    if (error) { err.textContent = "Couldn't send: " + error.message; err.hidden = false; return; }
    body.innerHTML = `<div class="card center sent"><span class="t-ico big" style="--c:#2ed3c6;--icon:${iconUrl('verified')}" aria-hidden="true"></span>
      <h2 class="form-title">Sent</h2><p class="muted">${form.kind === 'report' ? 'The admin team has your report.' : 'You’ll get a DM from CareBeyond Helper when it’s been reviewed.'}</p>
      <button class="ghost" id="ap-done">Done</button></div>`;
    body.querySelector('#ap-done').onclick = () => renderApply(body);
  };
}

async function renderReview(body) {
  let filter = 'pending';
  body.innerHTML = `
    <div class="toolbar"><div class="chips" id="rv-filter"><button class="chip on" data-f="pending">Waiting</button><button class="chip" data-f="done">Done</button></div></div>
    <div class="card" id="rv-list"><p class="muted small">Loading…</p></div>`;
  const { data: forms } = await sb.from('forms').select('key, title, kind, questions');
  const fmap = Object.fromEntries((forms || []).map((f) => [f.key, f]));
  body.querySelector('#rv-filter').onclick = (e) => {
    const b = e.target.closest('.chip'); if (!b) return;
    filter = b.dataset.f;
    body.querySelectorAll('#rv-filter .chip').forEach((x) => x.classList.toggle('on', x === b));
    load();
  };
  const list = body.querySelector('#rv-list');
  async function load() {
    let q = sb.from('form_submissions').select('*').order('created_at', { ascending: false }).limit(100);
    q = filter === 'pending' ? q.eq('status', 'pending') : q.neq('status', 'pending');
    const { data, error } = await q;
    if (error) { list.innerHTML = ''; return liveError(list, error); }
    list.innerHTML = data.length ? data.map((s) => `
      <button class="row-item ticket" data-id="${s.id}">
        <span class="t-ico" style="--c:${fmap[s.form_key]?.kind === 'report' ? '#5c72ff' : '#3a82d0'};--icon:${iconUrl(fmap[s.form_key]?.kind === 'report' ? 'law' : 'resume')}" aria-hidden="true"></span>
        <span class="case-main"><strong>${esc(s.submitter_name || 'Unknown')}</strong>
          <span class="muted small-meta">${esc(fmap[s.form_key]?.title || s.form_key)} · ${when(s.created_at)}${s.reviewer_name ? ` · ${esc(s.reviewer_name)}` : ''}</span></span>
        <span class="st sub-${esc(s.status)}">${esc(SUB_STATUS[s.status] || s.status)}</span>
      </button>`).join('') : `<p class="muted small">${filter === 'pending' ? 'Nothing waiting.' : 'Nothing reviewed yet.'}</p>`;
    list.onclick = (e) => {
      const b = e.target.closest('.ticket'); if (!b) return;
      const s = data.find((x) => String(x.id) === b.dataset.id);
      renderSubmission(body, s, fmap[s.form_key] || { title: s.form_key, kind: 'application', questions: [] });
    };
  }
  load();
}

function renderSubmission(body, s, form) {
  const qs = form.questions || [];
  const label = (id) => (qs.find((q) => q.id === id) || {}).label || id;
  const isReport = form.kind === 'report';
  body.innerHTML = `
    <button class="back inline-back" type="button"><span class="back-ico" aria-hidden="true"></span>All submissions</button>
    <div class="card thread-head"><div class="case-main"><strong class="thread-subject">${esc(s.submitter_name || 'Unknown')}</strong>
      <span class="muted small-meta">${esc(form.title)} · ${when(s.created_at)}</span></div>
      <span class="st sub-${esc(s.status)}">${esc(SUB_STATUS[s.status] || s.status)}</span></div>
    <div class="card answers">${Object.entries(s.answers || {}).map(([k, v]) => `
      <div class="answer"><div class="answer-q">${esc(label(k))}</div><div class="answer-a">${esc(v)}</div></div>`).join('') || '<p class="muted small">No answers.</p>'}</div>
    ${s.status === 'pending' ? `<form class="card case-form" id="rv-form">
      <label class="f"><span>Note to ${isReport ? 'the file' : 'the applicant'} <em>(optional)</em></span><textarea id="rv-note" rows="2" maxlength="1000"></textarea></label>
      <p class="error" id="rv-err" hidden></p>
      <div class="f-actions">${isReport ? '<button type="button" class="refresh" data-s="reviewed">Mark reviewed</button>'
        : '<button type="button" class="ghost deny" data-s="denied">Deny</button><button type="button" class="refresh" data-s="accepted">Accept</button>'}</div>
    </form>` : (s.review_note ? `<div class="card"><div class="answer-q">Note</div><div class="answer-a">${esc(s.review_note)}</div></div>` : '')}`;
  body.querySelector('.inline-back').onclick = () => renderReview(body);
  body.querySelector('#rv-form')?.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-s]'); if (!b) return;
    const { data, error } = await sb.from('form_submissions').update({
      status: b.dataset.s, reviewer_discord_id: myDiscordId, reviewer_name: $('name').textContent,
      review_note: body.querySelector('#rv-note').value.trim() || null, reviewed_at: new Date().toISOString(),
    }).eq('id', s.id).eq('status', 'pending').select();
    const err = body.querySelector('#rv-err');
    if (error) { err.textContent = "Couldn't save: " + error.message; err.hidden = false; return; }
    if (!data || !data.length) { err.textContent = 'Someone else has already reviewed this.'; err.hidden = false; return; }
    renderReview(body);
  });
}

// ----- Shifts (#shifts): started and ended in Discord only; the page shows who's on and your hours -----
const shiftSecs = (s, now = Date.now()) => Math.max(0, ((s.ended_at ? new Date(s.ended_at) : now) - new Date(s.started_at)) / 1000
  - (s.break_seconds || 0) - (s.status === 'break' && s.break_started_at ? (now - new Date(s.break_started_at)) / 1000 : 0));
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

async function renderShifts(body) {
  body.innerHTML = '<div class="card"><p class="muted small">Loading…</p></div>';
  const week = weekStartSydney();
  const [on, mine] = await Promise.all([
    sb.from('shifts').select('*').neq('status', 'ended').order('started_at'),
    sb.from('shifts').select('*').eq('discord_id', myDiscordId).order('started_at', { ascending: false }).limit(20),
  ]);
  if (on.error) { body.innerHTML = ''; return liveError(body, on.error); }
  const myNow = (on.data || []).find((s) => s.discord_id === myDiscordId);
  const weekSecs = (mine.data || []).filter((s) => s.started_at >= week).reduce((a, s) => a + shiftSecs(s), 0);
  body.innerHTML = `
    <div class="card shift-me">
      <span class="t-ico big" style="--c:${myNow ? '#16b364' : '#9aa9c4'};--icon:${iconUrl('clock')}" aria-hidden="true"></span>
      <div class="case-main"><strong class="thread-subject">${myNow ? (myNow.status === 'break' ? 'On a break' : 'On shift') : 'Off shift'}</strong>
        <span class="muted small-meta">${myNow ? `${esc(myNow.department)} · ${hrs(shiftSecs(myNow))} so far` : 'Start a shift in Discord with /shift start'}</span></div>
      <div class="stat-mini"><span class="muted small-meta">This week</span><strong>${hrs(weekSecs)}</strong></div>
    </div>
    <div class="cmd-strip">${['/shift start', '/shift break', '/shift end', '/shift status'].map((c) => `<code class="cmd">${c}</code>`).join('')}</div>
    <h2 class="menu-label aud-staff"><span class="aud-dot"></span>On now</h2>
    <div class="card">${(on.data || []).length ? on.data.map((s) => `
      <div class="row-item"><span class="dot-status ${s.status === 'break' ? 'brk' : 'on'}"></span>
        <div class="case-main"><strong>${esc(s.name)}</strong><span class="muted small-meta">${esc(s.department)}${s.status === 'break' ? ' · on a break' : ''}</span></div>
        <span class="muted small-meta">${hrs(shiftSecs(s))}</span></div>`).join('') : '<p class="muted small">Nobody is on shift right now.</p>'}</div>
    <h2 class="menu-label aud-staff"><span class="aud-dot"></span>Your shifts</h2>
    <div class="card">${(mine.data || []).length ? mine.data.map((s) => `
      <div class="row-item"><div class="case-main"><strong>${new Date(s.started_at).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}</strong>
        <span class="muted small-meta">${esc(s.department)} · ${new Date(s.started_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${s.ended_at ? '–' + new Date(s.ended_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ' · now'}${s.ended_by === 'auto' ? ' · ended automatically' : ''}</span></div>
        <strong>${hrs(shiftSecs(s))}</strong></div>`).join('') : '<p class="muted small">No shifts yet.</p>'}</div>`;
}

// ----- Reports (#exec/reports) -----
async function renderReports(body) {
  const ranges = {
    week: () => [weekStartSydney(), new Date().toISOString()],
    last: () => { const s = new Date(weekStartSydney()); return [new Date(s - 7 * 864e5).toISOString(), s.toISOString()]; },
    d30: () => [new Date(Date.now() - 30 * 864e5).toISOString(), new Date().toISOString()],
  };
  let range = 'week';
  body.innerHTML = `
    <div class="toolbar"><div class="chips" id="rp-range"><button class="chip on" data-r="week">This week</button><button class="chip" data-r="last">Last week</button><button class="chip" data-r="d30">Last 30 days</button></div></div>
    <div id="rp-body"><div class="card"><p class="muted small">Loading…</p></div></div>`;
  body.querySelector('#rp-range').onclick = (e) => {
    const b = e.target.closest('.chip'); if (!b) return;
    range = b.dataset.r;
    body.querySelectorAll('#rp-range .chip').forEach((x) => x.classList.toggle('on', x === b));
    load();
  };
  async function load() {
    const out = body.querySelector('#rp-body');
    const [from_ts, to_ts] = ranges[range]();
    const { data, error } = await sb.rpc('shift_report', { from_ts, to_ts });
    if (error) { out.innerHTML = ''; return liveError(out, error); }
    const rows = (data || []).slice().sort((a, b) => b.hours - a.hours);
    const total = rows.reduce((a, r) => a + Number(r.hours || 0), 0), shifts = rows.reduce((a, r) => a + Number(r.shifts || 0), 0);
    const depts = {};
    rows.forEach((r) => { depts[r.department] = (depts[r.department] || 0) + Number(r.hours || 0); });
    const max = Math.max(1, ...Object.values(depts));
    out.innerHTML = `
      <div class="grid-3">
        <div class="card tight stat"><span class="muted small-meta">Hours</span><strong>${total.toFixed(1)}</strong></div>
        <div class="card tight stat"><span class="muted small-meta">Shifts</span><strong>${shifts}</strong></div>
        <div class="card tight stat"><span class="muted small-meta">People</span><strong>${rows.length}</strong></div>
      </div>
      ${Object.keys(depts).length ? `<div class="card bars">${Object.entries(depts).sort((a, b) => b[1] - a[1]).map(([d, h]) => {
        const t = TEAMS.find((x) => x.id === d);
        return `<div class="bar-row"><span class="bar-label">${esc(d)}</span><span class="meter"><span style="width:${(h / max) * 100}%;--c:${t ? hex(t.color) : '#3a82d0'}"></span></span><span class="bar-val">${h.toFixed(1)}h</span></div>`;
      }).join('')}</div>` : ''}
      <div class="card">${rows.length ? rows.map((r, i) => `
        <div class="row-item"><span class="rank-n">${i + 1}</span><div class="case-main"><strong>${esc(r.name)}</strong><span class="muted small-meta">${esc(r.department)} · ${r.shifts} shift${r.shifts == 1 ? '' : 's'}</span></div>
          <strong>${Number(r.hours).toFixed(1)}h</strong></div>`).join('') : '<p class="muted small">No shifts in this period.</p>'}</div>`;
  }
  load();
}

// ----- Staff & roster (#roster) -----
// Compact badges for person cards: a department + its rank stay one block ("Nursing · Year 5" style, shortened).
function personBadges(badges) {
  const one = (b) => `<span class="rbadge${b.joined ? ' joined' : ''}" style="--c:${b.color ? hex(b.color) : '#9aa9c4'}">${b.icon ? `<span class="ri" style="--icon:${iconUrl(b.icon)}"></span>` : ''}<span class="rl">${esc(b.label.replace(/ Department$/, ''))}</span></span>`;
  let html = '';
  for (let i = 0; i < badges.length; i++) {
    if (badges[i + 1] && badges[i + 1].joined) { html += `<span class="pair">${one(badges[i])}${one(badges[i + 1])}</span>`; i++; }
    else html += one(badges[i]);
  }
  return html;
}
async function renderRoster(body) {
  body.innerHTML = '<div class="card"><p class="muted small">Loading…</p></div>';
  const [{ data: people, error }, { data: allRoles }] = await Promise.all([
    sb.rpc('roster'), sb.from('roles').select('id, name, color, position, kind, department, rank_label, rank_order, badge_color'),
  ]);
  if (error) { body.innerHTML = ''; return liveError(body, error); }
  const byId = Object.fromEntries((allRoles || []).map((r) => [r.id, r]));
  const depts = (allRoles || []).filter((r) => r.kind === 'department');
  const groups = {};
  for (const p of people || []) {
    const roles = (p.role_ids || []).map((id) => byId[id]).filter(Boolean);
    const lead = roles.some((r) => r.kind === 'leadership');
    const ranks = roles.filter((r) => r.kind === 'rank').sort((a, b) => b.rank_order - a.rank_order);
    const dept = lead ? 'Leadership' : (ranks[0]?.department || roles.find((r) => r.kind === 'department')?.department || 'Other');
    (groups[dept] ||= []).push({ ...p, roles, order: lead ? Math.max(...roles.filter((r) => r.kind === 'leadership').map((r) => r.position)) : (ranks[0]?.rank_order || 0) });
  }
  const order = ['Leadership', 'Administration', 'Nursing', 'Paramedicine', 'Community Engagement', 'Other'].filter((d) => groups[d]);
  let pick = 'all';
  const draw = () => {
    body.querySelector('#ro-list').innerHTML = order.filter((d) => pick === 'all' || pick === d).map((d) => `
      <h2 class="menu-label aud-staff"><span class="aud-dot"></span>${esc(d)} <span class="muted count">${groups[d].length}</span></h2>
      <div class="grid-people">${groups[d].sort((a, b) => b.order - a.order || a.display_name.localeCompare(b.display_name)).map((p) => {
        const all = buildBadges(p.roles, depts).filter((b) => b.label !== 'Verified' && b.label !== 'Member');
        const badges = all.slice(0, all[1] && all[1].joined ? 2 : 1).concat(all[1] && !all[1].joined ? [all[1]] : []);
        return `<div class="card person">
          <img class="avatar big" src="${esc(sized(p.avatar_url || '', 128))}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
          <strong class="person-name">${esc(cleanName(p.display_name))}</strong>
          <div class="person-badges">${personBadges(badges)}</div>
        </div>`;
      }).join('')}</div>`).join('') || '<div class="card"><p class="muted small">Nobody to show.</p></div>';
  };
  body.innerHTML = `<div class="toolbar"><div class="chips" id="ro-filter"><button class="chip on" data-d="all">Everyone</button>${order.map((d) => `<button class="chip" data-d="${esc(d)}">${esc(d)}</button>`).join('')}</div></div><div id="ro-list" class="page-body"></div>`;
  body.querySelector('#ro-filter').onclick = (e) => {
    const b = e.target.closest('.chip'); if (!b) return;
    pick = b.dataset.d;
    body.querySelectorAll('#ro-filter .chip').forEach((x) => x.classList.toggle('on', x === b));
    draw();
  };
  draw();
}

Object.assign(LIVE, { apply: renderApply, review: renderReview, shifts: renderShifts, reports: renderReports, people: renderRoster });

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

function buildSessionAdmin(sess) {
  const box = $('session-admin');
  if (!access.admin) { box.hidden = true; return; }
  const live = sess && sess.live, upcoming = (sess && sess.upcoming) || [];
  box.hidden = false;
  box.innerHTML = `
    <div class="sa-actions">
      ${live ? '<button class="ghost danger" id="sa-end">End session</button>'
        : '<button class="refresh" id="sa-start">Start session now</button>'}
      <button class="ghost" id="sa-schedule">Schedule a session</button>
    </div>
    <form class="card sa-form" id="sa-form" hidden>
      <div class="f-row">
        <label class="f sa-when"><span>Date</span><input type="date" id="sa-date"></label>
        <label class="f sa-when"><span>Time (Sydney)</span><input type="time" id="sa-time" step="300"></label>
      </div>
      <label class="f"><span>Note <em>(optional)</em></span><input id="sa-note" maxlength="200" placeholder="e.g. Training night, all departments"></label>
      <p class="error" id="sa-err" hidden></p>
      <div class="f-actions"><button type="button" class="linkish" id="sa-cancel-form">Cancel</button><button class="refresh" type="submit" id="sa-submit">Start session</button></div>
    </form>
    ${upcoming.length ? `<div class="card sa-list">${upcoming.map((u) => `
      <div class="row-item"><div class="case-main"><strong>${esc(whenAhead(u.scheduled_for))}</strong>
        <span class="muted small-meta">${esc([u.host_name && 'with ' + u.host_name, u.note].filter(Boolean).join(' · '))}</span></div>
        ${live ? '' : `<button class="ghost small-btn" data-golive="${u.id}">Start now</button>`}<button class="ghost small-btn" data-cancel="${u.id}">Cancel</button></div>`).join('')}</div>` : ''}`;

  const form = box.querySelector('#sa-form');
  let mode = 'live';
  const open = (m) => {
    mode = m;
    form.hidden = false;
    form.querySelectorAll('.sa-when').forEach((x) => { x.hidden = m === 'live'; });
    box.querySelector('#sa-submit').textContent = m === 'live' ? 'Start session' : 'Schedule';
    if (m === 'scheduled' && !box.querySelector('#sa-date').value) box.querySelector('#sa-date').value = sydneyToday();
    box.querySelector(m === 'live' ? '#sa-note' : '#sa-date').focus();
  };
  box.querySelector('#sa-start')?.addEventListener('click', () => open('live'));
  box.querySelector('#sa-schedule').addEventListener('click', () => open('scheduled'));
  box.querySelector('#sa-cancel-form').addEventListener('click', () => { form.hidden = true; });
  const fail = (msg) => { const e = box.querySelector('#sa-err'); e.textContent = msg; e.hidden = false; };

  form.onsubmit = async (e) => {
    e.preventDefault();
    const note = box.querySelector('#sa-note').value.trim() || null;
    const row = { status: mode, note, host_discord_id: myDiscordId, host_name: $('name').textContent };
    if (mode === 'scheduled') {
      const d = box.querySelector('#sa-date').value, t = box.querySelector('#sa-time').value;
      if (!d || !t) return fail('Pick a date and a time.');
      row.scheduled_for = sydneyToIso(d, t);
      if (new Date(row.scheduled_for) <= new Date()) return fail('That time has already passed.');
    }
    const { error } = await sb.from('sessions').insert(row).select().single();   // started_at + join code filled by the database
    if (error) return fail(error.code === '23505' ? 'A session is already live.' : "Couldn't save: " + error.message);
    loadAndDraw();   // the admin asked for this change, so redraw now
  };
  box.querySelector('#sa-end')?.addEventListener('click', async () => {
    if (!confirm('End the live session? The Discord announcement will change to "Session Ended".')) return;
    const { error } = await sb.from('sessions').update({ status: 'ended', ended_at: new Date().toISOString() }).eq('id', live.id).eq('status', 'live');
    if (error) return fail("Couldn't end it: " + error.message);
    loadAndDraw();
  });
  box.querySelectorAll('[data-golive]').forEach((b) => b.addEventListener('click', async () => {
    const { error } = await sb.from('sessions').update({ status: 'live' }).eq('id', b.dataset.golive).eq('status', 'scheduled');
    if (error) return fail(error.code === '23505' ? 'A session is already live.' : "Couldn't start it: " + error.message);
    loadAndDraw();
  }));
  box.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Cancel this scheduled session?')) return;
    const { error } = await sb.from('sessions').update({ status: 'cancelled' }).eq('id', b.dataset.cancel).eq('status', 'scheduled');
    if (error) return fail("Couldn't cancel it: " + error.message);
    loadAndDraw();
  }));
}

// ---------- session banner ----------
// Under the Welcome card: the Maple Hospital custom server and its join code (pinned; the owner will say if it
// changes). Live / next-session status comes once the sessions back end is ready.
let joinCode = '4920-4087';   // fallback; the live value comes from settings or the session
function buildSessionBanner(sess) {
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
