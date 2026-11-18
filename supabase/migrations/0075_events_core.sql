-- 0075: events, core (Bravo, 18 Nov 2026; owner approved the department frame + window design, events part of the plan).
-- One feed for everything that's "on": sessions and meetings (mirrored here by triggers; they keep their own tables, bot
-- posts, join code, check-in and attendance) plus native kinds that live only here (training, drill, social, ceremony,
-- other). Kinds are data. Additive: nothing existing changes; the bot keeps working as it is.
-- Plan: Plans/CareBeyond/rethink/events-plan.md · contract: rethink/EVENTS-CONTRACT.md

-- ---------- kinds ----------
create table if not exists public.event_kinds (
  kind text primary key,
  label text not null, icon text not null, colour text not null,
  default_minutes int not null default 60,
  create_rule text not null,                 -- see event_can_create (0076)
  rsvp boolean not null default true,
  attendance boolean not null default false,
  join_code boolean not null default false,
  counts_activity boolean not null default false,
  sort int not null default 100,
  active boolean not null default true);
alter table public.event_kinds enable row level security;
drop policy if exists event_kinds_read on public.event_kinds;
create policy event_kinds_read on public.event_kinds for select to authenticated using (true);
insert into public.event_kinds (kind, label, icon, colour, default_minutes, create_rule, rsvp, attendance, join_code, counts_activity, sort) values
  ('session',  'Session',  'controller',     '#3A82D0', 120, 'run_sessions',   true, false, true,  false, 10),
  ('meeting',  'Meeting',  'calendar',       '#6A4FD6',  60, 'dept_meetings',  true, true,  false, true,  20),
  ('training', 'Training', 'graduation-cap', '#0D7D74',  60, 'dept_training',  true, true,  false, true,  30),
  ('drill',    'Drill',    'siren',          '#E8890C',  45, 'dept_drill',     true, true,  false, true,  40),
  ('social',   'Social',   'handshake',      '#FFAA00',  60, 'dept_social',    true, false, false, false, 50),
  ('ceremony', 'Ceremony', 'star',           '#22579F',  60, 'director',       true, true,  false, false, 60),
  ('other',    'Event',    'calendar',       '#55688C',  60, 'director',       true, false, false, false, 70)
on conflict (kind) do nothing;

-- ---------- events ----------
create table if not exists public.events (
  id bigint generated always as identity primary key,
  kind text not null references public.event_kinds (kind),
  title text not null check (char_length(btrim(title)) between 1 and 100),
  description text check (description is null or char_length(description) <= 2000),
  department text references public.departments (name) on update cascade,
  audience text not null default 'department' check (audience in ('hospital', 'department', 'ranks')),
  audience_ranks text[],
  starts_at timestamptz not null,
  ends_at timestamptz,
  duration_minutes int not null default 60 check (duration_minutes between 5 and 720),
  status text not null default 'scheduled' check (status in ('scheduled', 'live', 'ended', 'cancelled')),
  cancel_reason text,
  location_kind text check (location_kind is null or location_kind in ('in_game', 'discord', 'both')),
  location_text text check (location_text is null or char_length(location_text) <= 120),
  voice_channel_id text,
  host_discord_id text, host_name text,
  ping boolean not null default true,
  series_id bigint,
  detached boolean not null default false,
  session_id bigint unique references public.sessions (id) on delete set null,
  meeting_id bigint unique references public.meetings (id) on delete set null,
  -- bot bookkeeping (the meetings pattern); mirrored sessions/meetings are posted by their own cogs, never here
  post_message_id text, post_dirty boolean not null default false, post_rev int not null default 0,
  reminder_sent boolean not null default false, announced_state text, live_message_id text, announce_claimed_at timestamptz,
  created_by text, created_by_name text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint events_department_needed check (audience = 'hospital' or department is not null),
  constraint events_ranks_needed check (audience <> 'ranks' or coalesce(cardinality(audience_ranks), 0) > 0));
