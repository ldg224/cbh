-- 0069: CBH Check-in (Alpha). Owner, 18 Nov 2026: the Chart is for live (player) patients only and EVERY case starts here.
-- Patients check in from Discord (bot, service role) or the website while a session is live (character name, age, Roblox
-- username, symptoms; optional pain, onset, allergies, history, last oral intake); staff take them from a queue, which turns
-- the check-in into an open CBH Chart case. Contract: Plans/CareBeyond/chart/CHART-V2-CONTRACT.md. Additive. Needs 0067/0068.

alter table public.chart_cases drop constraint if exists chart_cases_status_check;
alter table public.chart_cases add constraint chart_cases_status_check check (status in ('waiting', 'open', 'closed', 'void'));
alter table public.chart_cases drop constraint if exists chart_cases_arrival_check;
alter table public.chart_cases add constraint chart_cases_arrival_check check (arrival in ('walk_in', 'ambulance', 'helicopter', 'self_checkin'));
alter table public.chart_cases drop constraint if exists chart_cases_disposition_check;
alter table public.chart_cases add constraint chart_cases_disposition_check check (disposition in ('discharged', 'admitted', 'or', 'transferred', 'deceased', 'ama', 'lwbs'));

alter table public.chart_cases add column if not exists cared_for text[] not null default '{}';
alter table public.chart_cases add column if not exists checkin_confirmed text[] not null default '{}';

create table if not exists public.chart_checkins (
  id               bigint generated always as identity primary key,
  case_id          bigint not null unique references public.chart_cases (id) on delete cascade,
  discord_id       text not null,
  roblox_name      text not null check (char_length(roblox_name) between 1 and 40),
  pain             smallint check (pain between 0 and 10),
  source           text not null default 'website' check (source in ('website', 'discord_button', 'discord_form')),
  state            text not null default 'waiting' check (state in ('waiting', 'claimed', 'in_room', 'discharged', 'left', 'cancelled')),
  session_id       bigint,
  created_at       timestamptz not null default now(),
  claimed_by       text,
  claimed_by_name  text,
  claimed_at       timestamptz,
  room             text,
  in_room_at       timestamptz,
  ended_at         timestamptz,
  ended_reason     text,
  staff_message_id text,
  rating           smallint check (rating between 1 and 5),
  comment          text check (comment is null or char_length(comment) <= 500),
  rated_at         timestamptz,
  answers          jsonb not null default '{}'::jsonb   -- what the patient said at check-in (staff confirm or correct it on the case)
);
create unique index if not exists chart_checkins_one_active on public.chart_checkins (discord_id) where state in ('waiting', 'claimed', 'in_room');
create index if not exists chart_checkins_who on public.chart_checkins (discord_id, created_at desc);
create index if not exists chart_checkins_state on public.chart_checkins (state, created_at);

create table if not exists public.checkin_notices (
  id          bigint generated always as identity primary key,
  checkin_id  bigint not null references public.chart_checkins (id) on delete cascade,
  discord_id  text not null,
  kind        text not null check (kind in ('queued', 'position', 'claimed', 'in_room', 'discharged', 'left')),
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  claimed_at  timestamptz,
  sent_at     timestamptz,
  error       text
);
create unique index if not exists checkin_notices_once on public.checkin_notices (checkin_id, kind, coalesce(detail->>'position', ''));
create index if not exists checkin_notices_unsent on public.checkin_notices (id) where sent_at is null and error is null;

-- Patients see their own check-in; staff (Chart readers) see all. Notices: service role only.
alter table public.chart_checkins enable row level security;
alter table public.checkin_notices enable row level security;
revoke all on public.chart_checkins, public.checkin_notices from anon, authenticated;
grant select on public.chart_checkins to authenticated;
drop policy if exists chart_checkins_read on public.chart_checkins;
create policy chart_checkins_read on public.chart_checkins for select to authenticated using (discord_id = public.my_discord_id() or public.chart_can_read());

-- ---------- helpers (private) ----------
-- The bot calls with the service role and names the person; everyone else acts as themselves.
create or replace function public.chart_is_service()
returns boolean language sql stable set search_path = '' as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role', '') = 'service_role'
$$;
create or replace function public.chart_actor(p text)
returns text language sql stable security definer set search_path = '' as $$
  select case when public.chart_is_service() then nullif(btrim(coalesce(p, '')), '') else public.my_discord_id() end
$$;
create or replace function public.checkin_live_session()
returns bigint language sql stable security definer set search_path = '' as $$
  select x.id from public.sessions x where x.status = 'live' order by x.started_at desc nulls last limit 1
$$;
-- A staff member's open shift in a clinical department (the rule for taking patients, from the bot or the website).
create or replace function public.checkin_staff_shift(who text)
returns table (shift_id bigint, department text, started_at timestamptz) language sql stable security definer set search_path = '' as $$
  select s.id, s.department, s.started_at from public.shifts s join public.departments d on d.name = s.department and d.clinical
  where s.discord_id = who and s.status <> 'ended' order by s.started_at desc limit 1
$$;
create or replace function public.checkin_name(who text)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce((select m.display_name from public.members m where m.discord_id = who), who)
$$;

-- A staff member's rank in a department, e.g. "Year 3" (for the patient's DMs).
create or replace function public.checkin_rank_label(who text, dept text)
returns text language sql stable security definer set search_path = '' as $$
  select r.rank_label from public.members m join public.roles r on r.id = any (m.role_ids)
  where m.discord_id = who and r.department = dept and r.kind = 'rank' order by r.rank_order desc nulls last limit 1
$$;

-- Waiting order: ESI ascending (unset = 3, or 2 when pain >= 8), then longest wait.
create or replace function public.checkin_waiting()
returns table (id bigint, pos int) language sql stable security definer set search_path = '' as $$
  select k.id, (row_number() over (order by coalesce(c.esi, case when coalesce(k.pain, 0) >= 8 then 2 else 3 end), k.created_at, k.id))::int
  from public.chart_checkins k join public.chart_cases c on c.id = k.case_id where k.state = 'waiting'
$$;

create or replace function public.checkin_json(kid bigint)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', k.id, 'case_id', k.case_id, 'state', k.state, 'first_name', left(split_part(c.patient_name, ' ', 1), 12),
    'board_name', left(split_part(c.patient_name, ' ', 1), 12) || coalesce(' ' || upper(left(nullif(split_part(c.patient_name, ' ', 2), ''), 1)) || '.', ''),
    'name', c.patient_name, 'age', c.age, 'roblox_name', k.roblox_name, 'pain', k.pain, 'source', k.source,
    'position', (select w.pos from public.checkin_waiting() w where w.id = k.id),
    'waited_seconds', extract(epoch from coalesce(k.claimed_at, k.ended_at, now()) - k.created_at)::int,
    'room', k.room, 'staff_name', k.claimed_by_name, 'staff_discord_id', k.claimed_by, 'created_at', k.created_at, 'claimed_at', k.claimed_at,
    'staff_department', case when k.claimed_by is not null then c.department end,
    'staff_rank', case when k.claimed_by is not null then public.checkin_rank_label(k.claimed_by, c.department) end,
    'ended_at', k.ended_at, 'ended_reason', k.ended_reason)
  from public.chart_checkins k join public.chart_cases c on c.id = k.case_id where k.id = kid
