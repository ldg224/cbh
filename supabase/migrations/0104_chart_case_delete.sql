-- 0104 (Bravo, 21 Nov 2026): delete a chart made by mistake (Plans/CareBeyond/chart/delete-chart.md; kept simple, as the
-- user asked). A delete is a void, kept for audit. chart_case_void (replaces the unused Supervisor-only version from 0087)
-- lets the Supervisor or an exec delete any open chart with a reason, and the person who made it delete it while fresh; it
-- clears the bed, nurse, requests, orders, visits, a trauma call, a reservation, the queue place and the check-in row, and
-- tells the people affected. chart_case_unvoid: the deleter only, within 10 s, puts the patient back (not a trauma call; if
-- their bed was taken they go to the top of Up next). chart_case gains can.delete / delete_why / delete_reason_needed.
-- Voided charts are already hidden from the poll, the queue, the board and history (status 'void'). The poll is unchanged.

-- Who may delete this chart now, and if not, why (shared by chart_case_void and chart_case's can.delete).
-- The Chart Supervisor (or anyone who can supervise) or an exec: any open chart, with a reason. The person who made it (for an online check-in: who confirmed it):
-- only while fresh (no vitals or notes, no care, no requests, under 10 minutes).
create or replace function public.chart_void_check(c public.chart_cases, who text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare why text;
begin
  if c.id is null or c.status <> 'open' or c.state is null then
    return jsonb_build_object('ok', false, 'why', case when c.status = 'void' then 'Already deleted.' else 'Only an open chart can be deleted.' end);
  end if;
  if public.chart_is_sup() or public.chart_can_supervise() or public.is_exec() then return jsonb_build_object('ok', true, 'reason_needed', true); end if;
  if who is null or who is distinct from coalesce(case when c.source = 'online' then c.online_confirmed_by end, c.opened_by) then
    return jsonb_build_object('ok', false, 'why', 'Only the Supervisor, or the person who made it, can delete a chart.');
  end if;
  why := case
    when c.opened_at < now() - interval '10 minutes' then 'It''s over 10 minutes old: ask the Supervisor.'
    when exists (select 1 from public.chart_entries e where e.case_id = c.id and e.error_at is null) then 'It has vitals or notes now: ask the Supervisor.'
    when c.with_patient_at is not null or c.state in ('in_care', 'called') then 'Someone is caring for them now: ask the Supervisor.'
    when exists (select 1 from public.chart_requests q where q.case_id = c.id) then 'It has requests now: ask the Supervisor.'
  end;
  if why is not null then return jsonb_build_object('ok', false, 'why', why); end if;
  return jsonb_build_object('ok', true, 'reason_needed', false);
end $$;

-- Delete (void) a chart made by mistake. Kept for audit: the log row holds who, when, why and a snapshot for Undo.
-- Clears the bed, its nurse, open requests, orders and visits about it, a trauma call tied to it (team released and told),
-- a bed reservation, its place in Up next and its check-in row. chart_case_unvoid puts the patient back within 10 s.
create or replace function public.chart_case_void(p_case bigint, p_reason text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare me text := public.my_discord_id(); c public.chart_cases; chk jsonb; why text := nullif(btrim(coalesce(p_reason, '')), '');
  nm text; who text; msg text; res_bed text; cks jsonb; reqs jsonb;
begin
  if me is null then perform public.chart_err('no_access', 'Log in to use the Chart.'); end if;
  perform public.chart_lock();
  perform public.chart_tick();
  select * into c from public.chart_cases x where x.id = p_case for update;
  if c.id is null or c.state is null then perform public.chart_err('no_access', 'That patient isn''t there.'); end if;
  chk := public.chart_void_check(c, me);
  if not (chk->>'ok')::boolean then
    perform public.chart_err(case when c.status = 'void' then 'bad_state' when chk->>'why' like 'Only the Supervisor%' then 'no_access'
                                  when c.status <> 'open' then 'bad_state' else 'not_fresh' end, chk->>'why');
  end if;
  if (chk->>'reason_needed')::boolean and char_length(coalesce(why, '')) < 3 then perform public.chart_err('reason_needed', 'Say why it''s being deleted.'); end if;
  why := coalesce(why, 'Made by mistake');
  nm := rtrim(public.checkin_short_name(c.patient_name), '.');
  msg := format('%s''s chart was deleted by %s: you''re no longer needed.', nm, public.chart_pname(me));
  -- tell the people it affected (before their links are cleared)
  for who in select distinct x from (
      select c.owner_id x
      union select q.accepted_by from public.chart_requests q where q.case_id = c.id and q.done_at is null and q.cancelled_at is null
      union select o.person from public.chart_orders o where o.case_id = c.id and o.state in ('sent', 'seen')
      union select v.person from public.chart_visits v where v.case_id = c.id and v.state in ('sent', 'on_way', 'arrived')
      union select m.discord_id from public.chart_call_members m join public.chart_calls k on k.id = m.call_id
            where k.case_id = c.id and k.status in ('open', 'full') and m.state in ('called', 'on_way', 'arrived')) y
    where x is not null and x <> me loop
    perform public.chart_notice(who, msg);
  end loop;
  -- what Undo needs to put the patient back
  select b.id into res_bed from public.chart_beds b where b.reserved_for = c.id limit 1;
  select coalesce(jsonb_agg(jsonb_build_object('id', k.id, 'state', k.state, 'ended_at', k.ended_at, 'ended_reason', k.ended_reason)), '[]')
    into cks from public.chart_checkins k where k.case_id = c.id;
  select coalesce(jsonb_agg(q.id), '[]') into reqs from public.chart_requests q where q.case_id = c.id and q.done_at is null and q.cancelled_at is null;
  -- clear everything attached
  update public.chart_requests set cancelled_at = now(), cancelled_by = me, cancel_reason = 'Chart deleted'
  where case_id = c.id and done_at is null and cancelled_at is null;
  update public.chart_orders set state = 'expired' where case_id = c.id and state in ('sent', 'seen');
  update public.chart_visits set state = 'removed', ended_at = now(), ended_by = me, end_reason = 'Chart deleted'
  where case_id = c.id and state in ('sent', 'on_way', 'arrived');
  update public.chart_call_members m set released_at = now()
  from public.chart_calls k where k.id = m.call_id and k.case_id = c.id and k.status in ('open', 'full') and m.released_at is null and m.state in ('called', 'on_way', 'arrived');
  update public.chart_calls set status = 'done', ended_at = now(), ended_by = me, end_reason = 'Chart deleted' where case_id = c.id and status in ('open', 'full');
  update public.chart_beds set reserved_for = null, reserved_at = null where reserved_for = c.id;
  update public.chart_checkins set state = 'cancelled', ended_at = coalesce(ended_at, now()), ended_reason = 'Chart deleted'
  where case_id = c.id and state not in ('discharged', 'left', 'cancelled');
  update public.chart_cases set status = 'void', void_reason = left(why, 200), voided_at = now(), voided_by = me, bed_id = null, owner_id = null,
         closed_at = now(), closed_by = me, visit_expires_at = now(), assign_expires_at = null, last_at = now()
  where id = c.id;
  perform public.chart_act('void', c.id, jsonb_build_object('reason', why, 'snapshot', to_jsonb(c), 'reserved_bed', res_bed, 'checkins', cks, 'requests', reqs));
  return public.chart_done(jsonb_build_object('undo_until', now() + interval '10 seconds'));
end $$;

-- Undo a delete: only the person who deleted it, within 10 s. The patient comes back as they were (bed, nurse, place,
-- requests, reservation, check-in row); a trauma call isn't restarted. If their bed was taken meanwhile they go to the top
-- of Up next. Works even if the session ended in those 10 s.
create or replace function public.chart_case_unvoid(p_case bigint) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare me text := public.my_discord_id(); c public.chart_cases; l record; s public.chart_cases; bed text; nurse text; st text;
begin
  if me is null then perform public.chart_err('no_access', 'Log in to use the Chart.'); end if;
  perform public.chart_lock();
  select * into c from public.chart_cases x where x.id = p_case for update;
  if c.id is null or c.status <> 'void' or c.voided_by is distinct from me or c.voided_at < now() - interval '10 seconds' then
    perform public.chart_err('undo_over', 'It''s too late to undo that.');
  end if;
  select g.detail into l from public.chart_log g where g.case_id = c.id and g.action = 'void' and g.actor = me order by g.id desc limit 1;
  if l.detail is null or l.detail->'snapshot' is null then perform public.chart_err('undo_over', 'It''s too late to undo that.'); end if;
  s := jsonb_populate_record(null::public.chart_cases, l.detail->'snapshot');
  bed := s.bed_id; nurse := s.owner_id; st := s.state;
  if bed is not null and exists (select 1 from public.chart_cases z where z.status = 'open' and z.bed_id = bed and z.id <> c.id) then
    -- their bed was taken meanwhile: top of Up next, no bed, no nurse
    bed := null; nurse := null; st := 'waiting';
  end if;
  update public.chart_cases set status = s.status, state = st, bed_id = bed, owner_id = nurse,
         void_reason = s.void_reason, voided_at = s.voided_at, voided_by = s.voided_by, closed_at = s.closed_at, closed_by = s.closed_by,
         visit_expires_at = s.visit_expires_at,
         assign_expires_at = case when st = 'assigned' then now() + interval '60 seconds' else s.assign_expires_at end,
         prioritised = case when st = 'waiting' and s.bed_id is not null then true else s.prioritised end, last_at = now()
  where id = c.id;
  update public.chart_requests set cancelled_at = null, cancelled_by = null, cancel_reason = null
  where case_id = c.id and cancel_reason = 'Chart deleted' and id in (select (jsonb_array_elements_text(coalesce(l.detail->'requests', '[]')))::bigint);
  if l.detail->>'reserved_bed' is not null then
    update public.chart_beds set reserved_for = c.id, reserved_at = now() where id = l.detail->>'reserved_bed' and reserved_for is null;
  end if;
  update public.chart_checkins k set state = x.state, ended_at = nullif(x.ended_at, '')::timestamptz, ended_reason = nullif(x.ended_reason, '')
  from (select e->>'id' as id, e->>'state' as state, e->>'ended_at' as ended_at, e->>'ended_reason' as ended_reason
        from jsonb_array_elements(coalesce(l.detail->'checkins', '[]')) e) x
  where k.id::text = x.id and k.case_id = c.id and k.ended_reason = 'Chart deleted';
  if nurse is not null then
    perform public.chart_notice(nurse, format('%s''s chart is back.', rtrim(public.checkin_short_name(s.patient_name), '.')));
  end if;
  perform public.chart_act('unvoid', c.id, jsonb_build_object('bed', bed, 'nurse', nurse, 'bed_was_taken', s.bed_id is not null and bed is null));
  return public.chart_done(jsonb_build_object('bed', bed, 'nurse', nurse, 'state', st));
end $$;

revoke execute on function public.chart_void_check(public.chart_cases, text) from public, anon, authenticated;
grant execute on function public.chart_void_check(public.chart_cases, text) to service_role;
revoke execute on function public.chart_case_void(bigint, text) from public, anon, authenticated;
grant execute on function public.chart_case_void(bigint, text) to service_role, authenticated;
revoke execute on function public.chart_case_unvoid(bigint) from public, anon, authenticated;
grant execute on function public.chart_case_unvoid(bigint) to service_role, authenticated;

do $m$
declare d text; n text;
begin
  d := pg_get_functiondef('public.chart_case(bigint)'::regprocedure);
  n := replace(d, $a$'amend', ed, 'void', ed,$a$,
                  $b$'amend', ed, 'void', ed,
      'delete', coalesce((public.chart_void_check(c, uid)->>'ok')::boolean, false), 'delete_why', public.chart_void_check(c, uid)->>'why',
      'delete_reason_needed', coalesce((public.chart_void_check(c, uid)->>'reason_needed')::boolean, false),$b$);
  if n = d then raise exception '0104: chart_case text not found'; end if;
  execute n;
end $m$;
