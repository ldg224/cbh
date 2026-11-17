-- 0039: follow-ups from Delta's re-tests (18 Nov 2026; Bravo). Only tightens or fixes.
-- N1: sessions_shape runs as the caller, who can only read their own members row, so a session runner couldn't hand
--     the lead host to someone else ("The host must be in the server"), although the Sessions form offers it.
--     member_display_name() is a small security definer helper that only answers "is this ID a member, and what's
--     their name", so the trigger can check any host.
-- F3 (belt and braces): the change window read by role_change_check is clamped to one rank below the holder's own
--     rank there too, so a wide row written straight into rank_permissions can't widen it.

create or replace function public.member_display_name(did text) returns text
language sql stable security definer set search_path = '' as $$
  select m.display_name from public.members m where m.discord_id = did
$$;
revoke execute on function public.member_display_name(text) from public, anon;
grant execute on function public.member_display_name(text) to authenticated;

create or replace function public.my_members_window(department text)
returns table (lo integer, hi integer, lo_label text, hi_label text)
language sql stable security definer set search_path = '' as $$
  with w as (
    select min(p.window_lo) lo, max(least(p.window_hi, r.rank_order - 1)) hi
    from public.my_roles() r join public.rank_permissions p on p.role_id = r.id
    where r.kind = 'rank' and r.department = my_members_window.department and p.perm = 'members.edit'
      and least(p.window_hi, r.rank_order - 1) >= p.window_lo
  )
  select w.lo, w.hi,
    (select x.rank_label from public.roles x where x.kind = 'rank' and x.department = my_members_window.department and x.rank_order = w.lo limit 1),
    (select x.rank_label from public.roles x where x.kind = 'rank' and x.department = my_members_window.department and x.rank_order = w.hi limit 1)
  from w
$$;

CREATE OR REPLACE FUNCTION public.sessions_shape()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
    if public.member_display_name(new.host_discord_id) is null then
      if tg_op = 'INSERT' and new.host_discord_id is not null then
        null;   -- e.g. the bot or an old row: keep what was given
      else
        raise exception 'The host must be in the server';
      end if;
    else
      new.host_name := public.member_display_name(new.host_discord_id);
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
end $function$
;
