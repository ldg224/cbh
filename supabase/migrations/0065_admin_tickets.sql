-- 0065: Administration Team Members handle Administration tickets (0.29.0, Bravo; owner approved the Admin merge).
-- leads_team(team) gave ticket access to Director, Leader, Year 5 and Year 4 of that team only, so an Administration
-- Team Member saw an empty Tickets tab. For the Administration team, Team Members now count too (not Trainees).
create or replace function public.leads_team(t text) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_exec() or exists (
    select 1 from public.my_roles() r
    where r.kind = 'rank' and r.department = t
      and (r.rank_label in ('Director', 'Leader', 'Year 5', 'Year 4') or (t = 'Administration' and r.rank_label = 'Team Member')))
$$;
