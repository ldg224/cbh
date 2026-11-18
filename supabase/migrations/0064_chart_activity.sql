-- 0064: CBH Chart activity for quota and recognition (Alpha). Per member and department in a window:
-- cases led (opened), entries written (valid ones), SBAR handoffs, cosigns given, active days.
-- Owners see everyone; activity.view in a department sees that department; anyone else sees only themselves.
create or replace function public.chart_activity(since timestamptz, until timestamptz default now(), department text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare me text := public.my_discord_id();
begin
  if not public.chart_can_read() then raise exception 'The CBH Chart is for clinical staff and Administration.'; end if;
  if since is null then raise exception 'Give a start date.'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('discord_id', a.who, 'name', coalesce(m.display_name, a.who), 'department', a.dept,
      'cases_led', a.cases_led, 'entries', a.entries, 'handoffs', a.handoffs, 'cosigns_given', a.cosigns, 'active_days', a.days)
      order by a.dept, a.entries + a.cases_led desc)
    from (
      select x.who, x.dept, sum(x.cases_led)::int cases_led, sum(x.entries)::int entries, sum(x.handoffs)::int handoffs, sum(x.cosigns)::int cosigns,
             count(distinct x.d_day) filter (where x.d_day is not null)::int days
      from (
        select c.opened_by who, c.department dept, 1 cases_led, 0 entries, 0 handoffs, 0 cosigns, (c.opened_at at time zone 'UTC')::date as d_day
          from public.chart_cases c where c.status <> 'void' and c.opened_at >= since and c.opened_at <= until
        union all
        select e.author, e.department, 0, 1, (e.kind = 'handoff')::int, 0, (e.at at time zone 'UTC')::date
          from public.chart_entries e join public.chart_cases c on c.id = e.case_id
          where e.error_at is null and c.status <> 'void' and e.at >= since and e.at <= until
        union all
        select e.cosigned_by, e.department, 0, 0, 0, 1, null::date
          from public.chart_entries e where e.cosigned_at >= since and e.cosigned_at <= until and e.error_at is null
      ) x
      where (chart_activity.department is null or x.dept = chart_activity.department)
        and (public.is_exec() or x.who = me or public.has_perm('activity.view', x.dept))
      group by x.who, x.dept
    ) a left join public.members m on m.discord_id = a.who), '[]'::jsonb);
end $$;
revoke execute on function public.chart_activity(timestamptz, timestamptz, text) from public, anon;
grant execute on function public.chart_activity(timestamptz, timestamptz, text) to authenticated;
