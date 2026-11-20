-- Undo 0095: one map again. The live functions go back to their 0094 text, the map functions and columns go, and
-- the Emergency wing rooms and beds are removed (kept but switched off if old patient records point at their beds).
do $m$
declare d text; n text;
begin
  d := pg_get_functiondef('public.chart_tick()'::regprocedure);
  n := replace(d, $b$  if public.chart_map_sync() then changed := true; end if;
  delete from public.chart_checkin_attempts where at < now() - interval '24 hours';$b$,
                  $a$  delete from public.chart_checkin_attempts where at < now() - interval '24 hours';$a$);
  if n = d then raise exception '0095 down: chart_tick text not found'; end if;
  execute n;

  d := pg_get_functiondef('public.chart_poll(bigint)'::regprocedure);
  n := replace(d, $b$'npc_in_session', o.npc_in_session, 'map', o.map_applied,$b$, $a$'npc_in_session', o.npc_in_session,$a$);
  if n = d then raise exception '0095 down: chart_poll ops text not found'; end if;
  d := n;
  n := replace(d, $b$'area', r.area, 'wing', r.wing,$b$, $a$'area', r.area,$a$);
  if n = d then raise exception '0095 down: chart_poll rooms text not found'; end if;
  d := n;
  n := replace(d, $b$order by b.id) from public.chart_beds b join public.chart_rooms r on r.id = b.room_id where r.active), '[]'),$b$,
                  $a$order by b.id) from public.chart_beds b), '[]'),$a$);
  if n = d then raise exception '0095 down: chart_poll beds text not found'; end if;
  execute n;

  d := pg_get_functiondef('public.chart_own_ok(text,text[])'::regprocedure);
  n := replace(d, $b$count(*) filter (where r.beds >= 2)$b$, $a$count(*) filter (where r.beds = 2)$a$);
  if n = d then raise exception '0095 down: chart_own_ok text not found'; end if;
  execute n;
end $m$;

drop function if exists public.chart_set_map(text);
drop function if exists public.chart_map_sync();
drop function if exists public.chart_map_apply(text);
drop function if exists public.chart_map_now();

-- Emergency wing: refuse while it's in use; otherwise remove what no patient record points at, switch off the rest.
do $e$ begin
  if exists (select 1 from public.chart_beds b join public.chart_rooms r on r.id = b.room_id
             where r.wing = 'er' and (b.owner_id is not null or b.pair_id is not null
                   or exists (select 1 from public.chart_cases c where c.status = 'open' and c.bed_id = b.id))) then
    raise exception '0095 down: the Emergency wing is in use; free it first';
  end if;
end $e$;
update public.chart_staff set offer_room_id = null where offer_room_id in (select r.id from public.chart_rooms r where r.wing = 'er');
delete from public.chart_beds b
where b.room_id in (select r.id from public.chart_rooms r where r.wing = 'er')
  and not exists (select 1 from public.chart_cases c where c.bed_id = b.id);
delete from public.chart_rooms r
where r.wing = 'er' and not exists (select 1 from public.chart_beds b where b.room_id = r.id);
update public.chart_rooms set active = false where wing = 'er' and active;
-- MT keeps three chairs only if it survived above; the old 1-2 check comes back only when no room breaks it
alter table public.chart_rooms drop constraint if exists chart_rooms_beds_check;
do $c$ begin
  if not exists (select 1 from public.chart_rooms where beds > 2) then
    alter table public.chart_rooms add constraint chart_rooms_beds_check check (beds between 1 and 2);
  else
    alter table public.chart_rooms add constraint chart_rooms_beds_check check (beds between 1 and 3);
  end if;
end $c$;
alter table public.chart_rooms drop constraint if exists chart_rooms_wing_check;
alter table public.chart_rooms drop column if exists wing;

alter table public.chart_ops drop constraint if exists chart_ops_map_applied_check;
alter table public.chart_ops drop column if exists map_applied;

revoke insert (chart_map), update (chart_map) on public.sessions from authenticated;
alter table public.sessions drop constraint if exists sessions_chart_map_check;
alter table public.sessions drop column if exists chart_map;
