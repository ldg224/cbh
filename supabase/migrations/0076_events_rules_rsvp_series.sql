-- 0076: events, who can create what, RSVP, and recurring series (Bravo, 18 Nov 2026). Additive. Contract: rethink/EVENTS-CONTRACT.md
-- Owner decisions: drills and trainings count towards activity, socials don't (event_kinds, 0075); recurring events are
-- built but NO schedule is seeded.

-- ---------- who can create which kind (the caller) ----------
create or replace function public.event_can_create(p_kind text, p_department text default null, p_audience text default 'department')
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare k public.event_kinds; hosp boolean := coalesce(p_audience, 'department') = 'hospital';
begin
  select * into k from public.event_kinds x where x.kind = p_kind and x.active;
  if not found or public.my_discord_id() is null then return false; end if;
  if public.is_exec() then return true; end if;
  if not hosp and p_department is null then return false; end if;
  return case k.create_rule
    when 'run_sessions'  then public.can_run_sessions() and (hosp or public.directs_dept(p_department) or public.has_perm('meetings.manage', p_department) or public.has_hperm('hosp.sessions'))
    when 'dept_meetings' then not hosp and public.has_perm('meetings.manage', p_department)
    when 'dept_training' then case when hosp then public.directs_dept('Administration')
                               else public.has_perm('courses.manage', p_department) or public.has_perm('meetings.manage', p_department) end
    when 'dept_drill'    then case when hosp then public.has_hperm('hosp.sessions')
                               else public.has_perm('meetings.manage', p_department)
                                    and coalesce((select d.clinical from public.departments d where d.name = p_department), false) end
    when 'dept_social'   then case when hosp then exists (select 1 from public.my_roles() r where r.kind = 'rank'
                                    and r.department = 'Community Engagement' and r.rank_label in ('Director', 'Leader'))
                               else public.has_perm('meetings.manage', p_department) end
    when 'director'      then not hosp and public.directs_dept(p_department)
    else false end;
end $$;

-- Who may change this event (edit, cancel, go live, mark attendance): owners, its creator or host, or anyone who could
-- create that kind there.
create or replace function public.event_can_edit(p_id bigint) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare e public.events; me text := public.my_discord_id();
begin
  select * into e from public.events x where x.id = p_id;
  if not found or me is null then return false; end if;
  return public.is_exec() or e.created_by = me or e.host_discord_id = me
    or exists (select 1 from public.event_hosts h where h.event_id = p_id and h.discord_id = me)
    or public.event_can_create(e.kind, e.department, e.audience);
end $$;

-- ---------- RSVP (website: the signed-in member; bot: the service role passes the Discord ID) ----------
create or replace function public.event_rsvp(p_id bigint, p_response text, p_discord_id text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare who text := case when coalesce(auth.role(), '') = 'service_role' and p_discord_id is not null then p_discord_id else public.my_discord_id() end;
        e public.events; k public.event_kinds;
begin
  if who is null then raise exception 'Sign in to answer.'; end if;
  select * into e from public.events x where x.id = p_id;
  if not found or not public.event_visible_to(p_id, who) then raise exception 'That event isn''t there any more.'; end if;
  select * into k from public.event_kinds x where x.kind = e.kind;
  if not k.rsvp then raise exception 'This event doesn''t take replies.'; end if;
  if e.status not in ('scheduled', 'live') then raise exception 'This event has %.', case e.status when 'cancelled' then 'been cancelled' else 'ended' end; end if;
  if p_response is null then
    delete from public.event_rsvps r where r.event_id = p_id and r.discord_id = who;
  elsif p_response not in ('going', 'maybe', 'no') then
    raise exception 'Answer Going, Maybe or Can''t.';
  else
    insert into public.event_rsvps (event_id, discord_id, response) values (p_id, who, p_response)
    on conflict (event_id, discord_id) do update set response = excluded.response, at = now();
  end if;
  -- the card in Discord shows the counts: re-post it (native kinds only)
  update public.events x set post_dirty = true, post_rev = x.post_rev + 1
  where x.id = p_id and x.session_id is null and x.meeting_id is null and x.post_message_id is not null;
  return jsonb_build_object('ok', true, 'my_rsvp', p_response,
    'going', (select count(*) from public.event_rsvps r where r.event_id = p_id and r.response = 'going'),
    'maybe', (select count(*) from public.event_rsvps r where r.event_id = p_id and r.response = 'maybe'));
end $$;

-- ---------- recurring series ----------
create table if not exists public.event_series (
  id bigint generated always as identity primary key,
  kind text not null references public.event_kinds (kind),
  title text not null check (char_length(btrim(title)) between 1 and 100),
  description text check (description is null or char_length(description) <= 2000),
  department text references public.departments (name) on update cascade,
  audience text not null default 'department' check (audience in ('hospital', 'department', 'ranks')),
  audience_ranks text[],
  weekdays int[] not null check (cardinality(weekdays) between 1 and 7 and weekdays <@ array[0, 1, 2, 3, 4, 5, 6]),
  local_time time not null,
  timezone text not null default 'America/New_York',
  duration_minutes int not null default 60 check (duration_minutes between 5 and 720),
  location_kind text, location_text text,
  starts_on date not null default current_date, ends_on date,
  ping boolean not null default true,
  host_discord_id text, host_name text,
  active boolean not null default true,
  created_by text, created_by_name text, created_at timestamptz not null default now(),
  constraint event_series_department_needed check (audience = 'hospital' or department is not null));
alter table public.event_series enable row level security;
drop policy if exists event_series_read on public.event_series;
create policy event_series_read on public.event_series for select to authenticated using (
  public.is_exec() or (department is not null and public.ev_leads(public.my_discord_id(), department)) or audience = 'hospital');
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'events_series_fk') then
    alter table public.events add constraint events_series_fk foreign key (series_id) references public.event_series (id) on delete set null;
  end if;
