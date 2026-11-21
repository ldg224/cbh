-- 0101 (Bravo, 21 Nov 2026): the trauma call carries its patient into the bay (supervisor-v2.md §8; the user couldn't get
-- an arrived ambulance patient into TB1). Additive: two new helpers, and exact text replacements on live functions
-- (asserted), each reversed by the down file.
--   chart_call_arrive    on handover (the ambulance patient arrives), a call tied to that patient puts them straight into
--                        the call's bay (its bed, else another free bed in that bay), skipping Up next, and tells the team
--                        "<patient> has arrived in Trauma Bay 1". No free bed: they stay in Up next, flagged for the
--                        Supervisor; the handover reply says bay_busy
--   chart_call_place     Supervisor: "Place in Trauma Bay 1" / a patient dropped on the bay (chart_assign needs a bay
--                        holder): ties the call to the patient and seats them now (or, if still incoming, on arrival)
--   chart_call_nurse     their nurse: whoever holds that bed, else the first Nursing member of the call to arrive (now, or
--                        when they press Arrived); the patient goes straight to in care with them
--   chart_call_sweep     a call on a bay with no patient takes the patient placed in that bay (any way they get there)
-- Finishing or cancelling a call already releases the team and leaves the patient with their nurse; a patient who leaves
-- already ends the call ('Patient left'). No change there.

-- The patient's nurse for a trauma call's patient in the bay: whoever holds that bed, else the first Nursing member of the
-- call to arrive. Only when the patient has no nurse yet (the Supervisor can change it as usual). Returns the nurse, or null.
create or replace function public.chart_call_nurse(p_call bigint) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare c public.chart_calls; k public.chart_cases; nurse text;
begin
  select * into c from public.chart_calls x where x.id = p_call;
  if c.id is null or c.case_id is null or c.status not in ('open', 'full') then return null; end if;
  select * into k from public.chart_cases x where x.id = c.case_id;
  if k.id is null or k.status <> 'open' or k.owner_id is not null or k.bed_id is null
     or k.state not in ('waiting', 'checked_in', 'waiting_in_room') then return null; end if;
  if (select b.room_id from public.chart_beds b where b.id = k.bed_id) is distinct from public.chart_call_room(c.bed_id, null) then return null; end if;
  nurse := (select b.owner_id from public.chart_beds b where b.id = k.bed_id);
  if nurse is null then
    select m.discord_id into nurse from public.chart_call_members m
    where m.call_id = c.id and m.department = 'Nursing' and m.state = 'arrived' order by m.arrived_at, m.id limit 1;
  end if;
  if nurse is null then return null; end if;
  update public.chart_cases set owner_id = nurse, state = 'in_care', assigned_at = coalesce(assigned_at, now()), with_patient_at = now(),
         assign_expires_at = null, assign_from = null, last_at = now()
  where id = k.id;
  perform public.chart_worked(k.id, nurse);
  perform public.chart_notice(nurse, format('%s in %s is your patient.', public.checkin_short_name(k.patient_name),
                              (select b.label from public.chart_beds b where b.id = k.bed_id)));
  insert into public.chart_log (case_id, subject_id, actor_name, action, detail)
  values (k.id, nurse, 'Auto', 'call_nurse', jsonb_build_object('call', c.id, 'bed', k.bed_id));
  return nurse;
end $$;

-- Seat a call's patient in the call's bay: its bed, else another free bed in that bay. Ties the call to the patient, sets
-- their nurse (chart_call_nurse) and tells the team. Returns {placed:{..}} or {bay_busy:true, ..} (nothing changed then).
create or replace function public.chart_call_seat(p_call bigint, p_case bigint) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare c public.chart_calls; k public.chart_cases; rm text; bed text; nurse text; who text;
begin
  select * into c from public.chart_calls x where x.id = p_call;
  select * into k from public.chart_cases x where x.id = p_case;
  rm := public.chart_call_room(c.bed_id, null);
  select b.id into bed from public.chart_beds b
  where b.room_id = rm and public.chart_place_ok(k.id, b.id, null, 'place') is null
    and not exists (select 1 from public.chart_cases z where z.status = 'open' and z.bed_id = b.id and z.id <> k.id)
  order by (b.id = k.bed_id) desc, (b.id = c.bed_id) desc, b.id limit 1;
  if bed is null then return jsonb_build_object('bay_busy', true, 'bay', rm, 'bay_name', public.chart_room_name(rm), 'call', c.id); end if;
  update public.chart_calls set case_id = k.id where id = c.id and case_id is null;
  update public.chart_cases set bed_id = bed, state = 'waiting_in_room', queued_at = coalesce(queued_at, now()), last_at = now() where id = k.id;
  nurse := public.chart_call_nurse(c.id);
  for who in select distinct x from (select c.started_by x union select m.discord_id from public.chart_call_members m
                                     where m.call_id = c.id and m.state in ('called', 'on_way', 'arrived')) y loop
    perform public.chart_notice(who, format('%s has arrived in %s.', public.checkin_short_name(k.patient_name), public.chart_room_name(rm)));
  end loop;
  insert into public.chart_log (case_id, actor_name, action, detail) values (k.id, coalesce(public.chart_short(public.my_discord_id()), 'Auto'), 'call_seat',
         jsonb_build_object('call', c.id, 'bed', bed, 'nurse', nurse));
  return jsonb_build_object('placed', jsonb_build_object('bed', bed, 'room', rm, 'bay_name', public.chart_room_name(rm), 'nurse', nurse), 'call', c.id);
end $$;

