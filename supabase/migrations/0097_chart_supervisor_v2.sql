-- 0097 (Bravo, 21 Nov 2026): Chart Supervisor v2 (Plans/CareBeyond/chart/supervisor-v2.md; every rule is the user's answer).
-- Additive.
--   One bed per person      self-pick, the Open-room offer, chart_give_room and chart_assign into an unheld bed take one
--                           bed; the Supervisor gives a second with chart_person_place(.., 'add') (cap 2)
--   Partner requests        chart_take_beds on a free bed in a room someone else holds asks that person
--                           (chart_partner_asks); chart_partner_answer; no answer in 60 s = no (tick)
--   Supervisor moves        chart_person_place(person, bed, move|add, hand_to, move_anyway, override_dept),
--                           chart_person_off(person, bed|null, hand_to, move_anyway). Room staff only; patients in the
--                           old bed(s) ask first (has_patients); a department clash asks (dept_clash)
--   Orders                  every Supervisor move/add/off/handover makes an order for the person (chart_orders):
--                           sent -> seen -> ok; chart_order_seen, chart_order_ok; me.order in the poll
--   Visits                  chart_visit_send / chart_visit_step / chart_visit_remove (chart_visits): admins, execs,
--                           Directors and On call people, sent -> on_way -> arrived -> done (or removed)
--   Poll                    me.offer.beds = the one bed the offer gives; admins on shift, visits, me.order/visit/partner_ask/partner_wait/rank/shift_started_at/admin,
--                           staff[].rank/admin/shift_started_at/visit
--   Tick                    partner asks expire, visits and orders of people who clocked out close (guarded block)
-- No triggers. Live functions are patched by exact text replacement (asserted); the down file reverses them.

-- ---------- tables (no client access) ----------
create table if not exists public.chart_partner_asks (
  id          bigint generated always as identity primary key,
  asker       text not null,
  holder      text not null,
  bed_id      text not null,
  room_id     text not null,
  asked_at    timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '60 seconds',
  state       text not null default 'pending' check (state in ('pending', 'accepted', 'declined', 'expired', 'cancelled', 'failed')),
  answered_at timestamptz
);
create index if not exists chart_partner_asks_pending on public.chart_partner_asks (holder) where state = 'pending';

create table if not exists public.chart_orders (
  id        bigint generated always as identity primary key,
  person    text not null,
  kind      text not null check (kind in ('move', 'add', 'off', 'handover')),
  room_id   text,
  bed_id    text,
  by_id     text,
  at        timestamptz not null default now(),
  state     text not null default 'sent' check (state in ('sent', 'seen', 'ok', 'expired')),
  seen_at   timestamptz,
  ok_at     timestamptz
);
create index if not exists chart_orders_open on public.chart_orders (person) where state in ('sent', 'seen');

create table if not exists public.chart_visits (
  id          bigint generated always as identity primary key,
  person      text not null,
  room_id     text not null,
  reason      text not null check (reason in ('help', 'complaint', 'check_staff', 'second_opinion', 'medical', 'custom')),
  note        text check (note is null or char_length(note) <= 120),
  by_id       text,
  sent_at     timestamptz not null default now(),
  state       text not null default 'sent' check (state in ('sent', 'on_way', 'arrived', 'done', 'removed')),
  on_way_at   timestamptz,
  arrived_at  timestamptz,
  ended_at    timestamptz,
  ended_by    text,
  end_reason  text
);
create unique index if not exists chart_visits_one_active on public.chart_visits (person) where state in ('sent', 'on_way', 'arrived');

alter table public.chart_partner_asks enable row level security;
alter table public.chart_orders enable row level security;
alter table public.chart_visits enable row level security;
revoke all on table public.chart_partner_asks, public.chart_orders, public.chart_visits from public, anon, authenticated;
grant all on table public.chart_partner_asks, public.chart_orders, public.chart_visits to service_role;

-- ---------- people ----------
-- 'exec' | 'director' | 'admin' (Administration) | null, for anyone (is_exec/directs_any only answer for the caller).
create or replace function public.chart_admin_kind(who text) returns text
language sql stable security definer set search_path = '' as $$
  select case when bool_or(public.is_owner_role(r.id)) then 'exec'
              when bool_or(r.kind = 'rank' and r.rank_label = 'Director') then 'director'
              when bool_or(r.department = 'Administration' and r.kind in ('department', 'rank')) then 'admin' end
  from public.members m join public.roles r on r.id = any (m.role_ids) where m.discord_id = who
$$;

-- Their rank for the hover card: Executive, else their highest rank (the shift's department first).
create or replace function public.chart_rank_label(who text) returns text
language sql stable security definer set search_path = '' as $$
  select case when public.chart_admin_kind(who) = 'exec' then 'Executive' else
    (select r.rank_label from public.members m join public.roles r on r.id = any (m.role_ids)
     where m.discord_id = who and r.kind = 'rank' and r.rank_label is not null
     order by (r.department = (public.chart_shift_of(who)).department) desc, r.rank_order desc nulls last limit 1) end
$$;

create or replace function public.chart_avatar(who text) returns text
language sql stable security definer set search_path = '' as $$
  select m.avatar_url from public.members m where m.discord_id = who
$$;

-- ---------- views for the poll ----------
create or replace function public.chart_visit_state(who text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', v.id, 'room', v.room_id, 'reason', v.reason, 'note', v.note, 'state', v.state)
  from public.chart_visits v where v.person = who and v.state in ('sent', 'on_way', 'arrived') order by v.id desc limit 1
$$;

create or replace function public.chart_visits_view() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', v.id, 'person', v.person, 'name', public.chart_pname(v.person), 'avatar_url', public.chart_avatar(v.person),
           'room', v.room_id, 'reason', v.reason, 'note', v.note, 'state', v.state, 'sent_at', v.sent_at, 'on_way_at', v.on_way_at,
           'arrived_at', v.arrived_at, 'by_name', public.chart_short(v.by_id)) order by v.sent_at), '[]'::jsonb)
  from public.chart_visits v where v.state in ('sent', 'on_way', 'arrived')
