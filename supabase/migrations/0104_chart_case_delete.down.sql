-- Undo 0104: chart_case loses can.delete, chart_case_unvoid and chart_void_check go, chart_case_void is back as in 0087.
do $m$
declare d text; n text;
begin
  d := pg_get_functiondef('public.chart_case(bigint)'::regprocedure);
  n := replace(d, $b$'amend', ed, 'void', ed,
      'delete', coalesce((public.chart_void_check(c, uid)->>'ok')::boolean, false), 'delete_why', public.chart_void_check(c, uid)->>'why',
      'delete_reason_needed', coalesce((public.chart_void_check(c, uid)->>'reason_needed')::boolean, false),$b$,
                  $a$'amend', ed, 'void', ed,$a$);
  if n = d then raise exception '0104 down: chart_case text not found'; end if;
  execute n;
end $m$;

drop function if exists public.chart_case_unvoid(bigint);
drop function if exists public.chart_case_void(bigint, text);
create or replace function public.chart_case_void(p_case bigint, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare c public.chart_cases; why text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  perform public.chart_begin(); perform public.chart_need_sup();
  c := public.chart_case_row(p_case);
  if why is null then perform public.chart_err('reason_needed', 'Say why it''s void.'); end if;
  update public.chart_requests set cancelled_at = now(), cancelled_by = public.my_discord_id(), cancel_reason = 'Void' where case_id = c.id and done_at is null and cancelled_at is null;
  update public.chart_cases set status = 'void', void_reason = left(why, 200), bed_id = null, owner_id = null, closed_at = now(), closed_by = public.my_discord_id(),
         visit_expires_at = now() where id = c.id;
  perform public.chart_act('void', c.id, jsonb_build_object('reason', why));
  return public.chart_done();
end $$;
revoke execute on function public.chart_case_void(bigint, text) from public, anon;
grant execute on function public.chart_case_void(bigint, text) to service_role, authenticated;
drop function if exists public.chart_void_check(public.chart_cases, text);
