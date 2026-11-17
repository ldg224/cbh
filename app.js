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
  const { data: me, error } = await sb.from('members').select('display_name, avatar_url, role_ids, is_staff').maybeSingle();
  if (error) throw error;
  if (!me) return { me: null, roles: [], departments: [] };
  const ids = me.role_ids.length ? me.role_ids.join(',') : '0';
  const { data: rows, error: e2 } = await sb.from('roles').select(ROLE_FIELDS).or(`id.in.(${ids}),kind.eq.department`);
  if (e2) throw e2;
  const mine = new Set(me.role_ids);
  const roles = rows.filter((r) => mine.has(r.id)).sort((a, b) => b.position - a.position);
  const departments = rows.filter((r) => r.kind === 'department');
  return { me, roles, departments };
}

// Only what the page shows, so timestamps from the bot's routine resync don't count as a change.
// The page shows your name, photo and badges, so only those count (a new ping role, say, changes nothing on screen).
function fingerprint({ me, roles, departments }) {
  if (!me) return 'not-in-server';
  return JSON.stringify([me.display_name, me.avatar_url, buildBadges(roles, departments)]);
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
  setAccess(me, roles);
  buildMenu();
  buildSessionBanner();
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
    { id: 'reports',  title: 'Reports',       icon: 'bar-chart', layout: 'stats' },
    { id: 'strikes',  title: 'Strikes',       icon: 'error',     layout: 'list' },
    { id: 'announce', title: 'Announcements', icon: 'megaphone', layout: 'form' },
    { id: 'settings', title: 'Bot settings',  icon: 'settings',  layout: 'settings' },
  ] },
  { id: 'admin', aud: 'admin', title: 'Admin hub', icon: 'shield', wide: true, tools: [
    { id: 'cases',        title: 'Mod reports',  icon: 'law',     layout: 'list' },
    { id: 'logs',         title: 'Discord logs', icon: 'history', layout: 'log' },
    { id: 'tickets',      title: 'Tickets',      icon: 'inbox',   layout: 'list' },
    { id: 'applications', title: 'Applications', icon: 'resume',  layout: 'list', aud: 'exec' },
  ] },
  { id: 'shifts',   aud: 'staff',    title: 'Shifts',         icon: 'clock',   layout: 'shifts' },
  { id: 'roster',   aud: 'staff',    title: 'Staff & roster', icon: 'people',  layout: 'people' },
  { id: 'rules',    aud: 'everyone', title: 'Rules & info',   icon: 'book',    layout: 'doc' },
  { id: 'contact',  aud: 'everyone', title: 'Contact a team', icon: 'chat',    layout: 'contact' },
  { id: 'apply',    aud: 'everyone', title: 'Apply',          icon: 'resume',  layout: 'form' },
  { id: 'commands', aud: 'everyone', title: 'Commands',       icon: 'console', layout: 'commands' },
];
// Who can see what. Derived from role kinds (cbh/roles.py): exec = leadership or Executive; admin = the
// Administration department, or exec; staff = the bot's is_staff flag.
let access = { exec: false, admin: false, staff: false, everyone: true };
function setAccess(me, roles) {
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
  return a;
}

function buildMenu() {
  const nav = $('menu');
  nav.replaceChildren();
  for (const aud of AUDIENCES) {
    const pages = PAGES.filter((p) => p.aud === aud.id);
    if (!canSee(aud.id) || !pages.length) continue;
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

// Bot commands: a static list for now (Bravo keeps us told about changes; later the bot may sync it to Supabase).
const COMMANDS = [
  { name: '/login', args: 'code', what: 'Log in to this website with the code from "Log in with a code".', who: 'Everyone' },
];
function commandsPage() {
  const el = document.createElement('div');
  el.className = 'card';
  for (const c of COMMANDS) {
    const row = document.createElement('div');
    row.className = 'row-item cmd-row';
    row.innerHTML = '<code class="cmd"></code><div class="cmd-what"></div><span class="cmd-who"></span>';
    row.querySelector('.cmd').textContent = c.args ? `${c.name} ${c.args}` : c.name;
    row.querySelector('.cmd-what').textContent = c.what;
    row.querySelector('.cmd-who').textContent = c.who;
    el.append(row);
  }
  return el.outerHTML;
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
  $('menu').hidden = !!r;
  $('page').hidden = !r;
  if (!r) { document.title = 'CareBeyond Dashboard'; fitBadges(); return; }
  const { page, tool } = r;
  const back = $('page').querySelector('.back');
  back.href = tool ? '#' + page.id : '#';
  back.lastChild.textContent = tool ? page.title : 'Menu';
  const body = $('page-body');
  if (tool) {
    setPageTitle(tool.icon, tool.title, tool.aud || page.aud);
    body.innerHTML = LAYOUTS[tool.layout]();
  } else if (page.tools) {
    setPageTitle(page.icon, page.title, page.aud);
    const grid = document.createElement('div');
    grid.className = 'hub-grid';
    for (const t of page.tools.filter((x) => canSee(x.aud || page.aud))) {
      const a = tileEl(`#${page.id}/${t.id}`, t, t.aud || page.aud, 'tool');
      if (t.aud && t.aud !== page.aud) {
        a.insertAdjacentHTML('beforeend', `<span class="tile-flag">${AUDIENCES.find((x) => x.id === t.aud).label} only</span>`);
      }
      grid.append(a);
    }
    body.replaceChildren(grid);
  } else {
    setPageTitle(page.icon, page.title, page.aud);
    body.innerHTML = LAYOUTS[page.layout]();
  }
  document.title = (tool ? tool.title : page.title) + ' · CareBeyond';
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

// ---------- session banner ----------
// Under the Welcome card: the Maple Hospital custom server and its join code (pinned; the owner will say if it
// changes). Live / next-session status comes once the sessions back end is ready.
const JOIN_CODE = '4920-4087';
function buildSessionBanner() {
  $('join-code').textContent = JOIN_CODE;
}
$('copy-join').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(JOIN_CODE);
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
