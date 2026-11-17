-- 0016: home page redesign (0.14.0): per-person pins, one call for every live count on the home page, and the
-- global people search. Database only; no bot change.

-- ---------- pins ----------
create table if not exists public.user_prefs (
  discord_id  text primary key,
  pins        jsonb not null default '{"enabled": true, "count": 4, "items": []}'::jsonb,
  updated_at  timestamptz not null default now()
);
alter table public.user_prefs enable row level security;
revoke all on public.user_prefs from anon, authenticated;   -- only through the functions below

create or replace function public.get_my_prefs() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce((select jsonb_build_object('pins', p.pins) from public.user_prefs p
                   where p.discord_id = public.my_discord_id()),
                  jsonb_build_object('pins', '{"enabled": true, "count": 4, "items": []}'::jsonb))
$$;

create or replace function public.set_my_pins(pins jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me text := public.my_discord_id(); n int;
begin
  if me is null or not public.is_member() then raise exception 'Log in first'; end if;
  if jsonb_typeof(pins) <> 'object' or jsonb_typeof(pins -> 'enabled') <> 'boolean'
     or jsonb_typeof(pins -> 'count') <> 'number' or jsonb_typeof(pins -> 'items') <> 'array' then
    raise exception 'Pins need enabled, count and items';
  end if;
  n := (pins ->> 'count')::int;
  if n < 2 or n > 7 then raise exception 'Show between 2 and 7 pins'; end if;
  if jsonb_array_length(pins -> 'items') > 7 then raise exception 'You can pin up to 7 tools'; end if;
  if exists (select 1 from jsonb_array_elements(pins -> 'items') x
             where jsonb_typeof(x) <> 'string' or char_length(x #>> '{}') not between 1 and 60) then
    raise exception 'Each pin must be a tool name';
  end if;
  insert into public.user_prefs (discord_id, pins, updated_at)
  values (me, jsonb_build_object('enabled', pins -> 'enabled', 'count', n, 'items', pins -> 'items'), now())
  on conflict (discord_id) do update set pins = excluded.pins, updated_at = now();
  return public.get_my_prefs();
end $$;

revoke execute on function public.get_my_prefs(), public.set_my_pins(jsonb) from public, anon;
grant execute on function public.get_my_prefs(), public.set_my_pins(jsonb) to authenticated;

-- ---------- home counts ----------
create or replace function public.home_counts() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me text := public.my_discord_id();
  is_mem boolean := public.is_member();
  staff boolean := public.is_team();
  adm boolean := public.is_admin();
  ex boolean := public.is_exec();
  week_start timestamptz := date_trunc('week', now() at time zone 'Australia/Sydney') at time zone 'Australia/Sydney';
  day_start timestamptz := date_trunc('day', now() at time zone 'Australia/Sydney') at time zone 'Australia/Sydney';
  code text := (select s.value #>> '{}' from public.settings s where s.key = 'join_code');
  out jsonb;
begin
  if not is_mem then return null; end if;
  out := jsonb_build_object(
    'session', jsonb_build_object(
      'live', (select jsonb_build_object('id', x.id, 'host_name', x.host_name, 'started_at', x.started_at,
                                         'join_code', coalesce(x.join_code, code), 'note', x.note)
               from public.sessions x where x.status = 'live' order by x.started_at desc limit 1),
      'next', (select jsonb_build_object('id', x.id, 'scheduled_for', x.scheduled_for, 'host_name', x.host_name, 'note', x.note)
               from public.sessions x where x.status = 'scheduled' and x.scheduled_for > now()
               order by x.scheduled_for limit 1),
      'code', code),
    'last_session_ended_at', (select max(x.ended_at) from public.sessions x where x.status = 'ended'),
    'members_total', (select count(*) from public.members),
    'my_shift', (select jsonb_build_object('id', s.id, 'status', s.status, 'department', s.department,
                                           'started_at', s.started_at, 'break_seconds', s.break_seconds,
                                           'break_started_at', s.break_started_at)
                 from public.shifts s where s.discord_id = me and s.status <> 'ended' limit 1),
    'my_week_hours', coalesce((select round(sum(public.shift_seconds(s)) / 3600.0, 2) from public.shifts s
                               where s.discord_id = me and s.started_at >= week_start), 0),
    'failed_mine', (select count(*) from public.mod_cases c where c.status = 'failed'
                    and c.moderator_discord_id = me and c.dismissed_at is null),
    'apps_waiting', (select count(*) from public.form_submissions f
                     where f.status = 'pending' and public.can_review_form(f.form_key)),
    'apps_oldest_at', (select min(f.created_at) from public.form_submissions f
                       where f.status = 'pending' and public.can_review_form(f.form_key)),
    'tickets_open', (select count(*) from public.tickets t where t.status <> 'closed' and public.leads_team(t.team)),
    'tickets_latest', (select jsonb_build_object('id', t.id, 'subject', t.subject, 'name', t.opener_name, 'team', t.team)
                       from public.tickets t where t.status <> 'closed' and public.leads_team(t.team)
                       order by t.created_at desc limit 1),
    -- staff and above
    'on_shift', case when staff then (
        select jsonb_build_object(
          'total', count(*),
          'on_break', count(*) filter (where s.status = 'break'),
          'by_dept', coalesce((select jsonb_object_agg(d.department, d.n) from (
                       select x.department, count(*) n from public.shifts x where x.status <> 'ended'
                       group by x.department) d), '{}'::jsonb),
          'people', coalesce((select jsonb_agg(p) from (
                       select coalesce(m.display_name, x.name) as name, m.avatar_url, x.department, x.status
                       from public.shifts x left join public.members m on m.discord_id = x.discord_id
                       where x.status <> 'ended' order by x.started_at limit 6) p), '[]'::jsonb))
        from public.shifts s where s.status <> 'ended') else null end,
    'dept_members', case when staff then coalesce((select jsonb_object_agg(d.department, d.n) from (
        select r.department, count(distinct m.discord_id) n from public.members m
        join public.roles r on r.id = any (m.role_ids)
        where r.kind in ('department', 'rank') and r.department is not null group by r.department) d), '{}'::jsonb)
      else null end,
    'dept_on_now', case when staff then coalesce((select jsonb_object_agg(d.department, d.n) from (
        select x.department, count(*) n from public.shifts x where x.status <> 'ended' group by x.department) d), '{}'::jsonb)
      else null end,
    -- admins
    'actions_week', case when adm then (select count(*) from public.mod_cases c
        where c.status = 'done' and c.revoked_at is null and c.created_at >= now() - interval '7 days') else null end,
    'active_warnings', case when adm then (select count(*) from public.mod_cases c
        where c.action = 'warn' and c.status = 'done' and c.revoked_at is null) else null end,
    'logs_today', case when adm then (select jsonb_build_object(
        'deleted', count(*) filter (where l.type = 'message_delete'),
        'edited', count(*) filter (where l.type = 'message_edit'),
        'joins_leaves', count(*) filter (where l.type in ('member_join', 'member_leave')),
        'roles', count(*) filter (where l.type in ('roles_change', 'nickname_change')))
        from public.discord_logs l where l.at >= day_start) else null end,
    -- execs
    'hospital_hours_week', case when ex then coalesce((select round(sum(public.shift_seconds(s)) / 3600.0, 2)
        from public.shifts s where s.started_at >= week_start), 0) else null end
  );
  return out;
end $$;
revoke execute on function public.home_counts() from public, anon;
grant execute on function public.home_counts() to authenticated;

-- ---------- global people search (staff and above) ----------
create or replace function public.people_search(q text)
returns table (discord_id text, display_name text, username text, avatar_url text, summary text, on_shift boolean,
               warnings integer)
language sql stable security definer set search_path = '' as $$
  with term as (select trim(q) as t)
  select m.discord_id, m.display_name, m.username, m.avatar_url,
    (select string_agg(x.label, ' · ' order by x.ord desc) from (
       select case when r.kind = 'rank' then r.department || ' ' || r.rank_label else r.name end as label,
              case r.kind when 'leadership' then 1000 + r.position when 'executive' then 900
                          else coalesce(r.rank_order, 0) end as ord
       from public.roles r where r.id = any (m.role_ids) and r.kind in ('leadership', 'executive', 'rank')) x),
    exists (select 1 from public.shifts s where s.discord_id = m.discord_id and s.status <> 'ended'),
    case when public.is_admin() then (select count(*)::integer from public.mod_cases c
      where c.target_discord_id = m.discord_id and c.action = 'warn' and c.status = 'done' and c.revoked_at is null)
    else null end
  from public.members m
  where public.is_team() and char_length((select t from term)) >= 1
    and (m.discord_id = (select t from term) or m.display_name ilike '%' || (select t from term) || '%'
         or m.username ilike '%' || (select t from term) || '%')
  order by case when m.discord_id = (select t from term) then 0
                when m.display_name ilike (select t from term) || '%' or m.username ilike (select t from term) || '%' then 1
                else 2 end, m.display_name
  limit 8
$$;
revoke execute on function public.people_search(text) from public, anon;
grant execute on function public.people_search(text) to authenticated;