end $$;
create unique index if not exists events_series_occurrence on public.events (series_id, starts_at) where series_id is not null;

create or replace function public.event_series_save(p jsonb) returns public.event_series
language plpgsql security definer set search_path = '' as $$
declare s public.event_series; me text := public.my_discord_id(); nm text;
  k text := p ->> 'kind'; d text := nullif(p ->> 'department', ''); a text := coalesce(p ->> 'audience', 'department');
begin
  if not public.event_can_create(k, d, a) then raise exception 'You can''t make % events here.', coalesce(k, 'these'); end if;
  select m.display_name into nm from public.members m where m.discord_id = me;
  if (p ->> 'id') is null then
    insert into public.event_series (kind, title, description, department, audience, audience_ranks, weekdays, local_time, timezone,
                                     duration_minutes, location_kind, location_text, starts_on, ends_on, ping, host_discord_id, host_name,
                                     created_by, created_by_name)
    values (k, btrim(p ->> 'title'), nullif(p ->> 'description', ''), d, a,
            case when a = 'ranks' then array(select jsonb_array_elements_text(p -> 'audience_ranks')) end,
            array(select (jsonb_array_elements_text(p -> 'weekdays'))::int), (p ->> 'local_time')::time,
            coalesce(nullif(p ->> 'timezone', ''), 'America/New_York'),
            coalesce((p ->> 'duration_minutes')::int, (select x.default_minutes from public.event_kinds x where x.kind = k)),
            nullif(p ->> 'location_kind', ''), nullif(p ->> 'location_text', ''),
            coalesce((p ->> 'starts_on')::date, current_date), (p ->> 'ends_on')::date, coalesce((p ->> 'ping')::boolean, true),
            me, nm, me, nm)
    returning * into s;
    insert into public.event_log (department, what, by_discord_id, by_name) values (d, 'Started a repeating ' || k || ': ' || s.title, me, nm);
  else
    select * into s from public.event_series x where x.id = (p ->> 'id')::bigint for update;
    if not found then raise exception 'That repeating event isn''t there any more.'; end if;
    if not (public.is_exec() or s.created_by = me or public.event_can_create(s.kind, s.department, s.audience)) then
      raise exception 'You can''t change this repeating event.';
    end if;
    update public.event_series x set title = coalesce(btrim(p ->> 'title'), x.title), description = coalesce(p ->> 'description', x.description),
      weekdays = coalesce(array(select (jsonb_array_elements_text(p -> 'weekdays'))::int), x.weekdays),
      local_time = coalesce((p ->> 'local_time')::time, x.local_time), duration_minutes = coalesce((p ->> 'duration_minutes')::int, x.duration_minutes),
      location_kind = coalesce(p ->> 'location_kind', x.location_kind), location_text = coalesce(p ->> 'location_text', x.location_text),
      ends_on = case when p ? 'ends_on' then (p ->> 'ends_on')::date else x.ends_on end, ping = coalesce((p ->> 'ping')::boolean, x.ping)
    where x.id = s.id returning * into s;
    -- future, untouched native occurrences follow the series (sessions and meetings are changed on their own pages)
    update public.events e set title = s.title, description = s.description, duration_minutes = s.duration_minutes,
      location_kind = s.location_kind, location_text = s.location_text, ping = s.ping, post_dirty = true, post_rev = e.post_rev + 1, updated_at = now()
    where e.series_id = s.id and not e.detached and e.status = 'scheduled' and e.starts_at > now() and e.session_id is null and e.meeting_id is null;
  end if;
  return s;
end $$;

