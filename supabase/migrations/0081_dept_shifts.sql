-- 0081: the department Shifts page (0.33.0, Bravo): one read, dept_shifts(department, part, period, metric), for the three
-- toggles On now / This week / Leaderboard. Builds on 0078 (dept_pick, dept_can_read, dept_is_leader, dept_week_start,
-- dept_target_for, dept_minutes, dept_events_attended, dept_streak) and 0079 (dept_top_score).
--
-- Who sees what (enforced here, not just on the page):
--   now          everyone who can read the department: who is on shift or on break, since when, worked minutes so far.
--   week         everyone: their own week (minutes vs target, their own shifts). Leaders also get every shift in the
--                department this week and each person's minutes vs their target.
--   leaderboard  everyone in the department (the owner made it public, 19 Nov 2026): the full ranked list (metric minutes
--                or top, period week or 30d), plus the caller's own place ("4th of 12").
-- Leaders = dept_is_leader (Director, activity.view, members.edit) or an executive.

create or replace function public.dept_shifts(p_department text default null, p_part text default 'now',
                                              p_period text default 'week', p_metric text default 'minutes')
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare d text := public.dept_pick(p_department); me text := public.my_discord_id();
        leader boolean := public.dept_is_leader(d) or public.is_exec();
        part text := coalesce(nullif(btrim(p_part), ''), 'now'); metric text := coalesce(nullif(btrim(p_metric), ''), 'minutes');
        wk timestamptz := public.dept_week_start(now()); since timestamptz; until timestamptz; out jsonb; board jsonb; mine jsonb;
