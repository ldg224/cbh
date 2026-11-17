-- 0012: "Mod actions". Admins take real Discord actions from the website (warn, timeout, untimeout, kick, ban, unban):
-- the website adds a pending case, CareBeyond Helper carries it out with the same rules as the slash commands
-- (DM first, then the action, then #server-logs) and marks it done or failed. In-game actions stay records only,
-- with a checked Roblox username.

alter table public.mod_cases add column if not exists status text not null default 'done'
  check (status in ('pending', 'done', 'failed'));
alter table public.mod_cases add column if not exists error text;
alter table public.mod_cases add column if not exists done_at timestamptz;
alter table public.mod_cases add column if not exists target_roblox_id text;
create index if not exists mod_cases_pending on public.mod_cases (id) where status = 'pending';

-- Website actions (pending, carried out by the bot) and in-game records (done straight away).
drop policy if exists mod_cases_report on public.mod_cases;
create policy mod_cases_report on public.mod_cases for insert to authenticated
  with check (
    public.is_admin() and moderator_discord_id = public.my_discord_id() and not posted and error is null
    and done_at is null and (
      (source = 'website' and status = 'pending' and target_discord_id is not null
        and action in ('warn', 'timeout', 'untimeout', 'kick', 'ban', 'unban')
        and (action <> 'timeout' or duration_minutes in (10, 60, 360, 1440, 4320, 10080)))
      or (source = 'in_game' and status = 'done' and target_discord_id is null)
    ));

-- People to pick as a target: server members (exact ID, or name/username match, prefix matches first), plus people
-- banned through CareBeyond Helper who are no longer in the server (banned = true), for Unban.
create or replace function public.mod_member_search(q text)
returns table (discord_id text, display_name text, username text, avatar_url text, banned boolean)
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
  select h.discord_id, h.display_name, h.username, h.avatar_url, h.banned from hits h
  where public.is_admin() and char_length((select t from term)) >= 1
  order by h.rank_, h.display_name
  limit 20
$$;
revoke execute on function public.mod_member_search(text) from public, anon;
grant execute on function public.mod_member_search(text) to authenticated;
