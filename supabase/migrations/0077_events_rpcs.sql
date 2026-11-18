-- 0077: events, the website RPCs (Bravo, 18 Nov 2026). Additive. Contract: rethink/EVENTS-CONTRACT.md
-- events_feed / my_whats_on / event_get / event_kinds_list / event_save (routes sessions and meetings to their own tables)
-- / event_cancel / event_set_status / event_attendance_mark, plus event_set_post for the bot.

-- The event object (as the contract), for the caller.
create or replace function public.event_json(p_id bigint) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', e.id, 'kind', e.kind, 'kind_label', k.label, 'kind_icon', k.icon, 'kind_colour', k.colour,
    'title', e.title, 'description', e.description, 'department', e.department, 'audience', e.audience, 'audience_ranks', e.audience_ranks,
    'starts_at', e.starts_at, 'ends_at', coalesce(e.ends_at, e.starts_at + make_interval(mins => e.duration_minutes)),
    'duration_minutes', e.duration_minutes, 'status', e.status, 'cancel_reason', e.cancel_reason,
    'location_kind', e.location_kind, 'location_text', e.location_text, 'host_name', e.host_name, 'host_discord_id', e.host_discord_id,
    'series_id', e.series_id, 'session_id', e.session_id, 'meeting_id', e.meeting_id,
    'going', (select count(*) from public.event_rsvps r where r.event_id = e.id and r.response = 'going'),
    'maybe', (select count(*) from public.event_rsvps r where r.event_id = e.id and r.response = 'maybe'),
    'my_rsvp', (select r.response from public.event_rsvps r where r.event_id = e.id and r.discord_id = public.my_discord_id()),
    'attended', (select a.status from public.event_attendance a where a.event_id = e.id and a.discord_id = public.my_discord_id()),
    'rsvp', k.rsvp, 'attendance', k.attendance, 'counts_activity', k.counts_activity,
    'can_edit', public.event_can_edit(e.id),
    'can_rsvp', k.rsvp and e.status in ('scheduled', 'live'),
    'join_code', case when e.kind = 'session' and (e.status = 'live' or (e.status = 'scheduled' and e.starts_at <= now() + interval '30 minutes'))
                      then (select s.join_code from public.sessions s where s.id = e.session_id) end)
  from public.events e join public.event_kinds k on k.kind = e.kind
  where e.id = p_id
$$;

create or replace function public.events_feed(p_from timestamptz default now() - interval '2 hours', p_to timestamptz default now() + interval '14 days',
  p_department text default null, p_kinds text[] default null, p_limit int default 50) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(public.event_json(x.id) order by x.starts_at, x.id), '[]'::jsonb)
  from (select e.id, e.starts_at from public.events e
        where coalesce(e.ends_at, e.starts_at + make_interval(mins => e.duration_minutes)) >= coalesce(p_from, now() - interval '2 hours')
          and e.starts_at <= coalesce(p_to, now() + interval '14 days')
          and (p_department is null or e.department = p_department or e.audience = 'hospital')
          and (case when p_kinds is null then e.status <> 'cancelled' else e.kind = any (p_kinds) end)
          and public.event_visible_to(e.id, public.my_discord_id())
        order by e.starts_at, e.id
        limit least(greatest(coalesce(p_limit, 50), 1), 200)) x
$$;

-- Next N days for Home: all my departments and hospital-wide (events_feed already filters what I may see).
create or replace function public.my_whats_on(p_days int default 7) returns jsonb
language sql stable security definer set search_path = '' as $$
  select public.events_feed(now() - interval '2 hours', now() + make_interval(days => least(greatest(coalesce(p_days, 7), 1), 31)), null, null, 20)
$$;

