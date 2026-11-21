-- Undo 0099: chart_person_place and chart_visit_send go back to their 0097 versions exactly, chart_doctor_send and
-- chart_send_check go, me.order loses the patient, and orders of the new kinds are removed. Run before 0098.down.
do $m$
declare d text; n text;
begin
  d := pg_get_functiondef('public.chart_order_mine(text)'::regprocedure);
  n := replace(d, $b$'by_name', public.chart_short(o.by_id), 'at', o.at, 'state', o.state, 'case_id', o.case_id,
         'patient', (select public.checkin_short_name(x.patient_name) from public.chart_cases x where x.id = o.case_id))$b$,
                  $a$'by_name', public.chart_short(o.by_id), 'at', o.at, 'state', o.state)$a$);
  if n = d then raise exception '0099 down: chart_order_mine text not found'; end if;
  execute n;
  d := pg_get_functiondef('public.chart_sv_leave(text,text[],text,boolean)'::regprocedure);
  n := replace(d, $b$handback_note = 'Their nurse was moved by the Supervisor', handed_back_by = p_person, lost_nurse = true, prioritised = true,$b$,
                  $a$handback_note = 'Their nurse was moved by the Supervisor', handed_back_by = p_person,$a$);
  if n = d then raise exception '0099 down: chart_sv_leave text not found'; end if;
  execute n;
  d := pg_get_functiondef('public.chart_sv_sweep()'::regprocedure);
  n := replace(d, $b$    -- a visit to a patient follows them to their new room
    for x in select v.id, v.person, b.room_id as now_room, c.patient_name from public.chart_visits v
               join public.chart_cases c on c.id = v.case_id join public.chart_beds b on b.id = c.bed_id
             where v.state in ('sent', 'on_way', 'arrived') and c.status = 'open' and b.room_id is distinct from v.room_id loop
      update public.chart_visits set room_id = x.now_room where id = x.id;
      perform public.chart_notice(x.person, format('%s moved to %s.', public.checkin_short_name(x.patient_name), public.chart_room_name(x.now_room)));
      changed := true;
    end loop;
    update public.chart_orders o set state = 'expired' where o.state in ('sent', 'seen') and (public.chart_shift_of(o.person)).id is null;$b$,
                  $a$    update public.chart_orders o set state = 'expired' where o.state in ('sent', 'seen') and (public.chart_shift_of(o.person)).id is null;$a$);
  if n = d then raise exception '0099 down: chart_sv_sweep text not found'; end if;
  execute n;
  d := pg_get_functiondef('public.chart_room_guard()'::regprocedure);
  n := replace(d, $b$      perform public.chart_err('room_has_patients', format('%s still has patients. Move them first.', public.chart_room_name(new.id)));$b$,
                  $a$      perform public.chart_err('room_in_use', 'Move the patients out of the room first.');$a$);
  if n = d then raise exception '0099 down: chart_room_guard text not found'; end if;
  execute n;
  d := pg_get_functiondef('public.chart_room_set(text,text,text,boolean,text)'::regprocedure);
  n := replace(d, $b$  if p_closed and not r.closed then perform public.chart_room_cancel(r.id); end if;
  perform public.chart_act('room_set', null,$b$,
                  $a$  perform public.chart_act('room_set', null,$a$);
  if n = d then raise exception '0099 down: chart_room_set text not found'; end if;
  execute n;
  d := pg_get_functiondef('public.chart_map_apply(text)'::regprocedure);
  n := replace(d, $b$    update public.chart_staff set offer_room_id = null
    where offer_room_id in (select r.id from public.chart_rooms r where r.wing = 'er');
    perform public.chart_room_cancel(r.id, true) from public.chart_rooms r where r.wing = 'er' and r.active;$b$,
                  $a$    update public.chart_staff set offer_room_id = null
    where offer_room_id in (select r.id from public.chart_rooms r where r.wing = 'er');$a$);
  if n = d then raise exception '0099 down: chart_map_apply text not found'; end if;
  execute n;
end $m$;

drop function if exists public.chart_doctor_send(text, bigint, boolean, boolean);
drop function if exists public.chart_person_place(text, text, text, text, boolean, boolean, boolean, boolean, boolean, boolean);
drop function if exists public.chart_visit_send(text, text, text, text, boolean, boolean, bigint);
drop function if exists public.chart_room_cancel(text, boolean);
drop function if exists public.chart_send_check(text, boolean, boolean);

create or replace function public.chart_person_place(p_person text, p_bed text, p_mode text default 'move', p_hand_to text default null,
                                                     p_move_anyway boolean default false, p_override_dept boolean default false) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare s public.chart_staff; b public.chart_beds; r public.chart_rooms; e text; old text[]; oid bigint;
begin
  perform public.chart_begin(); perform public.chart_need_sup();
  if p_mode is null or p_mode not in ('move', 'add') then perform public.chart_err('bad_input', 'Move them, or give them this bed too.'); end if;
  select * into s from public.chart_staff x where x.discord_id = p_person;
  if s.discord_id is null or (public.chart_shift_of(p_person)).id is null then perform public.chart_err('not_on_shift', format('%s isn''t on shift.', public.chart_pname(p_person))); end if;
  if s.role is distinct from 'room' then
    perform public.chart_err('wrong_role', format('%s is working %s: send them to visit instead.', public.chart_pname(p_person),
      coalesce(case s.role when 'reception' then 'Reception' when 'on_call' then 'On call' when 'road' then 'Road' when 'supervisor' then 'as Supervisor' end, 'no role')));
  end if;
  if public.chart_on_break(p_person) then perform public.chart_err('wrong_role', format('%s is on a break.', public.chart_pname(p_person))); end if;
  select * into b from public.chart_beds x where x.id = p_bed for update;
  e := public.chart_place_ok(null, p_bed, null, 'own');
  if e is not null then perform public.chart_err(split_part(e, '|', 1), substr(e, strpos(e, '|') + 1)); end if;
  if b.owner_id = p_person then return public.chart_done(jsonb_build_object('unchanged', true)); end if;
  if b.owner_id is not null then perform public.chart_err('not_bed_owner', format('%s is %s''s bed: take them off it first.', b.label, public.chart_pname(b.owner_id))); end if;
  select * into r from public.chart_rooms x where x.id = b.room_id;
  -- a room with no department, 'Any', or the children's rooms (Paediatric) never clashes, so it's never re-departmented
  if r.department is not null and r.department not in ('Any', 'Paediatric') and r.department is distinct from s.department
     and not coalesce(p_override_dept, false) then
    perform public.chart_err('dept_clash', format('Room %s is %s and %s is working %s.', r.id, coalesce(r.department, 'no department'),
                             public.chart_pname(p_person), coalesce(s.department, 'no department')));
  end if;
  if p_mode = 'add' then
    if (select count(*) from public.chart_beds x where x.owner_id = p_person) >= 2 then
      perform public.chart_err('limit', format('%s already holds 2 beds.', public.chart_pname(p_person)));
    end if;
  else
    select coalesce(array_agg(x.id), '{}') into old from public.chart_beds x where x.owner_id = p_person;
    if cardinality(old) > 0 then perform public.chart_sv_leave(p_person, old, nullif(btrim(coalesce(p_hand_to, '')), ''), coalesce(p_move_anyway, false)); end if;
  end if;
  update public.chart_beds set owner_id = p_person, owner_since = now() where id = b.id and owner_id is null;
  update public.chart_staff set offer_room_id = null where discord_id = p_person and offer_room_id is not null;
  oid := public.chart_order(p_person, p_mode, b.id);
  perform public.chart_act('person_place', null, jsonb_build_object('bed', b.id, 'mode', p_mode, 'hand_to', p_hand_to, 'anyway', p_move_anyway,
          'override_dept', coalesce(p_override_dept, false) and r.department not in ('Any', 'Paediatric') and r.department is distinct from s.department), b.room_id, null, p_person);
  return public.chart_done(jsonb_build_object('order_id', oid));
end $$;

create or replace function public.chart_visit_send(p_person text, p_room text, p_reason text, p_note text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare r public.chart_rooms; note text := nullif(btrim(coalesce(p_note, '')), ''); vid bigint;
begin
  perform public.chart_begin(); perform public.chart_need_sup();
  if (public.chart_shift_of(p_person)).id is null then perform public.chart_err('not_on_shift', format('%s isn''t on shift.', public.chart_pname(p_person))); end if;
  if public.chart_admin_kind(p_person) is null
     and coalesce((select s.role from public.chart_staff s where s.discord_id = p_person), '') <> 'on_call' then
    perform public.chart_err('wrong_role', 'Only admins, executives, Directors and On call doctors can be sent to visit.');
  end if;
  select * into r from public.chart_rooms x where x.id = p_room;
  if r.id is null or not r.active then perform public.chart_err('bad_input', 'Pick a room.'); end if;
  if p_reason is null or p_reason not in ('help', 'complaint', 'check_staff', 'second_opinion', 'medical', 'custom') then
    perform public.chart_err('bad_input', 'Pick a reason.');
  end if;
  if p_reason = 'custom' and note is null then perform public.chart_err('bad_input', 'Type the message.'); end if;
  if char_length(coalesce(note, '')) > 120 then perform public.chart_err('bad_input', 'Keep the message to 120 characters.'); end if;
  -- a new visit replaces one they're already on
  update public.chart_visits set state = 'removed', ended_at = now(), ended_by = public.my_discord_id(), end_reason = 'Sent somewhere else'
  where person = p_person and state in ('sent', 'on_way', 'arrived');
  insert into public.chart_visits (person, room_id, reason, note, by_id) values (p_person, r.id, p_reason, note, public.my_discord_id()) returning id into vid;
  perform public.chart_act('visit_send', null, jsonb_build_object('visit', vid, 'reason', p_reason, 'note', note), r.id, null, p_person);
  return public.chart_done(jsonb_build_object('visit_id', vid));
end $$;

revoke execute on function public.chart_person_place(text, text, text, text, boolean, boolean) from public, anon, authenticated;
grant execute on function public.chart_person_place(text, text, text, text, boolean, boolean) to service_role, authenticated;
revoke execute on function public.chart_visit_send(text, text, text, text) from public, anon, authenticated;
grant execute on function public.chart_visit_send(text, text, text, text) to service_role, authenticated;

delete from public.chart_orders where kind in ('patient', 'request');
alter table public.chart_orders drop constraint if exists chart_orders_kind_check;
alter table public.chart_orders add constraint chart_orders_kind_check check (kind in ('move', 'add', 'off', 'handover'));
alter table public.chart_orders drop column if exists case_id;
alter table public.chart_visits drop column if exists case_id;
