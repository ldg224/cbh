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
