// Public settings. The publishable key is safe to share; access is enforced by row level security.
window.CBH_CONFIG = {
  supabaseUrl: "https://ycrwcwfknqikezynzgyv.supabase.co",
  supabaseKey: "sb_publishable_DckvrwNf5t38g-04vOr4DQ__gytvaQP",
  // The Maple Hospital custom server code shown on the public front page (and the logged-in fallback). Change it here.
  publicJoinCode: "4920-4087",
  // The permanent Discord invite (front page and patient pages).
  discordInvite: "https://discord.gg/xxqTP4shRA",
  // Online check-in and the patient visit page (CBH Chart). false = "Launching soon". Turn on at the Chart launch.
  patientCheckinLive: false,
};
