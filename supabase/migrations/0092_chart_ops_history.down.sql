-- 0092 down: back to the 0089 chart_history; drop chart_history_people.
drop function if exists public.chart_history_people();
drop function if exists public.chart_history(bigint, int, text, date, date, text, text, text);

create or replace function public.chart_history(p_before_id bigint default null, p_limit int default 30) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(x.j order by x.id desc), '[]') from (
    select c.id, jsonb_build_object('id', c.id, 'short_name', public.checkin_short_name(c.patient_name), 'outcome', c.outcome, 'state', c.state,
             'discharged_at', coalesce(c.discharged_at, c.closed_at), 'team', c.team, 'owner_name', public.chart_short(c.discharged_by), 'rating', c.rating) j
    from public.chart_cases c
    where c.state is not null and c.status <> 'open' and (p_before_id is null or c.id < p_before_id)
      and public.chart_case_access(c, public.my_discord_id()) = 'full'
    order by c.id desc limit least(greatest(coalesce(p_limit, 30), 1), 100)) x
$$;
revoke execute on function public.chart_history(bigint, int) from public, anon, authenticated;
grant execute on function public.chart_history(bigint, int) to authenticated, service_role;
