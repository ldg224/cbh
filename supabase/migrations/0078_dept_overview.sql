-- 0078: the department Overview (Alpha). Owner approved the department frame (v8), 18 Nov 2026. events-plan.md Part 2:
-- "From the Director" posts (new posts.manage permission), a weekly minutes target (department + per rank) and ONE read,
-- my_department_overview(p_department), for What's on (Bravo's events_feed, 0077), From the Director, My week and On now.
-- Multi-department is back: p_department is required when someone is in several departments.
-- Contract: Plans/CareBeyond/rethink/DEPT-OVERVIEW-CONTRACT.md. Additive.

-- ---------- permission ----------
alter table public.rank_permissions drop constraint if exists rank_permissions_perm_check;
alter table public.rank_permissions add constraint rank_permissions_perm_check check (perm in ('dept.view', 'activity.view', 'members.edit', 'history.view',
  'meetings.manage', 'meetings.attendance', 'applications.review', 'applications.settings', 'courses.manage', 'courses.assess', 'posts.manage'));

-- ---------- posts ----------
create table if not exists public.department_posts (
  id                 bigint generated always as identity primary key,
  department         text not null references public.departments (name) on update cascade,
  title              text not null check (char_length(title) between 1 and 120),
  body               text not null check (char_length(body) between 1 and 4000),
  pinned             boolean not null default false,
  mirror             boolean not null default false,     -- also post in the department's announcements channel (bot)
  ping               boolean not null default false,     -- ping the department's ranks on the FIRST Discord post only
  author_discord_id  text not null,
  author_name        text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  edited_by_name     text,
  deleted_at         timestamptz,
  discord_message_id text,
  post_dirty         boolean not null default false,
  post_rev           integer not null default 0,
  pinged             boolean not null default false
);
create unique index if not exists department_posts_one_pin on public.department_posts (department) where pinned and deleted_at is null;
create index if not exists department_posts_dept on public.department_posts (department, created_at desc) where deleted_at is null;
create index if not exists department_posts_dirty on public.department_posts (id) where post_dirty;

create table if not exists public.department_post_log (
  id         bigint generated always as identity primary key,
  post_id    bigint not null references public.department_posts (id) on delete cascade,
  department text not null,
  action     text not null check (action in ('posted', 'edited', 'pinned', 'unpinned', 'deleted')),
  title      text,
  by_discord_id text,
  by_name    text,
  at         timestamptz not null default now()
);

alter table public.department_posts enable row level security;
alter table public.department_post_log enable row level security;
revoke all on public.department_posts, public.department_post_log from anon, authenticated;

-- ---------- targets ----------
alter table public.departments add column if not exists weekly_minutes_target integer check (weekly_minutes_target is null or weekly_minutes_target between 0 and 10080);
create table if not exists public.dept_rank_targets (
  role_id    text primary key references public.roles (id) on delete cascade,
  minutes    integer not null check (minutes between 0 and 10080),
  set_by     text,
  set_at     timestamptz not null default now()
);
alter table public.dept_rank_targets enable row level security;
revoke all on public.dept_rank_targets from anon, authenticated;

-- ---------- helpers (private) ----------
-- The department to act on: the one asked (must exist), or the caller's only department.
create or replace function public.dept_pick(p_department text)
returns text language plpgsql stable security definer set search_path = '' as $$
declare d text; n int;
begin
  if p_department is not null then
    select x.name into d from public.departments x where x.name = p_department or x.id = p_department;
    if d is null then raise exception 'Unknown department "%".', p_department; end if;
    return d;
  end if;
  select count(distinct r.department), min(r.department) into n, d from public.my_roles() r where r.kind = 'rank' and r.department is not null;
  if n = 1 then return d; end if;
  if n = 0 then raise exception 'You''re not in a department.'; end if;
  raise exception 'Pick a department (you''re in %).', n;
end $$;

create or replace function public.dept_is_leader(d text)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.directs_dept(d) or public.has_perm('activity.view', d) or public.has_perm('members.edit', d)
$$;

create or replace function public.dept_can_read(d text)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.in_dept(d) or public.dept_is_leader(d) or public.is_exec()
$$;

-- The America/New_York week (Mon 00:00) containing ts.
create or replace function public.dept_week_start(ts timestamptz default now())
returns timestamptz language sql stable set search_path = '' as $$
  select (date_trunc('week', ts at time zone 'America/New_York') at time zone 'America/New_York')
