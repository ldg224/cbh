-- 0096 (Bravo, 21 Nov 2026): Trauma call (team call). The user, from the live test: a trauma ambulance needs e.g. 4 doctors
-- and 3 medical staff, but the Supervisor could only drag one person in and had no loud way to call people. Additive.
--   chart_calls / chart_call_members   the call (patient and/or bed, how many wanted PER DEPARTMENT, open|full|done|cancelled)
--                                      and who's on it (the department they fill, named or volunteered,
--                                      called|on_way|declined|arrived|released)
--   departments                        Medical, Surgical, Paramedicine, Nursing (the user: a number per department, any can
--                                      be 0). "In a department" = chart_person_depts (department or rank roles), so someone
--                                      in several departments can fill a place in any of them.
--   chart_call_start/set/add/remove/end   Supervisor (chart_can_supervise)
--   chart_call_answer(p_call, p_coming, p_department)  the called person: On my way / Can't come; also joins an OPEN place
--   chart_call_arrived(p_call, p_person)  at the bedside (yourself, or a supervisor for someone)
--   chart_poll                         calls[], me.call/can_join, staff[].call, beds[].away
--   chart_auto_assign                  skips people who are on a call
--   chart_tick                         closes calls when the session ends, nobody is on shift or the patient's case is
--                                      closed, and releases members who clock out (guarded: never breaks the tick)
-- No triggers. Live functions are patched by exact text replacement (asserted); the down file reverses them.

-- ---------- tables (no client access: everything goes through the functions) ----------
create table if not exists public.chart_calls (
  id                bigint generated always as identity primary key,
  case_id           bigint references public.chart_cases (id) on delete cascade,
  bed_id            text,
  session_id        bigint,
  want_medical      smallint not null default 0 check (want_medical between 0 and 12),
  want_surgical     smallint not null default 0 check (want_surgical between 0 and 12),
  want_paramedicine smallint not null default 0 check (want_paramedicine between 0 and 12),
  want_nursing      smallint not null default 0 check (want_nursing between 0 and 12),
  status            text not null default 'open' check (status in ('open', 'full', 'done', 'cancelled')),
  note              text check (note is null or char_length(note) <= 200),
  started_by        text not null,
  started_at        timestamptz not null default now(),
  ended_by          text,
  ended_at          timestamptz,
  end_reason        text check (end_reason is null or char_length(end_reason) <= 120),
  constraint chart_calls_where check (case_id is not null or bed_id is not null)
);
create unique index if not exists chart_calls_one_per_case on public.chart_calls (case_id) where status in ('open', 'full') and case_id is not null;
create unique index if not exists chart_calls_one_per_bed on public.chart_calls (bed_id) where status in ('open', 'full') and bed_id is not null;
create index if not exists chart_calls_active on public.chart_calls (status) where status in ('open', 'full');

create table if not exists public.chart_call_members (
  id           bigint generated always as identity primary key,
  call_id      bigint not null references public.chart_calls (id) on delete cascade,
  discord_id   text not null,
  department   text not null check (department in ('Medical', 'Surgical', 'Paramedicine', 'Nursing')),
  named        boolean not null default true,
  state        text not null default 'called' check (state in ('called', 'on_way', 'declined', 'arrived', 'released')),
  called_by    text,
  called_at    timestamptz not null default now(),
  answered_at  timestamptz,
  arrived_at   timestamptz,
  released_at  timestamptz,
  unique (call_id, discord_id)
);
create index if not exists chart_call_members_person on public.chart_call_members (discord_id) where state in ('called', 'on_way', 'arrived');

alter table public.chart_calls enable row level security;
alter table public.chart_call_members enable row level security;
revoke all on table public.chart_calls from public, anon, authenticated;
revoke all on table public.chart_call_members from public, anon, authenticated;
grant all on table public.chart_calls to service_role;
grant all on table public.chart_call_members to service_role;

-- ---------- helpers ----------
create or replace function public.chart_call_depts() returns text[]
language sql immutable set search_path = '' as $$
  select array['Medical', 'Surgical', 'Paramedicine', 'Nursing']
$$;

