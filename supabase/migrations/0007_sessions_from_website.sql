-- 0007: admins run sessions from the website. The bot watches the table and does the Discord side (announcement in
-- #server-starts with Session Ping, editing it when the session ends). The /session commands are retired.

-- What the bot last did for each session; it acts whenever this differs from status.
alter table public.sessions add column if not exists announced_state text;
update public.sessions set announced_state = status where announced_state is null;
alter table public.sessions add column if not exists needs_sync boolean
  generated always as (announced_state is distinct from status) stored;
create index if not exists sessions_needs_sync on public.sessions (id) where needs_sync;

-- Only one live session at a time.
create unique index if not exists sessions_one_live on public.sessions ((true)) where status = 'live';

-- Fill in times and allow only sensible changes: scheduled -> live | cancelled, live -> ended.
create or replace function public.sessions_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.status not in ('live', 'scheduled') then raise exception 'A new session must be live or scheduled'; end if;
    if new.status = 'scheduled' and (new.scheduled_for is null or new.scheduled_for <= now()) then
      raise exception 'Pick a time in the future';
    end if;
    if new.status = 'live' and new.started_at is null then new.started_at := now(); end if;
    if new.join_code is null then
      select s.value #>> '{}' into new.join_code from public.settings s where s.key = 'join_code';
    end if;
    return new;
  end if;
  if new.status is distinct from old.status then
    if not ((old.status = 'scheduled' and new.status in ('live', 'cancelled')) or (old.status = 'live' and new.status = 'ended')) then
      raise exception 'Can''t change a % session to %', old.status, new.status;
    end if;
    if new.status = 'live' then
      new.started_at := coalesce(new.started_at, now());
      select s.value #>> '{}' into new.join_code from public.settings s where s.key = 'join_code';
    end if;
    if new.status = 'ended' then new.ended_at := coalesce(new.ended_at, now()); end if;
  end if;
  return new;
end $$;
drop trigger if exists sessions_guard on public.sessions;
create trigger sessions_guard before insert or update on public.sessions for each row execute function public.sessions_guard();

-- Admins create and change sessions from the website, as themselves for new ones.
drop policy if exists sessions_admin_insert on public.sessions;
create policy sessions_admin_insert on public.sessions for insert to authenticated
  with check (public.is_admin() and host_discord_id = public.my_discord_id() and message_id is null
              and announced_state is null);
drop policy if exists sessions_admin_update on public.sessions;
create policy sessions_admin_update on public.sessions for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

grant insert (status, note, scheduled_for, host_discord_id, host_name) on public.sessions to authenticated;
grant update (status, note, scheduled_for, ended_at) on public.sessions to authenticated;  -- ended_at is optional: the trigger fills it
