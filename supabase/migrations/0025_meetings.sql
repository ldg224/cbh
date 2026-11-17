-- 0025: Department meetings (Department page stage 2; Bravo, 18 Nov 2026). Number pending Charlie's confirmation.
-- A meeting belongs to one department. Its Director (or an executive) schedules, edits, cancels, starts and ends it,
-- marks attendance and writes notes. Department members can read their department's meetings and their own
-- attendance. CareBeyond Helper posts it in the department's own channel (scheduled post kept up to date, a reminder
-- pinging the department role 15 minutes before, "Starting" and "Ended"). Separate from sessions on purpose:
-- no session reader, banner, Session Ping or the one-live-session rule ever sees a meeting. Additive only.

create table if not exists public.meetings (
  id                    bigint generated always as identity primary key,
  department            text not null check (department in ('Administration', 'Community Engagement', 'Nursing', 'Paramedicine')),
  title                 text not null check (char_length(trim(title)) between 1 and 100),
  scheduled_for         timestamptz not null,
  duration_minutes      integer not null default 60 check (duration_minutes between 5 and 600),
  location              text check (location is null or char_length(location) <= 120),
  agenda                text check (agenda is null or char_length(agenda) <= 1500),
  ping                  boolean not null default true,
  status                text not null default 'scheduled' check (status in ('scheduled', 'live', 'ended', 'cancelled')),
  notes                 text check (notes is null or char_length(notes) <= 10000),
  notes_updated_at      timestamptz,
  notes_updated_by_name text,
  created_by            text not null,
  created_by_name       text,
  created_at            timestamptz not null default now(),
  started_at            timestamptz,
  ended_at              timestamptz,
  -- bot bookkeeping (same idea as sessions 0020/0022)
  post_message_id       text,
  post_dirty            boolean not null default true,
  post_rev              integer not null default 0,
  reminder_sent         boolean not null default false,
  live_message_id       text,
  announced_state       text
);
create index if not exists meetings_dept on public.meetings (department, scheduled_for desc);
create index if not exists meetings_dirty on public.meetings (id) where post_dirty;
create index if not exists meetings_due on public.meetings (scheduled_for) where status = 'scheduled' and not reminder_sent;

create table if not exists public.meeting_attendance (
  meeting_id    bigint not null references public.meetings (id) on delete cascade,
  discord_id    text not null,
  status        text not null check (status in ('present', 'late', 'apologies', 'absent')),
  marked_by     text,
  marked_at     timestamptz not null default now(),
  primary key (meeting_id, discord_id)
);
create index if not exists meeting_attendance_person on public.meeting_attendance (discord_id);

-- In a department = holds its division role or any of its ranks.
create or replace function public.in_dept(d text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.my_roles() r where r.department = d and r.kind in ('department', 'rank'))
$$;
revoke execute on function public.in_dept(text) from public, anon;
grant execute on function public.in_dept(text) to authenticated;

alter table public.meetings enable row level security;
alter table public.meeting_attendance enable row level security;
drop policy if exists meetings_read on public.meetings;
create policy meetings_read on public.meetings for select to authenticated
  using (public.directs_dept(department) or public.in_dept(department));
drop policy if exists meeting_attendance_read on public.meeting_attendance;
create policy meeting_attendance_read on public.meeting_attendance for select to authenticated
  using (discord_id = public.my_discord_id()
         or exists (select 1 from public.meetings m where m.id = meeting_id and public.directs_dept(m.department)));
revoke all on public.meetings, public.meeting_attendance from anon;
revoke insert, update, delete, truncate on public.meetings, public.meeting_attendance from authenticated;
grant select on public.meetings, public.meeting_attendance to authenticated;

-- Create or edit a meeting (mid = null creates). Only while it's scheduled. Any change re-syncs the Discord post;
-- a new time re-arms the reminder.
create or replace function public.meeting_save(mid bigint, department text, title text, scheduled_for timestamptz,
  duration_minutes integer default 60, location text default null, agenda text default null, ping boolean default true)
returns public.meetings
language plpgsql security definer set search_path = '' as $$
declare m public.meetings; me text := public.my_discord_id();
begin
  if not public.directs_dept(meeting_save.department) then raise exception 'You don''t direct %', meeting_save.department; end if;
  if char_length(trim(coalesce(title, ''))) = 0 then raise exception 'Give the meeting a title'; end if;
  if mid is null then
    if scheduled_for < now() - interval '5 minutes' then raise exception 'Pick a time in the future'; end if;
    insert into public.meetings (department, title, scheduled_for, duration_minutes, location, agenda, ping, created_by, created_by_name)
    values (meeting_save.department, trim(title), scheduled_for, coalesce(duration_minutes, 60), nullif(trim(location), ''),
            nullif(trim(agenda), ''), coalesce(ping, true), me,
            (select x.display_name from public.members x where x.discord_id = me))
    returning * into m;
  else
    select * into m from public.meetings x where x.id = mid for update;
    if not found then raise exception 'That meeting doesn''t exist'; end if;
    if m.department <> meeting_save.department then raise exception 'A meeting can''t move department'; end if;
    if m.status <> 'scheduled' then raise exception 'Only a meeting that hasn''t started can be changed'; end if;
    update public.meetings x set title = trim(meeting_save.title), duration_minutes = coalesce(meeting_save.duration_minutes, 60),
      location = nullif(trim(meeting_save.location), ''), agenda = nullif(trim(meeting_save.agenda), ''),
      ping = coalesce(meeting_save.ping, true),
      reminder_sent = case when x.scheduled_for = meeting_save.scheduled_for then x.reminder_sent else false end,
      scheduled_for = meeting_save.scheduled_for,
      post_dirty = true, post_rev = x.post_rev + 1
    where x.id = mid returning * into m;
  end if;
  return m;