create or replace function public.chart_call_want(c public.chart_calls, p_dept text) returns int
language sql immutable set search_path = '' as $$
  select case p_dept when 'Medical' then c.want_medical when 'Surgical' then c.want_surgical
                     when 'Paramedicine' then c.want_paramedicine when 'Nursing' then c.want_nursing else 0 end
$$;

-- How many of one department are on the call now (called, on the way or arrived all hold a place).
create or replace function public.chart_call_held(p_call bigint, p_dept text) returns int
language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.chart_call_members m where m.call_id = p_call and m.department = p_dept and m.state in ('called', 'on_way', 'arrived')
$$;

-- Places of one department not yet taken.
create or replace function public.chart_call_open(p_call bigint, p_dept text) returns int
language sql stable security definer set search_path = '' as $$
  select greatest(0, public.chart_call_want(c, p_dept) - public.chart_call_held(p_call, p_dept)) from public.chart_calls c where c.id = p_call
$$;

create or replace function public.chart_call_open_total(p_call bigint) returns int
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(public.chart_call_open(p_call, d)), 0)::int from unnest(public.chart_call_depts()) d
$$;

create or replace function public.chart_call_refresh(p_call bigint) returns void
language sql volatile security definer set search_path = '' as $$
  update public.chart_calls c
  set status = case when public.chart_call_open_total(c.id) = 0 then 'full' else 'open' end
  where c.id = p_call and c.status in ('open', 'full')
    and c.status is distinct from case when public.chart_call_open_total(c.id) = 0 then 'full' else 'open' end
$$;

-- On an active call and coming or there: their beds show "Away: at trauma", auto-assign skips them.
create or replace function public.chart_away(who text) returns boolean
language sql stable security definer set search_path = '' as $$
  select who is not null and exists (select 1 from public.chart_call_members m join public.chart_calls c on c.id = m.call_id
                                     where m.discord_id = who and m.state in ('on_way', 'arrived') and c.status in ('open', 'full'))
$$;

create or replace function public.chart_call_state(who text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', m.call_id, 'state', m.state, 'named', m.named, 'department', m.department)
  from public.chart_call_members m join public.chart_calls c on c.id = m.call_id
  where m.discord_id = who and m.state in ('called', 'on_way', 'arrived') and c.status in ('open', 'full')
  order by (m.state = 'called') desc, m.called_at desc limit 1
$$;

-- The first of the person's departments with an open place on the call (null when none).
create or replace function public.chart_call_fit_dept(p_call bigint, who text) returns text
language sql stable security definer set search_path = '' as $$
  select d from unnest(public.chart_call_depts()) with ordinality as x (d, o)
  where d = any (public.chart_person_depts(who)) and public.chart_call_open(p_call, d) > 0 order by o limit 1
$$;

create or replace function public.chart_calls_joinable(who text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(c.id order by c.id), '[]'::jsonb) from public.chart_calls c
  where c.status = 'open' and not public.chart_on_break(who) and public.chart_call_fit_dept(c.id, who) is not null
    -- someone who pressed "Can't come" gets no Join banner for that call (they can still join it themselves)
    and not exists (select 1 from public.chart_call_members m where m.call_id = c.id and m.discord_id = who and m.state in ('called', 'on_way', 'arrived', 'declined'))
$$;

-- The room a call is in: its bed's room, or else the room of its patient's bed (null for a patient not in a bed yet).
create or replace function public.chart_call_room(p_bed text, p_case bigint) returns text
language sql stable security definer set search_path = '' as $$
  select b.room_id from public.chart_beds b
  where b.id = coalesce(p_bed, (select x.bed_id from public.chart_cases x where x.id = p_case))
$$;

-- Where the call is, in words (for notices).
create or replace function public.chart_call_where(p_call bigint) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((select b.label from public.chart_beds b where b.id = coalesce(c.bed_id, x.bed_id)),
                  public.checkin_short_name(x.patient_name), 'the call')
  from public.chart_calls c left join public.chart_cases x on x.id = c.case_id where c.id = p_call
$$;

create or replace function public.chart_calls_view() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', c.id, 'status', c.status, 'case_id', c.case_id,
      'patient', case when x.id is not null then public.checkin_short_name(x.patient_name) end,
      'bed', coalesce(c.bed_id, x.bed_id),
      'room', (select b.room_id from public.chart_beds b where b.id = coalesce(c.bed_id, x.bed_id)),
      'note', c.note,
      'want', jsonb_build_object('Medical', c.want_medical, 'Surgical', c.want_surgical, 'Paramedicine', c.want_paramedicine, 'Nursing', c.want_nursing),
      'open', jsonb_build_object('Medical', public.chart_call_open(c.id, 'Medical'), 'Surgical', public.chart_call_open(c.id, 'Surgical'),
                                 'Paramedicine', public.chart_call_open(c.id, 'Paramedicine'), 'Nursing', public.chart_call_open(c.id, 'Nursing')),
      'started_by', jsonb_build_object('discord_id', c.started_by, 'name', public.chart_pname(c.started_by)),
      'started_at', c.started_at,
      'members', coalesce((select jsonb_agg(jsonb_build_object('discord_id', m.discord_id, 'name', public.chart_pname(m.discord_id),
                    'department', m.department, 'named', m.named, 'state', m.state,
                    'called_at', m.called_at, 'answered_at', m.answered_at, 'arrived_at', m.arrived_at)
                    order by array_position(public.chart_call_depts(), m.department), m.called_at)
                  from public.chart_call_members m where m.call_id = c.id and m.state <> 'released'), '[]'::jsonb))
    order by c.started_at), '[]'::jsonb)
  from public.chart_calls c left join public.chart_cases x on x.id = c.case_id
  where c.status in ('open', 'full')
