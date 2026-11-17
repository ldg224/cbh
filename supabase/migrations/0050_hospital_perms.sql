-- 0050: R1a, hospital-level permissions per role (user approved the role editor, 18 Nov 2026; Bravo).
-- Until now, "admin" was a fixed rule (is_admin(): an exec or an Administration rank above Trainee) and session
-- running was is_admin() or any Director. Now each role can be given hospital powers on its own, in the website role
-- editor (executives only):
--   hosp.mod        Mod actions: see and file warns, timeouts, kicks, bans; send for supervisor review
--   hosp.records    Records: look people up, their record, Discord messages, photos
--   hosp.logs       Discord logs
--   hosp.incidents  Incidents: write up, read, edit and remove incident reports
--   hosp.sessions   Run sessions (Directors still can, as before)
-- Executives always have everything. Seeded to today's rules exactly: Administration Director, Leader and Team Member
-- get all five (Trainees none). is_admin() stays, meaning "has any moderation power" (mod / records / logs /
-- incidents), for the website's Hospital tools and admin-only forms. Department permissions stay in rank_permissions.

create table if not exists public.role_permissions (
  role_id     text not null references public.roles (id) on delete cascade,
  perm        text not null check (perm in ('hosp.mod', 'hosp.records', 'hosp.logs', 'hosp.incidents', 'hosp.sessions')),
  granted_by  text,
  granted_at  timestamptz not null default now(),
  primary key (role_id, perm)
);
alter table public.role_permissions enable row level security;
drop policy if exists role_permissions_read on public.role_permissions;
create policy role_permissions_read on public.role_permissions for select to authenticated using (public.is_exec());
revoke all on public.role_permissions from anon;
revoke insert, update, delete, truncate on public.role_permissions from authenticated;
grant select on public.role_permissions to authenticated;

create or replace function public.has_hperm(perm text) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_exec() or exists (
    select 1 from public.my_roles() r join public.role_permissions p on p.role_id = r.id where p.perm = has_hperm.perm)
$$;
revoke execute on function public.has_hperm(text) from public, anon;
grant execute on function public.has_hperm(text) to authenticated;

create or replace function public.my_hperms() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(p order by p), '[]'::jsonb)
  from unnest(array['hosp.mod', 'hosp.records', 'hosp.logs', 'hosp.incidents', 'hosp.sessions']) p where public.has_hperm(p)
$$;
revoke execute on function public.my_hperms() from public, anon;
grant execute on function public.my_hperms() to authenticated;

-- Executives turn a hospital permission on or off for a role. Never leadership/executive (they have everything),
-- bots or booster roles.
create or replace function public.set_role_hperm(role_id text, perm text, allow boolean) returns boolean
language plpgsql security definer set search_path = '' as $$
declare r public.roles;
begin
  if not public.is_exec() then raise exception 'Only executives can change hospital permissions'; end if;
  select * into r from public.roles x where x.id = set_role_hperm.role_id;
  if not found then raise exception 'That role doesn''t exist'; end if;
  if r.kind in ('leadership', 'executive') then raise exception 'Leadership and executive roles always have every permission'; end if;
  if r.kind in ('bot', 'community') then raise exception 'Bot and booster roles can''t be given permissions'; end if;
  if allow then
    insert into public.role_permissions (role_id, perm, granted_by) values (set_role_hperm.role_id, set_role_hperm.perm, public.my_discord_id())
    on conflict do nothing;
  else
    delete from public.role_permissions p where p.role_id = set_role_hperm.role_id and p.perm = set_role_hperm.perm;
  end if;
  return allow;
end $$;
revoke execute on function public.set_role_hperm(text, text, boolean) from public, anon;
grant execute on function public.set_role_hperm(text, text, boolean) to authenticated;

-- "Has any moderation power": the website's Hospital tools, admin-only forms, my_access().admin, home_counts.
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.has_hperm('hosp.mod') or public.has_hperm('hosp.records') or public.has_hperm('hosp.logs') or public.has_hperm('hosp.incidents')
$$;

-- Seed: today's admins (Administration ranks other than Trainee) get all five.
insert into public.role_permissions (role_id, perm, granted_by)
select r.id, p, 'seed-0050' from public.roles r
cross join unnest(array['hosp.mod', 'hosp.records', 'hosp.logs', 'hosp.incidents', 'hosp.sessions']) p
where r.kind = 'rank' and r.department = 'Administration' and r.rank_label <> 'Trainee'
on conflict do nothing;

