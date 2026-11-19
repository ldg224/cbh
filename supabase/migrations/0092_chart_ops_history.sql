-- 0092: Chart "Past patients" (Bravo, 19 Nov 2026; for Alpha's page). chart_history gains server-side filters and a fuller row;
-- chart_history_people lists who treated the cases you may see (filter dropdown). Access is unchanged: chart_case_access 'full'
-- on a closed case (owners all, Directors their department's, staff the cases they worked). The old two-argument
-- chart_history is dropped (no client called it) so PostgREST has one unambiguous function; the new one keeps both old
-- parameters and the old row keys (state, discharged_at).

drop function if exists public.chart_history(bigint, int);

create or replace function public.chart_history(p_before_id bigint default null, p_limit int default 30, p_search text default null,
  p_from date default null, p_to date default null, p_outcome text default null, p_team text default null, p_person text default null) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(x.j order by x.id desc), '[]') from (
    select c.id, jsonb_build_object('id', c.id, 'patient_name', c.patient_name, 'short_name', public.checkin_short_name(c.patient_name),
             'age', c.age, 'child', c.child, 'esi', c.esi, 'outcome', c.outcome, 'state', c.state,
             'opened_at', c.opened_at, 'closed_at', coalesce(c.discharged_at, c.closed_at), 'discharged_at', coalesce(c.discharged_at, c.closed_at),
             'team', c.team, 'owner_name', public.chart_short(coalesce(c.discharged_by, c.cared_for[cardinality(c.cared_for)])),
             'cared_for_names', coalesce((select jsonb_agg(public.chart_short(w) order by n) from unnest(c.cared_for) with ordinality u(w, n)), '[]'),
             'rating', c.rating, 'rating_source', c.rating_source, 'source', c.source, 'npc', coalesce(c.npc, false)) j
    from public.chart_cases c
    where c.state is not null and c.status <> 'open' and (p_before_id is null or c.id < p_before_id)
      and (nullif(btrim(p_search), '') is null
           or position(lower(btrim(p_search)) in lower(coalesce(c.patient_name, ''))) > 0
           or position(lower(btrim(p_search)) in lower(coalesce(c.roblox_username, ''))) > 0)
      and (p_from is null or (coalesce(c.discharged_at, c.closed_at) at time zone 'America/New_York')::date >= p_from)
      and (p_to is null or (coalesce(c.discharged_at, c.closed_at) at time zone 'America/New_York')::date <= p_to)
      and (nullif(p_outcome, '') is null or c.outcome = p_outcome)
      and (nullif(p_team, '') is null or c.team = p_team)
      and (nullif(p_person, '') is null or p_person = any (c.cared_for))
      and public.chart_case_access(c, public.my_discord_id()) = 'full'
    order by c.id desc limit least(greatest(coalesce(p_limit, 30), 1), 100)) x
$$;

create or replace function public.chart_history_people() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('discord_id', p.w, 'name', public.chart_short(p.w)) order by public.chart_short(p.w), p.w), '[]') from (
    select distinct w from public.chart_cases c, unnest(c.cared_for) w
    where c.state is not null and c.status <> 'open' and public.chart_case_access(c, public.my_discord_id()) = 'full') p
$$;

revoke execute on function public.chart_history(bigint, int, text, date, date, text, text, text) from public, anon, authenticated;
revoke execute on function public.chart_history_people() from public, anon, authenticated;
grant execute on function public.chart_history(bigint, int, text, date, date, text, text, text) to authenticated, service_role;
grant execute on function public.chart_history_people() to authenticated, service_role;