$$;

-- Administration, executives and Directors on shift (whether or not they've opened the Chart).
create or replace function public.chart_admins_view() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('discord_id', x.discord_id, 'name', public.chart_pname(x.discord_id), 'avatar_url', public.chart_avatar(x.discord_id),
           'rank', public.chart_rank_label(x.discord_id), 'admin_kind', x.k, 'role', (select st.role from public.chart_staff st where st.discord_id = x.discord_id),
           'shift_department', x.department, 'shift_started_at', x.started_at, 'visit', public.chart_visit_state(x.discord_id))
         order by array_position(array['exec', 'director', 'admin'], x.k), public.chart_pname(x.discord_id)), '[]'::jsonb)
  from (select distinct on (s.discord_id) s.discord_id, s.department, s.started_at, public.chart_admin_kind(s.discord_id) k
        from public.shifts s where s.status <> 'ended' order by s.discord_id, s.started_at desc) x
  where x.k is not null
$$;

create or replace function public.chart_order_mine(who text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', o.id, 'kind', o.kind, 'room', o.room_id, 'bed', o.bed_id, 'bed_label', (select b.label from public.chart_beds b where b.id = o.bed_id),
         'by_name', public.chart_short(o.by_id), 'at', o.at, 'state', o.state)
  from public.chart_orders o where o.person = who and o.state in ('sent', 'seen') order by o.id limit 1
$$;

create or replace function public.chart_partner_for(who text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', a.id, 'from', jsonb_build_object('discord_id', a.asker, 'name', public.chart_pname(a.asker)), 'room', a.room_id,
         'bed', a.bed_id, 'bed_label', (select b.label from public.chart_beds b where b.id = a.bed_id), 'expires_at', a.expires_at)
  from public.chart_partner_asks a where a.holder = who and a.state = 'pending' and a.expires_at > now() order by a.id limit 1
$$;

create or replace function public.chart_partner_waiting(who text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', a.id, 'holder', jsonb_build_object('discord_id', a.holder, 'name', public.chart_pname(a.holder)), 'room', a.room_id,
         'bed', a.bed_id, 'expires_at', a.expires_at)
  from public.chart_partner_asks a where a.asker = who and a.state = 'pending' and a.expires_at > now() order by a.id desc limit 1
$$;

