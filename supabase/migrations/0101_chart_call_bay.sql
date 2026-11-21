-- 0101 (Bravo, 21 Nov 2026): the trauma call carries its patient into the bay (supervisor-v2.md §8; the user couldn't get
-- an arrived ambulance patient into TB1), and the patient-drag answers (§8b). Needs 0100. Additive: new helpers, two bed
-- columns, and exact text replacements on live functions (asserted), each reversed by the down file.
--   §8   chart_handover -> chart_case_arrive: a trauma call's patient goes straight into the call's bay (its bed, else another
--        free bed there), skipping Up next, and the team is told "<patient> has arrived in Trauma Bay 1"; no free bed ->
--        they stay in Up next flagged for the Supervisor (bay_busy). chart_call_place: "Place in Trauma Bay 1" (chart_assign
--        needs a bay holder). Nurse (chart_call_nurse): the bed's holder, else the first Nursing member of the call to arrive.
--        A bay call takes the patient placed in its bay. Finish/cancel and a patient leaving: unchanged (already right).
--   Q9   chart_patient_drop: an Up next patient onto a free, unheld bed is seated there marked Needs a nurse, first in line
--   Q10  a patient with a nurse onto a bed another nurse holds -> holder_nurse, unless p_handto_holder (true/false)
--   Q11  reservations: chart_bed_reserve / a dropped incoming patient reserve a bed (beds.reserved_for, poll beds[].reserved);
--        no other patient can be placed there (place_ok 'reserved'); on arrival they're seated there; a trauma call for an
--        incoming patient reserves its bay (chart_reserve_sweep in the tick)
--   Q12  the call follows its patient to another bay; the team is told "Trauma call moved to Trauma Bay 2"
--   Q13  chart_set_nurse(case, person) for the Supervisor
--   Q16  an adult into a children's room -> kids_room unless p_anyway (patient drops and reservations)

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

-- ---------- §8b: reservations, patient drops, changing the nurse ----------
alter table public.chart_beds add column if not exists reserved_for bigint;
alter table public.chart_beds add column if not exists reserved_at timestamptz;

