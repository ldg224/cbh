-- 0036: QA fixes (Delta's findings F2, F3, F7, F9, 18 Nov 2026; Bravo). Only tightens things.
-- F2: a co-host (who can be any member) could update the session row directly: make themselves lead host, turn the
--     ping on, write the announcement, change kind, department or time, and replace the co-host list. Now a co-host can
--     only start or end it and edit the note; everything else is for the lead host and session runners
--     (can_run_sessions). set_session_hosts: lead host or session runners only. CareBeyond Helper (service role) is
--     not affected.
-- F3: a rank's change window may only reach the rank below itself (nobody manages their own rank or above); the
--     lowest rank can't be given Edit members. Existing grants already fit (Administration Leader 1-2).
-- F7: editing a meeting to a past time is refused, as moving one already is.
-- F9: ticket opener and message author names come from public.members, not from the page.

-- Runs as the caller (not security definer), so current_user tells a logged-in user from the bot's service role.
create or replace function public.sessions_cohost_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user <> 'authenticated' then return new; end if;              -- the bot and migrations
  if public.can_run_sessions() or old.host_discord_id = public.my_discord_id() then return new; end if;
  if new.host_discord_id is distinct from old.host_discord_id or new.host_name is distinct from old.host_name
     or new.ping is distinct from old.ping or new.announcement is distinct from old.announcement
     or new.kind is distinct from old.kind or new.department is distinct from old.department
     or new.scheduled_for is distinct from old.scheduled_for or new.location_kind is distinct from old.location_kind
     or new.location_text is distinct from old.location_text then
    raise exception 'Only the lead host or a session runner can change that';
  end if;
  return new;
end $$;
drop trigger if exists sessions_cohost_guard on public.sessions;
create trigger sessions_cohost_guard before update on public.sessions for each row execute function public.sessions_cohost_guard();

create or replace function public.set_session_hosts(sid bigint, host_ids text[])
 returns setof public.session_hosts
 language plpgsql security definer set search_path = '' as $$
declare st text; lead text;
begin
  select s.status, s.host_discord_id into st, lead from public.sessions s where s.id = sid;
  if st is null then raise exception 'That session doesn''t exist'; end if;
  if not (public.can_run_sessions() or lead = public.my_discord_id()) then
    raise exception 'Only the lead host or a session runner can change the hosts';
  end if;
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

-- Runs as the caller: a logged-in user can read their own members row, which is the only one these inserts allow.
create or replace function public.ticket_names_from_members() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user <> 'authenticated' then return new; end if;              -- the bot relays Discord messages itself
  if tg_table_name = 'tickets' then
    new.opener_name := coalesce((select m.display_name from public.members m where m.discord_id = new.opener_discord_id), new.opener_name);
  else
    new.author_name := coalesce((select m.display_name from public.members m where m.discord_id = new.author_discord_id), new.author_name);
  end if;
  return new;
end $$;
drop trigger if exists tickets_names on public.tickets;
create trigger tickets_names before insert on public.tickets for each row execute function public.ticket_names_from_members();
drop trigger if exists ticket_messages_names on public.ticket_messages;
create trigger ticket_messages_names before insert on public.ticket_messages for each row execute function public.ticket_names_from_members();

CREATE OR REPLACE FUNCTION public.meeting_save(mid bigint, department text, title text, scheduled_for timestamp with time zone, duration_minutes integer DEFAULT 60, location text DEFAULT NULL::text, agenda text DEFAULT NULL::text, ping boolean DEFAULT true, voice_channel_id text DEFAULT NULL::text)
 RETURNS meetings
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare m public.meetings; me text := public.my_discord_id(); cid text := nullif(trim(coalesce(voice_channel_id, '')), '');
begin
  if not public.has_perm('meetings.manage', meeting_save.department) then raise exception 'You can''t run % meetings', meeting_save.department; end if;
  if char_length(trim(coalesce(title, ''))) = 0 then raise exception 'Give the meeting a title'; end if;
  if not public.meeting_channel_ok(cid) then raise exception 'That voice channel isn''t in the server any more'; end if;
  if mid is null then
    if scheduled_for < now() - interval '5 minutes' then raise exception 'Pick a time in the future'; end if;
    insert into public.meetings (department, title, scheduled_for, duration_minutes, location, agenda, ping, voice_channel_id,
                                 created_by, created_by_name)
    values (meeting_save.department, trim(title), scheduled_for, coalesce(duration_minutes, 60),
            case when cid is null then nullif(trim(location), '') end, nullif(trim(agenda), ''), coalesce(ping, true), cid,
            me, (select x.display_name from public.members x where x.discord_id = me))
    returning * into m;
  else
    select * into m from public.meetings x where x.id = mid for update;
    if not found then raise exception 'That meeting doesn''t exist'; end if;
    if m.department <> meeting_save.department then raise exception 'A meeting can''t move department'; end if;
    if m.status <> 'scheduled' then raise exception 'Only a meeting that hasn''t started can be changed'; end if;
    if meeting_save.scheduled_for <> m.scheduled_for and meeting_save.scheduled_for < now() - interval '5 minutes' then
      raise exception 'Pick a time in the future';
    end if;
    update public.meetings x set title = trim(meeting_save.title), duration_minutes = coalesce(meeting_save.duration_minutes, 60),
      location = case when cid is null then nullif(trim(meeting_save.location), '') end, agenda = nullif(trim(meeting_save.agenda), ''),
      ping = coalesce(meeting_save.ping, true),
      moved_from_at = case when x.scheduled_for <> meeting_save.scheduled_for then x.scheduled_for else x.moved_from_at end,
      moved_from_channel_id = case when x.voice_channel_id is distinct from cid then x.voice_channel_id else x.moved_from_channel_id end,
      moved_at = case when x.scheduled_for <> meeting_save.scheduled_for or x.voice_channel_id is distinct from cid then now() else x.moved_at end,
      reminder_sent = case when x.scheduled_for = meeting_save.scheduled_for then x.reminder_sent else false end,
      scheduled_for = meeting_save.scheduled_for, voice_channel_id = cid,
      post_dirty = true, post_rev = x.post_rev + 1
    where x.id = mid returning * into m;
  end if;
  return m;
end $function$
;

CREATE OR REPLACE FUNCTION public.set_rank_window(role_id text, lo integer, hi integer)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r public.roles; mn integer; mx integer;
begin
  select * into r from public.roles x where x.id = set_rank_window.role_id;
  if not found or r.kind <> 'rank' or r.department is null then raise exception 'That isn''t a department rank'; end if;
  if not public.directs_dept(r.department) then raise exception 'Only the % Director or an executive can change this', r.department; end if;
  select min(x.rank_order), max(x.rank_order) into mn, mx from public.roles x
    where x.kind = 'rank' and x.department = r.department and x.rank_label <> 'Director';
  -- Nobody manages their own rank or above (Charlie/QA F3, 18 Nov 2026).
  mx := least(mx, r.rank_order - 1);
  if mx < mn then raise exception 'The lowest rank can''t change other members'; end if;
  if lo is null or hi is null or lo > hi or lo < greatest(mn, 1) or hi > mx then
    raise exception 'Pick a range from % up to the rank below %', (select x.rank_label from public.roles x where x.kind = 'rank' and x.department = r.department and x.rank_order = mn limit 1), r.rank_label;
  end if;
  update public.rank_permissions p set window_lo = lo, window_hi = hi
  where p.role_id = set_rank_window.role_id and p.perm = 'members.edit';
  if not found then raise exception 'Turn on Change members for this rank first'; end if;
  return true;
end $function$
;

CREATE OR REPLACE FUNCTION public.set_rank_perm(role_id text, perm text, allow boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r public.roles; lo integer; hi integer;
begin
  select * into r from public.roles x where x.id = set_rank_perm.role_id;
  if not found or r.kind <> 'rank' or r.department is null then raise exception 'That isn''t a department rank'; end if;
  if r.rank_label = 'Director' then raise exception 'Directors always have every permission'; end if;
  if not public.directs_dept(r.department) then raise exception 'Only the % Director or an executive can change this', r.department; end if;
  if allow then
    if set_rank_perm.perm = 'members.edit' then
      select min(x.rank_order) into lo from public.roles x where x.kind = 'rank' and x.department = r.department and x.rank_label <> 'Director';
      hi := r.rank_order - 1;
      if hi < lo then raise exception 'The lowest rank can''t change other members'; end if;
    end if;
    insert into public.rank_permissions (role_id, perm, granted_by, window_lo, window_hi)
    values (set_rank_perm.role_id, set_rank_perm.perm, public.my_discord_id(), lo, hi)
    on conflict do nothing;
  else
    delete from public.rank_permissions p where p.role_id = set_rank_perm.role_id and p.perm = set_rank_perm.perm;
  end if;
  return allow;
end $function$
;
