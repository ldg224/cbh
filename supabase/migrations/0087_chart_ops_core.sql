-- 0087: CBH Chart operations, the core (Bravo, 19 Nov 2026; BACKEND-PLAN §2-4.8, CONTRACT.md v1.1).
-- Helpers, the one lock, the tick (timers), THE placement check + trigger backstop, auto-assign, and the staff / room /
-- case RPCs. Every change RPC: lock -> tick -> check -> change -> log -> auto-assign (unsupervised) -> bump rev.
-- Errors: plain-words message + a stable hint code (CONTRACT §8). Internal helpers are revoked from website users;
-- only the RPCs in CONTRACT are granted to authenticated (never anon here).

-- ---------- small helpers (internal) ----------
create or replace function public.chart_err(h text, m text) returns void
language plpgsql immutable set search_path = '' as $$
begin
  raise exception using message = m, hint = h, errcode = 'P0001';
end $$;

create or replace function public.chart_lock() returns void
language sql volatile set search_path = '' as $$
  select pg_advisory_xact_lock(hashtext('cbh_chart_ops'))
$$;

create or replace function public.chart_pname(who text) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((select m.display_name from public.members m where m.discord_id = who), 'Someone')
$$;

create or replace function public.chart_short(who text) returns text
language sql stable security definer set search_path = '' as $$
  select public.checkin_short_name(public.chart_pname(who))
$$;

create or replace function public.chart_bump() returns bigint
language sql volatile security definer set search_path = '' as $$
  update public.chart_ops set rev = rev + 1 where id = 1 returning rev
$$;

create or replace function public.chart_rev() returns bigint
language sql stable security definer set search_path = '' as $$
  select rev from public.chart_ops where id = 1
$$;

create or replace function public.chart_act(p_action text, p_case bigint default null, p_detail jsonb default '{}'::jsonb,
                                            p_room text default null, p_request bigint default null, p_subject text default null)
returns void language sql volatile security definer set search_path = '' as $$
  insert into public.chart_log (case_id, room_id, request_id, subject_id, actor, actor_name, actor_role, action, detail)
  values (p_case, p_room, p_request, p_subject, public.my_discord_id(), public.chart_short(public.my_discord_id()),
          (select s.role from public.chart_staff s where s.discord_id = public.my_discord_id()), p_action, coalesce(p_detail, '{}'::jsonb))
$$;

-- The person's open shift (newest), if any.
create or replace function public.chart_shift_of(who text) returns public.shifts
language sql stable security definer set search_path = '' as $$
  select s.* from public.shifts s where s.discord_id = who and s.status <> 'ended' order by s.started_at desc limit 1
$$;

-- Clinical departments the person belongs to (department or rank roles).
create or replace function public.chart_person_depts(who text) returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct r.department order by r.department), '{}')
  from public.members m join public.roles r on r.id = any (m.role_ids)
  join public.departments d on d.name = r.department and d.clinical and d.active
  where m.discord_id = who and r.kind in ('department', 'rank')
$$;

create or replace function public.chart_session_live() returns bigint
language sql stable security definer set search_path = '' as $$
  select s.id from public.sessions s where s.status = 'live' order by s.started_at desc nulls last limit 1
$$;

create or replace function public.chart_can_supervise() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.has_hperm('hosp.supervise')
      or exists (select 1 from public.sessions s where s.status = 'live' and s.host_discord_id = public.my_discord_id())
$$;

create or replace function public.chart_supervised() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.chart_staff s where s.role = 'supervisor')
$$;

create or replace function public.chart_is_sup() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.chart_staff s where s.discord_id = public.my_discord_id() and s.role = 'supervisor')
$$;

