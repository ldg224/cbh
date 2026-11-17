-- 0001: Discord roles and members, synced by the CareBeyond Helper bot.
-- The bot writes with the secret key (bypasses RLS). Logged-in users can only read their own member row,
-- and the role list only if they are in the server.

create table if not exists public.roles (
  id          text primary key,              -- Discord role ID
  name        text not null,
  color       integer not null default 0,    -- 0 = no colour
  position    integer not null default 0,    -- higher = nearer the top of the role list
  managed     boolean not null default false,
  updated_at  timestamptz not null default now()
);

create table if not exists public.members (
  discord_id    text primary key,
  username      text,
  display_name  text,
  avatar_url    text,
  role_ids      text[] not null default '{}',
  is_staff      boolean not null default false,
  joined_at     timestamptz,
  updated_at    timestamptz not null default now()
);

alter table public.roles   enable row level security;
alter table public.members enable row level security;

-- Discord user ID of whoever is logged in (from their Discord login identity).
create or replace function public.my_discord_id()
returns text
language sql stable security definer
set search_path = ''
as $$
  select i.provider_id from auth.identities i
  where i.user_id = auth.uid() and i.provider = 'discord'
  limit 1
$$;
revoke execute on function public.my_discord_id() from public, anon;
grant execute on function public.my_discord_id() to authenticated;

drop policy if exists members_read_own on public.members;
create policy members_read_own on public.members
  for select to authenticated
  using (discord_id = public.my_discord_id());

drop policy if exists roles_read_if_member on public.roles;
create policy roles_read_if_member on public.roles
  for select to authenticated
  using (exists (select 1 from public.members m where m.discord_id = public.my_discord_id()));

-- Only reading for logged-in users; nothing at all for anonymous visitors.
revoke all on public.roles, public.members from anon;
revoke insert, update, delete, truncate on public.roles, public.members from authenticated;
grant select on public.roles, public.members to authenticated;
