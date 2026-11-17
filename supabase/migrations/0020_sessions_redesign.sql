-- 0020: Sessions redesign (owner, 17 Nov 2026): session types, ping choice and a custom announcement message, editing
-- scheduled sessions (time, note, type, host), a "Session scheduled" post that the bot keeps up to date, a reminder
-- ping 15 minutes before, and session history for session runners. Additive only.

alter table public.sessions add column if not exists kind text not null default 'regular'
  check (kind in ('regular', 'training', 'event', 'department'));
alter table public.sessions add column if not exists department text
  check (department is null or department in ('Administration', 'Community Engagement', 'Nursing', 'Paramedicine'));
alter table public.sessions add column if not exists ping boolean not null default true;
alter table public.sessions add column if not exists announcement text check (announcement is null or char_length(announcement) <= 500);
-- Bot bookkeeping for the "Session scheduled" post and the reminder.
alter table public.sessions add column if not exists scheduled_message_id text;
alter table public.sessions add column if not exists sched_dirty boolean not null default false;
alter table public.sessions add column if not exists reminder_sent boolean not null default false;
create index if not exists sessions_sched_dirty on public.sessions (id) where sched_dirty;

-- Department sessions name their department; other types don't.
create or replace function public.sessions_shape() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.kind = 'department' and new.department is null then raise exception 'Pick the department for a department session'; end if;
  if new.kind <> 'department' then new.department := null; end if;
  if new.host_discord_id is distinct from old.host_discord_id
     and not exists (select 1 from public.members m where m.discord_id = new.host_discord_id) then
    raise exception 'The host must be in the server';
  end if;
  -- Anything the "Session scheduled" post shows changed (or it was cancelled): the bot updates the post.
  if tg_op = 'INSERT' then
    new.sched_dirty := new.status = 'scheduled';
  elsif new.status in ('scheduled', 'cancelled') and (new.status, new.scheduled_for, new.kind, new.department, new.note, new.host_name,
        new.host_discord_id) is distinct from (old.status, old.scheduled_for, old.kind, old.department, old.note, old.host_name, old.host_discord_id) then
    new.sched_dirty := true;
  elsif new.status = 'live' and old.status = 'scheduled' and old.scheduled_message_id is not null then
    new.sched_dirty := true;   -- started: the scheduled post says so
  end if;
  if tg_op = 'UPDATE' and new.scheduled_for is distinct from old.scheduled_for then new.reminder_sent := false; end if;
  return new;
end $$;
drop trigger if exists sessions_shape on public.sessions;
create trigger sessions_shape before insert or update on public.sessions for each row execute function public.sessions_shape();

-- Website writes: the new fields, and (for scheduled sessions) time, note, type and host.
grant insert (kind, department, ping, announcement) on public.sessions to authenticated;
grant update (kind, department, ping, announcement, host_discord_id, host_name) on public.sessions to authenticated;

-- Session history for session runners: past sessions with how long they ran and who worked during them.
create or replace function public.session_history(max_rows integer default 30)
returns table (id bigint, kind text, department text, note text, host_name text, started_at timestamptz, ended_at timestamptz,
               minutes integer, staff_count integer, staff_hours numeric, staff jsonb)
language sql stable security definer set search_path = '' as $$
  select x.id, x.kind, x.department, x.note, x.host_name, x.started_at, x.ended_at,
    (extract(epoch from (x.ended_at - x.started_at)) / 60)::integer,
    (select count(distinct s.discord_id)::integer from public.shifts s
      where s.started_at < x.ended_at and coalesce(s.ended_at, now()) > x.started_at),
    coalesce((select round(sum(extract(epoch from (least(coalesce(s.ended_at, now()), x.ended_at) - greatest(s.started_at, x.started_at)))) / 3600.0, 2)
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
revoke execute on function public.session_history(integer) from public, anon;
grant execute on function public.session_history(integer) to authenticated;
