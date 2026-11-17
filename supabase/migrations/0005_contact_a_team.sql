-- 0005: "Contact a team" (replaces Tickets v2). One flow: pick a team, write a message. From the website or /contact
-- in Discord. CareBeyond Helper opens a private thread in that team's channel with the team's leads, and relays
-- replies both ways (staff replies reach the person by DM and on the website).
-- Handled by each team's leads (Director, Leader, Year 5, Year 4); executives see every team.

create or replace function public.leads_team(t text) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_exec() or exists (
    select 1 from public.my_roles() r
    where r.kind = 'rank' and r.department = t and r.rank_label in ('Director', 'Leader', 'Year 5', 'Year 4'))
$$;
revoke execute on function public.leads_team(text) from public, anon;
grant execute on function public.leads_team(text) to authenticated;

create table if not exists public.tickets (
  id                     bigint generated always as identity primary key,
  team                   text not null check (team in ('Administration', 'Nursing', 'Paramedicine', 'Community Engagement')),
  subject                text not null check (char_length(subject) between 1 and 120),
  status                 text not null default 'open' check (status in ('open', 'claimed', 'closed')),
  opener_discord_id      text not null,
  opener_name            text,
  claimed_by_discord_id  text,
  claimed_by_name        text,
  thread_id              text,                       -- the private Discord thread, set by the bot
  source                 text not null default 'website' check (source in ('website', 'discord')),
  created_at             timestamptz not null default now(),
  closed_at              timestamptz
);
create index if not exists tickets_team on public.tickets (team, status, created_at desc);
create index if not exists tickets_opener on public.tickets (opener_discord_id, created_at desc);

create table if not exists public.ticket_messages (
  id                 bigint generated always as identity primary key,
  ticket_id          bigint not null references public.tickets (id) on delete cascade,
  author_discord_id  text not null,
  author_name        text,
  from_staff         boolean not null default false,
  body               text not null check (char_length(body) between 1 and 2000),
  relayed            boolean not null default false,  -- the bot has carried it to the other side
  created_at         timestamptz not null default now()
);
create index if not exists ticket_messages_ticket on public.ticket_messages (ticket_id, created_at);
create index if not exists ticket_messages_relay on public.ticket_messages (relayed) where not relayed;

alter table public.tickets enable row level security;
alter table public.ticket_messages enable row level security;

-- Read: your own tickets, or your team's if you lead it (execs: all).
drop policy if exists tickets_read on public.tickets;
create policy tickets_read on public.tickets for select to authenticated
  using (opener_discord_id = public.my_discord_id() or public.leads_team(team));
-- Open a ticket as yourself (website).
drop policy if exists tickets_open on public.tickets;
create policy tickets_open on public.tickets for insert to authenticated
  with check (public.is_member() and opener_discord_id = public.my_discord_id() and status = 'open'
              and source = 'website' and thread_id is null and claimed_by_discord_id is null);
-- Leads claim / close their team's tickets from the website.
drop policy if exists tickets_manage on public.tickets;
create policy tickets_manage on public.tickets for update to authenticated
  using (public.leads_team(team)) with check (public.leads_team(team));

drop policy if exists ticket_messages_read on public.ticket_messages;
create policy ticket_messages_read on public.ticket_messages for select to authenticated
  using (exists (select 1 from public.tickets t where t.id = ticket_id
                 and (t.opener_discord_id = public.my_discord_id() or public.leads_team(t.team))));
-- Write: the opener on their own open ticket, or a lead (as staff) on their team's.
drop policy if exists ticket_messages_write on public.ticket_messages;
create policy ticket_messages_write on public.ticket_messages for insert to authenticated
  with check (author_discord_id = public.my_discord_id() and not relayed and exists (
    select 1 from public.tickets t where t.id = ticket_id and t.status <> 'closed' and (
      (t.opener_discord_id = public.my_discord_id() and not from_staff) or (public.leads_team(t.team) and from_staff))));

revoke all on public.tickets, public.ticket_messages from anon;
revoke delete, truncate on public.tickets, public.ticket_messages from authenticated;
revoke update on public.ticket_messages from authenticated;
grant select, insert on public.tickets, public.ticket_messages to authenticated;
-- leads may only change these columns
revoke update on public.tickets from authenticated;
grant update (status, claimed_by_discord_id, claimed_by_name, closed_at) on public.tickets to authenticated;
