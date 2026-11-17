-- 0027: Rank permissions (user, 18 Nov 2026; Bravo). In each department's page the Director (or an executive) chooses
-- which of the department's ranks may do what on the website. Executives and the department's Director always may.
-- Seeded to reproduce today's rules exactly, so nothing changes until someone edits it:
--   applications.review = Leader, Year 5, Year 4 (today's "leads", leads_team()); everything else = Director/exec only.
-- Permissions (user's list, 18 Nov 2026):
--   dept.view            open the department page (read-only without the others)
--   activity.view        see everyone's hours, shifts and Inactive flags
--   members.edit         change ranks, add and remove members (only people and ranks below their own)
--   meetings.manage      schedule, edit, move, start, end and cancel meetings
--   meetings.attendance  take attendance and write meeting notes
--   applications.review  review applications for the department
--   applications.settings change the department's application settings
--   courses.manage       create and edit courses (Courses isn't built yet)
-- Additive. Nothing here changes an existing check; later migrations switch checks over to has_perm().

create table if not exists public.rank_permissions (
  role_id     text not null references public.roles (id) on delete cascade,
  perm        text not null check (perm in ('dept.view', 'activity.view', 'members.edit', 'meetings.manage',
                                            'meetings.attendance', 'applications.review', 'applications.settings',
                                            'courses.manage')),
  granted_by  text,
  granted_at  timestamptz not null default now(),
  primary key (role_id, perm)
);
alter table public.rank_permissions enable row level security;
drop policy if exists rank_permissions_read on public.rank_permissions;
create policy rank_permissions_read on public.rank_permissions for select to authenticated using (public.is_team());
revoke all on public.rank_permissions from anon;
revoke insert, update, delete, truncate on public.rank_permissions from authenticated;
grant select on public.rank_permissions to authenticated;

-- May the logged-in person do `perm` in `department`? Execs and that department's Director always may; otherwise one
-- of their ranks in that department must hold the permission.
create or replace function public.has_perm(perm text, department text) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_exec() or public.directs_dept(has_perm.department) or exists (
    select 1 from public.my_roles() r join public.rank_permissions p on p.role_id = r.id
    where r.kind = 'rank' and r.department = has_perm.department and p.perm = has_perm.perm)
$$;
revoke execute on function public.has_perm(text, text) from public, anon;
grant execute on function public.has_perm(text, text) to authenticated;

-- Every permission the logged-in person has, per department (for the website: which pages and controls to show).
create or replace function public.my_perms() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(d.department, d.perms), '{}'::jsonb) from (
    select x.department, to_jsonb(array_agg(distinct x.perm order by x.perm)) as perms from (
      select dd.department, pp.perm
      from (values ('Administration'), ('Community Engagement'), ('Nursing'), ('Paramedicine')) dd(department)
      cross join (values ('dept.view'), ('activity.view'), ('members.edit'), ('meetings.manage'), ('meetings.attendance'),
                         ('applications.review'), ('applications.settings'), ('courses.manage')) pp(perm)
      where public.has_perm(pp.perm, dd.department)
    ) x group by x.department
  ) d
$$;
revoke execute on function public.my_perms() from public, anon;
grant execute on function public.my_perms() to authenticated;

-- Turn one permission on or off for one rank. Only that department's Director or an executive. Only the department's
-- own ranks, never its Director rank (Directors always have everything).
create or replace function public.set_rank_perm(role_id text, perm text, allow boolean)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare r public.roles;
begin
  select * into r from public.roles x where x.id = set_rank_perm.role_id;
  if not found or r.kind <> 'rank' or r.department is null then raise exception 'That isn''t a department rank'; end if;
  if r.rank_label = 'Director' then raise exception 'Directors always have every permission'; end if;
  if not public.directs_dept(r.department) then raise exception 'Only the % Director or an executive can change this', r.department; end if;
  if allow then
    insert into public.rank_permissions (role_id, perm, granted_by) values (set_rank_perm.role_id, set_rank_perm.perm, public.my_discord_id())
    on conflict do nothing;
  else
    delete from public.rank_permissions p where p.role_id = set_rank_perm.role_id and p.perm = set_rank_perm.perm;
  end if;
  return allow;
end $$;
revoke execute on function public.set_rank_perm(text, text, boolean) from public, anon;
grant execute on function public.set_rank_perm(text, text, boolean) to authenticated;

-- Seed: today's rules. applications.review = the ranks leads_team() treats as leads (Leader, Year 5, Year 4).
insert into public.rank_permissions (role_id, perm, granted_by)
select r.id, 'applications.review', 'seed-0027' from public.roles r
where r.kind = 'rank' and r.department is not null and r.rank_label in ('Leader', 'Year 5', 'Year 4')
on conflict do nothing;
