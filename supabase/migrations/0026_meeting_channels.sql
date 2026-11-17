-- 0026: Meetings: pick a voice channel, and reschedule / move (user via Charlie, 18 Nov 2026; Bravo). Additive.
-- 1. public.discord_channels: the server's voice and stage channels, kept in step by CareBeyond Helper (meetings cog).
--    Readable by staff (is_team()); written only by the bot (service role).
-- 2. meetings.voice_channel_id: where the meeting is. The Discord posts show it as a clickable channel.
-- 3. Reschedule / move: meeting_move() changes the time and/or place of an upcoming meeting and records what it was
--    (moved_at, moved_from_at, moved_from_channel_id) so the post can say "Moved from ...". A new time re-arms the
--    reminder; any change re-syncs the post. meeting_save() gains voice_channel_id (dropped and recreated with the new
--    argument; nothing live calls it yet).

create table if not exists public.discord_channels (
  id          text primary key,
  name        text not null,
  kind        text not null check (kind in ('voice', 'stage')),
  category    text,
  position    integer not null default 0,
  updated_at  timestamptz not null default now()
);
alter table public.discord_channels enable row level security;
drop policy if exists discord_channels_read on public.discord_channels;
create policy discord_channels_read on public.discord_channels for select to authenticated using (public.is_team());
revoke all on public.discord_channels from anon;
revoke insert, update, delete, truncate on public.discord_channels from authenticated;
grant select on public.discord_channels to authenticated;

alter table public.meetings add column if not exists voice_channel_id text;
alter table public.meetings add column if not exists moved_at timestamptz;
alter table public.meetings add column if not exists moved_from_at timestamptz;
alter table public.meetings add column if not exists moved_from_channel_id text;

create or replace function public.meeting_channel_ok(cid text) returns boolean
language sql stable security definer set search_path = '' as $$
  select cid is null or exists (select 1 from public.discord_channels c where c.id = cid)
$$;
revoke execute on function public.meeting_channel_ok(text) from public, anon, authenticated;

drop function if exists public.meeting_save(bigint, text, text, timestamptz, integer, text, text, boolean);
create function public.meeting_save(mid bigint, department text, title text, scheduled_for timestamptz,
  duration_minutes integer default 60, location text default null, agenda text default null, ping boolean default true,
  voice_channel_id text default null)
returns public.meetings
language plpgsql security definer set search_path = '' as $$
declare m public.meetings; me text := public.my_discord_id(); cid text := nullif(trim(coalesce(voice_channel_id, '')), '');
begin
  if not public.directs_dept(meeting_save.department) then raise exception 'You don''t direct %', meeting_save.department; end if;
  if char_length(trim(coalesce(title, ''))) = 0 then raise exception 'Give the meeting a title'; end if;
  if not public.meeting_channel_ok(cid) then raise exception 'That voice channel isn''t in the server any more'; end if;
  if mid is null then
    if scheduled_for < now() - interval '5 minutes' then raise exception 'Pick a time in the future'; end if;
    insert into public.meetings (department, title, scheduled_for, duration_minutes, location, agenda, ping, voice_channel_id,
                                 created_by, created_by_name)
    values (meeting_save.department, trim(title), scheduled_for, coalesce(duration_minutes, 60),
            case when cid is null then nullif(trim(location), '') end, nullif(trim(agenda), ''), coalesce(ping, true), cid,
            me, (select x.display_name from public.members x where x.discord_id = me))
    returning * into m;
  else
    select * into m from public.meetings x where x.id = mid for update;
    if not found then raise exception 'That meeting doesn''t exist'; end if;
    if m.department <> meeting_save.department then raise exception 'A meeting can''t move department'; end if;
    if m.status <> 'scheduled' then raise exception 'Only a meeting that hasn''t started can be changed'; end if;
    update public.meetings x set title = trim(meeting_save.title), duration_minutes = coalesce(meeting_save.duration_minutes, 60),
      location = case when cid is null then nullif(trim(meeting_save.location), '') end, agenda = nullif(trim(meeting_save.agenda), ''),
      ping = coalesce(meeting_save.ping, true),
      moved_from_at = case when x.scheduled_for <> meeting_save.scheduled_for then x.scheduled_for else x.moved_from_at end,
      moved_from_channel_id = case when x.voice_channel_id is distinct from cid then x.voice_channel_id else x.moved_from_channel_id end,
      moved_at = case when x.scheduled_for <> meeting_save.scheduled_for or x.voice_channel_id is distinct from cid then now() else x.moved_at end,
      reminder_sent = case when x.scheduled_for = meeting_save.scheduled_for then x.reminder_sent else false end,
      scheduled_for = meeting_save.scheduled_for, voice_channel_id = cid,
      post_dirty = true, post_rev = x.post_rev + 1
    where x.id = mid returning * into m;
  end if;
  return m;
end $$;

-- Reschedule and/or move an upcoming meeting. Pass the new time and place (unchanged values are fine).
create or replace function public.meeting_move(mid bigint, scheduled_for timestamptz, voice_channel_id text default null,
  location text default null)
