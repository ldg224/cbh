// roblox-user: checks a Roblox username for the Mod actions form (in-game records must name a real account).
//
//   POST { username }  (signed-in admin)  ->  200 { id, name, displayName }  |  404 { error }  |  403 { error }
//
// Uses Roblox's public users API (no key). The caller must be signed in to the dashboard as an admin: we check that
// with their own token through is_admin(), so verify_jwt is off at the gateway and the check happens here.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const ALLOWED_ORIGINS = ["https://ldg224.github.io", "http://127.0.0.1:8765", "http://localhost:8765"];

function cors(req: Request) {
  const origin = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function reply(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...cors(req), "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors(req) });
  if (req.method !== "POST") return reply(req, { error: "POST only." }, 405);
  try {
    const auth = req.headers.get("authorization") ?? "";
    if (!auth.startsWith("Bearer ")) return reply(req, { error: "Log in first." }, 401);
    const asUser = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: auth } }, auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: isAdmin, error: aErr } = await asUser.rpc("is_admin");
    if (aErr || isAdmin !== true) return reply(req, { error: "Only Administration and executives can do this." }, 403);

    const { username } = await req.json().catch(() => ({}));
    const name = String(username ?? "").trim();
    if (!/^[A-Za-z0-9_]{3,20}$/.test(name)) {
      return reply(req, { error: "Roblox usernames are 3 to 20 letters, numbers or underscores." }, 400);
    }
    const r = await fetch("https://users.roblox.com/v1/usernames/users", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ usernames: [name], excludeBannedUsers: false }),
    });
    if (!r.ok) return reply(req, { error: "Roblox didn't answer. Try again in a moment." }, 502);
    const hit = (await r.json())?.data?.[0];
    if (!hit) return reply(req, { error: `No Roblox account is called "${name}".` }, 404);
    return reply(req, { id: String(hit.id), name: hit.name, displayName: hit.displayName });
  } catch (e) {
    console.error(e);
    return reply(req, { error: "Something went wrong. Try again." }, 500);
  }
});