$$;

-- Someone's target in a department: their highest rank's override, else the department's.
create or replace function public.dept_target_for(who text, d text)
returns integer language sql stable security definer set search_path = '' as $$
  select coalesce((select t.minutes from public.members m join public.roles r on r.id = any (m.role_ids) and r.kind = 'rank' and r.department = d
                   join public.dept_rank_targets t on t.role_id = r.id
                   where m.discord_id = who order by r.rank_order desc nulls last limit 1),
                  (select x.weekly_minutes_target from public.departments x where x.name = d))
$$;

-- On-shift minutes in a department between two times (shifts that started in the window; breaks taken off).
create or replace function public.dept_minutes(who text, d text, since timestamptz, until timestamptz)
returns integer language sql stable security definer set search_path = '' as $$
  select coalesce((sum(public.shift_seconds(s)) / 60)::int, 0) from public.shifts s
  where s.discord_id = who and s.department = d and s.started_at >= since and s.started_at < until
$$;

-- Events attended (present/late) in a department window, for kinds that count for activity. 0 until 0075 is applied.
create or replace function public.dept_events_attended(who text, d text, since timestamptz, until timestamptz)
returns integer language plpgsql stable security definer set search_path = '' as $$
declare n int := 0;
begin
  if to_regclass('public.event_attendance') is null then return 0; end if;
  execute 'select count(*)::int from public.event_attendance a join public.events e on e.id = a.event_id join public.event_kinds k on k.kind = e.kind
           where a.discord_id = $1 and a.status in (''present'', ''late'') and k.counts_activity and coalesce(e.department, $2) = $2
             and e.starts_at >= $3 and e.starts_at < $4' into n using who, d, since, until;
  return coalesce(n, 0);
exception when undefined_column or undefined_table then return 0;
end $$;

create or replace function public.dept_streak(who text, d text)
returns integer language plpgsql stable security definer set search_path = '' as $$
declare wk timestamptz := public.dept_week_start(now()); t int := public.dept_target_for(who, d); n int := 0; i int;
begin
  if t is null or t = 0 then return 0; end if;
  for i in 1..12 loop
    exit when public.dept_minutes(who, d, wk - make_interval(weeks => i), wk - make_interval(weeks => i - 1)) < t;
    n := n + 1;
  end loop;
  if public.dept_minutes(who, d, wk, wk + interval '7 days') >= t then n := n + 1; end if;
  return least(n, 12);
end $$;

create or replace function public.dept_post_json(p public.department_posts)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('id', p.id, 'department', p.department, 'title', p.title, 'body', p.body, 'pinned', p.pinned, 'mirror', p.mirror,
    'ping', p.ping, 'author_name', p.author_name, 'created_at', p.created_at, 'updated_at', p.updated_at, 'edited_by_name', p.edited_by_name)
$$;

-- ---------- posts RPCs ----------
create or replace function public.dept_posts(p_department text default null, p_limit int default 10)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare d text := public.dept_pick(p_department);
begin
  if not public.dept_can_read(d) then raise exception 'You''re not in %.', d; end if;
  return coalesce((select jsonb_agg(public.dept_post_json(p) order by p.pinned desc, p.created_at desc)
    from (select * from public.department_posts x where x.department = d and x.deleted_at is null
          order by x.pinned desc, x.created_at desc limit least(greatest(coalesce(p_limit, 10), 1), 50)) p), '[]'::jsonb);
end $$;

