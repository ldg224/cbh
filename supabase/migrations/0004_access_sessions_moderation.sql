-- 0004: who can see what (access helpers), sessions + settings (session banner, join code), moderation cases
-- and Discord logs (Admin hub). The bot writes everything with the secret key; the site reads through RLS.

-- ---------- access helpers ----------
-- Audiences, from the role catalogue (cbh/roles.py in the bot):
--   exec  = a leadership role (Hospital Director, COO, Board) or Executive
--   admin = exec, or anyone in the Administration department (division role or any Administration rank)
--   team  = anyone in any department (Administration, Community Engagement, Nursing, Paramedicine) or exec
--   member = in the server

create or replace function public.my_roles()
returns setof public.roles
language sql stable security definer
set search_path = ''
as $$
  select r.* from public.roles r
  join public.members m on r.id = any (m.role_ids)
  where m.discord_id = public.my_discord_id()
$$;

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.members m where m.discord_id = public.my_discord_id())
$$;

create or replace function public.is_exec() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.my_roles() r where r.kind in ('leadership', 'executive'))
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_exec() or exists (
    select 1 from public.my_roles() r where r.kind in ('department', 'rank') and r.department = 'Administration')
$$;

create or replace function public.is_team() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_exec() or exists (select 1 from public.my_roles() r where r.kind in ('department', 'rank'))
$$;

-- One call for the website: what the logged-in person may see, and which teams they belong to / lead.
create or replace function public.my_access()
returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'member', public.is_member(),
    'team',   public.is_team(),
    'admin',  public.is_admin(),
    'exec',   public.is_exec(),
    'teams',  coalesce((select jsonb_agg(distinct r.department) from public.my_roles() r
                         where r.kind in ('department', 'rank')), '[]'::jsonb),
    'leads',  coalesce((select jsonb_agg(distinct r.department) from public.my_roles() r
                         where r.kind = 'rank' and r.rank_label in ('Director', 'Leader', 'Year 5', 'Year 4')), '[]'::jsonb)
  )
$$;

revoke execute on function public.my_roles(), public.is_member(), public.is_exec(), public.is_admin(),
  public.is_team(), public.my_access() from public, anon;
grant execute on function public.my_roles(), public.is_member(), public.is_exec(), public.is_admin(),
  public.is_team(), public.my_access() to authenticated;

-- ---------- settings ----------
create table if not exists public.settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  text                                   -- Discord ID
);
alter table public.settings enable row level security;
drop policy if exists settings_read on public.settings;
create policy settings_read on public.settings for select to authenticated using (public.is_member());
insert into public.settings (key, value) values ('join_code', '"4920-4087"') on conflict (key) do nothing;

-- ---------- sessions ----------
create table if not exists public.sessions (
  id              bigint generated always as identity primary key,
  status          text not null default 'scheduled' check (status in ('scheduled', 'live', 'ended', 'cancelled')),
  note            text,
  host_discord_id text not null,
  host_name       text,
  scheduled_for   timestamptz,                      -- set for scheduled sessions
  started_at      timestamptz,
  ended_at        timestamptz,
  join_code       text,
  message_id      text,                             -- the announcement in #server-starts
  created_at      timestamptz not null default now()
);
create index if not exists sessions_status on public.sessions (status, scheduled_for);
alter table public.sessions enable row level security;
drop policy if exists sessions_read on public.sessions;
create policy sessions_read on public.sessions for select to authenticated using (public.is_member());

-- ---------- moderation cases ----------
create table if not exists public.mod_cases (
  id                    bigint generated always as identity primary key,
  action                text not null check (action in ('warn', 'timeout', 'untimeout', 'kick', 'ban', 'unban', 'note')),
  target_discord_id     text,                       -- null for in-game reports about someone not in Discord
  target_name           text not null,
  moderator_discord_id  text not null,
  moderator_name        text,
  reason                text not null,
  duration_minutes      integer,                    -- timeouts
  source                text not null default 'discord' check (source in ('discord', 'website', 'in_game')),
  created_at            timestamptz not null default now()
);
create index if not exists mod_cases_target on public.mod_cases (target_discord_id, created_at desc);
create index if not exists mod_cases_created on public.mod_cases (created_at desc);
alter table public.mod_cases enable row level security;
drop policy if exists mod_cases_read on public.mod_cases;
create policy mod_cases_read on public.mod_cases for select to authenticated using (public.is_admin());
-- Admins file reports from the website ("I banned X in game"): only as themselves, only as website/in-game reports.
drop policy if exists mod_cases_report on public.mod_cases;
create policy mod_cases_report on public.mod_cases for insert to authenticated
  with check (public.is_admin() and moderator_discord_id = public.my_discord_id() and source in ('website', 'in_game'));

-- ---------- Discord logs ----------
create table if not exists public.discord_logs (
  id              bigint generated always as identity primary key,
  at              timestamptz not null default now(),
  type            text not null,     -- message_delete, message_edit, member_join, member_leave, member_ban,
                                     -- member_unban, roles_change, nickname_change, timeout
  user_discord_id text,
  user_name       text,
  actor_discord_id text,             -- who did it, when known (moderation commands)
  channel_id      text,
  channel_name    text,
  details         jsonb not null default '{}'::jsonb   -- e.g. {"before": "...", "after": "..."} or {"added": [...]}
);
create index if not exists discord_logs_at on public.discord_logs (at desc);
create index if not exists discord_logs_user on public.discord_logs (user_discord_id, at desc);
alter table public.discord_logs enable row level security;
drop policy if exists discord_logs_read on public.discord_logs;
create policy discord_logs_read on public.discord_logs for select to authenticated using (public.is_admin());

revoke all on public.settings, public.sessions, public.mod_cases, public.discord_logs from anon;
revoke insert, update, delete, truncate on public.settings, public.sessions, public.discord_logs from authenticated;
revoke update, delete, truncate on public.mod_cases from authenticated;
grant select on public.settings, public.sessions, public.mod_cases, public.discord_logs to authenticated;
grant insert on public.mod_cases to authenticated;