$$;

-- What the patient is told at discharge (DM + website). Patient-facing only: who treated them, the diagnosis, what was done
-- (interventions, medicines and tests by name), the outcome and the follow-up advice. NEVER notes, handoffs or vitals.
create or replace function public.checkin_summary_json(kid bigint)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('checkin_id', k.id, 'case_id', c.id, 'patient_name', c.patient_name, 'staff_name', k.claimed_by_name,
    'treated_by', coalesce(case when cardinality(c.cared_for) > 0 then (select jsonb_agg(public.checkin_name(w) order by n) from unnest(c.cared_for) with ordinality u(w, n)) end,
                  (select jsonb_agg(x.n order by x.f) from (select e.author_name n, min(e.at) f from public.chart_entries e
                   where e.case_id = c.id and e.error_at is null and e.kind not in ('update', 'note', 'handoff') group by e.author_name) x), jsonb_build_array(k.claimed_by_name)),
    'diagnosis', case when c.diagnosis is null then null else public.chart_label('diagnosis', c.diagnosis) end,
    'treatment', coalesce((select jsonb_agg(x.l order by x.f) from (select coalesce(cat.label, e.item) l, min(e.at) f from public.chart_entries e
                   left join public.chart_catalog cat on cat.id = e.item
                   where e.case_id = c.id and e.error_at is null and e.kind in ('intervention', 'medication', 'order') group by 1) x), '[]'::jsonb),
    'disposition', c.disposition,
    'disposition_label', case c.disposition when 'discharged' then 'Discharged home' when 'admitted' then 'Admitted' when 'or' then 'Sent to surgery'
                           when 'transferred' then 'Transferred' when 'deceased' then 'Deceased' when 'ama' then 'Left against advice'
                           when 'lwbs' then 'Left before being seen' end,
    'follow_up', c.follow_up, 'ended_at', coalesce(k.ended_at, c.closed_at),
    'department', c.department, 'rank', public.checkin_rank_label(k.claimed_by, c.department),
    'minutes', round(extract(epoch from coalesce(k.ended_at, c.closed_at, now()) - k.created_at) / 60)::int)
  from public.chart_checkins k join public.chart_cases c on c.id = k.case_id where k.id = kid
$$;

-- Tell whoever is now first in line (once per check-in), unless their check-in notice already said #1.
create or replace function public.checkin_notify_top()
returns void language plpgsql security definer set search_path = '' as $$
declare t bigint; who text;
begin
  select w.id into t from public.checkin_waiting() w where w.pos = 1;
  if t is null then return; end if;
  if exists (select 1 from public.checkin_notices n where n.checkin_id = t and n.kind = 'queued' and n.detail->>'position' = '1') then return; end if;
  select k.discord_id into who from public.chart_checkins k where k.id = t;
  insert into public.checkin_notices (checkin_id, discord_id, kind, detail) values (t, who, 'position', '{"position":1}') on conflict do nothing;
end $$;

-- Notices on every state change, then refresh "you're next".
create or replace function public.checkin_after_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    insert into public.checkin_notices (checkin_id, discord_id, kind, detail)
    values (new.id, new.discord_id, 'queued', jsonb_build_object('position', (select w.pos from public.checkin_waiting() w where w.id = new.id))) on conflict do nothing;
  elsif new.state is distinct from old.state then
    if new.state = 'claimed' then
      insert into public.checkin_notices (checkin_id, discord_id, kind, detail) values (new.id, new.discord_id, 'claimed', jsonb_build_object('staff_name', new.claimed_by_name,
        'department', (select x.department from public.checkin_staff_shift(new.claimed_by) x),
        'rank', public.checkin_rank_label(new.claimed_by, (select x.department from public.checkin_staff_shift(new.claimed_by) x)),
        'position', 'c' || extract(epoch from new.claimed_at)::bigint)) on conflict do nothing;
    elsif new.state = 'in_room' then
      insert into public.checkin_notices (checkin_id, discord_id, kind, detail) values (new.id, new.discord_id, 'in_room', jsonb_build_object('room', new.room)) on conflict do nothing;
    elsif new.state = 'discharged' then
      insert into public.checkin_notices (checkin_id, discord_id, kind, detail) values (new.id, new.discord_id, 'discharged', public.checkin_summary_json(new.id)) on conflict do nothing;
    elsif new.state = 'left' then
      insert into public.checkin_notices (checkin_id, discord_id, kind, detail) values (new.id, new.discord_id, 'left', jsonb_build_object('reason', new.ended_reason)) on conflict do nothing;
    end if;
  end if;
  perform public.checkin_notify_top();
  return null;
end $$;
drop trigger if exists checkin_after_change on public.chart_checkins;
create trigger checkin_after_change after insert or update on public.chart_checkins for each row execute function public.checkin_after_change();

-- Ratings: that department's Director and owners (and each staff member for their own patients).
create or replace function public.checkin_sees_ratings(dept text)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_exec() or (dept is not null and public.chart_rank(dept) >= 6)
$$;

-- The Chart drives the end of a check-in: closing the case = discharged, voiding = cancelled; an ESI change may reorder the line.
create or replace function public.checkin_case_sync()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'closed' and old.status is distinct from 'closed' then
    update public.chart_checkins set state = 'discharged', ended_at = now() where case_id = new.id and state in ('claimed', 'in_room');
  elsif new.status = 'void' and old.status is distinct from 'void' then
    update public.chart_checkins set state = 'cancelled', ended_at = now(), ended_reason = coalesce(ended_reason, new.void_reason) where case_id = new.id and state in ('waiting', 'claimed', 'in_room');
  end if;
  if new.esi is distinct from old.esi and new.status = 'waiting' then perform public.checkin_notify_top(); end if;
  return null;
end $$;
drop trigger if exists checkin_case_sync on public.chart_cases;
create trigger checkin_case_sync after update on public.chart_cases for each row execute function public.checkin_case_sync();