create or replace function public.event_series_stop(p_id bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.event_series; me text := public.my_discord_id(); n int;
begin
  select * into s from public.event_series x where x.id = p_id for update;
  if not found then raise exception 'That repeating event isn''t there any more.'; end if;
  if not (public.is_exec() or s.created_by = me or public.event_can_create(s.kind, s.department, s.audience)) then
    raise exception 'You can''t stop this repeating event.';
  end if;
  update public.event_series x set active = false where x.id = p_id;
  with c as (update public.events e set status = 'cancelled', cancel_reason = 'The repeating event was stopped', post_dirty = true,
               post_rev = e.post_rev + 1, updated_at = now()
             where e.series_id = p_id and not e.detached and e.status = 'scheduled' and e.starts_at > now()
               and e.session_id is null and e.meeting_id is null returning 1)
  select count(*) into n from c;
  update public.sessions x set status = 'cancelled' where x.status = 'scheduled' and x.scheduled_for > now()
    and x.id in (select e.session_id from public.events e where e.series_id = p_id and not e.detached);
  update public.meetings x set status = 'cancelled', post_dirty = true, post_rev = x.post_rev + 1 where x.status = 'scheduled' and x.scheduled_for > now()
    and x.id in (select e.meeting_id from public.events e where e.series_id = p_id and not e.detached);
  return jsonb_build_object('ok', true, 'cancelled', n);
end $$;

create or replace function public.event_series_list(p_department text default null) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(to_jsonb(s) order by s.created_at desc), '[]'::jsonb) from public.event_series s
  where s.active and (p_department is null or s.department = p_department or s.audience = 'hospital')
    and (public.is_exec() or s.audience = 'hospital' or (s.department is not null and public.ev_leads(public.my_discord_id(), s.department)))
$$;

-- Creates the missing occurrences for the next p_days days (bot, hourly). Sessions become scheduled sessions rows and
-- meetings become meetings rows, so their own bot posts, Go live, join code and attendance work as today.
create or replace function public.event_series_materialize(p_days int default 14) returns int
language plpgsql security definer set search_path = '' as $$
declare s public.event_series; d date; at timestamptz; n int := 0; sid bigint; mid bigint;
begin
  for s in select * from public.event_series x where x.active loop
    for d in select g::date from generate_series(greatest(current_date, s.starts_on), current_date + least(greatest(p_days, 1), 31), interval '1 day') g loop
      continue when s.ends_on is not null and d > s.ends_on;
      continue when not (extract(dow from d)::int = any (s.weekdays));
      at := (d + s.local_time) at time zone s.timezone;
      continue when at <= now() or exists (select 1 from public.events e where e.series_id = s.id and e.starts_at = at);
      if s.kind = 'session' then
        insert into public.sessions (status, scheduled_for, host_discord_id, host_name, kind, department, note, ping, location_kind, location_text)
        values ('scheduled', at, s.host_discord_id, s.host_name, case when s.audience <> 'hospital' then 'department' else 'regular' end,
                case when s.audience <> 'hospital' then s.department end, s.title, s.ping,
                case when nullif(btrim(coalesce(s.location_text, '')), '') is null then 'discord' else coalesce(s.location_kind, 'in_game') end,
                nullif(left(btrim(coalesce(s.location_text, '')), 80), ''))
        returning id into sid;
        update public.events e set series_id = s.id where e.session_id = sid;
      elsif s.kind = 'meeting' then
        insert into public.meetings (department, title, scheduled_for, duration_minutes, location, agenda, ping, created_by, created_by_name)
        values (s.department, s.title, at, s.duration_minutes, left(s.location_text, 120), s.description, s.ping, s.created_by, s.created_by_name)
        returning id into mid;
        update public.events e set series_id = s.id where e.meeting_id = mid;
      else
        insert into public.events (kind, title, description, department, audience, audience_ranks, starts_at, ends_at, duration_minutes,
                                   location_kind, location_text, host_discord_id, host_name, ping, series_id, post_dirty, post_rev,
                                   created_by, created_by_name)
        values (s.kind, s.title, s.description, s.department, s.audience, s.audience_ranks, at, at + make_interval(mins => s.duration_minutes),
                s.duration_minutes, s.location_kind, s.location_text, s.host_discord_id, s.host_name, s.ping, s.id, true, 1,
                s.created_by, s.created_by_name);
      end if;
      n := n + 1;
    end loop;
  end loop;
  return n;
end $$;

revoke execute on function public.event_can_create(text, text, text), public.event_can_edit(bigint), public.event_rsvp(bigint, text, text),
  public.event_series_save(jsonb), public.event_series_stop(bigint), public.event_series_list(text), public.event_series_materialize(int) from public, anon;
grant execute on function public.event_can_create(text, text, text), public.event_can_edit(bigint), public.event_rsvp(bigint, text, text),
  public.event_series_save(jsonb), public.event_series_stop(bigint), public.event_series_list(text) to authenticated;
-- event_series_materialize: service role only (no grant to authenticated)
