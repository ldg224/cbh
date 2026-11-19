// roblox-lookup: the patient check-in's "Is this you?" (Bravo, 19 Nov 2026; CONTRACT v1.2, asked for by Alpha).
//
//   POST { username }  (no login needed)  ->  200 { found: true, id, name, display_name, headshot_url } | 200 { found: false }
//                                         ->  429 { error } when the visitor's limit (20 a minute per IP) is reached
//
// Uses Roblox's public users + thumbnails APIs (no key). Returns ONLY those four public fields, never anything else.
// Deploy with verify_jwt OFF (anyone may call it). Abuse limit: chart_lookup_allowed() in the database counts calls per
// salted IP hash (chart_checkin_attempts, kind 'lookup'); only the service role can run it. CORS is limited to the site.
// The check-in page never depends on this: if it fails, the page just skips the confirm.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const ALLOWED_ORIGINS = ["https://ldg224.github.io", "http://127.0.0.1:8765", "http://localhost:8765"];
const USERNAME = /^(?=.{3,20}$)[A-Za-z0-9]+(_[A-Za-z0-9]+)?$/;   // Roblox: 3-20 letters/digits, one underscore not at either end

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
  return new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors(req) });
  if (req.method !== "POST") return reply(req, { error: "POST only." }, 405);
  const origin = req.headers.get("origin") ?? "";
  if (origin && !ALLOWED_ORIGINS.includes(origin)) return reply(req, { error: "Not allowed." }, 403);
  try {
    const { username } = await req.json().catch(() => ({}));
    const name = String(username ?? "").trim();
    if (!USERNAME.test(name)) return reply(req, { found: false });

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || req.headers.get("cf-connecting-ip") || "unknown";
    const { data: allowed, error: limErr } = await admin.rpc("chart_lookup_allowed", { p_ip: ip });
    if (limErr) console.error(limErr);
    if (allowed === false) return reply(req, { error: "Slow down a little, then try again." }, 429);

    const r = await fetch("https://users.roblox.com/v1/usernames/users", {
      method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ usernames: [name], excludeBannedUsers: true }),
    });
    if (!r.ok) return reply(req, { found: false });
    const hit = (await r.json())?.data?.[0];
    if (!hit) return reply(req, { found: false });

    let headshot: string | null = null;
    try {
      const t = await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${hit.id}&size=150x150&format=Png&isCircular=false`);
      if (t.ok) headshot = (await t.json())?.data?.[0]?.imageUrl ?? null;
    } catch { /* no picture is fine */ }
    return reply(req, { found: true, id: String(hit.id), name: hit.name, display_name: hit.displayName, headshot_url: headshot });
  } catch (e) {
    console.error(e);
    return reply(req, { found: false });
  }
});