create or replace function public.chart_add_core(cid bigint, k text, d jsonb, dept text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare cs public.chart_cases; dep text := public.chart_dept_for(dept); it text; cat public.chart_catalog; v text; n numeric; eid bigint;
        lim jsonb := '{"hr":[0,300],"sbp":[0,300],"dbp":[0,200],"rr":[0,80],"spo2":[0,100],"pulse":[0,300],"etco2":[0,100],"temp_f":[80,110],"glucose":[10,900],"pain":[0,10]}';
        clean jsonb := '{}'::jsonb; cosign boolean := false; t text;
begin
  select * into cs from public.chart_cases where id = cid for update;
  if cs.id is null then raise exception 'That case doesn''t exist.'; end if;
  if cs.status = 'waiting' then raise exception 'Take this patient from the check-in queue first.'; end if;
  if cs.status <> 'open' then raise exception 'This case is %; reopen isn''t possible, open a new case instead.', cs.status; end if;
  d := coalesce(d, '{}'::jsonb);
  if jsonb_typeof(d) <> 'object' then raise exception 'Entry data must be an object.'; end if;
  if k = 'vitals' then
    for v in select jsonb_object_keys(lim) loop
      if d ? v then
        begin n := (d->>v)::numeric; exception when others then raise exception 'Vital % must be a number.', v; end;
        if n < (lim->v->>0)::numeric or n > (lim->v->>1)::numeric then raise exception 'Vital % is out of range (% to %).', v, lim->v->>0, lim->v->>1; end if;
        clean := clean || jsonb_build_object(v, n);
      end if;
    end loop;
    if d ? 'avpu' then
      if d->>'avpu' not in ('A', 'V', 'P', 'U') then raise exception 'AVPU must be A, V, P or U.'; end if;
      clean := clean || jsonb_build_object('avpu', d->>'avpu');
    end if;
    if clean = '{}'::jsonb then raise exception 'Enter at least one vital sign.'; end if;
  elsif k in ('intervention', 'medication') then
    it := d->>'item';
    select * into cat from public.chart_catalog where id = it and kind = k and active;
    if cat.id is null then raise exception 'Unknown % "%".', k, coalesce(it, ''); end if;
    clean := jsonb_build_object('item', it);
    if k = 'medication' and nullif(btrim(coalesce(d->>'dose', '')), '') is not null then clean := clean || jsonb_build_object('dose', left(btrim(d->>'dose'), 40)); end if;
    if nullif(btrim(coalesce(d->>'note', '')), '') is not null then clean := clean || jsonb_build_object('note', left(btrim(d->>'note'), 300)); end if;
    cosign := not public.chart_scope_ok(it, dep);
  elsif k = 'assessment' then
    if jsonb_typeof(coalesce(d->'items', '[]')) <> 'array' then raise exception 'Assessment items must be a list.'; end if;
    if exists (select 1 from jsonb_array_elements_text(coalesce(d->'items', '[]')) x where not exists (select 1 from public.chart_catalog c where c.id = x and c.kind = 'assessment')) then
      raise exception 'Unknown assessment item.'; end if;
    clean := jsonb_build_object('items', coalesce(d->'items', '[]'));
    if nullif(btrim(coalesce(d->>'text', '')), '') is not null then clean := clean || jsonb_build_object('text', left(btrim(d->>'text'), 1000)); end if;
    if clean->'items' = '[]'::jsonb and not clean ? 'text' then raise exception 'Pick at least one finding or write one.'; end if;
  elsif k = 'handoff' then
    foreach t in array array['s', 'b', 'a', 'r'] loop
      if nullif(btrim(coalesce(d->>t, '')), '') is not null then clean := clean || jsonb_build_object(t, left(btrim(d->>t), 600)); end if;
    end loop;
    if not (clean ? 's' or clean ? 'r') then raise exception 'A handoff needs at least the Situation or the Recommendation.'; end if;
    if d ? 'to' then
      if not exists (select 1 from public.departments x where x.name = d->>'to') then raise exception 'Unknown department "%".', d->>'to'; end if;
      clean := clean || jsonb_build_object('to', d->>'to');
    end if;
  elsif k = 'order' then
    it := d->>'item';
    if not exists (select 1 from public.chart_catalog c where c.id = it and c.kind = 'order' and c.active) then raise exception 'Unknown order "%".', coalesce(it, ''); end if;
    clean := jsonb_build_object('item', it);
  elsif k = 'result' then
    begin n := (d->>'order_id')::numeric; exception when others then raise exception 'Which order is the result for?'; end;
    if not exists (select 1 from public.chart_entries o where o.id = n and o.case_id = cid and o.kind = 'order' and o.error_at is null) then
      raise exception 'That order isn''t on this case.'; end if;
    if exists (select 1 from public.chart_entries x where x.case_id = cid and x.kind = 'result' and x.error_at is null and x.data->>'order_id' = (n::bigint)::text) then
      raise exception 'That result is already back.'; end if;
    clean := jsonb_build_object('order_id', n::bigint);
    if nullif(btrim(coalesce(d->>'text', '')), '') is not null then clean := clean || jsonb_build_object('text', left(btrim(d->>'text'), 200)); end if;
  elsif k = 'note' then
    if nullif(btrim(coalesce(d->>'text', '')), '') is null then raise exception 'Write the note first.'; end if;
    clean := jsonb_build_object('text', left(btrim(d->>'text'), 1000));
  else
    raise exception 'Unknown entry kind "%".', k;
  end if;
  insert into public.chart_entries (case_id, kind, department, item, data, author, author_name, author_rank, author_rank_label, shift_id, session_id, needs_cosign)
  select cid, k, dep, case when k in ('intervention', 'medication', 'order') then it end, clean, public.my_discord_id(), public.chart_my_name(),
         x.rank, x.rank_label, public.chart_my_shift(), public.chart_live_session(), cosign
  from public.chart_my_depts() x where x.name = dep
  returning id into eid;
  update public.chart_cases set last_at = now() where id = cid;
  return eid;
end $$;

create or replace function public.chart_set_esi(case_id bigint, esi int)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c public.chart_cases; dep text;
begin
  if not public.chart_scope_any('esi') then raise exception 'Only RN-level staff and above can set the ESI.'; end if;
  if esi is null or esi < 1 or esi > 5 then raise exception 'ESI must be 1 to 5.'; end if;
  select * into c from public.chart_cases where id = chart_set_esi.case_id for update;
  if c.id is null then raise exception 'That case doesn''t exist.'; end if;
  if c.status not in ('open', 'waiting') then raise exception 'This case is %.', c.status; end if;
  select x.name into dep from public.chart_my_depts() x where public.chart_scope_ok('esi', x.name) limit 1;
  update public.chart_cases set esi = chart_set_esi.esi, esi_by = public.my_discord_id(), esi_by_name = public.chart_my_name(), last_at = now() where id = c.id;
  insert into public.chart_entries (case_id, kind, department, data, author, author_name, author_rank, author_rank_label, shift_id, session_id)
  select c.id, 'triage', dep, jsonb_strip_nulls(jsonb_build_object('esi', chart_set_esi.esi, 'from', c.esi)), public.my_discord_id(), public.chart_my_name(),
         x.rank, x.rank_label, public.chart_my_shift(), public.chart_live_session()
  from public.chart_my_depts() x where x.name = dep;
  return public.chart_case_json(c.id);
end $$;

create or replace function public.chart_case_json(cid bigint)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', c.id,
    'patient', jsonb_build_object('name', c.patient_name, 'alias', c.patient_alias, 'age', c.age, 'age_band', c.age_band, 'sex', c.sex, 'roblox_username', c.roblox_username),
    'complaint', c.complaint, 'complaint_label', coalesce((select k.label from public.chart_catalog k where k.id = c.complaint and k.kind = 'complaint'), c.complaint),
    'arrival', c.arrival, 'esi', c.esi, 'esi_by_name', c.esi_by_name, 'status', c.status, 'disposition', c.disposition, 'void_reason', c.void_reason,
    'opened_by', c.opened_by, 'opened_by_name', c.opened_by_name, 'department', c.department, 'opened_at', c.opened_at,
    'closed_at', c.closed_at, 'session_id', c.session_id, 'shift_id', c.shift_id, 'last_at', c.last_at,
    'room', c.room,
    'symptoms', coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'label', coalesce(k.label, s.v)) order by s.n)
                 from unnest(c.symptoms) with ordinality s(v, n) left join public.chart_catalog k on k.id = s.v and k.kind = 'symptom'), '[]'::jsonb),
    'history', jsonb_build_object('allergies', c.allergies, 'nkda', c.nkda, 'past_history', c.past_history, 'last_intake', c.last_intake, 'onset', c.onset),
    'diagnosis', case when c.diagnosis is null then null else jsonb_build_object('id', (select k.id from public.chart_catalog k where k.id = c.diagnosis and k.kind = 'diagnosis'),
                 'label', public.chart_label('diagnosis', c.diagnosis), 'by_name', c.diagnosis_by_name, 'at', c.diagnosis_at) end,
    'orders', coalesce((select jsonb_agg(jsonb_build_object('entry_id', o.id, 'item', o.item, 'label', public.chart_label('order', o.item),
                 'ordered_at', o.at, 'ordered_by_name', o.author_name, 'result_at', r.at, 'result_by_name', r.author_name, 'result_text', r.data->>'text') order by o.at, o.id)
               from public.chart_entries o
               left join lateral (select x.* from public.chart_entries x where x.case_id = o.case_id and x.kind = 'result' and x.error_at is null
                                    and x.data->>'order_id' = o.id::text order by x.at limit 1) r on true
               where o.case_id = c.id and o.kind = 'order' and o.error_at is null), '[]'::jsonb),
    'cared_for', to_jsonb(c.cared_for),
    'checkin', (select jsonb_build_object('id', k.id, 'state', k.state, 'pain', k.pain, 'source', k.source, 'created_at', k.created_at, 'claimed_at', k.claimed_at,
                 'answers', (select jsonb_object_agg(f.key, jsonb_build_object('original', k.answers->f.key, 'current', f.cur,
                                 'confirmed', f.key = any (c.checkin_confirmed), 'corrected', k.answers ? f.key and (k.answers->f.key) is distinct from f.cur))
                             from (values ('name', to_jsonb(c.patient_name)), ('age', to_jsonb(c.age)), ('roblox_username', to_jsonb(c.roblox_username)),
                                          ('symptoms', to_jsonb(c.symptoms)), ('pain', to_jsonb(k.pain)), ('onset', to_jsonb(c.onset)),
                                          ('allergies', case when c.nkda then to_jsonb('none'::text) else to_jsonb(c.allergies) end),
                                          ('history', to_jsonb(c.past_history)), ('last_intake', to_jsonb(c.last_intake))) f(key, cur)),
                 'staff_name', k.claimed_by_name, 'waited_seconds', extract(epoch from coalesce(k.claimed_at, k.ended_at, now()) - k.created_at)::int)
                from public.chart_checkins k where k.case_id = c.id),
    'latest_vitals', public.chart_latest_vitals(c.id),
    'pending_cosign', (select count(*) from public.chart_entries e where e.case_id = c.id and e.needs_cosign and e.cosigned_at is null and e.error_at is null))
  from public.chart_cases c where c.id = cid
