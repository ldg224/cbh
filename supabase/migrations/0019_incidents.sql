-- 0019: Incidents (Alpha, approved by Charlie). Written write-ups staff file against a person: title, what happened,
-- when, and optional evidence links (http/https only, checked here). Admins read and file them; the author or an
-- executive edits or removes them. Removed incidents stay readable by executives only (audit trail).
-- member_record() gains an 'incidents' count; everything else it returns is unchanged. Additive only.

create or replace function public.urls_ok(u text[]) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(bool_and(x ~* '^https?://[^[:space:]]+$' and char_length(x) <= 500), true) from unnest(u) x
$$;

create table if not exists public.incidents (
  id                bigint generated always as identity primary key,
  target_discord_id text not null,
  target_name       text,
  title             text not null check (char_length(trim(title)) between 1 and 120),
  body              text not null check (char_length(trim(body)) between 1 and 4000),
  happened_at       timestamptz not null default now(),
  evidence          text[] not null default '{}' check (cardinality(evidence) <= 10 and public.urls_ok(evidence)),
  created_by        text not null,
  created_by_name   text,
  created_at        timestamptz not null default now(),
  edited_at         timestamptz,
  removed_at        timestamptz,
  removed_by        text,
  removed_by_name   text
);
create index if not exists incidents_target on public.incidents (target_discord_id, happened_at desc);
alter table public.incidents enable row level security;

drop policy if exists incidents_read on public.incidents;
create policy incidents_read on public.incidents for select to authenticated
  using (public.is_admin() and (removed_at is null or public.is_exec()));
drop policy if exists incidents_file on public.incidents;
create policy incidents_file on public.incidents for insert to authenticated
  with check (public.is_admin() and created_by = public.my_discord_id() and removed_at is null);
drop policy if exists incidents_edit on public.incidents;
create policy incidents_edit on public.incidents for update to authenticated
  using (public.is_admin() and (created_by = public.my_discord_id() or public.is_exec()))
  with check (public.is_admin() and (created_by = public.my_discord_id() or public.is_exec()));
revoke all on public.incidents from anon;
revoke delete, truncate on public.incidents from authenticated;
grant select, insert, update on public.incidents to authenticated;

-- Who filed it and when can't be changed; edits and removals are stamped by the database.
create or replace function public.incidents_stamp() returns trigger
language plpgsql set search_path = '' as $$
declare me text := public.my_discord_id();
begin
  if tg_op = 'INSERT' then
    new.created_at := now(); new.edited_at := null; new.removed_at := null; new.removed_by := null; new.removed_by_name := null;
    new.created_by_name := (select m.display_name from public.members m where m.discord_id = new.created_by);
  else
    new.created_by := old.created_by; new.created_by_name := old.created_by_name; new.created_at := old.created_at;
    new.target_discord_id := old.target_discord_id;
    if old.removed_at is not null and new.removed_at is null and not public.is_exec() then
      raise exception 'Only executives can bring back a removed incident';
    end if;
    if new.removed_at is not null and old.removed_at is null then
      new.removed_at := now(); new.removed_by := me;
      new.removed_by_name := (select m.display_name from public.members m where m.discord_id = me);
    elsif new.title is distinct from old.title or new.body is distinct from old.body
       or new.happened_at is distinct from old.happened_at or new.evidence is distinct from old.evidence then
      new.edited_at := now();
    end if;
  end if;
  return new;
end $$;
drop trigger if exists incidents_stamp on public.incidents;
create trigger incidents_stamp before insert or update on public.incidents for each row execute function public.incidents_stamp();

-- member_record: the live version (as of 0018) with one added key, 'incidents'.
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

-- Removing goes through this function: a plain update can't hide a row from the person doing it (row security
-- refuses an update whose result they could no longer see). Same rule: the author or an executive.
create or replace function public.remove_incident(incident_id bigint)
returns void
language plpgsql security definer set search_path = '' as $$
declare i public.incidents; me text := public.my_discord_id();
begin
  select * into i from public.incidents x where x.id = incident_id for update;
  if not found then raise exception 'That incident doesn''t exist'; end if;
  if not public.is_admin() or not (i.created_by = me or public.is_exec()) then
    raise exception 'Only the person who wrote it or an executive can remove it';
  end if;
  if i.removed_at is not null then raise exception 'That incident was already removed'; end if;
  update public.incidents set removed_at = now() where id = incident_id;
end $$;
revoke execute on function public.remove_incident(bigint) from public, anon;
grant execute on function public.remove_incident(bigint) to authenticated;
