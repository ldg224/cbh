-- 0093 down: old short names and chart_title, no history editing. Snapshot names rewritten by 0093 stay (they are
-- correct names). Voided cases stay voided (status 'void'); amendments stay in chart_log.
delete from public.rank_permissions where perm = 'chart.history_edit';
alter table public.rank_permissions drop constraint if exists rank_permissions_perm_check;
alter table public.rank_permissions add constraint rank_permissions_perm_check check (perm in ('dept.view', 'activity.view', 'members.edit', 'history.view',
  'meetings.manage', 'meetings.attendance', 'applications.review', 'applications.settings', 'courses.manage', 'courses.assess', 'posts.manage'));

create or replace function public.my_perms() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(d.department, d.perms), '{}'::jsonb) from (
    select x.department, to_jsonb(array_agg(distinct x.perm order by x.perm)) as perms from (
      select dd.department, pp.perm
      from (select dx.name from public.departments dx where dx.active) dd(department)
      cross join (values ('dept.view'), ('activity.view'), ('members.edit'), ('history.view'), ('meetings.manage'),
                         ('meetings.attendance'), ('applications.review'), ('applications.settings'), ('courses.manage'),
                         ('courses.assess')) pp(perm)
      where public.has_perm(pp.perm, dd.department)
    ) x group by x.department
  ) d
$$;

create or replace function public.checkin_short_name(full_name text) returns text
language sql immutable set search_path = '' as $$
  select left(split_part(full_name, ' ', 1), 12) || coalesce(' ' || upper(left(nullif(split_part(full_name, ' ', 2), ''), 1)) || '.', '')
$$;

create or replace function public.chart_title(who text) returns text
language sql stable security definer set search_path = '' as $$
  select case (select s.department from public.chart_staff s where s.discord_id = who)
           when 'Medical' then 'Dr.' when 'Surgical' then 'Dr.' when 'Paramedicine' then 'Paramedic' else 'Nurse' end
         || ' ' || split_part(regexp_replace(public.chart_pname(who), '^(Dr\.?|Nurse)\s+', ''), ' ', 1)
$$;

drop function if exists public.chart_history_amend(bigint, text, jsonb, text);
drop function if exists public.chart_history_amend_entry(bigint, text, jsonb, text);
drop function if exists public.chart_history_strike(bigint, text);
drop function if exists public.chart_history_void(bigint, text);
drop function if exists public.chart_history_restore(bigint, text);

create or replace function public.chart_case_access(c public.chart_cases, uid text) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when c.status = 'open' and (coalesce(c.owner_id = uid, false) or coalesce(c.pair_id = uid, false) or uid = any (c.worked_by) or public.chart_is_sup()
         or exists (select 1 from public.chart_requests q where q.case_id = c.id and (q.asked_by = uid or q.accepted_by = uid))) then 'full'
    when c.status = 'open' and exists (select 1 from public.chart_staff s where s.discord_id = uid and s.role = 'reception') then 'desk'
    when c.status <> 'open' and (public.is_exec() or uid = any (c.worked_by) or exists (select 1 from unnest(c.departments) d where public.directs_dept(d))) then 'full'
    when c.status <> 'open' and c.state = 'discharged' and c.discharged_at > now() - interval '2 hours'
         and exists (select 1 from public.chart_staff s where s.discord_id = uid and s.role = 'reception') then 'desk'
    else null end
$$;