$$;

drop function if exists public.chart_close(bigint, text, text, text);
create or replace function public.chart_close(case_id bigint, disposition text, note text default null, follow_up text default null, cared_for text[] default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c public.chart_cases; dep text; cosign boolean;
begin
  if not public.chart_can_write() then raise exception 'Only clinical staff can write in the CBH Chart.'; end if;
  if disposition is null or disposition not in ('discharged', 'admitted', 'or', 'transferred', 'deceased', 'ama') then raise exception 'Pick a disposition.'; end if;
  select * into c from public.chart_cases where id = chart_close.case_id for update;
  if c.id is null then raise exception 'That case doesn''t exist.'; end if;
  if c.status <> 'open' then raise exception 'This case is already %.', c.status; end if;
  if char_length(coalesce(follow_up, '')) > 500 then raise exception 'Keep the follow-up advice under 500 characters.'; end if;
  -- act for a department where it's in scope if I have one, else my main one (then it needs a cosign)
  select x.name into dep from public.chart_my_depts() x order by public.chart_scope_ok('disposition', x.name) desc, x.rank desc limit 1;
  cosign := disposition in ('discharged', 'admitted', 'transferred') and not public.chart_scope_ok('disposition', dep);
  insert into public.chart_entries (case_id, kind, department, item, data, author, author_name, author_rank, author_rank_label, shift_id, session_id, needs_cosign)
  select c.id, 'disposition', dep, 'disposition', jsonb_strip_nulls(jsonb_build_object('disposition', chart_close.disposition, 'note', left(nullif(btrim(coalesce(note, '')), ''), 500))),
         public.my_discord_id(), public.chart_my_name(), x.rank, x.rank_label, public.chart_my_shift(), public.chart_live_session(), cosign
  from public.chart_my_depts() x where x.name = dep;
  update public.chart_cases set status = 'closed', disposition = chart_close.disposition, follow_up = nullif(btrim(coalesce(chart_close.follow_up, '')), ''),
         cared_for = coalesce((select array_agg(distinct w) from unnest(chart_close.cared_for) w where exists (select 1 from public.members m where m.discord_id = w)), '{}'), closed_by = public.my_discord_id(), closed_at = now(), last_at = now() where id = c.id;
  return public.chart_case_json(c.id);
end $$;

create or replace function public.chart_list(status text default 'open', mine boolean default false, session_id bigint default null,
                                             department text default null, q text default null, before_id bigint default null, lim int default 30)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare me text := public.my_discord_id(); term text := nullif(btrim(coalesce(q, '')), '');
begin
  if not public.chart_can_read() then raise exception 'The CBH Chart is for clinical staff and Administration.'; end if;
  return coalesce((select jsonb_agg(x.j order by x.id desc) from (
    select c.id, jsonb_build_object('id', c.id, 'patient_name', c.patient_name, 'alias', c.patient_alias, 'roblox_username', c.roblox_username,
        'complaint', c.complaint, 'complaint_label', coalesce((select k.label from public.chart_catalog k where k.id = c.complaint and k.kind = 'complaint'), c.complaint),
        'esi', c.esi, 'status', c.status, 'arrival', c.arrival, 'department', c.department, 'opened_at', c.opened_at, 'opened_by_name', c.opened_by_name,
        'last_at', c.last_at, 'disposition', c.disposition, 'session_id', c.session_id,
        'room', c.room, 'age', c.age, 'diagnosis_label', case when c.diagnosis is null then null else public.chart_label('diagnosis', c.diagnosis) end,
        'entries', (select count(*) from public.chart_entries e where e.case_id = c.id and e.error_at is null),
        'pending_cosign', (select count(*) from public.chart_entries e where e.case_id = c.id and e.needs_cosign and e.cosigned_at is null and e.error_at is null),
        'latest_vitals', public.chart_latest_vitals(c.id)) j
    from public.chart_cases c
    where (coalesce(chart_list.status, 'open') = 'all' and c.status not in ('void', 'waiting') or c.status = coalesce(chart_list.status, 'open'))
      and (not coalesce(mine, false) or c.opened_by = me or exists (select 1 from public.chart_entries e where e.case_id = c.id and e.author = me))
      and (chart_list.session_id is null or c.session_id = chart_list.session_id)
      and (chart_list.department is null or c.department = chart_list.department)
      and (term is null or c.patient_name ilike '%' || term || '%' or c.roblox_username ilike '%' || term || '%')
      and (before_id is null or c.id < before_id)
    order by c.id desc limit least(greatest(coalesce(lim, 30), 1), 100)) x), '[]'::jsonb);
end $$;


-- Rough wait estimate for a waiting patient: their place in line x the recent average door-to-claim (default 5 min).
create or replace function public.checkin_est_wait(kid bigint)
returns int language sql stable security definer set search_path = '' as $$
  select case when w.pos is null then null else greatest(1, round(w.pos * coalesce(
           (select avg(extract(epoch from k.claimed_at - k.created_at)) / 60 from public.chart_checkins k where k.claimed_at > now() - interval '3 hours'), 5)))::int end
  from (select (select x.pos from public.checkin_waiting() x where x.id = kid) pos) w
$$;

create or replace function public.checkin_short_name(full_name text)
returns text language sql immutable set search_path = '' as $$
  select left(split_part(full_name, ' ', 1), 12) || coalesce(' ' || upper(left(nullif(split_part(full_name, ' ', 2), ''), 1)) || '.', '')
$$;

-- The waiting board (every member, and the bot): first name + last initial only.
create or replace function public.checkin_board()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not (public.chart_is_service() or exists (select 1 from public.members m where m.discord_id = public.my_discord_id())) then
    raise exception 'Join the CareBeyond server to see the board.'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'board_name', public.checkin_short_name(c.patient_name), 'state', k.state,
      'position', w.pos, 'waited_min', (extract(epoch from now() - k.created_at) / 60)::int, 'waited_seconds', extract(epoch from now() - k.created_at)::int,
      'with_name', case when k.claimed_by_name is not null then public.checkin_short_name(k.claimed_by_name) end, 'room', k.room)
      order by (k.state <> 'waiting'), w.pos, k.claimed_at)
    from public.chart_checkins k join public.chart_cases c on c.id = k.case_id left join public.checkin_waiting() w on w.id = k.id
    where k.state in ('waiting', 'claimed', 'in_room')), '[]'::jsonb);
