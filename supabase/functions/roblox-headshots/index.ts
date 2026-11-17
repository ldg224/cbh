// roblox-headshots: fills the roblox_avatars cache (migration 0021) so pages can show Roblox characters.
//
//   POST { ids: ["156", ...] }  (signed-in admin)  ->  200 { avatars: { "156": "https://tr.rbxcdn.com/..." } }
//
// Roblox's thumbnail API can't be called from the browser (no CORS), and its image URLs expire, so this function
// fetches them server-side and caches them. Only Roblox IDs that appear on an in-game mod case are looked up;
// anything cached in the last 7 days is reused. Batches of up to 100, each with a timeout. The caller must be an
// admin (checked with their own token through is_admin()); the service key never leaves this function.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const ALLOWED_ORIGINS = ["https://ldg224.github.io", "http://127.0.0.1:8765", "http://localhost:8765", "http://127.0.0.1:8766"];
const FRESH_MS = 7 * 24 * 3600 * 1000;
const MAX_IDS = 100;

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
    const url = Deno.env.get("SUPABASE_URL")!;
    const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: auth } }, auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: isAdmin, error: aErr } = await asUser.rpc("is_admin");
    if (aErr || isAdmin !== true) return reply(req, { error: "Only Administration and executives can do this." }, 403);

    const body = await req.json().catch(() => ({}));
    const asked = [...new Set((Array.isArray(body?.ids) ? body.ids : []).map((x: unknown) => String(x)).filter((x: string) => /^[0-9]{1,20}$/.test(x)))].slice(0, MAX_IDS) as string[];
    if (!asked.length) return reply(req, { avatars: {} });

    const svc = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } });
    // Only IDs we actually have on in-game cases.
    const { data: known } = await svc.from("mod_cases").select("target_roblox_id").in("target_roblox_id", asked);
    const ids = [...new Set((known ?? []).map((r: { target_roblox_id: string }) => r.target_roblox_id))];
    if (!ids.length) return reply(req, { avatars: {} });

    const { data: cached } = await svc.from("roblox_avatars").select("roblox_id, url, fetched_at").in("roblox_id", ids);
    const out: Record<string, string | null> = {};
    const stale: string[] = [];
    for (const id of ids) {
      const c = (cached ?? []).find((x: { roblox_id: string }) => x.roblox_id === id);
      if (c && Date.now() - new Date(c.fetched_at).getTime() < FRESH_MS) out[id] = c.url;
      else stale.push(id);
    }
    if (stale.length) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      try {
        const r = await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${stale.join(",")}&size=150x150&format=Png&isCircular=false`,
          { headers: { Accept: "application/json" }, signal: ctl.signal });
        if (r.ok) {
          const rows = ((await r.json())?.data ?? []) as { targetId: number; state: string; imageUrl: string | null }[];
          const now = new Date().toISOString();
          const up = stale.map((id) => {
            const hit = rows.find((x) => String(x.targetId) === id);
            const img = hit && hit.state === "Completed" && hit.imageUrl && /^https:\/\/[a-z0-9.-]+\.rbxcdn\.com\//.test(hit.imageUrl) ? hit.imageUrl : null;
            out[id] = img;
            return { roblox_id: id, url: img, fetched_at: now };
          });
          await svc.from("roblox_avatars").upsert(up, { onConflict: "roblox_id" });
        }
      } catch (e) {
        console.error("thumbnails", e);   // Roblox slow or down: return what we have cached
        for (const id of stale) out[id] = (cached ?? []).find((x: { roblox_id: string }) => x.roblox_id === id)?.url ?? null;
      } finally { clearTimeout(timer); }
    }
    return reply(req, { avatars: out });
  } catch (e) {
    console.error(e);
    return reply(req, { error: "Something went wrong. Try again." }, 500);
  }
});
