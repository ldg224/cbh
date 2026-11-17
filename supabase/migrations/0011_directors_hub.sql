-- 0011: Directors hub. Department Directors (and execs, for every department) manage their department's members:
-- change rank, add, remove, and see shifts. Role changes are requests the bot carries out (offline catch-up).
-- Sessions can now be run by admins, Directors and execs.

-- ---------- who directs what ----------
create or replace function public.directs_dept(d text) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_exec() or exists (
    select 1 from public.my_roles() r where r.kind = 'rank' and r.department = d and r.rank_label = 'Director')
$$;

create or replace function public.directs_any() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_exec() or exists (select 1 from public.my_roles() r where r.kind = 'rank' and r.rank_label = 'Director')
$$;

create or replace function public.can_run_sessions() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_admin() or public.directs_any()
$$;

revoke execute on function public.directs_dept(text), public.directs_any(), public.can_run_sessions() from public, anon;
grant execute on function public.directs_dept(text), public.directs_any(), public.can_run_sessions() to authenticated;

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
                                       where r.kind in ('department', 'rank')), '[]'::jsonb) end,
    'directs', case when public.is_exec()
                    then '["Administration", "Community Engagement", "Nursing", "Paramedicine"]'::jsonb
                    else coalesce((select jsonb_agg(distinct r.department) from public.my_roles() r
                                   where r.kind = 'rank' and r.rank_label = 'Director'), '[]'::jsonb) end,
    'run_sessions', public.can_run_sessions()
  )
$$;

-- ---------- sessions: admins, Directors and execs ----------
drop policy if exists sessions_admin_insert on public.sessions;
create policy sessions_admin_insert on public.sessions for insert to authenticated
  with check (public.can_run_sessions() and host_discord_id = public.my_discord_id() and message_id is null
              and announced_state is null);
drop policy if exists sessions_admin_update on public.sessions;
create policy sessions_admin_update on public.sessions for update to authenticated
  using (public.can_run_sessions()) with check (public.can_run_sessions());

-- ---------- department roster ----------
create or replace function public.dept_roster(department text)
returns table (discord_id text, display_name text, avatar_url text, rank_role_id text, rank_label text,
               rank_order integer, week_hours numeric, shifts_30d bigint, last_shift_at timestamptz, on_shift boolean)
language sql stable security definer set search_path = '' as $$
  with dept_roles as (
    select r.* from public.roles r where r.department = dept_roster.department and r.kind in ('department', 'rank')
  ), people as (
    select m.* from public.members m
    where public.directs_dept(dept_roster.department)
      and exists (select 1 from dept_roles d where d.id = any (m.role_ids))
  ), week_start as (
    select (date_trunc('week', now() at time zone 'Australia/Sydney') at time zone 'Australia/Sydney') as t
  )
  select p.discord_id, p.display_name, p.avatar_url,
    rk.id, rk.rank_label, rk.rank_order,
    coalesce((select round(sum(public.shift_seconds(s)) / 3600.0, 2) from public.shifts s
              where s.discord_id = p.discord_id and s.department = dept_roster.department
                and s.started_at >= (select t from week_start)), 0),
    (select count(*) from public.shifts s where s.discord_id = p.discord_id and s.department = dept_roster.department
       and s.started_at >= now() - interval '30 days'),
    (select max(s.started_at) from public.shifts s where s.discord_id = p.discord_id
       and s.department = dept_roster.department),
    exists (select 1 from public.shifts s where s.discord_id = p.discord_id and s.status <> 'ended')
  from people p
  left join lateral (
    select d.id, d.rank_label, d.rank_order from dept_roles d
    where d.kind = 'rank' and d.id = any (p.role_ids) order by d.rank_order desc limit 1
  ) rk on true
  order by rk.rank_order desc nulls last, p.display_name
$$;

-- ---------- member search (for "Add") ----------
create or replace function public.member_search(q text)
returns table (discord_id text, display_name text, avatar_url text)
language sql stable security definer set search_path = '' as $$
  select m.discord_id, m.display_name, m.avatar_url from public.members m
  where public.directs_any() and char_length(trim(q)) >= 1
    and (m.display_name ilike '%' || trim(q) || '%' or m.username ilike '%' || trim(q) || '%')
  order by m.display_name limit 20
$$;

