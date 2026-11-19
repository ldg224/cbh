-- 0093: Chart names keep titles, and closed records can be corrected (Bravo, 19 Nov 2026; user via Charlie).
-- 1. NAMES: checkin_short_name (behind chart_short, every short_name/owner_name/actor_name) keeps a leading title with the
--    next word: "Dr. Turtle" (was "Dr. T."), "Dr. Turtle Smith" -> "Dr. Turtle S.". Patients keep first name + initial,
--    titles kept too. chart_title strips any of these titles before adding the role's own. Stored snapshots in chart_log /
--    chart_entries / chart_cases that hold exactly the old short form of that person's current name are rewritten.
-- 2. EDIT CHART HISTORY: new department permission chart.history_edit (Directors and owners have it through has_perm).
--    On a CLOSED case of their department a holder can amend a case field or an entry (old value kept in chart_log,
--    "Amended by X: reason"), strike an entry with a reason, or void the case with a reason. Owners can list voided
--    cases and restore them. Nothing is ever deleted. my_perms() now also lists posts.manage (it was missing, so a rank
--    granted "Post department news" never saw it on the website). Additive: new columns, new functions, chart_history gains p_voided.

-- ================= 1. NAMES =================
create or replace function public.checkin_short_name(full_name text) returns text
language sql immutable set search_path = '' as $$
  select case
    when w[1] is null or w[1] = '' then full_name
    when w[1] ~* '^(dr|doctor|prof|professor|nurse|mr|mrs|ms|miss|mx|sir|dame)\.?$' and w[2] is not null then
      w[1] || ' ' || left(w[2], 12) || coalesce(' ' || upper(left(w[3], 1)) || '.', '')
    else left(w[1], 12) || coalesce(' ' || upper(left(w[2], 1)) || '.', '')
  end
  from (select regexp_split_to_array(btrim(full_name), '\s+') w) x
$$;

create or replace function public.chart_title(who text) returns text
language sql stable security definer set search_path = '' as $$
  select case (select s.department from public.chart_staff s where s.discord_id = who)
           when 'Medical' then 'Dr.' when 'Surgical' then 'Dr.' when 'Paramedicine' then 'Paramedic' else 'Nurse' end
         || ' ' || split_part(regexp_replace(btrim(public.chart_pname(who)), '^(dr|doctor|prof|professor|nurse|mr|mrs|ms|miss|mx|sir|dame)\.?\s+', '', 'i'), ' ', 1)
$$;

-- Snapshots written with the old rule: rewrite only where the stored text is exactly the old short form of that person.
create or replace function public.chart_old_short(full_name text) returns text
language sql immutable set search_path = '' as $$
  select left(split_part(full_name, ' ', 1), 12) || coalesce(' ' || upper(left(nullif(split_part(full_name, ' ', 2), ''), 1)) || '.', '')
$$;
update public.chart_log l set actor_name = public.chart_short(l.actor)
  where l.actor is not null and l.actor_name = public.chart_old_short(public.chart_pname(l.actor)) and l.actor_name <> public.chart_short(l.actor);
update public.chart_entries e set author_name = public.chart_short(e.author)
  where e.author is not null and e.author_name = public.chart_old_short(public.chart_pname(e.author)) and e.author_name <> public.chart_short(e.author);
update public.chart_entries e set error_by_name = public.chart_short(e.error_by)
  where e.error_by is not null and e.error_by_name = public.chart_old_short(public.chart_pname(e.error_by)) and e.error_by_name <> public.chart_short(e.error_by);
update public.chart_entries e set done_by_name = public.chart_short(e.done_by)
  where e.done_by is not null and e.done_by_name = public.chart_old_short(public.chart_pname(e.done_by)) and e.done_by_name <> public.chart_short(e.done_by);
update public.chart_cases c set esi_by_name = public.chart_short(c.esi_by)
  where c.esi_by is not null and c.esi_by_name = public.chart_old_short(public.chart_pname(c.esi_by)) and c.esi_by_name <> public.chart_short(c.esi_by);
update public.chart_cases c set diagnosis_by_name = public.chart_short(c.diagnosis_by)
  where c.diagnosis_by is not null and c.diagnosis_by_name = public.chart_old_short(public.chart_pname(c.diagnosis_by)) and c.diagnosis_by_name <> public.chart_short(c.diagnosis_by);
drop function public.chart_old_short(text);

