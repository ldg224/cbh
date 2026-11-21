-- 0098 (Bravo, 21 Nov 2026): the Supervisor wins a Pick-your-room race. chart_take_beds (a pick, and the partner ask it
-- makes) refuses with 'sup_order' when the Supervisor has put the caller in a bed in the last 60 s (a chart_orders row
-- of kind move/add/handover, any state), so a stale Pick your room can't undo the Supervisor's placement.
-- chart_take_beds is patched by one exact text replacement (asserted); the down file reverses it. Additive.
do $m$
declare d text; n text;
begin
  d := pg_get_functiondef('public.chart_take_beds(text[])'::regprocedure);
  n := replace(d, $a$  if public.chart_load(me.discord_id) > 0 then perform public.chart_err('hold_patients', 'Hand your patients back first.'); end if;$a$,
                  $b$  if public.chart_load(me.discord_id) > 0 then perform public.chart_err('hold_patients', 'Hand your patients back first.'); end if;
  if exists (select 1 from public.chart_orders o where o.person = me.discord_id and o.kind in ('move', 'add', 'handover') and o.at > now() - interval '60 seconds') then
    perform public.chart_err('sup_order', format('The Supervisor has just put you in Room %s.', (select o.room_id from public.chart_orders o
      where o.person = me.discord_id and o.kind in ('move', 'add', 'handover') and o.at > now() - interval '60 seconds' order by o.id desc limit 1)));
  end if;$b$);
  if n = d then raise exception '0098: chart_take_beds text not found'; end if;
  execute n;
end $m$;
