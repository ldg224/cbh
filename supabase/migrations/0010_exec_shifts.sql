-- 0010: executives and leadership (who often have no department role) can start shifts in any department.
-- my_access() gains 'shift_teams': the departments the person may start a shift in.

create or replace function public.my_access()
returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'member', public.is_member(),
    'team',   public.is_team(),
    'admin',  public.is_admin(),
    'exec',   public.is_exec(),
    'teams',  coalesce((select jsonb_agg(distinct r.department) from public.my_roles() r
                         where r.kind in ('department', 'rank')), '[]'::jsonb),
    'leads',  coalesce((select jsonb_agg(distinct r.department) from public.my_roles() r
                         where r.kind = 'rank' and r.rank_label in ('Director', 'Leader', 'Year 5', 'Year 4')), '[]'::jsonb),
    'shift_teams', case when public.is_exec()
                        then '["Administration", "Community Engagement", "Nursing", "Paramedicine"]'::jsonb
                        else coalesce((select jsonb_agg(distinct r.department) from public.my_roles() r
                                       where r.kind in ('department', 'rank')), '[]'::jsonb) end
  )
$$;

create or replace function public.shift_start(department text)
returns public.shifts
language plpgsql security definer set search_path = '' as $$
declare me text := public.my_discord_id(); s public.shifts;
begin
  if shift_start.department not in ('Administration', 'Community Engagement', 'Nursing', 'Paramedicine') then
    raise exception 'Unknown department %', department;
  end if;
  if me is null or not (public.is_exec() or exists (
        select 1 from public.my_roles() r
        where r.kind in ('department', 'rank') and r.department = shift_start.department)) then
    raise exception 'You''re not in %', department;
  end if;
  if exists (select 1 from public.shifts x where x.discord_id = me and x.status <> 'ended') then
    raise exception 'You''re already on shift';
  end if;
  insert into public.shifts (discord_id, name, department, session_id)
  values (me, (select m.display_name from public.members m where m.discord_id = me), shift_start.department,
          (select x.id from public.sessions x where x.status = 'live' limit 1))
  returning * into s;
  return s;
end $$;
