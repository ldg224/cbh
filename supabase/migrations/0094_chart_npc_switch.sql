-- 0094 (Charlie, 20 Nov 2026): supervisors can allow NPC patients during a session (the user: "give me supervisors a
-- setting to enable npc patient"). Additive.
--   chart_ops.npc_in_session      off by default; stays as set until a supervisor changes it (not reset by session end)
--   chart_npc_allow(p_on)         supervisor only (chart_need_sup), logged as 'npc_allow'
--   chart_checkin                 'npc_in_session' refusal only when the switch is off
--   chart_poll                    returns npc_in_session next to reception_open
-- chart_checkin and chart_poll are patched from their live definitions (one exact text replacement each, asserted), so
-- nothing else in those long functions changes. The down file reverses both replacements.

alter table public.chart_ops add column if not exists npc_in_session boolean not null default false;

create or replace function public.chart_npc_allow(p_on boolean) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform public.chart_begin(); perform public.chart_need_sup();
  update public.chart_ops set npc_in_session = coalesce(p_on, false), updated_by = public.my_discord_id(), updated_at = now() where id = 1;
  perform public.chart_act('npc_allow', null, jsonb_build_object('on', coalesce(p_on, false)));
  return public.chart_done();
end $$;
revoke execute on function public.chart_npc_allow(boolean) from public, anon, authenticated;
grant execute on function public.chart_npc_allow(boolean) to service_role, authenticated;

do $m$
declare d text; n text;
begin
  -- check-in: NPCs during a session only when a supervisor allows them
  d := pg_get_functiondef('public.chart_checkin(jsonb,text,integer,text[])'::regprocedure);
  n := replace(d, $a$if p_source = 'npc' and public.chart_session_live() is not null then perform public.chart_err('npc_in_session', 'No NPC patients during a session.'); end if;$a$,
                  $b$if p_source = 'npc' and public.chart_session_live() is not null and not coalesce((select o.npc_in_session from public.chart_ops o where o.id = 1), false) then perform public.chart_err('npc_in_session', 'No NPC patients during a session: a supervisor can allow them in the Session menu.'); end if;$b$);
  if n = d then raise exception '0094: chart_checkin text not found'; end if;
  execute n;

  -- poll: tell the site whether the switch is on
  d := pg_get_functiondef('public.chart_poll(bigint)'::regprocedure);
  n := replace(d, $a$'reception_open', o.reception_open,$a$, $b$'reception_open', o.reception_open, 'npc_in_session', o.npc_in_session,$b$);
  if n = d then raise exception '0094: chart_poll text not found'; end if;
  execute n;
end $m$;
