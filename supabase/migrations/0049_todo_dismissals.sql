-- 0049: clearing To do pings (user via Charlie, 18 Nov 2026; Bravo). "I need to be able to clear them or turn them off."
-- 1. todo_dismissals: "Dealt with" on a quiet member (until they're active again, then it can come back), "Snooze 30
--    days" or "On leave until <date>" (until set), and "Dismiss" on a failed rank change (for everyone). Who and when
--    are recorded. Only people who can see the item can dismiss it (todo_dismiss checks has_perm).
-- 2. A per-person switch, "Show quiet-member notes" (user_prefs.quiet_notes, default on): off hides inactivity pings
--    for that person only.
-- 3. Applications and attendance stay non-dismissable; they clear when the work is done.
-- my_todo() keeps its shape (0046) and respects both. Additive.

create table if not exists public.todo_dismissals (
  department    text not null check (department in ('Administration', 'Community Engagement', 'Nursing', 'Paramedicine')),
  kind          text not null check (kind in ('inactive', 'failed_change')),
  target        text not null,                 -- a member's Discord ID, or a role_changes id
  until         timestamptz,                   -- snooze / on leave; null = until they're active again (inactive) or for good
  last_active   timestamptz,                   -- inactive: their last shift or meeting when it was dealt with
  reason        text check (reason is null or char_length(reason) <= 200),
  dismissed_by  text not null,
  dismissed_by_name text,
  created_at    timestamptz not null default now(),
  primary key (department, kind, target)
);
alter table public.todo_dismissals enable row level security;
drop policy if exists todo_dismissals_read on public.todo_dismissals;
create policy todo_dismissals_read on public.todo_dismissals for select to authenticated using (
  case kind when 'inactive' then public.has_perm('activity.view', department)
            else public.has_perm('history.view', department) or public.has_perm('members.edit', department) end);
revoke all on public.todo_dismissals from anon;
revoke insert, update, delete, truncate on public.todo_dismissals from authenticated;
grant select on public.todo_dismissals to authenticated;

alter table public.user_prefs add column if not exists quiet_notes boolean not null default true;

create or replace function public.get_my_prefs() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce((select jsonb_build_object('pins', p.pins, 'quiet_notes', p.quiet_notes) from public.user_prefs p
                   where p.discord_id = public.my_discord_id()),
                  jsonb_build_object('pins', '{"enabled": true, "count": 4, "items": []}'::jsonb, 'quiet_notes', true))
$$;

create or replace function public.set_my_quiet_notes(show boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me text := public.my_discord_id();
begin
  if me is null or not public.is_member() then raise exception 'Log in first'; end if;
  insert into public.user_prefs (discord_id, quiet_notes, updated_at) values (me, coalesce(show, true), now())
  on conflict (discord_id) do update set quiet_notes = excluded.quiet_notes, updated_at = now();
  return public.get_my_prefs();
end $$;
revoke execute on function public.set_my_quiet_notes(boolean) from public, anon;
grant execute on function public.set_my_quiet_notes(boolean) to authenticated;

-- Dismiss one item. kind 'inactive': target = the member, needs activity.view; until = snooze / leave end (optional).
-- kind 'failed_change': target = the role_changes id, needs history.view or members.edit; always for good.
create or replace function public.todo_dismiss(department text, kind text, target text, until timestamptz default null,
  reason text default null)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare me text := public.my_discord_id(); la timestamptz;
begin
  if kind = 'inactive' then
    if not public.has_perm('activity.view', todo_dismiss.department) then raise exception 'You can''t see % activity', todo_dismiss.department; end if;
    if not exists (select 1 from public.members p join public.roles r on r.id = any (p.role_ids)
                   where p.discord_id = target and r.department = todo_dismiss.department and r.kind in ('department', 'rank')) then
      raise exception 'That person isn''t in %', todo_dismiss.department;
    end if;
    if until is not null and (until <= now() or until > now() + interval '366 days') then raise exception 'Pick a date within the next year'; end if;
    la := greatest((select max(s.started_at) from public.shifts s where s.discord_id = target),
                   (select max(m.scheduled_for) from public.meeting_attendance a join public.meetings m on m.id = a.meeting_id
                    where a.discord_id = target and m.department = todo_dismiss.department and not a.guest and a.status in ('present', 'late')));
  elsif kind = 'failed_change' then
    if not (public.has_perm('history.view', todo_dismiss.department) or public.has_perm('members.edit', todo_dismiss.department)) then
      raise exception 'You can''t see % rank changes', todo_dismiss.department;
    end if;
    if not exists (select 1 from public.role_changes c where c.id::text = target and c.department = todo_dismiss.department and c.status = 'failed') then
      raise exception 'That isn''t a failed % rank change', todo_dismiss.department;
    end if;
    until := null;
  else
    raise exception 'Only quiet members and failed rank changes can be cleared';
  end if;
  insert into public.todo_dismissals (department, kind, target, until, last_active, reason, dismissed_by, dismissed_by_name)
  values (todo_dismiss.department, kind, target, until, la, nullif(trim(coalesce(reason, '')), ''), me,
          (select p.display_name from public.members p where p.discord_id = me))
  on conflict on constraint todo_dismissals_pkey do update set until = excluded.until, last_active = excluded.last_active,
    reason = excluded.reason, dismissed_by = excluded.dismissed_by, dismissed_by_name = excluded.dismissed_by_name, created_at = now();
  return true;
end $$;

create or replace function public.todo_undismiss(department text, kind text, target text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not (case kind when 'inactive' then public.has_perm('activity.view', todo_undismiss.department)
                    else public.has_perm('history.view', todo_undismiss.department) or public.has_perm('members.edit', todo_undismiss.department) end) then
    raise exception 'You can''t change that';
  end if;
  delete from public.todo_dismissals x where x.department = todo_undismiss.department and x.kind = todo_undismiss.kind and x.target = todo_undismiss.target;
  return true;
end $$;
revoke execute on function public.todo_dismiss(text, text, text, timestamptz, text), public.todo_undismiss(text, text, text) from public, anon;
grant execute on function public.todo_dismiss(text, text, text, timestamptz, text), public.todo_undismiss(text, text, text) to authenticated;

create or replace function public.my_todo() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me text := public.my_discord_id(); d text; out jsonb := '{}'::jsonb; x jsonb;
  -- Inactivity thresholds (owner, 18 Nov 2026; adjust here): an orange note from NOTE_DAYS, red from ALERT_DAYS.
  note_days constant int := 14; alert_days constant int := 60;
  n_note int; n_alert int;
  quiet_on boolean := coalesce((select p.quiet_notes from public.user_prefs p where p.discord_id = me), true);
  n_apps int; n_att int; n_inact int; n_fail int; oldest timestamptz; att jsonb; inact jsonb;
begin
  if me is null then return out; end if;
  foreach d in array array['Administration', 'Community Engagement', 'Nursing', 'Paramedicine'] loop
    n_apps := 0; n_att := 0; n_inact := 0; n_fail := 0; n_note := 0; n_alert := 0; oldest := null; att := '[]'; inact := '[]';
    select count(*), min(s.created_at) into n_apps, oldest
      from public.form_submissions s join public.forms f on f.key = s.form_key
      where coalesce(f.department, f.review_team) = d and s.status = 'pending' and public.app_is_reviewer(f.key, me);
    if public.has_perm('meetings.attendance', d) or public.has_perm('meetings.manage', d) then
      select count(*), coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'title', m.title, 'at', m.scheduled_for) order by m.scheduled_for desc), '[]')
        into n_att, att
        from public.meetings m
        where m.department = d and m.status = 'ended' and coalesce(m.ended_at, m.scheduled_for) > now() - interval '14 days'
          and not exists (select 1 from public.meeting_attendance a where a.meeting_id = m.id);
    end if;
    if quiet_on and public.has_perm('activity.view', d) then
      with people as (
        select p.discord_id, p.display_name, p.joined_at from public.members p
        where exists (select 1 from public.roles r where r.id = any (p.role_ids) and r.department = d and r.kind in ('department', 'rank'))
          and p.discord_id <> me
      ), last_seen as (
        select p.*,
          (select max(s.started_at) from public.shifts s where s.discord_id = p.discord_id) last_shift,
          (select max(m.scheduled_for) from public.meeting_attendance a join public.meetings m on m.id = a.meeting_id
            where a.discord_id = p.discord_id and m.department = d and not a.guest and a.status in ('present', 'late')) last_meeting,
          exists (select 1 from public.shifts s where s.discord_id = p.discord_id and s.status <> 'ended') on_now
        from people p
      ), idle as (
        -- Days since they were last active: their last shift or meeting, or when they joined if neither.
        select l.*, extract(day from now() - greatest(l.last_shift, l.last_meeting, coalesce(l.joined_at, '-infinity'::timestamptz)))::int days
        from last_seen l where not l.on_now
      ), flagged as (
        -- Not if someone dealt with it and they haven't been active since (Dealt with), or it's snoozed / they're on
        -- leave until a date that hasn't passed (0049).
        select i.* from idle i where i.days >= note_days and not exists (
          select 1 from public.todo_dismissals x
          where x.department = d and x.kind = 'inactive' and x.target = i.discord_id
            and coalesce(greatest(i.last_shift, i.last_meeting), '-infinity'::timestamptz) <= coalesce(x.last_active, '-infinity'::timestamptz)
            and (x.until is null or x.until > now())))
      select count(*), count(*) filter (where days < alert_days), count(*) filter (where days >= alert_days),
             coalesce((select jsonb_agg(jsonb_build_object('discord_id', f.discord_id, 'name', f.display_name, 'days', f.days, 'last_shift', f.last_shift))
                       from (select * from flagged order by days desc limit 8) f), '[]')
        into n_inact, n_note, n_alert, inact from flagged;
    end if;
    if public.has_perm('history.view', d) or public.has_perm('members.edit', d) then
      select count(*) into n_fail from public.role_changes c where c.department = d and c.status = 'failed' and c.created_at > now() - interval '7 days'
        and not exists (select 1 from public.todo_dismissals x where x.kind = 'failed_change' and x.target = c.id::text);
    end if;
    if public.has_perm('dept.view', d) or n_apps > 0 or n_att > 0 or n_inact > 0 or n_fail > 0 then
      -- red = needs action now; orange = a note (inactivity under ALERT_DAYS)
      x := jsonb_build_object('apps', n_apps, 'apps_oldest', oldest, 'attendance', n_att, 'attendance_list', att,
                              'inactive', n_inact, 'inactive_note', n_note, 'inactive_alert', n_alert, 'inactive_list', inact,
                              'failed', n_fail, 'note_days', note_days, 'alert_days', alert_days,
                              'red', n_apps + n_att + n_fail + n_alert, 'orange', n_note,
                              'total', n_apps + n_att + n_inact + n_fail);
      out := out || jsonb_build_object(d, x);
    end if;
  end loop;
  return out;
end $$;
revoke execute on function public.my_todo() from public, anon;
grant execute on function public.my_todo() to authenticated;
