-- 0099 (Bravo, 21 Nov 2026): Chart drop rules, every case (Plans/CareBeyond/chart/supervisor-v2.md §7, after the user found
-- that dropping a nurse on Max R.'s bed gave them the bed but not Max). Needs 0098 (chart_room_name).
--   chart_person_place   now also: a waiting patient with no nurse in the bed becomes P's patient (a normal assignment,
--                        order kind 'patient'); a patient who has a nurse -> has_nurse (send P to help); a bed held with no
--                        patient -> held, unless p_share (the room's other free bed, or no_free_bed) or p_swap (the holder
--                        is taken off with an 'off' order); on break -> on_break unless p_anyway (their break ends); on a
--                        trauma call -> on_trauma unless p_pull (released from the call)
--   chart_visit_send     Room staff can be sent to help where a patient has a nurse; closed room -> room_closed;
--                        p_anyway / p_pull as above
--   chart_doctor_send    an On call doctor onto a patient: an accepted doctor (or surgery) request, order kind 'request'
--   chart_orders         + case_id; kinds + 'patient', 'request'; me.order gains case_id and patient
-- §7b (the user's answers to Delta's open cases):
--   Move anyway             the patient left in the bed is flagged 'needs a nurse' (lost_nurse) and goes first in Up next
--                           (prioritised), for the Supervisor and auto-assign alike (chart_sv_leave)
--   Visits follow patients  a visit can name its patient (chart_visits.case_id; help visits find it themselves); when the
--                           patient moves to another room the visit follows, with a notice "Max R. moved to Room 106"
--                           (chart_sv_sweep). Doctor and surgery requests already follow the case.
--   Closing a room          with patients in it -> room_has_patients ("Room 104 still has patients. Move them first.");
--                           orders and visits on their way there are cancelled, with a notice to each person
--   ER map off              orders and visits to Emergency wing rooms are cancelled with notices (held beds and patients
--                           still block it: er_in_use)
-- chart_person_place and chart_visit_send get longer parameter lists, so they are replaced (dropped and created), not
-- overloaded: two versions with defaults would make the website's calls ambiguous. Old named calls keep working. The down
-- file puts back their 0097 versions exactly. chart_order_mine is patched by exact text replacement (asserted).

-- ---------- orders: a patient or a request ----------
alter table public.chart_orders add column if not exists case_id bigint;
alter table public.chart_orders drop constraint if exists chart_orders_kind_check;
alter table public.chart_orders add constraint chart_orders_kind_check check (kind in ('move', 'add', 'off', 'handover', 'patient', 'request'));

-- ---------- sending someone: on a break, or at a trauma call ----------
create or replace function public.chart_send_check(p_person text, p_anyway boolean, p_pull boolean) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare sh public.shifts := public.chart_shift_of(p_person); m record;
begin
  if sh.status = 'break' then
    if not coalesce(p_anyway, false) then perform public.chart_err('on_break', format('%s is on a break.', public.chart_pname(p_person))); end if;
    -- send anyway: their break ends (the same sum as shift_break)
    update public.shifts set status = 'active', break_seconds = break_seconds + greatest(0, extract(epoch from (now() - break_started_at))::integer),
           break_started_at = null
    where id = sh.id and status = 'break';
    perform public.chart_act('break_end', null, jsonb_build_object('by', 'supervisor'), null, null, p_person);
  end if;
  select x.id, x.call_id into m from public.chart_call_members x join public.chart_calls c on c.id = x.call_id
  where x.discord_id = p_person and x.state in ('on_way', 'arrived') and c.status in ('open', 'full') order by x.id desc limit 1;
  if m.id is not null then
    if not coalesce(p_pull, false) then
      perform public.chart_err('on_trauma', format('%s is at the trauma call at %s.', public.chart_pname(p_person), public.chart_call_where(m.call_id)));
    end if;
    update public.chart_call_members set state = 'released', released_at = now() where id = m.id;
    perform public.chart_call_refresh(m.call_id);
    perform public.chart_notice(p_person, format('%s took you off the trauma call at %s.', public.chart_short(public.my_discord_id()), public.chart_call_where(m.call_id)));
    perform public.chart_act('call_remove', null, jsonb_build_object('call', m.call_id, 'reason', 'Pulled by the Supervisor'), null, null, p_person);
  end if;
