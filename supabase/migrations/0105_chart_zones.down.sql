-- 0105 down: back to the two maps ('main', 'main_er'). Refuses while a session or the Chart uses another map, or
-- while a 2nd-floor bed is held or has a patient.
do $d$ begin
  if exists (select 1 from public.sessions where chart_map not in ('main', 'main_er'))
     or exists (select 1 from public.chart_ops where map_applied not in ('main', 'main_er')) then
    raise exception '0105 down: a session or the Chart still uses a zone map; set it back to main or main_er first';
  end if;
  if exists (select 1 from public.chart_beds b join public.chart_rooms r on r.id = b.room_id
             where r.wing in ('z3', 'z4') and (b.owner_id is not null or b.pair_id is not null
               or exists (select 1 from public.chart_cases c where c.status = 'open' and c.bed_id = b.id))) then
    raise exception '0105 down: a 2nd-floor bed is in use';
  end if;
end $d$;

update public.chart_staff set offer_room_id = null
where offer_room_id in (select id from public.chart_rooms where wing in ('z3', 'z4'));
delete from public.chart_beds where room_id in (select id from public.chart_rooms where wing in ('z3', 'z4'));
delete from public.chart_rooms where wing in ('z3', 'z4');

alter table public.sessions drop constraint if exists sessions_chart_map_check;
alter table public.sessions add constraint sessions_chart_map_check check (chart_map in ('main', 'main_er'));
alter table public.chart_ops drop constraint if exists chart_ops_map_applied_check;
alter table public.chart_ops add constraint chart_ops_map_applied_check check (map_applied in ('main', 'main_er'));
alter table public.chart_rooms drop constraint if exists chart_rooms_wing_check;
alter table public.chart_rooms add constraint chart_rooms_wing_check check (wing in ('main', 'er'));
alter table public.chart_rooms drop constraint if exists chart_rooms_beds_check;
alter table public.chart_rooms add constraint chart_rooms_beds_check check (beds between 1 and 3);

create or replace function public.chart_room_name(p_room text) returns text
language sql immutable set search_path = '' as $$
  select case when p_room ~ '^TB[0-9]+$' then 'Trauma Bay ' || substr(p_room, 3)
              when p_room ~ '^ER[0-9]+$' then 'ER ' || substr(p_room, 3)
              when p_room = 'MT' then 'Minor Triage'
              when p_room is null then 'a room'
              else 'Room ' || p_room end
$$;

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
    perform public.chart_room_cancel(r.id, true) from public.chart_rooms r where r.wing = 'er' and r.active;
  end if;
  update public.chart_rooms set active = (p_map = 'main_er'), updated_at = now()
  where wing = 'er' and active is distinct from (p_map = 'main_er');
  -- 0105 could switch the main ward off: make sure it's back on
  update public.chart_rooms set active = true, updated_at = now() where wing = 'main' and not active;
  update public.chart_ops set map_applied = p_map where id = 1 and map_applied is distinct from p_map;
  return null;
end $$;

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

drop function if exists public.chart_map_norm(text);
drop function if exists public.chart_map_zones(text);

-- the classroom booking
do $m$
declare d text; n text;
begin
  d := pg_get_functiondef('public.chart_poll_shared()'::regprocedure);
  n := replace(d, $b$'online_mode', o.online_mode, 'launched', o.launched,
       'classroom', case when o.class_by is not null and o.class_session = public.chart_session_live()
                         then jsonb_build_object('by', o.class_by, 'name', public.chart_pname(o.class_by), 'at', o.class_at) end) from public.chart_ops o where o.id = 1)$b$,
                  $a$'online_mode', o.online_mode, 'launched', o.launched) from public.chart_ops o where o.id = 1)$a$);
  if n = d then raise exception '0105 down: chart_poll_shared text not found'; end if;
  execute n;
end $m$;
drop function if exists public.chart_classroom(boolean);
alter table public.chart_ops drop column if exists class_by;
alter table public.chart_ops drop column if exists class_at;
alter table public.chart_ops drop column if exists class_session;
