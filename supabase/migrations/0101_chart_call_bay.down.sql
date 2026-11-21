-- Undo 0101: the patched functions go back to their 0100 text, then the helpers go.
do $m$
declare d text; n text;
begin
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
  return public.chart_done(public.chart_call_arrive(c.id));$b$,
                  $a$  perform public.chart_act('handover', c.id);
  return public.chart_done();$a$);
  if n = d then raise exception '0101 down: handover text not found'; end if;
  execute n;
end $m$;

drop function if exists public.chart_call_place(bigint, bigint);
drop function if exists public.chart_call_arrive(bigint);
drop function if exists public.chart_call_seat(bigint, bigint);
drop function if exists public.chart_call_nurse(bigint);
