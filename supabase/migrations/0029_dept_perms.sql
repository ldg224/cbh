-- 0029: The department page uses rank permissions (0027) instead of "Director or exec" (Bravo, 18 Nov 2026).
-- Nothing changes for anyone until a Director edits the permissions: only Directors and execs hold these today.
--   dept.view: the roster (names, ranks), role_changes history, member search for adding
--   activity.view: hours, shifts, last shift, the 4-week chart and the meeting-attendance Inactive input
--   members.edit: year/rank changes, add, remove, but only inside the rank's change window (below)
--   meetings.manage: schedule, edit, move, start, end, cancel; meetings.attendance: attendance, notes, guests
-- Change windows (user, 18 Nov 2026): each rank given members.edit has a range of ranks it may manage, by rank order
-- (e.g. Year 3 = Year 1 to Year 2; a Year 6 = Year 1 to Year 5). Someone's current rank and the rank they're given
-- must both be inside it. Directors and execs have no window. Default when first granted: the lowest rank up to the
-- rank just below the holder's own. Additive (new columns and functions; existing functions keep their signatures).

alter table public.rank_permissions add column if not exists window_lo integer;
alter table public.rank_permissions add column if not exists window_hi integer;
alter table public.rank_permissions drop constraint if exists rank_permissions_window_ok;
alter table public.rank_permissions add constraint rank_permissions_window_ok check (
  (perm = 'members.edit' and window_lo is not null and window_hi is not null and window_lo <= window_hi)
  or (perm <> 'members.edit' and window_lo is null and window_hi is null));

-- The widest window the caller has in a department (across all their ranks there with members.edit), with labels.
create or replace function public.my_members_window(department text)
returns table (lo integer, hi integer, lo_label text, hi_label text)
language sql stable security definer set search_path = '' as $$
  with w as (
    select min(p.window_lo) lo, max(p.window_hi) hi
    from public.my_roles() r join public.rank_permissions p on p.role_id = r.id
    where r.kind = 'rank' and r.department = my_members_window.department and p.perm = 'members.edit'
  )
  select w.lo, w.hi,
    (select x.rank_label from public.roles x where x.kind = 'rank' and x.department = my_members_window.department and x.rank_order = w.lo limit 1),
    (select x.rank_label from public.roles x where x.kind = 'rank' and x.department = my_members_window.department and x.rank_order = w.hi limit 1)
  from w
$$;
revoke execute on function public.my_members_window(text) from public, anon;
grant execute on function public.my_members_window(text) to authenticated;

-- Who may use member search (adding members, adding meeting guests).
create or replace function public.can_search_members() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.directs_any() or exists (
    select 1 from public.my_roles() r join public.rank_permissions p on p.role_id = r.id
    where r.kind = 'rank' and p.perm in ('members.edit', 'meetings.attendance', 'meetings.manage'))
$$;
revoke execute on function public.can_search_members() from public, anon;
grant execute on function public.can_search_members() to authenticated;

