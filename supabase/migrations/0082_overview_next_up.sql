-- 0082: the department Overview redesign "Next Up" (0.34.0, Alpha; owner picked direction A, 19 Nov 2026).
-- Additive: my_department_overview(p_department) keeps every key it had (0078) and adds:
--   me.name, me.avatar_url          the header (your Discord photo, initials only when there's none)
--   my_week.days                    7 rows {day, minutes, cumulative} for this week (America/New_York, Monday first),
--                                   so the page can draw minutes over the week against the target line. Days still
--                                   to come have minutes null.
--   team                            everyone with a rank in the department: discord_id, name, avatar_url, rank,
--                                   rank_order, on_shift ('active' | 'break' | null), week_minutes. The same people and
--                                   minutes the department already sees on Roster and the Shifts leaderboard (0081,
--                                   public to the department by the owner).
--   last_shift                      the department's latest finished shift {discord_id, name, avatar_url, ended_at, minutes}
--   on_now[].avatar_url, posts[].author_avatar_url
-- Why avatars come from here: faces.js only fetches member_faces() for admins, so members saw initials everywhere.
-- Who can read it is unchanged: dept_can_read (in the department, its leaders, executives).

create or replace function public.my_department_overview(p_department text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare d text := public.dept_pick(p_department); dep public.departments; me text := public.my_discord_id(); wk timestamptz := public.dept_week_start(now());
        rk record; mins int; tgt int; feed jsonb := '[]'::jsonb; mem record; days jsonb;
begin
  if not public.dept_can_read(d) then raise exception 'You''re not in %.', d; end if;
  select * into dep from public.departments where name = d;
  select r.rank_label, r.id into rk from public.my_roles() r where r.kind = 'rank' and r.department = d order by r.rank_order desc nulls last limit 1;
  select m.display_name, m.avatar_url into mem from public.members m where m.discord_id = me;
  mins := public.dept_minutes(me, d, wk, wk + interval '7 days');
  tgt := public.dept_target_for(me, d);
  if to_regprocedure('public.events_feed(timestamptz, timestamptz, text, text[], integer)') is not null then
    begin
      execute 'select public.events_feed(p_from => $1, p_to => $2, p_department => $3, p_limit => 8)' into feed using now(), now() + interval '7 days', d;
    exception when others then feed := '[]'::jsonb;   -- What's on must never break the Overview
    end;
  end if;
  -- This week day by day (a shift counts on the day it started, like dept_minutes).
  select jsonb_agg(jsonb_build_object('day', (y.s at time zone 'America/New_York')::date, 'minutes', y.m,
           'cumulative', case when y.m is null then null else y.c end) order by y.i)
    into days
    from (select x.*, sum(coalesce(x.m, 0)) over (order by x.i) c
          from (select g.i, wk + make_interval(days => g.i) s,
                       case when wk + make_interval(days => g.i) > now() then null
                            else public.dept_minutes(me, d, wk + make_interval(days => g.i), wk + make_interval(days => g.i + 1)) end m
                from generate_series(0, 6) g(i)) x) y;

  return jsonb_build_object(
    'department', jsonb_build_object('name', dep.name, 'id', dep.id, 'color', case when dep.color is null then null else '#' || lpad(to_hex(dep.color), 6, '0') end,
                  'icon', dep.icon, 'weekly_minutes_target', dep.weekly_minutes_target,
                  'members', (select count(*) from public.members m where exists (select 1 from public.roles r where r.id = any (m.role_ids) and r.kind = 'rank' and r.department = d)),
                  'on_now', (select count(*) from public.shifts s where s.department = d and s.status in ('active', 'break'))),
    'me', jsonb_build_object('rank', rk.rank_label, 'rank_role_id', rk.id, 'can_post', public.has_perm('posts.manage', d),
                  'can_manage', public.directs_dept(d), 'leader', public.dept_is_leader(d),
                  'name', mem.display_name, 'avatar_url', mem.avatar_url),
    'posts', coalesce((select jsonb_agg(public.dept_post_json(p) || jsonb_build_object('author_avatar_url', (select m.avatar_url from public.members m where m.discord_id = p.author_discord_id))
                         order by p.pinned desc, p.created_at desc) from (
               (select * from public.department_posts x where x.department = d and x.deleted_at is null and x.pinned limit 1)
               union all
               (select * from public.department_posts x where x.department = d and x.deleted_at is null and not x.pinned order by x.created_at desc limit 3)) p), '[]'::jsonb),
    'whats_on', coalesce(feed, '[]'::jsonb),
    'my_week', jsonb_build_object('week_starts', (wk at time zone 'America/New_York')::date, 'minutes', mins, 'target', tgt,
                  'percent', case when tgt is null or tgt = 0 then null else least(999, round(100.0 * mins / tgt))::int end,
                  'shifts', (select count(*) from public.shifts s where s.discord_id = me and s.department = d and s.started_at >= wk and s.started_at < wk + interval '7 days'),
                  'sessions', (select count(distinct x.id) from public.sessions x where x.started_at is not null and exists (
                                 select 1 from public.shifts s where s.discord_id = me and s.department = d and s.started_at >= wk and s.started_at < wk + interval '7 days'
                                   and s.started_at < coalesce(x.ended_at, now()) and coalesce(s.ended_at, now()) > x.started_at)),
                  'events_attended', public.dept_events_attended(me, d, wk, wk + interval '7 days'),
                  'streak', public.dept_streak(me, d),
                  'days', coalesce(days, '[]'::jsonb)),
    'on_now', coalesce((select jsonb_agg(jsonb_build_object('discord_id', s.discord_id, 'name', coalesce(m.display_name, s.name), 'status', s.status, 'since', s.started_at,
                  'avatar_url', m.avatar_url,
                  'rank', (select r.rank_label from public.roles r where r.id = any (m.role_ids) and r.kind = 'rank' and r.department = d order by r.rank_order desc nulls last limit 1))
                  order by s.started_at)
               from public.shifts s left join public.members m on m.discord_id = s.discord_id
               where s.department = d and s.status in ('active', 'break')), '[]'::jsonb),
    'team', coalesce((select jsonb_agg(jsonb_build_object('discord_id', t.discord_id, 'name', t.display_name, 'avatar_url', t.avatar_url, 'rank', t.rank_label,
                  'rank_order', t.rank_order, 'on_shift', t.on_shift, 'week_minutes', public.dept_minutes(t.discord_id, d, wk, wk + interval '7 days'), 'me', t.discord_id = me)
                  order by t.rank_order desc nulls last, t.display_name)
               from (select m.discord_id, m.display_name, m.avatar_url, r.rank_label, r.rank_order,
                            (select s.status from public.shifts s where s.discord_id = m.discord_id and s.department = d and s.status in ('active', 'break') order by s.started_at desc limit 1) on_shift
                     from public.members m
                     cross join lateral (select x.rank_label, x.rank_order from public.roles x where x.id = any (m.role_ids) and x.kind = 'rank' and x.department = d
                                         order by x.rank_order desc nulls last limit 1) r) t), '[]'::jsonb),
    'last_shift', (select jsonb_build_object('discord_id', s.discord_id, 'name', coalesce(m.display_name, s.name), 'avatar_url', m.avatar_url,
                  'ended_at', s.ended_at, 'minutes', (public.shift_seconds(s) / 60)::int)
               from public.shifts s left join public.members m on m.discord_id = s.discord_id
               where s.department = d and s.status = 'ended' and s.ended_at is not null order by s.ended_at desc limit 1));
end $$;

revoke execute on function public.my_department_overview(text) from public, anon;
grant execute on function public.my_department_overview(text) to authenticated;