create or replace function public.chart_bed_reserved(p_bed text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('case_id', c.id, 'name', public.checkin_short_name(c.patient_name), 'eta_at', c.eta_at, 'at', b.reserved_at)
  from public.chart_beds b join public.chart_cases c on c.id = b.reserved_for where b.id = p_bed
$$;

-- Hold a bed for an incoming patient (no other patient can be placed there). Checks the bed is usable and free.
create or replace function public.chart_reserve_do(p_case bigint, p_bed text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare b public.chart_beds; e text;
begin
  select * into b from public.chart_beds x where x.id = p_bed for update;
  e := public.chart_place_ok(null, p_bed, null, 'own');
  if e is not null then perform public.chart_err(split_part(e, '|', 1), substr(e, strpos(e, '|') + 1)); end if;
  if exists (select 1 from public.chart_cases z where z.status = 'open' and z.bed_id = b.id) then
    perform public.chart_err('bed_taken', format('%s has a patient in it.', b.label));
  end if;
  if b.reserved_for is not null and b.reserved_for <> p_case and exists (select 1 from public.chart_cases z where z.id = b.reserved_for and z.status = 'open' and z.state = 'incoming') then
    perform public.chart_err('reserved', format('%s is reserved for %s.', b.label, rtrim((select public.checkin_short_name(z.patient_name) from public.chart_cases z where z.id = b.reserved_for), '.')));
  end if;
  update public.chart_beds set reserved_for = null, reserved_at = null where reserved_for = p_case and id <> b.id;
  update public.chart_beds set reserved_for = p_case, reserved_at = now() where id = b.id;
end $$;

-- Supervisor: reserve a bed for an incoming ambulance patient ("Reserved: Zoe R. · ambulance 4 min").
create or replace function public.chart_bed_reserve(p_case bigint, p_bed text, p_anyway boolean default false) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare c public.chart_cases; r public.chart_rooms;
begin
  perform public.chart_begin(); perform public.chart_need_sup();
  select * into c from public.chart_cases x where x.id = p_case;
  if c.id is null or c.status <> 'open' or c.state is distinct from 'incoming' then
    perform public.chart_err('bad_state', 'Only an incoming patient can have a bed reserved.');
  end if;
  select r2.* into r from public.chart_rooms r2 join public.chart_beds b on b.room_id = r2.id where b.id = p_bed;
  if (r.who = 'kids' or r.department = 'Paediatric') and not coalesce(c.child, false) and not coalesce(p_anyway, false) then
    perform public.chart_err('kids_room', format('%s is for children. Send anyway?', public.chart_room_name(r.id)));
  end if;
  perform public.chart_reserve_do(c.id, p_bed);
  perform public.chart_act('bed_reserve', c.id, jsonb_build_object('bed', p_bed), r.id);
  return public.chart_done(jsonb_build_object('reserved', p_bed));
end $$;

-- An arriving patient (handover): a trauma call's patient into its bay, else a reserved bed. Their nurse is the bed's
-- holder (a normal assignment, Got it); with nobody holding it they wait there marked "Needs a nurse".
create or replace function public.chart_case_arrive(p_case bigint) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare r jsonb; bed text; holder text; k public.chart_cases;
begin
  r := public.chart_call_arrive(p_case);
  if r <> '{}'::jsonb then
    update public.chart_beds set reserved_for = null, reserved_at = null where reserved_for = p_case;
    return r;
  end if;
  select b.id, b.owner_id into bed, holder from public.chart_beds b where b.reserved_for = p_case limit 1;
  if bed is null then return '{}'::jsonb; end if;
  update public.chart_beds set reserved_for = null, reserved_at = null where reserved_for = p_case;
  if exists (select 1 from public.chart_cases z where z.status = 'open' and z.bed_id = bed and z.id <> p_case) then
    return jsonb_build_object('reserved_busy', true, 'bed', bed);
  end if;
  select * into k from public.chart_cases x where x.id = p_case;
  perform set_config('cbh.kids_ok', 'on', true);   -- the Supervisor reserved this bed for them (children's room answered then)
  update public.chart_cases set bed_id = bed, state = 'waiting_in_room', last_at = now() where id = p_case;
  perform set_config('cbh.kids_ok', '', true);
  if holder is not null and public.chart_load(holder) < 2 and (public.chart_shift_of(holder)).id is not null then
    perform public.chart_do_assign(p_case, bed, holder);
    perform public.chart_notice(holder, format('%s has arrived in %s: press Got it.', public.checkin_short_name(k.patient_name), (select b.label from public.chart_beds b where b.id = bed)));
  else
    holder := null;
    update public.chart_cases set lost_nurse = true, prioritised = true where id = p_case;
  end if;
  insert into public.chart_log (case_id, actor_name, action, detail) values (p_case, 'Auto', 'reserve_arrive', jsonb_build_object('bed', bed, 'nurse', holder));
  return jsonb_build_object('placed', jsonb_build_object('bed', bed, 'room', (select b.room_id from public.chart_beds b where b.id = bed), 'nurse', holder));
end $$;

-- Supervisor: a patient dragged onto a bed (§8b). Incoming -> reserve. Up next with nobody holding the bed -> seated,
-- "Needs a nurse", first in line. Bed holder -> their patient (Got it). A patient with a nurse onto a bed someone else
-- holds -> holder_nurse unless p_handto_holder (true: the holder takes them over; false: their nurse stays). An adult into a
-- children's room -> kids_room unless p_anyway.
create or replace function public.chart_patient_drop(p_case bigint, p_bed text, p_handto_holder boolean default null,
                                                     p_anyway boolean default false, p_override boolean default false) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare c public.chart_cases; b public.chart_beds; r public.chart_rooms; e text; holder text; hs public.chart_staff; nurse text; oid bigint;
begin
  perform public.chart_begin(); perform public.chart_need_sup();
  select * into c from public.chart_cases x where x.id = p_case for update;
  if c.id is null or c.status <> 'open' or c.state is null then perform public.chart_err('bad_state', 'That patient has moved on: refresh.'); end if;
  select * into b from public.chart_beds x where x.id = p_bed for update;
  e := public.chart_place_ok(null, p_bed, null, 'own');   -- no such bed, room closed (with the reason), bed off
  if e is not null then perform public.chart_err(split_part(e, '|', 1), substr(e, strpos(e, '|') + 1)); end if;
  select * into r from public.chart_rooms x where x.id = b.room_id;
  if (r.who = 'kids' or r.department = 'Paediatric') and not coalesce(c.child, false) then
    if not coalesce(p_anyway, false) then perform public.chart_err('kids_room', format('%s is for children. Send anyway?', public.chart_room_name(r.id))); end if;
    perform set_config('cbh.kids_ok', 'on', true);   -- the Supervisor said send anyway (this transaction only)
  end if;
  if r.who = 'adults' and c.child then perform public.chart_err('adults_only', format('%s is for adults only.', public.chart_room_name(r.id))); end if;
  if c.state = 'incoming' then
    perform public.chart_reserve_do(c.id, b.id);
    perform public.chart_act('bed_reserve', c.id, jsonb_build_object('bed', b.id, 'drop', true), r.id);
    return public.chart_done(jsonb_build_object('reserved', b.id));
  end if;
  if c.bed_id = b.id then return public.chart_done(jsonb_build_object('unchanged', true)); end if;
  if exists (select 1 from public.chart_cases z where z.status = 'open' and z.bed_id = b.id and z.id <> c.id) then
    perform public.chart_err('bed_taken', format('%s already has a patient.', b.label));
  end if;
  if b.reserved_for is not null and b.reserved_for <> c.id and exists (select 1 from public.chart_cases z where z.id = b.reserved_for and z.status = 'open' and z.state = 'incoming') then
    perform public.chart_err('reserved', format('%s is reserved for %s.', b.label, rtrim((select public.checkin_short_name(z.patient_name) from public.chart_cases z where z.id = b.reserved_for), '.')));
  end if;
  holder := b.owner_id;
  if c.owner_id is null then
    if holder is not null then
      -- the bed's holder takes them (a normal assignment: Got it)
      select * into hs from public.chart_staff x where x.discord_id = holder;
      if c.team is not null and c.team <> 'Any' and c.team is distinct from hs.department and not coalesce(p_override, false) then
        perform public.chart_err('not_their_team', format('%s is a %s patient and %s is working %s.', public.checkin_short_name(c.patient_name), c.team,
                                 public.chart_pname(holder), coalesce(hs.department, 'no team')));
      end if;
      if public.chart_load(holder) >= 2 then perform public.chart_err('limit', format('%s already has 2 patients.', public.chart_pname(holder))); end if;
      update public.chart_cases set bed_id = b.id, state = 'waiting_in_room', last_at = now() where id = c.id;
      perform public.chart_do_assign(c.id, b.id, holder);
      perform public.chart_notice(holder, format('%s gave you %s in %s: press Got it.', public.chart_short(public.my_discord_id()), public.checkin_short_name(c.patient_name), b.label));
      oid := public.chart_order(holder, 'patient', b.id);
      update public.chart_orders set case_id = c.id where id = oid;
      nurse := holder;
    else
      -- nobody holds the bed: seated there, "Needs a nurse", first in line for the next free nurse in their team
      update public.chart_cases set bed_id = b.id, state = 'waiting_in_room', lost_nurse = true, prioritised = true, last_at = now() where id = c.id;
    end if;
  else
    if holder is not null and holder <> c.owner_id then
      if p_handto_holder is null then
        perform public.chart_err('holder_nurse', format('%s holds %s: hand %s to %s, or keep %s as nurse?', public.chart_pname(holder), b.label,
                                 rtrim(public.checkin_short_name(c.patient_name), '.'), public.chart_short(holder), public.chart_short(c.owner_id)));
      end if;
      if p_handto_holder then
        if public.chart_load(holder) >= 2 then perform public.chart_err('limit', format('%s already has 2 patients.', public.chart_pname(holder))); end if;
        perform public.chart_notice(c.owner_id, format('%s moved %s to %s.', public.chart_short(public.my_discord_id()), public.checkin_short_name(c.patient_name), public.chart_pname(holder)));
        update public.chart_cases set bed_id = b.id, owner_id = holder, state = 'assigned', assign_from = 'waiting_in_room', assigned_at = now(),
               assign_expires_at = now() + interval '60 seconds', last_at = now()
        where id = c.id;
        perform public.chart_notice(holder, format('%s moved %s to you in %s: press Got it.', public.chart_short(public.my_discord_id()), public.checkin_short_name(c.patient_name), b.label));
        oid := public.chart_order(holder, 'patient', b.id);
        update public.chart_orders set case_id = c.id where id = oid;
        nurse := holder;
      end if;
    end if;
    if nurse is null then
      update public.chart_cases set bed_id = b.id, last_at = now() where id = c.id;   -- their nurse stays
      nurse := c.owner_id;
    end if;
  end if;
  perform set_config('cbh.kids_ok', '', true);
  perform public.chart_act('patient_drop', c.id, jsonb_build_object('from_bed', c.bed_id, 'to_bed', b.id, 'from_owner', c.owner_id, 'to_owner', nurse,
          'handto_holder', p_handto_holder, 'anyway', p_anyway), r.id);
  return public.chart_done(jsonb_build_object('bed', b.id, 'nurse', nurse, 'needs_nurse', nurse is null));
end $$;

-- Supervisor: change a patient's nurse (a nurse's face dropped on the patient, or Change nurse in the record).
create or replace function public.chart_set_nurse(p_case bigint, p_person text, p_anyway boolean default false, p_pull boolean default false) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare c public.chart_cases; s public.chart_staff; oid bigint;
begin
  perform public.chart_begin(); perform public.chart_need_sup();
  select * into c from public.chart_cases x where x.id = p_case for update;
  if c.id is null or c.status <> 'open' or c.state is null then perform public.chart_err('bad_state', 'That patient has moved on: refresh.'); end if;
  if c.bed_id is null then perform public.chart_err('no_bed', format('Put %s in a bed first.', rtrim(public.checkin_short_name(c.patient_name), '.'))); end if;
  if c.owner_id = p_person then return public.chart_done(jsonb_build_object('unchanged', true)); end if;
  select * into s from public.chart_staff x where x.discord_id = p_person;
  if s.discord_id is null or (public.chart_shift_of(p_person)).id is null then perform public.chart_err('not_on_shift', format('%s isn''t on shift.', public.chart_pname(p_person))); end if;
  if s.role is distinct from 'room' then perform public.chart_err('wrong_role', format('%s isn''t working Room.', public.chart_pname(p_person))); end if;
  perform public.chart_send_check(p_person, p_anyway, p_pull);
  if public.chart_load(p_person) >= 2 then perform public.chart_err('limit', format('%s already has 2 patients.', public.chart_pname(p_person))); end if;
  if c.owner_id is not null then
    perform public.chart_notice(c.owner_id, format('%s gave %s to %s.', public.chart_short(public.my_discord_id()), public.checkin_short_name(c.patient_name), public.chart_pname(p_person)));
  end if;
  update public.chart_cases set owner_id = p_person, state = 'assigned', assign_from = 'waiting_in_room', assigned_at = now(),
         assign_expires_at = now() + interval '60 seconds', lost_nurse = false, last_at = now()
  where id = c.id;
  perform public.chart_notice(p_person, format('%s gave you %s in %s: press Got it.', public.chart_short(public.my_discord_id()), public.checkin_short_name(c.patient_name),
                              (select b.label from public.chart_beds b where b.id = c.bed_id)));
  oid := public.chart_order(p_person, 'patient', c.bed_id);
  update public.chart_orders set case_id = c.id where id = oid;
  perform public.chart_act('set_nurse', c.id, jsonb_build_object('from', c.owner_id, 'to', p_person), null, null, p_person);
  return public.chart_done(jsonb_build_object('order_id', oid));
end $$;

-- Tick: reservations of patients who arrived or left are cleared; a trauma call for an incoming patient reserves its bay.
create or replace function public.chart_reserve_sweep() returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare changed boolean := false; x record;
begin
  if not exists (select 1 from public.chart_beds b where b.reserved_for is not null)
     and not exists (select 1 from public.chart_calls c join public.chart_cases k on k.id = c.case_id
                     where c.status in ('open', 'full') and c.bed_id is not null and k.state = 'incoming') then return false; end if;
  begin
    update public.chart_beds b set reserved_for = null, reserved_at = null
    where b.reserved_for is not null
      and not exists (select 1 from public.chart_cases k where k.id = b.reserved_for and k.status = 'open' and k.state = 'incoming');
    if found then changed := true; end if;
    for x in select c.bed_id, c.case_id from public.chart_calls c join public.chart_cases k on k.id = c.case_id
             join public.chart_beds b on b.id = c.bed_id
             where c.status in ('open', 'full') and k.state = 'incoming' and k.status = 'open' and b.reserved_for is distinct from c.case_id
               and b.reserved_for is null and not exists (select 1 from public.chart_cases z where z.status = 'open' and z.bed_id = b.id) loop
      update public.chart_beds set reserved_for = null, reserved_at = null where reserved_for = x.case_id;
      update public.chart_beds set reserved_for = x.case_id, reserved_at = now() where id = x.bed_id and reserved_for is null;
      changed := true;
    end loop;
    return changed;
  exception when others then
    begin
      insert into public.chart_log (actor_name, action, detail) values ('Auto', 'reserve_error', jsonb_build_object('error', sqlerrm));
    exception when others then
      raise warning 'chart_reserve_sweep: %', sqlerrm;
    end;
    return false;
  end;
end $$;

do $g$
declare f text;
begin
  foreach f in array array['public.chart_bed_reserved(text)', 'public.chart_reserve_do(bigint,text)', 'public.chart_case_arrive(bigint)',
                           'public.chart_reserve_sweep()', 'public.chart_bed_reserve(bigint,text,boolean)',
                           'public.chart_patient_drop(bigint,text,boolean,boolean,boolean)', 'public.chart_set_nurse(bigint,text,boolean,boolean)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  foreach f in array array['public.chart_bed_reserve(bigint,text,boolean)', 'public.chart_patient_drop(bigint,text,boolean,boolean,boolean)',
                           'public.chart_set_nurse(bigint,text,boolean,boolean)'] loop
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $g$;

do $m$
declare d text; n text;
begin
  d := pg_get_functiondef('public.chart_handover(bigint,text,jsonb)'::regprocedure);
  n := replace(d, $a$  perform public.chart_act('handover', c.id);
  return public.chart_done();$a$,
                  $b$  perform public.chart_act('handover', c.id);
  return public.chart_done(public.chart_case_arrive(c.id));$b$);
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
    -- the call follows its patient to another bay (unless that bed has its own call); the team is told
    for x in select c.id, k.bed_id as to_bed, (select b.room_id from public.chart_beds b where b.id = k.bed_id) as to_room, c.started_by
             from public.chart_calls c join public.chart_cases k on k.id = c.case_id
             where c.status in ('open', 'full') and k.status = 'open' and k.bed_id is not null and c.bed_id is not null
               and (select b.room_id from public.chart_beds b where b.id = k.bed_id) is distinct from public.chart_call_room(c.bed_id, null)
               and not exists (select 1 from public.chart_calls o where o.bed_id = k.bed_id and o.id <> c.id and o.status in ('open', 'full')) loop
      update public.chart_calls set bed_id = x.to_bed where id = x.id;
      perform public.chart_notice(w, format('Trauma call moved to %s.', public.chart_room_name(x.to_room)))
      from (select x.started_by w union select m.discord_id from public.chart_call_members m where m.call_id = x.id and m.state in ('called', 'on_way', 'arrived')) y;
      insert into public.chart_log (actor_name, action, detail) values ('Auto', 'call_follow', jsonb_build_object('call', x.id, 'bed', x.to_bed));
      changed := true;
    end loop;
    -- members who clocked out
$b$);
  if n = d then raise exception '0101: call_sweep text not found'; end if;
  execute n;
  d := pg_get_functiondef('public.chart_place_ok(bigint,text,text,text,boolean)'::regprocedure);
  n := replace(d, $a$    if r.who = 'kids' and not c.child then return format('kids_only|Room %s is for children only.', r.id); end if;$a$,
                  $b$    if b.reserved_for is not null and b.reserved_for <> p_case
       and exists (select 1 from public.chart_cases z where z.id = b.reserved_for and z.status = 'open' and z.state = 'incoming') then
      return format('reserved|%s is reserved for %s.', b.label, rtrim((select public.checkin_short_name(z.patient_name) from public.chart_cases z where z.id = b.reserved_for), '.'));
    end if;
    if r.who = 'kids' and not c.child and coalesce(current_setting('cbh.kids_ok', true), '') <> 'on' then return format('kids_only|Room %s is for children only.', r.id); end if;$b$);
  if n = d then raise exception '0101: place_ok text not found'; end if;
  execute n;
  d := pg_get_functiondef('public.chart_tick()'::regprocedure);
  n := replace(d, $a$  if public.chart_sv_sweep() then changed := true; end if;$a$,
                  $b$  if public.chart_reserve_sweep() then changed := true; end if;
  if public.chart_sv_sweep() then changed := true; end if;$b$);
  if n = d then raise exception '0101: tick text not found'; end if;
  execute n;
  d := pg_get_functiondef('public.chart_poll(bigint)'::regprocedure);
  n := replace(d, $a$'away', public.chart_away(b.owner_id),$a$,
                  $b$'away', public.chart_away(b.owner_id), 'reserved', public.chart_bed_reserved(b.id),$b$);
  if n = d then raise exception '0101: poll text not found'; end if;
  execute n;
end $m$;
