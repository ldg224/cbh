-- 0070: CBH Chart v2 + Check-in metrics, feedback list and expiry (Alpha). Contract: Plans/CareBeyond/chart/CHECKIN-CONTRACT.md.

-- Mark check-ins as "left" when nobody is running a session (15 min with no live session) or after 3 hours of waiting. Bot, every few minutes.
create or replace function public.checkin_expire()
returns integer language plpgsql security definer set search_path = '' as $$
declare n int := 0; k record; quiet boolean;
begin
  if not public.chart_is_service() and current_user not in ('postgres', 'service_role') then raise exception 'Only the bot can do that.'; end if;
  quiet := public.checkin_live_session() is null
           and coalesce((select max(coalesce(x.ended_at, x.started_at)) from public.sessions x where x.status in ('live', 'ended')), '-infinity') < now() - interval '15 minutes';
  for k in select * from public.chart_checkins where state in ('waiting', 'claimed') and (quiet or created_at < now() - interval '3 hours') loop
    update public.chart_checkins set state = 'left', ended_at = now(),
           ended_reason = case when quiet then 'The session ended before you were seen' else 'Waited more than 3 hours' end where id = k.id;
    update public.chart_cases set status = 'closed', disposition = 'lwbs', closed_at = now(), last_at = now() where id = k.case_id;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public.checkin_expire() from public, anon, authenticated;
grant execute on function public.checkin_expire() to service_role;


create or replace function public.checkin_metrics(since timestamptz, until timestamptz default now(), department text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare me text := public.my_discord_id();
begin
  if not public.chart_can_read() then raise exception 'Check-in numbers are for clinical staff and Administration.'; end if;
  if since is null then raise exception 'Give a start date.'; end if;
  return jsonb_build_object(
    'departments', coalesce((select jsonb_agg(jsonb_build_object('department', d.dept, 'checkins', d.n, 'discharged', d.dis, 'left', d.lft, 'cancelled', d.can,
          'avg_door_to_claim_min', d.d2c, 'avg_claim_to_room_min', d.c2r,
          'avg_rating', case when public.checkin_sees_ratings(d.dept) then d.rat end, 'ratings', case when public.checkin_sees_ratings(d.dept) then d.nrat end) order by d.dept)
      from (select coalesce(case when k.claimed_by is not null then c.department end, 'Unassigned') dept, count(*) n,
                   count(*) filter (where k.state = 'discharged') dis, count(*) filter (where k.state = 'left') lft, count(*) filter (where k.state = 'cancelled') can,
                   round((avg(extract(epoch from k.claimed_at - k.created_at)) / 60)::numeric, 1) d2c,
                   round((avg(extract(epoch from k.in_room_at - k.claimed_at)) / 60)::numeric, 1) c2r,
                   round(avg(k.rating)::numeric, 2) rat, count(k.rating) nrat
            from public.chart_checkins k join public.chart_cases c on c.id = k.case_id
            where k.created_at >= since and k.created_at <= until
            group by 1) d
      where (checkin_metrics.department is null or d.dept = checkin_metrics.department)
        and (public.is_exec() or public.has_perm('activity.view', d.dept))), '[]'::jsonb),
    'staff', coalesce((select jsonb_agg(jsonb_build_object('discord_id', s.who, 'name', public.checkin_name(s.who), 'department', s.dept, 'taken', s.n,
          'discharged', s.dis, 'avg_door_to_claim_min', s.d2c,
          'avg_rating', case when s.who = me or public.checkin_sees_ratings(s.dept) then s.rat end, 'ratings', case when s.who = me or public.checkin_sees_ratings(s.dept) then s.nrat end) order by s.dept, s.n desc)
      from (select k.claimed_by who, c.department dept, count(*) n, count(*) filter (where k.state = 'discharged') dis,
                   round((avg(extract(epoch from k.claimed_at - k.created_at)) / 60)::numeric, 1) d2c, round(avg(k.rating)::numeric, 2) rat, count(k.rating) nrat
            from public.chart_checkins k join public.chart_cases c on c.id = k.case_id
            where k.claimed_by is not null and k.created_at >= since and k.created_at <= until
            group by 1, 2) s
      where (checkin_metrics.department is null or s.dept = checkin_metrics.department)
        and (public.is_exec() or s.who = me or public.has_perm('activity.view', s.dept))), '[]'::jsonb));
end $$;

create or replace function public.checkin_feedback_list(since timestamptz, department text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not (public.is_exec() or exists (select 1 from public.chart_my_depts() x where x.rank >= 6)) then raise exception 'Patient feedback is for Directors and owners.'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('checkin_id', k.id, 'case_id', k.case_id, 'rating', k.rating, 'comment', k.comment,
      'staff_name', k.claimed_by_name, 'department', c.department, 'at', k.rated_at) order by k.rated_at desc)
    from public.chart_checkins k join public.chart_cases c on c.id = k.case_id
    where k.rating is not null and k.rated_at >= since and (checkin_feedback_list.department is null or c.department = checkin_feedback_list.department)
      and public.checkin_sees_ratings(c.department)), '[]'::jsonb);
end $$;

-- My own patient rating (staff): average and count only, never the comments.
create or replace function public.checkin_my_rating(since timestamptz default null)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('avg_rating', round(avg(k.rating)::numeric, 2), 'ratings', count(k.rating), 'patients', count(*))
  from public.chart_checkins k
  where k.claimed_by = public.my_discord_id() and k.state = 'discharged' and (since is null or k.ended_at >= since)
$$;

do $g$
declare f text;
begin
  foreach f in array array['checkin_metrics(timestamptz, timestamptz, text)', 'checkin_feedback_list(timestamptz, text)', 'checkin_my_rating(timestamptz)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $g$;
