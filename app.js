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

// Your own member row (the database only returns yours) and your roles, highest first.
async function fetchMine() {
  const { data: me, error } = await sb.from('members').select('display_name, role_ids, is_staff').maybeSingle();
  if (error) throw error;
  if (!me) return { me: null, roles: [] };
  const { data: roles, error: e2 } = await sb.from('roles').select('id, name, color, position').in('id', me.role_ids);
  if (e2) throw e2;
  roles.sort((a, b) => b.position - a.position);
  return { me, roles };
}

// Only what the page shows, so timestamps from the bot's routine resync don't count as a change.
function fingerprint({ me, roles }) {
  if (!me) return 'not-in-server';
  return JSON.stringify([me.display_name, me.is_staff, roles.map((r) => [r.id, r.name, r.color, r.position])]);
}

// ---------- drawing ----------

function draw(data) {
  const list = $('roles');
  list.replaceChildren();
  $('changed').hidden = true;
  pending = null;
  shownSig = fingerprint(data);
  const { me, roles } = data;
  if (!me) {
    $('status-badge').hidden = true;
    $('roles-note').textContent = "We couldn't find you in the CareBeyond - Hospital server. Join it with this Discord account, then refresh.";
    return;
  }
  $('welcome-name').textContent = me.display_name;
  $('name').textContent = me.display_name;
  // Status is shown only by the badge next to the name (never as a sentence like "CareBeyond staff").
  const badge = $('status-badge');
  badge.textContent = me.is_staff ? 'Staff' : 'Member';
  badge.className = me.is_staff ? 'badge' : 'badge badge-member';
  badge.hidden = false;
  for (const r of roles) {
    const li = document.createElement('li');
    li.className = 'role';
    const dot = document.createElement('span');
    dot.className = 'dot';
    if (r.color) dot.style.setProperty('--role', '#' + r.color.toString(16).padStart(6, '0'));
    li.append(dot, document.createTextNode(r.name));
    list.append(li);
  }
  $('roles-note').textContent = roles.length
    ? 'Loaded ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + '. You\'ll see a Refresh button here if anything changes.'
    : 'You have no roles in the server yet.';
}

async function loadAndDraw() {
  $('roles').replaceChildren();
  $('roles-note').textContent = 'Loading your roles…';
  $('status-badge').hidden = true;
  try {
    draw(await fetchMine());
  } catch (err) {
    $('roles-note').textContent = "Couldn't load your roles: " + (err.message || err);
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
