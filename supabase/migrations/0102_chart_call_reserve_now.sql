-- 0102 (Bravo, 21 Nov 2026): Delta's run: a trauma call started for an incoming patient didn't show its bay as Reserved on
-- the plan. The reservation was only made by chart_reserve_sweep in the tick (throttled to every 2 s, and frozen inside a
-- single transaction), so it could lag. Now chart_call_start and chart_call_place (tying an incoming patient) reserve the
-- bay at once through chart_call_reserve; the sweep stays as the backstop. Additive: one helper and two exact text
-- replacements (asserted), reversed by the down file.

-- A trauma call for an incoming patient reserves its bay straight away (the tick's sweep was the only place it happened,
-- so a reservation could take a poll or two to appear). Never raises: if the bay bed is taken or reserved for someone
-- else, nothing happens (the sweep keeps trying).
create or replace function public.chart_call_reserve(p_call bigint) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare c public.chart_calls;
begin
  select * into c from public.chart_calls x where x.id = p_call;
  if c.id is null or c.case_id is null or c.bed_id is null or c.status not in ('open', 'full') then return false; end if;
  if not exists (select 1 from public.chart_cases k where k.id = c.case_id and k.status = 'open' and k.state = 'incoming') then return false; end if;
  if exists (select 1 from public.chart_cases z where z.status = 'open' and z.bed_id = c.bed_id) then return false; end if;
  if exists (select 1 from public.chart_beds b join public.chart_cases z on z.id = b.reserved_for
             where b.id = c.bed_id and b.reserved_for <> c.case_id and z.status = 'open' and z.state = 'incoming') then return false; end if;
  update public.chart_beds set reserved_for = null, reserved_at = null where reserved_for = c.case_id and id <> c.bed_id;
  update public.chart_beds set reserved_for = c.case_id, reserved_at = now() where id = c.bed_id and reserved_for is distinct from c.case_id;
  return true;
end $$;
revoke execute on function public.chart_call_reserve(bigint) from public, anon, authenticated;
grant execute on function public.chart_call_reserve(bigint) to service_role;

do $m$
declare d text; n text;
begin
  d := pg_get_functiondef('public.chart_call_start(bigint,text,jsonb,jsonb,text)'::regprocedure);
  n := replace(d, $a$  perform public.chart_act('call_start', p_case,$a$,
                  $b$  perform public.chart_call_reserve(cid);   -- an incoming patient's bay is reserved now
  perform public.chart_act('call_start', p_case,$b$);
  if n = d then raise exception '0102: call_start text not found'; end if;
  execute n;
  d := pg_get_functiondef('public.chart_call_place(bigint,bigint)'::regprocedure);
  n := replace(d, $a$    perform public.chart_act('call_link', k.id, jsonb_build_object('call', c.id));$a$,
                  $b$    perform public.chart_call_reserve(c.id);   -- their bay is reserved now
    perform public.chart_act('call_link', k.id, jsonb_build_object('call', c.id));$b$);
  if n = d then raise exception '0102: call_place text not found'; end if;
  execute n;
end $m$;
