-- 0033: "See history" permission (user via Charlie, 18 Nov 2026; Bravo). Additive.
-- The History tab (role changes with their reasons) now needs 'history.view' instead of 'dept.view'. Execs and the
-- department's Director always pass (has_perm). Seeded ONLY to ranks that hold members.edit today (the Administration
-- Leader), so Team Members and Trainees who were given "See this page" stop seeing reasons until a Director ticks it.
-- has_perm('dept.view') is unchanged: the roster and member reads still need it.

alter table public.rank_permissions drop constraint if exists rank_permissions_perm_check;
alter table public.rank_permissions add constraint rank_permissions_perm_check check (perm in (
  'dept.view', 'activity.view', 'members.edit', 'history.view', 'meetings.manage', 'meetings.attendance',
  'applications.review', 'applications.settings', 'courses.manage'));

create or replace function public.my_perms() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(d.department, d.perms), '{}'::jsonb) from (
    select x.department, to_jsonb(array_agg(distinct x.perm order by x.perm)) as perms from (
      select dd.department, pp.perm
      from (values ('Administration'), ('Community Engagement'), ('Nursing'), ('Paramedicine')) dd(department)
      cross join (values ('dept.view'), ('activity.view'), ('members.edit'), ('history.view'), ('meetings.manage'),
                         ('meetings.attendance'), ('applications.review'), ('applications.settings'), ('courses.manage')) pp(perm)
      where public.has_perm(pp.perm, dd.department)
    ) x group by x.department
  ) d
$$;

drop policy if exists role_changes_read on public.role_changes;
create policy role_changes_read on public.role_changes for select to authenticated using (public.has_perm('history.view', department));

insert into public.rank_permissions (role_id, perm, granted_by)
select p.role_id, 'history.view', 'seed-0033' from public.rank_permissions p where p.perm = 'members.edit'
on conflict do nothing;