create or replace function public.event_get(p_id bigint) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare e public.events; me text := public.my_discord_id(); lead boolean;
begin
  select * into e from public.events x where x.id = p_id;
  if not found or not public.event_visible_to(p_id, me) then raise exception 'That event isn''t there any more.'; end if;
  lead := public.event_can_edit(p_id) or (e.department is not null and public.ev_leads(me, e.department));
  return public.event_json(p_id) || jsonb_build_object(
    'hosts', (select coalesce(jsonb_agg(jsonb_build_object('discord_id', h.discord_id, 'name', h.name)), '[]') from public.event_hosts h where h.event_id = p_id),
    'rsvps', case when lead then (select coalesce(jsonb_agg(jsonb_build_object('discord_id', r.discord_id, 'name', m.display_name, 'response', r.response) order by r.at), '[]')
                                  from public.event_rsvps r left join public.members m on m.discord_id = r.discord_id where r.event_id = p_id) end,
    'attendance', case when lead then (select coalesce(jsonb_agg(jsonb_build_object('discord_id', a.discord_id, 'name', m.display_name, 'status', a.status, 'guest', a.guest)), '[]')
                                       from public.event_attendance a left join public.members m on m.discord_id = a.discord_id where a.event_id = p_id) end,
    'series', (select to_jsonb(s) from public.event_series s where s.id = e.series_id));
end $$;

create or replace function public.event_kinds_list(p_department text default null) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('kind', k.kind, 'label', k.label, 'icon', k.icon, 'colour', k.colour, 'rsvp', k.rsvp,
    'attendance', k.attendance, 'counts_activity', k.counts_activity, 'default_minutes', k.default_minutes,
    'can_create_department', p_department is not null and public.event_can_create(k.kind, p_department, 'department'),
    'can_create_hospital', public.event_can_create(k.kind, null, 'hospital')) order by k.sort), '[]'::jsonb)
  from public.event_kinds k where k.active
$$;

-- Create or edit. Sessions → a scheduled sessions row (the caller hosts; the same rules as today); meetings → meeting_save;
-- everything else → events. Editing one occurrence of a series marks it detached.
create or replace function public.event_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me text := public.my_discord_id(); nm text; e public.events; k public.event_kinds;
  v_id bigint := (p ->> 'id')::bigint; v_kind text := p ->> 'kind'; v_dept text := nullif(p ->> 'department', '');
  v_aud text := coalesce(nullif(p ->> 'audience', ''), case when nullif(p ->> 'department', '') is null then 'hospital' else 'department' end);
  v_title text := btrim(coalesce(p ->> 'title', '')); v_start timestamptz := (p ->> 'starts_at')::timestamptz;
  v_mins int; v_ranks text[]; sid bigint; m public.meetings;
