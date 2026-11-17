-- 0008: Discord commands are kept to the moderation basics + /login (owner's rule, 17 Nov 2026). Shifts and bot
-- settings move to the website. The bot watches the tables and does the Discord side.

-- ---------- shifts ----------
-- What the bot last applied (status roles, #shift-logs); it acts whenever this differs from status.
alter table public.shifts add column if not exists synced_state text;
update public.shifts set synced_state = status where synced_state is null;
alter table public.shifts add column if not exists needs_sync boolean
  generated always as (synced_state is distinct from status) stored;
create index if not exists shifts_needs_sync on public.shifts (id) where needs_sync;

-- Start a shift for yourself in one of your departments.
create or replace function public.shift_start(department text)
returns public.shifts
language plpgsql security definer set search_path = '' as $$
declare me text := public.my_discord_id(); s public.shifts;
begin
  if me is null or not exists (select 1 from public.my_roles() r
                               where r.kind in ('department', 'rank') and r.department = shift_start.department) then
    raise exception 'You''re not in %', department;
  end if;
  if exists (select 1 from public.shifts x where x.discord_id = me and x.status <> 'ended') then
    raise exception 'You''re already on shift';
  end if;
  insert into public.shifts (discord_id, name, department, session_id)
  values (me, (select m.display_name from public.members m where m.discord_id = me), shift_start.department,
          (select x.id from public.sessions x where x.status = 'live' limit 1))
  returning * into s;
  return s;
end $$;

-- Start or end a break on your open shift.
create or replace function public.shift_break()
returns public.shifts
language plpgsql security definer set search_path = '' as $$
declare me text := public.my_discord_id(); s public.shifts;
begin
  select * into s from public.shifts x where x.discord_id = me and x.status <> 'ended' for update;
  if not found then raise exception 'You''re not on shift'; end if;
  if s.status = 'active' then
    update public.shifts set status = 'break', break_started_at = now() where id = s.id returning * into s;
  else
    update public.shifts set status = 'active',
      break_seconds = break_seconds + extract(epoch from (now() - break_started_at))::integer,
      break_started_at = null
    where id = s.id returning * into s;
  end if;
  return s;
end $$;

-- End your open shift. (The bot also uses the same logic for automatic ends.)
create or replace function public.end_shift_row(shift_id bigint, by_whom text)
returns public.shifts
language plpgsql security definer set search_path = '' as $$
declare s public.shifts;
begin
  update public.shifts set status = 'ended', ended_at = now(), ended_by = by_whom,
    break_seconds = break_seconds + case when status = 'break' and break_started_at is not null
                                         then extract(epoch from (now() - break_started_at))::integer else 0 end,
    break_started_at = null
  where id = shift_id and status <> 'ended' returning * into s;
  return s;
end $$;
revoke execute on function public.end_shift_row(bigint, text) from public, anon, authenticated;

create or replace function public.shift_end()
returns public.shifts
language plpgsql security definer set search_path = '' as $$
declare me text := public.my_discord_id(); sid bigint;
begin
  select x.id into sid from public.shifts x where x.discord_id = me and x.status <> 'ended';
  if sid is null then raise exception 'You''re not on shift'; end if;
  return public.end_shift_row(sid, 'self');
end $$;

revoke execute on function public.shift_start(text), public.shift_break(), public.shift_end() from public, anon;
grant execute on function public.shift_start(text), public.shift_break(), public.shift_end() to authenticated;

-- ---------- bot settings ----------
insert into public.settings (key, value) values ('shift_auto_end_hours', '8') on conflict (key) do nothing;

-- Execs change bot settings from the website. Only listed keys, each checked.
create or replace function public.set_setting(setting text, val jsonb)
returns public.settings
language plpgsql security definer set search_path = '' as $$
declare r public.settings;
begin
  if not public.is_exec() then raise exception 'Only executives can change bot settings'; end if;
  if setting = 'join_code' then
    if jsonb_typeof(val) <> 'string' or char_length(val #>> '{}') not between 1 and 20 then
      raise exception 'The join code must be 1 to 20 characters';
    end if;
  elsif setting = 'shift_auto_end_hours' then
    if jsonb_typeof(val) <> 'number' or (val #>> '{}')::numeric not between 1 and 24 then
      raise exception 'Auto-end must be between 1 and 24 hours';
    end if;
  else
    raise exception 'Unknown setting %', setting;
  end if;
  insert into public.settings (key, value, updated_at, updated_by) values (setting, val, now(), public.my_discord_id())
  on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by
  returning * into r;
  return r;
end $$;
revoke execute on function public.set_setting(text, jsonb) from public, anon;
grant execute on function public.set_setting(text, jsonb) to authenticated;
