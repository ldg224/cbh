-- 0057: my_todo + assigned courses (Bravo, 18 Nov 2026, for Alpha's course assignments 0056). Apply AFTER 0056.
-- my_todo() as live, plus a merge of course_my_todo() per department: keys courses (overdue, red), courses_note
-- (not yet due, orange), courses_list; red/orange/total include them. Everything else is unchanged.
CREATE OR REPLACE FUNCTION public.my_todo()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  -- Assigned courses (Alpha's course_my_todo(), 0056): the caller's own unfinished assigned courses, per department.
  -- red += overdue ('courses'), orange += not yet due ('courses_note'). A plain member gets just these.
  for d, x in select key, value from jsonb_each(coalesce(public.course_my_todo(), '{}'::jsonb)) loop
    out := out || jsonb_build_object(d, coalesce(out -> d, '{}'::jsonb) || jsonb_build_object(
      'courses', coalesce((x ->> 'courses')::int, 0), 'courses_note', coalesce((x ->> 'courses_note')::int, 0),
      'courses_list', coalesce(x -> 'courses_list', '[]'::jsonb),
      'red', coalesce((out -> d ->> 'red')::int, 0) + coalesce((x ->> 'courses')::int, 0),
      'orange', coalesce((out -> d ->> 'orange')::int, 0) + coalesce((x ->> 'courses_note')::int, 0),
      'total', coalesce((out -> d ->> 'total')::int, 0) + coalesce((x ->> 'courses')::int, 0) + coalesce((x ->> 'courses_note')::int, 0)));
  end loop;
  return out;
end $function$
;