end $$;

-- ---------- chart_person_place, every bed case ----------
drop function if exists public.chart_person_place(text, text, text, text, boolean, boolean);
create function public.chart_person_place(p_person text, p_bed text, p_mode text default 'move', p_hand_to text default null,
                                          p_move_anyway boolean default false, p_override_dept boolean default false,
                                          p_share boolean default false, p_swap boolean default false,
                                          p_anyway boolean default false, p_pull boolean default false) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare s public.chart_staff; b public.chart_beds; r public.chart_rooms; c public.chart_cases; e text; old text[]; oid bigint; h text; alt text;
  res jsonb := '{}'::jsonb; kind text;
begin
  perform public.chart_begin(); perform public.chart_need_sup();
  if p_mode is null or p_mode not in ('move', 'add') then perform public.chart_err('bad_input', 'Move them, or give them this bed too.'); end if;
  select * into s from public.chart_staff x where x.discord_id = p_person;
  if s.discord_id is null or (public.chart_shift_of(p_person)).id is null then perform public.chart_err('not_on_shift', format('%s isn''t on shift.', public.chart_pname(p_person))); end if;
  if s.role is distinct from 'room' then
    perform public.chart_err('wrong_role', format('%s is working %s: send them to visit instead.', public.chart_pname(p_person),
      coalesce(case s.role when 'reception' then 'Reception' when 'on_call' then 'On call' when 'road' then 'Road' when 'supervisor' then 'as Supervisor' end, 'no role')));
  end if;
  select * into b from public.chart_beds x where x.id = p_bed for update;
  e := public.chart_place_ok(null, p_bed, null, 'own');   -- no such bed, room closed (with its reason), bed off
  if e is not null then perform public.chart_err(split_part(e, '|', 1), substr(e, strpos(e, '|') + 1)); end if;
  -- the patient in that bed, if any
  select * into c from public.chart_cases x where x.status = 'open' and x.state is not null and x.bed_id = b.id order by x.id limit 1;
  if c.id is not null and c.owner_id is not null and c.owner_id <> p_person then
    perform public.chart_err('has_nurse', format('%s in %s is %s''s patient: send %s to help instead.', public.checkin_short_name(c.patient_name), b.label,
                             public.chart_pname(c.owner_id), public.chart_pname(p_person)));
  end if;
  if b.owner_id = p_person and not (c.id is not null and c.owner_id is null and c.state = 'waiting_in_room') then
    return public.chart_done(jsonb_build_object('unchanged', true));
  end if;
  -- held by someone else with no patient of theirs in it: share or swap
  if b.owner_id is not null and b.owner_id <> p_person then
    if coalesce(p_share, false) then
      select y.id into alt from public.chart_beds y
      where y.room_id = b.room_id and y.id <> b.id and y.owner_id is null and y.available
        and not exists (select 1 from public.chart_cases z where z.status = 'open' and z.bed_id = y.id and z.owner_id is not null)
      order by y.id limit 1;
      if alt is null then perform public.chart_err('no_free_bed', format('There''s no free bed left in %s.', public.chart_room_name(b.room_id))); end if;
      select * into b from public.chart_beds x where x.id = alt for update;
      c := null;
      select * into c from public.chart_cases x where x.status = 'open' and x.state is not null and x.bed_id = b.id order by x.id limit 1;
    elsif coalesce(p_swap, false) then
      h := b.owner_id;
    else
      perform public.chart_err('held', format('%s is %s''s bed: share the room, or give the bed to %s?', b.label, public.chart_pname(b.owner_id), public.chart_pname(p_person)));
    end if;
  end if;
  perform public.chart_send_check(p_person, p_anyway, p_pull);
  select * into r from public.chart_rooms x where x.id = b.room_id;
  -- a room with no department, 'Any', or the children's rooms (Paediatric) never clashes
  if r.department is not null and r.department not in ('Any', 'Paediatric') and r.department is distinct from s.department
     and not coalesce(p_override_dept, false) then
    perform public.chart_err('dept_clash', format('%s is %s and %s is working %s.', public.chart_room_name(r.id), r.department,
                             public.chart_pname(p_person), coalesce(s.department, 'no department')));
  end if;
  if h is not null then   -- swap: the holder comes off this bed first
    perform public.chart_sv_leave(h, array[b.id], null, true);
    perform public.chart_order(h, 'off', b.id);
    perform public.chart_act('person_off', null, jsonb_build_object('beds', jsonb_build_array(b.id), 'swap_for', p_person), b.room_id, null, h);
  end if;
  if p_mode = 'add' then
    if b.owner_id is distinct from p_person and (select count(*) from public.chart_beds x where x.owner_id = p_person) >= 2 then
      perform public.chart_err('limit', format('%s already holds 2 beds.', public.chart_pname(p_person)));
    end if;
  else
    select coalesce(array_agg(x.id), '{}') into old from public.chart_beds x where x.owner_id = p_person and x.id <> b.id;
    if cardinality(old) > 0 then perform public.chart_sv_leave(p_person, old, nullif(btrim(coalesce(p_hand_to, '')), ''), coalesce(p_move_anyway, false)); end if;
  end if;
  update public.chart_beds set owner_id = p_person, owner_since = now() where id = b.id and owner_id is null;
  update public.chart_staff set offer_room_id = null where discord_id = p_person and offer_room_id is not null;
  kind := p_mode;
  -- a waiting patient with no nurse in the bed becomes theirs (a normal assignment: Got it within 60 s)
  if c.id is not null and c.owner_id is null and c.state = 'waiting_in_room' then
    if c.colour_confirmed then
      e := public.chart_place_ok(c.id, b.id, p_person, 'place', coalesce(p_override_dept, false));
      if e is not null then perform public.chart_err(split_part(e, '|', 1), substr(e, strpos(e, '|') + 1)); end if;
      perform public.chart_do_assign(c.id, b.id, p_person);
      perform public.chart_act('assign', c.id, jsonb_build_object('bed', b.id, 'person', p_person, 'team', c.team, 'drop', true), b.room_id, null, p_person);
      kind := 'patient';
      res := jsonb_build_object('patient', public.checkin_short_name(c.patient_name), 'case_id', c.id);
    else
      res := jsonb_build_object('patient_waiting', true, 'reason', 'Confirm the colour first.');
    end if;
  end if;
  oid := public.chart_order(p_person, kind, b.id);
  if kind = 'patient' then update public.chart_orders set case_id = c.id where id = oid; end if;
  perform public.chart_act('person_place', null, jsonb_build_object('bed', b.id, 'mode', p_mode, 'hand_to', p_hand_to, 'anyway', p_move_anyway,
          'override_dept', coalesce(p_override_dept, false) and r.department not in ('Any', 'Paediatric') and r.department is distinct from s.department,
          'share', p_share, 'swap', h is not null, 'patient', c.id), b.room_id, null, p_person);
  return public.chart_done(res || jsonb_build_object('order_id', oid, 'bed', b.id));
