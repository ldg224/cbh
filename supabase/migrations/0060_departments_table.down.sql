-- DOWN for 0060 (not applied).
begin;
CREATE OR REPLACE FUNCTION public.dept_id_of(dept text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case dept when 'Administration' then 'administration' when 'Nursing' then 'nursing'
                   when 'Paramedicine' then 'paramedicine' when 'Community Engagement' then 'community' end
$function$;
CREATE OR REPLACE FUNCTION public.shift_start(department text)
 RETURNS shifts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare me text := public.my_discord_id(); s public.shifts;
begin
  if shift_start.department not in ('Administration', 'Community Engagement', 'Nursing', 'Paramedicine') then
    raise exception 'Unknown department %', department;
  end if;
  if me is null or not (public.is_exec() or exists (
        select 1 from public.my_roles() r
        where r.kind in ('department', 'rank') and r.department = shift_start.department)) then
    raise exception 'You''re not in %', department;
  end if;
  if exists (select 1 from public.shifts x where x.discord_id = me and x.status <> 'ended') then
    raise exception 'You''re already on shift';
  end if;
  insert into public.shifts (discord_id, name, department, session_id)
  values (me, (select m.display_name from public.members m where m.discord_id = me), shift_start.department,
          (select x.id from public.sessions x where x.status = 'live' limit 1))
  returning * into s;
  return s;
end $function$;
CREATE OR REPLACE FUNCTION public.app_form_create(dept text, title text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare k text := 'app-' || substr(md5(random()::text || clock_timestamp()::text), 1, 10);
        nm text := (select display_name from public.members where discord_id = public.my_discord_id());
        t text := coalesce(nullif(btrim(title), ''), 'New application');
begin
  if dept not in ('Administration', 'Community Engagement', 'Nursing', 'Paramedicine') then raise exception 'Unknown department.'; end if;
  if not public.app_can_edit(dept) then raise exception 'You can''t create % applications.', dept; end if;
  insert into public.forms (key, title, description, kind, audience, review_team, open, questions, sort, department, stages,
                            accept_rank_role_id, accept_role_ids, cooldown_days, section, draft, draft_saved_at, draft_by_name)
  values (k, left(t, 80), null, 'application', 'member', dept, false, '[]'::jsonb,
          coalesce((select max(sort) from public.forms), 0) + 1, dept, '["In review"]'::jsonb,
          (select id from public.roles where kind = 'rank' and department = dept order by rank_order limit 1), '{}', 14, 'General',
          jsonb_build_object('title', left(t, 80), 'description', null, 'section', 'General', 'audience_ranks', '[]'::jsonb, 'open', false,
                             'questions', '[]'::jsonb, 'stages', '["In review"]'::jsonb,
                             'accept_rank_role_id', (select id from public.roles where kind = 'rank' and department = dept order by rank_order limit 1),
                             'accept_role_ids', '[]'::jsonb, 'cooldown_days', 14),
          now(), nm);
  return k;
end $function$;
CREATE OR REPLACE FUNCTION public.my_access()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'member', public.is_member(),
    'team',   public.is_team(),
    'admin',  public.is_admin(),
    'exec',   public.is_exec(),
    'teams',  coalesce((select jsonb_agg(distinct r.department) from public.my_roles() r
                         where r.kind in ('department', 'rank')), '[]'::jsonb),
    'leads',  coalesce((select jsonb_agg(distinct r.department) from public.my_roles() r
                         where r.kind = 'rank' and r.rank_label in ('Director', 'Leader', 'Year 5', 'Year 4')), '[]'::jsonb),
    'shift_teams', case when public.is_exec()
                        then '["Administration", "Community Engagement", "Nursing", "Paramedicine"]'::jsonb
                        else coalesce((select jsonb_agg(distinct r.department) from public.my_roles() r
                                       where r.kind in ('department', 'rank')), '[]'::jsonb) end,
    'directs', case when public.is_exec()
                    then '["Administration", "Community Engagement", "Nursing", "Paramedicine"]'::jsonb
                    else coalesce((select jsonb_agg(distinct r.department) from public.my_roles() r
                                   where r.kind = 'rank' and r.rank_label = 'Director'), '[]'::jsonb) end,
    'run_sessions', public.can_run_sessions()
  )
$function$;
CREATE OR REPLACE FUNCTION public.my_perms()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_object_agg(d.department, d.perms), '{}'::jsonb) from (
    select x.department, to_jsonb(array_agg(distinct x.perm order by x.perm)) as perms from (
      select dd.department, pp.perm
      from (values ('Administration'), ('Community Engagement'), ('Nursing'), ('Paramedicine')) dd(department)
      cross join (values ('dept.view'), ('activity.view'), ('members.edit'), ('history.view'), ('meetings.manage'),
                         ('meetings.attendance'), ('applications.review'), ('applications.settings'), ('courses.manage'),
                         ('courses.assess')) pp(perm)
      where public.has_perm(pp.perm, dd.department)
    ) x group by x.department
  ) d
$function$;
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
end $function$;
alter table public.tickets drop constraint if exists tickets_team_fk;
alter table public.tickets add constraint tickets_team_check check (team  = any (array['Administration','Community Engagement','Nursing','Paramedicine']));
alter table public.shifts drop constraint if exists shifts_department_fk;
alter table public.shifts add constraint shifts_department_check check (department  = any (array['Administration','Community Engagement','Nursing','Paramedicine']));
alter table public.role_changes drop constraint if exists role_changes_department_fk;
alter table public.role_changes add constraint role_changes_department_check check (department  = any (array['Administration','Community Engagement','Nursing','Paramedicine']));
alter table public.sessions drop constraint if exists sessions_department_fk;
alter table public.sessions add constraint sessions_department_check check (department is null or department = any (array['Administration','Community Engagement','Nursing','Paramedicine']));
alter table public.meetings drop constraint if exists meetings_department_fk;
alter table public.meetings add constraint meetings_department_check check (department  = any (array['Administration','Community Engagement','Nursing','Paramedicine']));
alter table public.forms drop constraint if exists forms_department_fk;
alter table public.forms add constraint forms_department_check check (department is null or department = any (array['Administration','Community Engagement','Nursing','Paramedicine']));
alter table public.todo_dismissals drop constraint if exists todo_dismissals_department_fk;
alter table public.todo_dismissals add constraint todo_dismissals_department_check check (department  = any (array['Administration','Community Engagement','Nursing','Paramedicine']));
alter table public.courses drop constraint if exists courses_department_fk;
alter table public.courses add constraint courses_department_check check (department  = any (array['Administration','Community Engagement','Nursing','Paramedicine']));
drop table if exists public.departments;
commit;
