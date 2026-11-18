-- 0080: make the events mirror triggers exception-safe (Bravo, 18 Nov 2026).
-- 0075's AFTER triggers on sessions / meetings / session_hosts / meeting_attendance copy rows into events. If that copy
-- ever failed, the error would roll back the session or meeting write itself (proved in a rolled-back test with a broken
-- events table). The website and bot must never be blocked by the What's on feed, so each mirror now catches any error,
-- logs a WARNING and lets the original write through. The feed simply catches up on the next write to that row.
create or replace function public.ev_mirror_session() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  begin
    perform public.ev_upsert_session(new);
  exception when others then
    raise warning 'events mirror (session %) skipped: %', new.id, sqlerrm;
  end;
  return null;
end $$;

create or replace function public.ev_mirror_meeting() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  begin
    perform public.ev_upsert_meeting(new);
  exception when others then
    raise warning 'events mirror (meeting %) skipped: %', new.id, sqlerrm;
  end;
  return null;
end $$;

create or replace function public.ev_mirror_session_hosts() returns trigger
language plpgsql security definer set search_path = '' as $$
declare eid bigint;
begin
  begin
    select e.id into eid from public.events e where e.session_id = coalesce(new.session_id, old.session_id);
    if eid is not null then
      if tg_op = 'DELETE' then
        delete from public.event_hosts h where h.event_id = eid and h.discord_id = old.discord_id;
      else
        insert into public.event_hosts (event_id, discord_id, name) values (eid, new.discord_id, new.name)
        on conflict (event_id, discord_id) do update set name = excluded.name;
      end if;
    end if;
  exception when others then
    raise warning 'events mirror (session hosts) skipped: %', sqlerrm;
  end;
  return null;
end $$;

create or replace function public.ev_mirror_meeting_attendance() returns trigger
language plpgsql security definer set search_path = '' as $$
declare eid bigint;
begin
  begin
    select e.id into eid from public.events e where e.meeting_id = coalesce(new.meeting_id, old.meeting_id);
    if eid is not null then
      if tg_op = 'DELETE' then
        delete from public.event_attendance a where a.event_id = eid and a.discord_id = old.discord_id;
      else
        insert into public.event_attendance (event_id, discord_id, status, marked_by, marked_at, guest)
        values (eid, new.discord_id, new.status, new.marked_by, coalesce(new.marked_at, now()), coalesce(new.guest, false))
        on conflict (event_id, discord_id) do update set status = excluded.status, marked_by = excluded.marked_by,
          marked_at = excluded.marked_at, guest = excluded.guest;
      end if;
    end if;
  exception when others then
    raise warning 'events mirror (meeting attendance) skipped: %', sqlerrm;
  end;
  return null;
end $$;
