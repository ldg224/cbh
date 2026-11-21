-- 0103 (Bravo, 21 Nov 2026): Chart capacity for 50 people at once. Delta's smoke test on 0.48.0 (31 sessions polling every
-- 3 s, 2 Supervisors writing): chart_poll p50 12 s, chart_role_set p50 19 s with half timing out. Causes, measured on a
-- 50-person floor: every poll took the global Chart lock, so polls and writes queued behind each other; and every change made
-- each viewer rebuild the whole floor (about 170-400 ms each, mostly per-row helper calls).
--   chart_poll        never waits for the Chart lock: it ticks only when a tick is due and the lock is free (pg_try_...)
--   chart_poll_cache  the parts of the reply that are the same for every viewer (ops, rooms, beds, both forms of every
--                     patient card, queue, codes, calls, visits, admins, staff, the desk lists, incoming) are built once
--                     per Chart revision by chart_poll_shared (the same expressions, copied) and reused by everyone; the
--                     first poller after a change builds them while others wait for it (up to 2 s)
--   chart_whoami      no longer writes the caller's Chart row on every poll when nothing changed
-- The reply is unchanged (proved by comparing old and new output for several viewers on a busy test floor). chart_poll is
-- replaced whole and chart_whoami patched by exact text replacement; the down file restores both exactly.

-- ---------- the parts of chart_poll that are the same for every viewer, built once per Chart revision ----------
create table if not exists public.chart_poll_cache (
  id        int primary key default 1 check (id = 1),
  rev       bigint not null,
  built_at  timestamptz not null default now(),
  data      jsonb not null
);
alter table public.chart_poll_cache enable row level security;
revoke all on table public.chart_poll_cache from public, anon, authenticated;
grant all on table public.chart_poll_cache to service_role;

-- Exactly the expressions chart_poll used (copied verbatim), so the reply is unchanged; patient cards in both forms.
create or replace function public.chart_poll_shared() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'ops', jsonb_build_object('session', case when public.chart_session_live() is not null then 'live' else 'none' end,
       'supervisors', coalesce((select jsonb_agg(jsonb_build_object('discord_id', s.discord_id, 'name', public.chart_pname(s.discord_id))) from public.chart_staff s where s.role = 'supervisor'), '[]'),
       'auto_mode', not public.chart_supervised()) || (select jsonb_build_object('reception_open', o.reception_open, 'npc_in_session', o.npc_in_session, 'map', o.map_applied, 'online_mode', o.online_mode, 'launched', o.launched) from public.chart_ops o where o.id = 1),
    'rooms', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'beds', r.beds, 'area', r.area, 'wing', r.wing, 'department', r.department, 'who', r.who, 'closed', r.closed,
       'closed_reason', r.closed_reason, 'problem', case when r.problem_at is not null then jsonb_build_object('note', r.problem_note, 'by_name', public.chart_short(r.problem_by), 'at', r.problem_at) end)
       order by r.sort) from public.chart_rooms r where r.active), '[]'),
    'beds', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'room', b.room_id, 'label', b.label, 'available', b.available, 'off_reason', b.off_reason, 'away', public.chart_away(b.owner_id), 'reserved', public.chart_bed_reserved(b.id),
        'owner', case when b.owner_id is not null then jsonb_build_object('discord_id', b.owner_id, 'name', public.chart_pname(b.owner_id),
                       'avatar_url', (select m.avatar_url from public.members m where m.discord_id = b.owner_id)) end,
        'pair', case when b.pair_id is not null then jsonb_build_object('discord_id', b.pair_id, 'name', public.chart_pname(b.pair_id)) end,
        'case_id', (select c.id from public.chart_cases c where c.status = 'open' and c.bed_id = b.id)) order by b.id) from public.chart_beds b join public.chart_rooms r on r.id = b.room_id where r.active), '[]'),
    'cases_full', coalesce((select jsonb_object_agg(c.id::text, public.chart_case_board(c, true)) from public.chart_cases c where c.status = 'open' and c.state is not null), '{}'),
    'cases_lite', coalesce((select jsonb_object_agg(c.id::text, public.chart_case_board(c, false)) from public.chart_cases c where c.status = 'open' and c.state is not null), '{}'),
    'queue', coalesce((select jsonb_agg(c.id order by c.esi nulls last, c.prioritised desc, c.priority desc, c.queued_at) from public.chart_cases c
        where c.status = 'open' and c.state in ('waiting', 'waiting_in_room')), '[]'),
    'codes', coalesce((select jsonb_agg(jsonb_build_object('case_id', c.id, 'room', b.room_id, 'bed', c.bed_id, 'at', c.code_at, 'by_name', c.code_by))
        from public.chart_cases c left join public.chart_beds b on b.id = c.bed_id where c.status = 'open' and c.code_at is not null), '[]'),
    'calls', public.chart_calls_view(), 'visits', public.chart_visits_view(), 'admins', public.chart_admins_view(),
    'staff', coalesce((select jsonb_agg(jsonb_build_object('discord_id', s.discord_id, 'name', public.chart_pname(s.discord_id),
        'avatar_url', (select m.avatar_url from public.members m where m.discord_id = s.discord_id), 'department', s.department, 'role', s.role,
        'status', public.chart_staff_status(s.discord_id), 'ready_since', s.ready_since, 'call', public.chart_call_state(s.discord_id), 'rank', public.chart_rank_label(s.discord_id),
        'admin', public.chart_admin_kind(s.discord_id) is not null, 'shift_started_at', (public.chart_shift_of(s.discord_id)).started_at,
        'visit', public.chart_visit_state(s.discord_id),
        'beds', coalesce((select jsonb_agg(b.id order by b.id) from public.chart_beds b where b.owner_id = s.discord_id), '[]'),
        'patients', coalesce((select jsonb_agg(c.id order by c.id) from public.chart_cases c where c.status = 'open' and c.owner_id = s.discord_id), '[]'),
        'request', (select jsonb_build_object('id', q.id, 'kind', q.kind, 'case_id', q.case_id,
                      'room', (select b.room_id from public.chart_cases c join public.chart_beds b on b.id = c.bed_id where c.id = q.case_id),
                      'state', case when q.here_at is not null then 'here' else 'accepted' end)
                    from public.chart_requests q where q.accepted_by = s.discord_id and q.done_at is null and q.cancelled_at is null order by q.id desc limit 1))
        order by s.joined_at) from public.chart_staff s where (public.chart_shift_of(s.discord_id)).id is not null), '[]'),
    'to_confirm', coalesce((select jsonb_agg(c.id order by c.queued_at) from public.chart_cases c where c.status = 'open' and c.state = 'checked_in'), '[]'),
    'recent_discharged', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'short_name', public.checkin_short_name(c.patient_name), 'outcome', c.outcome,
          'discharged_at', c.discharged_at, 'rated', c.rating is not null, 'papers', c.papers) order by c.discharged_at desc)
        from public.chart_cases c where c.state = 'discharged' and c.discharged_at > now() - interval '2 hours'), '[]'),
    'incoming', coalesce((select jsonb_agg(c.id order by c.eta_at) from public.chart_cases c where c.status = 'open' and c.state = 'incoming'), '[]'))
