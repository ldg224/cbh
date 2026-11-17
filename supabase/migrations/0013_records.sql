-- 0013: Records (Admin hub) and failed-action notices.
-- Failed website mod actions are shown only to the moderator who asked, until they dismiss them.
-- Every message in the server is saved by the bot from now on and kept for 90 days.

-- ---------- failed-action notices ----------
alter table public.mod_cases add column if not exists dismissed_at timestamptz;

create or replace function public.dismiss_failed(case_id bigint) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.mod_cases set dismissed_at = now()
  where id = case_id and status = 'failed' and moderator_discord_id = public.my_discord_id() and dismissed_at is null;
  if not found then raise exception 'Nothing to dismiss'; end if;
end $$;
revoke execute on function public.dismiss_failed(bigint) from public, anon;
grant execute on function public.dismiss_failed(bigint) to authenticated;

-- ---------- members: when the Discord account was made ----------
alter table public.members add column if not exists account_created_at timestamptz;

-- ---------- saved messages ----------
create table if not exists public.discord_messages (
  message_id    text primary key,
  channel_id    text not null,
  channel_name  text,
  author_id     text not null,
  author_name   text,
  content       text,
  attachments   jsonb not null default '[]'::jsonb,   -- [{name, url}]
  created_at    timestamptz not null,
  edited_at     timestamptz,
  deleted_at    timestamptz
);
create index if not exists discord_messages_author on public.discord_messages (author_id, created_at desc);
create index if not exists discord_messages_created on public.discord_messages (created_at);
alter table public.discord_messages enable row level security;
drop policy if exists discord_messages_read on public.discord_messages;
create policy discord_messages_read on public.discord_messages for select to authenticated using (public.is_admin());
revoke all on public.discord_messages from anon;
revoke insert, update, delete, truncate on public.discord_messages from authenticated;
grant select on public.discord_messages to authenticated;

-- ---------- picker: now with warning counts ----------
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
       and c.action = 'warn' and c.status = 'done')
  from hits h
  where public.is_admin() and char_length((select t from term)) >= 1
  order by h.rank_, h.display_name
  limit 20
$$;
revoke execute on function public.mod_member_search(text) from public, anon;
grant execute on function public.mod_member_search(text) to authenticated;

-- ---------- a person's record ----------
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
    'warnings', (select count(*) from c where action = 'warn'),
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
