-- Undo 0096: no trauma calls. The live functions go back to their 0095 text first (they call the new helpers), then the
-- functions and both tables go.
do $m$
declare d text; n text;
begin
  d := pg_get_functiondef('public.chart_tick()'::regprocedure);
  n := replace(d, $b$  if public.chart_call_sweep() then changed := true; end if;
  delete from public.chart_checkin_attempts where at < now() - interval '24 hours';$b$,
                  $a$  delete from public.chart_checkin_attempts where at < now() - interval '24 hours';$a$);
  if n = d then raise exception '0096 down: chart_tick text not found'; end if;
  execute n;

  d := pg_get_functiondef('public.chart_auto_assign()'::regprocedure);
  n := replace(d, $b$where x.role = 'room' and x.ready and not public.chart_on_break(x.discord_id) and not public.chart_away(x.discord_id)$b$,
                  $a$where x.role = 'room' and x.ready and not public.chart_on_break(x.discord_id)$a$);
  if n = d then raise exception '0096 down: chart_auto_assign text not found'; end if;
  execute n;

  d := pg_get_functiondef('public.chart_poll(bigint)'::regprocedure);
  n := replace(d, $b$'can_supervise', public.chart_can_supervise(), 'call', public.chart_call_state(uid), 'can_join', public.chart_calls_joinable(uid), 'ready', me.ready,$b$,
                  $a$'can_supervise', public.chart_can_supervise(), 'ready', me.ready,$a$);
  if n = d then raise exception '0096 down: chart_poll me text not found'; end if;
  d := n;
  n := replace(d, $b$'available', b.available, 'off_reason', b.off_reason, 'away', public.chart_away(b.owner_id),$b$,
                  $a$'available', b.available, 'off_reason', b.off_reason,$a$);
  if n = d then raise exception '0096 down: chart_poll beds text not found'; end if;
  d := n;
  n := replace(d, $b$'status', public.chart_staff_status(s.discord_id), 'ready_since', s.ready_since, 'call', public.chart_call_state(s.discord_id),$b$,
                  $a$'status', public.chart_staff_status(s.discord_id), 'ready_since', s.ready_since,$a$);
  if n = d then raise exception '0096 down: chart_poll staff text not found'; end if;
  d := n;
  n := replace(d, $b$where c.status = 'open' and c.code_at is not null), '[]'),
    'calls', public.chart_calls_view());$b$,
                  $a$where c.status = 'open' and c.code_at is not null), '[]'));$a$);
  if n = d then raise exception '0096 down: chart_poll calls text not found'; end if;
  execute n;
end $m$;

drop function if exists public.chart_call_start(bigint, text, jsonb, jsonb, text);
drop function if exists public.chart_call_set(bigint, jsonb, text);
drop function if exists public.chart_call_add(bigint, jsonb);
drop function if exists public.chart_call_remove(bigint, text);
drop function if exists public.chart_call_end(bigint, boolean);
drop function if exists public.chart_call_answer(bigint, boolean, text);
drop function if exists public.chart_call_arrived(bigint, text);
drop function if exists public.chart_call_sweep();
drop function if exists public.chart_call_check(bigint);
drop function if exists public.chart_call_fit(bigint);
drop function if exists public.chart_call_name_all(bigint, jsonb);
drop function if exists public.chart_call_name(bigint, text, text);
drop function if exists public.chart_call_set_want(bigint, jsonb);
drop function if exists public.chart_call_get(bigint);
drop function if exists public.chart_call_sup();
drop function if exists public.chart_calls_view();
drop function if exists public.chart_call_where(bigint);
drop function if exists public.chart_calls_joinable(text);
drop function if exists public.chart_call_fit_dept(bigint, text);
drop function if exists public.chart_call_state(text);
drop function if exists public.chart_away(text);
drop function if exists public.chart_call_refresh(bigint);
drop function if exists public.chart_call_open_total(bigint);
drop function if exists public.chart_call_open(bigint, text);
drop function if exists public.chart_call_held(bigint, text);
drop function if exists public.chart_call_want(public.chart_calls, text);
drop function if exists public.chart_call_depts();

drop table if exists public.chart_call_members;
drop table if exists public.chart_calls;
