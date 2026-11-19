-- 0089: CBH Chart operations, reading + patients with no account (Bravo, 19 Nov 2026; BACKEND-PLAN §4.5, §4.7, CONTRACT v1.2).
-- chart_poll (the one live snapshot, shaped by role), chart_case, chart_suggest, chart_history; and the FIVE anon RPCs:
-- chart_public_status, chart_checkin_anon, chart_visit, chart_visit_rate, chart_visit_cancel. These five are the only
-- Chart functions granted to anon. chart_lookup_allowed is for the roblox-lookup Edge Function (service role only).

-- ---------- small view helpers (internal) ----------
create or replace function public.chart_title(who text) returns text
language sql stable security definer set search_path = '' as $$
  select case (select s.department from public.chart_staff s where s.discord_id = who)
           when 'Medical' then 'Dr.' when 'Surgical' then 'Dr.' when 'Paramedicine' then 'Paramedic' else 'Nurse' end
         || ' ' || split_part(regexp_replace(public.chart_pname(who), '^(Dr\.?|Nurse)\s+', ''), ' ', 1)
$$;

create or replace function public.chart_staff_status(who text) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when public.chart_on_break(who) then 'break'
    when exists (select 1 from public.chart_requests q where q.accepted_by = who and q.done_at is null and q.cancelled_at is null and q.here_at is not null) then 'at_request'
    when exists (select 1 from public.chart_requests q where q.accepted_by = who and q.done_at is null and q.cancelled_at is null) then 'on_request'
    when exists (select 1 from public.chart_cases c where c.status = 'open' and c.owner_id = who and c.state = 'assigned') then 'assigned'
    when exists (select 1 from public.chart_cases c where c.status = 'open' and c.owner_id = who and c.state = 'called') then 'fetching'
    when exists (select 1 from public.chart_cases c where c.status = 'open' and c.owner_id = who and c.state = 'in_care') then 'with_patient'
    when (select s.ready from public.chart_staff s where s.discord_id = who) then 'ready'
    else 'not_ready' end
$$;

create or replace function public.chart_tags(p_case bigint) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'doctor', (select case when q.done_at is not null then 'done' when q.here_at is not null then 'here' when q.accepted_at is not null then 'accepted' else 'requested' end
               from public.chart_requests q where q.case_id = p_case and q.kind = 'doctor' and q.cancelled_at is null order by q.id desc limit 1),
    'surgery', (select case when q.done_at is not null then 'done' when q.here_at is not null then 'here' when q.accepted_at is not null then 'accepted' else 'requested' end
               from public.chart_requests q where q.case_id = p_case and q.kind = 'surgery' and q.cancelled_at is null order by q.id desc limit 1),
    'imaging', (select case when q.done_at is not null then 'done' when q.here_at is not null then 'here' when q.accepted_at is not null then 'accepted' else 'requested' end
               from public.chart_requests q where q.case_id = p_case and q.kind = 'imaging' and q.cancelled_at is null order by q.id desc limit 1),
    'help', (select case when q.done_at is not null then 'done' when q.here_at is not null then 'here' when q.accepted_at is not null then 'accepted' else 'requested' end
               from public.chart_requests q where q.case_id = p_case and q.kind = 'help' and q.cancelled_at is null order by q.id desc limit 1))
$$;

create or replace function public.chart_suggested_esi(pain int) returns int
language sql immutable set search_path = '' as $$
  select case when pain is null then null when pain >= 9 then 2 when pain >= 7 then 3 when pain >= 4 then 4 else 5 end
$$;