-- Turning members.edit on gives the default window; set_rank_window() changes it. (Replaces 0027's set_rank_perm body.)
create or replace function public.set_rank_perm(role_id text, perm text, allow boolean)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare r public.roles; lo integer; hi integer;
begin
  select * into r from public.roles x where x.id = set_rank_perm.role_id;
  if not found or r.kind <> 'rank' or r.department is null then raise exception 'That isn''t a department rank'; end if;
  if r.rank_label = 'Director' then raise exception 'Directors always have every permission'; end if;
  if not public.directs_dept(r.department) then raise exception 'Only the % Director or an executive can change this', r.department; end if;
  if allow then
    if set_rank_perm.perm = 'members.edit' then
      select min(x.rank_order) into lo from public.roles x where x.kind = 'rank' and x.department = r.department and x.rank_label <> 'Director';
      hi := greatest(lo, r.rank_order - 1);
    end if;
    insert into public.rank_permissions (role_id, perm, granted_by, window_lo, window_hi)
    values (set_rank_perm.role_id, set_rank_perm.perm, public.my_discord_id(), lo, hi)
    on conflict do nothing;
  else
    delete from public.rank_permissions p where p.role_id = set_rank_perm.role_id and p.perm = set_rank_perm.perm;
  end if;
  return allow;
end $$;

-- Set a rank's change window by rank order (inclusive). Must sit inside the department's non-Director ranks.
create or replace function public.set_rank_window(role_id text, lo integer, hi integer)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare r public.roles; mn integer; mx integer;
begin
  select * into r from public.roles x where x.id = set_rank_window.role_id;
  if not found or r.kind <> 'rank' or r.department is null then raise exception 'That isn''t a department rank'; end if;
  if not public.directs_dept(r.department) then raise exception 'Only the % Director or an executive can change this', r.department; end if;
  select min(x.rank_order), max(x.rank_order) into mn, mx from public.roles x
    where x.kind = 'rank' and x.department = r.department and x.rank_label <> 'Director';
  if lo is null or hi is null or lo > hi or lo < mn or hi > mx then raise exception 'Pick a range of ranks below Director'; end if;
  update public.rank_permissions p set window_lo = lo, window_hi = hi
  where p.role_id = set_rank_window.role_id and p.perm = 'members.edit';
  if not found then raise exception 'Turn on Change members for this rank first'; end if;
  return true;
end $$;
revoke execute on function public.set_rank_window(text, integer, integer) from public, anon;
grant execute on function public.set_rank_window(text, integer, integer) to authenticated;

-- Read access follows the same permissions.
drop policy if exists role_changes_read on public.role_changes;
create policy role_changes_read on public.role_changes for select to authenticated using (public.has_perm('dept.view', department));
drop policy if exists meeting_attendance_read on public.meeting_attendance;
create policy meeting_attendance_read on public.meeting_attendance for select to authenticated
  using (discord_id = public.my_discord_id()
         or exists (select 1 from public.meetings m where m.id = meeting_id
                    and (public.has_perm('meetings.attendance', m.department) or public.has_perm('meetings.manage', m.department))));

CREATE OR REPLACE FUNCTION public.role_change_check(target text, department text, rank_role_id text, action text)
 RETURNS members
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare me text := public.my_discord_id(); t public.members; rk public.roles; exec_caller boolean := public.is_exec();
  director boolean := public.directs_dept(role_change_check.department); w record; cur integer;
begin
  if not public.has_perm('members.edit', role_change_check.department) then
    raise exception 'You can''t change % members', role_change_check.department;
  end if;
  select * into t from public.members m where m.discord_id = target;
  if not found then raise exception 'That person isn''t in the server'; end if;
  if action <> 'remove' then
    select * into rk from public.roles r where r.id = role_change_check.rank_role_id;
    if not found or rk.kind <> 'rank' or rk.department <> role_change_check.department then
      raise exception 'That isn''t a % rank', role_change_check.department;
    end if;
  end if;
  if not exec_caller then
    if target = me then raise exception 'You can''t change your own rank'; end if;
    if exists (select 1 from public.roles r where r.id = any (t.role_ids)
               and (r.kind in ('leadership', 'executive') or (r.kind = 'rank' and r.rank_label = 'Director'))) then
      raise exception 'Only executives can change a Director or executive';
    end if;
    if action <> 'remove' and rk.rank_label = 'Director' then
      raise exception 'Only executives can make someone a Director';
    end if;
  end if;
  -- Not the Director or an exec: only inside their change window (user, 18 Nov 2026). Both the person's current rank
  -- (if they have one here) and the new rank must sit inside it.
  if not exec_caller and not director then
    select * into w from public.my_members_window(role_change_check.department) x;
    if w.lo is null then raise exception 'You can''t change % members', role_change_check.department; end if;
    select max(r.rank_order) into cur from public.roles r
      where r.id = any (t.role_ids) and r.kind = 'rank' and r.department = role_change_check.department;
    if cur is not null and (cur < w.lo or cur > w.hi) then
      raise exception 'You can only change people from % to %', w.lo_label, w.hi_label;
    end if;
    if action <> 'remove' and (rk.rank_order < w.lo or rk.rank_order > w.hi) then
      raise exception 'You can only give ranks from % to %', w.lo_label, w.hi_label;
    end if;
  end if;
  return t;
end $function$;

CREATE OR REPLACE FUNCTION public.dept_roster(department text)
 RETURNS TABLE(discord_id text, display_name text, avatar_url text, rank_role_id text, rank_label text, rank_order integer, week_hours numeric, shifts_30d bigint, last_shift_at timestamp with time zone, on_shift boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with dept_roles as (
    select r.* from public.roles r where r.department = dept_roster.department and r.kind in ('department', 'rank')
  ), people as (
    select m.* from public.members m
    where public.has_perm('dept.view', dept_roster.department)
      and exists (select 1 from dept_roles d where d.id = any (m.role_ids))
  ), week_start as (
    select (date_trunc('week', now() at time zone 'Australia/Sydney') at time zone 'Australia/Sydney') as t
  )
  select p.discord_id, p.display_name, p.avatar_url,
    rk.id, rk.rank_label, rk.rank_order,
    case when public.has_perm('activity.view', dept_roster.department) then
    coalesce((select round(sum(public.shift_seconds(s)) / 3600.0, 2) from public.shifts s
              where s.discord_id = p.discord_id and s.department = dept_roster.department
                and s.started_at >= (select t from week_start)), 0) end,
    case when public.has_perm('activity.view', dept_roster.department) then
    (select count(*) from public.shifts s where s.discord_id = p.discord_id and s.department = dept_roster.department
       and s.started_at >= now() - interval '30 days') end,
    case when public.has_perm('activity.view', dept_roster.department) then
    (select max(s.started_at) from public.shifts s where s.discord_id = p.discord_id
       and s.department = dept_roster.department) end,
    exists (select 1 from public.shifts s where s.discord_id = p.discord_id and s.status <> 'ended')
  from people p
  left join lateral (
    select d.id, d.rank_label, d.rank_order from dept_roles d
    where d.kind = 'rank' and d.id = any (p.role_ids) order by d.rank_order desc limit 1
  ) rk on true
  order by rk.rank_order desc nulls last, p.display_name
$function$
;

CREATE OR REPLACE FUNCTION public.dept_weekly_hours(department text)
 RETURNS TABLE(discord_id text, weeks numeric[])
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with w as (
    select (date_trunc('week', now() at time zone 'Australia/Sydney') at time zone 'Australia/Sydney') as this_week
  ), slots as (
    select g.i, (select this_week from w) - make_interval(weeks => 4 - g.i) as start_at
    from generate_series(1, 4) g(i)
  ), dept_roles as (
    select r.id from public.roles r where r.department = dept_weekly_hours.department and r.kind in ('department', 'rank')
  ), people as (
    select m.discord_id from public.members m
    where public.has_perm('activity.view', dept_weekly_hours.department)
      and exists (select 1 from dept_roles d where d.id = any (m.role_ids))
  )
  select p.discord_id,
    array(select coalesce((select round(sum(public.shift_seconds(s)) / 3600.0, 2) from public.shifts s
                           where s.discord_id = p.discord_id and s.department = dept_weekly_hours.department
                             and s.started_at >= sl.start_at and s.started_at < sl.start_at + interval '7 days'), 0)
          from slots sl order by sl.i)
  from people p
$function$
;

CREATE OR REPLACE FUNCTION public.dept_last_meeting(department text)
 RETURNS TABLE(discord_id text, last_meeting_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select a.discord_id, max(m.scheduled_for)
  from public.meeting_attendance a join public.meetings m on m.id = a.meeting_id
  where public.has_perm('activity.view', dept_last_meeting.department) and m.department = dept_last_meeting.department
    and a.status in ('present', 'late') and not a.guest
  group by a.discord_id
$function$
;

CREATE OR REPLACE FUNCTION public.member_search(q text)
 RETURNS TABLE(discord_id text, display_name text, avatar_url text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select m.discord_id, m.display_name, m.avatar_url from public.members m
  where public.can_search_members() and char_length(trim(q)) >= 1
    and (m.display_name ilike '%' || trim(q) || '%' or m.username ilike '%' || trim(q) || '%')
  order by m.display_name limit 20
$function$
;

CREATE OR REPLACE FUNCTION public.meeting_save(mid bigint, department text, title text, scheduled_for timestamp with time zone, duration_minutes integer DEFAULT 60, location text DEFAULT NULL::text, agenda text DEFAULT NULL::text, ping boolean DEFAULT true, voice_channel_id text DEFAULT NULL::text)
 RETURNS meetings
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare m public.meetings; me text := public.my_discord_id(); cid text := nullif(trim(coalesce(voice_channel_id, '')), '');
begin
  if not public.has_perm('meetings.manage', meeting_save.department) then raise exception 'You can''t run % meetings', meeting_save.department; end if;
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
end $function$
;

CREATE OR REPLACE FUNCTION public.meeting_set_status(mid bigint, to_status text)
 RETURNS meetings
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare m public.meetings;
begin
  select * into m from public.meetings x where x.id = mid for update;
  if not found then raise exception 'That meeting doesn''t exist'; end if;
  if not public.has_perm('meetings.manage', m.department) then raise exception 'You can''t run % meetings', m.department; end if;
  if not ((m.status = 'scheduled' and to_status in ('live', 'cancelled')) or (m.status = 'live' and to_status = 'ended')) then
    raise exception 'That meeting is % already', m.status;
  end if;
  update public.meetings x set status = to_status,
    started_at = case when to_status = 'live' then now() else x.started_at end,
    ended_at = case when to_status = 'ended' then now() else x.ended_at end,
    post_dirty = true, post_rev = x.post_rev + 1
  where x.id = mid returning * into m;
  return m;
end $function$
;

CREATE OR REPLACE FUNCTION public.meeting_move(mid bigint, scheduled_for timestamp with time zone, voice_channel_id text DEFAULT NULL::text, location text DEFAULT NULL::text)
 RETURNS meetings
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare m public.meetings; cid text := nullif(trim(coalesce(voice_channel_id, '')), ''); loc text := nullif(trim(coalesce(location, '')), '');
begin
  select * into m from public.meetings x where x.id = mid for update;
  if not found then raise exception 'That meeting doesn''t exist'; end if;
  if not public.has_perm('meetings.manage', m.department) then raise exception 'You can''t run % meetings', m.department; end if;
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
end $function$
;

CREATE OR REPLACE FUNCTION public.meeting_mark(mid bigint, marks jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare m public.meetings; me text := public.my_discord_id(); n integer := 0; x jsonb; is_member boolean;
begin
  select * into m from public.meetings y where y.id = mid;
  if not found then raise exception 'That meeting doesn''t exist'; end if;
  if not (public.has_perm('meetings.attendance', m.department) or public.has_perm('meetings.manage', m.department)) then raise exception 'You can''t take % meeting attendance', m.department; end if;
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
end $function$
;

CREATE OR REPLACE FUNCTION public.meeting_notes(mid bigint, notes text)
 RETURNS meetings
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare m public.meetings; me text := public.my_discord_id();
begin
  select * into m from public.meetings y where y.id = mid;
  if not found then raise exception 'That meeting doesn''t exist'; end if;
  if not (public.has_perm('meetings.attendance', m.department) or public.has_perm('meetings.manage', m.department)) then raise exception 'You can''t take % meeting attendance', m.department; end if;
  if char_length(coalesce(notes, '')) > 10000 then raise exception 'Keep the notes under 10,000 characters'; end if;
  update public.meetings y set notes = nullif(trim(meeting_notes.notes), ''), notes_updated_at = now(),
    notes_updated_by_name = (select p.display_name from public.members p where p.discord_id = me)
  where y.id = mid returning * into m;
  return m;
end $function$
;

CREATE OR REPLACE FUNCTION public.meeting_guests(mid bigint)
 RETURNS TABLE(discord_id text, display_name text, avatar_url text, status text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select a.discord_id, p.display_name, p.avatar_url, a.status
  from public.meeting_attendance a join public.meetings m on m.id = a.meeting_id
  left join public.members p on p.discord_id = a.discord_id
  where a.meeting_id = mid and a.guest and (public.has_perm('meetings.attendance', m.department) or public.has_perm('meetings.manage', m.department))
  order by p.display_name
$function$
;
