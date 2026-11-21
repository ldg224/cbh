-- Undo 0102.
do $m$
declare d text; n text;
begin
  d := pg_get_functiondef('public.chart_call_place(bigint,bigint)'::regprocedure);
  n := replace(d, $b$    perform public.chart_call_reserve(c.id);   -- their bay is reserved now
    perform public.chart_act('call_link', k.id, jsonb_build_object('call', c.id));$b$,
                  $a$    perform public.chart_act('call_link', k.id, jsonb_build_object('call', c.id));$a$);
  if n = d then raise exception '0102 down: call_place text not found'; end if;
  execute n;
  d := pg_get_functiondef('public.chart_call_start(bigint,text,jsonb,jsonb,text)'::regprocedure);
  n := replace(d, $b$  perform public.chart_call_reserve(cid);   -- an incoming patient's bay is reserved now
  perform public.chart_act('call_start', p_case,$b$,
                  $a$  perform public.chart_act('call_start', p_case,$a$);
  if n = d then raise exception '0102 down: call_start text not found'; end if;
  execute n;
end $m$;

drop function if exists public.chart_call_reserve(bigint);