-- One case as the board sees it; `full` adds the desk/owner details.
create or replace function public.chart_case_board(c public.chart_cases, p_full boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', c.id, 'short_name', public.checkin_short_name(c.patient_name), 'esi', c.esi, 'colour_confirmed', c.colour_confirmed,
    'state', c.state, 'source', c.source, 'team', c.team, 'extra_teams', to_jsonb(c.extra_teams), 'child', c.child, 'npc', c.npc, 'bed', c.bed_id,
    'owner', c.owner_id, 'owner_name', case when c.owner_id is not null then public.chart_short(c.owner_id) end, 'priority', c.priority,
    'prioritised', c.prioritised, 'lost_nurse', c.lost_nurse, 'handback_count', c.handback_count, 'queued_at', c.queued_at, 'assigned_at', c.assigned_at,
    'assign_expires_at', c.assign_expires_at, 'called_at', c.called_at, 'called_out_at', c.called_out_at, 'off_ward', c.off_ward,
    'code', c.code_at is not null, 'online_unconfirmed', c.source = 'online' and c.state = 'checked_in', 'flag_supervisor', c.flag_supervisor,
    'eta_at', c.eta_at, 'tags', public.chart_tags(c.id))
  || case when p_full then jsonb_build_object('roblox_username', c.roblox_username, 'roblox_user_id', c.roblox_user_id::text, 'handback_note', c.handback_note,
       'said', c.said, 'age', c.age, 'pain', c.pain, 'suggested_esi', public.chart_suggested_esi(c.pain), 'care_notes', c.care_notes,
       'symptoms', to_jsonb(c.symptoms)) else '{}'::jsonb end
$$;

create or replace function public.chart_req_view(q public.chart_requests) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', q.id, 'case_id', q.case_id, 'kind', q.kind, 'surgery_mode', q.surgery_mode, 'note', q.note, 'red', q.red,
    'room', (select b.room_id from public.chart_cases c join public.chart_beds b on b.id = c.bed_id where c.id = q.case_id),
    'bed', (select c.bed_id from public.chart_cases c where c.id = q.case_id),
    'asked_by', q.asked_by, 'asked_by_name', public.chart_short(q.asked_by), 'asked_at', q.asked_at, 'sent_to', q.sent_to,
    'accepted_by', q.accepted_by, 'accepted_by_name', case when q.accepted_by is not null then public.chart_short(q.accepted_by) end,
    'accepted_at', q.accepted_at, 'here_at', q.here_at, 'done_at', q.done_at, 'done_note', q.done_note, 'cancelled_at', q.cancelled_at,
    'cancel_reason', q.cancel_reason, 'reopened', q.reopened, 'chased', q.chased, 'chased_at', q.chased_at, 'auto', q.auto)
$$;

-- ---------- the wait board (counts only; for the anon hospital block) ----------
create or replace function public.chart_waits() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare med numeric; out jsonb := '{}'::jsonb; kids boolean; w int; inc int; staff_n int; mid numeric; lo int; hi int; k text;
begin
  select case when count(*) >= 3 then percentile_cont(0.5) within group (order by extract(epoch from (c.with_patient_at - c.queued_at)) / 60) end
  into med from public.chart_cases c where c.with_patient_at > now() - interval '3 hours' and c.queued_at is not null and c.with_patient_at >= c.queued_at;
  med := coalesce(med, 12);
  foreach k in array array['adults', 'children'] loop
    kids := k = 'children';
    select count(*) filter (where c.state in ('waiting', 'waiting_in_room', 'checked_in')), count(*) filter (where c.state in ('assigned', 'called', 'in_care'))
    into w, inc from public.chart_cases c where c.status = 'open' and c.child = kids;
    select count(distinct b.owner_id) into staff_n from public.chart_beds b join public.chart_rooms r on r.id = b.room_id
    where b.owner_id is not null and b.available and not r.closed and (r.who = 'anyone' or r.who = case when kids then 'kids' else 'adults' end);
    if staff_n = 0 then select count(*) into staff_n from public.chart_staff s where s.role = 'room'; end if;
    mid := w::numeric / greatest(staff_n, 1) * med;
    lo := (round(mid * 0.7 / 5) * 5)::int; hi := (round(mid * 1.3 / 5) * 5)::int;
    if hi <= 10 then lo := 0; hi := 10; end if;
    out := out || jsonb_build_object(k, jsonb_build_object('waiting', w, 'in_care', inc, 'wait_min', lo, 'wait_max', hi,
             'wait_label', case when lo = 0 and hi = 10 then 'Under 10 min' else lo || '–' || hi || ' min' end,
             'level', case when hi < 30 then 'normal' when hi <= 60 then 'long' else 'very_long' end,
             'gauge', round(least(hi / 90.0, 1), 2)));
  end loop;
  return out;
end $$;

-- Someone is "on" for patients: a clinical shift, or anyone with a Chart role.
create or replace function public.chart_anyone_on() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.shifts s join public.departments d on d.name = s.department where s.status <> 'ended' and d.clinical)
      or exists (select 1 from public.chart_staff x where x.role is not null and (public.chart_shift_of(x.discord_id)).id is not null)
