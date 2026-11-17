-- 0003: "Log in with a code". The site asks the login-code Edge Function for a short code, the person types
-- /login CODE in Discord, CareBeyond Helper confirms who they are, and the site's next check gets a session.
-- Only the Edge Function (service role) and the bot (secret key) touch this table; nobody else can see it.

create table if not exists public.login_codes (
  code         text primary key,                        -- 6 characters, stored without the dash, upper case
  secret_hash  text not null,                           -- sha-256 of the secret only the starting browser knows
  client_info  text,                                    -- e.g. "Chrome on Windows", shown in Discord before confirming
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '5 minutes',
  discord_id   text,                                    -- set by the bot when someone confirms /login
  claimed_at   timestamptz,
  used_at      timestamptz                              -- set when the browser has collected its session
);
create index if not exists login_codes_created_at on public.login_codes (created_at);

alter table public.login_codes enable row level security;
revoke all on public.login_codes from anon, authenticated;

-- Who is logged in: their Discord login identity, or (for code logins) the Discord ID the Edge Function stored in
-- app_metadata, which only the service role can write.
create or replace function public.my_discord_id()
returns text
language sql stable security definer
set search_path = ''
as $$
  select coalesce(
    (select i.provider_id from auth.identities i
      where i.user_id = auth.uid() and i.provider = 'discord' limit 1),
    (select u.raw_app_meta_data ->> 'discord_id' from auth.users u where u.id = auth.uid())
  )
$$;
revoke execute on function public.my_discord_id() from public, anon;
grant execute on function public.my_discord_id() to authenticated;
