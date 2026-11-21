-- Undo 0100: the patched functions go back to their 0099 text.
do $m$
declare d text; n text;
begin
  d := pg_get_functiondef('public.chart_session_end(boolean)'::regprocedure);
  n := replace(d, $b$    update public.chart_requests set cancelled_at = now(), cancel_reason = 'Session ended' where done_at is null and cancelled_at is null;
    -- freeing everyone's beds, orders, visits and asks: only for a real end (a live session, or the last person on shift)
    if public.chart_session_live() is not null or (select count(*) from public.shifts s where s.status <> 'ended') <= 1 then
      update public.chart_beds set owner_id = null, owner_since = null where owner_id is not null;
      update public.chart_orders set state = 'expired' where state in ('sent', 'seen');
      update public.chart_visits set state = 'removed', ended_at = now(), ended_by = public.my_discord_id(), end_reason = 'Session ended'
      where state in ('sent', 'on_way', 'arrived');
      update public.chart_partner_asks set state = 'cancelled', answered_at = now() where state = 'pending';
    end if;
$b$,
                  $a$    update public.chart_requests set cancelled_at = now(), cancel_reason = 'Session ended' where done_at is null and cancelled_at is null;
$a$);
  if n = d then raise exception '0100 down: session_end text not found'; end if;
  execute n;
  d := pg_get_functiondef('public.chart_sv_leave(text,text[],text,boolean)'::regprocedure);
  n := replace(d, $b$    update public.chart_cases set owner_id = p_hand_to, state = case when state = 'called' then 'assigned' else state end,
           assign_expires_at = case when state in ('assigned', 'called') then now() + interval '60 seconds' else assign_expires_at end, last_at = now()$b$,
                  $a$    update public.chart_cases set owner_id = p_hand_to,
           assign_expires_at = case when state = 'assigned' then now() + interval '60 seconds' else assign_expires_at end, last_at = now()$a$);
  if n = d then raise exception '0100 down: sv_leave text not found'; end if;
  execute n;
  d := pg_get_functiondef('public.chart_person_place(text,text,text,text,boolean,boolean,boolean,boolean,boolean,boolean)'::regprocedure);
  n := replace(d, $b$      perform public.chart_notice(b.owner_id, format('%s is now sharing %s with you.', public.chart_short(p_person), public.chart_room_name(b.room_id)));
      select * into b from public.chart_beds x where x.id = alt for update;
$b$,
                  $a$      select * into b from public.chart_beds x where x.id = alt for update;
$a$);
  if n = d then raise exception '0100 down: person_place (share) text not found'; end if;
  execute n;
  d := pg_get_functiondef('public.chart_person_place(text,text,text,text,boolean,boolean,boolean,boolean,boolean,boolean)'::regprocedure);
  n := replace(d, $b$  update public.chart_beds set owner_id = p_person, owner_since = now() where id = b.id and owner_id is null;
  -- their own request to share a room is withdrawn: the Supervisor has placed them
  perform public.chart_notice(a.holder, format('%s''s request to share %s was withdrawn: the Supervisor placed them.', public.chart_short(p_person), public.chart_room_name(a.room_id)))
  from public.chart_partner_asks a where a.asker = p_person and a.state = 'pending';
  update public.chart_partner_asks set state = 'cancelled', answered_at = now() where asker = p_person and state = 'pending';
$b$,
                  $a$  update public.chart_beds set owner_id = p_person, owner_since = now() where id = b.id and owner_id is null;
$a$);
  if n = d then raise exception '0100 down: person_place (asks) text not found'; end if;
  execute n;
  d := pg_get_functiondef('public.chart_order(text,text,text)'::regprocedure);
  n := replace(d, $b$  with older as (update public.chart_orders set state = 'expired' where person = p_person and state in ('sent', 'seen'))
  insert into public.chart_orders (person, kind, room_id, bed_id, by_id)$b$,
                  $a$  insert into public.chart_orders (person, kind, room_id, bed_id, by_id)$a$);
  if n = d then raise exception '0100 down: order text not found'; end if;
  execute n;
  d := pg_get_functiondef('public.chart_sv_sweep()'::regprocedure);
  n := replace(d, $b$format('%s didn''t answer about sharing %s: pick another bed.', public.chart_short(x.holder), public.chart_room_name(x.room_id))$b$,
                  $a$format('%s didn''t answer about sharing Room %s: pick another bed.', public.chart_short(x.holder), x.room_id)$a$);
  if n = d then raise exception '0100 down: sv_sweep (room name) text not found'; end if;
  execute n;
  d := pg_get_functiondef('public.chart_sv_sweep()'::regprocedure);
  n := replace(d, $b$    -- the patient has left (discharged, left, died, or the session closed them): their visits and request/patient orders end
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
$b$,
                  $a$    -- a visit to a patient follows them to their new room
$a$);
  if n = d then raise exception '0100 down: sv_sweep (patient left) text not found'; end if;
  execute n;
end $m$;
