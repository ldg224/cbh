-- 0046: To do severity (owner via Charlie, 18 Nov 2026; Bravo). my_todo() now splits inactivity into an orange note
-- (14-59 days without a shift or meeting, counted from when they joined if they've never been active) and a red
-- alert (60+ days), returns 'red' and 'orange' totals for the sidebar badges, and lists the longest-inactive first
-- with their day count. Thresholds are the two constants at the top of the function. Read-only, same permissions.
create or replace function public.my_todo() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me text := public.my_discord_id(); d text; out jsonb := '{}'::jsonb; x jsonb;
  -- Inactivity thresholds (owner, 18 Nov 2026; adjust here): an orange note from NOTE_DAYS, red from ALERT_DAYS.
  note_days constant int := 14; alert_days constant int := 60;
  n_note int; n_alert int;
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
    if public.has_perm('activity.view', d) then
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
      ), flagged as (select * from idle where days >= note_days)
      select count(*), count(*) filter (where days < alert_days), count(*) filter (where days >= alert_days),
             coalesce((select jsonb_agg(jsonb_build_object('discord_id', f.discord_id, 'name', f.display_name, 'days', f.days, 'last_shift', f.last_shift))
                       from (select * from flagged order by days desc limit 8) f), '[]')
        into n_inact, n_note, n_alert, inact from flagged;
    end if;
    if public.has_perm('history.view', d) or public.has_perm('members.edit', d) then
      select count(*) into n_fail from public.role_changes c where c.department = d and c.status = 'failed' and c.created_at > now() - interval '7 days';
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