$$;

create or replace function public.chart_hospital() returns jsonb
language sql stable security definer set search_path = '' as $$
  with st as (select case when not (select launched from public.chart_ops where id = 1) or not public.chart_anyone_on() then 'closed'
                          when (select online_mode from public.chart_ops where id = 1) = 'walk_ins_only' then 'walk_ins_only' else 'open' end s),
       live as (select s.join_code from public.sessions s where s.status = 'live' order by s.started_at desc nulls last limit 1)
  select jsonb_build_object(
    'launched', (select launched from public.chart_ops where id = 1),   -- v1.3: false = the Chart isn't open yet (state is then 'closed')
    'state', (select s from st),
    'session', case when exists (select 1 from live) then 'live' else 'none' end,
    'join_code', coalesce((select nullif(join_code, '') from live), (select x.value #>> '{}' from public.settings x where x.key = 'join_code')),
    'next_session_at', case when (select s from st) = 'closed' or not exists (select 1 from live) then
        (select min(s.scheduled_for) from public.sessions s where s.status = 'scheduled' and s.scheduled_for > now()) end,
    'wait_hint', case when (select s from st) <> 'closed' then ((public.chart_waits()->'adults'->>'wait_max')::int) end,
    'waits', case when (select s from st) <> 'closed' then public.chart_waits() end)
$$;

-- ================= READING (staff) =================
create or replace function public.chart_poll(p_since_rev bigint default 0) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare uid text := public.my_discord_id(); sh public.shifts; me public.chart_staff; rv bigint; role text; sup boolean; desk boolean; full_all boolean;
  out jsonb; depts text[];
begin
  if uid is null then perform public.chart_err('no_access', 'Log in to use the Chart.'); end if;
  perform public.chart_lock();
  perform public.chart_tick();
  sh := public.chart_shift_of(uid);
  if sh.id is not null then me := public.chart_whoami(); else delete from public.chart_staff where discord_id = uid; end if;
  -- notices are shown for 60 s
  update public.chart_staff set notices = coalesce((select jsonb_agg(n) from jsonb_array_elements(notices) n where (n->>'at')::timestamptz > now() - interval '60 seconds'), '[]'::jsonb)
  where discord_id = uid and notices <> '[]'::jsonb;
  rv := public.chart_rev();
  if p_since_rev is not null and p_since_rev = rv then return jsonb_build_object('rev', rv, 'unchanged', true); end if;
  role := me.role; sup := role = 'supervisor'; desk := coalesce(role in ('reception', 'supervisor'), false);
  depts := public.chart_person_depts(uid);
  out := jsonb_build_object('rev', rv, 'server_now', now(),
    'ops', jsonb_build_object('session', case when public.chart_session_live() is not null then 'live' else 'none' end,
       'supervisors', coalesce((select jsonb_agg(jsonb_build_object('discord_id', s.discord_id, 'name', public.chart_pname(s.discord_id))) from public.chart_staff s where s.role = 'supervisor'), '[]'),
       'auto_mode', not public.chart_supervised()) || (select jsonb_build_object('reception_open', o.reception_open, 'online_mode', o.online_mode, 'launched', o.launched) from public.chart_ops o where o.id = 1),
    'rooms', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'beds', r.beds, 'area', r.area, 'department', r.department, 'who', r.who, 'closed', r.closed,
       'closed_reason', r.closed_reason, 'problem', case when r.problem_at is not null then jsonb_build_object('note', r.problem_note, 'by_name', public.chart_short(r.problem_by), 'at', r.problem_at) end)
       order by r.sort) from public.chart_rooms r where r.active), '[]'));
  if sh.id is null then
    return out || jsonb_build_object('me', jsonb_build_object('discord_id', uid, 'name', public.chart_pname(uid), 'on_shift', false, 'can_supervise', public.chart_can_supervise()));
  end if;
  out := out || jsonb_build_object('me', jsonb_build_object('discord_id', uid, 'name', public.chart_pname(uid), 'on_shift', true, 'shift_department', sh.department,
      'departments', to_jsonb(depts), 'role', role, 'department', me.department,
      'can_pick', to_jsonb(array_remove(array[
          case when (select reception_open from public.chart_ops where id = 1) then 'reception' end,
          case when cardinality(depts) > 0 then 'room' end,
          case when depts && array['Medical', 'Surgical'] then 'on_call' end,
          case when 'Paramedicine' = any (depts) then 'road' end,
          case when public.chart_can_supervise() then 'supervisor' end], null)),
      'can_supervise', public.chart_can_supervise(), 'ready', me.ready, 'ready_since', me.ready_since,
      'ready_expires_at', case when me.ready then me.last_active_at + interval '10 minutes' end,
      'status', public.chart_staff_status(uid),
      'beds', coalesce((select jsonb_agg(b.id order by b.id) from public.chart_beds b where b.owner_id = uid), '[]'),
      'load', public.chart_load(uid), 'limit', 2,
      'offer', case when me.offer_room_id is not null then jsonb_build_object('room', me.offer_room_id,
          'beds', (select jsonb_agg(b.id order by b.id) from public.chart_beds b where b.room_id = me.offer_room_id and b.available and b.owner_id is null),
          'waiting', (select count(*) from public.chart_cases c join public.chart_beds b on b.id = c.bed_id where b.room_id = me.offer_room_id and c.status = 'open')) end,
      'notices', (select x.notices from public.chart_staff x where x.discord_id = uid)));
  out := out || jsonb_build_object(
    'beds', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'room', b.room_id, 'label', b.label, 'available', b.available, 'off_reason', b.off_reason,
        'owner', case when b.owner_id is not null then jsonb_build_object('discord_id', b.owner_id, 'name', public.chart_pname(b.owner_id),
                       'avatar_url', (select m.avatar_url from public.members m where m.discord_id = b.owner_id)) end,
        'pair', case when b.pair_id is not null then jsonb_build_object('discord_id', b.pair_id, 'name', public.chart_pname(b.pair_id)) end,
        'case_id', (select c.id from public.chart_cases c where c.status = 'open' and c.bed_id = b.id)) order by b.id) from public.chart_beds b), '[]'),
    'cases', coalesce((select jsonb_agg(public.chart_case_board(c, desk or c.owner_id = uid
          or exists (select 1 from public.chart_requests q where q.case_id = c.id and q.accepted_by = uid)) order by c.id)
        from public.chart_cases c where c.status = 'open' and c.state is not null), '[]'),
    'queue', coalesce((select jsonb_agg(c.id order by c.esi nulls last, c.prioritised desc, c.priority desc, c.queued_at) from public.chart_cases c
        where c.status = 'open' and c.state in ('waiting', 'waiting_in_room')), '[]'),
    'codes', coalesce((select jsonb_agg(jsonb_build_object('case_id', c.id, 'room', b.room_id, 'bed', c.bed_id, 'at', c.code_at, 'by_name', c.code_by))
        from public.chart_cases c left join public.chart_beds b on b.id = c.bed_id where c.status = 'open' and c.code_at is not null), '[]'));
  if role is not null then
    out := out || jsonb_build_object('staff', coalesce((select jsonb_agg(jsonb_build_object('discord_id', s.discord_id, 'name', public.chart_pname(s.discord_id),
        'avatar_url', (select m.avatar_url from public.members m where m.discord_id = s.discord_id), 'department', s.department, 'role', s.role,
        'status', public.chart_staff_status(s.discord_id), 'ready_since', s.ready_since,
        'beds', coalesce((select jsonb_agg(b.id order by b.id) from public.chart_beds b where b.owner_id = s.discord_id), '[]'),
        'patients', coalesce((select jsonb_agg(c.id order by c.id) from public.chart_cases c where c.status = 'open' and c.owner_id = s.discord_id), '[]'),
        'request', (select jsonb_build_object('id', q.id, 'kind', q.kind, 'case_id', q.case_id,
                      'room', (select b.room_id from public.chart_cases c join public.chart_beds b on b.id = c.bed_id where c.id = q.case_id),
                      'state', case when q.here_at is not null then 'here' else 'accepted' end)
                    from public.chart_requests q where q.accepted_by = s.discord_id and q.done_at is null and q.cancelled_at is null order by q.id desc limit 1))
        order by s.joined_at) from public.chart_staff s where (public.chart_shift_of(s.discord_id)).id is not null), '[]'));
  end if;
  if desk then
    out := out || jsonb_build_object(
      'to_confirm', coalesce((select jsonb_agg(c.id order by c.queued_at) from public.chart_cases c where c.status = 'open' and c.state = 'checked_in'), '[]'),
      'recent_discharged', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'short_name', public.checkin_short_name(c.patient_name), 'outcome', c.outcome,
          'discharged_at', c.discharged_at, 'rated', c.rating is not null, 'papers', c.papers) order by c.discharged_at desc)
        from public.chart_cases c where c.state = 'discharged' and c.discharged_at > now() - interval '2 hours'), '[]'));
  end if;
  if desk or role = 'road' then
    out := out || jsonb_build_object('incoming', coalesce((select jsonb_agg(c.id order by c.eta_at) from public.chart_cases c where c.status = 'open' and c.state = 'incoming'), '[]'));
  end if;
  if role is not null and role <> 'reception' then
    out := out || jsonb_build_object('requests', coalesce((select jsonb_agg(public.chart_req_view(q) order by q.red desc, q.asked_at)
        from public.chart_requests q join public.chart_cases c on c.id = q.case_id
        where q.done_at is null and q.cancelled_at is null and c.status = 'open'
          and (sup or role = 'on_call' or q.kind in ('help', 'code') or q.asked_by = uid or q.accepted_by = uid or c.owner_id = uid or q.sent_to = uid)), '[]'));
  end if;
  return out;
