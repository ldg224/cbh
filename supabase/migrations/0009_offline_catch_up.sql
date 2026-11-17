-- 0009: the bot's PC isn't always on. Everything done on the website while the bot is offline must be carried out
-- when it comes back. These columns let each watcher catch up from the table, not from "the last minute".

-- Tickets closed on the website: the bot archives the thread, then sets this.
alter table public.tickets add column if not exists thread_closed boolean not null default false;
update public.tickets set thread_closed = true where status = 'closed';

-- Messages written in a ticket thread while the bot was offline are backfilled from Discord; this stops duplicates.
alter table public.ticket_messages add column if not exists discord_message_id text;
create unique index if not exists ticket_messages_discord_id on public.ticket_messages (discord_message_id)
  where discord_message_id is not null;

-- Mod cases filed on the website are posted to #server-logs by the bot; bot-made cases are posted straight away.
alter table public.mod_cases add column if not exists posted boolean not null default false;
update public.mod_cases set posted = true where source = 'discord';

-- Automatic shift ends happen at the real cut-off time, not when the bot gets round to it.
create or replace function public.end_shift_row(shift_id bigint, by_whom text, at timestamptz default null)
returns public.shifts
language plpgsql security definer set search_path = '' as $$
declare s public.shifts; t timestamptz;
begin
  select * into s from public.shifts x where x.id = shift_id and x.status <> 'ended' for update;
  if not found then return null; end if;
  t := least(now(), coalesce(at, now()));
  update public.shifts set status = 'ended', ended_at = t, ended_by = by_whom,
    break_seconds = break_seconds + case when status = 'break' and break_started_at is not null
                                         then greatest(0, extract(epoch from (t - break_started_at))::integer) else 0 end,
    break_started_at = null
  where id = shift_id returning * into s;
  return s;
end $$;
drop function if exists public.end_shift_row(bigint, text);
revoke execute on function public.end_shift_row(bigint, text, timestamptz) from public, anon, authenticated;

create or replace function public.shift_end()
returns public.shifts
language plpgsql security definer set search_path = '' as $$
declare me text := public.my_discord_id(); sid bigint;
begin
  select x.id into sid from public.shifts x where x.discord_id = me and x.status <> 'ended';
  if sid is null then raise exception 'You''re not on shift'; end if;
  return public.end_shift_row(sid, 'self', null);
end $$;