-- Patients someone holds now (counts towards the limit of 2; NPCs included, a pair doesn't count).
create or replace function public.chart_load(who text) returns int
language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.chart_cases c
  where c.status = 'open' and c.owner_id = who and c.state in ('assigned', 'called', 'in_care')
$$;

create or replace function public.chart_on_break(who text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((public.chart_shift_of(who)).status = 'break', false)
$$;

-- The caller's Chart row; creates it on first use while on shift. Fails with not_on_shift otherwise.
create or replace function public.chart_whoami() returns public.chart_staff
language plpgsql volatile security definer set search_path = '' as $$
declare me text := public.my_discord_id(); sh public.shifts; s public.chart_staff;
begin
  if me is null then perform public.chart_err('not_on_shift', 'Log in to use the Chart.'); end if;
  sh := public.chart_shift_of(me);
  if sh.id is null then
    delete from public.chart_staff x where x.discord_id = me;
    perform public.chart_err('not_on_shift', 'Start a shift to use the Chart.');
  end if;
  insert into public.chart_staff as x (discord_id, shift_id, department)
  values (me, sh.id, case when sh.department = any (public.chart_person_depts(me)) then sh.department else (public.chart_person_depts(me))[1] end)
  on conflict (discord_id) do update set shift_id = excluded.shift_id
  returning * into s;
  return s;
end $$;

create or replace function public.chart_touch() returns void
language sql volatile security definer set search_path = '' as $$
  update public.chart_staff set last_active_at = now() where discord_id = public.my_discord_id()
$$;

create or replace function public.chart_notice(who text, msg text) returns void
language sql volatile security definer set search_path = '' as $$
  update public.chart_staff set notices = (notices || jsonb_build_array(jsonb_build_object('id', (extract(epoch from clock_timestamp()) * 1000)::bigint,
         'text', msg, 'at', now())))
  where discord_id = who
$$;

create or replace function public.chart_need_sup() returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform public.chart_whoami();
  if not public.chart_is_sup() then perform public.chart_err('not_supervisor', 'Only the Supervisor can do that.'); end if;
end $$;

create or replace function public.chart_case_row(p_case bigint) returns public.chart_cases
language plpgsql stable security definer set search_path = '' as $$
declare c public.chart_cases;
begin
  select * into c from public.chart_cases x where x.id = p_case;
  if c.id is null or c.state is null then perform public.chart_err('no_access', 'That patient isn''t there.'); end if;
  return c;
end $$;

create or replace function public.chart_teams_ok(t text[]) returns text[]
language plpgsql stable security definer set search_path = '' as $$
declare x text; out text[] := '{}';
begin
  if t is null or cardinality(t) = 0 then return array['Any']; end if;
  if 'Any' = any (t) then return array['Any']; end if;
  foreach x in array t loop
    if not exists (select 1 from public.departments d where d.name = x and d.clinical and d.active) then
      perform public.chart_err('bad_input', format('%s isn''t a clinical team.', x));
    end if;
    if not x = any (out) then out := out || x; end if;
  end loop;
  return out;
end $$;

-- ---------- THE placement check (BACKEND-PLAN §4.8). Returns null when OK, else 'hint|message'. ----------
-- mode: 'place' (normal), 'swap' (the bed's current patient is the swap partner), 'own' (bed rules only, no patient).
create or replace function public.chart_place_ok(p_case bigint, p_bed text, p_person text, p_mode text default 'place', p_override boolean default false)
returns text language plpgsql stable security definer set search_path = '' as $$
declare b public.chart_beds; r public.chart_rooms; c public.chart_cases; s public.chart_staff; other bigint;
begin
  select * into b from public.chart_beds x where x.id = p_bed;
  if b.id is null then return 'bad_beds|That bed doesn''t exist.'; end if;
  select * into r from public.chart_rooms x where x.id = b.room_id;
  if not r.active or r.closed then return format('room_closed|Room %s is closed: %s', r.id, coalesce(r.closed_reason, 'out of use')); end if;
  if not b.available then return format('bed_off|%s is switched off: %s', b.label, coalesce(b.off_reason, 'out of use')); end if;
  if p_case is not null then
    select * into c from public.chart_cases x where x.id = p_case;
    select x.id into other from public.chart_cases x where x.status = 'open' and x.bed_id = b.id and x.id <> p_case limit 1;
    if other is not null and p_mode <> 'swap' then
      return format('bed_taken|%s already has %s.', b.label, rtrim((select public.checkin_short_name(x.patient_name) from public.chart_cases x where x.id = other), '.'));
    end if;
    if r.who = 'kids' and not c.child then return format('kids_only|Room %s is for children only.', r.id); end if;
    if r.who = 'adults' and c.child then return format('adults_only|Room %s is for adults only.', r.id); end if;
  end if;
  if p_person is not null then
    select * into s from public.chart_staff x where x.discord_id = p_person;
    if s.discord_id is null or (public.chart_shift_of(p_person)).id is null then
      return format('not_on_shift|%s isn''t on shift.', public.chart_pname(p_person));
    end if;
    if public.chart_on_break(p_person) then return format('wrong_role|%s is on a break.', public.chart_pname(p_person)); end if;
    if s.role is distinct from 'room' and s.role is distinct from 'on_call' then
      return format('wrong_role|%s isn''t working Patient Care.', public.chart_pname(p_person));
    end if;
    if b.owner_id is not null and b.owner_id <> p_person then
      return format('not_bed_owner|%s is %s''s bed.', b.label, public.chart_pname(b.owner_id));
    end if;
    if b.owner_id is null and (select count(*) from public.chart_beds x where x.owner_id = p_person) >= 2 then
      return format('limit|%s already holds 2 beds.', public.chart_pname(p_person));
    end if;
    if p_case is not null then
      if (select x.owner_id from public.chart_cases x where x.id = p_case) is distinct from p_person and public.chart_load(p_person) >= 2 then
        return format('limit|%s already has 2 patients.', public.chart_pname(p_person));
      end if;
      if c.team is not null and c.team <> 'Any' and c.team is distinct from s.department and not p_override then
        return format('not_their_team|%s is a %s patient and %s is working %s.', public.checkin_short_name(c.patient_name), c.team,
                      public.chart_pname(p_person), coalesce(s.department, 'no team'));
      end if;
    end if;
  end if;
  return null;
end $$;

create or replace function public.chart_place_check(p_case bigint, p_bed text, p_person text, p_mode text default 'place', p_override boolean default false)
returns void language plpgsql stable security definer set search_path = '' as $$
declare e text := public.chart_place_ok(p_case, p_bed, p_person, p_mode, p_override);
begin
  if e is not null then perform public.chart_err(split_part(e, '|', 1), substr(e, strpos(e, '|') + 1)); end if;
end $$;

-- Ownership half: one 2-bed room, any two 1-bed rooms, or one bed of a shared room; max 2 beds in total.
create or replace function public.chart_own_ok(p_person text, p_beds text[]) returns text
language plpgsql stable security definer set search_path = '' as $$
declare x text; e text; keep text[]; total int; twos int; rooms_n int;
begin
  if p_beds is null or cardinality(p_beds) = 0 or cardinality(p_beds) > 2 then return 'bad_beds|Pick one or two beds.'; end if;
  foreach x in array p_beds loop
    e := public.chart_place_ok(null, x, null, 'own');
    if e is not null then return e; end if;
    if exists (select 1 from public.chart_beds b where b.id = x and b.owner_id is not null and b.owner_id <> p_person) then
      return format('not_bed_owner|%s is %s''s bed.', (select b.label from public.chart_beds b where b.id = x),
                    public.chart_pname((select b.owner_id from public.chart_beds b where b.id = x)));
    end if;
  end loop;
  select array_agg(b.id) into keep from public.chart_beds b where b.owner_id = p_person and not b.id = any (p_beds);
  total := cardinality(p_beds) + coalesce(cardinality(keep), 0);
  if total > 2 then return 'limit|You can hold 2 beds at most.'; end if;
  select count(distinct b.room_id), count(*) filter (where r.beds = 2) into rooms_n, twos
  from public.chart_beds b join public.chart_rooms r on r.id = b.room_id where b.id = any (p_beds || coalesce(keep, '{}'));
  if total = 2 and rooms_n = 2 and twos > 0 then return 'bad_beds|Pick one 2-bed room, or any two 1-bed rooms.'; end if;
  return null;
end $$;

-- ---------- trigger backstop: no RPC can place into a closed room or an Off bed, or break kids/adults ----------
create or replace function public.chart_bed_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare e text;
begin
  if new.status = 'open' and new.bed_id is not null and (tg_op = 'INSERT' or new.bed_id is distinct from old.bed_id or new.child is distinct from old.child) then
    e := public.chart_place_ok(new.id, new.bed_id, null, 'swap');   -- room/bed/who rules; the bed's occupant is checked by the unique index
    if e is not null and split_part(e, '|', 1) in ('room_closed', 'bed_off', 'kids_only', 'adults_only', 'bad_beds') then
      perform public.chart_err(split_part(e, '|', 1), substr(e, strpos(e, '|') + 1));
    end if;
  end if;
  return new;
end $$;
drop trigger if exists chart_bed_guard on public.chart_cases;
create trigger chart_bed_guard before insert or update of bed_id, child on public.chart_cases
  for each row execute function public.chart_bed_guard();

create or replace function public.chart_owner_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r public.chart_rooms;
begin
  select * into r from public.chart_rooms x where x.id = new.room_id;
  if new.owner_id is not null and new.owner_id is distinct from old.owner_id then
    if r.closed or not r.active then perform public.chart_err('room_closed', format('Room %s is closed: %s', r.id, coalesce(r.closed_reason, 'out of use'))); end if;
    if not new.available then perform public.chart_err('bed_off', format('%s is switched off: %s', new.label, coalesce(new.off_reason, 'out of use'))); end if;
  end if;
  if old.available and not new.available then
    if exists (select 1 from public.chart_cases c where c.status = 'open' and c.bed_id = new.id) then
      perform public.chart_err('bed_in_use', format('%s has a patient in it.', new.label));
    end if;
    if new.owner_id is not null then perform public.chart_err('bed_in_use', format('%s is held by %s: release it first.', new.label, public.chart_pname(new.owner_id))); end if;
  end if;
  return new;
end $$;
drop trigger if exists chart_owner_guard on public.chart_beds;
create trigger chart_owner_guard before update on public.chart_beds for each row execute function public.chart_owner_guard();

create or replace function public.chart_room_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.closed and not old.closed then
    if exists (select 1 from public.chart_cases c join public.chart_beds b on b.id = c.bed_id where c.status = 'open' and b.room_id = new.id) then
      perform public.chart_err('room_in_use', 'Move the patients out of the room first.');
    end if;
    if exists (select 1 from public.chart_beds b where b.room_id = new.id and b.owner_id is not null) then
      perform public.chart_err('room_owned', 'Free the beds first: someone still holds a bed in this room.');
    end if;
  end if;
  return new;
end $$;
drop trigger if exists chart_room_guard on public.chart_rooms;
create trigger chart_room_guard before update on public.chart_rooms for each row execute function public.chart_room_guard();

-- ---------- moving cases (internal) ----------
-- Give a case to a person in a bed: assigned + 60 s Got it. The check-in's extra teams become requests the first time.
create or replace function public.chart_do_assign(p_case bigint, p_bed text, p_person text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare c public.chart_cases; t text;
begin
  select * into c from public.chart_cases x where x.id = p_case for update;
  update public.chart_beds set owner_id = p_person, owner_since = coalesce(owner_since, now()) where id = p_bed and owner_id is null;
  update public.chart_cases set state = 'assigned', assign_from = c.state, owner_id = p_person, bed_id = p_bed, assigned_at = now(),
         assign_expires_at = now() + interval '60 seconds', last_at = now()
  where id = p_case;
  if cardinality(c.extra_teams) > 0 and not exists (select 1 from public.chart_requests q where q.case_id = p_case and q.auto) then
    foreach t in array c.extra_teams loop
      insert into public.chart_requests (case_id, kind, red, asked_by, auto)
      values (p_case, case t when 'Medical' then 'doctor' when 'Surgical' then 'surgery' else 'help' end, c.esi = 1, p_person, true);
    end loop;
  end if;
  update public.chart_staff set offer_room_id = null where discord_id = p_person;
end $$;

-- Back to the queue (top of its colour). Keeps the bed when it was handed back in a room.
create or replace function public.chart_requeue(p_case bigint, p_keep_bed boolean) returns void
language sql volatile security definer set search_path = '' as $$
  update public.chart_cases set state = case when p_keep_bed and bed_id is not null then 'waiting_in_room' else 'waiting' end,
         bed_id = case when p_keep_bed then bed_id else null end, owner_id = null, priority = 1, assigned_at = null,
         assign_expires_at = null, assign_from = null, called_at = null, last_at = now()
  where id = p_case
$$;

create or replace function public.chart_close_case(p_case bigint, p_state text, p_outcome text) returns void
language sql volatile security definer set search_path = '' as $$
  update public.chart_requests set cancelled_at = now(), cancelled_by = public.my_discord_id(), cancel_reason = 'Patient left'
  where case_id = p_case and done_at is null and cancelled_at is null;
  update public.chart_cases set status = 'closed', state = p_state, outcome = p_outcome, closed_at = now(), closed_by = public.my_discord_id(),
         bed_id = null, owner_id = null, assign_expires_at = null, code_at = null, visit_expires_at = now() + interval '24 hours', last_at = now(),
         disposition = case p_outcome when 'home' then 'discharged' when 'follow_up' then 'discharged' when 'admitted' then 'admitted'
                                      when 'transferred' then 'transferred' when 'died' then 'deceased' when 'left_before_seen' then 'lwbs'
                                      when 'left_during_care' then 'ama' else disposition end
  where id = p_case
$$;

create or replace function public.chart_worked(p_case bigint, who text) returns void
language sql volatile security definer set search_path = '' as $$
  update public.chart_cases set
    worked_by = case when who = any (worked_by) then worked_by else worked_by || who end,
    departments = case when (select s.department from public.chart_staff s where s.discord_id = who) is null
                         or (select s.department from public.chart_staff s where s.discord_id = who) = any (departments) then departments
                       else departments || (select s.department from public.chart_staff s where s.discord_id = who) end
  where id = p_case
$$;

-- ---------- auto-assign (no Supervisor on) ----------
create or replace function public.chart_auto_assign() returns int
language plpgsql volatile security definer set search_path = '' as $$
declare s record; c record; b text; n int := 0; room_off text;
begin
  if public.chart_supervised() then return 0; end if;
  for s in select x.* from public.chart_staff x
           where x.role = 'room' and x.ready and not public.chart_on_break(x.discord_id)
             and not exists (select 1 from public.chart_cases y where y.status = 'open' and y.owner_id = x.discord_id and y.state = 'assigned')
             and public.chart_load(x.discord_id) < 2
           order by x.ready_since nulls last loop
    b := null;
    for c in select y.* from public.chart_cases y
             where y.status = 'open' and y.state in ('waiting', 'waiting_in_room') and y.colour_confirmed and y.team is not null
               and (y.team = 'Any' or y.team = s.department)
             order by y.esi nulls last, y.prioritised desc, y.priority desc, y.queued_at loop
      if c.state = 'waiting_in_room' then
        if (select bb.owner_id from public.chart_beds bb where bb.id = c.bed_id) = s.discord_id
           and public.chart_place_ok(c.id, c.bed_id, s.discord_id) is null then b := c.bed_id; end if;
      else
        select bb.id into b from public.chart_beds bb join public.chart_rooms r on r.id = bb.room_id
        where bb.owner_id = s.discord_id and public.chart_place_ok(c.id, bb.id, s.discord_id) is null
        order by (c.child and r.who = 'kids') desc, r.sort, bb.id limit 1;
      end if;
      if b is not null then
        perform public.chart_do_assign(c.id, b, s.discord_id);
        insert into public.chart_log (case_id, subject_id, actor_name, action, detail) values (c.id, s.discord_id, 'Auto', 'assign', jsonb_build_object('bed', b, 'auto', true));
        n := n + 1;
        exit;
      end if;
    end loop;
    -- Ready with no beds: offer an Open room whose waiting-in-room patients are their team.
    if b is null and not exists (select 1 from public.chart_beds bb where bb.owner_id = s.discord_id) then
      select r.id into room_off from public.chart_rooms r
      where not r.closed and r.active and not exists (select 1 from public.chart_beds bb where bb.room_id = r.id and bb.owner_id is not null)
        and exists (select 1 from public.chart_cases y join public.chart_beds bb on bb.id = y.bed_id
                    where bb.room_id = r.id and y.status = 'open' and y.state = 'waiting_in_room' and (y.team = 'Any' or y.team = s.department))
        and exists (select 1 from public.chart_beds bb where bb.room_id = r.id and bb.available)
      order by r.sort limit 1;
      update public.chart_staff set offer_room_id = room_off where discord_id = s.discord_id and offer_room_id is distinct from room_off;
    end if;
  end loop;
  return n;
end $$;

-- ---------- the tick: timers, at most every 2 s (call under the lock) ----------
create or replace function public.chart_tick() returns void
language plpgsql volatile security definer set search_path = '' as $$
declare o public.chart_ops; c record; changed boolean := false;
begin
  select * into o from public.chart_ops where id = 1;
  if o.last_tick_at > now() - interval '2 seconds' then return; end if;
  update public.chart_ops set last_tick_at = now() where id = 1;
  for c in select * from public.chart_cases where status = 'open' and state = 'assigned' and assign_expires_at < now() loop
    update public.chart_staff set ready = false, ready_since = null where discord_id = c.owner_id;
    perform public.chart_notice(c.owner_id, format('%s went back to Up next: Got it wasn''t pressed in time.', public.checkin_short_name(c.patient_name)));
    perform public.chart_requeue(c.id, c.assign_from = 'waiting_in_room');
    if c.assign_from = 'waiting_in_room' then
      -- the bed was theirs only through the assignment if it was Open: give it back
      null;
    end if;
    insert into public.chart_log (case_id, subject_id, actor_name, action) values (c.id, c.owner_id, 'Auto', 'expire_assign');
    changed := true;
  end loop;
  for c in select x.* from public.chart_staff x where x.ready and x.last_active_at < now() - interval '10 minutes' and public.chart_load(x.discord_id) = 0 loop
    update public.chart_staff set ready = false, ready_since = null where discord_id = c.discord_id;
    insert into public.chart_log (subject_id, actor_name, action) values (c.discord_id, 'Auto', 'ready_expired');
    changed := true;
  end loop;
  delete from public.chart_checkin_attempts where at < now() - interval '24 hours';
  if o.ip_salt_day < current_date then
    update public.chart_ops set ip_salt = encode(extensions.gen_random_bytes(16), 'hex'), ip_salt_day = current_date where id = 1;
  end if;
  if public.chart_auto_assign() > 0 then changed := true; end if;
  if changed then perform public.chart_bump(); end if;
end $$;

-- Finish a change: auto-assign when unsupervised, bump rev, reply.
create or replace function public.chart_done(extra jsonb default '{}'::jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform public.chart_touch();
  perform public.chart_auto_assign();
  return jsonb_build_object('ok', true, 'rev', public.chart_bump()) || coalesce(extra, '{}'::jsonb);
end $$;

create or replace function public.chart_begin() returns public.chart_staff
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform public.chart_lock();
  perform public.chart_tick();
  return public.chart_whoami();
end $$;

-- ================= STAFF, BEDS AND ROOMS =================
create or replace function public.chart_role_set(p_role text, p_department text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare me public.chart_staff := public.chart_begin(); depts text[] := public.chart_person_depts(me.discord_id); d text;
begin
  if p_role is not null and p_role not in ('reception', 'room', 'on_call', 'road', 'supervisor') then perform public.chart_err('bad_input', 'Pick a role.'); end if;
  if p_role is not null and not (select launched from public.chart_ops where id = 1) and not (public.is_exec() or public.has_hperm('hosp.supervise')) then
    perform public.chart_err('not_launched', 'The Chart isn''t open yet.');
  end if;
  if public.chart_load(me.discord_id) > 0 and p_role is distinct from me.role then perform public.chart_err('hold_patients', 'Hand your patients back first.'); end if;
  d := coalesce(p_department, me.department);
  if p_role in ('room', 'on_call', 'road') and not d = any (depts) then d := depts[1]; end if;
  if p_department is not null and not p_department = any (depts) then perform public.chart_err('cant_pick_role', format('You aren''t in %s.', p_department)); end if;
  if p_role = 'room' and cardinality(depts) = 0 then perform public.chart_err('cant_pick_role', 'Patient Care is for clinical departments.'); end if;
  if p_role = 'on_call' and not (d in ('Medical', 'Surgical')) then perform public.chart_err('cant_pick_role', 'On call is for Medical and Surgical.'); end if;
  if p_role = 'road' and not ('Paramedicine' = any (depts)) then perform public.chart_err('cant_pick_role', 'The Road role is for Paramedicine.'); d := 'Paramedicine'; end if;
  if p_role = 'road' then d := 'Paramedicine'; end if;
  if p_role = 'supervisor' and not public.chart_can_supervise() then perform public.chart_err('cant_pick_role', 'Supervising needs the Supervise sessions permission, or hosting the live session.'); end if;
  if p_role = 'reception' and not (select reception_open from public.chart_ops where id = 1) then perform public.chart_err('cant_pick_role', 'Reception is closed for this session.'); end if;
  if p_role is distinct from 'room' and p_role is distinct from 'on_call' then
    update public.chart_beds set owner_id = null, owner_since = null where owner_id = me.discord_id;
  end if;
  update public.chart_staff set role = p_role, department = d, ready = false, ready_since = null, offer_room_id = null where discord_id = me.discord_id;
  perform public.chart_act('role_set', null, jsonb_build_object('role', p_role, 'department', d));
  return public.chart_done(jsonb_build_object('need_room', p_role = 'room' and not exists (select 1 from public.chart_beds b where b.owner_id = me.discord_id)));
end $$;

create or replace function public.chart_ready(p_on boolean) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare me public.chart_staff := public.chart_begin();
begin
  if me.role is distinct from 'room' then perform public.chart_err('wrong_role', 'Pick Patient Care: Room first.'); end if;
  if p_on and public.chart_on_break(me.discord_id) then perform public.chart_err('wrong_role', 'You''re on a break.'); end if;
  -- Ready with no beds is allowed: the client shows the room picker (need_room), and auto mode may offer a room to take over.
  update public.chart_staff set ready = p_on, ready_since = case when p_on then now() end where discord_id = me.discord_id;
  perform public.chart_act(case when p_on then 'ready' else 'not_ready' end);
  return public.chart_done(jsonb_build_object('need_room', p_on and not exists (select 1 from public.chart_beds b where b.owner_id = me.discord_id)));
end $$;

create or replace function public.chart_stay_ready() returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare me public.chart_staff := public.chart_begin();
begin
  return public.chart_done(jsonb_build_object('ready_expires_at', now() + interval '10 minutes'));
end $$;

create or replace function public.chart_take_beds(p_beds text[]) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare me public.chart_staff := public.chart_begin(); e text;
begin
  if coalesce(me.role, '') not in ('room', 'on_call') or me.role is null then perform public.chart_err('wrong_role', 'Pick Patient Care: Room first.'); end if;
  if public.chart_load(me.discord_id) > 0 then perform public.chart_err('hold_patients', 'Hand your patients back first.'); end if;
  update public.chart_beds set owner_id = null, owner_since = null where owner_id = me.discord_id and not id = any (p_beds);
  e := public.chart_own_ok(me.discord_id, p_beds);
  if e is not null then perform public.chart_err(split_part(e, '|', 1), substr(e, strpos(e, '|') + 1)); end if;
  update public.chart_beds set owner_id = me.discord_id, owner_since = now() where id = any (p_beds) and owner_id is null;
  perform public.chart_act('take_beds', null, jsonb_build_object('beds', to_jsonb(p_beds)));
  return public.chart_done();
end $$;

create or replace function public.chart_leave_beds() returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare me public.chart_staff := public.chart_begin();
begin
  if public.chart_load(me.discord_id) > 0 then perform public.chart_err('hold_patients', 'Hand your patients back first.'); end if;
  update public.chart_beds set owner_id = null, owner_since = null where owner_id = me.discord_id;
  update public.chart_staff set ready = false, ready_since = null where discord_id = me.discord_id;
  perform public.chart_act('leave_beds');
  return public.chart_done();
end $$;

create or replace function public.chart_offer_take() returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare me public.chart_staff := public.chart_begin(); bs text[]; e text;
begin
  if me.offer_room_id is null then perform public.chart_err('bad_state', 'That room was taken.'); end if;
  select array_agg(b.id order by b.id) into bs from public.chart_beds b where b.room_id = me.offer_room_id and b.available and b.owner_id is null;
  e := public.chart_own_ok(me.discord_id, bs);
  if e is not null then perform public.chart_err(split_part(e, '|', 1), substr(e, strpos(e, '|') + 1)); end if;
  update public.chart_beds set owner_id = me.discord_id, owner_since = now() where id = any (bs);
  update public.chart_staff set offer_room_id = null where discord_id = me.discord_id;
  perform public.chart_act('offer_take', null, jsonb_build_object('beds', to_jsonb(bs)), me.offer_room_id);
  return public.chart_done();
end $$;

create or replace function public.chart_room_set(p_room text, p_department text, p_who text, p_closed boolean, p_closed_reason text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare r public.chart_rooms; bad text; why text := nullif(btrim(coalesce(p_closed_reason, '')), '');
begin
  perform public.chart_begin(); perform public.chart_need_sup();
  select * into r from public.chart_rooms x where x.id = p_room for update;
  if r.id is null then perform public.chart_err('bad_input', 'No such room.'); end if;
  if p_department is not null and p_department <> 'Paediatric'
     and not exists (select 1 from public.departments d where d.name = p_department and d.clinical and d.active) then
    perform public.chart_err('bad_input', 'Pick a clinical department.');
  end if;
  if p_who is not null and p_who not in ('anyone', 'kids', 'adults') then perform public.chart_err('bad_input', 'Pick who can go in.'); end if;
  if p_closed and not r.closed and (why is null or char_length(why) < 3) then perform public.chart_err('reason_needed', 'Say why the room is closed.'); end if;
  if p_who is not null and p_who <> r.who then
    select public.checkin_short_name(c.patient_name) into bad from public.chart_cases c join public.chart_beds b on b.id = c.bed_id
    where c.status = 'open' and b.room_id = r.id and ((p_who = 'kids' and not c.child) or (p_who = 'adults' and c.child)) limit 1;
    if bad is not null then perform public.chart_err('who_conflict', format('%s is in %s and wouldn''t fit: move them first.', bad, r.id)); end if;
  end if;
  update public.chart_rooms set department = coalesce(p_department, department), who = coalesce(p_who, who),
         closed = coalesce(p_closed, closed), closed_reason = case when coalesce(p_closed, closed) then coalesce(left(why, 120), closed_reason) end,
         closed_by = case when p_closed and not r.closed then public.my_discord_id() when not coalesce(p_closed, closed) then null else closed_by end,
         closed_at = case when p_closed and not r.closed then now() when not coalesce(p_closed, closed) then null else closed_at end,
         updated_by = public.my_discord_id(), updated_at = now()
  where id = r.id;
  perform public.chart_act('room_set', null, jsonb_build_object('before', jsonb_build_object('department', r.department, 'who', r.who, 'closed', r.closed, 'reason', r.closed_reason),
          'after', (select jsonb_build_object('department', x.department, 'who', x.who, 'closed', x.closed, 'reason', x.closed_reason) from public.chart_rooms x where x.id = r.id)), r.id);
  return public.chart_done();
end $$;

create or replace function public.chart_bed_set(p_bed text, p_available boolean, p_reason text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare b public.chart_beds; why text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  perform public.chart_begin(); perform public.chart_need_sup();
  select * into b from public.chart_beds x where x.id = p_bed for update;
  if b.id is null then perform public.chart_err('bad_beds', 'That bed doesn''t exist.'); end if;
  if not p_available and b.available then
    if exists (select 1 from public.chart_cases c where c.status = 'open' and c.bed_id = b.id) then
      perform public.chart_err('bed_in_use', format('%s has a patient in it.', b.label));
    end if;
    if why is null or char_length(why) < 3 then perform public.chart_err('reason_needed', 'Say why the bed is off.'); end if;
    if b.owner_id is not null then
      perform public.chart_notice(b.owner_id, format('%s was switched off by %s.', b.label, rtrim(public.chart_short(public.my_discord_id()), '.')));
      perform public.chart_act('bed_off_release', null, jsonb_build_object('bed', b.id, 'owner', b.owner_id), b.room_id, null, b.owner_id);
      update public.chart_beds set owner_id = null, owner_since = null where id = b.id;
    end if;
  end if;
  update public.chart_beds set available = p_available, off_reason = case when p_available then null else left(why, 120) end,
         off_by = case when p_available then null else public.my_discord_id() end, off_at = case when p_available then null else now() end
  where id = b.id;
  perform public.chart_act('bed_set', null, jsonb_build_object('bed', b.id, 'before', b.available, 'after', p_available, 'reason', why), b.room_id);
  return public.chart_done();
end $$;

create or replace function public.chart_room_problem(p_room text, p_note text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform public.chart_begin();
  update public.chart_rooms set problem_note = left(nullif(btrim(coalesce(p_note, '')), ''), 200), problem_by = public.my_discord_id(), problem_at = now() where id = p_room;
  if not found then perform public.chart_err('bad_input', 'No such room.'); end if;
  perform public.chart_act('room_problem', null, jsonb_build_object('note', p_note), p_room);
  return public.chart_done();
end $$;

create or replace function public.chart_room_problem_clear(p_room text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform public.chart_begin(); perform public.chart_need_sup();
  update public.chart_rooms set problem_note = null, problem_by = null, problem_at = null where id = p_room;
  perform public.chart_act('room_problem_clear', null, '{}', p_room);
  return public.chart_done();
end $$;

create or replace function public.chart_give_room(p_person text, p_beds text[], p_move_patients boolean default false) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare s public.chart_staff; e text; c record; nb text;
begin
  perform public.chart_begin(); perform public.chart_need_sup();
  select * into s from public.chart_staff x where x.discord_id = p_person;
  if s.discord_id is null or (public.chart_shift_of(p_person)).id is null then perform public.chart_err('not_on_shift', format('%s isn''t on shift.', public.chart_pname(p_person))); end if;
  if s.role is distinct from 'room' and s.role is distinct from 'on_call' then perform public.chart_err('wrong_role', format('%s isn''t working Patient Care.', public.chart_pname(p_person))); end if;
  if public.chart_load(p_person) > 0 and not p_move_patients then perform public.chart_err('hold_patients', 'They have patients: move them too, or hand back first.'); end if;
  -- their old beds go Open (patients moved along below)
  create temporary table if not exists chart_tmp_moves (case_id bigint) on commit drop;
  delete from chart_tmp_moves;
  insert into chart_tmp_moves select x.id from public.chart_cases x where x.status = 'open' and x.owner_id = p_person and x.bed_id is not null and not x.bed_id = any (p_beds);
  update public.chart_cases set bed_id = null where id in (select case_id from chart_tmp_moves);
  update public.chart_beds set owner_id = null, owner_since = null where owner_id = p_person and not id = any (p_beds);
  e := public.chart_own_ok(p_person, p_beds);
  if e is not null then perform public.chart_err(split_part(e, '|', 1), substr(e, strpos(e, '|') + 1)); end if;
  update public.chart_beds set owner_id = p_person, owner_since = now() where id = any (p_beds) and owner_id is null;
  for c in select x.* from public.chart_cases x where x.id in (select case_id from chart_tmp_moves) loop
    select b.id into nb from public.chart_beds b where b.id = any (p_beds) and public.chart_place_ok(c.id, b.id, p_person, 'place', true) is null order by b.id limit 1;
    if nb is null then perform public.chart_err('bed_taken', format('There''s no free bed for %s in the new room.', public.checkin_short_name(c.patient_name))); end if;
    update public.chart_cases set bed_id = nb where id = c.id;
  end loop;
  perform public.chart_act('give_room', null, jsonb_build_object('beds', to_jsonb(p_beds), 'moved', (select count(*) from chart_tmp_moves)), null, null, p_person);
  perform public.chart_notice(p_person, format('%s gave you %s.', public.chart_short(public.my_discord_id()), array_to_string(p_beds, ' and ')));
  return public.chart_done();
end $$;

create or replace function public.chart_hand_back_all(p_person text, p_note text, p_lost boolean) returns int
language plpgsql volatile security definer set search_path = '' as $$
declare c record; n int := 0;
begin
  for c in select x.* from public.chart_cases x where x.status = 'open' and x.owner_id = p_person and x.state in ('assigned', 'called', 'in_care') loop
    update public.chart_cases set state = case when bed_id is not null then 'waiting_in_room' else 'waiting' end, owner_id = null, priority = 1,
           lost_nurse = lost_nurse or p_lost, handback_note = left(p_note, 300), handback_count = handback_count + 1,
           assign_expires_at = null, assign_from = null, last_at = now()
    where id = c.id;
    insert into public.chart_log (case_id, subject_id, actor, actor_name, action, detail)
    values (c.id, p_person, public.my_discord_id(), coalesce(public.chart_short(public.my_discord_id()), 'Auto'), 'hand_back', jsonb_build_object('note', p_note, 'lost', p_lost));
    n := n + 1;
  end loop;
  -- Requests they accepted go back to open.
  update public.chart_requests set accepted_by = null, accepted_at = null, here_at = null, reopened = reopened + 1
  where accepted_by = p_person and done_at is null and cancelled_at is null;
  return n;
end $$;

create or replace function public.chart_set_role_for(p_person text, p_role text, p_hand_back_note text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare note text := nullif(btrim(coalesce(p_hand_back_note, '')), '');
begin
  perform public.chart_begin(); perform public.chart_need_sup();
  if not exists (select 1 from public.chart_staff x where x.discord_id = p_person) then perform public.chart_err('not_on_shift', 'They aren''t on the Chart.'); end if;
  if p_role is not null and p_role not in ('reception', 'room', 'on_call', 'road', 'supervisor') then perform public.chart_err('bad_input', 'Pick a role.'); end if;
  if public.chart_load(p_person) > 0 then
    if note is null then perform public.chart_err('hold_patients', 'They hold patients: add a hand-back note.'); end if;
    perform public.chart_hand_back_all(p_person, note, false);
  end if;
  if p_role is distinct from 'room' and p_role is distinct from 'on_call' then update public.chart_beds set owner_id = null, owner_since = null where owner_id = p_person; end if;
  update public.chart_staff set role = p_role, ready = false, ready_since = null where discord_id = p_person;
  perform public.chart_notice(p_person, format('%s changed your role to %s.', public.chart_short(public.my_discord_id()), coalesce(replace(p_role, '_', ' '), 'none')));
  perform public.chart_act('role_set_for', null, jsonb_build_object('role', p_role), null, null, p_person);
  return public.chart_done();
end $$;

create or replace function public.chart_theyve_gone(p_person text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare me public.chart_staff := public.chart_begin();
begin
  if not public.chart_is_sup() and not exists (
    select 1 from public.chart_cases c where c.status = 'open' and c.owner_id = p_person
      and (me.discord_id = any (c.worked_by) or exists (select 1 from public.chart_requests q where q.case_id = c.id and (q.asked_by = me.discord_id or q.accepted_by = me.discord_id)))) then
    perform public.chart_err('not_supervisor', 'Only the Supervisor, or someone on one of their patients, can do that.');
  end if;
  perform public.chart_hand_back_all(p_person, 'Nurse left', true);
  update public.chart_beds set owner_id = null, owner_since = null where owner_id = p_person;
  update public.chart_staff set ready = false, ready_since = null where discord_id = p_person;
  perform public.chart_act('theyve_gone', null, '{}', null, null, p_person);
  return public.chart_done();
end $$;

create or replace function public.chart_switches(p_reception_open boolean, p_online_mode text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform public.chart_begin(); perform public.chart_need_sup();
  if p_online_mode not in ('open', 'walk_ins_only') then perform public.chart_err('bad_input', 'Online check-in is open or walk-ins only.'); end if;
  update public.chart_ops set reception_open = p_reception_open, online_mode = p_online_mode, updated_by = public.my_discord_id(), updated_at = now() where id = 1;
  perform public.chart_act('switches', null, jsonb_build_object('reception_open', p_reception_open, 'online_mode', p_online_mode));
  return public.chart_done();
end $$;

create or replace function public.chart_phone_mode(p_on boolean) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare me public.chart_staff := public.chart_begin();
begin
  update public.chart_staff set phone_mode = p_on where discord_id = me.discord_id;
  return public.chart_done();
end $$;

-- ================= CASES =================
create or replace function public.chart_checkin(p_patient jsonb, p_source text, p_esi int default null, p_teams text[] default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare me public.chart_staff := public.chart_begin(); t text[]; nm text; rb text; age int; sym text[]; c_id bigint; st text; prev bigint; bd text; pain int; ons text;
begin
  if p_source not in ('desk', 'walk_in', 'npc', 'incoming') then perform public.chart_err('bad_input', 'Unknown check-in source.'); end if;
  if p_source = 'desk' and coalesce(me.role, '') not in ('reception', 'supervisor') then perform public.chart_err('wrong_role', 'The front desk checks patients in.'); end if;
  if p_source = 'walk_in' and (me.role is null or coalesce(me.role, '') = 'reception') then perform public.chart_err('wrong_role', 'Walk-ins are for Patient Care.'); end if;
  if p_source = 'npc' and me.role is distinct from 'room' then perform public.chart_err('wrong_role', 'NPC patients are logged by Patient Care: Room.'); end if;
  if p_source = 'npc' and public.chart_session_live() is not null then perform public.chart_err('npc_in_session', 'No NPC patients during a session.'); end if;
  if p_source = 'incoming' and coalesce(me.role, '') not in ('road', 'supervisor') then perform public.chart_err('wrong_role', 'Incoming cases come from the Road role.'); end if;
  if p_esi is not null and (p_esi < 1 or p_esi > 5) then perform public.chart_err('bad_input', 'The colour is 1 to 5.'); end if;
  nm := nullif(btrim(coalesce(p_patient->>'name', p_patient->>'roblox_username', '')), '');
  rb := nullif(btrim(coalesce(p_patient->>'roblox_username', '')), '');
  if nm is null then perform public.chart_err('bad_input', 'Give the patient''s name.'); end if;
  if char_length(nm) > 80 or char_length(coalesce(rb, '')) > 40 then perform public.chart_err('too_long', 'Keep the name shorter.'); end if;
  age := nullif(p_patient->>'age', '')::int;
  if age is not null and (age < 0 or age > 120) then perform public.chart_err('bad_input', 'Age is 0 to 120.'); end if;
  sym := public.chart_norm_symptoms(p_patient->'symptoms');
  pain := nullif(p_patient->>'pain', '')::int;
  if pain is not null and (pain < 1 or pain > 10) then perform public.chart_err('bad_input', 'Pain is 1 to 10.'); end if;
  ons := nullif(p_patient->>'onset', '');
  if ons is not null and ons not in ('just_now', 'today', 'days', 'longer') then perform public.chart_err('bad_input', 'Pick when it started.'); end if;
  if char_length(coalesce(p_patient->>'care_notes', '')) > 300 then perform public.chart_err('too_long', 'Keep the care notes under 300 characters.'); end if;
  t := public.chart_teams_ok(p_teams);
  st := case when p_source = 'incoming' then 'incoming' when p_source = 'npc' then 'in_care' when p_esi is null then 'checked_in' else 'waiting' end;
  if rb is not null then
    select x.id into prev from public.chart_cases x where lower(x.roblox_username) = lower(rb) and x.status = 'closed' and x.closed_at > now() - interval '3 hours'
    order by x.closed_at desc limit 1;
  end if;
  insert into public.chart_cases (patient_name, roblox_username, age, child, symptoms, complaint, allergies, past_history, arrival, esi, esi_by, esi_by_name,
                                  status, state, source, npc, team, extra_teams, colour_confirmed, queued_at, opened_by, opened_by_name, session_id, shift_id,
                                  eta_at, previous_case_id, pain, care_notes, onset, roblox_user_id, said)
  values (nm, rb, age, coalesce(age < 18, false), sym, nullif(left(array_to_string(sym, ', '), 120), ''), left(p_patient->>'allergies', 200), left(p_patient->>'past_history', 200),
          case when p_source = 'incoming' then 'ambulance' else 'walk_in' end,
          case when p_source = 'npc' then coalesce(p_esi, 4) else p_esi end, case when p_esi is not null then me.discord_id end,
          case when p_esi is not null then public.chart_short(me.discord_id) end,
          'open', st, p_source, p_source = 'npc', t[1], t[2:], p_esi is not null or p_source = 'npc', now(), me.discord_id, public.chart_short(me.discord_id),
          public.chart_session_live(), me.shift_id,
          case when p_source = 'incoming' then now() + make_interval(mins => coalesce(nullif(p_patient->>'eta_minutes', '')::int, 5)) end, prev,
          pain, left(nullif(btrim(coalesce(p_patient->>'care_notes', '')), ''), 300), ons, nullif(p_patient->>'roblox_user_id', '')::bigint,
          case when pain >= 7 then 'very_bad' when pain >= 4 then 'quite_bad' when pain >= 1 then 'a_little' end)
  returning id into c_id;
  if p_source = 'npc' then
    bd := p_patient->>'bed';
    if bd is null then perform public.chart_err('bad_beds', 'Pick your bed for the NPC.'); end if;
    perform public.chart_place_check(c_id, bd, me.discord_id, 'place', false);
    update public.chart_cases set bed_id = bd, owner_id = me.discord_id, with_patient_at = now(), called_at = now(),
           cared_for = array[me.discord_id], team = coalesce(nullif(t[1], 'Any'), me.department) where id = c_id;
    perform public.chart_worked(c_id, me.discord_id);
  end if;
  if p_source = 'incoming' and nullif(btrim(coalesce(p_patient->>'note', '')), '') is not null then
    insert into public.chart_entries (case_id, kind, department, data, author, author_name)
    values (c_id, 'handoff', coalesce(me.department, 'Paramedicine'), jsonb_build_object('text', left(p_patient->>'note', 500)), me.discord_id, public.chart_short(me.discord_id));
  end if;
  perform public.chart_act('checkin', c_id, jsonb_build_object('source', p_source, 'esi', p_esi, 'teams', to_jsonb(t)));
  if p_esi is not null then perform public.chart_act('colour', c_id, jsonb_build_object('from', null, 'to', p_esi, 'confirm', true)); end if;
  return public.chart_done(jsonb_build_object('case_id', c_id));
end $$;

-- Who may run the front desk for this action: Reception, a Supervisor, or anyone in Patient Care when no Reception is on.
create or replace function public.chart_is_desk(me public.chart_staff) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(coalesce(me.role, '') in ('reception', 'supervisor')
      or (me.role is not null and not exists (select 1 from public.chart_staff x where x.role = 'reception')), false)
$$;

create or replace function public.chart_confirm_online(p_case bigint, p_esi int, p_teams text[], p_child boolean) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare me public.chart_staff := public.chart_begin(); c public.chart_cases := public.chart_case_row(p_case); t text[] := public.chart_teams_ok(p_teams);
begin
  if not public.chart_is_desk(me) then perform public.chart_err('wrong_role', 'The front desk confirms online check-ins.'); end if;
  if c.state <> 'checked_in' or c.source <> 'online' then perform public.chart_err('bad_state', 'That check-in was already handled.'); end if;
  if p_esi is null or p_esi < 1 or p_esi > 5 then perform public.chart_err('bad_input', 'Pick a colour.'); end if;
  update public.chart_cases set esi = p_esi, esi_by = me.discord_id, esi_by_name = public.chart_short(me.discord_id), colour_confirmed = true,
         team = t[1], extra_teams = t[2:], child = coalesce(p_child, false), state = 'waiting', queued_at = now(),
         online_confirmed_at = now(), online_confirmed_by = me.discord_id, last_at = now()
  where id = c.id;
  perform public.chart_act('confirm_online', c.id, jsonb_build_object('esi', p_esi, 'teams', to_jsonb(t), 'child', p_child));
  perform public.chart_act('colour', c.id, jsonb_build_object('from', c.esi, 'to', p_esi, 'confirm', true));
  return public.chart_done();
end $$;

create or replace function public.chart_reject_online(p_case bigint, p_reason text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare me public.chart_staff := public.chart_begin(); c public.chart_cases := public.chart_case_row(p_case);
begin
  if not public.chart_is_desk(me) then perform public.chart_err('wrong_role', 'The front desk handles online check-ins.'); end if;
  if c.state <> 'checked_in' then perform public.chart_err('bad_state', 'That check-in was already handled.'); end if;
  update public.chart_cases set status = 'void', state = 'left_before_seen', void_reason = coalesce(left(nullif(btrim(p_reason), ''), 200), 'Not a real check-in'),
         closed_at = now(), closed_by = me.discord_id, visit_expires_at = now() + interval '24 hours' where id = c.id;
  perform public.chart_act('reject_online', c.id, jsonb_build_object('reason', p_reason));
  return public.chart_done();
end $$;

create or replace function public.chart_colour(p_case bigint, p_esi int, p_confirm boolean default false, p_reason text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare me public.chart_staff := public.chart_begin(); c public.chart_cases := public.chart_case_row(p_case);
begin
  if c.status <> 'open' then perform public.chart_err('bad_state', 'That visit has ended.'); end if;
  if not (public.chart_is_desk(me) or c.owner_id is not distinct from me.discord_id) then perform public.chart_err('wrong_role', 'Only the desk, the patient''s nurse or the Supervisor can change the colour.'); end if;
  if p_esi is null or p_esi < 1 or p_esi > 5 then perform public.chart_err('bad_input', 'Pick a colour.'); end if;
  update public.chart_cases set esi = p_esi, esi_by = me.discord_id, esi_by_name = public.chart_short(me.discord_id),
         colour_confirmed = colour_confirmed or p_confirm,
         state = case when state = 'checked_in' and source <> 'online' and p_confirm then 'waiting' else state end,
         queued_at = case when state = 'checked_in' and source <> 'online' and p_confirm then now() else queued_at end, last_at = now()
  where id = c.id;
  perform public.chart_act('colour', c.id, jsonb_build_object('from', c.esi, 'to', p_esi, 'confirm', p_confirm, 'reason', p_reason));
  return public.chart_done();
end $$;

create or replace function public.chart_set_team(p_case bigint, p_teams text[]) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare me public.chart_staff := public.chart_begin(); c public.chart_cases := public.chart_case_row(p_case); t text[] := public.chart_teams_ok(p_teams);
begin
  if not public.chart_is_desk(me) then perform public.chart_err('wrong_role', 'Only the desk or the Supervisor can change the team.'); end if;
  update public.chart_cases set team = t[1], extra_teams = t[2:], last_at = now() where id = c.id;
  perform public.chart_act('set_team', c.id, jsonb_build_object('from', c.team, 'to', t[1], 'extra', to_jsonb(t[2:])));
  return public.chart_done();
end $$;

create or replace function public.chart_handover(p_case bigint, p_note text, p_vitals jsonb default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare me public.chart_staff := public.chart_begin(); c public.chart_cases := public.chart_case_row(p_case);
begin
  if coalesce(me.role, '') not in ('road', 'supervisor') then perform public.chart_err('wrong_role', 'Handover is for the Road role.'); end if;
  if c.state <> 'incoming' then perform public.chart_err('bad_state', 'Already handed over.'); end if;
  update public.chart_cases set state = case when esi is null then 'checked_in' else 'waiting' end, queued_at = now(), last_at = now() where id = c.id;
  if nullif(btrim(coalesce(p_note, '')), '') is not null then
    insert into public.chart_entries (case_id, kind, department, data, author, author_name)
    values (c.id, 'handoff', coalesce(me.department, 'Paramedicine'), jsonb_build_object('text', left(p_note, 500)), me.discord_id, public.chart_short(me.discord_id));
  end if;
  if p_vitals is not null and jsonb_typeof(p_vitals) = 'object' then
    insert into public.chart_entries (case_id, kind, department, data, author, author_name)
    values (c.id, 'vitals', coalesce(me.department, 'Paramedicine'), p_vitals, me.discord_id, public.chart_short(me.discord_id));
  end if;
  perform public.chart_worked(c.id, me.discord_id);
  perform public.chart_act('handover', c.id);
  return public.chart_done();
end $$;

create or replace function public.chart_assign(p_case bigint, p_bed text, p_person text default null, p_override boolean default false) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare c public.chart_cases; who text; b public.chart_beds; e text; mism boolean;
begin
  perform public.chart_begin(); perform public.chart_need_sup();
  c := public.chart_case_row(p_case);
  if c.status <> 'open' or c.state not in ('waiting', 'waiting_in_room') then perform public.chart_err('bad_state', 'That patient has moved on: refresh.'); end if;
  if not c.colour_confirmed then perform public.chart_err('bad_state', 'Confirm the colour first.'); end if;
  select * into b from public.chart_beds x where x.id = p_bed;
  if b.id is null then perform public.chart_err('bad_beds', 'That bed doesn''t exist.'); end if;
  who := coalesce(p_person, b.owner_id);
  if who is null then perform public.chart_err('not_bed_owner', format('Nobody holds %s: pick who.', b.label)); end if;
  perform public.chart_place_check(c.id, b.id, who, 'place', p_override);
  if b.owner_id is null then
    e := public.chart_own_ok(who, array[b.id]);
    if e is not null then perform public.chart_err(split_part(e, '|', 1), substr(e, strpos(e, '|') + 1)); end if;
  end if;
  mism := c.team is not null and c.team <> 'Any' and c.team is distinct from (select s.department from public.chart_staff s where s.discord_id = who);
  perform public.chart_do_assign(c.id, b.id, who);
  perform public.chart_act(case when mism then 'assign_override' else 'assign' end, c.id, jsonb_build_object('bed', b.id, 'person', who, 'team', c.team), b.room_id, null, who);
  perform public.chart_notice(who, format('%s gave you %s in %s: press Got it.', public.chart_short(public.my_discord_id()), public.checkin_short_name(c.patient_name), b.label));
  return public.chart_done();
end $$;

create or replace function public.chart_got_it(p_case bigint) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare me public.chart_staff := public.chart_begin(); c public.chart_cases := public.chart_case_row(p_case);
begin
  if c.state <> 'assigned' or c.owner_id is distinct from me.discord_id then perform public.chart_err('bad_state', 'That patient has moved on.'); end if;
  perform public.chart_place_check(c.id, c.bed_id, me.discord_id, 'place', true);   -- the room may have changed during the 60 s
  update public.chart_cases set state = 'called', called_at = now(), assign_expires_at = null, last_at = now() where id = c.id;
  perform public.chart_act('got_it', c.id);
  return public.chart_done();
end $$;

create or replace function public.chart_with_patient(p_case bigint) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare me public.chart_staff := public.chart_begin(); c public.chart_cases := public.chart_case_row(p_case);
begin
  if c.state <> 'called' or c.owner_id is distinct from me.discord_id then perform public.chart_err('bad_state', 'That patient has moved on.'); end if;
  update public.chart_cases set state = 'in_care', with_patient_at = now(), priority = 0, prioritised = false, last_at = now(),
         cared_for = case when me.discord_id = any (cared_for) then cared_for else cared_for || me.discord_id end
  where id = c.id;
  perform public.chart_worked(c.id, me.discord_id);
  perform public.chart_act('with_patient', c.id);
  return public.chart_done();
end $$;

create or replace function public.chart_called_out(p_case bigint, p_undo boolean default false) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare me public.chart_staff := public.chart_begin(); c public.chart_cases := public.chart_case_row(p_case);
begin
  if not (public.chart_is_desk(me) or c.owner_id is not distinct from me.discord_id) then perform public.chart_err('wrong_role', 'The front desk calls patients in.'); end if;
  if c.state not in ('assigned', 'called') then perform public.chart_err('bad_state', 'That patient isn''t being called.'); end if;
  update public.chart_cases set called_out_at = case when p_undo then null else now() end where id = c.id;
  perform public.chart_act(case when p_undo then 'called_out_undo' else 'called_out' end, c.id);
  return public.chart_done();
end $$;

create or replace function public.chart_prioritise(p_case bigint, p_on boolean) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare me public.chart_staff := public.chart_begin(); c public.chart_cases := public.chart_case_row(p_case);
begin
  if coalesce(me.role, '') not in ('reception', 'supervisor') then perform public.chart_err('wrong_role', 'Only the desk or the Supervisor can prioritise.'); end if;
  update public.chart_cases set prioritised = p_on where id = c.id;
  perform public.chart_act('prioritise', c.id, jsonb_build_object('on', p_on));
  return public.chart_done();
end $$;

create or replace function public.chart_no_show(p_case bigint) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare me public.chart_staff := public.chart_begin(); c public.chart_cases := public.chart_case_row(p_case);
begin
  if not (public.chart_is_desk(me) or c.owner_id is not distinct from me.discord_id) then perform public.chart_err('wrong_role', 'Only the desk, the nurse or the Supervisor can mark a no show.'); end if;
  if c.state <> 'called' then perform public.chart_err('bad_state', 'They aren''t being called.'); end if;
  if c.called_at > now() - interval '5 minutes' then perform public.chart_err('too_soon', 'Give them 5 minutes to arrive.'); end if;
  if c.no_show_count >= 1 then
    perform public.chart_close_case(c.id, 'left_before_seen', 'left_before_seen');
  else
    perform public.chart_requeue(c.id, false);
  end if;
  update public.chart_cases set no_show_count = no_show_count + 1 where id = c.id;
  perform public.chart_act('no_show', c.id, jsonb_build_object('count', c.no_show_count + 1));
  return public.chart_done();
end $$;

create or replace function public.chart_hand_back(p_case bigint, p_note text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare me public.chart_staff := public.chart_begin(); c public.chart_cases := public.chart_case_row(p_case); note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if c.owner_id is distinct from me.discord_id or c.state not in ('assigned', 'called', 'in_care') then perform public.chart_err('bad_state', 'That isn''t your patient now.'); end if;
  if note is null then perform public.chart_err('bad_input', 'Add a hand-back note.'); end if;
  update public.chart_cases set state = case when bed_id is not null then 'waiting_in_room' else 'waiting' end, owner_id = null, priority = 1,
         handback_note = left(note, 300), handback_count = handback_count + 1, assign_expires_at = null, assign_from = null, last_at = now(),
         flag_supervisor = flag_supervisor or handback_count + 1 >= 3,
         prioritised = prioritised or (handback_count + 1 >= 3 and not public.chart_supervised())
  where id = c.id;
  perform public.chart_act('hand_back', c.id, jsonb_build_object('note', note, 'count', c.handback_count + 1));
  return public.chart_done();
end $$;

create or replace function public.chart_move(p_case bigint, p_bed text, p_override boolean default false) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare c public.chart_cases; b public.chart_beds; who text; e text;
begin
  perform public.chart_begin(); perform public.chart_need_sup();
  c := public.chart_case_row(p_case);
  if c.status <> 'open' or c.state not in ('waiting_in_room', 'assigned', 'called', 'in_care') then perform public.chart_err('bad_state', 'Only a patient in a bed can be moved.'); end if;
  select * into b from public.chart_beds x where x.id = p_bed;
  if b.id is null then perform public.chart_err('bad_beds', 'That bed doesn''t exist.'); end if;
  who := coalesce(b.owner_id, c.owner_id);
  perform public.chart_place_check(c.id, b.id, who, 'place', p_override);
  if who is not null and b.owner_id is null then
    e := public.chart_own_ok(who, array[b.id]);
    if e is not null then perform public.chart_err(split_part(e, '|', 1), substr(e, strpos(e, '|') + 1)); end if;
    update public.chart_beds set owner_id = who, owner_since = now() where id = b.id;
  end if;
  update public.chart_cases set bed_id = b.id, last_at = now() where id = c.id;
  if who is not null and who is distinct from c.owner_id then
    update public.chart_cases set state = 'assigned', assign_from = 'waiting_in_room', owner_id = who, assigned_at = now(),
           assign_expires_at = now() + interval '60 seconds' where id = c.id;
    perform public.chart_notice(who, format('%s moved %s to you in %s: press Got it.', public.chart_short(public.my_discord_id()), public.checkin_short_name(c.patient_name), b.label));
    if c.owner_id is not null then perform public.chart_notice(c.owner_id, format('%s moved %s to %s.', public.chart_short(public.my_discord_id()), public.checkin_short_name(c.patient_name), public.chart_pname(who))); end if;
  end if;
  perform public.chart_act('move', c.id, jsonb_build_object('from_bed', c.bed_id, 'to_bed', b.id, 'from_owner', c.owner_id, 'to_owner', who), b.room_id);
  return public.chart_done();
end $$;

create or replace function public.chart_swap(p_case_a bigint, p_case_b bigint, p_override boolean default false) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare a public.chart_cases; b public.chart_cases; oa text; ob text;
begin
  perform public.chart_begin(); perform public.chart_need_sup();
  a := public.chart_case_row(p_case_a); b := public.chart_case_row(p_case_b);
  if a.bed_id is null or b.bed_id is null or a.status <> 'open' or b.status <> 'open' then perform public.chart_err('bad_state', 'Both patients need a bed to swap.'); end if;
  oa := (select x.owner_id from public.chart_beds x where x.id = a.bed_id); ob := (select x.owner_id from public.chart_beds x where x.id = b.bed_id);
  perform public.chart_place_check(a.id, b.bed_id, ob, 'swap', p_override);
  perform public.chart_place_check(b.id, a.bed_id, oa, 'swap', p_override);
  update public.chart_cases set bed_id = null where id = a.id;
  update public.chart_cases set bed_id = a.bed_id, owner_id = case when owner_id is not null then oa end where id = b.id;
  update public.chart_cases set bed_id = b.bed_id, owner_id = case when a.owner_id is not null then ob end where id = a.id;
  perform public.chart_act('swap', a.id, jsonb_build_object('a', a.id, 'b', b.id, 'a_bed', b.bed_id, 'b_bed', a.bed_id));
  return public.chart_done();
end $$;

create or replace function public.chart_transfer(p_case bigint, p_to text, p_off_ward text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare me public.chart_staff := public.chart_begin(); c public.chart_cases := public.chart_case_row(p_case);
begin
  if coalesce(me.role, '') not in ('on_call', 'supervisor') then perform public.chart_err('wrong_role', 'Transfers are for On call or the Supervisor.'); end if;
  if c.status <> 'open' or c.state <> 'in_care' then perform public.chart_err('bad_state', 'Only a patient being treated can be transferred.'); end if;
  if (public.chart_shift_of(p_to)).id is null then perform public.chart_err('not_on_shift', format('%s isn''t on shift.', public.chart_pname(p_to))); end if;
  update public.chart_cases set owner_id = p_to, bed_id = null, off_ward = left(coalesce(p_off_ward, 'Pre-Op'), 40), last_at = now(),
         cared_for = case when p_to = any (cared_for) then cared_for else cared_for || p_to end where id = c.id;
  perform public.chart_worked(c.id, p_to);
  if c.owner_id is not null and c.owner_id <> p_to then perform public.chart_notice(c.owner_id, format('%s took %s to %s.', public.chart_pname(p_to), public.checkin_short_name(c.patient_name), coalesce(p_off_ward, 'Pre-Op'))); end if;
  perform public.chart_act('transfer', c.id, jsonb_build_object('to', p_to, 'off_ward', p_off_ward));
  return public.chart_done();
end $$;

create or replace function public.chart_off_ward(p_case bigint, p_place text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare me public.chart_staff := public.chart_begin(); c public.chart_cases := public.chart_case_row(p_case);
begin
  if c.owner_id is distinct from me.discord_id and not public.chart_is_sup() then perform public.chart_err('no_access', 'That isn''t your patient.'); end if;
  update public.chart_cases set off_ward = left(nullif(btrim(coalesce(p_place, '')), ''), 40) where id = c.id;
  perform public.chart_act('off_ward', c.id, jsonb_build_object('place', p_place));
  return public.chart_done();
end $$;

create or replace function public.chart_code(p_case bigint) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare me public.chart_staff := public.chart_begin(); c public.chart_cases := public.chart_case_row(p_case);
begin
  if c.status <> 'open' then perform public.chart_err('bad_state', 'That visit has ended.'); end if;
  update public.chart_cases set code_at = now(), code_by = public.chart_short(me.discord_id) where id = c.id;
  insert into public.chart_requests (case_id, kind, red, asked_by) values (c.id, 'code', true, me.discord_id) on conflict do nothing;
  perform public.chart_act('code', c.id);
  return public.chart_done();
end $$;

create or replace function public.chart_code_clear(p_case bigint) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare me public.chart_staff := public.chart_begin(); c public.chart_cases := public.chart_case_row(p_case);
begin
  if c.owner_id is distinct from me.discord_id and not public.chart_is_sup() then perform public.chart_err('no_access', 'Only the patient''s nurse or the Supervisor can clear a Code.'); end if;
  update public.chart_cases set code_at = null, code_by = null where id = c.id;
  update public.chart_requests set done_at = now(), done_note = 'Cleared' where case_id = c.id and kind = 'code' and done_at is null and cancelled_at is null;
  perform public.chart_act('code_clear', c.id);
  return public.chart_done();
end $$;

create or replace function public.chart_discharge(p_case bigint, p_outcome text, p_follow_up text default null, p_advice text default null,
                                                  p_admitted_to text default null, p_forced boolean default false) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare me public.chart_staff := public.chart_begin(); c public.chart_cases := public.chart_case_row(p_case);
begin
  if c.status <> 'open' or c.state not in ('called', 'in_care') then perform public.chart_err('bad_state', 'Only a patient being treated can be discharged.'); end if;
  if c.owner_id is distinct from me.discord_id and not public.chart_is_sup() then perform public.chart_err('no_access', 'Only the patient''s nurse or the Supervisor can discharge.'); end if;
  if p_outcome not in ('home', 'follow_up', 'admitted', 'transferred') then perform public.chart_err('bad_input', 'Pick an outcome.'); end if;
  if p_outcome = 'admitted' and nullif(btrim(coalesce(p_admitted_to, '')), '') is null then perform public.chart_err('bad_input', 'Say where they were admitted to.'); end if;
  if char_length(coalesce(p_follow_up, '')) > 500 or char_length(coalesce(p_advice, '')) > 500 then perform public.chart_err('too_long', 'Keep it under 500 characters.'); end if;
  if not p_forced and (not c.colour_confirmed or not exists (select 1 from public.chart_entries e where e.case_id = c.id and e.kind in ('intervention', 'note') and e.error_at is null)) then
    perform public.chart_err('min_record', 'Confirm the colour and add at least one thing you did or a note first.');
  end if;
  update public.chart_cases set follow_up = coalesce(nullif(btrim(p_follow_up), ''), follow_up), advice = coalesce(nullif(btrim(p_advice), ''), advice),
         admitted_to = left(nullif(btrim(coalesce(p_admitted_to, '')), ''), 80), discharged_at = now(), discharged_by = me.discord_id where id = c.id;
  perform public.chart_worked(c.id, me.discord_id);
  perform public.chart_close_case(c.id, 'discharged', p_outcome);
  if p_forced then perform public.chart_act('discharge_forced', c.id); end if;
  perform public.chart_act('discharge', c.id, jsonb_build_object('outcome', p_outcome));
  return public.chart_done();
end $$;

create or replace function public.chart_left(p_case bigint, p_kind text, p_note text default null, p_time_of_death timestamptz default null,
                                             p_confirmed_by text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare me public.chart_staff := public.chart_begin(); c public.chart_cases := public.chart_case_row(p_case); note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if c.status <> 'open' then perform public.chart_err('bad_state', 'That visit has ended.'); end if;
  if p_kind not in ('left_before_seen', 'left_during_care', 'died') then perform public.chart_err('bad_input', 'Pick how they left.'); end if;
  if p_kind = 'died' and c.owner_id is distinct from me.discord_id and not public.chart_is_sup() then perform public.chart_err('no_access', 'Only the patient''s nurse or the Supervisor can record a death.'); end if;
  if p_kind <> 'died' and not (public.chart_is_desk(me) or c.owner_id is not distinct from me.discord_id) then perform public.chart_err('no_access', 'Only the desk, the nurse or the Supervisor can do that.'); end if;
  if p_kind in ('left_during_care', 'died') and note is null then perform public.chart_err('bad_input', 'Add a note.'); end if;
  if p_kind = 'died' and (p_time_of_death is null or nullif(btrim(coalesce(p_confirmed_by, '')), '') is null) then
    perform public.chart_err('bad_input', 'Add the time of death and who confirmed it.');
  end if;
  update public.chart_cases set left_note = left(note, 500), time_of_death = p_time_of_death, death_confirmed_by = left(nullif(btrim(coalesce(p_confirmed_by, '')), ''), 80) where id = c.id;
  perform public.chart_close_case(c.id, p_kind, p_kind);
  perform public.chart_act('left', c.id, jsonb_build_object('kind', p_kind));
  return public.chart_done();
end $$;

create or replace function public.chart_aftercare(p_case bigint, p_follow_up text default null, p_papers boolean default false,
                                                  p_rating int default null, p_comment text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare me public.chart_staff := public.chart_begin(); c public.chart_cases := public.chart_case_row(p_case);
begin
  if not public.chart_is_desk(me) and not (me.discord_id = any (c.worked_by)) then perform public.chart_err('wrong_role', 'After-care is done at the desk.'); end if;
  if c.state <> 'discharged' then perform public.chart_err('bad_state', 'After-care is for discharged patients.'); end if;
  if p_rating is not null then
    if c.rating is not null then
      perform public.chart_err('already_rated', case when c.rating_source = 'patient' then 'The patient already rated this visit.' else 'A rating was already entered.' end);
    end if;
    if p_rating < 1 or p_rating > 5 then perform public.chart_err('bad_input', 'Pick 1 to 5 stars.'); end if;
  end if;
  update public.chart_cases set follow_up = coalesce(left(nullif(btrim(p_follow_up), ''), 500), follow_up), papers = papers or coalesce(p_papers, false),
         aftercare_at = now(), aftercare_by = me.discord_id,
         rating = coalesce(rating, p_rating), rating_comment = case when rating is null and p_rating is not null then left(nullif(btrim(p_comment), ''), 500) else rating_comment end,
         rated_at = case when rating is null and p_rating is not null then now() else rated_at end,
         rating_by = case when rating is null and p_rating is not null then me.discord_id else rating_by end,
         rating_source = case when rating is null and p_rating is not null then 'reception' else rating_source end
  where id = c.id;
  perform public.chart_act('aftercare', c.id, jsonb_build_object('papers', p_papers, 'rating', p_rating));
  return public.chart_done();
end $$;

create or replace function public.chart_case_void(p_case bigint, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare c public.chart_cases; why text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  perform public.chart_begin(); perform public.chart_need_sup();
  c := public.chart_case_row(p_case);
  if why is null then perform public.chart_err('reason_needed', 'Say why it''s void.'); end if;
  update public.chart_requests set cancelled_at = now(), cancelled_by = public.my_discord_id(), cancel_reason = 'Void' where case_id = c.id and done_at is null and cancelled_at is null;
  update public.chart_cases set status = 'void', void_reason = left(why, 200), bed_id = null, owner_id = null, closed_at = now(), closed_by = public.my_discord_id(),
         visit_expires_at = now() where id = c.id;
  perform public.chart_act('void', c.id, jsonb_build_object('reason', why));
  return public.chart_done();
end $$;

create or replace function public.chart_session_end(p_close_all boolean default false) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare me public.chart_staff := public.chart_begin(); ids bigint[]; x bigint;
begin
  if not public.chart_is_sup() and (select count(*) from public.shifts s where s.status <> 'ended') > 1 then
    perform public.chart_err('not_supervisor', 'Only the Supervisor, or the last person on shift, can end the session.');
  end if;
  select coalesce(array_agg(c.id order by c.id), '{}') into ids from public.chart_cases c where c.status = 'open' and c.state is not null;
  if p_close_all then
    foreach x in array ids loop perform public.chart_close_case(x, 'session_ended', 'session_ended'); end loop;
    update public.chart_requests set cancelled_at = now(), cancel_reason = 'Session ended' where done_at is null and cancelled_at is null;
    perform public.chart_act('session_end', null, jsonb_build_object('closed', cardinality(ids)));
  end if;
  return public.chart_done(jsonb_build_object('open', to_jsonb(ids)));
end $$;

create or replace function public.chart_case_update(p_case bigint, p_changes jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare me public.chart_staff := public.chart_begin(); c public.chart_cases := public.chart_case_row(p_case); k text;
begin
  if c.status <> 'open' then perform public.chart_err('bad_state', 'That visit has ended.'); end if;
  if not (public.chart_is_desk(me) or c.owner_id is not distinct from me.discord_id or me.discord_id = any (c.worked_by)) then perform public.chart_err('no_access', 'That isn''t your patient.'); end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' then perform public.chart_err('bad_input', 'Nothing to change.'); end if;
  for k in select jsonb_object_keys(p_changes) loop
    if k not in ('name', 'roblox_username', 'age', 'allergies', 'nkda', 'past_history', 'last_intake', 'onset', 'symptoms') then
      perform public.chart_err('bad_input', format('Can''t change "%s".', k));
    end if;
  end loop;
  update public.chart_cases set
    patient_name = case when p_changes ? 'name' then coalesce(left(nullif(btrim(p_changes->>'name'), ''), 80), patient_name) else patient_name end,
    roblox_username = case when p_changes ? 'roblox_username' then left(nullif(btrim(p_changes->>'roblox_username'), ''), 40) else roblox_username end,
    age = case when p_changes ? 'age' then nullif(p_changes->>'age', '')::int else age end,
    child = case when p_changes ? 'age' and nullif(p_changes->>'age', '') is not null then (p_changes->>'age')::int < 18 else child end,
    allergies = case when p_changes ? 'allergies' then left(nullif(btrim(p_changes->>'allergies'), ''), 200) else allergies end,
    nkda = case when p_changes ? 'nkda' then (p_changes->>'nkda')::boolean else nkda end,
    past_history = case when p_changes ? 'past_history' then left(nullif(btrim(p_changes->>'past_history'), ''), 200) else past_history end,
    last_intake = case when p_changes ? 'last_intake' then left(nullif(btrim(p_changes->>'last_intake'), ''), 200) else last_intake end,
    onset = case when p_changes ? 'onset' then left(nullif(btrim(p_changes->>'onset'), ''), 200) else onset end,
    symptoms = case when p_changes ? 'symptoms' then public.chart_norm_symptoms(p_changes->'symptoms') else symptoms end,
    last_at = now()
  where id = c.id;
  perform public.chart_act('case_update', c.id, jsonb_build_object('fields', (select jsonb_agg(x) from jsonb_object_keys(p_changes) x)));
  return public.chart_done();
end $$;

-- The launch switch (dark ship): only the owners (Hospital Director, COO) can flip it.
create or replace function public.chart_launch(p_on boolean) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform public.chart_lock();
  if not public.is_exec() then perform public.chart_err('not_supervisor', 'Only the Hospital Director or the COO can launch the Chart.'); end if;
  update public.chart_ops set launched = p_on, launched_by = public.my_discord_id(), launched_at = now() where id = 1;
  insert into public.chart_log (actor, actor_name, action, detail) values (public.my_discord_id(), public.chart_short(public.my_discord_id()), 'launch', jsonb_build_object('on', p_on));
  return jsonb_build_object('ok', true, 'rev', public.chart_bump(), 'launched', p_on);
end $$;

-- ---------- grants: internal helpers for nobody; RPCs for logged-in users ----------
do $$
declare f record;
begin
  for f in select p.oid::regprocedure::text sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in (
             'chart_err', 'chart_lock', 'chart_pname', 'chart_short', 'chart_bump', 'chart_rev', 'chart_act', 'chart_shift_of', 'chart_person_depts',
             'chart_session_live', 'chart_can_supervise', 'chart_supervised', 'chart_is_sup', 'chart_load', 'chart_on_break', 'chart_whoami', 'chart_touch',
             'chart_notice', 'chart_need_sup', 'chart_case_row', 'chart_teams_ok', 'chart_place_ok', 'chart_place_check', 'chart_own_ok', 'chart_bed_guard',
             'chart_owner_guard', 'chart_room_guard', 'chart_do_assign', 'chart_requeue', 'chart_close_case', 'chart_worked', 'chart_auto_assign', 'chart_tick',
             'chart_done', 'chart_begin', 'chart_hand_back_all', 'chart_is_desk',
             'chart_role_set', 'chart_ready', 'chart_stay_ready', 'chart_take_beds', 'chart_leave_beds', 'chart_offer_take', 'chart_room_set', 'chart_bed_set',
             'chart_room_problem', 'chart_room_problem_clear', 'chart_give_room', 'chart_set_role_for', 'chart_theyve_gone', 'chart_switches', 'chart_phone_mode',
             'chart_checkin', 'chart_confirm_online', 'chart_reject_online', 'chart_colour', 'chart_set_team', 'chart_handover', 'chart_assign', 'chart_got_it',
             'chart_with_patient', 'chart_called_out', 'chart_prioritise', 'chart_no_show', 'chart_hand_back', 'chart_move', 'chart_swap', 'chart_transfer',
             'chart_off_ward', 'chart_code', 'chart_code_clear', 'chart_discharge', 'chart_left', 'chart_aftercare', 'chart_case_void', 'chart_session_end',
             'chart_case_update', 'chart_launch') loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
    if f.proname in ('chart_role_set', 'chart_ready', 'chart_stay_ready', 'chart_take_beds', 'chart_leave_beds', 'chart_offer_take', 'chart_room_set', 'chart_bed_set',
             'chart_room_problem', 'chart_room_problem_clear', 'chart_give_room', 'chart_set_role_for', 'chart_theyve_gone', 'chart_switches', 'chart_phone_mode',
             'chart_checkin', 'chart_confirm_online', 'chart_reject_online', 'chart_colour', 'chart_set_team', 'chart_handover', 'chart_assign', 'chart_got_it',
             'chart_with_patient', 'chart_called_out', 'chart_prioritise', 'chart_no_show', 'chart_hand_back', 'chart_move', 'chart_swap', 'chart_transfer',
             'chart_off_ward', 'chart_code', 'chart_code_clear', 'chart_discharge', 'chart_left', 'chart_aftercare', 'chart_case_void', 'chart_session_end',
             'chart_case_update', 'chart_launch') then
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end $$;
