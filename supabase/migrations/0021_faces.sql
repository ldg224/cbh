-- 0021: faces for Mod actions and Records (Alpha, approved by Charlie). Additive only.
-- member_faces(ids): current members' Discord photo and name, for admins (members' own rows are otherwise read-own).
-- roblox_avatars: a cache of Roblox headshot image URLs (they expire after ~30 days), filled by the
-- roblox-headshots Edge Function for Roblox IDs that appear on in-game mod cases; admins read it.

create or replace function public.member_faces(ids text[])
returns table (discord_id text, display_name text, avatar_url text)
language sql stable security definer set search_path = '' as $$
  select m.discord_id, m.display_name, m.avatar_url
  from public.members m
  where public.is_admin() and m.discord_id = any (ids[1:200])
$$;
revoke execute on function public.member_faces(text[]) from public, anon;
grant execute on function public.member_faces(text[]) to authenticated;

create table if not exists public.roblox_avatars (
  roblox_id  text primary key check (roblox_id ~ '^[0-9]{1,20}$'),
  url        text check (url is null or url ~ '^https://[a-z0-9.-]+\.rbxcdn\.com/'),
  fetched_at timestamptz not null default now()
);
alter table public.roblox_avatars enable row level security;
drop policy if exists roblox_avatars_read on public.roblox_avatars;
create policy roblox_avatars_read on public.roblox_avatars for select to authenticated using (public.is_admin());
revoke all on public.roblox_avatars from anon;
revoke insert, update, delete, truncate on public.roblox_avatars from authenticated;
grant select on public.roblox_avatars to authenticated;
-- Only the Edge Function (service role) writes it.
