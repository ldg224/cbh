-- 0089 down: drop the Chart reading + anon functions added in 0089.
drop function if exists public.chart_visit_cancel(text), public.chart_visit_rate(text, int, text), public.chart_visit(text), public.chart_by_token(text),
  public.chart_checkin_anon(text, text, int, text, int, text, text, text, text, text, text), public.chart_ip_hash(), public.chart_has_link(text),
  public.chart_refused(text, text), public.chart_public_status(), public.chart_history(bigint, int), public.chart_suggest(text, text), public.chart_case(bigint),
  public.chart_case_access(public.chart_cases, text), public.chart_poll(bigint), public.chart_hospital(), public.chart_anyone_on(), public.chart_waits(),
  public.chart_req_view(public.chart_requests), public.chart_case_board(public.chart_cases, boolean), public.chart_suggested_esi(int), public.chart_tags(bigint),
  public.chart_staff_status(text), public.chart_title(text), public.chart_lookup_allowed(text);
