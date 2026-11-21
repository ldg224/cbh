-- Undo 0101: the patched functions go back to their 0100 text, then the new functions and columns go.
do $m$
declare d text; n text;
begin
  d := pg_get_functiondef('public.chart_poll(bigint)'::regprocedure);
  n := replace(d, $b$'away', public.chart_away(b.owner_id), 'reserved', public.chart_bed_reserved(b.id),$b$,
                  $a$'away', public.chart_away(b.owner_id),$a$);
  if n = d then raise exception '0101 down: poll text not found'; end if;
  execute n;
  d := pg_get_functiondef('public.chart_tick()'::regprocedure);
  n := replace(d, $b$  if public.chart_reserve_sweep() then changed := true; end if;
  if public.chart_sv_sweep() then changed := true; end if;$b$,
                  $a$  if public.chart_sv_sweep() then changed := true; end if;$a$);
  if n = d then raise exception '0101 down: tick text not found'; end if;
  execute n;
  d := pg_get_functiondef('public.chart_place_ok(bigint,text,text,text,boolean)'::regprocedure);
  n := replace(d, $b$    if b.reserved_for is not null and b.reserved_for <> p_case
       and exists (select 1 from public.chart_cases z where z.id = b.reserved_for and z.status = 'open' and z.state = 'incoming') then
      return format('reserved|%s is reserved for %s.', b.label, rtrim((select public.checkin_short_name(z.patient_name) from public.chart_cases z where z.id = b.reserved_for), '.'));
    end if;
    if r.who = 'kids' and not c.child and coalesce(current_setting('cbh.kids_ok', true), '') <> 'on' then return format('kids_only|Room %s is for children only.', r.id); end if;$b$,
                  $a$    if r.who = 'kids' and not c.child then return format('kids_only|Room %s is for children only.', r.id); end if;$a$);
  if n = d then raise exception '0101 down: place_ok text not found'; end if;
  execute n;
  d := pg_get_functiondef('public.chart_call_sweep()'::regprocedure);
  n := replace(d, $b$    -- a call on a bay with no patient yet: the patient placed in that bay becomes the call's patient
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
$b$,
                  $a$    -- members who clocked out
$a$);
  if n = d then raise exception '0101 down: call_sweep text not found'; end if;
  execute n;
  d := pg_get_functiondef('public.chart_call_arrived(bigint,text)'::regprocedure);
  n := replace(d, $b$  perform public.chart_call_nurse(c.id);   -- the first Nursing member to arrive takes a nurse-less patient in the bay
  perform public.chart_act('call_arrived', c.case_id,$b$,
                  $a$  perform public.chart_act('call_arrived', c.case_id,$a$);
  if n = d then raise exception '0101 down: call_arrived text not found'; end if;
  execute n;
  d := pg_get_functiondef('public.chart_handover(bigint,text,jsonb)'::regprocedure);
  n := replace(d, $b$  perform public.chart_act('handover', c.id);
  return public.chart_done(public.chart_case_arrive(c.id));$b$,
                  $a$  perform public.chart_act('handover', c.id);
  return public.chart_done();$a$);
  if n = d then raise exception '0101 down: handover text not found'; end if;
  execute n;
end $m$;

drop function if exists public.chart_set_nurse(bigint, text, boolean, boolean);
drop function if exists public.chart_patient_drop(bigint, text, boolean, boolean, boolean);
drop function if exists public.chart_bed_reserve(bigint, text, boolean);
drop function if exists public.chart_reserve_sweep();
drop function if exists public.chart_case_arrive(bigint);
drop function if exists public.chart_reserve_do(bigint, text);
drop function if exists public.chart_bed_reserved(text);
drop function if exists public.chart_call_place(bigint, bigint);
drop function if exists public.chart_call_arrive(bigint);
drop function if exists public.chart_call_seat(bigint, bigint);
drop function if exists public.chart_call_nurse(bigint);
alter table public.chart_beds drop column if exists reserved_at;
alter table public.chart_beds drop column if exists reserved_for;
