-- Undo 0097: Supervisor v2 off. The live functions go back to their 0096 text first (they call the new helpers), then the
-- new functions and tables go. Run before 0096.down when undoing both.
do $m$
declare d text; n text;
begin
  -- one bed: picking your own
  d := pg_get_functiondef('public.chart_own_ok(text,text[])'::regprocedure);
  n := replace(d, $b$cardinality(p_beds) > 1 then return 'bad_beds|Pick one bed.'; end if;$b$,
                  $a$cardinality(p_beds) > 2 then return 'bad_beds|Pick one or two beds.'; end if;$a$);
  if n = d then raise exception '0097 down: chart_own_ok count text not found'; end if;
  d := n;
  n := replace(d, $b$if total > 1 then return 'limit|You can hold one bed: the Supervisor can give you a second.'; end if;$b$,
                  $a$if total > 2 then return 'limit|You can hold 2 beds at most.'; end if;$a$);
  if n = d then raise exception '0097 down: chart_own_ok limit text not found'; end if;
  execute n;

  -- one bed: placing a patient in an unheld bed for someone who holds one already
  d := pg_get_functiondef('public.chart_place_ok(bigint,text,text,text,boolean)'::regprocedure);
  n := replace(d, $b$>= 1 then
      return format('limit|%s already holds a bed: the Supervisor can give them this one too.', public.chart_pname(p_person));$b$,
                  $a$>= 2 then
      return format('limit|%s already holds 2 beds.', public.chart_pname(p_person));$a$);
  if n = d then raise exception '0097 down: chart_place_ok limit text not found'; end if;
  execute n;

  -- one bed: the Open-room offer takes one bed
  d := pg_get_functiondef('public.chart_offer_take()'::regprocedure);
  n := replace(d, $b$select array_agg(y.id) into bs from (select b.id from public.chart_beds b where b.room_id = me.offer_room_id and b.available and b.owner_id is null order by b.id limit 1) y;$b$,
                  $a$select array_agg(b.id order by b.id) into bs from public.chart_beds b where b.room_id = me.offer_room_id and b.available and b.owner_id is null;$a$);
  if n = d then raise exception '0097 down: chart_offer_take text not found'; end if;
  execute n;

  -- partner request: a free bed in a room someone else holds
  d := pg_get_functiondef('public.chart_take_beds(text[])'::regprocedure);
  n := replace(d, $b$  if cardinality(p_beds) = 1 and exists (select 1 from public.chart_beds x join public.chart_beds y on y.room_id = x.room_id and y.id <> x.id
                                           where x.id = p_beds[1] and x.owner_id is null and y.owner_id is not null and y.owner_id <> me.discord_id) then
    return public.chart_partner_ask(me.discord_id, p_beds[1]);
  end if;
  update public.chart_beds set owner_id = null, owner_since = null where owner_id = me.discord_id and not id = any (p_beds);$b$,
                  $a$  update public.chart_beds set owner_id = null, owner_since = null where owner_id = me.discord_id and not id = any (p_beds);$a$);
  if n = d then raise exception '0097 down: chart_take_beds text not found'; end if;
  execute n;

  -- tick
  d := pg_get_functiondef('public.chart_tick()'::regprocedure);
  n := replace(d, $b$  if public.chart_sv_sweep() then changed := true; end if;
  if public.chart_call_sweep() then changed := true; end if;$b$,
                  $a$  if public.chart_call_sweep() then changed := true; end if;$a$);
  if n = d then raise exception '0097 down: chart_tick text not found'; end if;
  execute n;

  -- poll
  d := pg_get_functiondef('public.chart_poll(bigint)'::regprocedure);
  n := replace(d, $b$'can_join', public.chart_calls_joinable(uid), 'order', public.chart_order_mine(uid), 'visit', public.chart_visit_state(uid),
      'partner_ask', public.chart_partner_for(uid), 'partner_wait', public.chart_partner_waiting(uid), 'rank', public.chart_rank_label(uid),
      'shift_started_at', sh.started_at, 'admin', public.chart_admin_kind(uid) is not null, 'ready', me.ready,$b$,
                  $a$'can_join', public.chart_calls_joinable(uid), 'ready', me.ready,$a$);
  if n = d then raise exception '0097 down: chart_poll me text not found'; end if;
  d := n;
  n := replace(d, $b$'ready_since', s.ready_since, 'call', public.chart_call_state(s.discord_id), 'rank', public.chart_rank_label(s.discord_id),
        'admin', public.chart_admin_kind(s.discord_id) is not null, 'shift_started_at', (public.chart_shift_of(s.discord_id)).started_at,
        'visit', public.chart_visit_state(s.discord_id),$b$,
                  $a$'ready_since', s.ready_since, 'call', public.chart_call_state(s.discord_id),$a$);
  if n = d then raise exception '0097 down: chart_poll staff text not found'; end if;
  d := n;
  n := replace(d, $b$'calls', public.chart_calls_view(), 'visits', public.chart_visits_view(), 'admins', public.chart_admins_view());$b$,
                  $a$'calls', public.chart_calls_view());$a$);
  if n = d then raise exception '0097 down: chart_poll lists text not found'; end if;
  d := n;
  n := replace(d, $b$'beds', (select jsonb_agg(y.id) from (select b.id from public.chart_beds b where b.room_id = me.offer_room_id and b.available and b.owner_id is null order by b.id limit 1) y),$b$,
                  $a$'beds', (select jsonb_agg(b.id order by b.id) from public.chart_beds b where b.room_id = me.offer_room_id and b.available and b.owner_id is null),$a$);
  if n = d then raise exception '0097 down: chart_poll offer text not found'; end if;
  execute n;
end $m$;

drop function if exists public.chart_visit_remove(bigint);
drop function if exists public.chart_visit_step(bigint,text);
drop function if exists public.chart_visit_send(text,text,text,text);
drop function if exists public.chart_order_ok(bigint);
drop function if exists public.chart_order_seen(bigint);
drop function if exists public.chart_person_off(text,text,text,boolean);
drop function if exists public.chart_person_place(text,text,text,text,boolean,boolean);
drop function if exists public.chart_partner_answer(bigint,boolean);
drop function if exists public.chart_sv_sweep();
drop function if exists public.chart_sv_leave(text,text[],text,boolean);
drop function if exists public.chart_order(text,text,text);
drop function if exists public.chart_partner_ask(text,text);
drop function if exists public.chart_partner_waiting(text);
drop function if exists public.chart_partner_for(text);
drop function if exists public.chart_order_mine(text);
drop function if exists public.chart_admins_view();
drop function if exists public.chart_visits_view();
drop function if exists public.chart_visit_state(text);
drop function if exists public.chart_avatar(text);
drop function if exists public.chart_rank_label(text);
drop function if exists public.chart_admin_kind(text);

drop table if exists public.chart_visits;
drop table if exists public.chart_orders;
drop table if exists public.chart_partner_asks;
