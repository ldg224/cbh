-- Undo 0094: NPC patients refused during every session again; the switch and its column go.
do $m$
declare d text; n text;
begin
  d := pg_get_functiondef('public.chart_checkin(jsonb,text,integer,text[])'::regprocedure);
  n := replace(d, $b$if p_source = 'npc' and public.chart_session_live() is not null and not coalesce((select o.npc_in_session from public.chart_ops o where o.id = 1), false) then perform public.chart_err('npc_in_session', 'No NPC patients during a session: a supervisor can allow them in the Session menu.'); end if;$b$,
                  $a$if p_source = 'npc' and public.chart_session_live() is not null then perform public.chart_err('npc_in_session', 'No NPC patients during a session.'); end if;$a$);
  if n = d then raise exception '0094 down: chart_checkin text not found'; end if;
  execute n;
  d := pg_get_functiondef('public.chart_poll(bigint)'::regprocedure);
  n := replace(d, $b$'reception_open', o.reception_open, 'npc_in_session', o.npc_in_session,$b$, $a$'reception_open', o.reception_open,$a$);
  if n = d then raise exception '0094 down: chart_poll text not found'; end if;
  execute n;
end $m$;
drop function if exists public.chart_npc_allow(boolean);
alter table public.chart_ops drop column if exists npc_in_session;
