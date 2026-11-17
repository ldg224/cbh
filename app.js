// CareBeyond staff dashboard. Discord login through Supabase Auth.
// Staff-only access is enforced in the database (row level security), not here.
const sb = supabase.createClient(CBH_CONFIG.supabaseUrl, CBH_CONFIG.supabaseKey);
const $ = (id) => document.getElementById(id);

function render(session) {
  $('loading').hidden = true;
  const user = session && session.user;
  $('signed-out').hidden = !!user;
  $('signed-in').hidden = !user;
  $('who').hidden = !user;
  if (!user) return;
  const meta = user.user_metadata || {};
  const name = meta.full_name || meta.custom_claims?.global_name || meta.name || 'staff member';
  $('name').textContent = name;
  $('welcome-name').textContent = name;
  if (meta.avatar_url) $('avatar').src = meta.avatar_url; else $('avatar').hidden = true;
  loadRoles();
}

// Your own member row (the database only returns yours) and the server's roles, highest first.
let rolesLoading = false;
async function loadRoles() {
  if (rolesLoading) return;
  rolesLoading = true;
  const list = $('roles');
  list.replaceChildren();
  $('roles-note').textContent = 'Loading your roles…';
  $('staff-line').textContent = '';
  try {
    const { data: me, error } = await sb.from('members').select('display_name, role_ids, is_staff, updated_at').maybeSingle();
    if (error) throw error;
    if (!me) {
      $('roles-note').textContent = "We couldn't find you in the CareBeyond - Hospital server. Join it with this Discord account, then refresh.";
      return;
    }
    $('welcome-name').textContent = me.display_name;
    $('name').textContent = me.display_name;
    $('staff-line').innerHTML = me.is_staff ? 'CareBeyond staff <span class="badge">Staff</span>' : 'CareBeyond member';
    const { data: roles, error: e2 } = await sb.from('roles').select('id, name, color, position').in('id', me.role_ids);
    if (e2) throw e2;
    roles.sort((a, b) => b.position - a.position);
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
      ? 'Updated ' + new Date(me.updated_at).toLocaleString() + '. Role changes in Discord show here within a few seconds.'
      : 'You have no roles in the server yet.';
  } catch (err) {
    $('roles-note').textContent = "Couldn't load your roles: " + (err.message || err);
  } finally {
    rolesLoading = false;
  }
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
  render(null);
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

sb.auth.onAuthStateChange((_event, session) => render(session));
sb.auth.getSession().then(({ data }) => render(data.session));
