-- 0045: my_todo() for CareBeyond Desk phase 3 (Bravo, 18 Nov 2026). Additive, read-only.
-- For each department the caller can work in, what's waiting on them, counted only where they have the matching
-- permission (has_perm) so nothing leaks:
--   apps        pending applications for the department's forms that the caller may review (app_is_reviewer)
--   attendance  meetings that ended in the last 14 days with no attendance taken (meetings.attendance / .manage)
--   inactive    members with no shift and no meeting attended (present/late, not as a guest) in 14 days and not on
--               shift now (activity.view), with up to 8 names
--   failed      rank changes that failed in the last 7 days (history.view or members.edit)
-- Courses (ready for promotion, observations to mark) join when Courses is built.
create or replace function public.my_todo() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me text := public.my_discord_id(); d text; out jsonb := '{}'::jsonb; x jsonb;
  n_apps int; n_att int; n_inact int; n_fail int; oldest timestamptz; att jsonb; inact jsonb;
begin
  if me is null then return out; end if;
  foreach d in array array['Administration', 'Community Engagement', 'Nursing', 'Paramedicine'] loop
    n_apps := 0; n_att := 0; n_inact := 0; n_fail := 0; oldest := null; att := '[]'; inact := '[]';
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
        select p.discord_id, p.display_name from public.members p
        where exists (select 1 from public.roles r where r.id = any (p.role_ids) and r.department = d and r.kind in ('department', 'rank'))
          and p.discord_id <> me
      ), idle as (
        select p.*, (select max(s.started_at) from public.shifts s where s.discord_id = p.discord_id and s.department = d) last_shift
        from people p
        where not exists (select 1 from public.shifts s where s.discord_id = p.discord_id and (s.status <> 'ended' or s.started_at > now() - interval '14 days'))
          and not exists (select 1 from public.meeting_attendance a join public.meetings m on m.id = a.meeting_id
                          where a.discord_id = p.discord_id and m.department = d and not a.guest and a.status in ('present', 'late')
                            and m.scheduled_for > now() - interval '14 days')
      )
      select count(*), coalesce((select jsonb_agg(jsonb_build_object('discord_id', i.discord_id, 'name', i.display_name, 'last_shift', i.last_shift))
                                 from (select * from idle order by last_shift nulls first limit 8) i), '[]')
        into n_inact, inact from idle;
    end if;
    if public.has_perm('history.view', d) or public.has_perm('members.edit', d) then
      select count(*) into n_fail from public.role_changes c where c.department = d and c.status = 'failed' and c.created_at > now() - interval '7 days';
    end if;
    if public.has_perm('dept.view', d) or n_apps > 0 or n_att > 0 or n_inact > 0 or n_fail > 0 then
      x := jsonb_build_object('apps', n_apps, 'apps_oldest', oldest, 'attendance', n_att, 'attendance_list', att,
                              'inactive', n_inact, 'inactive_list', inact, 'failed', n_fail,
                              'total', n_apps + n_att + n_inact + n_fail);
      out := out || jsonb_build_object(d, x);
    end if;
  end loop;
  return out;
end $$;
revoke execute on function public.my_todo() from public, anon;
grant execute on function public.my_todo() to authenticated;
