// login-code: turn a confirmed Discord ID into a Supabase session (used by index.ts's poll; tested on its own).
//
// One person = one account (Alpha, 18 Nov 2026). If the person has ever signed in with Discord (OAuth), the code login
// signs into THAT account, so a phone that used a code and a computer that used Discord are the same user. Only people
// who never used Discord login get the separate code account `discord-<id>@login.carebeyond.invalid`, which carries the
// Discord ID in app_metadata (only the service role can write that; my_discord_id() reads it). Neither address is ever
// emailed: the magic link is verified here, server side, and only the session goes back to the browser that asked.
import { createClient, type SupabaseClient, type User } from "npm:@supabase/supabase-js@2.45.4";

type Member = { display_name: string | null; avatar_url: string | null };

// The person's Discord-login account, if any: the user whose Discord identity has this Discord ID. The member list is
// small (dozens), so a paged scan of auth users is fine; it stops at 20 pages (20,000 accounts) as a safety limit.
export async function findDiscordUser(admin: SupabaseClient, discordId: string): Promise<User | null> {
  let best: User | null = null;
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    // The list doesn't include identities, so shortlist accounts that use Discord login, then confirm each one's
    // Discord identity with getUserById (only the shortlisted ones, usually zero or one).
    for (const u of data.users) {
      const providers = (u.app_metadata?.providers ?? [u.app_metadata?.provider]) as string[];
      if (!providers.includes("discord") || !u.email) continue;
      const hint = u.user_metadata?.provider_id ?? u.user_metadata?.sub;
      if (hint && hint !== discordId) continue;   // metadata names a different Discord account
      const { data: full, error: e2 } = await admin.auth.admin.getUserById(u.id);
      if (e2 || !full?.user) continue;
      const linked = (full.user.identities ?? []).some((i) => i.provider === "discord" && (i.identity_data?.provider_id === discordId || i.identity_data?.sub === discordId || i.id === discordId));
      const banned = (full.user as User & { banned_until?: string | null }).banned_until;
      if (linked && !(banned && new Date(banned) > new Date())) {
        // several (unlikely): the most recently used one
        if (!best || (full.user.last_sign_in_at ?? "") > (best.last_sign_in_at ?? "")) best = full.user;
      }
    }
    if (data.users.length < 1000) break;
  }
  return best;
}

export async function sessionFor(admin: SupabaseClient, discordId: string, member: Member) {
  const meta = { full_name: member.display_name, avatar_url: member.avatar_url };
  let email: string;
  let refreshCodeAccount = false;
  const existing = await findDiscordUser(admin, discordId);
  if (existing?.email) {
    // Sign into their Discord-login account. Its metadata is left alone: Discord keeps it current on their next Discord login.
    email = existing.email;
  } else {
    email = `discord-${discordId}@login.carebeyond.invalid`;
    const created = await admin.auth.admin.createUser({
      email, email_confirm: true, app_metadata: { discord_id: discordId, login: "code" }, user_metadata: meta,
    });
    if (created.error && !/already|registered|exists/i.test(created.error.message)) throw created.error;
    refreshCodeAccount = !created.data?.user;   // it already existed
  }
  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (linkErr) throw linkErr;
  if (refreshCodeAccount) {
    // existing code account: keep its name and photo current
    await admin.auth.admin.updateUserById(link.user.id, { app_metadata: { discord_id: discordId, login: "code" }, user_metadata: meta });
  }
  // A throwaway client: verifying signs it in, and the admin client must keep using the service role.
  const once = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: verified, error: vErr } = await once.auth.verifyOtp({ type: "magiclink", token_hash: link.properties.hashed_token });
  if (vErr || !verified.session) throw vErr ?? new Error("no session");
  const s = verified.session;
  return { access_token: s.access_token, refresh_token: s.refresh_token, user_id: s.user.id };
}
