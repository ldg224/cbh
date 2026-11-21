-- Undo 0098: chart_take_beds back to its 0097 text.
do $m$
declare d text; n text;
begin
  d := pg_get_functiondef('public.chart_take_beds(text[])'::regprocedure);
  n := replace(d, $b$  if public.chart_load(me.discord_id) > 0 then perform public.chart_err('hold_patients', 'Hand your patients back first.'); end if;
  if exists (select 1 from public.chart_orders o where o.person = me.discord_id and o.kind in ('move', 'add', 'handover', 'patient') and o.at > now() - interval '60 seconds') then
    perform public.chart_err('sup_order', format('The Supervisor has just put you in %s.', public.chart_room_name((select o.room_id from public.chart_orders o
      where o.person = me.discord_id and o.kind in ('move', 'add', 'handover', 'patient') and o.at > now() - interval '60 seconds' order by o.id desc limit 1))));
  end if;$b$,
                  $a$  if public.chart_load(me.discord_id) > 0 then perform public.chart_err('hold_patients', 'Hand your patients back first.'); end if;$a$);
  if n = d then raise exception '0098 down: chart_take_beds text not found'; end if;
  execute n;
end $m$;
drop function if exists public.chart_room_name(text);