create index if not exists events_starts on public.events (starts_at);
create index if not exists events_dept_starts on public.events (department, starts_at);
create index if not exists events_post_dirty on public.events (id) where post_dirty and session_id is null and meeting_id is null;
alter table public.events enable row level security;

create table if not exists public.event_hosts (
  event_id bigint not null references public.events (id) on delete cascade,
  discord_id text not null, name text,
  primary key (event_id, discord_id));
alter table public.event_hosts enable row level security;

create table if not exists public.event_rsvps (
  event_id bigint not null references public.events (id) on delete cascade,
  discord_id text not null,
  response text not null check (response in ('going', 'maybe', 'no')),
  at timestamptz not null default now(),
  primary key (event_id, discord_id));
create index if not exists event_rsvps_who on public.event_rsvps (discord_id);
alter table public.event_rsvps enable row level security;

create table if not exists public.event_attendance (
  event_id bigint not null references public.events (id) on delete cascade,
  discord_id text not null,
  status text not null check (status in ('present', 'late', 'absent')),
  marked_by text, marked_at timestamptz not null default now(),
  guest boolean not null default false,
  primary key (event_id, discord_id));
create index if not exists event_attendance_who on public.event_attendance (discord_id);
alter table public.event_attendance enable row level security;

create table if not exists public.event_log (
  id bigint generated always as identity primary key,
  event_id bigint references public.events (id) on delete set null,
  department text, what text not null,
  by_discord_id text, by_name text, created_at timestamptz not null default now());
alter table public.event_log enable row level security;

-- ---------- who is who, by Discord ID (the bot passes IDs; the website uses my_discord_id()) ----------
create or replace function public.ev_roles(who text) returns setof public.roles
language sql stable security definer set search_path = '' as $$
  select r.* from public.members m join public.roles r on r.id = any (m.role_ids) where m.discord_id = who
$$;
create or replace function public.ev_is_owner(who text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.ev_roles(who) r where public.is_owner_role(r.id))
$$;
create or replace function public.ev_in_dept(who text, d text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.ev_roles(who) r where r.department = d and r.kind in ('department', 'rank'))
$$;
create or replace function public.ev_leads(who text, d text) returns boolean
language sql stable security definer set search_path = '' as $$
  -- Director of d, or a rank of d that may see the department page or run its meetings
  select exists (select 1 from public.ev_roles(who) r where r.kind = 'rank' and r.department = d
                 and (r.rank_label = 'Director' or exists (select 1 from public.rank_permissions p
                      where p.role_id = r.id and p.perm in ('dept.view', 'meetings.manage', 'meetings.attendance'))))
$$;