end $$;

-- May I open this record? Open: on the case, desk (no entries), Supervisor. Closed: owners all, Directors their department's, staff theirs.
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

create or replace function public.chart_suggest(p_kind text, p_prefix text default '') returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(x.label), '[]') from (
    select s.label from public.chart_suggestions s
    where public.my_discord_id() is not null and s.kind = p_kind and not s.hidden and s.norm like lower(btrim(coalesce(p_prefix, ''))) || '%'
    order by s.uses desc, s.label limit 8) x
$$;

create or replace function public.chart_history(p_before_id bigint default null, p_limit int default 30) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(x.j order by x.id desc), '[]') from (
    select c.id, jsonb_build_object('id', c.id, 'short_name', public.checkin_short_name(c.patient_name), 'outcome', c.outcome, 'state', c.state,
             'discharged_at', coalesce(c.discharged_at, c.closed_at), 'team', c.team, 'owner_name', public.chart_short(c.discharged_by), 'rating', c.rating) j
    from public.chart_cases c
    where c.state is not null and c.status <> 'open' and (p_before_id is null or c.id < p_before_id)
      and public.chart_case_access(c, public.my_discord_id()) = 'full'
    order by c.id desc limit least(greatest(coalesce(p_limit, 30), 1), 100)) x
$$;

