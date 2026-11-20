-- 0095 (Bravo, 21 Nov 2026): two Chart maps, 'main' (the main ward, default) and 'main_er' (main ward + the new
-- Emergency wing). The user: "host if its set to an in game session, but the supervisor can easily change". Additive.
--   sessions.chart_map        'main' | 'main_er', default 'main' (existing rows stay 'main'); the host picks it on the
--                             session form for in-game sessions
--   chart_rooms.wing          'main' | 'er'; the ER rooms are seeded inactive (TB1-2 Surgical, ER1-6 and MT Medical)
--   chart_rooms.beds          1-3 now (MT has three chairs)
--   chart_ops.map_applied     the map the rooms are set up for right now
--   chart_map_now()           the live session's map, or 'main' when no session is live
--   chart_map_apply(p_map)    turns the ER rooms on/off (active); refuses to turn them off while they're in use
--   chart_map_sync()          called from chart_tick: keeps the rooms in step with chart_map_now(); never raises
--   chart_set_map(p_map)      supervisor (hosp.supervise) or the live session's host, during a live session
--   chart_poll                ops.map, rooms[].wing, and only beds in active rooms
--   chart_own_ok              a 3-chair room counts like a 2-bed room
-- Inactive rooms are already skipped by chart_auto_assign and chart_place_ok (so by own/take/give/move as well).
-- chart_tick, chart_poll and chart_own_ok are patched from their live definitions (exact replacements, asserted), so
-- nothing else in them changes. No trigger is added to any table. The down file reverses everything.

-- ---------- columns ----------
alter table public.sessions add column if not exists chart_map text not null default 'main';
do $c$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.sessions'::regclass and conname = 'sessions_chart_map_check') then
    alter table public.sessions add constraint sessions_chart_map_check check (chart_map in ('main', 'main_er'));
  end if;
end $c$;
-- the site writes sessions directly (column grants): let it set the map on create/edit
grant insert (chart_map), update (chart_map) on public.sessions to authenticated;

alter table public.chart_ops add column if not exists map_applied text not null default 'main';
do $c$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.chart_ops'::regclass and conname = 'chart_ops_map_applied_check') then
    alter table public.chart_ops add constraint chart_ops_map_applied_check check (map_applied in ('main', 'main_er'));
  end if;
end $c$;

alter table public.chart_rooms add column if not exists wing text not null default 'main';
do $c$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.chart_rooms'::regclass and conname = 'chart_rooms_wing_check') then
    alter table public.chart_rooms add constraint chart_rooms_wing_check check (wing in ('main', 'er'));
  end if;
end $c$;
alter table public.chart_rooms drop constraint if exists chart_rooms_beds_check;
alter table public.chart_rooms add constraint chart_rooms_beds_check check (beds between 1 and 3);

-- ---------- the Emergency wing (off until a session uses it) ----------
insert into public.chart_rooms (id, beds, area, department, who, sort, active, wing) values
  ('TB1', 1, 'tb1', 'Surgical', 'anyone', 11, false, 'er'),
  ('TB2', 1, 'tb2', 'Surgical', 'anyone', 12, false, 'er'),
  ('ER1', 1, 'er1', 'Medical',  'anyone', 13, false, 'er'),
  ('ER2', 1, 'er2', 'Medical',  'anyone', 14, false, 'er'),
  ('ER3', 1, 'er3', 'Medical',  'anyone', 15, false, 'er'),
  ('ER4', 1, 'er4', 'Medical',  'anyone', 16, false, 'er'),
  ('ER5', 1, 'er5', 'Medical',  'anyone', 17, false, 'er'),
  ('ER6', 1, 'er6', 'Medical',  'anyone', 18, false, 'er'),
  ('MT',  3, 'mt',  'Medical',  'anyone', 19, false, 'er')
on conflict (id) do nothing;
insert into public.chart_beds (id, room_id, label) values
  ('TB1', 'TB1', 'TB1'), ('TB2', 'TB2', 'TB2'),
  ('ER1', 'ER1', 'ER1'), ('ER2', 'ER2', 'ER2'), ('ER3', 'ER3', 'ER3'),
  ('ER4', 'ER4', 'ER4'), ('ER5', 'ER5', 'ER5'), ('ER6', 'ER6', 'ER6'),
  ('MTA', 'MT', 'MT Chair A'), ('MTB', 'MT', 'MT Chair B'), ('MTC', 'MT', 'MT Chair C')
on conflict (id) do nothing;

-- ---------- functions ----------
create or replace function public.chart_map_now() returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((select s.chart_map from public.sessions s where s.id = public.chart_session_live()), 'main')
$$;