-- Can this person see this event? Owners and hosts always; hospital-wide: every member; department: its members and
-- leaders; ranks: holders of those ranks plus the department's leaders.
create or replace function public.event_visible_to(p_id bigint, who text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare e public.events;
begin
  if who is null or not exists (select 1 from public.members m where m.discord_id = who) then return false; end if;
  select * into e from public.events x where x.id = p_id;
  if not found then return false; end if;
  if public.ev_is_owner(who) or e.host_discord_id = who
     or exists (select 1 from public.event_hosts h where h.event_id = p_id and h.discord_id = who)
     or exists (select 1 from public.event_attendance a where a.event_id = p_id and a.discord_id = who) then return true; end if;
  if e.audience = 'hospital' then return true; end if;
  if e.audience = 'department' then return public.ev_in_dept(who, e.department) or public.ev_leads(who, e.department); end if;
  return exists (select 1 from public.ev_roles(who) r where r.id = any (e.audience_ranks)) or public.ev_leads(who, e.department);
end $$;

drop policy if exists events_read on public.events;
create policy events_read on public.events for select to authenticated using (public.event_visible_to(id, public.my_discord_id()));
drop policy if exists event_hosts_read on public.event_hosts;
create policy event_hosts_read on public.event_hosts for select to authenticated using (public.event_visible_to(event_id, public.my_discord_id()));
drop policy if exists event_rsvps_read on public.event_rsvps;
create policy event_rsvps_read on public.event_rsvps for select to authenticated using (
  discord_id = public.my_discord_id() or public.is_exec()
  or exists (select 1 from public.events e where e.id = event_id and (e.host_discord_id = public.my_discord_id()
             or (e.department is not null and public.ev_leads(public.my_discord_id(), e.department)))));
drop policy if exists event_attendance_read on public.event_attendance;
create policy event_attendance_read on public.event_attendance for select to authenticated using (
  discord_id = public.my_discord_id() or public.is_exec()
  or exists (select 1 from public.events e where e.id = event_id and (e.host_discord_id = public.my_discord_id()
             or (e.department is not null and public.ev_leads(public.my_discord_id(), e.department)))));
drop policy if exists event_log_read on public.event_log;
create policy event_log_read on public.event_log for select to authenticated using (
  public.is_exec() or (department is not null and public.ev_leads(public.my_discord_id(), department)));

-- ---------- mirror sessions and meetings into events ----------
create or replace function public.ev_upsert_session(new public.sessions) returns void
language plpgsql security definer set search_path = '' as $$
declare st timestamptz := coalesce(new.started_at, new.scheduled_for, new.created_at);
begin
  insert into public.events as e (kind, title, department, audience, starts_at, ends_at, duration_minutes, status, location_kind,
                                  location_text, host_discord_id, host_name, ping, session_id, created_by, created_by_name, created_at)
  values ('session',
          left(coalesce(nullif(btrim(new.note), ''), case new.kind when 'department' then coalesce(new.department, 'Department') || ' session'
               when 'training' then 'Training session' when 'event' then 'Event session' else 'Session' end), 100),
          case when new.kind = 'department' then new.department end,
          case when new.kind = 'department' and new.department is not null then 'department' else 'hospital' end,
          st, coalesce(new.ended_at, st + interval '2 hours'),
          greatest(5, least(720, coalesce(extract(epoch from (new.ended_at - st))::int / 60, 120))),
          new.status, new.location_kind, new.location_text, new.host_discord_id, new.host_name, coalesce(new.ping, true),
          new.id, new.host_discord_id, new.host_name, new.created_at)
  on conflict (session_id) do update set
    title = excluded.title, department = excluded.department, audience = excluded.audience, starts_at = excluded.starts_at,
    ends_at = excluded.ends_at, duration_minutes = excluded.duration_minutes, status = excluded.status,
    location_kind = excluded.location_kind, location_text = excluded.location_text, host_discord_id = excluded.host_discord_id,
    host_name = excluded.host_name, ping = excluded.ping, updated_at = now();
end $$;
create or replace function public.ev_mirror_session() returns trigger
language plpgsql security definer set search_path = '' as $$
begin perform public.ev_upsert_session(new); return null; end $$;
drop trigger if exists ev_mirror on public.sessions;
create trigger ev_mirror after insert or update on public.sessions for each row execute function public.ev_mirror_session();

create or replace function public.ev_upsert_meeting(new public.meetings) returns void
language plpgsql security definer set search_path = '' as $$
declare st timestamptz := coalesce(new.started_at, new.scheduled_for);
begin
  insert into public.events as e (kind, title, description, department, audience, starts_at, ends_at, duration_minutes, status,
                                  location_kind, location_text, voice_channel_id, host_discord_id, host_name, ping, meeting_id,
                                  created_by, created_by_name, created_at)
  values ('meeting', left(new.title, 100), left(new.agenda, 2000), new.department, 'department', st,
          coalesce(new.ended_at, st + make_interval(mins => coalesce(new.duration_minutes, 60))), coalesce(new.duration_minutes, 60),
          new.status, case when new.voice_channel_id is not null then 'discord' end, left(new.location, 120), new.voice_channel_id,
          new.created_by, new.created_by_name, coalesce(new.ping, true), new.id, new.created_by, new.created_by_name, new.created_at)
  on conflict (meeting_id) do update set
    title = excluded.title, description = excluded.description, starts_at = excluded.starts_at, ends_at = excluded.ends_at,
    duration_minutes = excluded.duration_minutes, status = excluded.status, location_kind = excluded.location_kind,
    location_text = excluded.location_text, voice_channel_id = excluded.voice_channel_id, ping = excluded.ping, updated_at = now();
end $$;
create or replace function public.ev_mirror_meeting() returns trigger
language plpgsql security definer set search_path = '' as $$
begin perform public.ev_upsert_meeting(new); return null; end $$;
drop trigger if exists ev_mirror on public.meetings;
create trigger ev_mirror after insert or update on public.meetings for each row execute function public.ev_mirror_meeting();

create or replace function public.ev_mirror_session_hosts() returns trigger
language plpgsql security definer set search_path = '' as $$
declare eid bigint;
begin
  select e.id into eid from public.events e where e.session_id = coalesce(new.session_id, old.session_id);
  if eid is null then return null; end if;
  if tg_op = 'DELETE' then
    delete from public.event_hosts h where h.event_id = eid and h.discord_id = old.discord_id;
  else
    insert into public.event_hosts (event_id, discord_id, name) values (eid, new.discord_id, new.name)
    on conflict (event_id, discord_id) do update set name = excluded.name;
  end if;
  return null;
end $$;
drop trigger if exists ev_mirror on public.session_hosts;
create trigger ev_mirror after insert or update or delete on public.session_hosts for each row execute function public.ev_mirror_session_hosts();

create or replace function public.ev_mirror_meeting_attendance() returns trigger
language plpgsql security definer set search_path = '' as $$
declare eid bigint;
begin
  select e.id into eid from public.events e where e.meeting_id = coalesce(new.meeting_id, old.meeting_id);
  if eid is null then return null; end if;
  if tg_op = 'DELETE' then
    delete from public.event_attendance a where a.event_id = eid and a.discord_id = old.discord_id;
  else
    insert into public.event_attendance (event_id, discord_id, status, marked_by, marked_at, guest)
    values (eid, new.discord_id, new.status, new.marked_by, coalesce(new.marked_at, now()), coalesce(new.guest, false))
    on conflict (event_id, discord_id) do update set status = excluded.status, marked_by = excluded.marked_by,
      marked_at = excluded.marked_at, guest = excluded.guest;
  end if;
  return null;
end $$;
drop trigger if exists ev_mirror on public.meeting_attendance;
create trigger ev_mirror after insert or update or delete on public.meeting_attendance for each row execute function public.ev_mirror_meeting_attendance();

-- ---------- backfill (last 90 days and everything ahead) ----------
-- (reads the legacy rows only; their own triggers don't fire)
select public.ev_upsert_session(s) from public.sessions s where coalesce(s.scheduled_for, s.started_at, s.created_at) > now() - interval '90 days';
select public.ev_upsert_meeting(m) from public.meetings m where m.scheduled_for > now() - interval '90 days';
insert into public.event_hosts (event_id, discord_id, name)
  select e.id, h.discord_id, h.name from public.session_hosts h join public.events e on e.session_id = h.session_id
on conflict do nothing;
insert into public.event_attendance (event_id, discord_id, status, marked_by, marked_at, guest)
  select e.id, a.discord_id, a.status, a.marked_by, coalesce(a.marked_at, now()), coalesce(a.guest, false)
  from public.meeting_attendance a join public.events e on e.meeting_id = a.meeting_id
on conflict do nothing;

revoke execute on function public.ev_roles(text), public.ev_is_owner(text), public.ev_in_dept(text, text), public.ev_leads(text, text),
  public.event_visible_to(bigint, text), public.ev_mirror_session(), public.ev_mirror_meeting(), public.ev_mirror_session_hosts(),
  public.ev_upsert_session(public.sessions), public.ev_upsert_meeting(public.meetings),
  public.ev_mirror_meeting_attendance() from public, anon;
grant execute on function public.ev_roles(text), public.ev_is_owner(text), public.ev_in_dept(text, text), public.ev_leads(text, text),
  public.event_visible_to(bigint, text) to authenticated;