-- ================= PATIENTS WITH NO ACCOUNT (anon) =================
create or replace function public.chart_public_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('hospital', public.chart_hospital())
$$;

create or replace function public.chart_refused(code text, msg text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('ok', false, 'refused', code, 'message', msg, 'hospital', public.chart_hospital())
$$;

create or replace function public.chart_has_link(t text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(t, '') ~* '(https?:|www\.|discord\.gg|\.com/|\.gg/)'
$$;

create or replace function public.chart_ip_hash() returns text
language sql stable security definer set search_path = '' as $$
  select encode(sha256(convert_to(coalesce(nullif(split_part(coalesce((nullif(current_setting('request.headers', true), '')::jsonb)->>'x-forwarded-for', ''), ',', 1), ''),
                (nullif(current_setting('request.headers', true), '')::jsonb)->>'cf-connecting-ip', 'unknown') || (select ip_salt from public.chart_ops where id = 1), 'UTF8')), 'hex')
$$;

create or replace function public.chart_checkin_anon(p_roblox_username text, p_name text, p_age int, p_symptoms text, p_pain int, p_client_key text,
                                                     p_onset text default null, p_allergies text default null, p_history text default null,
                                                     p_notes text default null, p_roblox_user_id text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare h jsonb; u text := btrim(coalesce(p_roblox_username, '')); nm text := btrim(coalesce(p_name, '')); sym text := btrim(coalesce(p_symptoms, ''));
  iph text; cl text; tok text; cid bigint; prev bigint;
begin
  perform public.chart_lock();
  perform public.chart_tick();
  h := public.chart_hospital();
  if not (select launched from public.chart_ops where id = 1) then return public.chart_refused('closed', 'Online check-in isn''t open yet.'); end if;
  if h->>'state' = 'closed' then return public.chart_refused('closed', 'Online check-in is closed: nobody is on shift.'); end if;
  if h->>'state' = 'walk_ins_only' then return public.chart_refused('walk_ins_only', 'The online check-in desk is closed, but you can still come to the front desk in game.'); end if;
  -- size caps first (cheap), then limits
  if char_length(coalesce(p_roblox_username, '') || coalesce(p_name, '') || coalesce(p_symptoms, '') || coalesce(p_allergies, '') || coalesce(p_history, '')
                 || coalesce(p_notes, '') || coalesce(p_client_key, '') || coalesce(p_onset, '') || coalesce(p_roblox_user_id, '')) > 1100 then
    return public.chart_refused('too_long', 'That''s too much text.');
  end if;
  if u !~ '^(?=.{3,20}$)[A-Za-z0-9]+(_[A-Za-z0-9]+)?$' then return public.chart_refused('bad_username', 'That doesn''t look like a Roblox username (3–20 letters or numbers).'); end if;
  if nm = '' or char_length(nm) > 40 then return public.chart_refused('bad_input', 'Give your character''s name (up to 40 letters).'); end if;
  if p_age is null or p_age < 1 or p_age > 120 then return public.chart_refused('bad_input', 'Give an age from 1 to 120.'); end if;
  if p_pain is null or p_pain < 1 or p_pain > 10 then return public.chart_refused('bad_input', 'Pick your pain from 1 to 10.'); end if;
  if p_onset is not null and p_onset not in ('just_now', 'today', 'days', 'longer') then return public.chart_refused('bad_input', 'Pick when it started.'); end if;
  if sym = '' then return public.chart_refused('bad_input', 'Tell us what''s wrong.'); end if;
  if char_length(sym) > 300 or char_length(coalesce(p_allergies, '')) > 200 or char_length(coalesce(p_history, '')) > 200 or char_length(coalesce(p_notes, '')) > 300 then
    return public.chart_refused('too_long', 'Keep it shorter.');
  end if;
  if public.chart_has_link(nm || ' ' || sym || ' ' || coalesce(p_allergies, '') || ' ' || coalesce(p_history, '') || ' ' || coalesce(p_notes, '')) then
    return public.chart_refused('no_links', 'Links can''t be sent here.');
  end if;
  if p_roblox_user_id is not null and p_roblox_user_id !~ '^[0-9]{1,15}$' then return public.chart_refused('bad_input', 'That Roblox account id isn''t right.'); end if;
  iph := public.chart_ip_hash();
  cl := encode(sha256(convert_to(coalesce(nullif(btrim(p_client_key), ''), 'none') || (select ip_salt from public.chart_ops where id = 1), 'UTF8')), 'hex');
  if (select count(*) from public.chart_checkin_attempts a where a.kind = 'checkin' and a.client_hash = cl and a.at > now() - interval '1 hour') >= 3
     or (select count(*) from public.chart_checkin_attempts a where a.kind = 'checkin' and a.ip_hash = iph and a.at > now() - interval '1 hour') >= 5 then
    return public.chart_refused('slow_down', 'Too many check-ins from here. Wait a little, or come to the front desk in game.');
  end if;
  insert into public.chart_checkin_attempts (ip_hash, client_hash, ok, kind) values (iph, cl, false, 'checkin');
  if (select count(*) from public.chart_cases c where c.status = 'open' and c.state = 'checked_in' and c.source = 'online') >= 15
     or (select count(*) from public.chart_checkin_attempts a where a.kind = 'checkin' and a.ok and a.at > now() - interval '1 hour') >= 60 then
    return public.chart_refused('busy', 'The front desk is busy: please check in at the desk in game.');
  end if;
  if exists (select 1 from public.chart_cases c where c.status = 'open' and c.source = 'online' and lower(c.roblox_username) = lower(u)) then
    return public.chart_refused('duplicate', 'You''re already checked in. Use your visit link.');
  end if;
  tok := translate(rtrim(encode(extensions.gen_random_bytes(32), 'base64'), '='), '+/', '-_');
  select x.id into prev from public.chart_cases x where lower(x.roblox_username) = lower(u) and x.status = 'closed' and x.closed_at > now() - interval '3 hours' order by x.closed_at desc limit 1;
  insert into public.chart_cases (patient_name, roblox_username, roblox_user_id, age, child, symptoms, complaint, pain, said, onset, allergies, past_history, care_notes,
                                  arrival, status, state, source, colour_confirmed, queued_at, opened_by, opened_by_name, session_id, visit_token_hash, previous_case_id)
  values (nm, u, p_roblox_user_id::bigint, p_age, p_age < 18, array[sym], left(sym, 120), p_pain,
          case when p_pain >= 7 then 'very_bad' when p_pain >= 4 then 'quite_bad' else 'a_little' end, p_onset,
          nullif(btrim(coalesce(p_allergies, '')), ''), nullif(btrim(coalesce(p_history, '')), ''), nullif(btrim(coalesce(p_notes, '')), ''),
          'self_checkin', 'open', 'checked_in', 'online', false, now(), 'online', 'Online check-in', public.chart_session_live(),
          sha256(convert_to(tok, 'UTF8')), prev)
  returning id into cid;
  update public.chart_checkin_attempts set ok = true where id = (select max(id) from public.chart_checkin_attempts where client_hash = cl);
  insert into public.chart_log (case_id, actor_name, action, detail) values (cid, 'Online', 'checkin', jsonb_build_object('source', 'online', 'pain', p_pain));
  perform public.chart_bump();
  return jsonb_build_object('ok', true, 'token', tok, 'hospital', public.chart_hospital());
end $$;

create or replace function public.chart_by_token(p_token text) returns public.chart_cases
language sql stable security definer set search_path = '' as $$
  select c.* from public.chart_cases c
  where p_token is not null and char_length(p_token) between 20 and 80 and c.visit_token_hash = sha256(convert_to(p_token, 'UTF8'))
    and (c.visit_expires_at is null or c.visit_expires_at > now())
$$;

create or replace function public.chart_visit(p_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.chart_cases := public.chart_by_token(p_token); place int; staff_n int; med numeric := 12;
begin
  if c.id is null then return jsonb_build_object('ok', false, 'gone', true, 'hospital', public.chart_hospital()); end if;
  if c.state in ('checked_in', 'waiting', 'waiting_in_room', 'assigned') then
    select count(*) + 1 into place from public.chart_cases x
    where x.status = 'open' and x.child = c.child and x.state in ('checked_in', 'waiting', 'waiting_in_room') and x.id <> c.id
      and (coalesce(x.esi, 9), x.queued_at) < (coalesce(c.esi, 9), c.queued_at);
    select count(*) into staff_n from public.chart_staff s where s.role = 'room';
  end if;
  return jsonb_build_object('ok', true, 'hospital', public.chart_hospital(), 'visit', jsonb_build_object(
    'name', public.checkin_short_name(c.patient_name), 'state', c.state,
    'state_words', case c.state when 'checked_in' then 'Waiting for the front desk' when 'waiting' then 'Waiting' when 'waiting_in_room' then 'Waiting'
                     when 'assigned' then 'Waiting' when 'called' then 'A nurse is on the way' when 'in_care' then 'Being treated' when 'discharged' then 'Discharged'
                     else 'Visit ended' end,
    'place', place, 'wait_hint', case when place is not null then greatest(5, (round(place::numeric / greatest(staff_n, 1) * med / 5) * 5)::int) end,
    'room', case when c.state in ('called', 'in_care') then (select b.room_id from public.chart_beds b where b.id = c.bed_id) end,
    'carer', case when c.owner_id is not null and c.state in ('called', 'in_care') then public.chart_title(c.owner_id) end,
    'outcome', c.outcome,
    'papers', case when c.state = 'discharged' then jsonb_build_object(
        'outcome_label', case c.outcome when 'home' then 'Went home' when 'follow_up' then 'Went home, come back later' when 'admitted' then 'Stayed in hospital'
                                        when 'transferred' then 'Sent elsewhere' end,
        'diagnosis', c.diagnosis,
        'care_given', coalesce((select jsonb_agg(e.data->>'text' order by e.at) from public.chart_entries e where e.case_id = c.id and e.kind in ('intervention', 'order') and e.error_at is null), '[]'),
        'advice', c.advice, 'follow_up', c.follow_up,
        'treated_by', coalesce((select jsonb_agg(public.chart_title(x)) from unnest(c.cared_for) x), '[]'),
        'arrived_at', c.opened_at, 'closed_at', coalesce(c.discharged_at, c.closed_at)) end,
    'can_rate', c.state = 'discharged' and c.rating is null, 'rating', c.rating, 'rating_source', c.rating_source,
    'can_cancel', c.state in ('checked_in', 'waiting')));
end $$;

create or replace function public.chart_visit_rate(p_token text, p_rating int, p_comment text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare c public.chart_cases;
begin
  perform public.chart_lock();
  c := public.chart_by_token(p_token);
  if c.id is null then return jsonb_build_object('ok', false, 'refused', 'gone', 'message', 'This visit has ended or the link is wrong.'); end if;
  if c.state <> 'discharged' then return jsonb_build_object('ok', false, 'refused', 'not_yet', 'message', 'You can rate your visit once you''re discharged.'); end if;
  if c.rating is not null then return jsonb_build_object('ok', false, 'refused', 'already_rated', 'message', 'This visit has already been rated. Thank you!'); end if;
  if p_rating is null or p_rating < 1 or p_rating > 5 then return jsonb_build_object('ok', false, 'refused', 'bad_input', 'message', 'Pick 1 to 5 stars.'); end if;
  if char_length(coalesce(p_comment, '')) > 500 or public.chart_has_link(p_comment) then
    return jsonb_build_object('ok', false, 'refused', 'too_long', 'message', 'Keep the comment short, with no links.');
  end if;
  update public.chart_cases set rating = p_rating, rating_comment = nullif(btrim(coalesce(p_comment, '')), ''), rated_at = now(), rating_source = 'patient' where id = c.id;
  insert into public.chart_log (case_id, actor_name, action, detail) values (c.id, 'Patient', 'rate', jsonb_build_object('rating', p_rating));
  perform public.chart_bump();
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.chart_visit_cancel(p_token text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare c public.chart_cases;
begin
  perform public.chart_lock();
  c := public.chart_by_token(p_token);
  if c.id is null then return jsonb_build_object('ok', false, 'refused', 'gone', 'message', 'This visit has ended or the link is wrong.'); end if;
  if c.state not in ('checked_in', 'waiting') then return jsonb_build_object('ok', false, 'refused', 'too_late', 'message', 'A nurse already has you: tell them in game.'); end if;
  perform public.chart_close_case(c.id, 'left_before_seen', 'left_before_seen');
  update public.chart_cases set left_note = 'Cancelled by the patient' where id = c.id;
  insert into public.chart_log (case_id, actor_name, action) values (c.id, 'Patient', 'visit_cancel');
  perform public.chart_bump();
  return jsonb_build_object('ok', true);
end $$;

-- For the roblox-lookup Edge Function (service role only): 20 lookups a minute per salted IP hash.
create or replace function public.chart_lookup_allowed(p_ip text) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare iph text := encode(sha256(convert_to(coalesce(p_ip, 'unknown') || (select ip_salt from public.chart_ops where id = 1), 'UTF8')), 'hex');
begin
  if (select count(*) from public.chart_checkin_attempts a where a.kind = 'lookup' and a.ip_hash = iph and a.at > now() - interval '1 minute') >= 20 then return false; end if;
  insert into public.chart_checkin_attempts (ip_hash, ok, kind) values (iph, true, 'lookup');
  return true;
end $$;

-- ---------- grants ----------
do $$
declare f record;
begin
  for f in select p.oid::regprocedure::text sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('chart_title', 'chart_staff_status', 'chart_tags', 'chart_suggested_esi', 'chart_case_board', 'chart_req_view',
             'chart_waits', 'chart_anyone_on', 'chart_hospital', 'chart_poll', 'chart_case_access', 'chart_case', 'chart_suggest', 'chart_history',
             'chart_public_status', 'chart_refused', 'chart_has_link', 'chart_ip_hash', 'chart_checkin_anon', 'chart_by_token', 'chart_visit',
             'chart_visit_rate', 'chart_visit_cancel', 'chart_lookup_allowed') loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
    if f.proname in ('chart_poll', 'chart_case', 'chart_suggest', 'chart_history') then
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
    if f.proname in ('chart_public_status', 'chart_checkin_anon', 'chart_visit', 'chart_visit_rate', 'chart_visit_cancel') then
      execute format('grant execute on function %s to anon, authenticated', f.sig);
    end if;
  end loop;
end $$;
