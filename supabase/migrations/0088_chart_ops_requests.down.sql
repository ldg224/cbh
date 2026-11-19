-- 0088 down: drop the Chart request + charting functions added in 0088.
drop function if exists public.chart_entry_error(bigint, text), public.chart_order_done(bigint, text), public.chart_entry_add(bigint, text, jsonb, text),
  public.chart_request_chase(bigint), public.chart_request_send(bigint, text), public.chart_request_reopen(bigint), public.chart_request_cancel(bigint, text),
  public.chart_request_done(bigint, text, jsonb), public.chart_request_here(bigint), public.chart_request_accept(bigint), public.chart_req_row(bigint),
  public.chart_request(bigint, text, text, text), public.chart_add_entry(bigint, text, jsonb, text), public.chart_suggest_learn(text, text),
  public.chart_can_chart(public.chart_cases, text);
