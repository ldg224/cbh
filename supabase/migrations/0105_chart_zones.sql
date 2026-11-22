-- 0105 (22 Nov 2026): the Chart's four zones. The user: "allow for you to toggle all 4 zones on and off and they all
-- display on the map so one person can do the entire two floors, or you can have 2 different supervisors". Plans:
-- Plans/CareBeyond/chart/maps/floor2/second-floor-zones.html (approved). Additive.
--   Zone 1  the main ward, 101-110 (wing 'main')
--   Zone 2  Emergency: Trauma Bays, ER 1-6, Minor Triage (wing 'er')
--   Zone 3  2nd floor: Pre-Op (4 beds), OR 1-3, PACU 1-3, ICU 1-6 (wing 'z3'; seeded inactive)
--   Zone 4  2nd floor: Pediatrics 201-204 (children only), Med-Surg 205-209 (wing 'z4'; seeded inactive)
-- A map is now any set of zones. It's stored as before in sessions.chart_map / chart_ops.map_applied: 'main' (zone 1)
-- and 'main_er' (zones 1 and 2) keep their old spelling, so the session form and old rows work unchanged; any other set
-- is the zone numbers in order, e.g. '1,2,3,4', '3,4' or '4'.
--   chart_map_zones(text)   the zones in a map
--   chart_map_norm(text)    a map in its one stored spelling, or null if it isn't a map
--   chart_map_apply(p_map)  turns each zone's rooms on/off; refuses to turn off a zone whose beds are in use. Zone 1
--                           can now be turned off too (a session that only runs the 2nd floor).
--   chart_set_map(p_map)    takes any map (stored normalised)
--   chart_room_name         names the new rooms
-- Supervisors also pick which of the open zones they look after; that's kept on their own device (chart.js).
-- The down file reverses everything (it refuses while a new room is in use or a session uses a new map).

-- ---------- spelling ----------
create or replace function public.chart_map_zones(p_map text) returns int[]
language sql immutable set search_path = '' as $$
  select case when p_map = 'main' then array[1]
              when p_map = 'main_er' then array[1, 2]
              when p_map ~ '^[1-4](,[1-4]){0,3}$' then (select array_agg(distinct z::int order by z::int) from unnest(string_to_array(p_map, ',')) z)
              else null end
$$;

create or replace function public.chart_map_norm(p_map text) returns text
language sql immutable set search_path = '' as $$
  select case when z is null then null
              when z = array[1] then 'main'
              when z = array[1, 2] then 'main_er'
              else array_to_string(z, ',') end
  from (select public.chart_map_zones(p_map) z) x
$$;

-- ---------- columns ----------
alter table public.sessions drop constraint if exists sessions_chart_map_check;
-- (plain patterns, not chart_map_norm: the site writes sessions directly and the checks must not need a grant)
alter table public.sessions add constraint sessions_chart_map_check
  check (chart_map in ('main', 'main_er') or (chart_map ~ '^[1-4](,[1-4]){0,3}$' and chart_map not in ('1', '1,2')));
alter table public.chart_ops drop constraint if exists chart_ops_map_applied_check;
alter table public.chart_ops add constraint chart_ops_map_applied_check
  check (map_applied in ('main', 'main_er') or (map_applied ~ '^[1-4](,[1-4]){0,3}$' and map_applied not in ('1', '1,2')));
alter table public.chart_rooms drop constraint if exists chart_rooms_wing_check;
alter table public.chart_rooms add constraint chart_rooms_wing_check check (wing in ('main', 'er', 'z3', 'z4'));
alter table public.chart_rooms drop constraint if exists chart_rooms_beds_check;
alter table public.chart_rooms add constraint chart_rooms_beds_check check (beds between 1 and 4);

-- ---------- the 2nd floor (off until a session uses it) ----------
insert into public.chart_rooms (id, beds, area, department, who, sort, active, wing) values
  ('PO',    4, 'po',    'Surgical', 'anyone', 20, false, 'z3'),
  ('OR1',   1, 'or1',   'Surgical', 'anyone', 21, false, 'z3'),
  ('OR2',   1, 'or2',   'Surgical', 'anyone', 22, false, 'z3'),
  ('OR3',   1, 'or3',   'Surgical', 'anyone', 23, false, 'z3'),
  ('PACU1', 1, 'pacu1', 'Surgical', 'anyone', 24, false, 'z3'),
  ('PACU2', 1, 'pacu2', 'Surgical', 'anyone', 25, false, 'z3'),
  ('PACU3', 1, 'pacu3', 'Surgical', 'anyone', 26, false, 'z3'),
  ('ICU1',  1, 'icu1',  'Medical',  'anyone', 27, false, 'z3'),
  ('ICU2',  1, 'icu2',  'Medical',  'anyone', 28, false, 'z3'),
  ('ICU3',  1, 'icu3',  'Medical',  'anyone', 29, false, 'z3'),
  ('ICU4',  1, 'icu4',  'Medical',  'anyone', 30, false, 'z3'),
  ('ICU5',  1, 'icu5',  'Medical',  'anyone', 31, false, 'z3'),
  ('ICU6',  1, 'icu6',  'Medical',  'anyone', 32, false, 'z3'),
  ('201',   1, 'r201',  'Nursing',  'kids',   33, false, 'z4'),
  ('202',   1, 'r202',  'Nursing',  'kids',   34, false, 'z4'),
  ('203',   1, 'r203',  'Nursing',  'kids',   35, false, 'z4'),
  ('204',   1, 'r204',  'Nursing',  'kids',   36, false, 'z4'),
  ('205',   1, 'r205',  'Medical',  'anyone', 37, false, 'z4'),
  ('206',   1, 'r206',  'Medical',  'anyone', 38, false, 'z4'),
  ('207',   1, 'r207',  'Medical',  'anyone', 39, false, 'z4'),
  ('208',   1, 'r208',  'Medical',  'anyone', 40, false, 'z4'),
  ('209',   1, 'r209',  'Medical',  'anyone', 41, false, 'z4')
