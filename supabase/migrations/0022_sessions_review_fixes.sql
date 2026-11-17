-- 0022: Sessions review fixes (Alpha's review; Charlie: fix all before release). On top of 0020, additive.
-- A revision number the trigger bumps whenever the scheduled post needs updating; the bot only clears sched_dirty
-- if the revision is still the one it posted (no lost updates when someone edits mid-loop).
alter table public.sessions add column if not exists sched_rev integer not null default 0;

create or replace function public.sessions_shape() returns trigger
language plpgsql set search_path = '' as $$
begin
  -- Past sessions are history: their details can't change.
  if tg_op = 'UPDATE' and old.status in ('ended', 'cancelled')
     and (new.kind, new.department, new.note, new.host_discord_id, new.scheduled_for, new.announcement, new.ping)
         is distinct from (old.kind, old.department, old.note, old.host_discord_id, old.scheduled_for, old.announcement, old.ping) then
    raise exception 'Past sessions can''t be edited';
  end if;
  if new.kind = 'department' and new.department is null then raise exception 'Pick the department for a department session'; end if;
  if new.kind <> 'department' then new.department := null; end if;
  -- The host's name always comes from the members list, never from what the website sends.
  if tg_op = 'INSERT' or new.host_discord_id is distinct from old.host_discord_id or new.host_name is distinct from old.host_name then
    if not exists (select 1 from public.members m where m.discord_id = new.host_discord_id) then
      if tg_op = 'INSERT' and new.host_discord_id is not null then
        null;   -- e.g. the bot or an old row: keep what was given
      else
        raise exception 'The host must be in the server';
      end if;
    else
      new.host_name := (select m.display_name from public.members m where m.discord_id = new.host_discord_id);
    end if;
  end if;
  if tg_op = 'INSERT' then
    new.sched_dirty := new.status = 'scheduled';
  elsif new.status in ('scheduled', 'cancelled') and (new.status, new.scheduled_for, new.kind, new.department, new.note, new.host_name,
        new.host_discord_id) is distinct from (old.status, old.scheduled_for, old.kind, old.department, old.note, old.host_name, old.host_discord_id) then
    new.sched_dirty := true;
    new.sched_rev := old.sched_rev + 1;
  elsif new.status = 'live' and old.status = 'scheduled' and old.scheduled_message_id is not null then
    new.sched_dirty := true;
    new.sched_rev := old.sched_rev + 1;
  end if;
  if tg_op = 'UPDATE' and new.scheduled_for is distinct from old.scheduled_for then new.reminder_sent := false; end if;
  return new;
end $$;

-- Hours worked during a session take breaks off (in proportion to how much of the shift overlapped the session).
create or replace function public.session_history(max_rows integer default 30)
returns table (id bigint, kind text, department text, note text, host_name text, started_at timestamptz, ended_at timestamptz,
               minutes integer, staff_count integer, staff_hours numeric, staff jsonb)
language sql stable security definer set search_path = '' as $$
  select x.id, x.kind, x.department, x.note, x.host_name, x.started_at, x.ended_at,
    (extract(epoch from (x.ended_at - x.started_at)) / 60)::integer,
    (select count(distinct s.discord_id)::integer from public.shifts s
      where s.started_at < x.ended_at and coalesce(s.ended_at, now()) > x.started_at),
    coalesce((select round(sum(
        greatest(0, extract(epoch from (least(coalesce(s.ended_at, now()), x.ended_at) - greatest(s.started_at, x.started_at)))
          * (1 - least(1, s.break_seconds / greatest(1, extract(epoch from (coalesce(s.ended_at, now()) - s.started_at))))))
      ) / 3600.0, 2)
      from public.shifts s where s.started_at < x.ended_at and coalesce(s.ended_at, now()) > x.started_at), 0),
    coalesce((select jsonb_agg(p) from (
      select distinct on (s.discord_id) coalesce(m.display_name, s.name) as name, m.avatar_url, s.department
      from public.shifts s left join public.members m on m.discord_id = s.discord_id
      where s.started_at < x.ended_at and coalesce(s.ended_at, now()) > x.started_at
      order by s.discord_id, s.started_at limit 8) p), '[]'::jsonb)
  from public.sessions x
  where public.can_run_sessions() and x.status = 'ended' and x.started_at is not null and x.ended_at is not null
  order by x.started_at desc
  limit greatest(1, least(coalesce(max_rows, 30), 200))
$$;

-- The bot claims a live session before announcing it, so a failed save after posting can never post it twice.
alter table public.sessions add column if not exists announce_claimed_at timestamptz;

-- ---- Location and co-hosts (owner, 17 Nov 2026) ----
-- Location: "Discord only", or an in-game place typed freely (max 80 characters).
alter table public.sessions add column if not exists location_kind text not null default 'discord'
  check (location_kind in ('discord', 'in_game'));
alter table public.sessions add column if not exists location_text text
  check (location_text is null or char_length(location_text) between 1 and 80);
grant insert (location_kind, location_text) on public.sessions to authenticated;
grant update (location_kind, location_text) on public.sessions to authenticated;

create or replace function public.sessions_location() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.location_text := nullif(trim(new.location_text), '');
  if new.location_kind = 'in_game' and new.location_text is null then raise exception 'Type the in-game location'; end if;
  if new.location_kind = 'discord' then new.location_text := null; end if;
  if tg_op = 'UPDATE' and old.status in ('ended', 'cancelled')
     and (new.location_kind, new.location_text) is distinct from (old.location_kind, old.location_text) then
    raise exception 'Past sessions can''t be edited';
  end if;
  if tg_op = 'UPDATE' and new.status in ('scheduled', 'cancelled')
     and (new.location_kind, new.location_text) is distinct from (old.location_kind, old.location_text) then
    new.sched_dirty := true;
    new.sched_rev := old.sched_rev + 1;
  end if;
  return new;
end $$;
drop trigger if exists sessions_location on public.sessions;
create trigger sessions_location before insert or update on public.sessions for each row execute function public.sessions_location();

-- Co-hosts. The lead host stays in sessions.host_discord_id; this table holds the others. Names come from members.
create table if not exists public.session_hosts (
  session_id  bigint not null references public.sessions (id) on delete cascade,
  discord_id  text not null,
  name        text,
  primary key (session_id, discord_id)
);
alter table public.session_hosts enable row level security;
drop policy if exists session_hosts_read on public.session_hosts;
create policy session_hosts_read on public.session_hosts for select to authenticated using (public.is_member());
revoke all on public.session_hosts from anon;
revoke insert, update, delete, truncate on public.session_hosts from authenticated;
grant select on public.session_hosts to authenticated;

-- Is the logged-in person a host (lead or co-host) of this session?
create or replace function public.hosts_session(sid bigint) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.sessions s where s.id = sid and s.host_discord_id = public.my_discord_id())
      or exists (select 1 from public.session_hosts h where h.session_id = sid and h.discord_id = public.my_discord_id())