$$;

-- Supervisor gate for the call controls (no shift needed, like chart_set_map).
create or replace function public.chart_call_sup() returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if public.my_discord_id() is null then perform public.chart_err('no_access', 'Log in to use the Chart.'); end if;
  perform public.chart_lock();
  perform public.chart_tick();
  if not public.chart_can_supervise() then perform public.chart_err('not_supervisor', 'Only a supervisor can run a trauma call.'); end if;
end $$;

create or replace function public.chart_call_get(p_call bigint) returns public.chart_calls
language plpgsql volatile security definer set search_path = '' as $$
declare c public.chart_calls;
begin
  select * into c from public.chart_calls x where x.id = p_call for update;
  if c.id is null then perform public.chart_err('bad_input', 'No such trauma call.'); end if;
  if c.status not in ('open', 'full') then perform public.chart_err('call_over', 'That trauma call is over.'); end if;
  return c;
end $$;

-- Apply wanted numbers ({"Medical": 2, ...}; departments left out keep their number). Checks the range, not the total.
create or replace function public.chart_call_set_want(p_call bigint, p_want jsonb) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare k text; v jsonb; n int;
begin
  if p_want is null then return; end if;
  if jsonb_typeof(p_want) <> 'object' then perform public.chart_err('bad_input', 'Say how many are needed from each department.'); end if;
  for k, v in select * from jsonb_each(p_want) loop
    if not k = any (public.chart_call_depts()) then perform public.chart_err('bad_input', format('%s isn''t a department for trauma calls.', k)); end if;
    n := case when jsonb_typeof(v) = 'number' then (v #>> '{}')::numeric::int end;
    if n is null or n < 0 or n > 12 then perform public.chart_err('bad_input', 'Ask for 0 to 12 from each department.'); end if;
  end loop;
  update public.chart_calls set
    want_medical      = coalesce((p_want ->> 'Medical')::numeric::int, want_medical),
    want_surgical     = coalesce((p_want ->> 'Surgical')::numeric::int, want_surgical),
    want_paramedicine = coalesce((p_want ->> 'Paramedicine')::numeric::int, want_paramedicine),
    want_nursing      = coalesce((p_want ->> 'Nursing')::numeric::int, want_nursing)
  where id = p_call;
end $$;

-- Name one person on a call for a department (given, or the first of theirs with an open place, or else the first of
-- theirs). New, or again after declining / being released; someone already on the call is left as they are.
create or replace function public.chart_call_name(p_call bigint, p_person text, p_dept text default null) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare d text := nullif(btrim(coalesce(p_dept, '')), ''); depts text[] := public.chart_person_depts(p_person);
begin
  if p_person is null or (public.chart_shift_of(p_person)).id is null then
    perform public.chart_err('not_on_shift', format('%s isn''t on shift.', coalesce(public.chart_pname(p_person), 'That person')));
  end if;
  if d is not null then
    if not d = any (public.chart_call_depts()) then perform public.chart_err('bad_input', format('%s isn''t a department for trauma calls.', d)); end if;
    if not d = any (depts) then perform public.chart_err('not_in_department', format('%s isn''t in %s.', public.chart_pname(p_person), d)); end if;
  else
    d := coalesce(public.chart_call_fit_dept(p_call, p_person),
                  (select x from unnest(public.chart_call_depts()) with ordinality as t (x, o) where x = any (depts) order by o limit 1));
    if d is null then
      perform public.chart_err('not_in_department', format('%s isn''t in Medical, Surgical, Paramedicine or Nursing.', public.chart_pname(p_person)));
    end if;
  end if;
  insert into public.chart_call_members as m (call_id, discord_id, department, named, state, called_by)
  values (p_call, p_person, d, true, 'called', public.my_discord_id())
  on conflict (call_id, discord_id) do update
    set state = 'called', named = true, department = excluded.department, called_by = excluded.called_by, called_at = now(),
        answered_at = null, arrived_at = null, released_at = null
    where m.state in ('declined', 'released');
  return d;
end $$;

-- People: [{"id": "<discord id>", "department": "Medical"}] (department optional), or plain id strings.
create or replace function public.chart_call_name_all(p_call bigint, p_people jsonb) returns int
language plpgsql volatile security definer set search_path = '' as $$
declare e jsonb; n int := 0;
begin
  if p_people is null or jsonb_typeof(p_people) = 'null' then return 0; end if;
  if jsonb_typeof(p_people) <> 'array' then perform public.chart_err('bad_input', 'Pick people to call.'); end if;
  for e in select * from jsonb_array_elements(p_people) loop
    if jsonb_typeof(e) = 'string' then perform public.chart_call_name(p_call, e #>> '{}');
    elsif jsonb_typeof(e) = 'object' then perform public.chart_call_name(p_call, e ->> 'id', e ->> 'department');
    else perform public.chart_err('bad_input', 'Pick people to call.'); end if;
    n := n + 1;
  end loop;
  return n;
end $$;

-- Raise the numbers wanted so everyone named fits.
create or replace function public.chart_call_fit(p_call bigint) returns void
language sql volatile security definer set search_path = '' as $$
  update public.chart_calls c set
    want_medical      = least(12, greatest(c.want_medical,      public.chart_call_held(c.id, 'Medical'))),
    want_surgical     = least(12, greatest(c.want_surgical,     public.chart_call_held(c.id, 'Surgical'))),
    want_paramedicine = least(12, greatest(c.want_paramedicine, public.chart_call_held(c.id, 'Paramedicine'))),
    want_nursing      = least(12, greatest(c.want_nursing,      public.chart_call_held(c.id, 'Nursing')))
  where c.id = p_call
$$;

create or replace function public.chart_call_check(p_call bigint) returns void
language plpgsql stable security definer set search_path = '' as $$
declare c public.chart_calls; d text;
begin
  select * into c from public.chart_calls x where x.id = p_call;
  if c.want_medical + c.want_surgical + c.want_paramedicine + c.want_nursing < 1 then
    perform public.chart_err('bad_input', 'Ask for at least one person.');
  end if;
  foreach d in array public.chart_call_depts() loop
    if public.chart_call_held(p_call, d) > public.chart_call_want(c, d) then
      perform public.chart_err('too_low', format('More %s people are already on the call than that: remove someone first.', d));
    end if;
  end loop;
end $$;

-- ---------- Supervisor controls ----------
create or replace function public.chart_call_start(p_case bigint, p_bed text, p_want jsonb,
                                                   p_people jsonb default '[]'::jsonb, p_note text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare cs public.chart_cases; bd text := nullif(btrim(coalesce(p_bed, '')), ''); cid bigint; c public.chart_calls; rm text;
begin
  perform public.chart_call_sup();
  if p_case is null and bd is null then perform public.chart_err('bad_input', 'Pick a patient or a bed.'); end if;
  if p_case is not null then
    select * into cs from public.chart_cases x where x.id = p_case;
    if cs.id is null or cs.status <> 'open' or cs.state is null then perform public.chart_err('no_access', 'That patient isn''t there.'); end if;
    if exists (select 1 from public.chart_calls x where x.case_id = p_case and x.status in ('open', 'full')) then
      perform public.chart_err('call_exists', format('%s already has a trauma call.', public.checkin_short_name(cs.patient_name)));
    end if;
  end if;
  if bd is not null then
    if not exists (select 1 from public.chart_beds b join public.chart_rooms r on r.id = b.room_id where b.id = bd and r.active) then
      perform public.chart_err('bad_input', 'No such bed.');
    end if;
    if exists (select 1 from public.chart_calls x where x.bed_id = bd and x.status in ('open', 'full')) then
      perform public.chart_err('call_exists', format('%s already has a trauma call.', (select b.label from public.chart_beds b where b.id = bd)));
    end if;
  end if;
  -- one active call per room
  rm := public.chart_call_room(bd, p_case);
  if rm is not null and exists (select 1 from public.chart_calls x where x.status in ('open', 'full') and public.chart_call_room(x.bed_id, x.case_id) = rm) then
    perform public.chart_err('call_exists', format('Room %s already has a trauma call.', rm));
  end if;
  insert into public.chart_calls (case_id, bed_id, session_id, note, started_by)
  values (p_case, bd, public.chart_session_live(), left(nullif(btrim(coalesce(p_note, '')), ''), 200), public.my_discord_id())
  returning id into cid;
  perform public.chart_call_set_want(cid, coalesce(p_want, '{}'::jsonb));
  perform public.chart_call_name_all(cid, p_people);
  perform public.chart_call_fit(cid);
  perform public.chart_call_check(cid);
  perform public.chart_call_refresh(cid);
  select * into c from public.chart_calls x where x.id = cid;
  perform public.chart_act('call_start', p_case, jsonb_build_object('call', cid, 'bed', bd,
          'want', jsonb_build_object('Medical', c.want_medical, 'Surgical', c.want_surgical, 'Paramedicine', c.want_paramedicine, 'Nursing', c.want_nursing),
          'named', coalesce(p_people, '[]'::jsonb)));
  return public.chart_done(jsonb_build_object('call_id', cid));
end $$;

create or replace function public.chart_call_set(p_call bigint, p_want jsonb, p_note text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare c public.chart_calls; a public.chart_calls;
begin
  perform public.chart_call_sup();
  c := public.chart_call_get(p_call);
  perform public.chart_call_set_want(c.id, p_want);
  if p_note is not null then
    update public.chart_calls set note = left(nullif(btrim(p_note), ''), 200) where id = c.id;
  end if;
  perform public.chart_call_check(c.id);
  perform public.chart_call_refresh(c.id);
  select * into a from public.chart_calls x where x.id = c.id;
  perform public.chart_act('call_set', c.case_id, jsonb_build_object('call', c.id,
          'want', jsonb_build_object('Medical', a.want_medical, 'Surgical', a.want_surgical, 'Paramedicine', a.want_paramedicine, 'Nursing', a.want_nursing),
          'before', jsonb_build_object('Medical', c.want_medical, 'Surgical', c.want_surgical, 'Paramedicine', c.want_paramedicine, 'Nursing', c.want_nursing)));
  return public.chart_done();
end $$;

create or replace function public.chart_call_add(p_call bigint, p_people jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare c public.chart_calls;
begin
  perform public.chart_call_sup();
  c := public.chart_call_get(p_call);
  if public.chart_call_name_all(c.id, p_people) = 0 then perform public.chart_err('bad_input', 'Pick someone to call.'); end if;
  perform public.chart_call_fit(c.id);
  perform public.chart_call_refresh(c.id);
  perform public.chart_act('call_add', c.case_id, jsonb_build_object('call', c.id, 'named', p_people));
  return public.chart_done();
end $$;

create or replace function public.chart_call_remove(p_call bigint, p_person text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare c public.chart_calls;
begin
  perform public.chart_call_sup();
  c := public.chart_call_get(p_call);
  update public.chart_call_members set state = 'released', released_at = now()
  where call_id = c.id and discord_id = p_person and state in ('called', 'on_way', 'arrived');
  if not found then perform public.chart_err('bad_input', 'They aren''t on this call.'); end if;
  perform public.chart_call_refresh(c.id);
  perform public.chart_notice(p_person, format('You were taken off the trauma call at %s.', public.chart_call_where(c.id)));
  perform public.chart_act('call_remove', c.case_id, jsonb_build_object('call', c.id), null, null, p_person);
  return public.chart_done();
end $$;

create or replace function public.chart_call_end(p_call bigint, p_cancel boolean default false) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare c public.chart_calls;
begin
  perform public.chart_call_sup();
  c := public.chart_call_get(p_call);
  update public.chart_calls set status = case when p_cancel then 'cancelled' else 'done' end, ended_by = public.my_discord_id(), ended_at = now(),
         end_reason = case when p_cancel then 'Cancelled' else 'Finished' end
  where id = c.id;
  update public.chart_call_members set released_at = now() where call_id = c.id and released_at is null and state in ('called', 'on_way', 'arrived');
  perform public.chart_act(case when p_cancel then 'call_cancel' else 'call_end' end, c.case_id, jsonb_build_object('call', c.id));
  return public.chart_done();
end $$;

-- ---------- the called person ----------
create or replace function public.chart_call_answer(p_call bigint, p_coming boolean, p_department text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare me text := public.my_discord_id(); c public.chart_calls; m public.chart_call_members; d text := nullif(btrim(coalesce(p_department, '')), ''); s text;
begin
  if me is null then perform public.chart_err('no_access', 'Log in to use the Chart.'); end if;
  if p_coming is null then perform public.chart_err('bad_input', 'Say if you''re coming.'); end if;
  perform public.chart_lock();
  perform public.chart_tick();
  if (public.chart_shift_of(me)).id is null then perform public.chart_err('not_on_shift', 'Start a shift to use the Chart.'); end if;
  c := public.chart_call_get(p_call);
  select * into m from public.chart_call_members x where x.call_id = c.id and x.discord_id = me for update;
  if m.id is not null and m.state in ('called', 'on_way', 'arrived') then
    if p_coming and m.state in ('on_way', 'arrived') then
      return jsonb_build_object('ok', true, 'rev', public.chart_rev());   -- a repeat On my way: nothing to do, nothing to log
    end if;
    if p_coming and m.state = 'called' then
      update public.chart_call_members set state = 'on_way', answered_at = now() where id = m.id;
    elsif not p_coming then
      update public.chart_call_members set state = 'declined', answered_at = now(), arrived_at = null where id = m.id;
      foreach s in array (select coalesce(array_agg(distinct y.x), '{}') from (select c.started_by as x union select st.discord_id from public.chart_staff st where st.role = 'supervisor') y where y.x <> me) loop
        perform public.chart_notice(s, format('%s can''t come to the trauma call at %s.', public.chart_short(me), public.chart_call_where(c.id)));
      end loop;
    end if;
  elsif p_coming then
    -- joining an open place, in the department given or the first of theirs with room
    if public.chart_on_break(me) then perform public.chart_err('on_break', 'You''re on break: end your break to join a trauma call.'); end if;
    if d is not null then
      if not d = any (public.chart_call_depts()) then perform public.chart_err('bad_input', format('%s isn''t a department for trauma calls.', d)); end if;
      if not d = any (public.chart_person_depts(me)) then perform public.chart_err('not_in_department', format('You aren''t in %s.', d)); end if;
      if public.chart_call_open(c.id, d) < 1 then perform public.chart_err('no_place', format('No %s places are left on this call.', d)); end if;
    else
      d := public.chart_call_fit_dept(c.id, me);
      if d is null then perform public.chart_err('no_place', 'No places are left on this call for your departments.'); end if;
    end if;
    insert into public.chart_call_members as x (call_id, discord_id, department, named, state, answered_at)
    values (c.id, me, d, false, 'on_way', now())
    on conflict (call_id, discord_id) do update
      set department = excluded.department, named = false, state = 'on_way', called_at = now(), answered_at = now(), arrived_at = null, released_at = null
      where x.state in ('declined', 'released');
  else
    perform public.chart_err('not_called', 'You aren''t on this call.');
  end if;
  if p_coming then
    update public.chart_staff set ready = false, ready_since = null where discord_id = me and ready;
  end if;
  perform public.chart_call_refresh(c.id);
  perform public.chart_act(case when p_coming then 'call_coming' else 'call_decline' end, c.case_id, jsonb_build_object('call', c.id));
  return public.chart_done();
end $$;

create or replace function public.chart_call_arrived(p_call bigint, p_person text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare me text := public.my_discord_id(); who text; c public.chart_calls;
begin
  if me is null then perform public.chart_err('no_access', 'Log in to use the Chart.'); end if;
  perform public.chart_lock();
  perform public.chart_tick();
  who := coalesce(nullif(btrim(coalesce(p_person, '')), ''), me);
  if who <> me and not public.chart_can_supervise() then perform public.chart_err('not_supervisor', 'Only a supervisor can mark someone else as arrived.'); end if;
  c := public.chart_call_get(p_call);
  update public.chart_call_members set state = 'arrived', arrived_at = now(), answered_at = coalesce(answered_at, now())
  where call_id = c.id and discord_id = who and state in ('called', 'on_way');
  if not found then perform public.chart_err('not_called', 'They aren''t on their way to this call.'); end if;
  update public.chart_staff set ready = false, ready_since = null where discord_id = who and ready;
  perform public.chart_call_refresh(c.id);
  perform public.chart_act('call_arrived', c.case_id, jsonb_build_object('call', c.id), null, null, who);
  return public.chart_done();
end $$;

-- ---------- tick: tidy calls (never raises) ----------
create or replace function public.chart_call_sweep() returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare changed boolean := false; x record; live bigint;
begin
  if not exists (select 1 from public.chart_calls c where c.status in ('open', 'full')) then return false; end if;
  begin
    live := public.chart_session_live();
    for x in select c.id, c.case_id,
                    case when c.session_id is not null and c.session_id is distinct from live then 'Session ended'
                         when not exists (select 1 from public.shifts s where s.status <> 'ended') then 'Nobody on shift'
                         when c.case_id is not null and not exists (select 1 from public.chart_cases k where k.id = c.case_id and k.status = 'open' and k.state is not null) then 'Patient left'
                    end as why
             from public.chart_calls c where c.status in ('open', 'full') loop
      continue when x.why is null;
      update public.chart_calls set status = 'done', ended_at = now(), end_reason = x.why where id = x.id and status in ('open', 'full');
      update public.chart_call_members set released_at = now() where call_id = x.id and released_at is null and state in ('called', 'on_way', 'arrived');
      insert into public.chart_log (case_id, actor_name, action, detail) values (x.case_id, 'Auto', 'call_end', jsonb_build_object('call', x.id, 'reason', x.why));
      changed := true;
    end loop;
    -- members who clocked out
    for x in select m.id, m.call_id, m.discord_id from public.chart_call_members m join public.chart_calls c on c.id = m.call_id
             where c.status in ('open', 'full') and m.state in ('called', 'on_way', 'arrived') and (public.chart_shift_of(m.discord_id)).id is null loop
      update public.chart_call_members set state = 'released', released_at = now() where id = x.id;
      perform public.chart_call_refresh(x.call_id);
      insert into public.chart_log (subject_id, actor_name, action, detail) values (x.discord_id, 'Auto', 'call_remove', jsonb_build_object('call', x.call_id, 'reason', 'Clocked out'));
      changed := true;
    end loop;
    return changed;
  exception when others then
    begin
      insert into public.chart_log (actor_name, action, detail) values ('Auto', 'call_error', jsonb_build_object('error', sqlerrm));
    exception when others then
      raise warning 'chart_call_sweep: %', sqlerrm;
    end;
    return false;
  end;
end $$;

-- ---------- grants ----------
do $g$
declare f text;
begin
  foreach f in array array[
    'public.chart_call_depts()', 'public.chart_call_want(public.chart_calls,text)', 'public.chart_call_held(bigint,text)',
    'public.chart_call_open(bigint,text)', 'public.chart_call_open_total(bigint)', 'public.chart_call_refresh(bigint)', 'public.chart_away(text)',
    'public.chart_call_state(text)', 'public.chart_call_fit_dept(bigint,text)', 'public.chart_calls_joinable(text)', 'public.chart_call_where(bigint)', 'public.chart_call_room(text,bigint)',
    'public.chart_calls_view()', 'public.chart_call_sup()', 'public.chart_call_get(bigint)', 'public.chart_call_set_want(bigint,jsonb)',
    'public.chart_call_name(bigint,text,text)', 'public.chart_call_name_all(bigint,jsonb)', 'public.chart_call_fit(bigint)',
    'public.chart_call_check(bigint)', 'public.chart_call_sweep()',
    'public.chart_call_start(bigint,text,jsonb,jsonb,text)', 'public.chart_call_set(bigint,jsonb,text)', 'public.chart_call_add(bigint,jsonb)',
    'public.chart_call_remove(bigint,text)', 'public.chart_call_end(bigint,boolean)', 'public.chart_call_answer(bigint,boolean,text)',
    'public.chart_call_arrived(bigint,text)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  foreach f in array array[
    'public.chart_call_start(bigint,text,jsonb,jsonb,text)', 'public.chart_call_set(bigint,jsonb,text)', 'public.chart_call_add(bigint,jsonb)',
    'public.chart_call_remove(bigint,text)', 'public.chart_call_end(bigint,boolean)', 'public.chart_call_answer(bigint,boolean,text)',
    'public.chart_call_arrived(bigint,text)'] loop
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $g$;

-- ---------- patches to live functions ----------
do $m$
declare d text; n text;
begin
  -- tick: tidy calls
  d := pg_get_functiondef('public.chart_tick()'::regprocedure);
  n := replace(d, $a$  delete from public.chart_checkin_attempts where at < now() - interval '24 hours';$a$,
                  $b$  if public.chart_call_sweep() then changed := true; end if;
  delete from public.chart_checkin_attempts where at < now() - interval '24 hours';$b$);
  if n = d then raise exception '0096: chart_tick text not found'; end if;
  execute n;

  -- auto-assign: not to someone on a trauma call
  d := pg_get_functiondef('public.chart_auto_assign()'::regprocedure);
  n := replace(d, $a$where x.role = 'room' and x.ready and not public.chart_on_break(x.discord_id)$a$,
                  $b$where x.role = 'room' and x.ready and not public.chart_on_break(x.discord_id) and not public.chart_away(x.discord_id)$b$);
  if n = d then raise exception '0096: chart_auto_assign text not found'; end if;
  execute n;

  -- poll
  d := pg_get_functiondef('public.chart_poll(bigint)'::regprocedure);
  n := replace(d, $a$'can_supervise', public.chart_can_supervise(), 'ready', me.ready,$a$,
                  $b$'can_supervise', public.chart_can_supervise(), 'call', public.chart_call_state(uid), 'can_join', public.chart_calls_joinable(uid), 'ready', me.ready,$b$);
  if n = d then raise exception '0096: chart_poll me text not found'; end if;
  d := n;
  n := replace(d, $a$'available', b.available, 'off_reason', b.off_reason,$a$,
                  $b$'available', b.available, 'off_reason', b.off_reason, 'away', public.chart_away(b.owner_id),$b$);
  if n = d then raise exception '0096: chart_poll beds text not found'; end if;
  d := n;
  n := replace(d, $a$'status', public.chart_staff_status(s.discord_id), 'ready_since', s.ready_since,$a$,
                  $b$'status', public.chart_staff_status(s.discord_id), 'ready_since', s.ready_since, 'call', public.chart_call_state(s.discord_id),$b$);
  if n = d then raise exception '0096: chart_poll staff text not found'; end if;
  d := n;
  n := replace(d, $a$where c.status = 'open' and c.code_at is not null), '[]'));$a$,
                  $b$where c.status = 'open' and c.code_at is not null), '[]'),
    'calls', public.chart_calls_view());$b$);
  if n = d then raise exception '0096: chart_poll calls text not found'; end if;
  execute n;
end $m$;