$$;

-- The shared parts for the current revision: from the cache, or built by the first poller after a change while the
-- others wait for it (up to 2 s, then build their own). Returns them with 'rev' set to the revision they belong to.
create or replace function public.chart_poll_cached(p_rev bigint) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare d jsonb; r bigint; prev text := current_setting('lock_timeout');
begin
  select x.data into d from public.chart_poll_cache x where x.id = 1 and x.rev = p_rev;
  if d is not null then return d; end if;
  begin
    perform set_config('lock_timeout', '2s', true);
    perform pg_advisory_xact_lock(hashtext('cbh_chart_poll_cache'));
  exception when lock_not_available then null;
  end;
  perform set_config('lock_timeout', prev, true);
  r := public.chart_rev();
  select x.data into d from public.chart_poll_cache x where x.id = 1 and x.rev = r;
  if d is not null then return d; end if;
  d := public.chart_poll_shared() || jsonb_build_object('rev', r);
  insert into public.chart_poll_cache as x (id, rev, built_at, data) values (1, r, now(), d)
  on conflict (id) do update set rev = excluded.rev, built_at = excluded.built_at, data = excluded.data where x.rev < excluded.rev;
  return d;
end $$;

revoke execute on function public.chart_poll_shared() from public, anon, authenticated;
grant execute on function public.chart_poll_shared() to service_role;
revoke execute on function public.chart_poll_cached(bigint) from public, anon, authenticated;
grant execute on function public.chart_poll_cached(bigint) to service_role;