end $$;

-- Start, end or cancel. Start: scheduled -> live. End: live -> ended. Cancel: scheduled -> cancelled.
create or replace function public.meeting_set_status(mid bigint, to_status text)
returns public.meetings
language plpgsql security definer set search_path = '' as $$
declare m public.meetings;
begin
  select * into m from public.meetings x where x.id = mid for update;
  if not found then raise exception 'That meeting doesn''t exist'; end if;
  if not public.directs_dept(m.department) then raise exception 'You don''t direct %', m.department; end if;
  if not ((m.status = 'scheduled' and to_status in ('live', 'cancelled')) or (m.status = 'live' and to_status = 'ended')) then
    raise exception 'That meeting is % already', m.status;
  end if;
  update public.meetings x set status = to_status,
    started_at = case when to_status = 'live' then now() else x.started_at end,
    ended_at = case when to_status = 'ended' then now() else x.ended_at end,
    post_dirty = true, post_rev = x.post_rev + 1
  where x.id = mid returning * into m;
  return m;
end $$;

-- Attendance: marks is [{discord_id, status}], status null clears. Department members only; any time after creation.
create or replace function public.meeting_mark(mid bigint, marks jsonb)
returns integer
language plpgsql security definer set search_path = '' as $$
declare m public.meetings; me text := public.my_discord_id(); n integer := 0; x jsonb;
begin
  select * into m from public.meetings y where y.id = mid;
  if not found then raise exception 'That meeting doesn''t exist'; end if;
  if not public.directs_dept(m.department) then raise exception 'You don''t direct %', m.department; end if;
  if m.status = 'cancelled' then raise exception 'That meeting was cancelled'; end if;
  for x in select * from jsonb_array_elements(coalesce(marks, '[]'::jsonb)) loop
    if (x ->> 'status') is null then
      delete from public.meeting_attendance a where a.meeting_id = mid and a.discord_id = x ->> 'discord_id';
    else
      if (x ->> 'status') not in ('present', 'late', 'apologies', 'absent') then raise exception 'Unknown attendance %', x ->> 'status'; end if;
      if not exists (select 1 from public.members p join public.roles r on r.id = any (p.role_ids)
                     where p.discord_id = x ->> 'discord_id' and r.department = m.department and r.kind in ('department', 'rank')) then
        raise exception 'That person isn''t in %', m.department;
      end if;
      insert into public.meeting_attendance (meeting_id, discord_id, status, marked_by, marked_at)
      values (mid, x ->> 'discord_id', x ->> 'status', me, now())
      on conflict (meeting_id, discord_id) do update set status = excluded.status, marked_by = excluded.marked_by, marked_at = now();
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function public.meeting_notes(mid bigint, notes text)
returns public.meetings
language plpgsql security definer set search_path = '' as $$
declare m public.meetings; me text := public.my_discord_id();
begin
  select * into m from public.meetings y where y.id = mid;
  if not found then raise exception 'That meeting doesn''t exist'; end if;
  if not public.directs_dept(m.department) then raise exception 'You don''t direct %', m.department; end if;
  if char_length(coalesce(notes, '')) > 10000 then raise exception 'Keep the notes under 10,000 characters'; end if;
  update public.meetings y set notes = nullif(trim(meeting_notes.notes), ''), notes_updated_at = now(),
    notes_updated_by_name = (select p.display_name from public.members p where p.discord_id = me)
  where y.id = mid returning * into m;
  return m;
end $$;

-- Last meeting attended per member of a department (present or late), for the Inactive flag. Director/execs only.
create or replace function public.dept_last_meeting(department text)
returns table (discord_id text, last_meeting_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select a.discord_id, max(m.scheduled_for)
  from public.meeting_attendance a join public.meetings m on m.id = a.meeting_id
  where public.directs_dept(dept_last_meeting.department) and m.department = dept_last_meeting.department
    and a.status in ('present', 'late')
  group by a.discord_id
$$;

revoke execute on function public.meeting_save(bigint, text, text, timestamptz, integer, text, text, boolean),
  public.meeting_set_status(bigint, text), public.meeting_mark(bigint, jsonb), public.meeting_notes(bigint, text),
  public.dept_last_meeting(text) from public, anon;
grant execute on function public.meeting_save(bigint, text, text, timestamptz, integer, text, text, boolean),
  public.meeting_set_status(bigint, text), public.meeting_mark(bigint, jsonb), public.meeting_notes(bigint, text),
  public.dept_last_meeting(text) to authenticated;
