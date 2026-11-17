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
  const { data: me, error } = await sb.from('members').select('display_name, role_ids, is_staff').maybeSingle();
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
function fingerprint({ me, roles, departments }) {
  if (!me) return 'not-in-server';
  const r = (x) => [x.id, x.name, x.color, x.position, x.kind, x.department, x.rank_label, x.rank_order, x.badge_color];
  return JSON.stringify([me.display_name, roles.map(r), departments.map(r)]);
}

// ---------- badges ----------
// Who someone is, at a glance, from their roles (the bot labels every role; see cbh/roles.py in the bot):
//   leadership titles (Hospital Director...) > Executive > each department + its rank (Nursing Department, Year 5)
//   > Verified. Someone with none of these gets a plain "Member" badge.
const hex = (n) => '#' + n.toString(16).padStart(6, '0');

function buildBadges(roles, departments) {
  const out = [];
  for (const r of roles.filter((x) => x.kind === 'leadership')) out.push({ label: r.name, color: r.badge_color });
  if (roles.some((x) => x.kind === 'executive')) {
    const r = roles.find((x) => x.kind === 'executive');
    out.push({ label: 'Executive', color: r.badge_color });
  }
  const deptColour = Object.fromEntries(departments.map((d) => [d.department, d.badge_color]));
  const depts = [...new Set(roles.filter((x) => x.department).map((x) => x.department))];
  // most senior department first (by best rank held)
  const best = (d) => Math.max(0, ...roles.filter((x) => x.kind === 'rank' && x.department === d).map((x) => x.rank_order));
  depts.sort((a, b) => best(b) - best(a));
  for (const d of depts) {
    out.push({ label: d + ' Department', color: deptColour[d] });
    const rank = roles.filter((x) => x.kind === 'rank' && x.department === d).sort((a, b) => b.rank_order - a.rank_order)[0];
    if (rank) out.push({ label: rank.rank_label, color: rank.badge_color, joined: true });
  }
  if (roles.some((x) => x.kind === 'verified')) {
    out.push({ label: 'Verified', color: roles.find((x) => x.kind === 'verified').badge_color, tick: true });
  }
  if (!out.length) out.push({ label: 'Member', color: null });
  return out;
}

function drawBadges(badges) {
  const row = $('badges');
  row.replaceChildren();
  for (const b of badges) {
    const el = document.createElement('span');
    el.className = 'rbadge' + (b.joined ? ' joined' : '');
    if (b.color) el.style.setProperty('--c', hex(b.color));
    if (b.tick) {
      el.insertAdjacentHTML('beforeend',
        '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>');
    }
    el.append(document.createTextNode(b.label));
    row.append(el);
  }
  row.hidden = false;
}

// ---------- drawing ----------

function draw(data) {
  const list = $('roles');
  list.replaceChildren();
  $('changed').hidden = true;
  pending = null;
  shownSig = fingerprint(data);
  const { me, roles, departments } = data;
  if (!me) {
    $('badges').hidden = true;
    note("We couldn't find you in the CareBeyond - Hospital server. Join it with this Discord account, then refresh.");
    return;
  }
  $('welcome-name').textContent = me.display_name;
  $('name').textContent = me.display_name;
  // Who they are is shown only by badges (never as a sentence like "CareBeyond staff").
  drawBadges(buildBadges(roles, departments));
  for (const r of roles) {
    const li = document.createElement('li');
    li.className = 'role';
    const dot = document.createElement('span');
    dot.className = 'dot';
    if (r.color) dot.style.setProperty('--role', '#' + r.color.toString(16).padStart(6, '0'));
    li.append(dot, document.createTextNode(r.name));
    list.append(li);
  }
  // No "how this page works" text: the note only appears for loading, errors and empty states.
  note(roles.length ? '' : 'You have no roles in the server yet.');
}

function note(text) {
  $('roles-note').textContent = text;
  $('roles-note').hidden = !text;
}

async function loadAndDraw() {
  $('roles').replaceChildren();
  note('Loading your roles…');
  $('badges').hidden = true;
  try {
    draw(await fetchMine());
  } catch (err) {
    note("Couldn't load your roles: " + (err.message || err));
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
  $('name').textContent = name;
  $('welcome-name').textContent = name;
  if (meta.avatar_url) $('avatar').src = meta.avatar_url; else $('avatar').hidden = true;
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