begin
  if me is null then raise exception 'Sign in first.'; end if;
  select m2.display_name into nm from public.members m2 where m2.discord_id = me;
  if v_id is not null then
    select * into e from public.events x where x.id = v_id for update;
    if not found then raise exception 'That event isn''t there any more.'; end if;
    if not public.event_can_edit(v_id) then raise exception 'You can''t change this event.'; end if;
    v_kind := e.kind; v_dept := e.department; v_aud := e.audience;   -- kind, department and audience don't move
  elsif not public.event_can_create(v_kind, v_dept, v_aud) then
    raise exception 'You can''t make % events here.', coalesce((select x.label from public.event_kinds x where x.kind = v_kind), 'these');
  end if;
  select * into k from public.event_kinds x where x.kind = v_kind;
  if char_length(v_title) = 0 or char_length(v_title) > 100 then raise exception 'Give it a title (up to 100 characters).'; end if;
  if v_start is null then raise exception 'Pick a date and time.'; end if;
  v_mins := coalesce((p ->> 'duration_minutes')::int, case when v_id is not null then e.duration_minutes end, k.default_minutes);
  if v_aud = 'ranks' then
    v_ranks := array(select jsonb_array_elements_text(p -> 'audience_ranks'));
    if coalesce(cardinality(v_ranks), 0) = 0 then raise exception 'Pick at least one rank.'; end if;
    if exists (select 1 from unnest(v_ranks) x where not exists (select 1 from public.roles r where r.id = x and r.kind = 'rank' and r.department = v_dept)) then
      raise exception 'Only % ranks can be picked.', v_dept; end if;
  end if;

  if v_kind = 'session' then
    if v_id is null then
      insert into public.sessions (status, scheduled_for, host_discord_id, host_name, kind, department, note, ping, location_kind, location_text)
      values ('scheduled', v_start, me, nm, case when v_dept is not null then 'department' else 'regular' end, v_dept, left(v_title, 100),
              coalesce((p ->> 'ping')::boolean, true), case when nullif(btrim(coalesce(p ->> 'location_text', '')), '') is null then 'discord' else coalesce(nullif(p ->> 'location_kind', ''), 'in_game') end,
              nullif(left(btrim(coalesce(p ->> 'location_text', '')), 80), ''))
      returning id into sid;
    else
      update public.sessions x set scheduled_for = v_start, note = left(v_title, 100), ping = coalesce((p ->> 'ping')::boolean, x.ping),
        location_text = coalesce(nullif(left(p ->> 'location_text', 80), ''), x.location_text)
      where x.id = e.session_id and x.status = 'scheduled' returning id into sid;
      if sid is null then raise exception 'Only a session that hasn''t started can be changed.'; end if;
    end if;
    select * into e from public.events x where x.session_id = sid;
  elsif v_kind = 'meeting' then
    m := public.meeting_save(case when v_id is not null then e.meeting_id end, v_dept, v_title, v_start, v_mins,
                             nullif(p ->> 'location_text', ''), nullif(p ->> 'description', ''), coalesce((p ->> 'ping')::boolean, true));
    select * into e from public.events x where x.meeting_id = m.id;
  elsif v_id is null then
    if v_start < now() - interval '5 minutes' then raise exception 'Pick a time in the future.'; end if;
    insert into public.events (kind, title, description, department, audience, audience_ranks, starts_at, ends_at, duration_minutes,
                               location_kind, location_text, host_discord_id, host_name, ping, post_dirty, post_rev, created_by, created_by_name)
    values (v_kind, v_title, nullif(p ->> 'description', ''), v_dept, v_aud, v_ranks, v_start, v_start + make_interval(mins => v_mins), v_mins,
            nullif(p ->> 'location_kind', ''), nullif(left(p ->> 'location_text', 120), ''), me, nm, coalesce((p ->> 'ping')::boolean, true),
            true, 1, me, nm)
    returning * into e;
    insert into public.event_log (event_id, department, what, by_discord_id, by_name) values (e.id, v_dept, 'Planned ' || k.label || ': ' || v_title, me, nm);
  else
    if e.status <> 'scheduled' then raise exception 'Only an event that hasn''t started can be changed.'; end if;
    update public.events x set title = v_title, description = nullif(p ->> 'description', ''), starts_at = v_start,
      ends_at = v_start + make_interval(mins => v_mins), duration_minutes = v_mins,
      audience_ranks = case when v_aud = 'ranks' then v_ranks else x.audience_ranks end,
      location_kind = nullif(p ->> 'location_kind', ''), location_text = nullif(left(p ->> 'location_text', 120), ''),
      ping = coalesce((p ->> 'ping')::boolean, x.ping), detached = x.series_id is not null,
      reminder_sent = case when v_start <> x.starts_at then false else x.reminder_sent end,
      post_dirty = true, post_rev = x.post_rev + 1, updated_at = now()
    where x.id = v_id returning * into e;
    insert into public.event_log (event_id, department, what, by_discord_id, by_name) values (e.id, v_dept, 'Changed ' || k.label || ': ' || v_title, me, nm);
  end if;
  if v_id is not null and e.series_id is not null then update public.events x set detached = true where x.id = e.id; end if;
  return public.event_json(e.id);
end $$;