-- ================= 2. EDIT CHART HISTORY =================
alter table public.rank_permissions drop constraint if exists rank_permissions_perm_check;
alter table public.rank_permissions add constraint rank_permissions_perm_check check (perm in ('dept.view', 'activity.view', 'members.edit', 'history.view',
  'meetings.manage', 'meetings.attendance', 'applications.review', 'applications.settings', 'courses.manage', 'courses.assess', 'posts.manage',
  'chart.history_edit'));

create or replace function public.my_perms() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(d.department, d.perms), '{}'::jsonb) from (
    select x.department, to_jsonb(array_agg(distinct x.perm order by x.perm)) as perms from (
      select dd.department, pp.perm
      from (select dx.name from public.departments dx where dx.active) dd(department)
      cross join (values ('dept.view'), ('activity.view'), ('members.edit'), ('history.view'), ('meetings.manage'),
                         ('meetings.attendance'), ('applications.review'), ('applications.settings'), ('courses.manage'),
                         ('courses.assess'), ('posts.manage'), ('chart.history_edit')) pp(perm)
      where public.has_perm(pp.perm, dd.department)
    ) x group by x.department
  ) d
$$;

alter table public.chart_entries add column if not exists amended_at timestamptz;
alter table public.chart_entries add column if not exists amended_by text;
alter table public.chart_entries add column if not exists amended_by_name text;
alter table public.chart_entries add column if not exists amend_reason text;
alter table public.chart_cases add column if not exists voided_at timestamptz;
alter table public.chart_cases add column if not exists voided_by text;

-- May the caller correct this closed record? Owners always; otherwise chart.history_edit in one of the case's departments.
create or replace function public.chart_hist_can_edit(c public.chart_cases) returns boolean
language sql stable security definer set search_path = '' as $$
  select c.state is not null and c.status = 'closed' and public.my_discord_id() is not null and (public.is_exec() or exists (
    select 1 from unnest(coalesce(c.departments, '{}') || coalesce(c.team, '')) d where d <> '' and public.has_perm('chart.history_edit', d)))
$$;

create or replace function public.chart_hist_case(p_case bigint, p_reason text) returns public.chart_cases
language plpgsql security definer set search_path = '' as $$
declare c public.chart_cases;
begin
  perform public.chart_lock();
  select * into c from public.chart_cases x where x.id = p_case and x.state is not null;
  if c.id is null or not public.chart_hist_can_edit(c) then perform public.chart_err('no_access', 'You can''t change that record.'); end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then perform public.chart_err('reason_needed', 'Say why you''re changing it.'); end if;
  return c;
end $$;