returns public.meetings
language plpgsql security definer set search_path = '' as $$
declare m public.meetings; cid text := nullif(trim(coalesce(voice_channel_id, '')), ''); loc text := nullif(trim(coalesce(location, '')), '');
begin
  select * into m from public.meetings x where x.id = mid for update;
  if not found then raise exception 'That meeting doesn''t exist'; end if;
  if not public.directs_dept(m.department) then raise exception 'You don''t direct %', m.department; end if;
  if m.status <> 'scheduled' then raise exception 'Only a meeting that hasn''t started can be moved'; end if;
  if meeting_move.scheduled_for < now() - interval '5 minutes' then raise exception 'Pick a time in the future'; end if;
  if not public.meeting_channel_ok(cid) then raise exception 'That voice channel isn''t in the server any more'; end if;
  if m.scheduled_for = meeting_move.scheduled_for and m.voice_channel_id is not distinct from cid
     and (cid is not null or m.location is not distinct from loc) then
    raise exception 'Nothing changed';
  end if;
  update public.meetings x set
    moved_from_at = case when x.scheduled_for <> meeting_move.scheduled_for then x.scheduled_for else x.moved_from_at end,
    moved_from_channel_id = case when x.voice_channel_id is distinct from cid then x.voice_channel_id else x.moved_from_channel_id end,
    moved_at = now(),
    reminder_sent = case when x.scheduled_for = meeting_move.scheduled_for then x.reminder_sent else false end,
    scheduled_for = meeting_move.scheduled_for, voice_channel_id = cid,
    location = case when cid is null then loc end,
    post_dirty = true, post_rev = x.post_rev + 1
  where x.id = mid returning * into m;
  return m;
end $$;

revoke execute on function public.meeting_save(bigint, text, text, timestamptz, integer, text, text, boolean, text),
  public.meeting_move(bigint, timestamptz, text, text) from public, anon;
grant execute on function public.meeting_save(bigint, text, text, timestamptz, integer, text, text, boolean, text),
  public.meeting_move(bigint, timestamptz, text, text) to authenticated;

-- ---------- Attendance (user via Charlie, 18 Nov 2026) ----------
-- Only Present, Late and Absent (Apologies removed; any existing Apologies become Absent). Late counts as attended.
-- Guests: someone from outside the department can be added to a meeting's attendance (guest = true). A guest's
-- attendance never counts toward their own department's Inactive flag (dept_last_meeting only looks at that
-- department's own meetings).
update public.meeting_attendance set status = 'absent' where status = 'apologies';
alter table public.meeting_attendance drop constraint if exists meeting_attendance_status_check;
alter table public.meeting_attendance add constraint meeting_attendance_status_check check (status in ('present', 'late', 'absent'));
alter table public.meeting_attendance add column if not exists guest boolean not null default false;

-- marks: [{discord_id, status}], status null removes the row (also how a guest is taken off the list).
create or replace function public.meeting_mark(mid bigint, marks jsonb)
returns integer
language plpgsql security definer set search_path = '' as $$
declare m public.meetings; me text := public.my_discord_id(); n integer := 0; x jsonb; is_member boolean;
begin
  select * into m from public.meetings y where y.id = mid;
  if not found then raise exception 'That meeting doesn''t exist'; end if;
  if not public.directs_dept(m.department) then raise exception 'You don''t direct %', m.department; end if;
  if m.status = 'cancelled' then raise exception 'That meeting was cancelled'; end if;
  for x in select * from jsonb_array_elements(coalesce(marks, '[]'::jsonb)) loop
    if (x ->> 'status') is null then
      delete from public.meeting_attendance a where a.meeting_id = mid and a.discord_id = x ->> 'discord_id';
    else
      if (x ->> 'status') not in ('present', 'late', 'absent') then raise exception 'Attendance is Present, Late or Absent'; end if;
      if not exists (select 1 from public.members p where p.discord_id = x ->> 'discord_id') then
        raise exception 'That person isn''t in the server';
      end if;
      is_member := exists (select 1 from public.members p join public.roles r on r.id = any (p.role_ids)
                           where p.discord_id = x ->> 'discord_id' and r.department = m.department and r.kind in ('department', 'rank'));
      insert into public.meeting_attendance (meeting_id, discord_id, status, guest, marked_by, marked_at)
      values (mid, x ->> 'discord_id', x ->> 'status', not is_member, me, now())
      on conflict (meeting_id, discord_id) do update set status = excluded.status, guest = excluded.guest,
        marked_by = excluded.marked_by, marked_at = now();
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

-- Guests' names and photos for the attendance sheet (the department roster doesn't include them).
create or replace function public.meeting_guests(mid bigint)
returns table (discord_id text, display_name text, avatar_url text, status text)
language sql stable security definer set search_path = '' as $$
  select a.discord_id, p.display_name, p.avatar_url, a.status
  from public.meeting_attendance a join public.meetings m on m.id = a.meeting_id
  left join public.members p on p.discord_id = a.discord_id
  where a.meeting_id = mid and a.guest and public.directs_dept(m.department)
  order by p.display_name
$$;

-- Only the department's own members count toward its Inactive flag (guests don't).
create or replace function public.dept_last_meeting(department text)
returns table (discord_id text, last_meeting_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select a.discord_id, max(m.scheduled_for)
  from public.meeting_attendance a join public.meetings m on m.id = a.meeting_id
  where public.directs_dept(dept_last_meeting.department) and m.department = dept_last_meeting.department
    and a.status in ('present', 'late') and not a.guest
  group by a.discord_id
$$;
revoke execute on function public.meeting_guests(bigint) from public, anon;
grant execute on function public.meeting_guests(bigint) to authenticated;
