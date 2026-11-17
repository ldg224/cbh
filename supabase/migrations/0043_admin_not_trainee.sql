-- 0043: Administration Trainees are not admins (user via Charlie, 18 Nov 2026; Bravo). Interim fix before the Desk
-- rebuild turns hospital powers into per-role permissions.
-- is_admin() counted any Administration role, so a Trainee (and accepted applicants start as Trainees) could see
-- Records, Mod actions, Discord logs, messages and incidents. Now: an executive, or someone holding an
-- Administration rank other than Trainee (Team Member, Leader, Director). The division role alone no longer counts
-- (nobody holds it without a rank today). Every check that uses is_admin() (RLS, my_access().admin, home_counts,
-- mod tools) follows automatically.
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_exec() or exists (
    select 1 from public.my_roles() r
    where r.kind = 'rank' and r.department = 'Administration' and r.rank_label <> 'Trainee')
$$;