end $$;

-- Staff confirm what the patient said (each answer can be confirmed; corrections go through chart_update and show as "corrected").
create or replace function public.chart_confirm(case_id bigint, fields text[] default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c public.chart_cases; dep text; ok text[] := array['name', 'age', 'roblox_username', 'symptoms', 'pain', 'onset', 'allergies', 'history', 'last_intake']; f text; add text[] := '{}';
begin
  if not public.chart_can_write() then raise exception 'Only clinical staff can write in the CBH Chart.'; end if;
  select * into c from public.chart_cases where id = chart_confirm.case_id for update;
  if c.id is null then raise exception 'That case doesn''t exist.'; end if;
  if c.status <> 'open' then raise exception 'Take the patient first.'; end if;
  foreach f in array coalesce(fields, ok) loop
    if not f = any (ok) then raise exception 'Can''t confirm "%".', f; end if;
    if not f = any (c.checkin_confirmed) and not f = any (add) then add := add || f; end if;
  end loop;
  if cardinality(add) = 0 then return public.chart_case_json(c.id); end if;
  dep := public.chart_dept_for(null);
  update public.chart_cases set checkin_confirmed = checkin_confirmed || add, last_at = now() where id = c.id;
  insert into public.chart_entries (case_id, kind, department, data, author, author_name, author_rank, author_rank_label, shift_id, session_id)
  select c.id, 'update', dep, jsonb_build_object('confirmed', to_jsonb(add)), public.my_discord_id(), public.chart_my_name(), x.rank, x.rank_label, public.chart_my_shift(), public.chart_live_session()
  from public.chart_my_depts() x where x.name = dep;
  return public.chart_case_json(c.id);
end $$;

-- ---------- patient side ----------
create or replace function public.checkin_status(p_discord_id text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare who text := public.chart_actor(p_discord_id); sid bigint := public.checkin_live_session(); act bigint; reason text; n int; wait_min int;
begin
  if who is null then raise exception 'Sign in first.'; end if;
  select k.id into act from public.chart_checkins k where k.discord_id = who and k.state in ('waiting', 'claimed', 'in_room');
  if not exists (select 1 from public.members m where m.discord_id = who) then reason := 'You''re not in the CareBeyond server.';
  elsif act is not null then reason := 'You''re already checked in.';
  elsif sid is null then reason := 'There''s no session running right now. Check in when a session is live.';
  else
    select count(*), ceil(extract(epoch from min(k.created_at) + interval '2 hours' - now()) / 60) into n, wait_min
      from public.chart_checkins k where k.discord_id = who and k.created_at > now() - interval '2 hours';
    if n >= 4 then reason := format('You''ve checked in a lot recently. Try again in %s minutes.', greatest(wait_min, 1));
    else
      select ceil(extract(epoch from max(k.ended_at) + interval '2 minutes' - now()) / 60) into wait_min
        from public.chart_checkins k where k.discord_id = who and k.state in ('cancelled', 'left') and k.ended_at > now() - interval '2 minutes';
      if wait_min is not null then reason := format('Please wait %s minute%s before checking in again.', greatest(wait_min, 1), case when greatest(wait_min, 1) = 1 then '' else 's' end); end if;
    end if;
  end if;
  return jsonb_build_object('session_live', sid is not null,
    'session', (select jsonb_build_object('id', x.id, 'started_at', x.started_at) from public.sessions x where x.id = sid),
    'next_session', (select jsonb_build_object('id', x.id, 'scheduled_for', x.scheduled_for) from public.sessions x
                     where x.status = 'scheduled' and x.scheduled_for > now() order by x.scheduled_for limit 1),
    'est_wait_min', case when act is not null then public.checkin_est_wait(act) end,
    'can_check_in', reason is null, 'reason', reason,
    'active', case when act is null then null else public.checkin_json(act) end,
    'feedback_due', coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'case_id', k.case_id, 'ended_at', k.ended_at, 'staff_name', k.claimed_by_name) order by k.ended_at desc)
                     from public.chart_checkins k where k.discord_id = who and k.state = 'discharged' and k.rating is null and k.ended_at > now() - interval '7 days'), '[]'::jsonb));
