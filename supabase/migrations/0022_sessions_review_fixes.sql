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