-- Policies: each table follows its own permission.
drop policy if exists mod_cases_read on public.mod_cases;
create policy mod_cases_read on public.mod_cases for select to authenticated using (public.has_hperm('hosp.mod') or public.has_hperm('hosp.records'));
drop policy if exists discord_logs_read on public.discord_logs;
create policy discord_logs_read on public.discord_logs for select to authenticated using (public.has_hperm('hosp.logs'));
drop policy if exists discord_messages_read on public.discord_messages;
create policy discord_messages_read on public.discord_messages for select to authenticated using (public.has_hperm('hosp.records'));
drop policy if exists roblox_avatars_read on public.roblox_avatars;
create policy roblox_avatars_read on public.roblox_avatars for select to authenticated using (public.has_hperm('hosp.records') or public.has_hperm('hosp.mod'));
drop policy if exists incidents_read on public.incidents;
create policy incidents_read on public.incidents for select to authenticated using (public.has_hperm('hosp.incidents') and ((removed_at is null) or public.is_exec()));
drop policy if exists incidents_file on public.incidents;
create policy incidents_file on public.incidents for insert to authenticated with check (public.has_hperm('hosp.incidents') and created_by = public.my_discord_id() and removed_at is null);
drop policy if exists incidents_edit on public.incidents;
create policy incidents_edit on public.incidents for update to authenticated
  using (public.has_hperm('hosp.incidents') and (created_by = public.my_discord_id() or public.is_exec()))
  with check (public.has_hperm('hosp.incidents') and (created_by = public.my_discord_id() or public.is_exec()));
drop policy if exists mod_cases_report on public.mod_cases;
create policy mod_cases_report on public.mod_cases for insert to authenticated with check (public.has_hperm('hosp.mod') and (moderator_discord_id = public.my_discord_id()) and (not posted) and (error is null) and (done_at is null)
  and (((source = 'website') and (status = 'pending') and (target_discord_id is not null) and (action = any (array['warn', 'timeout', 'untimeout', 'kick', 'ban', 'unban']))
        and ((action <> 'timeout') or (duration_minutes = any (array[10, 60, 360, 1440, 4320, 10080]))))
    or ((source = 'in_game') and (status = 'done') and (target_discord_id is null))));
-- (form_submissions_submit, sessions_admin_insert/update and the functions below keep using is_admin() /
--  can_run_sessions(), which now read these permissions.)

CREATE OR REPLACE FUNCTION public.member_faces(ids text[])
 RETURNS TABLE(discord_id text, display_name text, avatar_url text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select m.discord_id, m.display_name, m.avatar_url
  from public.members m
  where (public.has_hperm('hosp.records') or public.has_hperm('hosp.mod')) and m.discord_id = any (ids[1:200])
$function$
;

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
  select case when not (public.has_hperm('hosp.records') or public.has_hperm('hosp.mod')) then null else jsonb_build_object(
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
$function$
;

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
  where (public.has_hperm('hosp.records') or public.has_hperm('hosp.mod')) and char_length((select t from term)) >= 1
  order by h.rank_, h.display_name
  limit 20
$function$
;

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
    case when (public.has_hperm('hosp.records') or public.has_hperm('hosp.mod')) then (select count(*)::integer from public.mod_cases c
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
$function$
;

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
  if not public.has_hperm('hosp.incidents') or not (i.created_by = me or public.is_exec()) then
    raise exception 'Only the person who wrote it or an executive can remove it';
  end if;
  if i.removed_at is not null then raise exception 'That incident was already removed'; end if;
  update public.incidents set removed_at = now() where id = incident_id;
end $function$
;

CREATE OR REPLACE FUNCTION public.request_review(case_id bigint, note text)
 RETURNS mod_cases
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare c public.mod_cases; me text := public.my_discord_id();
begin
  if not public.has_hperm('hosp.mod') then raise exception 'Only admins can send an action for review'; end if;
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
end $function$
;

CREATE OR REPLACE FUNCTION public.can_run_sessions()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select public.has_hperm('hosp.sessions') or public.directs_any()
$function$
;