on conflict (id) do nothing;
insert into public.chart_beds (id, room_id, label) values
  ('POA', 'PO', 'PO Bed A'), ('POB', 'PO', 'PO Bed B'), ('POC', 'PO', 'PO Bed C'), ('POD', 'PO', 'PO Bed D'),
  ('OR1', 'OR1', 'OR1'), ('OR2', 'OR2', 'OR2'), ('OR3', 'OR3', 'OR3'),
  ('PACU1', 'PACU1', 'PACU1'), ('PACU2', 'PACU2', 'PACU2'), ('PACU3', 'PACU3', 'PACU3'),
  ('ICU1', 'ICU1', 'ICU1'), ('ICU2', 'ICU2', 'ICU2'), ('ICU3', 'ICU3', 'ICU3'),
  ('ICU4', 'ICU4', 'ICU4'), ('ICU5', 'ICU5', 'ICU5'), ('ICU6', 'ICU6', 'ICU6'),
  ('201', '201', '201'), ('202', '202', '202'), ('203', '203', '203'), ('204', '204', '204'),
  ('205', '205', '205'), ('206', '206', '206'), ('207', '207', '207'), ('208', '208', '208'), ('209', '209', '209')
on conflict (id) do nothing;

-- ---------- functions ----------
create or replace function public.chart_room_name(p_room text) returns text
language sql immutable set search_path = '' as $$
  select case when p_room ~ '^TB[0-9]+$' then 'Trauma Bay ' || substr(p_room, 3)
              when p_room ~ '^ER[0-9]+$' then 'ER ' || substr(p_room, 3)
              when p_room = 'MT' then 'Minor Triage'
              when p_room = 'PO' then 'Pre-Op'
              when p_room ~ '^OR[0-9]+$' then 'OR ' || substr(p_room, 3)
              when p_room ~ '^PACU[0-9]+$' then 'PACU ' || substr(p_room, 5)
              when p_room ~ '^ICU[0-9]+$' then 'ICU ' || substr(p_room, 4)
              when p_room is null then 'a room'
              else 'Room ' || p_room end
$$;

-- Sets the rooms up for p_map. Returns null when done, or 'code|message' when a zone can't be turned off yet.
create or replace function public.chart_map_apply(p_map text) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare m text := public.chart_map_norm(p_map); z int[]; busy text; busy_wing text;
begin
  if m is null then return 'bad_input|Pick at least one zone.'; end if;
  z := public.chart_map_zones(m);
  -- a zone going off must be empty: nobody holding its beds and no patient in them
  select r.id, r.wing into busy, busy_wing from public.chart_rooms r join public.chart_beds b on b.room_id = r.id
  where r.active and not (case r.wing when 'main' then 1 when 'er' then 2 when 'z3' then 3 else 4 end = any (z))
    and (b.owner_id is not null or b.pair_id is not null
         or exists (select 1 from public.chart_cases c where c.status = 'open' and c.bed_id = b.id))
  order by r.sort limit 1;
  if busy is not null then
    return format('zone_in_use|%s is still in use: move the patients out and free its beds before closing Zone %s.',
                  public.chart_room_name(busy), case busy_wing when 'main' then 1 when 'er' then 2 when 'z3' then 3 else 4 end);
  end if;
  update public.chart_staff set offer_room_id = null
  where offer_room_id in (select r.id from public.chart_rooms r
                          where not (case r.wing when 'main' then 1 when 'er' then 2 when 'z3' then 3 else 4 end = any (z)));
  perform public.chart_room_cancel(r.id, r.wing = 'er') from public.chart_rooms r
  where r.active and not (case r.wing when 'main' then 1 when 'er' then 2 when 'z3' then 3 else 4 end = any (z));
  update public.chart_rooms r set active = x.want, updated_at = now()
  from (select id, (case wing when 'main' then 1 when 'er' then 2 when 'z3' then 3 else 4 end = any (z)) want from public.chart_rooms) x
  where x.id = r.id and r.active is distinct from x.want;
  update public.chart_ops set map_applied = m where id = 1 and map_applied is distinct from m;
  -- closing Zone 3 hands the classroom back
  update public.chart_ops set class_by = null, class_at = null, class_session = null
  where id = 1 and class_by is not null and not 3 = any (public.chart_map_zones(m));
  return null;