create or replace function public.chart_case(p_id bigint) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare uid text := public.my_discord_id(); c public.chart_cases; acc text; me public.chart_staff;
begin
  select * into c from public.chart_cases x where x.id = p_id and x.state is not null;
  if c.id is null then perform public.chart_err('no_access', 'You can''t open that record.'); end if;
  acc := public.chart_case_access(c, uid);
  if acc is null then perform public.chart_err('no_access', 'You can''t open that record.'); end if;
  select * into me from public.chart_staff s where s.discord_id = uid;
  return jsonb_build_object(
    'case', public.chart_case_board(c, true) || jsonb_build_object('patient_name', c.patient_name, 'symptoms', to_jsonb(c.symptoms), 'allergies', c.allergies,
        'nkda', c.nkda, 'past_history', c.past_history, 'last_intake', c.last_intake, 'onset', c.onset, 'diagnosis', c.diagnosis, 'follow_up', c.follow_up,
        'advice', c.advice, 'outcome', c.outcome, 'admitted_to', c.admitted_to, 'discharged_at', c.discharged_at, 'rating', c.rating, 'rating_comment', c.rating_comment,
        'rating_source', c.rating_source, 'papers', c.papers, 'left_note', c.left_note, 'time_of_death', c.time_of_death, 'death_confirmed_by', c.death_confirmed_by,
        'cared_for', coalesce((select jsonb_agg(public.chart_short(x)) from unnest(c.cared_for) x), '[]'), 'previous_case_id', c.previous_case_id,
        'status', c.status, 'opened_at', c.opened_at, 'closed_at', c.closed_at, 'void_reason', c.void_reason),
    'entries', case when acc = 'desk' then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'data', e.data, 'by', e.author,
        'by_name', e.author_name, 'entered_for', e.entered_for, 'entered_for_name', case when e.entered_for is not null then public.chart_short(e.entered_for) end,
        'at', e.at, 'done_at', e.done_at, 'done_by_name', e.done_by_name, 'result', e.result,
        'error', case when e.error_at is not null then jsonb_build_object('reason', e.error_reason, 'by_name', e.error_by_name, 'at', e.error_at) end) order by e.at, e.id)
      from public.chart_entries e where e.case_id = c.id), '[]') end,
    'requests', coalesce((select jsonb_agg(public.chart_req_view(q) order by q.id) from public.chart_requests q where q.case_id = c.id), '[]'),
    'history', coalesce((select jsonb_agg(jsonb_build_object('at', l.at, 'action', l.action, 'actor_name', l.actor_name, 'actor_role', l.actor_role, 'detail', l.detail) order by l.id)
      from public.chart_log l where l.case_id = c.id), '[]'),
    'can', jsonb_build_object(
      'edit', c.status = 'open' and acc = 'full',
      'discharge', c.status = 'open' and (coalesce(c.owner_id = uid, false) or public.chart_is_sup()),
      'request', c.status = 'open' and acc = 'full',
      'hand_back', c.status = 'open' and coalesce(c.owner_id = uid, false),
      'aftercare', c.state = 'discharged' and (coalesce(me.role in ('reception', 'supervisor'), false) or uid = any (c.worked_by))));
end $$;

drop function if exists public.chart_history(bigint, int, text, date, date, text, text, text, boolean);
create or replace function public.chart_history(p_before_id bigint default null, p_limit int default 30, p_search text default null,
  p_from date default null, p_to date default null, p_outcome text default null, p_team text default null, p_person text default null) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(x.j order by x.id desc), '[]') from (
    select c.id, jsonb_build_object('id', c.id, 'patient_name', c.patient_name, 'short_name', public.checkin_short_name(c.patient_name),
             'age', c.age, 'child', c.child, 'esi', c.esi, 'outcome', c.outcome, 'state', c.state,
             'opened_at', c.opened_at, 'closed_at', coalesce(c.discharged_at, c.closed_at), 'discharged_at', coalesce(c.discharged_at, c.closed_at),
             'team', c.team, 'owner_name', public.chart_short(coalesce(c.discharged_by, c.cared_for[cardinality(c.cared_for)])),
             'cared_for_names', coalesce((select jsonb_agg(public.chart_short(w) order by n) from unnest(c.cared_for) with ordinality u(w, n)), '[]'),
             'rating', c.rating, 'rating_source', c.rating_source, 'source', c.source, 'npc', coalesce(c.npc, false)) j
    from public.chart_cases c
    where c.state is not null and c.status <> 'open' and (p_before_id is null or c.id < p_before_id)
      and (nullif(btrim(p_search), '') is null
           or position(lower(btrim(p_search)) in lower(coalesce(c.patient_name, ''))) > 0
           or position(lower(btrim(p_search)) in lower(coalesce(c.roblox_username, ''))) > 0)
      and (p_from is null or (coalesce(c.discharged_at, c.closed_at) at time zone 'America/New_York')::date >= p_from)
      and (p_to is null or (coalesce(c.discharged_at, c.closed_at) at time zone 'America/New_York')::date <= p_to)
      and (nullif(p_outcome, '') is null or c.outcome = p_outcome)
      and (nullif(p_team, '') is null or c.team = p_team)
      and (nullif(p_person, '') is null or p_person = any (c.cared_for))
      and public.chart_case_access(c, public.my_discord_id()) = 'full'
    order by c.id desc limit least(greatest(coalesce(p_limit, 30), 1), 100)) x
$$;

drop function if exists public.chart_hist_case(bigint, text);
drop function if exists public.chart_hist_can_edit(public.chart_cases);
alter table public.chart_entries drop column if exists amended_at, drop column if exists amended_by, drop column if exists amended_by_name, drop column if exists amend_reason;
alter table public.chart_cases drop column if exists voided_at, drop column if exists voided_by;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure::text sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('checkin_short_name', 'chart_title', 'my_perms', 'chart_case_access', 'chart_case', 'chart_history') loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
    if f.proname in ('my_perms', 'chart_case', 'chart_history') then execute format('grant execute on function %s to authenticated', f.sig); end if;
  end loop;
end $$;