create or replace function public.event_cancel(p_id bigint, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare e public.events; me text := public.my_discord_id();
begin
  select * into e from public.events x where x.id = p_id for update;
  if not found then raise exception 'That event isn''t there any more.'; end if;
  if not public.event_can_edit(p_id) then raise exception 'You can''t cancel this event.'; end if;
  if e.status <> 'scheduled' then raise exception 'Only an event that hasn''t started can be cancelled.'; end if;
  if e.session_id is not null then
    update public.sessions x set status = 'cancelled' where x.id = e.session_id and x.status = 'scheduled';
  elsif e.meeting_id is not null then
    perform public.meeting_set_status(e.meeting_id, 'cancelled');
  else
    update public.events x set status = 'cancelled', cancel_reason = nullif(left(p_reason, 200), ''), post_dirty = true, post_rev = x.post_rev + 1,
      updated_at = now() where x.id = p_id;
  end if;
  update public.events x set cancel_reason = coalesce(x.cancel_reason, nullif(left(p_reason, 200), '')) where x.id = p_id;
  insert into public.event_log (event_id, department, what, by_discord_id, by_name)
  values (p_id, e.department, 'Cancelled: ' || e.title, me, (select m.display_name from public.members m where m.discord_id = me));
  return public.event_json(p_id);
end $$;

-- Native kinds only: Start (live) and End. Sessions and meetings keep their own buttons.
create or replace function public.event_set_status(p_id bigint, p_status text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare e public.events;
begin
  select * into e from public.events x where x.id = p_id for update;
  if not found then raise exception 'That event isn''t there any more.'; end if;
  if e.session_id is not null or e.meeting_id is not null then raise exception 'Use the session or meeting buttons for this one.'; end if;
  if not public.event_can_edit(p_id) then raise exception 'You can''t run this event.'; end if;
  if not ((e.status = 'scheduled' and p_status = 'live') or (e.status = 'live' and p_status = 'ended')) then
    raise exception 'This event is % already.', e.status; end if;
  update public.events x set status = p_status,
    starts_at = case when p_status = 'live' then least(x.starts_at, now()) else x.starts_at end,
    ends_at = case when p_status = 'ended' then now() else x.ends_at end,
    post_dirty = true, post_rev = x.post_rev + 1, updated_at = now() where x.id = p_id;
  return public.event_json(p_id);
end $$;

-- Native kinds with attendance. Marks: [{discord_id, status present|late|absent}] (a null status clears one).
create or replace function public.event_attendance_mark(p_id bigint, p_marks jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare e public.events; k public.event_kinds; me text := public.my_discord_id(); x jsonb; n int := 0;
begin
  select * into e from public.events y where y.id = p_id;
  if not found then raise exception 'That event isn''t there any more.'; end if;
  if e.meeting_id is not null then raise exception 'Take meeting attendance on the meeting.'; end if;
  select * into k from public.event_kinds y where y.kind = e.kind;
  if not k.attendance then raise exception 'This event doesn''t take attendance.'; end if;
  if not (public.event_can_edit(p_id) or (e.department is not null and public.has_perm('meetings.attendance', e.department))) then
    raise exception 'You can''t take attendance for this event.'; end if;
  if e.status = 'scheduled' and e.starts_at > now() + interval '15 minutes' then raise exception 'Attendance opens when the event starts.'; end if;
  for x in select * from jsonb_array_elements(coalesce(p_marks, '[]'::jsonb)) loop
    if (x ->> 'status') is null then
      delete from public.event_attendance a where a.event_id = p_id and a.discord_id = x ->> 'discord_id';
    elsif (x ->> 'status') in ('present', 'late', 'absent') then
      insert into public.event_attendance (event_id, discord_id, status, marked_by, guest)
      values (p_id, x ->> 'discord_id', x ->> 'status', me,
              not (e.department is null or public.ev_in_dept(x ->> 'discord_id', e.department)))
      on conflict (event_id, discord_id) do update set status = excluded.status, marked_by = excluded.marked_by, marked_at = now();
    else
      raise exception 'Attendance is Present, Late or Absent.';
    end if;
    n := n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'marked', n);
end $$;

-- Bot: the card was posted or edited (only if nothing changed since it read the row).
create or replace function public.event_set_post(p_id bigint, p_message_id text, p_rev int) returns boolean
language sql security definer set search_path = '' as $$
  with u as (update public.events x set post_message_id = coalesce(p_message_id, x.post_message_id), post_dirty = false
             where x.id = p_id and x.post_rev = p_rev returning 1)
  select exists (select 1 from u)
$$;

revoke execute on function public.event_json(bigint), public.events_feed(timestamptz, timestamptz, text, text[], int), public.my_whats_on(int),
  public.event_get(bigint), public.event_kinds_list(text), public.event_save(jsonb), public.event_cancel(bigint, text),
  public.event_set_status(bigint, text), public.event_attendance_mark(bigint, jsonb), public.event_set_post(bigint, text, int) from public, anon;
grant execute on function public.event_json(bigint), public.events_feed(timestamptz, timestamptz, text, text[], int), public.my_whats_on(int),
  public.event_get(bigint), public.event_kinds_list(text), public.event_save(jsonb), public.event_cancel(bigint, text),
  public.event_set_status(bigint, text), public.event_attendance_mark(bigint, jsonb) to authenticated;
-- event_set_post: service role only