end $$;

-- ---------- visits can follow a patient; orders and visits to a closed room are called off ----------
alter table public.chart_visits add column if not exists case_id bigint;

-- A room closed (or the Emergency wing switched off): orders and visits on their way there stop, and each person is told.
create or replace function public.chart_room_cancel(p_room text, p_er boolean default false) returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare x record; n int := 0; msg text;
begin
  msg := case when p_er then format('The Emergency wing was closed: you''re no longer needed in %s.', public.chart_room_name(p_room))
              else format('%s was closed: you''re no longer needed there.', public.chart_room_name(p_room)) end;
  for x in select v.id, v.person from public.chart_visits v where v.room_id = p_room and v.state in ('sent', 'on_way', 'arrived') loop
    update public.chart_visits set state = 'removed', ended_at = now(), ended_by = public.my_discord_id(),
           end_reason = case when p_er then 'Emergency wing closed' else 'Room closed' end
    where id = x.id;
    perform public.chart_notice(x.person, msg);
    n := n + 1;
  end loop;
  for x in select o.id, o.person from public.chart_orders o where o.room_id = p_room and o.state in ('sent', 'seen') and o.kind <> 'off' loop
    update public.chart_orders set state = 'expired' where id = x.id;
    perform public.chart_notice(x.person, msg);
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public.chart_room_cancel(text, boolean) from public, anon, authenticated;
grant execute on function public.chart_room_cancel(text, boolean) to service_role;

