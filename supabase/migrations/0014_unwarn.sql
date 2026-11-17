-- 0014: executives can remove a warning ("unwarn"). Removed warnings stay on the record (struck through) but no
-- longer count. The bot posts the removal to #server-logs and DMs the member.

alter table public.mod_cases add column if not exists revoked_at timestamptz;
alter table public.mod_cases add column if not exists revoked_by text;
alter table public.mod_cases add column if not exists revoked_by_name text;
alter table public.mod_cases add column if not exists revoked_reason text;
alter table public.mod_cases add column if not exists revoke_posted boolean not null default false;
create index if not exists mod_cases_revoke_unposted on public.mod_cases (id) where revoked_at is not null and not revoke_posted;

create or replace function public.revoke_warning(case_id bigint, reason text)
returns public.mod_cases
language plpgsql security definer set search_path = '' as $$
declare c public.mod_cases; me text := public.my_discord_id();
begin
  if not public.is_exec() then raise exception 'Only executives can remove a warning'; end if;
  if char_length(trim(coalesce(revoke_warning.reason, ''))) = 0 then raise exception 'Give a reason for removing it'; end if;
  select * into c from public.mod_cases x where x.id = case_id for update;
  if not found then raise exception 'That case doesn''t exist'; end if;
  if c.action <> 'warn' then raise exception 'Only warnings can be removed'; end if;
  if c.status <> 'done' then raise exception 'That warning was never given'; end if;
  if c.revoked_at is not null then raise exception 'That warning was already removed'; end if;
  update public.mod_cases set revoked_at = now(), revoked_by = me,
    revoked_by_name = (select m.display_name from public.members m where m.discord_id = me),
    revoked_reason = left(trim(revoke_warning.reason), 500)
  where id = case_id returning * into c;
  return c;
end $$;
revoke execute on function public.revoke_warning(bigint, text) from public, anon;
grant execute on function public.revoke_warning(bigint, text) to authenticated;

-- Warning counts leave out removed warnings.
drop function if exists public.mod_member_search(text);
create function public.mod_member_search(q text)
returns table (discord_id text, display_name text, username text, avatar_url text, banned boolean, warnings integer)
language sql stable security definer set search_path = '' as $$
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
$$;
revoke execute on function public.mod_member_search(text) from public, anon;
grant execute on function public.mod_member_search(text) to authenticated;


create or replace function public.member_record(discord_id text)
returns jsonb
language sql stable security definer set search_path = '' as $$
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
$$;
revoke execute on function public.member_record(text) from public, anon;
grant execute on function public.member_record(text) to authenticated;