create or replace function public.dept_post_save(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare me text := public.my_discord_id(); nm text := (select display_name from public.members where discord_id = public.my_discord_id());
        old public.department_posts; row public.department_posts; d text; t text := btrim(coalesce(p->>'title', '')); b text := btrim(coalesce(p->>'body', ''));
        pin boolean := coalesce((p->>'pinned')::boolean, false); mir boolean := coalesce((p->>'mirror')::boolean, false); png boolean := coalesce((p->>'ping')::boolean, false);
begin
  if p ? 'id' and p->>'id' is not null then
    select * into old from public.department_posts where id = (p->>'id')::bigint and deleted_at is null for update;
    if old.id is null then raise exception 'That post doesn''t exist.'; end if;
    d := old.department;
    -- an edit keeps any setting it doesn't mention
    if not p ? 'pinned' then pin := old.pinned; end if;
    if not p ? 'mirror' then mir := old.mirror; end if;
    if not p ? 'ping' then png := old.ping; end if;
  else
    d := public.dept_pick(p->>'department');
  end if;
  if not public.has_perm('posts.manage', d) then raise exception 'You can''t post for %.', d; end if;
  if t = '' or char_length(t) > 120 then raise exception 'Give the post a title (up to 120 characters).'; end if;
  if b = '' or char_length(b) > 4000 then raise exception 'Write the post (up to 4000 characters).'; end if;
  if png and not mir then png := false; end if;
  if pin then update public.department_posts set pinned = false where department = d and pinned and deleted_at is null and id is distinct from old.id; end if;
  if old.id is null then
    insert into public.department_posts (department, title, body, pinned, mirror, ping, author_discord_id, author_name, post_dirty)
    values (d, t, b, pin, mir, png, me, nm, mir) returning * into row;
    insert into public.department_post_log (post_id, department, action, title, by_discord_id, by_name) values (row.id, d, 'posted', t, me, nm);
  else
    update public.department_posts set title = t, body = b, pinned = pin, mirror = mir, ping = png and not pinged, updated_at = now(), edited_by_name = nm,
           post_dirty = mir or discord_message_id is not null, post_rev = post_rev + 1
    where id = old.id returning * into row;
    insert into public.department_post_log (post_id, department, action, title, by_discord_id, by_name)
    values (row.id, d, case when pin and not old.pinned then 'pinned' when old.pinned and not pin then 'unpinned' else 'edited' end, t, me, nm);
  end if;
  return public.dept_post_json(row);
end $$;

create or replace function public.dept_post_delete(p_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare old public.department_posts; me text := public.my_discord_id();
begin
  select * into old from public.department_posts where id = p_id and deleted_at is null for update;
  if old.id is null then raise exception 'That post doesn''t exist.'; end if;
  if not public.has_perm('posts.manage', old.department) then raise exception 'You can''t delete posts for %.', old.department; end if;
  update public.department_posts set deleted_at = now(), pinned = false, post_dirty = discord_message_id is not null where id = old.id;
  insert into public.department_post_log (post_id, department, action, title, by_discord_id, by_name)
  values (old.id, old.department, 'deleted', old.title, me, (select display_name from public.members where discord_id = me));
end $$;

-- ---------- targets RPCs ----------
create or replace function public.dept_set_target(p_department text, p_minutes int, p_rank_role_id text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare d text := public.dept_pick(p_department);
begin
  if not public.directs_dept(d) then raise exception 'Only the % Director can set the weekly target.', d; end if;
  if p_minutes is not null and (p_minutes < 0 or p_minutes > 10080) then raise exception 'The target is 0 to 10080 minutes a week.'; end if;
  if p_rank_role_id is null then
    update public.departments set weekly_minutes_target = p_minutes where name = d;
  else
    if not exists (select 1 from public.roles r where r.id = p_rank_role_id and r.kind = 'rank' and r.department = d) then
      raise exception 'That isn''t a % rank.', d; end if;
    if p_minutes is null then delete from public.dept_rank_targets where role_id = p_rank_role_id;
    else insert into public.dept_rank_targets (role_id, minutes, set_by) values (p_rank_role_id, p_minutes, public.my_discord_id())
         on conflict (role_id) do update set minutes = excluded.minutes, set_by = excluded.set_by, set_at = now();
    end if;
  end if;
  return public.dept_targets(d);
end $$;

create or replace function public.dept_targets(p_department text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare d text := public.dept_pick(p_department);
begin
  if not public.dept_can_read(d) then raise exception 'You''re not in %.', d; end if;
  return jsonb_build_object('department', (select x.weekly_minutes_target from public.departments x where x.name = d),
    'ranks', coalesce((select jsonb_agg(jsonb_build_object('rank_role_id', r.id, 'rank_label', r.rank_label, 'minutes', t.minutes) order by r.rank_order)
                       from public.roles r join public.dept_rank_targets t on t.role_id = r.id where r.department = d), '[]'::jsonb));
end $$;

-- ---------- the Overview ----------
create or replace function public.my_department_overview(p_department text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare d text := public.dept_pick(p_department); dep public.departments; me text := public.my_discord_id(); wk timestamptz := public.dept_week_start(now());
        rk record; mins int; tgt int; feed jsonb := '[]'::jsonb;
begin
  if not public.dept_can_read(d) then raise exception 'You''re not in %.', d; end if;
  select * into dep from public.departments where name = d;
  select r.rank_label, r.id into rk from public.my_roles() r where r.kind = 'rank' and r.department = d order by r.rank_order desc nulls last limit 1;
  mins := public.dept_minutes(me, d, wk, wk + interval '7 days');
  tgt := public.dept_target_for(me, d);
  if to_regprocedure('public.events_feed(timestamptz, timestamptz, text, text[], integer)') is not null then
    begin
      execute 'select public.events_feed(p_from => $1, p_to => $2, p_department => $3, p_limit => 8)' into feed using now(), now() + interval '7 days', d;
    exception when others then feed := '[]'::jsonb;   -- What's on must never break the Overview
    end;
  end if;
  return jsonb_build_object(
    'department', jsonb_build_object('name', dep.name, 'id', dep.id, 'color', case when dep.color is null then null else '#' || lpad(to_hex(dep.color), 6, '0') end,
                  'icon', dep.icon, 'weekly_minutes_target', dep.weekly_minutes_target,
                  'members', (select count(*) from public.members m where exists (select 1 from public.roles r where r.id = any (m.role_ids) and r.kind = 'rank' and r.department = d)),
                  'on_now', (select count(*) from public.shifts s where s.department = d and s.status in ('active', 'break'))),
    'me', jsonb_build_object('rank', rk.rank_label, 'rank_role_id', rk.id, 'can_post', public.has_perm('posts.manage', d),
                  'can_manage', public.directs_dept(d), 'leader', public.dept_is_leader(d)),
    'posts', coalesce((select jsonb_agg(public.dept_post_json(p) order by p.pinned desc, p.created_at desc) from (
               (select * from public.department_posts x where x.department = d and x.deleted_at is null and x.pinned limit 1)
               union all
               (select * from public.department_posts x where x.department = d and x.deleted_at is null and not x.pinned order by x.created_at desc limit 3)) p), '[]'::jsonb),
    'whats_on', coalesce(feed, '[]'::jsonb),
    'my_week', jsonb_build_object('week_starts', (wk at time zone 'America/New_York')::date, 'minutes', mins, 'target', tgt,
                  'percent', case when tgt is null or tgt = 0 then null else least(999, round(100.0 * mins / tgt))::int end,
                  'shifts', (select count(*) from public.shifts s where s.discord_id = me and s.department = d and s.started_at >= wk and s.started_at < wk + interval '7 days'),
                  'sessions', (select count(distinct x.id) from public.sessions x where x.started_at is not null and exists (
                                 select 1 from public.shifts s where s.discord_id = me and s.department = d and s.started_at >= wk and s.started_at < wk + interval '7 days'
                                   and s.started_at < coalesce(x.ended_at, now()) and coalesce(s.ended_at, now()) > x.started_at)),
                  'events_attended', public.dept_events_attended(me, d, wk, wk + interval '7 days'),
                  'streak', public.dept_streak(me, d)),
    'on_now', coalesce((select jsonb_agg(jsonb_build_object('discord_id', s.discord_id, 'name', coalesce(m.display_name, s.name), 'status', s.status, 'since', s.started_at,
                  'rank', (select r.rank_label from public.roles r where r.id = any (m.role_ids) and r.kind = 'rank' and r.department = d order by r.rank_order desc nulls last limit 1))
                  order by s.started_at)
               from public.shifts s left join public.members m on m.discord_id = s.discord_id
               where s.department = d and s.status in ('active', 'break')), '[]'::jsonb));
end $$;

do $g$
declare f text;
begin
  foreach f in array array['dept_pick(text)', 'dept_is_leader(text)', 'dept_can_read(text)', 'dept_target_for(text, text)', 'dept_minutes(text, text, timestamptz, timestamptz)',
                           'dept_events_attended(text, text, timestamptz, timestamptz)', 'dept_streak(text, text)', 'dept_post_json(public.department_posts)'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
  revoke execute on function public.dept_week_start(timestamptz) from public, anon;
  foreach f in array array['dept_posts(text, int)', 'dept_post_save(jsonb)', 'dept_post_delete(bigint)', 'dept_set_target(text, int, text)', 'dept_targets(text)',
                           'my_department_overview(text)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $g$;
