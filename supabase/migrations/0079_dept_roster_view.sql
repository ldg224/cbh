-- 0079: department roster saved views (Alpha; events-plan.md §12, parked defaults §14).
-- Views: all, most_minutes, top (minutes 60% + events 25% + streak 15%), year:<rank_role_id>; periods week (Mon-Sun ET) or 30d.
-- Leaders (Director, owners, activity.view) see every view and every number. Members see 'all' and their own Year, with
-- names, ranks and who is on now; minutes/shifts/events/last active only on their own row. Rankings are leaders-only.

-- Top performing, in one place so the owner can tune the weights: each part scaled 0-1 against the best in the department.
create or replace function public.dept_top_score(minutes int, max_minutes int, events int, max_events int, streak int)
returns numeric language sql immutable set search_path = '' as $$
  select round(100 * (0.60 * case when coalesce(max_minutes, 0) > 0 then minutes::numeric / max_minutes else 0 end
                    + 0.25 * case when coalesce(max_events, 0) > 0 then events::numeric / max_events else 0 end
                    + 0.15 * least(coalesce(streak, 0), 12)::numeric / 12), 1)
$$;

create or replace function public.dept_roster_view(p_department text default null, p_view text default 'all', p_period text default 'week')
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare d text := public.dept_pick(p_department); me text := public.my_discord_id(); leader boolean := public.dept_is_leader(d) or public.has_perm('activity.view', d);
        since timestamptz; until timestamptz := now(); v text := coalesce(nullif(btrim(p_view), ''), 'all'); yr text; my_rank text; rows jsonb;
begin
  if not public.dept_can_read(d) then raise exception 'You''re not in %.', d; end if;
  if coalesce(p_period, 'week') = 'week' then since := public.dept_week_start(now()); until := since + interval '7 days';
  elsif p_period = '30d' then since := now() - interval '30 days';
  else raise exception 'Period must be week or 30d.'; end if;
  if v like 'year:%' then
    yr := substr(v, 6);
    if not exists (select 1 from public.roles r where r.id = yr and r.kind = 'rank' and r.department = d) then raise exception 'That isn''t a % rank.', d; end if;
    select r.id into my_rank from public.my_roles() r where r.kind = 'rank' and r.department = d order by r.rank_order desc nulls last limit 1;
    if not leader and yr is distinct from my_rank then raise exception 'You can see your own Year. Other Years are for leaders.'; end if;
  elsif v in ('most_minutes', 'top') then
    if not leader then raise exception 'Rankings are for leaders.'; end if;
  elsif v <> 'all' then raise exception 'Unknown view "%".', v;
  end if;

  with people as (
    select m.discord_id, m.display_name, m.avatar_url, r.id rank_role_id, r.rank_label, r.rank_order
    from public.members m
    cross join lateral (select x.id, x.rank_label, x.rank_order from public.roles x where x.id = any (m.role_ids) and x.kind = 'rank' and x.department = d
                        order by x.rank_order desc nulls last limit 1) r
    where yr is null or r.id = yr
  ), stats as (
    select p.*, public.dept_minutes(p.discord_id, d, since, until) minutes,
           (select count(*) from public.shifts s where s.discord_id = p.discord_id and s.department = d and s.started_at >= since and s.started_at < until)::int shifts,
           public.dept_events_attended(p.discord_id, d, since, until) events,
           (select max(coalesce(s.ended_at, now())) from public.shifts s where s.discord_id = p.discord_id and s.department = d) last_active,
           exists (select 1 from public.shifts s where s.discord_id = p.discord_id and s.department = d and s.status in ('active', 'break')) on_now,
           case when v = 'top' then public.dept_streak(p.discord_id, d) end streak
    from people p
  ), scored as (
    select s.*, case when v = 'top' then public.dept_top_score(s.minutes, max(s.minutes) over (), s.events, max(s.events) over (), s.streak) end score
    from stats s
  )
  select coalesce(jsonb_agg(jsonb_build_object('discord_id', x.discord_id, 'name', x.display_name, 'avatar_url', x.avatar_url, 'rank', x.rank_label,
      'rank_role_id', x.rank_role_id, 'rank_order', x.rank_order, 'on_now', x.on_now,
      'minutes', case when leader or x.discord_id = me then x.minutes end, 'shifts', case when leader or x.discord_id = me then x.shifts end,
      'events_attended', case when leader or x.discord_id = me then x.events end, 'last_active', case when leader or x.discord_id = me then x.last_active end,
      'score', x.score)
      order by case v when 'most_minutes' then -x.minutes when 'top' then -x.score else null end nulls last, x.rank_order desc nulls last, x.display_name), '[]'::jsonb)
    into rows from scored x;
  return jsonb_build_object('department', d, 'view', v, 'period', coalesce(p_period, 'week'), 'since', since, 'leader', leader, 'rows', rows);
end $$;

revoke execute on function public.dept_top_score(int, int, int, int, int) from public, anon, authenticated;
revoke execute on function public.dept_roster_view(text, text, text) from public, anon;
grant execute on function public.dept_roster_view(text, text, text) to authenticated;
