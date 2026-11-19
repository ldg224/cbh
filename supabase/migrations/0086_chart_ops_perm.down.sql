-- 0086 down: remove hosp.supervise grants and the key.
delete from public.role_permissions where perm = 'hosp.supervise';
alter table public.role_permissions drop constraint if exists role_permissions_perm_check;
alter table public.role_permissions add constraint role_permissions_perm_check
  check (perm in ('hosp.mod', 'hosp.records', 'hosp.logs', 'hosp.incidents', 'hosp.sessions'));
create or replace function public.my_hperms() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(p order by p), '[]'::jsonb)
  from unnest(array['hosp.mod', 'hosp.records', 'hosp.logs', 'hosp.incidents', 'hosp.sessions']) p where public.has_hperm(p)
$$;