-- Sets the rooms up for p_map. Returns null when done, or 'code|message' when the ER can't be turned off yet.
create or replace function public.chart_map_apply(p_map text) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare busy text;
begin
  if p_map not in ('main', 'main_er') then return 'bad_input|Pick a floor plan.'; end if;
  if p_map = 'main' then
    select r.id into busy from public.chart_rooms r join public.chart_beds b on b.room_id = r.id
    where r.wing = 'er' and r.active
      and (b.owner_id is not null or b.pair_id is not null
           or exists (select 1 from public.chart_cases c where c.status = 'open' and c.bed_id = b.id))
    order by r.sort limit 1;
    if busy is not null then
      return format('er_in_use|%s is still in use: move the patients out and free the Emergency beds first.', busy);
    end if;
    update public.chart_staff set offer_room_id = null
    where offer_room_id in (select r.id from public.chart_rooms r where r.wing = 'er');
  end if;
  update public.chart_rooms set active = (p_map = 'main_er'), updated_at = now()
  where wing = 'er' and active is distinct from (p_map = 'main_er');
  update public.chart_ops set map_applied = p_map where id = 1 and map_applied is distinct from p_map;
  return null;
end $$;

-- From chart_tick: follow the live session's map. Never raises (the Chart must keep working whatever happens here);
-- when the ER can't be turned off yet it stays on and is tried again on the next tick. True when something changed.
create or replace function public.chart_map_sync() returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare want text; have text;
begin
  -- the cheap check runs outside the exception block, so a normal tick opens no subtransaction
  select o.map_applied into have from public.chart_ops o where o.id = 1;
  if public.chart_map_now() is not distinct from have then return false; end if;
  begin
    want := public.chart_map_now();
    if public.chart_map_apply(want) is not null then return false; end if;
    insert into public.chart_log (actor_name, action, detail) values ('Auto', 'map_set', jsonb_build_object('map', want, 'from', have));
    return true;
  exception when others then
    return false;
  end;
end $$;

-- Supervisor control: change the live session's floor plan.
create or replace function public.chart_set_map(p_map text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare sid bigint; was text; e text;
begin
  if public.my_discord_id() is null then perform public.chart_err('no_access', 'Log in to use the Chart.'); end if;
  if p_map is null or p_map not in ('main', 'main_er') then perform public.chart_err('bad_input', 'Pick a floor plan.'); end if;
  perform public.chart_lock();
  perform public.chart_tick();
  sid := public.chart_session_live();
  if sid is null then perform public.chart_err('no_session', 'The floor plan can only be changed during a session.'); end if;
  if not public.chart_can_supervise() then perform public.chart_err('not_supervisor', 'Only a supervisor or the session host can change the floor plan.'); end if;
  select s.chart_map into was from public.sessions s where s.id = sid;
  e := public.chart_map_apply(p_map);
  if e is not null then perform public.chart_err(split_part(e, '|', 1), substr(e, strpos(e, '|') + 1)); end if;
  if was is distinct from p_map then
    update public.sessions set chart_map = p_map where id = sid;
  end if;
  perform public.chart_act('map_set', null, jsonb_build_object('map', p_map, 'from', was, 'session', sid));
  return public.chart_done(jsonb_build_object('map', p_map));
end $$;

revoke execute on function public.chart_map_now() from public, anon, authenticated;
revoke execute on function public.chart_map_apply(text) from public, anon, authenticated;
revoke execute on function public.chart_map_sync() from public, anon, authenticated;
revoke execute on function public.chart_set_map(text) from public, anon, authenticated;
grant execute on function public.chart_map_now() to service_role;
grant execute on function public.chart_map_apply(text) to service_role;
grant execute on function public.chart_map_sync() to service_role;
grant execute on function public.chart_set_map(text) to service_role, authenticated;

-- ---------- patches to live functions ----------
do $m$
declare d text; n text;
begin
  -- tick: follow the session's map
  d := pg_get_functiondef('public.chart_tick()'::regprocedure);
  n := replace(d, $a$  delete from public.chart_checkin_attempts where at < now() - interval '24 hours';$a$,
                  $b$  if public.chart_map_sync() then changed := true; end if;
  delete from public.chart_checkin_attempts where at < now() - interval '24 hours';$b$);
  if n = d then raise exception '0095: chart_tick text not found'; end if;
  execute n;

  -- poll: the map, each room's wing, and only beds in rooms in use
  d := pg_get_functiondef('public.chart_poll(bigint)'::regprocedure);
  n := replace(d, $a$'npc_in_session', o.npc_in_session,$a$, $b$'npc_in_session', o.npc_in_session, 'map', o.map_applied,$b$);
  if n = d then raise exception '0095: chart_poll ops text not found'; end if;
  d := n;
  n := replace(d, $a$'area', r.area,$a$, $b$'area', r.area, 'wing', r.wing,$b$);
  if n = d then raise exception '0095: chart_poll rooms text not found'; end if;
  d := n;
  n := replace(d, $a$order by b.id) from public.chart_beds b), '[]'),$a$,
                  $b$order by b.id) from public.chart_beds b join public.chart_rooms r on r.id = b.room_id where r.active), '[]'),$b$);
  if n = d then raise exception '0095: chart_poll beds text not found'; end if;
  execute n;

  -- own_ok: a 3-chair room counts like a 2-bed room
  d := pg_get_functiondef('public.chart_own_ok(text,text[])'::regprocedure);
  n := replace(d, $a$count(*) filter (where r.beds = 2)$a$, $b$count(*) filter (where r.beds >= 2)$b$);
  if n = d then raise exception '0095: chart_own_ok text not found'; end if;
  execute n;
end $m$;
