-- 0024: Activity page (was Reports), Alpha, number from Charlie. Additive only.
-- activity_report(from_ts, to_ts, prev_from, prev_to): one call for the Executive Activity page. Executives only
-- (is_exec() inside; everyone else gets null). Hours exclude breaks (shift_seconds, as Shifts and Sessions history).
-- Returns jsonb:
--   totals      { hours, shifts, people, sessions, actions } for this period, prev the same for the comparison period
--   departments [{ department, hours, prev_hours, shifts, people }]  (shifts by the department they were taken in)
--   people      [{ discord_id, name, avatar_url, departments[], hours, prev_hours, shifts, sessions, actions }]
--               everyone in a department (rank or department role) plus anyone who took a shift, hosted a session
--               or took a mod action in either period. Staff with 0 hours this period = the "quiet" list.
-- Sessions hosted: started in the period (live or ended); hosts = the lead host plus session_hosts.
-- Mod actions taken: status 'done', by moderator, any source.

create or replace function public.activity_report(from_ts timestamptz, to_ts timestamptz,
                                                  prev_from timestamptz, prev_to timestamptz)
returns jsonb
language sql stable security definer set search_path = '' as $$
  with
  sh as (
    select s.discord_id, s.name, s.department, (s.started_at >= from_ts) as cur,
           public.shift_seconds(s) / 3600.0 as h
    from public.shifts s
    where (s.started_at >= from_ts and s.started_at < to_ts) or (s.started_at >= prev_from and s.started_at < prev_to)
  ),
  ses as (
    select x.id, (x.started_at >= from_ts) as cur from public.sessions x
    where x.status in ('live', 'ended') and x.started_at is not null
      and ((x.started_at >= from_ts and x.started_at < to_ts) or (x.started_at >= prev_from and x.started_at < prev_to))
  ),
  hosts as (
    select distinct z.discord_id, z.name, ses.id, ses.cur from ses
    join lateral (
      select x.host_discord_id as discord_id, x.host_name as name from public.sessions x where x.id = ses.id and x.host_discord_id is not null
      union select h.discord_id, h.name from public.session_hosts h where h.session_id = ses.id
    ) z on true
  ),
  acts as (
    select c.moderator_discord_id as discord_id, c.moderator_name as name, (c.created_at >= from_ts) as cur
    from public.mod_cases c
    where c.status = 'done' and c.moderator_discord_id is not null
      and ((c.created_at >= from_ts and c.created_at < to_ts) or (c.created_at >= prev_from and c.created_at < prev_to))
  ),
  staff as (
    select m.discord_id,
           array(select distinct r.department from public.roles r
                 where r.id = any (m.role_ids) and r.kind in ('department', 'rank') and r.department is not null
                 order by 1) as depts
    from public.members m
    where exists (select 1 from public.roles r where r.id = any (m.role_ids) and r.kind in ('department', 'rank'))
  ),
  ids as (
    select discord_id from staff
    union select discord_id from sh union select discord_id from hosts union select discord_id from acts
  ),
  people as (
    select i.discord_id,
           coalesce(m.display_name, (select max(name) from sh where sh.discord_id = i.discord_id),
                    (select max(name) from hosts where hosts.discord_id = i.discord_id),
                    (select max(name) from acts where acts.discord_id = i.discord_id)) as name,
           m.avatar_url,
           coalesce(st.depts, '{}') as departments,
           (st.discord_id is not null) as staff,
           round(coalesce((select sum(h) from sh where sh.discord_id = i.discord_id and sh.cur), 0), 2) as hours,
           round(coalesce((select sum(h) from sh where sh.discord_id = i.discord_id and not sh.cur), 0), 2) as prev_hours,
           (select count(*) from sh where sh.discord_id = i.discord_id and sh.cur) as shifts,
           (select count(distinct id) from hosts where hosts.discord_id = i.discord_id and hosts.cur) as sessions,
           (select count(*) from acts where acts.discord_id = i.discord_id and acts.cur) as actions
    from ids i
    left join public.members m on m.discord_id = i.discord_id
    left join staff st on st.discord_id = i.discord_id
    where i.discord_id is not null
  )
  select case when not public.is_exec() then null else jsonb_build_object(
    'totals', jsonb_build_object(
      'hours', round(coalesce((select sum(h) from sh where cur), 0), 2),
      'shifts', (select count(*) from sh where cur),
      'people', (select count(distinct discord_id) from sh where cur),
      'sessions', (select count(*) from ses where cur),
      'actions', (select count(*) from acts where cur)),
    'prev', jsonb_build_object(
      'hours', round(coalesce((select sum(h) from sh where not cur), 0), 2),
      'shifts', (select count(*) from sh where not cur),
      'people', (select count(distinct discord_id) from sh where not cur),
      'sessions', (select count(*) from ses where not cur),
      'actions', (select count(*) from acts where not cur)),
    'departments', coalesce((
      select jsonb_agg(d order by d.hours desc, d.department) from (
        select sh.department,
               round(coalesce(sum(h) filter (where cur), 0), 2) as hours,
               round(coalesce(sum(h) filter (where not cur), 0), 2) as prev_hours,
               count(*) filter (where cur) as shifts,
               count(distinct discord_id) filter (where cur) as people
        from sh where sh.department is not null group by sh.department) d), '[]'),
    'people', coalesce((select jsonb_agg(p order by p.hours desc, p.name) from people p), '[]'))
  end
$$;
revoke execute on function public.activity_report(timestamptz, timestamptz, timestamptz, timestamptz) from public, anon;
grant execute on function public.activity_report(timestamptz, timestamptz, timestamptz, timestamptz) to authenticated;
