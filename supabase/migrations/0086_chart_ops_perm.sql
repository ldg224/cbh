-- 0086: new hospital permission "Supervise sessions" (hosp.supervise) for the Chart Supervisor role (Bravo, 19 Nov 2026;
-- BACKEND-PLAN §3). Widens the role_permissions check (no row breaks) and lists the key in my_hperms(). The Rank
-- Editor's label row goes in roles.js (Delta). Session hosts get the Supervisor role without the key (chart_can_supervise).

alter table public.role_permissions drop constraint if exists role_permissions_perm_check;
alter table public.role_permissions add constraint role_permissions_perm_check
  check (perm in ('hosp.mod', 'hosp.records', 'hosp.logs', 'hosp.incidents', 'hosp.sessions', 'hosp.supervise'));

create or replace function public.my_hperms() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(p order by p), '[]'::jsonb)
  from unnest(array['hosp.mod', 'hosp.records', 'hosp.logs', 'hosp.incidents', 'hosp.sessions', 'hosp.supervise']) p where public.has_hperm(p)
$$;
