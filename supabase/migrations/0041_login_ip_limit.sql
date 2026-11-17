-- 0041: per-address limit for "Log in with a code" (Delta's E1, 18 Nov 2026; Bravo). Additive.
-- The login-code Edge Function stores a salted SHA-256 of the caller's address (never the address itself) on each code
-- and allows 5 new codes a minute per address, so one person can no longer block code logins for everyone.
alter table public.login_codes add column if not exists ip_hash text;
create index if not exists login_codes_ip on public.login_codes (ip_hash, created_at desc) where ip_hash is not null;