-- Amend one field of a closed case. p_value is JSON: a string (or null) for text fields, true/false for nkda, a number for
-- pain, an array of strings for symptoms. Logs action 'amend' with {field, old, new, reason}.
create or replace function public.chart_history_amend(p_case bigint, p_field text, p_value jsonb, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.chart_cases := public.chart_hist_case(p_case, p_reason); old jsonb; nv jsonb; t text;
begin
  t := case when p_field in ('allergies', 'past_history', 'last_intake', 'onset', 'diagnosis', 'care_notes', 'advice', 'follow_up',
                             'outcome', 'admitted_to', 'left_note') then 'text'
            when p_field = 'nkda' then 'bool' when p_field = 'pain' then 'int' when p_field = 'symptoms' then 'list' end;
  if t is null then perform public.chart_err('bad_input', 'That can''t be changed here.'); end if;
  old := to_jsonb(c) -> p_field;
  begin
    if t = 'text' then
      if p_value is not null and jsonb_typeof(p_value) not in ('string', 'null') then raise exception 'type'; end if;
      execute format('update public.chart_cases set %I = $1 where id = $2', p_field) using nullif(btrim(p_value #>> '{}'), ''), c.id;
    elsif t = 'bool' then
      execute format('update public.chart_cases set %I = $1 where id = $2', p_field) using (p_value #>> '{}')::boolean, c.id;
    elsif t = 'int' then
      execute format('update public.chart_cases set %I = $1 where id = $2', p_field) using (p_value #>> '{}')::smallint, c.id;
    else
      if p_value is not null and jsonb_typeof(p_value) <> 'array' then raise exception 'type'; end if;
      execute format('update public.chart_cases set %I = $1 where id = $2', p_field)
        using coalesce((select array_agg(btrim(v)) from jsonb_array_elements_text(coalesce(p_value, '[]')) v where btrim(v) <> ''), '{}'::text[]), c.id;
    end if;
  exception when others then
    perform public.chart_err('bad_input', 'That value doesn''t fit ' || replace(p_field, '_', ' ') || '.');
  end;
  select to_jsonb(x) -> p_field into nv from public.chart_cases x where x.id = c.id;
  if nv is not distinct from old then perform public.chart_err('bad_input', 'Nothing changed.'); end if;
  perform public.chart_act('amend', c.id, jsonb_build_object('field', p_field, 'old', old, 'new', nv, 'reason', left(btrim(p_reason), 200)));
  return jsonb_build_object('ok', true, 'rev', public.chart_bump());
end $$;

-- Amend an entry of a closed case: new data (a JSON object, replaces the old) and/or result. Struck entries can't be.
create or replace function public.chart_history_amend_entry(p_entry bigint, p_reason text, p_data jsonb default null, p_result text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare e public.chart_entries; c public.chart_cases; me text := public.my_discord_id();
begin
  select * into e from public.chart_entries x where x.id = p_entry;
  if e.id is null then perform public.chart_err('no_access', 'You can''t change that record.'); end if;
  c := public.chart_hist_case(e.case_id, p_reason);
  if e.error_at is not null then perform public.chart_err('bad_state', 'That entry is struck.'); end if;
  if p_data is null and p_result is null then perform public.chart_err('bad_input', 'Nothing changed.'); end if;
  if p_data is not null and (jsonb_typeof(p_data) <> 'object' or length(p_data::text) > 4000) then perform public.chart_err('bad_input', 'That entry doesn''t look right.'); end if;
  if coalesce(p_data, e.data) is not distinct from e.data and coalesce(nullif(btrim(p_result), ''), e.result) is not distinct from e.result then
    perform public.chart_err('bad_input', 'Nothing changed.'); end if;
  update public.chart_entries set data = coalesce(p_data, data), result = case when p_result is null then result else left(nullif(btrim(p_result), ''), 300) end,
         amended_at = now(), amended_by = me, amended_by_name = public.chart_short(me), amend_reason = left(btrim(p_reason), 200)
  where id = e.id;
  perform public.chart_act('amend_entry', c.id, jsonb_build_object('entry', e.id, 'old', jsonb_build_object('data', e.data, 'result', e.result),
    'new', (select jsonb_build_object('data', x.data, 'result', x.result) from public.chart_entries x where x.id = e.id), 'reason', left(btrim(p_reason), 200)));
  return jsonb_build_object('ok', true, 'rev', public.chart_bump());
end $$;

-- Strike an entry of a closed case (same marks as chart_entry_error on an open one).
create or replace function public.chart_history_strike(p_entry bigint, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare e public.chart_entries; c public.chart_cases; me text := public.my_discord_id();
begin
  select * into e from public.chart_entries x where x.id = p_entry;
  if e.id is null then perform public.chart_err('no_access', 'You can''t change that record.'); end if;
  c := public.chart_hist_case(e.case_id, p_reason);
  if e.error_at is not null then perform public.chart_err('bad_state', 'Already struck.'); end if;
  update public.chart_entries set error_at = now(), error_by = me, error_by_name = public.chart_short(me), error_reason = left(btrim(p_reason), 200)
  where id = e.id;
  perform public.chart_act('entry_error', c.id, jsonb_build_object('entry', e.id, 'reason', left(btrim(p_reason), 200), 'after_close', true));
  return jsonb_build_object('ok', true, 'rev', public.chart_bump());
end $$;

-- Void a closed case (the "delete"): hidden from Chart History and closed to everyone but owners.
create or replace function public.chart_history_void(p_case bigint, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.chart_cases := public.chart_hist_case(p_case, p_reason);
begin
  update public.chart_cases set status = 'void', void_reason = left(btrim(p_reason), 200), voided_at = now(), voided_by = public.my_discord_id() where id = c.id;
  perform public.chart_act('void', c.id, jsonb_build_object('reason', left(btrim(p_reason), 200)));
  return jsonb_build_object('ok', true, 'rev', public.chart_bump());
end $$;

-- Owners only: bring a voided case back.
create or replace function public.chart_history_restore(p_case bigint, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.chart_cases;
begin
  perform public.chart_lock();
  if not public.is_exec() then perform public.chart_err('no_access', 'Only an owner can restore a record.'); end if;
  select * into c from public.chart_cases x where x.id = p_case and x.state is not null and x.status = 'void' and x.voided_at is not null;
  if c.id is null then perform public.chart_err('bad_state', 'That record isn''t voided.'); end if;
  update public.chart_cases set status = 'closed', void_reason = null, voided_at = null, voided_by = null where id = c.id;
  perform public.chart_act('restore', c.id, jsonb_build_object('reason', left(nullif(btrim(p_reason), ''), 200), 'was', c.void_reason));
  return jsonb_build_object('ok', true, 'rev', public.chart_bump());
end $$;

-- Voided records: owners only.
create or replace function public.chart_case_access(c public.chart_cases, uid text) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when c.status = 'void' then case when public.is_exec() then 'full' end
    when c.status = 'open' and (coalesce(c.owner_id = uid, false) or coalesce(c.pair_id = uid, false) or uid = any (c.worked_by) or public.chart_is_sup()
         or exists (select 1 from public.chart_requests q where q.case_id = c.id and (q.asked_by = uid or q.accepted_by = uid))) then 'full'
    when c.status = 'open' and exists (select 1 from public.chart_staff s where s.discord_id = uid and s.role = 'reception') then 'desk'
    when c.status <> 'open' and (public.is_exec() or uid = any (c.worked_by) or exists (select 1 from unnest(c.departments) d where public.directs_dept(d))) then 'full'
    when c.status <> 'open' and c.state = 'discharged' and c.discharged_at > now() - interval '2 hours'
         and exists (select 1 from public.chart_staff s where s.discord_id = uid and s.role = 'reception') then 'desk'
    else null end
$$;

-- chart_case: entries carry 'amended'; the case carries voided_at; 'can' gains amend / void / restore.
create or replace function public.chart_case(p_id bigint) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare uid text := public.my_discord_id(); c public.chart_cases; acc text; me public.chart_staff; ed boolean;
begin
  select * into c from public.chart_cases x where x.id = p_id and x.state is not null;
  if c.id is null then perform public.chart_err('no_access', 'You can''t open that record.'); end if;
  acc := public.chart_case_access(c, uid);
  if acc is null and public.chart_hist_can_edit(c) then acc := 'full'; end if;     -- history editors read what they may correct
  if acc is null then perform public.chart_err('no_access', 'You can''t open that record.'); end if;
  select * into me from public.chart_staff s where s.discord_id = uid;
  ed := public.chart_hist_can_edit(c);
  return jsonb_build_object(
    'case', public.chart_case_board(c, true) || jsonb_build_object('patient_name', c.patient_name, 'symptoms', to_jsonb(c.symptoms), 'allergies', c.allergies,
        'nkda', c.nkda, 'past_history', c.past_history, 'last_intake', c.last_intake, 'onset', c.onset, 'diagnosis', c.diagnosis, 'follow_up', c.follow_up,
        'advice', c.advice, 'outcome', c.outcome, 'admitted_to', c.admitted_to, 'discharged_at', c.discharged_at, 'rating', c.rating, 'rating_comment', c.rating_comment,
        'rating_source', c.rating_source, 'papers', c.papers, 'left_note', c.left_note, 'time_of_death', c.time_of_death, 'death_confirmed_by', c.death_confirmed_by,
        'cared_for', coalesce((select jsonb_agg(public.chart_short(x)) from unnest(c.cared_for) x), '[]'), 'previous_case_id', c.previous_case_id,
        'status', c.status, 'opened_at', c.opened_at, 'closed_at', c.closed_at, 'void_reason', c.void_reason, 'voided_at', c.voided_at,
        'care_notes', c.care_notes, 'pain', c.pain),
    'entries', case when acc = 'desk' then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'data', e.data, 'by', e.author,
        'by_name', e.author_name, 'entered_for', e.entered_for, 'entered_for_name', case when e.entered_for is not null then public.chart_short(e.entered_for) end,
        'at', e.at, 'done_at', e.done_at, 'done_by_name', e.done_by_name, 'result', e.result,
        'error', case when e.error_at is not null then jsonb_build_object('reason', e.error_reason, 'by_name', e.error_by_name, 'at', e.error_at) end,
        'amended', case when e.amended_at is not null then jsonb_build_object('reason', e.amend_reason, 'by_name', e.amended_by_name, 'at', e.amended_at) end) order by e.at, e.id)
      from public.chart_entries e where e.case_id = c.id), '[]') end,
    'requests', coalesce((select jsonb_agg(public.chart_req_view(q) order by q.id) from public.chart_requests q where q.case_id = c.id), '[]'),
    'history', coalesce((select jsonb_agg(jsonb_build_object('at', l.at, 'action', l.action, 'actor_name', l.actor_name, 'actor_role', l.actor_role, 'detail', l.detail) order by l.id)
      from public.chart_log l where l.case_id = c.id), '[]'),
    'can', jsonb_build_object(
      'edit', c.status = 'open' and acc = 'full',
      'discharge', c.status = 'open' and (coalesce(c.owner_id = uid, false) or public.chart_is_sup()),
      'request', c.status = 'open' and acc = 'full',
      'hand_back', c.status = 'open' and coalesce(c.owner_id = uid, false),
      'aftercare', c.state = 'discharged' and (coalesce(me.role in ('reception', 'supervisor'), false) or uid = any (c.worked_by)),
      'amend', ed, 'void', ed,
      'restore', c.status = 'void' and c.voided_at is not null and public.is_exec()));
end $$;

-- chart_history: p_voided (owners only) also lists voided cases; rows gain voided + void_reason + amended.
drop function if exists public.chart_history(bigint, int, text, date, date, text, text, text);
create or replace function public.chart_history(p_before_id bigint default null, p_limit int default 30, p_search text default null,
  p_from date default null, p_to date default null, p_outcome text default null, p_team text default null, p_person text default null,
  p_voided boolean default false) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(x.j order by x.id desc), '[]') from (
    select c.id, jsonb_build_object('id', c.id, 'patient_name', c.patient_name, 'short_name', public.checkin_short_name(c.patient_name),
             'age', c.age, 'child', c.child, 'esi', c.esi, 'outcome', c.outcome, 'state', c.state,
             'opened_at', c.opened_at, 'closed_at', coalesce(c.discharged_at, c.closed_at), 'discharged_at', coalesce(c.discharged_at, c.closed_at),
             'team', c.team, 'owner_name', public.chart_short(coalesce(c.discharged_by, c.cared_for[cardinality(c.cared_for)])),
             'cared_for_names', coalesce((select jsonb_agg(public.chart_short(w) order by n) from unnest(c.cared_for) with ordinality u(w, n)), '[]'),
             'rating', c.rating, 'rating_source', c.rating_source, 'source', c.source, 'npc', coalesce(c.npc, false),
             'voided', c.status = 'void', 'void_reason', c.void_reason,
             'amended', exists (select 1 from public.chart_log l where l.case_id = c.id and l.action in ('amend', 'amend_entry'))) j
    from public.chart_cases c
    where c.state is not null and c.status <> 'open' and (c.status <> 'void' or (coalesce(p_voided, false) and public.is_exec()))
      and (p_before_id is null or c.id < p_before_id)
      and (nullif(btrim(p_search), '') is null
           or position(lower(btrim(p_search)) in lower(coalesce(c.patient_name, ''))) > 0
           or position(lower(btrim(p_search)) in lower(coalesce(c.roblox_username, ''))) > 0)
      and (p_from is null or (coalesce(c.discharged_at, c.closed_at) at time zone 'America/New_York')::date >= p_from)
      and (p_to is null or (coalesce(c.discharged_at, c.closed_at) at time zone 'America/New_York')::date <= p_to)
      and (nullif(p_outcome, '') is null or c.outcome = p_outcome)
      and (nullif(p_team, '') is null or c.team = p_team)
      and (nullif(p_person, '') is null or p_person = any (c.cared_for))
      and (public.chart_case_access(c, public.my_discord_id()) = 'full' or public.chart_hist_can_edit(c))
    order by c.id desc limit least(greatest(coalesce(p_limit, 30), 1), 100)) x
$$;

-- ---------- grants ----------
do $$
declare f record;
begin
  for f in select p.oid::regprocedure::text sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('checkin_short_name', 'chart_title', 'my_perms', 'chart_hist_can_edit', 'chart_hist_case',
             'chart_history_amend', 'chart_history_amend_entry', 'chart_history_strike', 'chart_history_void', 'chart_history_restore',
             'chart_case_access', 'chart_case', 'chart_history') loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
    if f.proname in ('my_perms', 'chart_history_amend', 'chart_history_amend_entry', 'chart_history_strike', 'chart_history_void',
                     'chart_history_restore', 'chart_case', 'chart_history') then
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end $$;
