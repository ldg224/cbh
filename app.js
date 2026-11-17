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
