-- 0058: Discord role restructure (R2), code side (Bravo, 18 Nov 2026; owner approved R2). Additive and transition-safe.
--   status_roles      which Discord role means "on shift" / "on break". Hospital-wide rows (department null) win;
--                     while the table is empty the bot keeps its old per-department roles. Delta fills it in the live
--                     window once the new 🟢 On Shift / ☕ On Break roles exist.
--   office_keys       each department office's key role, the ranks that hold it automatically, and active (off until
--                     Delta's live window; the bot only syncs active keys)
--   office_key_members extra people a Director lets into their office (optional end date), seeded with today's holders
--   office_key_add / office_key_remove / office_key_set_ranks   Director of that department or executives
--   app_role_allowed  forms can no longer give division or status roles (both are automatic now)
create table if not exists public.status_roles (
  state text not null check (state in ('on_shift', 'on_break')),
  department text,
  role_id text not null,
  updated_at timestamptz not null default now());
create unique index if not exists status_roles_key on public.status_roles (state, coalesce(department, ''));
alter table public.status_roles enable row level security;
drop policy if exists status_roles_read on public.status_roles;
create policy status_roles_read on public.status_roles for select to authenticated using (true);

create table if not exists public.office_keys (
  department text primary key,
  role_id text not null,
  ranks text[] not null default '{}',
  active boolean not null default false,
  updated_at timestamptz not null default now());
alter table public.office_keys enable row level security;
drop policy if exists office_keys_read on public.office_keys;
create policy office_keys_read on public.office_keys for select to authenticated using (public.is_exec() or public.directs_dept(department));
insert into public.office_keys (department, role_id, ranks) values
  ('Administration', '1464028085274804254', array['1472798648063627401', '1472797683445010453']),
  ('Community Engagement', '1472794621833908355', array['1472797737073512490', '1472797517191057429']),
  ('Nursing', '1472794759868452895', array['1472815382329823392', '1472797090995507322', '1472804619192238225']),
  ('Paramedicine', '1572101881797419068', array['1478673454688632903', '1478675463701528586', '1478678200535220265'])
on conflict (department) do nothing;

create table if not exists public.office_key_members (
  department text not null references public.office_keys (department) on delete cascade,
  discord_id text not null,
  added_by text, added_by_name text, added_at timestamptz not null default now(),
  until timestamptz,
  primary key (department, discord_id));
alter table public.office_key_members enable row level security;
drop policy if exists office_key_members_read on public.office_key_members;
create policy office_key_members_read on public.office_key_members for select to authenticated using (public.is_exec() or public.directs_dept(department));
insert into public.office_key_members (department, discord_id, added_by, added_by_name) values
  ('Administration', '1299205199734378537', 'seed-0058', 'Already had the key'),
  ('Administration', '1114218458234761309', 'seed-0058', 'Already had the key'),
  ('Community Engagement', '1114218458234761309', 'seed-0058', 'Already had the key')
on conflict do nothing;

create or replace function public.office_key_add(department text, discord_id text, until timestamptz default null) returns boolean
language plpgsql security definer set search_path = '' as $$
declare me text := public.my_discord_id();
begin
  if not (public.is_exec() or public.directs_dept(office_key_add.department)) then raise exception 'Only the Director or executives can change office access'; end if;
  if not exists (select 1 from public.office_keys k where k.department = office_key_add.department) then raise exception 'That department has no office'; end if;
  if not exists (select 1 from public.members m where m.discord_id = office_key_add.discord_id) then raise exception 'That person isn''t in the server'; end if;
  if until is not null and until <= now() then raise exception 'The end date must be in the future'; end if;
  insert into public.office_key_members (department, discord_id, added_by, added_by_name, until)
  values (office_key_add.department, office_key_add.discord_id, me, (select m.display_name from public.members m where m.discord_id = me), until)
  on conflict on constraint office_key_members_pkey do update set until = excluded.until, added_by = excluded.added_by,
    added_by_name = excluded.added_by_name, added_at = now();
  return true;
end $$;

create or replace function public.office_key_remove(department text, discord_id text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not (public.is_exec() or public.directs_dept(office_key_remove.department)) then raise exception 'Only the Director or executives can change office access'; end if;
  delete from public.office_key_members k where k.department = office_key_remove.department and k.discord_id = office_key_remove.discord_id;
  return true;
end $$;

create or replace function public.office_key_set_ranks(department text, ranks text[]) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not (public.is_exec() or public.directs_dept(office_key_set_ranks.department)) then raise exception 'Only the Director or executives can change office access'; end if;
  if exists (select 1 from unnest(ranks) x where not exists (select 1 from public.roles r where r.id = x and r.kind = 'rank' and r.department = office_key_set_ranks.department)) then
    raise exception 'Only this department''s ranks can open its office'; end if;
  update public.office_keys k set ranks = coalesce(office_key_set_ranks.ranks, '{}'), updated_at = now() where k.department = office_key_set_ranks.department;
  return true;
end $$;

-- Forms may give ranks of their department, ping and community roles. Not division or status roles (automatic now).
create or replace function public.app_role_allowed(role_id text, dept text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.roles r where r.id = role_id
      and r.id <> '1472796097960480778'
      and (r.kind in ('ping', 'community') or (r.kind = 'rank' and r.department = dept))
      and coalesce(r.rank_label, '') <> 'Director')
$$;

revoke execute on function public.office_key_add(text, text, timestamptz), public.office_key_remove(text, text),
  public.office_key_set_ranks(text, text[]) from public, anon;
grant execute on function public.office_key_add(text, text, timestamptz), public.office_key_remove(text, text),
  public.office_key_set_ranks(text, text[]) to authenticated;

-- The Office access list for the department page, with names and photos (Directors can't read member_faces).
create or replace function public.office_key_list(department text) returns table (discord_id text, display_name text,
  avatar_url text, added_by_name text, added_at timestamptz, until timestamptz)
language sql stable security definer set search_path = '' as $$
  select k.discord_id, m.display_name, m.avatar_url, k.added_by_name, k.added_at, k.until
  from public.office_key_members k left join public.members m on m.discord_id = k.discord_id
  where k.department = office_key_list.department and (public.is_exec() or public.directs_dept(office_key_list.department))
  order by k.added_at
$$;
revoke execute on function public.office_key_list(text) from public, anon;
grant execute on function public.office_key_list(text) to authenticated;