revoke execute on function public.dept_roster(text), public.member_search(text) from public, anon;
grant execute on function public.dept_roster(text), public.member_search(text) to authenticated;

-- ---------- role change requests ----------
create table if not exists public.role_changes (
  id                 bigint generated always as identity primary key,
  target_discord_id  text not null,
  target_name        text,
  department         text not null check (department in ('Administration', 'Community Engagement', 'Nursing', 'Paramedicine')),
  action             text not null check (action in ('set_rank', 'add', 'remove')),
  rank_role_id       text,
  rank_label         text,
  requested_by       text not null,
  requested_by_name  text,
  status             text not null default 'pending' check (status in ('pending', 'done', 'failed')),
  error              text,
  created_at         timestamptz not null default now(),
  done_at            timestamptz
);
create index if not exists role_changes_pending on public.role_changes (id) where status = 'pending';
create index if not exists role_changes_dept on public.role_changes (department, created_at desc);
alter table public.role_changes enable row level security;
drop policy if exists role_changes_read on public.role_changes;
create policy role_changes_read on public.role_changes for select to authenticated using (public.directs_dept(department));
revoke all on public.role_changes from anon;
revoke insert, update, delete, truncate on public.role_changes from authenticated;
grant select on public.role_changes to authenticated;

-- The checks every request goes through. Returns the target's members row.
create or replace function public.role_change_check(target text, department text, rank_role_id text, action text)
returns public.members
language plpgsql stable security definer set search_path = '' as $$
declare me text := public.my_discord_id(); t public.members; rk public.roles; exec_caller boolean := public.is_exec();
begin
  if not public.directs_dept(role_change_check.department) then
    raise exception 'You don''t direct %', role_change_check.department;
  end if;
  select * into t from public.members m where m.discord_id = target;
  if not found then raise exception 'That person isn''t in the server'; end if;
  if action <> 'remove' then
    select * into rk from public.roles r where r.id = role_change_check.rank_role_id;
    if not found or rk.kind <> 'rank' or rk.department <> role_change_check.department then
      raise exception 'That isn''t a % rank', role_change_check.department;
    end if;
  end if;
  if not exec_caller then
    if target = me then raise exception 'You can''t change your own rank'; end if;
    if exists (select 1 from public.roles r where r.id = any (t.role_ids)
               and (r.kind in ('leadership', 'executive') or (r.kind = 'rank' and r.rank_label = 'Director'))) then
      raise exception 'Only executives can change a Director or executive';
    end if;
    if action <> 'remove' and rk.rank_label = 'Director' then
      raise exception 'Only executives can make someone a Director';
    end if;
  end if;
  return t;
end $$;
revoke execute on function public.role_change_check(text, text, text, text) from public, anon, authenticated;

create or replace function public.role_change_request(target text, department text, rank_role_id text, action text)
returns public.role_changes
language plpgsql security definer set search_path = '' as $$
declare t public.members; c public.role_changes; label text;
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
  select r.rank_label into label from public.roles r where r.id = rank_role_id;
  insert into public.role_changes (target_discord_id, target_name, department, action, rank_role_id, rank_label,
                                   requested_by, requested_by_name)
  values (target, t.display_name, department, action, case when action = 'remove' then null else rank_role_id end,
          case when action = 'remove' then null else label end, public.my_discord_id(),
          (select m.display_name from public.members m where m.discord_id = public.my_discord_id()))
  returning * into c;
  return c;
end $$;
revoke execute on function public.role_change_request(text, text, text, text) from public, anon, authenticated;

create or replace function public.dept_set_rank(target text, department text, rank_role_id text)
returns public.role_changes language sql security definer set search_path = '' as $$
  select public.role_change_request(target, department, rank_role_id, 'set_rank')
$$;
create or replace function public.dept_add(target text, department text, rank_role_id text)
returns public.role_changes language sql security definer set search_path = '' as $$
  select public.role_change_request(target, department, rank_role_id, 'add')
$$;
create or replace function public.dept_remove(target text, department text)
returns public.role_changes language sql security definer set search_path = '' as $$
  select public.role_change_request(target, department, null, 'remove')
$$;
revoke execute on function public.dept_set_rank(text, text, text), public.dept_add(text, text, text),
  public.dept_remove(text, text) from public, anon;
grant execute on function public.dept_set_rank(text, text, text), public.dept_add(text, text, text),
  public.dept_remove(text, text) to authenticated;
