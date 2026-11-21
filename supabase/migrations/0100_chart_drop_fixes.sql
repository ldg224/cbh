-- 0100 (Bravo, 21 Nov 2026): fixes from Delta's drop-checklist run on live 0098/0099, with Charlie's rulings. Additive:
-- exact text replacements on live functions (asserted), each reversed by the down file.
--   C7   a patient who leaves (discharge, left, death, session) ends the visits and request/patient orders tied to them,
--        with a notice "Max R. has left: you're no longer needed." (chart_sv_sweep; their requests already close)
--   C3   only the newest Supervisor order stands: a new one expires the person's older pending orders (chart_order)
--   B5   a Supervisor placement withdraws the person's own pending partner ask, telling the bed holder (chart_person_place)
--   A3   a patient handed over while being fetched ('called') goes back to 'assigned' with a fresh 60 s, so the new nurse's
--        Got it works (chart_sv_leave); a patient already in care stays in care
--   B11  End session with close-all also frees held beds and ends orders, visits and partner asks (chart_session_end)
--   nits the holder is told when someone shares their room; the partner-ask expiry notice uses the room's display name
-- C10/Q6: no change (closing a room someone holds a bed in stays refused, room_owned).
do $m$
declare d text; n text;
begin
  d := pg_get_functiondef('public.chart_sv_sweep()'::regprocedure);
  n := replace(d, $a$    -- a visit to a patient follows them to their new room
$a$,
                  $b$    -- the patient has left (discharged, left, died, or the session closed them): their visits and request/patient orders end
    for x in select v.id, v.person, c.patient_name from public.chart_visits v join public.chart_cases c on c.id = v.case_id
             where v.state in ('sent', 'on_way', 'arrived') and c.status <> 'open' loop
      update public.chart_visits set state = 'removed', ended_at = now(), end_reason = 'Patient left' where id = x.id;
      perform public.chart_notice(x.person, format('%s has left: you''re no longer needed.', public.checkin_short_name(x.patient_name)));
      changed := true;
    end loop;
    for x in select o.id, o.person, c.patient_name from public.chart_orders o join public.chart_cases c on c.id = o.case_id
             where o.state in ('sent', 'seen') and o.kind in ('request', 'patient') and c.status <> 'open' loop
      update public.chart_orders set state = 'expired' where id = x.id;
      perform public.chart_notice(x.person, format('%s has left: you''re no longer needed.', public.checkin_short_name(x.patient_name)));
      changed := true;
    end loop;
    -- a visit to a patient follows them to their new room
$b$);
  if n = d then raise exception '0100: sv_sweep (patient left) text not found'; end if;
  execute n;
  d := pg_get_functiondef('public.chart_sv_sweep()'::regprocedure);
  n := replace(d, $a$format('%s didn''t answer about sharing Room %s: pick another bed.', public.chart_short(x.holder), x.room_id)$a$,
                  $b$format('%s didn''t answer about sharing %s: pick another bed.', public.chart_short(x.holder), public.chart_room_name(x.room_id))$b$);
  if n = d then raise exception '0100: sv_sweep (room name) text not found'; end if;
  execute n;
  d := pg_get_functiondef('public.chart_order(text,text,text)'::regprocedure);
  n := replace(d, $a$  insert into public.chart_orders (person, kind, room_id, bed_id, by_id)$a$,
                  $b$  with older as (update public.chart_orders set state = 'expired' where person = p_person and state in ('sent', 'seen'))
  insert into public.chart_orders (person, kind, room_id, bed_id, by_id)$b$);
  if n = d then raise exception '0100: order text not found'; end if;
  execute n;
  d := pg_get_functiondef('public.chart_person_place(text,text,text,text,boolean,boolean,boolean,boolean,boolean,boolean)'::regprocedure);
  n := replace(d, $a$  update public.chart_beds set owner_id = p_person, owner_since = now() where id = b.id and owner_id is null;
$a$,
                  $b$  update public.chart_beds set owner_id = p_person, owner_since = now() where id = b.id and owner_id is null;
  -- their own request to share a room is withdrawn: the Supervisor has placed them
  perform public.chart_notice(a.holder, format('%s''s request to share %s was withdrawn: the Supervisor placed them.', public.chart_short(p_person), public.chart_room_name(a.room_id)))
  from public.chart_partner_asks a where a.asker = p_person and a.state = 'pending';
  update public.chart_partner_asks set state = 'cancelled', answered_at = now() where asker = p_person and state = 'pending';
$b$);
  if n = d then raise exception '0100: person_place (asks) text not found'; end if;
  execute n;
  d := pg_get_functiondef('public.chart_person_place(text,text,text,text,boolean,boolean,boolean,boolean,boolean,boolean)'::regprocedure);
  n := replace(d, $a$      select * into b from public.chart_beds x where x.id = alt for update;
$a$,
                  $b$      perform public.chart_notice(b.owner_id, format('%s is now sharing %s with you.', public.chart_short(p_person), public.chart_room_name(b.room_id)));
      select * into b from public.chart_beds x where x.id = alt for update;
$b$);
  if n = d then raise exception '0100: person_place (share) text not found'; end if;
  execute n;
  d := pg_get_functiondef('public.chart_sv_leave(text,text[],text,boolean)'::regprocedure);
  n := replace(d, $a$    update public.chart_cases set owner_id = p_hand_to,
           assign_expires_at = case when state = 'assigned' then now() + interval '60 seconds' else assign_expires_at end, last_at = now()$a$,
                  $b$    update public.chart_cases set owner_id = p_hand_to, state = case when state = 'called' then 'assigned' else state end,
           assign_expires_at = case when state in ('assigned', 'called') then now() + interval '60 seconds' else assign_expires_at end, last_at = now()$b$);
  if n = d then raise exception '0100: sv_leave text not found'; end if;
  execute n;
  d := pg_get_functiondef('public.chart_session_end(boolean)'::regprocedure);
  n := replace(d, $a$    update public.chart_requests set cancelled_at = now(), cancel_reason = 'Session ended' where done_at is null and cancelled_at is null;
$a$,
                  $b$    update public.chart_requests set cancelled_at = now(), cancel_reason = 'Session ended' where done_at is null and cancelled_at is null;
    update public.chart_beds set owner_id = null, owner_since = null where owner_id is not null;
    update public.chart_orders set state = 'expired' where state in ('sent', 'seen');
    update public.chart_visits set state = 'removed', ended_at = now(), ended_by = public.my_discord_id(), end_reason = 'Session ended'
    where state in ('sent', 'on_way', 'arrived');
    update public.chart_partner_asks set state = 'cancelled', answered_at = now() where state = 'pending';
$b$);
  if n = d then raise exception '0100: session_end text not found'; end if;
  execute n;
end $m$;
