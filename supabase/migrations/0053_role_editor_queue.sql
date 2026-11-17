-- 0053: the role editor's Discord side (R1b/R1c, Bravo, 18 Nov 2026). Additive.
-- Executives change a role on the website; CareBeyond Helper applies it in Discord and logs it to #server-logs.
--   roles: + permissions (Discord bitfield as text), hoist, mentionable, bot_can_edit (below the bot's top role; the bot fills these when it syncs)
--   role_cmd_perms   which roles may use each moderation command (/warn /timeout /untimeout /kick /ban /unban),
--                    seeded from the bot's ADMIN_ROLES so nothing changes today; executives always may
--   role_edits       the queue: display (name, colour, separate, mentionable), position, permissions, member_add,
--                    member_remove. The bot claims, applies and marks each one done or failed
--   role_log         history of website-only changes (hospital, department and command permissions), by trigger
--   request_role_edit(role_id, kind, payload, confirm)  executives only, with the rails:
--     never @everyone, a managed (bot/booster) role, or a role at or above the bot's top role (bot_can_edit);
--     turning ON a dangerous Discord permission needs confirm = the role's exact name.
alter table public.roles add column if not exists permissions text, add column if not exists hoist boolean,
  add column if not exists mentionable boolean, add column if not exists bot_can_edit boolean;

create table if not exists public.role_cmd_perms (
  role_id text not null references public.roles (id) on delete cascade,
  command text not null check (command in ('warn', 'timeout', 'untimeout', 'kick', 'ban', 'unban')),
  granted_by text, granted_at timestamptz not null default now(),
  primary key (role_id, command));
alter table public.role_cmd_perms enable row level security;
drop policy if exists role_cmd_perms_read on public.role_cmd_perms;
create policy role_cmd_perms_read on public.role_cmd_perms for select to authenticated using (public.is_exec());
insert into public.role_cmd_perms (role_id, command, granted_by)
  select r.id, c, 'seed-0053' from public.roles r, unnest(array['warn','timeout','untimeout','kick','ban','unban']) c
  where r.id in ('1472798648063627401', '1472797683445010453', '1472797318146429129')
on conflict do nothing;

create table if not exists public.role_edits (
  id bigint generated always as identity primary key,
  role_id text not null,
  role_name text,
  kind text not null check (kind in ('display', 'position', 'permissions', 'member_add', 'member_remove')),
  payload jsonb not null default '{}',
  summary text,
  requested_by text, requested_by_name text,
  status text not null default 'pending' check (status in ('pending', 'done', 'failed')),
  error text, created_at timestamptz not null default now(), claimed_at timestamptz, done_at timestamptz, posted_at timestamptz);
create index if not exists role_edits_pending on public.role_edits (id) where status = 'pending';
create index if not exists role_edits_role on public.role_edits (role_id, created_at desc);
alter table public.role_edits enable row level security;
drop policy if exists role_edits_read on public.role_edits;
create policy role_edits_read on public.role_edits for select to authenticated using (public.is_exec());

create table if not exists public.role_log (
  id bigint generated always as identity primary key,
  role_id text not null, what text not null,
  by_discord_id text, by_name text, created_at timestamptz not null default now(), posted_at timestamptz);
create index if not exists role_log_role on public.role_log (role_id, created_at desc);
alter table public.role_log enable row level security;
drop policy if exists role_log_read on public.role_log;
create policy role_log_read on public.role_log for select to authenticated using (public.is_exec());

create or replace function public.role_log_trigger() returns trigger
language plpgsql security definer set search_path = '' as $$
declare rid text; p text; on_ boolean; me text := public.my_discord_id(); label text;
begin
  if tg_op = 'DELETE' then rid := old.role_id; on_ := false; else rid := new.role_id; on_ := true; end if;
  p := case tg_table_name when 'role_cmd_perms' then '/' || coalesce(to_jsonb(new) ->> 'command', to_jsonb(old) ->> 'command')
    else coalesce(to_jsonb(new) ->> 'perm', to_jsonb(old) ->> 'perm') end;
  if me is null then return null; end if;   -- seeds and maintenance aren't history
  label := case tg_table_name when 'role_permissions' then 'Website' when 'rank_permissions' then 'Department' else 'Bot command' end;
  if tg_op = 'UPDATE' then
    insert into public.role_log (role_id, what, by_discord_id, by_name)
    values (rid, label || ': change window now ' || new.window_lo || '–' || new.window_hi, me,
      (select m.display_name from public.members m where m.discord_id = me));
  else
    insert into public.role_log (role_id, what, by_discord_id, by_name)
    values (rid, label || ': ' || p || case when on_ then ' on' else ' off' end, me,
      (select m.display_name from public.members m where m.discord_id = me));
  end if;
  return null;
end $$;
drop trigger if exists role_log_hosp on public.role_permissions;
create trigger role_log_hosp after insert or delete on public.role_permissions for each row execute function public.role_log_trigger();
drop trigger if exists role_log_cmd on public.role_cmd_perms;
create trigger role_log_cmd after insert or delete on public.role_cmd_perms for each row execute function public.role_log_trigger();
drop trigger if exists role_log_rank on public.rank_permissions;
create trigger role_log_rank after insert or delete or update of window_lo, window_hi on public.rank_permissions
  for each row execute function public.role_log_trigger();

create or replace function public.set_role_cmd(role_id text, command text, allow boolean) returns boolean
language plpgsql security definer set search_path = '' as $$
declare r public.roles;
begin
  if not public.is_exec() then raise exception 'Only executives can change bot commands'; end if;
  select * into r from public.roles x where x.id = set_role_cmd.role_id;
  if not found then raise exception 'That role doesn''t exist'; end if;
  if r.kind in ('leadership', 'executive') then raise exception 'Leadership and executive roles can always use every command'; end if;
  if r.kind in ('bot', 'community') or r.managed then raise exception 'Bot and booster roles can''t be given commands'; end if;
  if allow then
    insert into public.role_cmd_perms (role_id, command, granted_by) values (set_role_cmd.role_id, set_role_cmd.command, public.my_discord_id())
    on conflict do nothing;
  else
    delete from public.role_cmd_perms p where p.role_id = set_role_cmd.role_id and p.command = set_role_cmd.command;
  end if;
  return allow;
end $$;

-- Discord permission bits that can take over or wreck the server: turning one on needs the role's name typed.
create or replace function public.discord_dangerous_bits() returns numeric language sql immutable set search_path = '' as $$
  select (2::numeric ^ 3) + (2::numeric ^ 1) + (2::numeric ^ 2) + (2::numeric ^ 4) + (2::numeric ^ 5) + (2::numeric ^ 13)
    + (2::numeric ^ 17) + (2::numeric ^ 27) + (2::numeric ^ 28) + (2::numeric ^ 29) + (2::numeric ^ 30) + (2::numeric ^ 40)
$$;   -- Administrator, Kick, Ban, Manage Channels, Manage Server, Manage Messages, Mention Everyone, Manage Nicknames,
      -- Manage Roles, Manage Webhooks, Manage Expressions, Timeout Members

create or replace function public.request_role_edit(role_id text, kind text, payload jsonb, confirm text default null) returns bigint
language plpgsql security definer set search_path = '' as $$
declare r public.roles; me text := public.my_discord_id(); nm text; summ text; newp numeric; oldp numeric; added numeric;
  bit int; danger boolean := false; tgt text; new_id bigint;
begin
  if not public.is_exec() then raise exception 'Only executives can change roles'; end if;
  select * into r from public.roles x where x.id = request_role_edit.role_id;
  if not found then raise exception 'That role doesn''t exist'; end if;
  if r.name = '@everyone' then raise exception 'The @everyone role can''t be changed here'; end if;
  if r.managed then raise exception '% is managed by Discord or a bot, so it can''t be changed', r.name; end if;
  if r.bot_can_edit is not true then raise exception '% is at or above CareBeyond Helper''s top role, so the bot can''t change it', r.name; end if;
  select m.display_name into nm from public.members m where m.discord_id = me;

  if kind = 'display' then
    if payload ? 'name' and (length(trim(payload ->> 'name')) < 1 or length(payload ->> 'name') > 100) then
      raise exception 'Role names are 1 to 100 characters'; end if;
    if payload ? 'color' and ((payload ->> 'color')::bigint < 0 or (payload ->> 'color')::bigint > 16777215) then
      raise exception 'That isn''t a colour'; end if;
    summ := concat_ws(', ',
      case when payload ? 'name' then 'name to "' || (payload ->> 'name') || '"' end,
      case when payload ? 'color' then 'colour to #' || lpad(to_hex((payload ->> 'color')::int), 6, '0') end,
      case when payload ? 'hoist' then case when (payload ->> 'hoist')::boolean then 'shown separately' else 'not shown separately' end end,
      case when payload ? 'mentionable' then case when (payload ->> 'mentionable')::boolean then 'anyone can @mention' else 'not @mentionable' end end);
    if summ = '' then raise exception 'Nothing to change'; end if;
    summ := 'Changed ' || summ;
  elsif kind = 'position' then
    if (payload ->> 'position')::int is null or (payload ->> 'position')::int < 1 then raise exception 'That isn''t a position'; end if;
    if (payload ->> 'position')::int >= (select min(x.position) from public.roles x where x.bot_can_edit is false and x.name <> '@everyone') then
      raise exception 'It can''t go that high: CareBeyond Helper can only place roles below its own'; end if;
    summ := case when (payload ->> 'position')::int > r.position then 'Moved up' else 'Moved down' end;
  elsif kind = 'permissions' then
    newp := (payload ->> 'allow')::numeric;
    if newp is null or newp < 0 then raise exception 'Those aren''t permissions'; end if;
    oldp := coalesce(r.permissions, '0')::numeric;
    for bit in 0..50 loop
      if floor(newp / 2::numeric ^ bit)::numeric % 2 = 1 and floor(oldp / 2::numeric ^ bit)::numeric % 2 = 0
         and floor(public.discord_dangerous_bits() / 2::numeric ^ bit)::numeric % 2 = 1 then danger := true; end if;
    end loop;
    if danger and coalesce(confirm, '') <> r.name then
      raise exception 'Type the role''s name (%) to turn on a dangerous permission', r.name; end if;
    summ := coalesce(nullif(payload ->> 'summary', ''), 'Changed Discord permissions');
  elsif kind in ('member_add', 'member_remove') then
    tgt := payload ->> 'discord_id';
    if tgt is null or not exists (select 1 from public.members m where m.discord_id = tgt) then raise exception 'That person isn''t in the server'; end if;
    if kind = 'member_add' and exists (select 1 from public.members m where m.discord_id = tgt and request_role_edit.role_id = any (m.role_ids)) then
      raise exception 'They already have this role'; end if;
    if kind = 'member_remove' and not exists (select 1 from public.members m where m.discord_id = tgt and request_role_edit.role_id = any (m.role_ids)) then
      raise exception 'They don''t have this role'; end if;
    summ := case when kind = 'member_add' then 'Gave it to ' else 'Took it from ' end
      || coalesce((select m.display_name from public.members m where m.discord_id = tgt), tgt);
  else
    raise exception 'Unknown change';
  end if;
  if (select count(*) from public.role_edits e where e.role_id = r.id and e.status = 'pending') >= 20 then
    raise exception 'Too many changes waiting for this role. Give CareBeyond Helper a moment.'; end if;
  insert into public.role_edits (role_id, role_name, kind, payload, summary, requested_by, requested_by_name)
  values (r.id, r.name, kind, payload - 'summary', summ, me, nm) returning id into new_id;
  return new_id;
end $$;

-- role_overview gains the Discord details (drop: its return type changes; only roles.js calls it).
drop function if exists public.role_overview();
create function public.role_overview() returns table (id text, name text, color integer, "position" integer,
  kind text, department text, rank_label text, rank_order integer, badge_color integer, members integer,
  permissions text, hoist boolean, mentionable boolean, managed boolean, bot_can_edit boolean)
language sql stable security definer set search_path = '' as $$
  select r.id, r.name, r.color, r.position, r.kind, r.department, r.rank_label, r.rank_order, r.badge_color,
    (select count(*)::int from public.members m where r.id = any (m.role_ids)),
    r.permissions, r.hoist, r.mentionable, r.managed, r.bot_can_edit
  from public.roles r
  where public.is_exec()
  order by r.position desc
$$;

revoke execute on function public.role_overview(), public.set_role_cmd(text, text, boolean),
  public.request_role_edit(text, text, jsonb, text), public.role_log_trigger(), public.discord_dangerous_bits() from public, anon;
grant execute on function public.role_overview(), public.set_role_cmd(text, text, boolean),
  public.request_role_edit(text, text, jsonb, text), public.discord_dangerous_bits() to authenticated;