end $$;

create or replace function public.checkin_create(p_discord_id text default null, p_name text default null, p_age int default null, p_roblox_name text default null,
                                                 p_symptoms jsonb default null, p_pain int default null, p_onset text default null, p_allergies text default null,
                                                 p_history text default null, p_last_oral text default null, p_source text default 'website')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare who text := public.chart_actor(p_discord_id); st jsonb; rn text := nullif(btrim(coalesce(p_roblox_name, '')), ''); raw text[]; x text; sym text[] := '{}';
        hit text; cid bigint; kid bigint; nm text; pn text := nullif(btrim(coalesce(p_name, '')), '');
begin
  if who is null then raise exception 'Sign in first.'; end if;
  st := public.checkin_status(p_discord_id);
  if not (st->>'can_check_in')::boolean then raise exception '%', st->>'reason'; end if;
  if pn is null then raise exception 'Type your character''s name.'; end if;
  if char_length(pn) > 80 then raise exception 'That name is too long.'; end if;
  if p_age is null or p_age < 0 or p_age > 120 then raise exception 'Give your character''s age (0 to 120).'; end if;
  if rn is null then raise exception 'Type your Roblox username.'; end if;
  if char_length(rn) > 40 then raise exception 'That Roblox username is too long.'; end if;
  if p_pain is not null and (p_pain < 0 or p_pain > 10) then raise exception 'Pain is 0 to 10.'; end if;
  if coalesce(p_source, 'website') not in ('website', 'discord_button', 'discord_form') then raise exception 'Unknown check-in source.'; end if;
  if greatest(char_length(coalesce(p_allergies, '')), char_length(coalesce(p_history, '')), char_length(coalesce(p_onset, '')), char_length(coalesce(p_last_oral, ''))) > 200 then
    raise exception 'Keep each answer under 200 characters.'; end if;
  -- symptoms: a list, or one text split on commas, semicolons or new lines; matched to the catalogue by id or label
  if p_symptoms is null or p_symptoms = 'null'::jsonb then raw := '{}';
  elsif jsonb_typeof(p_symptoms) = 'array' then raw := array(select jsonb_array_elements_text(p_symptoms));
  elsif jsonb_typeof(p_symptoms) = 'string' then raw := regexp_split_to_array(p_symptoms #>> '{}', '\s*[,;\n]\s*');
  else raise exception 'Tell us your symptoms.'; end if;
  foreach x in array raw loop
    x := btrim(x);
    continue when x = '';
    select c.id into hit from public.chart_catalog c where c.kind = 'symptom' and c.active and (c.id = x or lower(c.label) = lower(x)) limit 1;
    sym := sym || coalesce(hit, x);
  end loop;
  sym := public.chart_norm_symptoms(to_jsonb(sym));
  if cardinality(sym) = 0 then raise exception 'Tell us at least one symptom.'; end if;
  nm := public.checkin_name(who);
  insert into public.chart_cases (patient_name, age, roblox_username, complaint, arrival, status, department, opened_by, opened_by_name, session_id, symptoms)
  values (pn, p_age, rn, left(public.chart_label('symptom', sym[1]), 120), 'self_checkin', 'waiting', 'Nursing', who, nm, public.checkin_live_session(), sym)
  returning id into cid;
  perform public.checkin_apply_details(cid, p_onset, p_allergies, p_history, p_last_oral);
  begin
    insert into public.chart_checkins (case_id, discord_id, roblox_name, pain, source, session_id)
    values (cid, who, rn, p_pain::smallint, coalesce(p_source, 'website'), public.checkin_live_session()) returning id into kid;
    update public.chart_checkins set answers = jsonb_strip_nulls(jsonb_build_object('name', pn, 'age', p_age, 'roblox_username', rn, 'symptoms', to_jsonb(sym), 'pain', p_pain,
           'onset', nullif(btrim(coalesce(p_onset, '')), ''), 'allergies', nullif(btrim(coalesce(p_allergies, '')), ''),
           'history', nullif(btrim(coalesce(p_history, '')), ''), 'last_intake', nullif(btrim(coalesce(p_last_oral, '')), ''))) where id = kid;
  exception when unique_violation then raise exception 'You''re already checked in.';
  end;
  return public.checkin_json(kid);
end $$;

-- Optional answers (the second step of the form). Only non-null values change anything; "none" (etc.) for allergies = no known allergies.
create or replace function public.checkin_apply_details(cid bigint, p_onset text, p_allergies text, p_history text, p_last_oral text)
returns void language plpgsql security definer set search_path = '' as $$
declare a text := nullif(btrim(coalesce(p_allergies, '')), '');
begin
  if greatest(char_length(coalesce(p_allergies, '')), char_length(coalesce(p_history, '')), char_length(coalesce(p_onset, '')), char_length(coalesce(p_last_oral, ''))) > 200 then
    raise exception 'Keep each answer under 200 characters.'; end if;
  update public.chart_cases set
    onset = coalesce(nullif(btrim(coalesce(p_onset, '')), ''), onset),
    past_history = coalesce(nullif(btrim(coalesce(p_history, '')), ''), past_history),
    last_intake = coalesce(nullif(btrim(coalesce(p_last_oral, '')), ''), last_intake),
    nkda = case when a is null then nkda when lower(a) in ('none', 'no', 'nka', 'nkda', 'no known allergies', 'n/a', 'nope') then true else false end,
    allergies = case when a is null then allergies when lower(a) in ('none', 'no', 'nka', 'nkda', 'no known allergies', 'n/a', 'nope') then null else a end,
    last_at = now()
  where id = cid;
end $$;

create or replace function public.checkin_details(p_id bigint, p_onset text default null, p_allergies text default null, p_history text default null,
                                                  p_last_oral text default null, p_discord_id text default null, p_pain int default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare who text := public.chart_actor(p_discord_id); k public.chart_checkins;
begin
  select * into k from public.chart_checkins where id = p_id for update;
  if k.id is null or k.discord_id is distinct from who then raise exception 'That isn''t your check-in.'; end if;
  if k.state not in ('waiting', 'claimed', 'in_room') then raise exception 'This check-in has ended.'; end if;
  if p_pain is not null and (p_pain < 0 or p_pain > 10) then raise exception 'Pain is 0 to 10.'; end if;
  perform public.checkin_apply_details(k.case_id, p_onset, p_allergies, p_history, p_last_oral);
  update public.chart_checkins set pain = coalesce(p_pain::smallint, pain),
         answers = answers || jsonb_strip_nulls(jsonb_build_object('pain', p_pain, 'onset', nullif(btrim(coalesce(p_onset, '')), ''), 'allergies', nullif(btrim(coalesce(p_allergies, '')), ''),
                   'history', nullif(btrim(coalesce(p_history, '')), ''), 'last_intake', nullif(btrim(coalesce(p_last_oral, '')), '')))
  where id = k.id;
  return public.checkin_json(k.id);
end $$;

-- The discharge summary on the website: the patient (their own) or Chart readers, once discharged or left.
create or replace function public.checkin_summary(p_id bigint, p_discord_id text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare who text := public.chart_actor(p_discord_id); k public.chart_checkins;
begin
  select * into k from public.chart_checkins where id = p_id;
  if k.id is null or not (k.discord_id = who or (not public.chart_is_service() and public.chart_can_read())) then raise exception 'That isn''t your check-in.'; end if;
  if k.state not in ('discharged', 'left') then raise exception 'Your summary is ready when you''re discharged.'; end if;
  return public.checkin_summary_json(k.id) || jsonb_build_object('rated', k.rating is not null);
end $$;

create or replace function public.checkin_cancel(p_id bigint, p_discord_id text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare who text := public.chart_actor(p_discord_id); k public.chart_checkins;
begin
  select * into k from public.chart_checkins where id = p_id for update;
  if k.id is null or k.discord_id is distinct from who then raise exception 'That isn''t your check-in.'; end if;
  if k.state not in ('waiting', 'claimed') then raise exception 'This check-in can''t be cancelled now (%).', replace(k.state, '_', ' '); end if;
  update public.chart_checkins set state = 'cancelled', ended_at = now(), ended_reason = 'Cancelled by the patient' where id = k.id;
  update public.chart_cases set status = 'void', void_reason = 'Cancelled by the patient', last_at = now() where id = k.case_id;
  return public.checkin_json(k.id);
end $$;

create or replace function public.checkin_feedback(p_id bigint, p_rating int, p_comment text default null, p_discord_id text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare who text := public.chart_actor(p_discord_id); k public.chart_checkins;
begin
  select * into k from public.chart_checkins where id = p_id for update;
  if k.id is null or k.discord_id is distinct from who then raise exception 'That isn''t your check-in.'; end if;
  if k.state <> 'discharged' then raise exception 'You can rate your visit after you''re discharged.'; end if;
  if k.rating is not null then raise exception 'You''ve already rated this visit. Thank you!'; end if;
  if p_rating is null or p_rating < 1 or p_rating > 5 then raise exception 'Pick a rating from 1 to 5.'; end if;
  if char_length(coalesce(p_comment, '')) > 500 then raise exception 'Keep your comment under 500 characters.'; end if;
  update public.chart_checkins set rating = p_rating, comment = nullif(btrim(coalesce(p_comment, '')), ''), rated_at = now() where id = k.id;
  return jsonb_build_object('ok', true);
end $$;

-- ---------- staff side ----------
create or replace function public.checkin_queue()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare svc boolean := public.chart_is_service();
begin
  if not (svc or public.chart_can_read()) then raise exception 'The check-in queue is for clinical staff.'; end if;
  return jsonb_build_object('session_live', public.checkin_live_session() is not null,
    'queue', coalesce((select jsonb_agg(public.checkin_json(k.id) || jsonb_build_object(
                 'esi', c.esi, 'recommended', w.pos = 1, 'staff_message_id', case when svc then k.staff_message_id end,
                 'diagnosis_label', case when c.diagnosis is null then null else public.chart_label('diagnosis', c.diagnosis) end,
                 'pending_cosign', (select count(*) from public.chart_entries e where e.case_id = c.id and e.needs_cosign and e.cosigned_at is null and e.error_at is null),
                 'symptoms', (public.chart_case_json(c.id))->'symptoms')
               order by (k.state <> 'waiting'), w.pos, k.claimed_at)
               from public.chart_checkins k join public.chart_cases c on c.id = k.case_id left join public.checkin_waiting() w on w.id = k.id
               where k.state in ('waiting', 'claimed', 'in_room')), '[]'::jsonb),
    'recent', coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'case_id', k.case_id, 'board_name', public.checkin_short_name(c.patient_name), 'state', k.state,
                 'diagnosis_label', case when c.diagnosis is null then null else public.chart_label('diagnosis', c.diagnosis) end,
                 'staff_name', k.claimed_by_name, 'minutes', round(extract(epoch from k.ended_at - k.created_at) / 60)::int, 'ended_at', k.ended_at,
                 'rating', case when not svc and (k.claimed_by = public.my_discord_id() or public.checkin_sees_ratings(c.department)) then k.rating end)
               order by k.ended_at desc)
               from public.chart_checkins k join public.chart_cases c on c.id = k.case_id
               where k.state in ('discharged', 'left') and k.ended_at > now() - interval '12 hours'), '[]'::jsonb),
    'suggested_staff', coalesce((select jsonb_agg(x.j order by x.n, x.started) from (
               select jsonb_build_object('discord_id', s.discord_id, 'name', public.checkin_name(s.discord_id), 'department', s.department,
                        'active_patients', count(k.id), 'on_shift_minutes', (extract(epoch from now() - s.started_at) / 60)::int) j, count(k.id) n, s.started_at started
               from public.shifts s join public.departments d on d.name = s.department and d.clinical
               left join public.chart_checkins k on k.claimed_by = s.discord_id and k.state in ('claimed', 'in_room')
               where s.status <> 'ended' group by s.discord_id, s.department, s.started_at) x), '[]'::jsonb));
end $$;

create or replace function public.checkin_take(p_id bigint, p_staff_discord_id text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare who text := public.chart_actor(p_staff_discord_id); sh record; k public.chart_checkins; nm text;
begin
  if who is null then raise exception 'Who is taking the patient?'; end if;
  select * into sh from public.checkin_staff_shift(who);
  if sh.shift_id is null then raise exception 'Start a shift in a clinical department to take patients.'; end if;
  if exists (select 1 from public.chart_checkins x where x.id = p_id and x.discord_id = who) then raise exception 'You can''t take your own check-in.'; end if;
  nm := public.checkin_name(who);
  update public.chart_checkins set state = 'claimed', claimed_by = who, claimed_by_name = nm, claimed_at = now()
  where id = p_id and state = 'waiting' returning * into k;   -- atomic: only one taker wins
  if k.id is null then
    select * into k from public.chart_checkins where id = p_id;
    if k.id is null then raise exception 'That check-in doesn''t exist.'; end if;
    if k.state in ('claimed', 'in_room') then raise exception '% already took this patient.', k.claimed_by_name; end if;
    raise exception 'This check-in has ended (%).', replace(k.state, '_', ' ');
  end if;
  update public.chart_cases set status = 'open', department = sh.department, opened_by = who, opened_by_name = nm, shift_id = sh.shift_id,
         session_id = coalesce(session_id, public.checkin_live_session()), last_at = now()
  where id = k.case_id;
  return jsonb_build_object('ok', true, 'case_id', k.case_id, 'state', 'claimed', 'staff_name', nm);
end $$;

create or replace function public.checkin_release(p_id bigint, p_staff_discord_id text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare who text := public.chart_actor(p_staff_discord_id); k public.chart_checkins; dep text;
begin
  select * into k from public.chart_checkins where id = p_id for update;
  if k.id is null then raise exception 'That check-in doesn''t exist.'; end if;
  if k.state <> 'claimed' then raise exception 'Only a claimed patient can go back to the queue.'; end if;
  select department into dep from public.chart_cases where id = k.case_id;
  if not (k.claimed_by = who or (not public.chart_is_service() and (public.is_exec() or public.chart_rank(dep) >= 6))) then
    raise exception 'Only % (or a Director) can put this patient back.', k.claimed_by_name; end if;
  update public.chart_checkins set state = 'waiting', claimed_by = null, claimed_by_name = null, claimed_at = null where id = k.id;
  update public.chart_cases set status = 'waiting', last_at = now() where id = k.case_id;
  return public.checkin_json(k.id);
end $$;

create or replace function public.checkin_room(p_id bigint, p_room text, p_staff_discord_id text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare who text := public.chart_actor(p_staff_discord_id); k public.chart_checkins; r text := nullif(btrim(coalesce(p_room, '')), '');
begin
  if who is null or (select shift_id from public.checkin_staff_shift(who)) is null then raise exception 'Start a shift in a clinical department first.'; end if;
  if r is null or char_length(r) > 40 then raise exception 'Give the room (up to 40 characters).'; end if;
  select * into k from public.chart_checkins where id = p_id for update;
  if k.id is null then raise exception 'That check-in doesn''t exist.'; end if;
  if k.state not in ('claimed', 'in_room') then raise exception 'Take the patient first.'; end if;
  update public.chart_checkins set state = 'in_room', room = r, in_room_at = coalesce(in_room_at, now()) where id = k.id;
  update public.chart_cases set room = r, last_at = now() where id = k.case_id;
  return public.checkin_json(k.id);
end $$;

create or replace function public.checkin_left(p_id bigint, p_reason text default null, p_staff_discord_id text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare who text := public.chart_actor(p_staff_discord_id); k public.chart_checkins;
begin
  if who is null or not ((select shift_id from public.checkin_staff_shift(who)) is not null or (not public.chart_is_service() and public.is_exec())) then
    raise exception 'Start a shift in a clinical department first.'; end if;
  select * into k from public.chart_checkins where id = p_id for update;
  if k.id is null then raise exception 'That check-in doesn''t exist.'; end if;
  if k.state not in ('waiting', 'claimed', 'in_room') then raise exception 'This check-in has already ended.'; end if;
  update public.chart_checkins set state = 'left', ended_at = now(), ended_reason = coalesce(left(nullif(btrim(coalesce(p_reason, '')), ''), 200), 'Left without being seen') where id = k.id;
  update public.chart_cases set status = 'closed', disposition = 'lwbs', closed_by = who, closed_at = now(), last_at = now() where id = k.case_id;
  return public.checkin_json(k.id);
end $$;

create or replace function public.checkin_set_staff_message(p_id bigint, p_message_id text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.chart_is_service() then raise exception 'Only the bot can do that.'; end if;
  update public.chart_checkins set staff_message_id = p_message_id where id = p_id;
end $$;

do $g$
declare f text;
begin
  foreach f in array array['chart_actor(text)', 'checkin_live_session()', 'checkin_staff_shift(text)', 'checkin_name(text)', 'checkin_waiting()',
                           'checkin_json(bigint)', 'checkin_notify_top()', 'checkin_summary_json(bigint)', 'checkin_apply_details(bigint, text, text, text, text)', 'checkin_rank_label(text, text)',
                           'checkin_est_wait(bigint)', 'checkin_sees_ratings(text)', 'checkin_after_change()', 'checkin_case_sync()', 'chart_add_core(bigint, text, jsonb, text)',
                           'chart_case_json(bigint)'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
  revoke execute on function public.chart_is_service() from public, anon;
  foreach f in array array['checkin_status(text)', 'checkin_create(text, text, int, text, jsonb, int, text, text, text, text, text)', 'checkin_cancel(bigint, text)',
                           'checkin_details(bigint, text, text, text, text, text, int)', 'checkin_summary(bigint, text)', 'checkin_board()',
                           'chart_confirm(bigint, text[])', 'chart_close(bigint, text, text, text, text[])',
                           'checkin_feedback(bigint, int, text, text)', 'checkin_queue()', 'checkin_take(bigint, text)', 'checkin_release(bigint, text)',
                           'checkin_room(bigint, text, text)', 'checkin_left(bigint, text, text)', 'chart_set_esi(bigint, int)',
                           'chart_list(text, boolean, bigint, text, text, bigint, int)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
  revoke execute on function public.checkin_set_staff_message(bigint, text) from public, anon, authenticated;
  grant execute on function public.checkin_set_staff_message(bigint, text) to service_role;
end $g$;