$$;
revoke execute on function public.hosts_session(bigint) from public, anon;
grant execute on function public.hosts_session(bigint) to authenticated;

-- Any listed host may edit their session too (session runners already can).
drop policy if exists sessions_host_update on public.sessions;
create policy sessions_host_update on public.sessions for update to authenticated
  using (public.hosts_session(id)) with check (public.hosts_session(id));

-- Replace a session's co-hosts. Session runners or the session's own hosts; scheduled or live sessions only.
create or replace function public.set_session_hosts(sid bigint, host_ids text[])
returns setof public.session_hosts
language plpgsql security definer set search_path = '' as $$
declare st text; lead text;
begin
  select s.status, s.host_discord_id into st, lead from public.sessions s where s.id = sid;
  if st is null then raise exception 'That session doesn''t exist'; end if;
  if not (public.can_run_sessions() or public.hosts_session(sid)) then raise exception 'Only session runners and its hosts can change the hosts'; end if;
  if st not in ('scheduled', 'live') then raise exception 'Past sessions can''t be edited'; end if;
  if coalesce(array_length(host_ids, 1), 0) > 8 then raise exception 'Up to 8 co-hosts'; end if;
  if exists (select 1 from unnest(coalesce(host_ids, '{}')) h where not exists (select 1 from public.members m where m.discord_id = h)) then
    raise exception 'Every host must be in the server';
  end if;
  delete from public.session_hosts h where h.session_id = sid;
  insert into public.session_hosts (session_id, discord_id, name)
    select sid, h, (select m.display_name from public.members m where m.discord_id = h)
    from (select distinct h from unnest(coalesce(host_ids, '{}')) h where h is distinct from lead) x;
  update public.sessions set sched_dirty = (status = 'scheduled' or sched_dirty), sched_rev = sched_rev + 1 where id = sid;
  return query select * from public.session_hosts h where h.session_id = sid;
end $$;
revoke execute on function public.set_session_hosts(bigint, text[]) from public, anon;
grant execute on function public.set_session_hosts(bigint, text[]) to authenticated;

-- History gains location and every host (lead first).
drop function if exists public.session_history(integer);
create function public.session_history(max_rows integer default 30)
returns table (id bigint, kind text, department text, note text, host_name text, started_at timestamptz, ended_at timestamptz,
               minutes integer, staff_count integer, staff_hours numeric, staff jsonb,
               location_kind text, location_text text, hosts jsonb)
language sql stable security definer set search_path = '' as $$
  select x.id, x.kind, x.department, x.note, x.host_name, x.started_at, x.ended_at,
    (extract(epoch from (x.ended_at - x.started_at)) / 60)::integer,
    (select count(distinct s.discord_id)::integer from public.shifts s
      where s.started_at < x.ended_at and coalesce(s.ended_at, now()) > x.started_at),
    coalesce((select round(sum(
        greatest(0, extract(epoch from (least(coalesce(s.ended_at, now()), x.ended_at) - greatest(s.started_at, x.started_at)))
          * (1 - least(1, s.break_seconds / greatest(1, extract(epoch from (coalesce(s.ended_at, now()) - s.started_at))))))
      ) / 3600.0, 2)
      from public.shifts s where s.started_at < x.ended_at and coalesce(s.ended_at, now()) > x.started_at), 0),
    coalesce((select jsonb_agg(p) from (
      select distinct on (s.discord_id) coalesce(m.display_name, s.name) as name, m.avatar_url, s.department
      from public.shifts s left join public.members m on m.discord_id = s.discord_id
      where s.started_at < x.ended_at and coalesce(s.ended_at, now()) > x.started_at
      order by s.discord_id, s.started_at limit 8) p), '[]'::jsonb),
    x.location_kind, x.location_text,
    jsonb_build_array(jsonb_build_object('name', x.host_name, 'is_lead', true))
      || coalesce((select jsonb_agg(jsonb_build_object('name', h.name, 'is_lead', false) order by h.name)
                   from public.session_hosts h where h.session_id = x.id), '[]'::jsonb)
  from public.sessions x
  where public.can_run_sessions() and x.status = 'ended' and x.started_at is not null and x.ended_at is not null
  order by x.started_at desc
  limit greatest(1, least(coalesce(max_rows, 30), 200))
$$;
revoke execute on function public.session_history(integer) from public, anon;
grant execute on function public.session_history(integer) to authenticated;
