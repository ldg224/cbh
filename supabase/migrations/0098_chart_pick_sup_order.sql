-- 0098 (Bravo, 21 Nov 2026): the Supervisor wins a Pick-your-room race. chart_take_beds (a pick, and the partner ask it
-- makes) refuses with 'sup_order' when the Supervisor has put the caller in a bed in the last 60 s (a chart_orders row
-- of kind move/add/handover, or 'patient' from 0099, any state), so a stale Pick your room can't undo the Supervisor's placement.
-- Messages use chart_room_name (Trauma Bay 1, ER 1, Minor Triage, Room 104). chart_take_beds is patched by one exact text replacement (asserted); the down file reverses it. Additive.
-- How a room is named on screen (Alpha's nit: "Trauma Bay 1", not "TB1"); the same names chart.js shows.
create or replace function public.chart_room_name(p_room text) returns text
language sql immutable set search_path = '' as $$
  select case when p_room ~ '^TB[0-9]+$' then 'Trauma Bay ' || substr(p_room, 3)
              when p_room ~ '^ER[0-9]+$' then 'ER ' || substr(p_room, 3)
              when p_room = 'MT' then 'Minor Triage'
              when p_room is null then 'a room'
              else 'Room ' || p_room end
$$;
revoke execute on function public.chart_room_name(text) from public, anon, authenticated;
grant execute on function public.chart_room_name(text) to service_role;

do $m$
declare d text; n text;
begin
  d := pg_get_functiondef('public.chart_take_beds(text[])'::regprocedure);
  n := replace(d, $a$  if public.chart_load(me.discord_id) > 0 then perform public.chart_err('hold_patients', 'Hand your patients back first.'); end if;$a$,
                  $b$  if public.chart_load(me.discord_id) > 0 then perform public.chart_err('hold_patients', 'Hand your patients back first.'); end if;
  if exists (select 1 from public.chart_orders o where o.person = me.discord_id and o.kind in ('move', 'add', 'handover', 'patient') and o.at > now() - interval '60 seconds') then
    perform public.chart_err('sup_order', format('The Supervisor has just put you in %s.', public.chart_room_name((select o.room_id from public.chart_orders o
      where o.person = me.discord_id and o.kind in ('move', 'add', 'handover', 'patient') and o.at > now() - interval '60 seconds' order by o.id desc limit 1))));
  end if;$b$);
  if n = d then raise exception '0098: chart_take_beds text not found'; end if;
  execute n;
end $m$;