end $$;

-- Supervisor control: change the live session's zones.
create or replace function public.chart_set_map(p_map text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare sid bigint; was text; e text; m text := public.chart_map_norm(p_map);
begin
  if public.my_discord_id() is null then perform public.chart_err('no_access', 'Log in to use the Chart.'); end if;
  if m is null then perform public.chart_err('bad_input', 'Pick at least one zone.'); end if;
  perform public.chart_lock();
  perform public.chart_tick();
  sid := public.chart_session_live();
  if sid is null then perform public.chart_err('no_session', 'The zones can only be changed during a session.'); end if;
  if not public.chart_can_supervise() then perform public.chart_err('not_supervisor', 'Only a supervisor or the session host can change the zones.'); end if;
  select s.chart_map into was from public.sessions s where s.id = sid;
  e := public.chart_map_apply(m);
  if e is not null then perform public.chart_err(split_part(e, '|', 1), substr(e, strpos(e, '|') + 1)); end if;
  if was is distinct from m then
    update public.sessions set chart_map = m where id = sid;
  end if;
  perform public.chart_act('map_set', null, jsonb_build_object('map', m, 'from', was, 'session', sid));
  return public.chart_done(jsonb_build_object('map', m));
end $$;

revoke execute on function public.chart_map_zones(text) from public, anon, authenticated;
revoke execute on function public.chart_map_norm(text) from public, anon, authenticated;
revoke execute on function public.chart_map_apply(text) from public, anon, authenticated;
revoke execute on function public.chart_set_map(text) from public, anon, authenticated;
grant execute on function public.chart_map_zones(text) to service_role;
grant execute on function public.chart_map_norm(text) to service_role;
grant execute on function public.chart_map_apply(text) to service_role;
grant execute on function public.chart_set_map(text) to service_role, authenticated;

-- ---------- the Medical Classroom (Zone 3) is booked out, never given patients ----------
-- The user (22 Nov 2026): "allow me to book out the classroom rather than assign patients to it". It isn't a
-- chart_rooms row, so nothing can place a patient there. Anyone on shift in the Chart books it for this session; the
-- person who booked it or a supervisor hands it back. It ends with the session (the poll only shows a booking made in
-- the live session) or when Zone 3 closes (chart_map_apply above).
alter table public.chart_ops add column if not exists class_by text;
alter table public.chart_ops add column if not exists class_at timestamptz;
alter table public.chart_ops add column if not exists class_session bigint;

create or replace function public.chart_classroom(p_book boolean) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare me public.chart_staff := public.chart_begin(); o public.chart_ops; sid bigint := public.chart_session_live();
begin
  if p_book is null then perform public.chart_err('bad_input', 'Book the classroom or hand it back.'); end if;
  if sid is null then perform public.chart_err('no_session', 'The classroom can only be booked during a session.'); end if;
  select * into o from public.chart_ops where id = 1;
  if not 3 = any (public.chart_map_zones(o.map_applied)) then
    perform public.chart_err('zone_off', 'The classroom is in Zone 3, which isn''t open this session.');
  end if;
  if o.class_session is distinct from sid then o.class_by := null; end if;   -- a booking from an earlier session has ended
  if p_book then
    if o.class_by = me.discord_id then return public.chart_done(); end if;
    if o.class_by is not null then
      perform public.chart_err('class_booked', format('%s has the classroom booked.', public.chart_short(o.class_by)));
    end if;
    update public.chart_ops set class_by = me.discord_id, class_at = now(), class_session = sid where id = 1;
    perform public.chart_act('class_book');
  else
    if o.class_by is null then return public.chart_done(); end if;
    if o.class_by is distinct from me.discord_id and me.role is distinct from 'supervisor' and not public.chart_can_supervise() then
      perform public.chart_err('not_yours', format('%s has the classroom booked: they or a supervisor can hand it back.', public.chart_short(o.class_by)));
    end if;
    update public.chart_ops set class_by = null, class_at = null, class_session = null where id = 1;
    perform public.chart_act('class_free', null, jsonb_build_object('booked_by', o.class_by));
  end if;
  return public.chart_done();
end $$;
revoke execute on function public.chart_classroom(boolean) from public, anon, authenticated;
grant execute on function public.chart_classroom(boolean) to service_role, authenticated;

-- the poll's ops gain 'classroom' (who has it, since when) while a booking from the live session stands
do $m$
declare d text; n text;
begin
  d := pg_get_functiondef('public.chart_poll_shared()'::regprocedure);
  n := replace(d, $a$'online_mode', o.online_mode, 'launched', o.launched) from public.chart_ops o where o.id = 1)$a$,
                  $b$'online_mode', o.online_mode, 'launched', o.launched,
       'classroom', case when o.class_by is not null and o.class_session = public.chart_session_live()
                         then jsonb_build_object('by', o.class_by, 'name', public.chart_pname(o.class_by), 'at', o.class_at) end) from public.chart_ops o where o.id = 1)$b$);
  if n = d then raise exception '0105: chart_poll_shared text not found'; end if;
  execute n;
end $m$;