-- ---------- partner requests ----------
-- From chart_take_beds: the one bed picked is in a room someone else holds. Asks the holder.
create or replace function public.chart_partner_ask(p_asker text, p_bed text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare b public.chart_beds; e text; h text; aid bigint; exp timestamptz;
begin
  select * into b from public.chart_beds x where x.id = p_bed;
  e := public.chart_place_ok(null, p_bed, null, 'own');
  if e is not null then perform public.chart_err(split_part(e, '|', 1), substr(e, strpos(e, '|') + 1)); end if;
  select y.owner_id into h from public.chart_beds y where y.room_id = b.room_id and y.id <> b.id and y.owner_id is not null and y.owner_id <> p_asker
  order by y.owner_since nulls last, y.id limit 1;
  if h is null then perform public.chart_err('bad_beds', 'Nobody holds that room now: pick the bed again.'); end if;
  update public.chart_partner_asks set state = 'cancelled', answered_at = now() where asker = p_asker and state = 'pending';
  insert into public.chart_partner_asks (asker, holder, bed_id, room_id) values (p_asker, h, b.id, b.room_id) returning id, expires_at into aid, exp;
  perform public.chart_act('partner_ask', null, jsonb_build_object('ask', aid, 'bed', b.id, 'holder', h), b.room_id, null, h);
  return public.chart_done(jsonb_build_object('partner_pending', true, 'ask_id', aid, 'expires_at', exp,
                                             'holder', jsonb_build_object('discord_id', h, 'name', public.chart_pname(h))));
end $$;

create or replace function public.chart_partner_answer(p_ask bigint, p_yes boolean) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare me public.chart_staff := public.chart_begin(); a public.chart_partner_asks; s public.chart_staff; why text; e text;
begin
  if p_yes is null then perform public.chart_err('bad_input', 'Say yes or no.'); end if;
  select * into a from public.chart_partner_asks x where x.id = p_ask for update;
  if a.id is null or a.holder is distinct from me.discord_id then perform public.chart_err('not_called', 'That request isn''t for you.'); end if;
  if a.state <> 'pending' or a.expires_at <= now() then perform public.chart_err('ask_over', 'That request has ended.'); end if;
  if not p_yes then
    update public.chart_partner_asks set state = 'declined', answered_at = now() where id = a.id;
    perform public.chart_notice(a.asker, format('%s said no to sharing Room %s: pick another bed.', public.chart_short(me.discord_id), a.room_id));
    perform public.chart_act('partner_no', null, jsonb_build_object('ask', a.id, 'bed', a.bed_id), a.room_id, null, a.asker);
    return public.chart_done();
  end if;
  -- yes: the asker takes the bed if they still can (the same rules as picking it themselves)
  select * into s from public.chart_staff x where x.discord_id = a.asker;
  if s.discord_id is null or (public.chart_shift_of(a.asker)).id is null then why := format('%s isn''t on shift any more.', public.chart_pname(a.asker));
  elsif coalesce(s.role, '') not in ('room', 'on_call') then why := format('%s isn''t working Patient Care now.', public.chart_pname(a.asker));
  elsif public.chart_load(a.asker) > 0 then why := format('%s has patients now.', public.chart_pname(a.asker));
  elsif (select x.owner_id from public.chart_beds x where x.id = a.bed_id) is not null then why := 'Someone else took that bed.';
  else
    e := public.chart_place_ok(null, a.bed_id, null, 'own');
    if e is not null then why := substr(e, strpos(e, '|') + 1); end if;
  end if;
  if why is not null then
    update public.chart_partner_asks set state = 'failed', answered_at = now() where id = a.id;
    perform public.chart_notice(a.asker, format('%s said yes, but %s Pick another bed.', public.chart_short(me.discord_id), why));
    return public.chart_done(jsonb_build_object('taken', false, 'reason', why));
  end if;
  update public.chart_beds set owner_id = null, owner_since = null where owner_id = a.asker and id <> a.bed_id;
  update public.chart_beds set owner_id = a.asker, owner_since = now() where id = a.bed_id and owner_id is null;
  update public.chart_partner_asks set state = 'accepted', answered_at = now() where id = a.id;
  perform public.chart_notice(a.asker, format('%s said yes: %s is yours.', public.chart_short(me.discord_id), (select b.label from public.chart_beds b where b.id = a.bed_id)));
  perform public.chart_act('partner_yes', null, jsonb_build_object('ask', a.id, 'bed', a.bed_id), a.room_id, null, a.asker);
  return public.chart_done(jsonb_build_object('taken', true));
end $$;

-- ---------- Supervisor moves ----------
create or replace function public.chart_order(p_person text, p_kind text, p_bed text) returns bigint
language sql volatile security definer set search_path = '' as $$
  insert into public.chart_orders (person, kind, room_id, bed_id, by_id)
  values (p_person, p_kind, (select b.room_id from public.chart_beds b where b.id = p_bed), p_bed, public.my_discord_id())
  returning id
$$;

-- What to do with the patients in beds a person is leaving: ask (has_patients), leave them for Up next (anyway), or
-- hand the beds with patients, and the patients, to another Room person.
create or replace function public.chart_sv_leave(p_person text, p_beds text[], p_hand_to text, p_anyway boolean) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare names text; t public.chart_staff; hb text[]; x text;
begin
  select string_agg(public.checkin_short_name(c.patient_name) || ' in ' || coalesce((select b.label from public.chart_beds b where b.id = c.bed_id), 'no bed'), ', ' order by c.id)
  into names from public.chart_cases c
  where c.status = 'open' and c.state is not null and (c.bed_id = any (p_beds) or (c.owner_id = p_person and c.state in ('assigned', 'called', 'in_care') and (c.bed_id is null or c.bed_id = any (p_beds))));
  if names is null then
    update public.chart_beds set owner_id = null, owner_since = null where owner_id = p_person and id = any (p_beds);
    return;
  end if;
  if p_hand_to is not null then
    select * into t from public.chart_staff s where s.discord_id = p_hand_to;
    if t.discord_id is null or (public.chart_shift_of(p_hand_to)).id is null then perform public.chart_err('not_on_shift', format('%s isn''t on shift.', public.chart_pname(p_hand_to))); end if;
    if p_hand_to = p_person then perform public.chart_err('bad_input', 'Pick someone else to hand them to.'); end if;
    if t.role is distinct from 'room' then perform public.chart_err('wrong_role', format('%s isn''t working Room.', public.chart_pname(p_hand_to))); end if;
    if public.chart_on_break(p_hand_to) then perform public.chart_err('wrong_role', format('%s is on a break.', public.chart_pname(p_hand_to))); end if;
    -- beds with patients go to them with the patients; the others are just let go
    select coalesce(array_agg(distinct c.bed_id), '{}') into hb from public.chart_cases c where c.status = 'open' and c.state is not null and c.bed_id = any (p_beds);
    update public.chart_cases set owner_id = p_hand_to,
           assign_expires_at = case when state = 'assigned' then now() + interval '60 seconds' else assign_expires_at end, last_at = now()
    where status = 'open' and owner_id = p_person and state in ('assigned', 'called', 'in_care') and (bed_id is null or bed_id = any (p_beds));
    update public.chart_beds set owner_id = p_hand_to, owner_since = now() where owner_id = p_person and id = any (hb);
    update public.chart_beds set owner_id = null, owner_since = null where owner_id = p_person and id = any (p_beds);
    foreach x in array hb loop perform public.chart_order(p_hand_to, 'handover', x); end loop;
    perform public.chart_act('handover', null, jsonb_build_object('from', p_person, 'beds', to_jsonb(hb)), null, null, p_hand_to);
    return;
  end if;
  if not p_anyway then
    perform public.chart_err('has_patients', format('%s has %s.', public.chart_pname(p_person), names));
  end if;
  -- move anyway: their patients stay where they are and go back to Up next
  update public.chart_cases set state = case when bed_id is not null then 'waiting_in_room' else 'waiting' end, owner_id = null, priority = 1,
         handback_note = 'Their nurse was moved by the Supervisor', handed_back_by = p_person, assign_expires_at = null, assign_from = null, last_at = now()
  where status = 'open' and owner_id = p_person and state in ('assigned', 'called', 'in_care') and (bed_id is null or bed_id = any (p_beds));
  update public.chart_beds set owner_id = null, owner_since = null where owner_id = p_person and id = any (p_beds);
end $$;

create or replace function public.chart_person_place(p_person text, p_bed text, p_mode text default 'move', p_hand_to text default null,
                                                     p_move_anyway boolean default false, p_override_dept boolean default false) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare s public.chart_staff; b public.chart_beds; r public.chart_rooms; e text; old text[]; oid bigint;
begin
  perform public.chart_begin(); perform public.chart_need_sup();
  if p_mode is null or p_mode not in ('move', 'add') then perform public.chart_err('bad_input', 'Move them, or give them this bed too.'); end if;
  select * into s from public.chart_staff x where x.discord_id = p_person;
  if s.discord_id is null or (public.chart_shift_of(p_person)).id is null then perform public.chart_err('not_on_shift', format('%s isn''t on shift.', public.chart_pname(p_person))); end if;
  if s.role is distinct from 'room' then
    perform public.chart_err('wrong_role', format('%s is working %s: send them to visit instead.', public.chart_pname(p_person),
      coalesce(case s.role when 'reception' then 'Reception' when 'on_call' then 'On call' when 'road' then 'Road' when 'supervisor' then 'as Supervisor' end, 'no role')));
  end if;
  if public.chart_on_break(p_person) then perform public.chart_err('wrong_role', format('%s is on a break.', public.chart_pname(p_person))); end if;
  select * into b from public.chart_beds x where x.id = p_bed for update;
  e := public.chart_place_ok(null, p_bed, null, 'own');
  if e is not null then perform public.chart_err(split_part(e, '|', 1), substr(e, strpos(e, '|') + 1)); end if;
  if b.owner_id = p_person then return public.chart_done(jsonb_build_object('unchanged', true)); end if;
  if b.owner_id is not null then perform public.chart_err('not_bed_owner', format('%s is %s''s bed: take them off it first.', b.label, public.chart_pname(b.owner_id))); end if;
  select * into r from public.chart_rooms x where x.id = b.room_id;
  if r.department is distinct from s.department and not coalesce(p_override_dept, false) then
    perform public.chart_err('dept_clash', format('Room %s is %s and %s is working %s.', r.id, coalesce(r.department, 'no department'),
                             public.chart_pname(p_person), coalesce(s.department, 'no department')));
  end if;
  if p_mode = 'add' then
    if (select count(*) from public.chart_beds x where x.owner_id = p_person) >= 2 then
      perform public.chart_err('limit', format('%s already holds 2 beds.', public.chart_pname(p_person)));
    end if;
  else
    select coalesce(array_agg(x.id), '{}') into old from public.chart_beds x where x.owner_id = p_person;
    if cardinality(old) > 0 then perform public.chart_sv_leave(p_person, old, nullif(btrim(coalesce(p_hand_to, '')), ''), coalesce(p_move_anyway, false)); end if;
  end if;
  update public.chart_beds set owner_id = p_person, owner_since = now() where id = b.id and owner_id is null;
  update public.chart_staff set offer_room_id = null where discord_id = p_person and offer_room_id is not null;
  oid := public.chart_order(p_person, p_mode, b.id);
  perform public.chart_act('person_place', null, jsonb_build_object('bed', b.id, 'mode', p_mode, 'hand_to', p_hand_to, 'anyway', p_move_anyway,
          'override_dept', p_override_dept and r.department is distinct from s.department), b.room_id, null, p_person);
  return public.chart_done(jsonb_build_object('order_id', oid));
end $$;

create or replace function public.chart_person_off(p_person text, p_bed text default null, p_hand_to text default null, p_move_anyway boolean default false) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare beds text[]; oid bigint;
begin
  perform public.chart_begin(); perform public.chart_need_sup();
  select coalesce(array_agg(x.id order by x.id), '{}') into beds from public.chart_beds x
  where x.owner_id = p_person and (p_bed is null or x.id = p_bed);
  if cardinality(beds) = 0 then
    perform public.chart_err('not_bed_owner', case when p_bed is null then format('%s doesn''t hold a bed.', public.chart_pname(p_person))
                                                    else format('%s doesn''t hold %s.', public.chart_pname(p_person), coalesce((select b.label from public.chart_beds b where b.id = p_bed), p_bed)) end);
  end if;
  perform public.chart_sv_leave(p_person, beds, nullif(btrim(coalesce(p_hand_to, '')), ''), coalesce(p_move_anyway, false));
  oid := public.chart_order(p_person, 'off', case when cardinality(beds) = 1 then beds[1] end);
  perform public.chart_act('person_off', null, jsonb_build_object('beds', to_jsonb(beds), 'hand_to', p_hand_to, 'anyway', p_move_anyway), null, null, p_person);
  return public.chart_done(jsonb_build_object('order_id', oid));
end $$;

-- ---------- orders (the person moved) ----------
create or replace function public.chart_order_seen(p_order bigint) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare me public.chart_staff := public.chart_begin();
begin
  update public.chart_orders set state = 'seen', seen_at = now() where id = p_order and person = me.discord_id and state = 'sent';
  return public.chart_done();
end $$;

create or replace function public.chart_order_ok(p_order bigint) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare me public.chart_staff := public.chart_begin();
begin
  update public.chart_orders set state = 'ok', ok_at = now(), seen_at = coalesce(seen_at, now())
  where id = p_order and person = me.discord_id and state in ('sent', 'seen');
  if not found then perform public.chart_err('bad_input', 'That order has gone.'); end if;
  return public.chart_done();
end $$;

-- ---------- visits ----------
create or replace function public.chart_visit_send(p_person text, p_room text, p_reason text, p_note text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare r public.chart_rooms; note text := nullif(btrim(coalesce(p_note, '')), ''); vid bigint;
begin
  perform public.chart_begin(); perform public.chart_need_sup();
  if (public.chart_shift_of(p_person)).id is null then perform public.chart_err('not_on_shift', format('%s isn''t on shift.', public.chart_pname(p_person))); end if;
  if public.chart_admin_kind(p_person) is null
     and coalesce((select s.role from public.chart_staff s where s.discord_id = p_person), '') <> 'on_call' then
    perform public.chart_err('wrong_role', 'Only admins, executives, Directors and On call doctors can be sent to visit.');
  end if;
  select * into r from public.chart_rooms x where x.id = p_room;
  if r.id is null or not r.active then perform public.chart_err('bad_input', 'Pick a room.'); end if;
  if p_reason is null or p_reason not in ('help', 'complaint', 'check_staff', 'second_opinion', 'medical', 'custom') then
    perform public.chart_err('bad_input', 'Pick a reason.');
  end if;
  if p_reason = 'custom' and note is null then perform public.chart_err('bad_input', 'Type the message.'); end if;
  if char_length(coalesce(note, '')) > 120 then perform public.chart_err('bad_input', 'Keep the message to 120 characters.'); end if;
  -- a new visit replaces one they're already on
  update public.chart_visits set state = 'removed', ended_at = now(), ended_by = public.my_discord_id(), end_reason = 'Sent somewhere else'
  where person = p_person and state in ('sent', 'on_way', 'arrived');
  insert into public.chart_visits (person, room_id, reason, note, by_id) values (p_person, r.id, p_reason, note, public.my_discord_id()) returning id into vid;
  perform public.chart_act('visit_send', null, jsonb_build_object('visit', vid, 'reason', p_reason, 'note', note), r.id, null, p_person);
  return public.chart_done(jsonb_build_object('visit_id', vid));
end $$;

create or replace function public.chart_visit_step(p_visit bigint, p_step text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare me public.chart_staff := public.chart_begin(); v public.chart_visits;
begin
  select * into v from public.chart_visits x where x.id = p_visit for update;
  if v.id is null or v.person is distinct from me.discord_id then perform public.chart_err('not_called', 'That visit isn''t yours.'); end if;
  if v.state not in ('sent', 'on_way', 'arrived') then perform public.chart_err('bad_state', 'That visit is over.'); end if;
  if p_step = 'on_way' and v.state = 'sent' then
    update public.chart_visits set state = 'on_way', on_way_at = now() where id = v.id;
  elsif p_step = 'arrived' and v.state in ('sent', 'on_way') then
    update public.chart_visits set state = 'arrived', arrived_at = now(), on_way_at = coalesce(on_way_at, now()) where id = v.id;
  elsif p_step = 'done' then
    update public.chart_visits set state = 'done', ended_at = now(), ended_by = me.discord_id, end_reason = 'Done' where id = v.id;
  elsif p_step in ('on_way', 'arrived') then
    return public.chart_done(jsonb_build_object('unchanged', true));   -- already past that step
  else
    perform public.chart_err('bad_input', 'Pick On my way, Arrived or Done.');
  end if;
  perform public.chart_act('visit_' || p_step, null, jsonb_build_object('visit', v.id), v.room_id);
  return public.chart_done();
end $$;

create or replace function public.chart_visit_remove(p_visit bigint) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v public.chart_visits;
begin
  perform public.chart_begin(); perform public.chart_need_sup();
  select * into v from public.chart_visits x where x.id = p_visit for update;
  if v.id is null or v.state not in ('sent', 'on_way', 'arrived') then perform public.chart_err('bad_state', 'That visit is over.'); end if;
  update public.chart_visits set state = 'removed', ended_at = now(), ended_by = public.my_discord_id(), end_reason = 'Removed by the Supervisor' where id = v.id;
  perform public.chart_notice(v.person, format('%s took you off the visit to Room %s.', public.chart_short(public.my_discord_id()), v.room_id));
  perform public.chart_act('visit_remove', null, jsonb_build_object('visit', v.id), v.room_id, null, v.person);
  return public.chart_done();
end $$;

-- ---------- tick: expire asks, close what belongs to people who clocked out (never raises) ----------
create or replace function public.chart_sv_sweep() returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare changed boolean := false; x record;
begin
  if not exists (select 1 from public.chart_partner_asks a where a.state = 'pending')
     and not exists (select 1 from public.chart_visits v where v.state in ('sent', 'on_way', 'arrived'))
     and not exists (select 1 from public.chart_orders o where o.state in ('sent', 'seen')) then return false; end if;
  begin
    for x in select a.* from public.chart_partner_asks a where a.state = 'pending'
               and (a.expires_at <= now() or (public.chart_shift_of(a.asker)).id is null or (public.chart_shift_of(a.holder)).id is null) loop
      update public.chart_partner_asks set state = case when x.expires_at <= now() then 'expired' else 'cancelled' end, answered_at = now() where id = x.id and state = 'pending';
      if x.expires_at <= now() then
        perform public.chart_notice(x.asker, format('%s didn''t answer about sharing Room %s: pick another bed.', public.chart_short(x.holder), x.room_id));
      end if;
      changed := true;
    end loop;
    for x in select v.id from public.chart_visits v where v.state in ('sent', 'on_way', 'arrived') and (public.chart_shift_of(v.person)).id is null loop
      update public.chart_visits set state = 'removed', ended_at = now(), end_reason = 'Clocked out' where id = x.id;
      changed := true;
    end loop;
    update public.chart_orders o set state = 'expired' where o.state in ('sent', 'seen') and (public.chart_shift_of(o.person)).id is null;
    if found then changed := true; end if;
    return changed;
  exception when others then
    begin
      insert into public.chart_log (actor_name, action, detail) values ('Auto', 'sv_error', jsonb_build_object('error', sqlerrm));
    exception when others then
      raise warning 'chart_sv_sweep: %', sqlerrm;
    end;
    return false;
  end;
end $$;

-- ---------- grants ----------
do $g$
declare f text;
begin
  foreach f in array array[
    'public.chart_admin_kind(text)', 'public.chart_rank_label(text)', 'public.chart_avatar(text)', 'public.chart_visit_state(text)', 'public.chart_visits_view()',
    'public.chart_admins_view()', 'public.chart_order_mine(text)', 'public.chart_partner_for(text)', 'public.chart_partner_waiting(text)',
    'public.chart_partner_ask(text,text)', 'public.chart_order(text,text,text)', 'public.chart_sv_leave(text,text[],text,boolean)', 'public.chart_sv_sweep()',
    'public.chart_partner_answer(bigint,boolean)', 'public.chart_person_place(text,text,text,text,boolean,boolean)', 'public.chart_person_off(text,text,text,boolean)',
    'public.chart_order_seen(bigint)', 'public.chart_order_ok(bigint)', 'public.chart_visit_send(text,text,text,text)', 'public.chart_visit_step(bigint,text)',
    'public.chart_visit_remove(bigint)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  foreach f in array array[
    'public.chart_partner_answer(bigint,boolean)', 'public.chart_person_place(text,text,text,text,boolean,boolean)', 'public.chart_person_off(text,text,text,boolean)',
    'public.chart_order_seen(bigint)', 'public.chart_order_ok(bigint)', 'public.chart_visit_send(text,text,text,text)', 'public.chart_visit_step(bigint,text)',
    'public.chart_visit_remove(bigint)'] loop
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $g$;

-- ---------- patches to live functions ----------
do $m$
declare d text; n text;
begin
  -- one bed: picking your own
  d := pg_get_functiondef('public.chart_own_ok(text,text[])'::regprocedure);
  n := replace(d, $a$cardinality(p_beds) > 2 then return 'bad_beds|Pick one or two beds.'; end if;$a$,
                  $b$cardinality(p_beds) > 1 then return 'bad_beds|Pick one bed.'; end if;$b$);
  if n = d then raise exception '0097: chart_own_ok count text not found'; end if;
  d := n;
  n := replace(d, $a$if total > 2 then return 'limit|You can hold 2 beds at most.'; end if;$a$,
                  $b$if total > 1 then return 'limit|You can hold one bed: the Supervisor can give you a second.'; end if;$b$);
  if n = d then raise exception '0097: chart_own_ok limit text not found'; end if;
  execute n;

  -- one bed: placing a patient in an unheld bed for someone who holds one already
  d := pg_get_functiondef('public.chart_place_ok(bigint,text,text,text,boolean)'::regprocedure);
  n := replace(d, $a$>= 2 then
      return format('limit|%s already holds 2 beds.', public.chart_pname(p_person));$a$,
                  $b$>= 1 then
      return format('limit|%s already holds a bed: the Supervisor can give them this one too.', public.chart_pname(p_person));$b$);
  if n = d then raise exception '0097: chart_place_ok limit text not found'; end if;
  execute n;

  -- one bed: the Open-room offer takes one bed
  d := pg_get_functiondef('public.chart_offer_take()'::regprocedure);
  n := replace(d, $a$select array_agg(b.id order by b.id) into bs from public.chart_beds b where b.room_id = me.offer_room_id and b.available and b.owner_id is null;$a$,
                  $b$select array_agg(y.id) into bs from (select b.id from public.chart_beds b where b.room_id = me.offer_room_id and b.available and b.owner_id is null order by b.id limit 1) y;$b$);
  if n = d then raise exception '0097: chart_offer_take text not found'; end if;
  execute n;

  -- partner request: a free bed in a room someone else holds
  d := pg_get_functiondef('public.chart_take_beds(text[])'::regprocedure);
  n := replace(d, $a$  update public.chart_beds set owner_id = null, owner_since = null where owner_id = me.discord_id and not id = any (p_beds);$a$,
                  $b$  if cardinality(p_beds) = 1 and exists (select 1 from public.chart_beds x join public.chart_beds y on y.room_id = x.room_id and y.id <> x.id
                                           where x.id = p_beds[1] and x.owner_id is null and y.owner_id is not null and y.owner_id <> me.discord_id) then
    return public.chart_partner_ask(me.discord_id, p_beds[1]);
  end if;
  update public.chart_beds set owner_id = null, owner_since = null where owner_id = me.discord_id and not id = any (p_beds);$b$);
  if n = d then raise exception '0097: chart_take_beds text not found'; end if;
  execute n;

  -- tick
  d := pg_get_functiondef('public.chart_tick()'::regprocedure);
  n := replace(d, $a$  if public.chart_call_sweep() then changed := true; end if;$a$,
                  $b$  if public.chart_sv_sweep() then changed := true; end if;
  if public.chart_call_sweep() then changed := true; end if;$b$);
  if n = d then raise exception '0097: chart_tick text not found'; end if;
  execute n;

  -- poll
  d := pg_get_functiondef('public.chart_poll(bigint)'::regprocedure);
  n := replace(d, $a$'can_join', public.chart_calls_joinable(uid), 'ready', me.ready,$a$,
                  $b$'can_join', public.chart_calls_joinable(uid), 'order', public.chart_order_mine(uid), 'visit', public.chart_visit_state(uid),
      'partner_ask', public.chart_partner_for(uid), 'partner_wait', public.chart_partner_waiting(uid), 'rank', public.chart_rank_label(uid),
      'shift_started_at', sh.started_at, 'admin', public.chart_admin_kind(uid) is not null, 'ready', me.ready,$b$);
  if n = d then raise exception '0097: chart_poll me text not found'; end if;
  d := n;
  n := replace(d, $a$'ready_since', s.ready_since, 'call', public.chart_call_state(s.discord_id),$a$,
                  $b$'ready_since', s.ready_since, 'call', public.chart_call_state(s.discord_id), 'rank', public.chart_rank_label(s.discord_id),
        'admin', public.chart_admin_kind(s.discord_id) is not null, 'shift_started_at', (public.chart_shift_of(s.discord_id)).started_at,
        'visit', public.chart_visit_state(s.discord_id),$b$);
  if n = d then raise exception '0097: chart_poll staff text not found'; end if;
  d := n;
  n := replace(d, $a$'calls', public.chart_calls_view());$a$,
                  $b$'calls', public.chart_calls_view(), 'visits', public.chart_visits_view(), 'admins', public.chart_admins_view());$b$);
  if n = d then raise exception '0097: chart_poll lists text not found'; end if;
  d := n;
  -- the offer card shows the one bed taking it gives (chart_offer_take above)
  n := replace(d, $a$'beds', (select jsonb_agg(b.id order by b.id) from public.chart_beds b where b.room_id = me.offer_room_id and b.available and b.owner_id is null),$a$,
                  $b$'beds', (select jsonb_agg(y.id) from (select b.id from public.chart_beds b where b.room_id = me.offer_room_id and b.available and b.owner_id is null order by b.id limit 1) y),$b$);
  if n = d then raise exception '0097: chart_poll offer text not found'; end if;
  execute n;
end $m$;
