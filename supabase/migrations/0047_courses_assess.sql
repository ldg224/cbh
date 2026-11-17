-- 0047: 'courses.assess' rank permission ("Assess courses": carry out practical evaluations), for Alpha's Courses
-- (Bravo, 18 Nov 2026). Department ranks only, like the others; Directors and executives always have it (has_perm).
-- Seeded to nobody. Additive: only widens what a grant can be.
alter table public.rank_permissions drop constraint if exists rank_permissions_perm_check;
alter table public.rank_permissions add constraint rank_permissions_perm_check check (perm in (
  'dept.view', 'activity.view', 'members.edit', 'history.view', 'meetings.manage', 'meetings.attendance',
  'applications.review', 'applications.settings', 'courses.manage', 'courses.assess'));

create or replace function public.my_perms() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(d.department, d.perms), '{}'::jsonb) from (
    select x.department, to_jsonb(array_agg(distinct x.perm order by x.perm)) as perms from (
      select dd.department, pp.perm
      from (values ('Administration'), ('Community Engagement'), ('Nursing'), ('Paramedicine')) dd(department)
      cross join (values ('dept.view'), ('activity.view'), ('members.edit'), ('history.view'), ('meetings.manage'),
                         ('meetings.attendance'), ('applications.review'), ('applications.settings'), ('courses.manage'),
                         ('courses.assess')) pp(perm)
      where public.has_perm(pp.perm, dd.department)
    ) x group by x.department
  ) d
$$;
