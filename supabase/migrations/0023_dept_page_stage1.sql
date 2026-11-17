-- 0023: Department page stage 1 (Bravo, 18 Nov 2026).
-- 1. An optional reason on every rank change, add and removal (shown in the page's History tab).
-- 2. dept_weekly_hours(): each member's hours in the last 4 weeks (Members tab sparklines, Overview chart).
-- Additive: the old 3-argument dept_* calls keep working (reason defaults to null).

alter table public.role_changes add column if not exists reason text;
alter table public.role_changes drop constraint if exists role_changes_reason_len;
alter table public.role_changes add constraint role_changes_reason_len check (reason is null or char_length(reason) <= 500);

-- Same checks as the 0011 version, plus the reason (trimmed; empty becomes null).
create or replace function public.role_change_request(target text, department text, rank_role_id text, action text, reason text)
returns public.role_changes
language plpgsql security definer set search_path = '' as $$
declare t public.members; c public.role_changes; label text; why text := nullif(trim(coalesce(reason, '')), '');
begin
  t := public.role_change_check(target, department, rank_role_id, action);
  if action = 'add' and exists (select 1 from public.roles r where r.id = any (t.role_ids)
                                and r.department = role_change_request.department and r.kind in ('department', 'rank')) then
    raise exception '% is already in %', t.display_name, department;
  end if;
  if action in ('set_rank', 'remove') and not exists (select 1 from public.roles r where r.id = any (t.role_ids)
                                and r.department = role_change_request.department and r.kind in ('department', 'rank')) then
    raise exception '% isn''t in %', t.display_name, department;
  end if;
  if exists (select 1 from public.role_changes x where x.target_discord_id = target and x.department = role_change_request.department
             and x.status = 'pending') then
    raise exception 'There''s already a change waiting for % in %', t.display_name, department;
  end if;
  if char_length(why) > 500 then raise exception 'Keep the reason under 500 characters'; end if;
  select r.rank_label into label from public.roles r where r.id = rank_role_id;
  insert into public.role_changes (target_discord_id, target_name, department, action, rank_role_id, rank_label,
                                   requested_by, requested_by_name, reason)
  values (target, t.display_name, department, action, case when action = 'remove' then null else rank_role_id end,
          case when action = 'remove' then null else label end, public.my_discord_id(),
          (select m.display_name from public.members m where m.discord_id = public.my_discord_id()), why)
  returning * into c;
  return c;
end $$;
revoke execute on function public.role_change_request(text, text, text, text, text) from public, anon, authenticated;

-- The old 4-argument version now passes no reason.
create or replace function public.role_change_request(target text, department text, rank_role_id text, action text)
returns public.role_changes language sql security definer set search_path = '' as $$
  select public.role_change_request(target, department, rank_role_id, action, null)
$$;
revoke execute on function public.role_change_request(text, text, text, text) from public, anon, authenticated;

-- Replace the 3-/2-argument calls with versions that take an optional reason (same names, so the website's
-- existing calls still resolve).
drop function if exists public.dept_set_rank(text, text, text);
drop function if exists public.dept_add(text, text, text);
drop function if exists public.dept_remove(text, text);
create function public.dept_set_rank(target text, department text, rank_role_id text, reason text default null)
returns public.role_changes language sql security definer set search_path = '' as $$
  select public.role_change_request(target, department, rank_role_id, 'set_rank', reason)
$$;
create function public.dept_add(target text, department text, rank_role_id text, reason text default null)
returns public.role_changes language sql security definer set search_path = '' as $$
  select public.role_change_request(target, department, rank_role_id, 'add', reason)
$$;
create function public.dept_remove(target text, department text, reason text default null)
returns public.role_changes language sql security definer set search_path = '' as $$
  select public.role_change_request(target, department, null, 'remove', reason)
$$;
revoke execute on function public.dept_set_rank(text, text, text, text), public.dept_add(text, text, text, text),
  public.dept_remove(text, text, text) from public, anon;
grant execute on function public.dept_set_rank(text, text, text, text), public.dept_add(text, text, text, text),
  public.dept_remove(text, text, text) to authenticated;

-- Hours per member per week (Sydney weeks, Monday start), this week and the 3 before it. weeks[4] = this week.
-- Only the department's Director and execs get rows (same rule as dept_roster).
create or replace function public.dept_weekly_hours(department text)
returns table (discord_id text, weeks numeric[])
language sql stable security definer set search_path = '' as $$
  with w as (
    select (date_trunc('week', now() at time zone 'Australia/Sydney') at time zone 'Australia/Sydney') as this_week
  ), slots as (
    select g.i, (select this_week from w) - make_interval(weeks => 4 - g.i) as start_at
    from generate_series(1, 4) g(i)
  ), dept_roles as (
    select r.id from public.roles r where r.department = dept_weekly_hours.department and r.kind in ('department', 'rank')
  ), people as (
    select m.discord_id from public.members m
    where public.directs_dept(dept_weekly_hours.department)
      and exists (select 1 from dept_roles d where d.id = any (m.role_ids))
  )
  select p.discord_id,
    array(select coalesce((select round(sum(public.shift_seconds(s)) / 3600.0, 2) from public.shifts s
                           where s.discord_id = p.discord_id and s.department = dept_weekly_hours.department
                             and s.started_at >= sl.start_at and s.started_at < sl.start_at + interval '7 days'), 0)
          from slots sl order by sl.i)
  from people p
$$;
revoke execute on function public.dept_weekly_hours(text) from public, anon;
grant execute on function public.dept_weekly_hours(text) to authenticated;