create or replace function public.chart_poll(p_since_rev bigint DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare uid text := public.my_discord_id(); sh public.shifts; me public.chart_staff; rv bigint; role text; sup boolean; desk boolean; full_all boolean;
  out jsonb; depts text[]; shd jsonb;
begin
  if uid is null then perform public.chart_err('no_access', 'Log in to use the Chart.'); end if;
  -- 0103: a poll never waits for the Chart lock. It ticks only when a tick is due (they're 2 s apart) and nobody else holds
  -- the lock; otherwise it skips the tick (the next poll or write does it). Writes still take the lock.
  if coalesce((select o.last_tick_at from public.chart_ops o where o.id = 1), '-infinity'::timestamptz) <= now() - interval '2 seconds'
     and pg_try_advisory_xact_lock(hashtext('cbh_chart_ops')) then
    perform public.chart_tick();
  end if;
  sh := public.chart_shift_of(uid);
  if sh.id is not null then me := public.chart_whoami(); else delete from public.chart_staff where discord_id = uid; end if;
  -- notices are shown for 60 s
  update public.chart_staff set notices = coalesce((select jsonb_agg(n) from jsonb_array_elements(notices) n where (n->>'at')::timestamptz > now() - interval '60 seconds'), '[]'::jsonb)
  where discord_id = uid and notices <> '[]'::jsonb;
  rv := public.chart_rev();
  if p_since_rev is not null and p_since_rev = rv then return jsonb_build_object('rev', rv, 'unchanged', true); end if;
  role := me.role; sup := role = 'supervisor'; desk := coalesce(role in ('reception', 'supervisor'), false);
  depts := public.chart_person_depts(uid);
  -- 0103: everything the same for every viewer comes from the per-revision cache
  shd := public.chart_poll_cached(rv);
  rv := (shd->>'rev')::bigint;
  out := jsonb_build_object('rev', rv, 'server_now', now(),
    'ops', shd->'ops',
    'rooms', shd->'rooms');
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
      'can_supervise', public.chart_can_supervise(), 'call', public.chart_call_state(uid), 'can_join', public.chart_calls_joinable(uid), 'order', public.chart_order_mine(uid), 'visit', public.chart_visit_state(uid),
      'partner_ask', public.chart_partner_for(uid), 'partner_wait', public.chart_partner_waiting(uid), 'rank', public.chart_rank_label(uid),
      'shift_started_at', sh.started_at, 'admin', public.chart_admin_kind(uid) is not null, 'ready', me.ready, 'ready_since', me.ready_since,
      'ready_expires_at', case when me.ready then me.last_active_at + interval '10 minutes' end,
      'status', public.chart_staff_status(uid),
      'beds', coalesce((select jsonb_agg(b.id order by b.id) from public.chart_beds b where b.owner_id = uid), '[]'),
      'load', public.chart_load(uid), 'limit', 2,
      'offer', case when me.offer_room_id is not null then jsonb_build_object('room', me.offer_room_id,
          'beds', (select jsonb_agg(y.id) from (select b.id from public.chart_beds b where b.room_id = me.offer_room_id and b.available and b.owner_id is null order by b.id limit 1) y),
          'waiting', (select count(*) from public.chart_cases c join public.chart_beds b on b.id = c.bed_id where b.room_id = me.offer_room_id and c.status = 'open')) end,
      'notices', (select x.notices from public.chart_staff x where x.discord_id = uid)));
  out := out || jsonb_build_object(
    'beds', shd->'beds',
    'cases', coalesce((select jsonb_agg(coalesce(
          case when desk or c.owner_id = uid or exists (select 1 from public.chart_requests q where q.case_id = c.id and q.accepted_by = uid)
               then shd->'cases_full'->(c.id::text) else shd->'cases_lite'->(c.id::text) end,
          public.chart_case_board(c, desk or c.owner_id = uid or exists (select 1 from public.chart_requests q where q.case_id = c.id and q.accepted_by = uid)))
          order by c.id)
        from public.chart_cases c where c.status = 'open' and c.state is not null), '[]'),
    'queue', shd->'queue',
    'codes', shd->'codes',
    'calls', shd->'calls', 'visits', shd->'visits', 'admins', shd->'admins');
  if role is not null then
    out := out || jsonb_build_object('staff', shd->'staff');
  end if;
  if desk then
    out := out || jsonb_build_object(
      'to_confirm', shd->'to_confirm',
      'recent_discharged', shd->'recent_discharged');
  end if;
  if desk or role = 'road' then
    out := out || jsonb_build_object('incoming', shd->'incoming');
  end if;
  if role is not null and role <> 'reception' then
    out := out || jsonb_build_object('requests', coalesce((select jsonb_agg(public.chart_req_view(q) order by q.red desc, q.asked_at)
        from public.chart_requests q join public.chart_cases c on c.id = q.case_id
        where q.done_at is null and q.cancelled_at is null and c.status = 'open'
          and (sup or role = 'on_call' or q.kind in ('help', 'code') or q.asked_by = uid or q.accepted_by = uid or c.owner_id = uid or q.sent_to = uid)), '[]'));
  end if;
  return out;
end $function$;

do $m$
declare d text; n text;
begin
  d := pg_get_functiondef('public.chart_whoami()'::regprocedure);
  n := replace(d, $a$  insert into public.chart_staff as x (discord_id, shift_id, department)
$a$,
                  $b$  -- 0103: nothing to write when they already have a Chart row for this shift (a write per poll queued behind writers)
  select * into s from public.chart_staff x where x.discord_id = me;
  if s.discord_id is not null and s.shift_id = sh.id then return s; end if;
  insert into public.chart_staff as x (discord_id, shift_id, department)
$b$);
  if n = d then raise exception '0103: chart_whoami text not found'; end if;
  execute n;
end $m$;