begin
  if not public.dept_can_read(d) then raise exception 'You''re not in %.', d; end if;

  if part = 'now' then
    return jsonb_build_object('department', d, 'part', part, 'leader', leader,
      'rows', coalesce((select jsonb_agg(jsonb_build_object('discord_id', s.discord_id, 'name', coalesce(m.display_name, s.name), 'avatar_url', m.avatar_url,
                  'rank', (select r.rank_label from public.roles r where r.id = any (m.role_ids) and r.kind = 'rank' and r.department = d order by r.rank_order desc nulls last limit 1),
                  'status', s.status, 'since', s.started_at, 'break_since', case when s.status = 'break' then s.break_started_at end,
                  'minutes', (public.shift_seconds(s) / 60)::int, 'me', s.discord_id = me)
                  order by s.status, s.started_at)
               from public.shifts s left join public.members m on m.discord_id = s.discord_id
               where s.department = d and s.status in ('active', 'break')), '[]'::jsonb));
  end if;

  if part = 'week' then
    since := wk; until := wk + interval '7 days';
    mine := jsonb_build_object('minutes', public.dept_minutes(me, d, since, until), 'target', public.dept_target_for(me, d),
              'shifts', (select count(*) from public.shifts s where s.discord_id = me and s.department = d and s.started_at >= since and s.started_at < until));
    out := jsonb_build_object('department', d, 'part', part, 'leader', leader,
      'week_starts', (wk at time zone 'America/New_York')::date, 'me', mine,
      'log', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'discord_id', s.discord_id, 'name', coalesce(m.display_name, s.name), 'avatar_url', m.avatar_url,
                  'status', s.status, 'started_at', s.started_at, 'ended_at', s.ended_at, 'ended_by', case when s.ended_by in ('self', 'auto') then s.ended_by when s.ended_by is null then null else 'staff' end,
                  'minutes', (public.shift_seconds(s) / 60)::int, 'break_minutes', ((s.break_seconds + case when s.status = 'break' and s.break_started_at is not null
                      then extract(epoch from (now() - s.break_started_at))::int else 0 end) / 60)::int, 'me', s.discord_id = me)
                  order by s.started_at desc)
               from public.shifts s left join public.members m on m.discord_id = s.discord_id
               where s.department = d and s.started_at >= since and s.started_at < until and (leader or s.discord_id = me)), '[]'::jsonb));
    if leader then
      out := out || jsonb_build_object('people', coalesce((select jsonb_agg(x.j order by x.mins desc, x.nm) from (
          select p.display_name nm, public.dept_minutes(p.discord_id, d, since, until) mins,
                 jsonb_build_object('discord_id', p.discord_id, 'name', p.display_name, 'avatar_url', p.avatar_url, 'rank', p.rank_label,
                   'minutes', public.dept_minutes(p.discord_id, d, since, until), 'target', public.dept_target_for(p.discord_id, d),
                   'shifts', (select count(*) from public.shifts s where s.discord_id = p.discord_id and s.department = d and s.started_at >= since and s.started_at < until)) j
          from (select m.discord_id, m.display_name, m.avatar_url, r.rank_label
                from public.members m
                cross join lateral (select x.rank_label from public.roles x where x.id = any (m.role_ids) and x.kind = 'rank' and x.department = d
                                    order by x.rank_order desc nulls last limit 1) r) p) x), '[]'::jsonb));
    end if;
    return out;
  end if;

  if part = 'leaderboard' then
    if metric not in ('minutes', 'top') then raise exception 'Metric must be minutes or top.'; end if;
    if coalesce(p_period, 'week') = 'week' then since := wk; until := wk + interval '7 days';
    elsif p_period = '30d' then since := now() - interval '30 days'; until := now();
    else raise exception 'Period must be week or 30d.'; end if;
    with people as (
      select m.discord_id, m.display_name, m.avatar_url, r.rank_label, r.rank_order
      from public.members m
      cross join lateral (select x.rank_label, x.rank_order from public.roles x where x.id = any (m.role_ids) and x.kind = 'rank' and x.department = d
                          order by x.rank_order desc nulls last limit 1) r
    ), stats as (
      select p.*, public.dept_minutes(p.discord_id, d, since, until) minutes,
             (select count(*) from public.shifts s where s.discord_id = p.discord_id and s.department = d and s.started_at >= since and s.started_at < until)::int shifts,
             public.dept_events_attended(p.discord_id, d, since, until) events,
             case when metric = 'top' then public.dept_streak(p.discord_id, d) end streak
      from people p
    ), scored as (
      select s.*, case when metric = 'top' then public.dept_top_score(s.minutes, max(s.minutes) over (), s.events, max(s.events) over (), s.streak) end score
      from stats s
    ), placed as (
      -- Only people with something to rank are placed; ties share a place.
      select x.*, case when (case metric when 'top' then coalesce(x.score, 0) else x.minutes end) > 0
                       then rank() over (order by case metric when 'top' then coalesce(x.score, 0) else x.minutes end desc) end place
      from scored x
    )
    select jsonb_build_object(
             'of', count(*),
             'ranked', count(*) filter (where pl.place is not null),
             'me', (select jsonb_build_object('place', y.place, 'minutes', y.minutes, 'shifts', y.shifts, 'events_attended', y.events, 'score', y.score)
                    from placed y where y.discord_id = me),
             'rows', coalesce(jsonb_agg(jsonb_build_object('discord_id', pl.discord_id, 'name', pl.display_name, 'avatar_url', pl.avatar_url,
                        'rank', pl.rank_label, 'place', pl.place, 'minutes', pl.minutes, 'shifts', pl.shifts, 'events_attended', pl.events, 'score', pl.score,
                        'me', pl.discord_id = me)
                        order by pl.place nulls last, pl.rank_order desc nulls last, pl.display_name), '[]'::jsonb))
      into board from placed pl;
    return jsonb_build_object('department', d, 'part', part, 'leader', leader, 'metric', metric, 'period', coalesce(p_period, 'week'), 'since', since) || board;
  end if;

  raise exception 'Unknown part "%".', part;
end $$;

revoke execute on function public.dept_shifts(text, text, text, text) from public, anon;
grant execute on function public.dept_shifts(text, text, text, text) to authenticated;