-- ---------- chart_visit_send: helpers, closed rooms, break and trauma ----------
drop function if exists public.chart_visit_send(text, text, text, text);
create function public.chart_visit_send(p_person text, p_room text, p_reason text, p_note text default null,
                                        p_anyway boolean default false, p_pull boolean default false, p_case bigint default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare r public.chart_rooms; note text := nullif(btrim(coalesce(p_note, '')), ''); vid bigint; role text; cid bigint := p_case; rm text := p_room;
begin
  perform public.chart_begin(); perform public.chart_need_sup();
  if (public.chart_shift_of(p_person)).id is null then perform public.chart_err('not_on_shift', format('%s isn''t on shift.', public.chart_pname(p_person))); end if;
  role := coalesce((select s.role from public.chart_staff s where s.discord_id = p_person), '');
  -- a visit to a patient goes to the room their bed is in (and follows them if they move)
  if cid is not null then
    select b.room_id into rm from public.chart_cases c join public.chart_beds b on b.id = c.bed_id where c.id = cid and c.status = 'open';
    if rm is null then perform public.chart_err('bad_state', 'That patient isn''t in a bed now: refresh.'); end if;
  end if;
  select * into r from public.chart_rooms x where x.id = rm;
  if r.id is null then perform public.chart_err('bad_input', 'Pick a room.'); end if;
  if not r.active or r.closed then perform public.chart_err('room_closed', format('%s is closed: %s', public.chart_room_name(r.id), coalesce(r.closed_reason, 'out of use'))); end if;
  -- admins, executives, Directors and On call; Room staff only to help where a patient has a nurse
  if public.chart_admin_kind(p_person) is null and role <> 'on_call'
     and not (role = 'room' and p_reason = 'help' and exists (select 1 from public.chart_cases c join public.chart_beds b on b.id = c.bed_id
                                                            where b.room_id = r.id and c.status = 'open' and c.owner_id is not null)) then
    perform public.chart_err('wrong_role', 'Only admins, executives, Directors and On call doctors can be sent to visit (Room staff only to help with a patient).');
  end if;
  if p_reason is null or p_reason not in ('help', 'complaint', 'check_staff', 'second_opinion', 'medical', 'custom') then
    perform public.chart_err('bad_input', 'Pick a reason.');
  end if;
  if p_reason = 'custom' and note is null then perform public.chart_err('bad_input', 'Type the message.'); end if;
  if char_length(coalesce(note, '')) > 120 then perform public.chart_err('bad_input', 'Keep the message to 120 characters.'); end if;
  perform public.chart_send_check(p_person, p_anyway, p_pull);
  -- a new visit replaces one they're already on
  update public.chart_visits set state = 'removed', ended_at = now(), ended_by = public.my_discord_id(), end_reason = 'Sent somewhere else'
  where person = p_person and state in ('sent', 'on_way', 'arrived');
  -- a help visit without a named patient helps the room's patient who has a nurse (so it can follow them)
  if cid is null and p_reason = 'help' then
    select c.id into cid from public.chart_cases c join public.chart_beds b on b.id = c.bed_id
    where b.room_id = r.id and c.status = 'open' and c.owner_id is not null order by c.id limit 1;
  end if;
  insert into public.chart_visits (person, room_id, reason, note, by_id, case_id) values (p_person, r.id, p_reason, note, public.my_discord_id(), cid) returning id into vid;
  perform public.chart_act('visit_send', cid, jsonb_build_object('visit', vid, 'reason', p_reason, 'note', note), r.id, null, p_person);
  return public.chart_done(jsonb_build_object('visit_id', vid));
end $$;

-- ---------- an On call doctor onto a patient ----------
create or replace function public.chart_doctor_send(p_person text, p_case bigint, p_anyway boolean default false, p_pull boolean default false) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare s public.chart_staff; c public.chart_cases; k text; q public.chart_requests; rid bigint; oid bigint;
begin
  perform public.chart_begin(); perform public.chart_need_sup();
  select * into s from public.chart_staff x where x.discord_id = p_person;
  if s.discord_id is null or (public.chart_shift_of(p_person)).id is null then perform public.chart_err('not_on_shift', format('%s isn''t on shift.', public.chart_pname(p_person))); end if;
  if s.role is distinct from 'on_call' then
    perform public.chart_err('wrong_role', format('%s isn''t working On call: place them, or send them to visit.', public.chart_pname(p_person)));
  end if;
  select * into c from public.chart_cases x where x.id = p_case;
  if c.id is null or c.status <> 'open' or c.state is null then perform public.chart_err('bad_state', 'That patient has moved on: refresh.'); end if;
  perform public.chart_send_check(p_person, p_anyway, p_pull);
  k := case when s.department = 'Surgical' then 'surgery' else 'doctor' end;
  -- an open request of that kind is taken over rather than doubled
  select * into q from public.chart_requests x where x.case_id = c.id and x.kind = k and x.done_at is null and x.cancelled_at is null order by x.id limit 1 for update;
  if q.id is not null then
    if q.accepted_by is not null and q.accepted_by <> p_person then
      perform public.chart_notice(q.accepted_by, format('%s sent %s to %s instead of you.', public.chart_short(public.my_discord_id()), public.chart_short(p_person),
                                  public.checkin_short_name(c.patient_name)));
    end if;
    update public.chart_requests set accepted_by = p_person, accepted_at = coalesce(case when accepted_by = p_person then accepted_at end, now()),
           sent_to = p_person, sent_by = public.my_discord_id(), here_at = case when accepted_by = p_person then here_at end
    where id = q.id;
    rid := q.id;
  else
    insert into public.chart_requests (case_id, kind, surgery_mode, red, asked_by, sent_to, sent_by, accepted_by, accepted_at)
    values (c.id, k, case when k = 'surgery' then 'come_down' end, c.esi = 1, public.my_discord_id(), p_person, public.my_discord_id(), p_person, now())
    returning id into rid;
  end if;
  update public.chart_staff set ready = false, ready_since = null where discord_id = p_person and ready;
  oid := public.chart_order(p_person, 'request', c.bed_id);
  update public.chart_orders set case_id = c.id where id = oid;
  perform public.chart_act('doctor_send', c.id, jsonb_build_object('request', rid, 'kind', k), null, rid, p_person);
  return public.chart_done(jsonb_build_object('request_id', rid, 'order_id', oid));
end $$;

-- ---------- grants ----------
revoke execute on function public.chart_send_check(text, boolean, boolean) from public, anon, authenticated;
grant execute on function public.chart_send_check(text, boolean, boolean) to service_role;
revoke execute on function public.chart_person_place(text, text, text, text, boolean, boolean, boolean, boolean, boolean, boolean) from public, anon, authenticated;
grant execute on function public.chart_person_place(text, text, text, text, boolean, boolean, boolean, boolean, boolean, boolean) to service_role, authenticated;
revoke execute on function public.chart_visit_send(text, text, text, text, boolean, boolean, bigint) from public, anon, authenticated;
grant execute on function public.chart_visit_send(text, text, text, text, boolean, boolean, bigint) to service_role, authenticated;
revoke execute on function public.chart_doctor_send(text, bigint, boolean, boolean) from public, anon, authenticated;
grant execute on function public.chart_doctor_send(text, bigint, boolean, boolean) to service_role, authenticated;

-- ---------- me.order: the patient ----------
do $m$
declare d text; n text;
begin
  d := pg_get_functiondef('public.chart_order_mine(text)'::regprocedure);
  n := replace(d, $a$'by_name', public.chart_short(o.by_id), 'at', o.at, 'state', o.state)$a$,
                  $b$'by_name', public.chart_short(o.by_id), 'at', o.at, 'state', o.state, 'case_id', o.case_id,
         'patient', (select public.checkin_short_name(x.patient_name) from public.chart_cases x where x.id = o.case_id))$b$);
  if n = d then raise exception '0099: chart_order_mine text not found'; end if;
  execute n;

  -- §7b
  d := pg_get_functiondef('public.chart_sv_leave(text,text[],text,boolean)'::regprocedure);
  n := replace(d, $a$handback_note = 'Their nurse was moved by the Supervisor', handed_back_by = p_person,$a$,
                  $b$handback_note = 'Their nurse was moved by the Supervisor', handed_back_by = p_person, lost_nurse = true, prioritised = true,$b$);
  if n = d then raise exception '0099: chart_sv_leave text not found'; end if;
  execute n;
  d := pg_get_functiondef('public.chart_sv_sweep()'::regprocedure);
  n := replace(d, $a$    update public.chart_orders o set state = 'expired' where o.state in ('sent', 'seen') and (public.chart_shift_of(o.person)).id is null;$a$,
                  $b$    -- a visit to a patient follows them to their new room
    for x in select v.id, v.person, b.room_id as now_room, c.patient_name from public.chart_visits v
               join public.chart_cases c on c.id = v.case_id join public.chart_beds b on b.id = c.bed_id
             where v.state in ('sent', 'on_way', 'arrived') and c.status = 'open' and b.room_id is distinct from v.room_id loop
      update public.chart_visits set room_id = x.now_room where id = x.id;
      perform public.chart_notice(x.person, format('%s moved to %s.', public.checkin_short_name(x.patient_name), public.chart_room_name(x.now_room)));
      changed := true;
    end loop;
    update public.chart_orders o set state = 'expired' where o.state in ('sent', 'seen') and (public.chart_shift_of(o.person)).id is null;$b$);
  if n = d then raise exception '0099: chart_sv_sweep text not found'; end if;
  execute n;
  d := pg_get_functiondef('public.chart_room_guard()'::regprocedure);
  n := replace(d, $a$      perform public.chart_err('room_in_use', 'Move the patients out of the room first.');$a$,
                  $b$      perform public.chart_err('room_has_patients', format('%s still has patients. Move them first.', public.chart_room_name(new.id)));$b$);
  if n = d then raise exception '0099: chart_room_guard text not found'; end if;
  execute n;
  d := pg_get_functiondef('public.chart_room_set(text,text,text,boolean,text)'::regprocedure);
  n := replace(d, $a$  perform public.chart_act('room_set', null,$a$,
                  $b$  if p_closed and not r.closed then perform public.chart_room_cancel(r.id); end if;
  perform public.chart_act('room_set', null,$b$);
  if n = d then raise exception '0099: chart_room_set text not found'; end if;
  execute n;
  d := pg_get_functiondef('public.chart_map_apply(text)'::regprocedure);
  n := replace(d, $a$    update public.chart_staff set offer_room_id = null
    where offer_room_id in (select r.id from public.chart_rooms r where r.wing = 'er');$a$,
                  $b$    update public.chart_staff set offer_room_id = null
    where offer_room_id in (select r.id from public.chart_rooms r where r.wing = 'er');
    perform public.chart_room_cancel(r.id, true) from public.chart_rooms r where r.wing = 'er' and r.active;$b$);
  if n = d then raise exception '0099: chart_map_apply text not found'; end if;
  execute n;
end $m$;