-- A trauma call's patient has arrived (handover): straight into the call's bay, skipping Up next. If the bay has no free bed
-- they stay in Up next, flagged for the Supervisor (bay_busy in the handover reply).
create or replace function public.chart_call_arrive(p_case bigint) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare c public.chart_calls; r jsonb;
begin
  select * into c from public.chart_calls x where x.case_id = p_case and x.status in ('open', 'full') order by x.id desc limit 1;
  if c.id is null or c.bed_id is null then return '{}'::jsonb; end if;
  r := public.chart_call_seat(c.id, p_case);
  if r ? 'bay_busy' then
    update public.chart_cases set flag_supervisor = true, last_at = now() where id = p_case;
    insert into public.chart_log (case_id, actor_name, action, detail) values (p_case, 'Auto', 'call_bay_busy', jsonb_build_object('call', c.id, 'room', r->>'bay'));
  end if;
  return r;
end $$;

-- Supervisor: "Place in Trauma Bay 1" (or a patient dropped on the bay). Ties the call to the patient; a patient who has
-- arrived is seated in the bay now (their nurse: the bay's holder, else the first Nursing member to arrive), an incoming
-- one when they arrive.
create or replace function public.chart_call_place(p_call bigint, p_case bigint) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare c public.chart_calls; k public.chart_cases; r jsonb;
begin
  perform public.chart_call_sup();
  c := public.chart_call_get(p_call);
  if c.bed_id is null then perform public.chart_err('bad_input', 'That trauma call has no bay: drag the patient to a bay instead.'); end if;
  select * into k from public.chart_cases x where x.id = p_case for update;
  if k.id is null or k.status <> 'open' or k.state is null then perform public.chart_err('bad_state', 'That patient has moved on: refresh.'); end if;
  if c.case_id is not null and c.case_id <> k.id then
    perform public.chart_err('call_has_patient', format('This call is for %s.', rtrim((select public.checkin_short_name(x.patient_name) from public.chart_cases x where x.id = c.case_id), '.')));
  end if;
  if exists (select 1 from public.chart_calls x where x.case_id = k.id and x.id <> c.id and x.status in ('open', 'full')) then
    perform public.chart_err('call_exists', format('%s already has a trauma call.', public.checkin_short_name(k.patient_name)));
  end if;
  if k.state = 'incoming' then
    update public.chart_calls set case_id = k.id where id = c.id and case_id is null;
    perform public.chart_act('call_link', k.id, jsonb_build_object('call', c.id));
    return public.chart_done(jsonb_build_object('linked', true, 'call', c.id));
  end if;
  if k.owner_id is not null then
    perform public.chart_err('has_nurse', format('%s has a nurse: move them with their nurse instead.', public.checkin_short_name(k.patient_name)));
  end if;
  r := public.chart_call_seat(c.id, k.id);
  if r ? 'bay_busy' then perform public.chart_err('bay_busy', format('%s is in use: free a bed there first.', r->>'bay_name')); end if;
  perform public.chart_act('call_place', k.id, jsonb_build_object('call', c.id, 'bed', r->'placed'->>'bed'));
  return public.chart_done(r);
end $$;

revoke execute on function public.chart_call_nurse(bigint) from public, anon, authenticated;
grant execute on function public.chart_call_nurse(bigint) to service_role;
revoke execute on function public.chart_call_arrive(bigint) from public, anon, authenticated;
grant execute on function public.chart_call_arrive(bigint) to service_role;
revoke execute on function public.chart_call_seat(bigint, bigint) from public, anon, authenticated;
grant execute on function public.chart_call_seat(bigint, bigint) to service_role;
revoke execute on function public.chart_call_place(bigint, bigint) from public, anon, authenticated;
grant execute on function public.chart_call_place(bigint, bigint) to service_role, authenticated;

do $m$
declare d text; n text;
begin
  d := pg_get_functiondef('public.chart_handover(bigint,text,jsonb)'::regprocedure);
  n := replace(d, $a$  perform public.chart_act('handover', c.id);
  return public.chart_done();$a$,
                  $b$  perform public.chart_act('handover', c.id);
  return public.chart_done(public.chart_call_arrive(c.id));$b$);
  if n = d then raise exception '0101: handover text not found'; end if;
  execute n;
  d := pg_get_functiondef('public.chart_call_arrived(bigint,text)'::regprocedure);
  n := replace(d, $a$  perform public.chart_act('call_arrived', c.case_id,$a$,
                  $b$  perform public.chart_call_nurse(c.id);   -- the first Nursing member to arrive takes a nurse-less patient in the bay
  perform public.chart_act('call_arrived', c.case_id,$b$);
  if n = d then raise exception '0101: call_arrived text not found'; end if;
  execute n;
  d := pg_get_functiondef('public.chart_call_sweep()'::regprocedure);
  n := replace(d, $a$    -- members who clocked out
$a$,
                  $b$    -- a call on a bay with no patient yet: the patient placed in that bay becomes the call's patient
    for x in select c.id, (select k.id from public.chart_cases k join public.chart_beds b on b.id = k.bed_id
                           where b.room_id = public.chart_call_room(c.bed_id, null) and k.status = 'open' and k.state is not null
                             and not exists (select 1 from public.chart_calls o where o.case_id = k.id and o.status in ('open', 'full'))
                           order by (k.bed_id = c.bed_id) desc, k.id limit 1) as k_id
             from public.chart_calls c where c.status in ('open', 'full') and c.case_id is null and c.bed_id is not null loop
      continue when x.k_id is null;
      update public.chart_calls set case_id = x.k_id where id = x.id and case_id is null;
      perform public.chart_call_nurse(x.id);
      insert into public.chart_log (case_id, actor_name, action, detail) values (x.k_id, 'Auto', 'call_link', jsonb_build_object('call', x.id));
      changed := true;
    end loop;
    -- members who clocked out
$b$);
  if n = d then raise exception '0101: call_sweep text not found'; end if;
  execute n;
end $m$;
