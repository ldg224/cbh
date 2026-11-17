-- DOWN for 0050 (not applied; run only to undo R1a). Restores the exact function bodies and policies from before 0050,
-- then drops the new objects. Generated from the live definitions on 18 Nov 2026.
begin;

CREATE OR REPLACE FUNCTION public.can_run_sessions()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select public.is_admin() or public.directs_any()
$function$;

CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select public.is_exec() or exists (
    select 1 from public.my_roles() r
    where r.kind = 'rank' and r.department = 'Administration' and r.rank_label <> 'Trainee')
$function$;

CREATE OR REPLACE FUNCTION public.member_faces(ids text[])
 RETURNS TABLE(discord_id text, display_name text, avatar_url text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select m.discord_id, m.display_name, m.avatar_url
  from public.members m
  where public.is_admin() and m.discord_id = any (ids[1:200])
$function$;

CREATE OR REPLACE FUNCTION public.member_record(discord_id text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with m as (select * from public.members x where x.discord_id = member_record.discord_id),
  c as (select * from public.mod_cases x where x.target_discord_id = member_record.discord_id and x.status = 'done'),
  msg as (select * from public.discord_messages x where x.author_id = member_record.discord_id),
  sh as (select * from public.shifts x where x.discord_id = member_record.discord_id),
  known_name as (
    select coalesce(
      (select display_name from m),
      (select author_name from msg order by created_at desc limit 1),
      (select target_name from c order by created_at desc limit 1),
      (select user_name from public.discord_logs l where l.user_discord_id = member_record.discord_id
         and l.user_name is not null order by l.at desc limit 1)) as n
  )
  select case when not public.is_admin() then null else jsonb_build_object(
    'discord_id', member_record.discord_id,
    'display_name', (select n from known_name),
    'username', (select username from m),
    'avatar_url', (select avatar_url from m),
    'joined_at', (select joined_at from m),
    'account_created_at', (select account_created_at from m),
    'in_server', exists (select 1 from m),
    'banned', coalesce((select x.action = 'ban' from public.mod_cases x
                        where x.target_discord_id = member_record.discord_id and x.action in ('ban', 'unban')
                          and x.status = 'done' order by x.created_at desc limit 1), false),
    'role_ids', coalesce((select to_jsonb(role_ids) from m), '[]'::jsonb),
    'incidents', (select count(*) from public.incidents i where i.target_discord_id = member_record.discord_id and i.removed_at is null),
    'warnings', (select count(*) from c where action = 'warn' and revoked_at is null),
    'warnings_removed', (select count(*) from c where action = 'warn' and revoked_at is not null),
    'timeouts', (select count(*) from c where action = 'timeout'),
    'kicks', (select count(*) from c where action = 'kick'),
    'bans', (select count(*) from c where action = 'ban'),
    'messages_90d', (select count(*) from msg),
    'last_message_at', (select max(created_at) from msg),
    'shift_hours_30d', coalesce((select round(sum(public.shift_seconds(s)) / 3600.0, 2) from sh s
                                 where s.started_at >= now() - interval '30 days'), 0),
    'shift_hours_total', coalesce((select round(sum(public.shift_seconds(s)) / 3600.0, 2) from sh s), 0),
    'shifts_total', (select count(*) from sh),
    'last_shift_at', (select max(started_at) from sh)
  ) end
$function$;

CREATE OR REPLACE FUNCTION public.mod_member_search(q text)
 RETURNS TABLE(discord_id text, display_name text, username text, avatar_url text, banned boolean, warnings integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with term as (select trim(q) as t),
  banned_people as (
    select distinct on (c.target_discord_id) c.target_discord_id as discord_id, c.target_name, c.action
    from public.mod_cases c
    where c.target_discord_id is not null and c.action in ('ban', 'unban') and c.status = 'done'
    order by c.target_discord_id, c.created_at desc
  ),
  hits as (
    select m.discord_id, m.display_name, m.username, m.avatar_url, false as banned,
      case when m.discord_id = (select t from term) then 0
           when m.display_name ilike (select t from term) || '%' or m.username ilike (select t from term) || '%' then 1
           else 2 end as rank_
    from public.members m
    where m.discord_id = (select t from term)
       or m.display_name ilike '%' || (select t from term) || '%' or m.username ilike '%' || (select t from term) || '%'
    union all
    select b.discord_id, b.target_name, null, null, true,
      case when b.discord_id = (select t from term) then 0
           when b.target_name ilike (select t from term) || '%' then 1 else 2 end
    from banned_people b
    where b.action = 'ban' and not exists (select 1 from public.members m where m.discord_id = b.discord_id)
      and (b.discord_id = (select t from term) or b.target_name ilike '%' || (select t from term) || '%')
  )
  select h.discord_id, h.display_name, h.username, h.avatar_url, h.banned,
    (select count(*)::integer from public.mod_cases c where c.target_discord_id = h.discord_id
       and c.action = 'warn' and c.status = 'done' and c.revoked_at is null)
  from hits h
  where public.is_admin() and char_length((select t from term)) >= 1
  order by h.rank_, h.display_name
  limit 20
$function$;

CREATE OR REPLACE FUNCTION public.people_search(q text)
 RETURNS TABLE(discord_id text, display_name text, username text, avatar_url text, summary text, on_shift boolean, warnings integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.remove_incident(incident_id bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare i public.incidents; me text := public.my_discord_id();
begin
  select * into i from public.incidents x where x.id = incident_id for update;
  if not found then raise exception 'That incident doesn''t exist'; end if;
  if not public.is_admin() or not (i.created_by = me or public.is_exec()) then
    raise exception 'Only the person who wrote it or an executive can remove it';
  end if;
  if i.removed_at is not null then raise exception 'That incident was already removed'; end if;
  update public.incidents set removed_at = now() where id = incident_id;
end $function$;

CREATE OR REPLACE FUNCTION public.request_review(case_id bigint, note text)
 RETURNS mod_cases
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare c public.mod_cases; me text := public.my_discord_id();
begin
  if not public.is_admin() then raise exception 'Only admins can send an action for review'; end if;
  if char_length(trim(coalesce(request_review.note, ''))) = 0 then raise exception 'Say what the supervisor should look at'; end if;
  select * into c from public.mod_cases x where x.id = case_id for update;
  if not found then raise exception 'That case doesn''t exist'; end if;
  if c.status <> 'done' then raise exception 'Only actions that went through can be reviewed'; end if;
  if c.review_status = 'requested' then raise exception 'That action is already waiting for review'; end if;
  update public.mod_cases set review_status = 'requested', review_requested_by = me,
    review_requested_by_name = (select m.display_name from public.members m where m.discord_id = me),
    review_requested_at = now(), review_note = left(trim(request_review.note), 1000),
    reviewed_by = null, reviewed_by_name = null, reviewed_at = null, review_outcome = null, review_result_note = null
  where id = case_id returning * into c;
  return c;
end $function$;

drop policy if exists mod_cases_read on public.mod_cases;
create policy mod_cases_read on public.mod_cases for select to authenticated using (is_admin());

drop policy if exists discord_logs_read on public.discord_logs;
create policy discord_logs_read on public.discord_logs for select to authenticated using (is_admin());

drop policy if exists incidents_file on public.incidents;
create policy incidents_file on public.incidents for insert to authenticated with check ((is_admin() AND (created_by = my_discord_id()) AND (removed_at IS NULL)));

drop policy if exists mod_cases_report on public.mod_cases;
create policy mod_cases_report on public.mod_cases for insert to authenticated with check ((is_admin() AND (moderator_discord_id = my_discord_id()) AND (NOT posted) AND (error IS NULL) AND (done_at IS NULL) AND (((source = 'website'::text) AND (status = 'pending'::text) AND (target_discord_id IS NOT NULL) AND (action = ANY (ARRAY['warn'::text, 'timeout'::text, 'untimeout'::text, 'kick'::text, 'ban'::text, 'unban'::text])) AND ((action <> 'timeout'::text) OR (duration_minutes = ANY (ARRAY[10, 60, 360, 1440, 4320, 10080])))) OR ((source = 'in_game'::text) AND (status = 'done'::text) AND (target_discord_id IS NULL)))));

drop policy if exists discord_messages_read on public.discord_messages;
create policy discord_messages_read on public.discord_messages for select to authenticated using (is_admin());

drop policy if exists incidents_read on public.incidents;
create policy incidents_read on public.incidents for select to authenticated using ((is_admin() AND ((removed_at IS NULL) OR is_exec())));

drop policy if exists incidents_edit on public.incidents;
create policy incidents_edit on public.incidents for update to authenticated using ((is_admin() AND ((created_by = my_discord_id()) OR is_exec()))) with check ((is_admin() AND ((created_by = my_discord_id()) OR is_exec())));

drop policy if exists roblox_avatars_read on public.roblox_avatars;
create policy roblox_avatars_read on public.roblox_avatars for select to authenticated using (is_admin());

drop function if exists public.set_role_hperm(text, text, boolean);
drop function if exists public.my_hperms();
drop function if exists public.has_hperm(text);
drop table if exists public.role_permissions;
commit;
