// login-code: "Log in with a code" for the CBH staff dashboard.
//
//   POST { action: "start" }                 -> { code: "K7P-4QX", secret, expires_in: 300 }
//   POST { action: "poll", code, secret }    -> { status: "waiting" | "expired" | "not_member" | "done", session? }
//
// The person types `/login K7P-4QX` in Discord; CareBeyond Helper confirms it and writes their Discord ID onto
// the code (public.login_codes). The browser that started the code (and only it: it alone knows `secret`) then
// gets a Supabase session for that Discord account and calls supabase.auth.setSession(session).
// Called without a signed-in user, so verify_jwt is off; the secret and short expiry protect it instead.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { sessionFor } from "./session.ts";

const ALLOWED_ORIGINS = ["https://ldg224.github.io", "http://127.0.0.1:8765", "http://localhost:8765"];
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L
const CODE_LEN = 6;
const STARTS_PER_MINUTE = 300;      // across everyone; a backstop against flooding the table
const STARTS_PER_IP_MINUTE = 5;     // per address (hashed), so one person can't block code logins for everyone
const COLLECT_WITHIN_MS = 10 * 60_000; // a claimed code's session can only be collected for 10 minutes

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

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
    status,
    headers: { ...cors(req), "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LEN));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

function randomSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(text: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function normalise(code: unknown) {
  return String(code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// "Chrome on Windows" style hint from the User-Agent, shown in Discord so people notice a code that isn't theirs.
function describeBrowser(ua: string) {
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox"
    : /SamsungBrowser/.test(ua) ? "Samsung Internet" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari"
    : "a browser";
  const os = /iPhone|iPad|iPod/.test(ua) ? "iPhone/iPad" : /Android/.test(ua) ? "Android" : /Windows/.test(ua)
    ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "Mac" : /CrOS/.test(ua) ? "Chromebook" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

// The caller's address, keyed and hashed (never stored as-is). cf-connecting-ip is set by Cloudflare in front of
// Supabase and a request that tries to send its own is refused there (checked 18 Nov 2026); sb-forwarded-for (first
// entry, Supabase's own) carries the same address. x-forwarded-for's first entry can be sent by the caller, so it
// isn't used. The key is the function's existing service-role secret, so no salt lives in the code.
async function ipHash(req: Request) {
  const ip = (req.headers.get("cf-connecting-ip") ?? "").trim()
    || (req.headers.get("sb-forwarded-for") ?? "").split(",")[0].trim();
  if (!ip) return null;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("cbh-login:" + ip));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function start(req: Request) {
  const since = new Date(Date.now() - 60_000).toISOString();
  const ip_hash = await ipHash(req);
  if (ip_hash) {
    const { count: mine } = await admin.from("login_codes").select("code", { count: "exact", head: true })
      .eq("ip_hash", ip_hash).gte("created_at", since);
    if ((mine ?? 0) >= STARTS_PER_IP_MINUTE) return reply(req, { error: "Too many codes from here. Wait a minute and try again." }, 429);
  }
  const { count } = await admin.from("login_codes").select("code", { count: "exact", head: true }).gte("created_at", since);
  if ((count ?? 0) >= STARTS_PER_MINUTE) return reply(req, { error: "Too many people are logging in right now. Try again in a minute." }, 429);

  // tidy up codes more than a day old
  await admin.from("login_codes").delete().lt("created_at", new Date(Date.now() - 86_400_000).toISOString());

  const secret = randomSecret();
  const secret_hash = await sha256(secret);
  const client_info = describeBrowser(req.headers.get("user-agent") ?? "");
  for (let i = 0; i < 5; i++) {
    const code = randomCode();
    const { error } = await admin.from("login_codes").insert({ code, secret_hash, client_info, ip_hash });
    if (!error) return reply(req, { code: `${code.slice(0, 3)}-${code.slice(3)}`, secret, expires_in: 300 });
    if (error.code !== "23505") throw error; // anything but a clash with an existing code
  }
  throw new Error("could not make a unique code");
}

async function poll(req: Request, body: Record<string, unknown>) {
  const code = normalise(body.code);
  const secret = String(body.secret ?? "");
  if (code.length !== CODE_LEN || !secret) return reply(req, { error: "Missing code." }, 400);

  const { data: row, error } = await admin.from("login_codes").select("*").eq("code", code).maybeSingle();
  if (error) throw error;
  if (!row || row.secret_hash !== await sha256(secret) || row.used_at) return reply(req, { status: "expired" });
  if (!row.discord_id) {
    return reply(req, { status: new Date(row.expires_at) < new Date() ? "expired" : "waiting" });
  }

  // Claimed, but too long ago to collect now (a code can't be claimed after 5 minutes; collection stops at 10).
  if (Date.now() - new Date(row.created_at).getTime() > COLLECT_WITHIN_MS) return reply(req, { status: "expired" });

  // Claimed: hand the session over exactly once.
  const { data: used } = await admin.from("login_codes").update({ used_at: new Date().toISOString() })
    .eq("code", code).is("used_at", null).select("code");
  if (!used?.length) return reply(req, { status: "expired" });

  const discordId: string = row.discord_id;
  const { data: member } = await admin.from("members").select("display_name, avatar_url").eq("discord_id", discordId).maybeSingle();
  if (!member) return reply(req, { status: "not_member" });

  // session.ts: signs into the person's Discord-login account if they have one, else their code account (18 Nov 2026).
  const { access_token, refresh_token } = await sessionFor(admin, discordId, member);
  return reply(req, { status: "done", session: { access_token, refresh_token } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors(req) });
  if (req.method !== "POST") return reply(req, { error: "POST only." }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    if (body.action === "start") return await start(req);
    if (body.action === "poll") return await poll(req, body);
    return reply(req, { error: "Unknown action." }, 400);
  } catch (e) {
    console.error(e);
    return reply(req, { error: "Something went wrong. Try again." }, 500);
  }
});
