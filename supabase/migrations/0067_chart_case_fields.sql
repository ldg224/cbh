-- 0067: CBH Chart v1.1, case fields (Alpha). Owner approved 18 Nov 2026 (research: Plans/CareBeyond/chart/maple-illnesses.md;
-- contract: Plans/CareBeyond/chart/CONTRACT-v1.1.md). Additive: new columns, new entry and catalogue kinds, new vitals
-- (Pulse, CO2), light orders/results, chart_update for filling details in as the ~11-minute case goes. Old calls still work.

alter table public.chart_cases add column if not exists age smallint check (age between 0 and 120);
alter table public.chart_cases add column if not exists room text check (room is null or char_length(room) <= 40);
alter table public.chart_cases add column if not exists symptoms text[] not null default '{}';
alter table public.chart_cases add column if not exists allergies text check (allergies is null or char_length(allergies) <= 200);
alter table public.chart_cases add column if not exists nkda boolean;
alter table public.chart_cases add column if not exists past_history text check (past_history is null or char_length(past_history) <= 200);
alter table public.chart_cases add column if not exists last_intake text check (last_intake is null or char_length(last_intake) <= 200);
alter table public.chart_cases add column if not exists onset text check (onset is null or char_length(onset) <= 200);
alter table public.chart_cases add column if not exists diagnosis text check (diagnosis is null or char_length(diagnosis) <= 60);
alter table public.chart_cases add column if not exists diagnosis_by text;
alter table public.chart_cases add column if not exists diagnosis_by_name text;
alter table public.chart_cases add column if not exists diagnosis_at timestamptz;

alter table public.chart_entries drop constraint if exists chart_entries_kind_check;
alter table public.chart_entries add constraint chart_entries_kind_check check (kind in
  ('vitals', 'intervention', 'medication', 'assessment', 'handoff', 'note', 'triage', 'disposition', 'order', 'result', 'update', 'diagnosis'));
alter table public.chart_catalog drop constraint if exists chart_catalog_kind_check;
alter table public.chart_catalog add constraint chart_catalog_kind_check check (kind in
  ('complaint', 'intervention', 'medication', 'assessment', 'cap', 'symptom', 'diagnosis', 'order'));
alter table public.chart_catalog add column if not exists pathway text check (pathway is null or pathway in ('verified', 'seen', 'none'));

-- Symptoms: catalogue ids or free text, max 12, each 1-40 characters.
create or replace function public.chart_norm_symptoms(v jsonb)
returns text[] language plpgsql immutable set search_path = '' as $$
declare r text[] := '{}'; x text;
begin
  if v is null or v = 'null'::jsonb then return '{}'; end if;
  if jsonb_typeof(v) <> 'array' then raise exception 'Symptoms must be a list.'; end if;
  if jsonb_array_length(v) > 12 then raise exception 'Up to 12 symptoms.'; end if;
  for x in select btrim(t) from jsonb_array_elements_text(v) t loop
    if x = '' then continue; end if;
    if char_length(x) > 40 then raise exception 'Keep each symptom under 40 characters.'; end if;
    if not x = any (r) then r := r || x; end if;
  end loop;
  return r;
end $$;

create or replace function public.chart_label(k text, v text)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce((select c.label from public.chart_catalog c where c.id = v and c.kind = k), v)
$$;


create or replace function public.chart_latest_vitals(cid bigint)
returns jsonb language sql stable security definer set search_path = '' as $$
  -- the newest value of each vital across the case's valid vitals entries, plus when the newest was taken
  select case when count(*) = 0 then null else
    jsonb_strip_nulls(jsonb_build_object(
      'hr',      (array_agg(e.data->'hr'      order by e.at desc) filter (where e.data ? 'hr'))[1],
      'sbp',     (array_agg(e.data->'sbp'     order by e.at desc) filter (where e.data ? 'sbp'))[1],
      'dbp',     (array_agg(e.data->'dbp'     order by e.at desc) filter (where e.data ? 'dbp'))[1],
      'rr',      (array_agg(e.data->'rr'      order by e.at desc) filter (where e.data ? 'rr'))[1],
      'spo2',    (array_agg(e.data->'spo2'    order by e.at desc) filter (where e.data ? 'spo2'))[1],
      'pulse',   (array_agg(e.data->'pulse'   order by e.at desc) filter (where e.data ? 'pulse'))[1],
      'etco2',   (array_agg(e.data->'etco2'   order by e.at desc) filter (where e.data ? 'etco2'))[1],
      'temp_f',  (array_agg(e.data->'temp_f'  order by e.at desc) filter (where e.data ? 'temp_f'))[1],
      'glucose', (array_agg(e.data->'glucose' order by e.at desc) filter (where e.data ? 'glucose'))[1],
      'pain',    (array_agg(e.data->'pain'    order by e.at desc) filter (where e.data ? 'pain'))[1],
      'avpu',    (array_agg(e.data->'avpu'    order by e.at desc) filter (where e.data ? 'avpu'))[1],
      'at',      to_jsonb(max(e.at)))) end
  from public.chart_entries e where e.case_id = cid and e.kind = 'vitals' and e.error_at is null
$$;

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
    'latest_vitals', public.chart_latest_vitals(c.id),
    'pending_cosign', (select count(*) from public.chart_entries e where e.case_id = c.id and e.needs_cosign and e.cosigned_at is null and e.error_at is null))
  from public.chart_cases c where c.id = cid
$$;

create or replace function public.chart_add_core(cid bigint, k text, d jsonb, dept text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare cs public.chart_cases; dep text := public.chart_dept_for(dept); it text; cat public.chart_catalog; v text; n numeric; eid bigint;
        lim jsonb := '{"hr":[0,300],"sbp":[0,300],"dbp":[0,200],"rr":[0,80],"spo2":[0,100],"pulse":[0,300],"etco2":[0,100],"temp_f":[80,110],"glucose":[10,900],"pain":[0,10]}';
        clean jsonb := '{}'::jsonb; cosign boolean := false; t text;
begin
  select * into cs from public.chart_cases where id = cid for update;
  if cs.id is null then raise exception 'That case doesn''t exist.'; end if;
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
    where (coalesce(chart_list.status, 'open') = 'all' and c.status <> 'void' or c.status = coalesce(chart_list.status, 'open'))
      and (not coalesce(mine, false) or c.opened_by = me or exists (select 1 from public.chart_entries e where e.case_id = c.id and e.author = me))
      and (chart_list.session_id is null or c.session_id = chart_list.session_id)
      and (chart_list.department is null or c.department = chart_list.department)
      and (term is null or c.patient_name ilike '%' || term || '%' or c.roblox_username ilike '%' || term || '%')
      and (before_id is null or c.id < before_id)
    order by c.id desc limit least(greatest(coalesce(lim, 30), 1), 100)) x), '[]'::jsonb);
end $$;

create or replace function public.chart_error(entry_id bigint, reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare e public.chart_entries; why text := nullif(btrim(coalesce(reason, '')), '');
begin
  select * into e from public.chart_entries where id = entry_id for update;
  if e.id is null then raise exception 'That entry doesn''t exist.'; end if;
  if e.error_at is not null then raise exception 'Already marked in error.'; end if;
  if why is null then raise exception 'Say why it''s in error.'; end if;
  if e.kind in ('triage', 'disposition') then raise exception 'Triage and disposition entries can''t be marked in error. Set the ESI again, or void the case.'; end if;
  if e.kind in ('update', 'diagnosis') then raise exception 'Change the detail again instead; the timeline keeps both.'; end if;
  if not (e.author = public.my_discord_id() or public.is_exec() or public.chart_rank(e.department) >= 6) then
    raise exception 'Only the author or the % Director can mark this in error.', e.department; end if;
  update public.chart_entries set error_at = now(), error_by = public.my_discord_id(), error_by_name = public.chart_my_name(), error_reason = left(why, 200)
  where id = e.id returning * into e;
  return public.chart_entry_json(e);
end $$;

create or replace function public.chart_catalog()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare j jsonb;
begin
  if not public.chart_can_read() then raise exception 'The CBH Chart is for clinical staff and Administration.'; end if;
  select jsonb_build_object(
    'complaints',    coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'label', c.label, 'group', c.grp, 'in_game', c.in_game, 'pathway', c.pathway) order by c.sort, c.label) from public.chart_catalog c where c.kind = 'complaint' and c.active), '[]'),
    'interventions', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'label', c.label, 'group', c.grp, 'in_game', c.in_game, 'scope', c.scope, 'mine', public.chart_scope_any(c.id)) order by c.sort, c.label) from public.chart_catalog c where c.kind = 'intervention' and c.active), '[]'),
    'medications',   coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'label', c.label, 'group', c.grp, 'in_game', c.in_game, 'scope', c.scope, 'mine', public.chart_scope_any(c.id)) order by c.sort, c.label) from public.chart_catalog c where c.kind = 'medication' and c.active), '[]'),
    'assessments',   coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'label', c.label, 'group', c.grp) order by c.sort) from public.chart_catalog c where c.kind = 'assessment' and c.active), '[]'),
    'symptoms',      coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'label', c.label, 'group', c.grp) order by c.sort, c.label) from public.chart_catalog c where c.kind = 'symptom' and c.active), '[]'),
    'diagnoses',     coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'label', c.label, 'group', c.grp) order by c.sort, c.label) from public.chart_catalog c where c.kind = 'diagnosis' and c.active), '[]'),
    'orders',        coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'label', c.label) order by c.sort, c.label) from public.chart_catalog c where c.kind = 'order' and c.active), '[]'),
    'capabilities',  coalesce((select jsonb_object_agg(c.id, jsonb_build_object('label', c.label, 'scope', c.scope, 'mine', public.chart_scope_any(c.id))) from public.chart_catalog c where c.kind = 'cap'), '{}'),
    'vitals', '[{"key":"sbp","label":"BP sys","unit":"mmHg","min":0,"max":300,"source":"portal"},{"key":"dbp","label":"BP dia","unit":"mmHg","min":0,"max":200,"source":"portal"},{"key":"hr","label":"HR","unit":"bpm","min":0,"max":300,"source":"portal"},{"key":"temp_f","label":"Temp","unit":"°F","min":80,"max":110,"source":"portal"},{"key":"spo2","label":"SpO₂","unit":"%","min":0,"max":100,"source":"monitor"},{"key":"pulse","label":"Pulse","unit":"bpm","min":0,"max":300,"source":"monitor"},{"key":"etco2","label":"CO₂","unit":"mmHg","min":0,"max":100,"source":"monitor"},{"key":"rr","label":"RR","unit":"/min","min":0,"max":80,"source":"monitor"},{"key":"glucose","label":"Glucose","unit":"mg/dL","min":10,"max":900,"source":"other"},{"key":"pain","label":"Pain","unit":"/10","min":0,"max":10,"source":"other"},{"key":"avpu","label":"AVPU","options":["A","V","P","U"],"source":"other"}]'::jsonb,
    'arrivals', '[{"id":"walk_in","label":"Walk-in"},{"id":"ambulance","label":"Ambulance"},{"id":"helicopter","label":"Helicopter"}]'::jsonb,
    'dispositions', '[{"id":"discharged","label":"Discharged"},{"id":"admitted","label":"Admitted"},{"id":"or","label":"To surgery"},{"id":"transferred","label":"Transferred"},{"id":"deceased","label":"Deceased"},{"id":"ama","label":"Left against advice"}]'::jsonb,
    'esi', '[{"level":1,"label":"Resuscitation","hint":"Needs a lifesaving action now"},{"level":2,"label":"Emergent","hint":"High risk, confused, or severe pain or distress"},{"level":3,"label":"Urgent","hint":"Needs two or more kinds of resources"},{"level":4,"label":"Less urgent","hint":"Needs one kind of resource"},{"level":5,"label":"Non-urgent","hint":"Needs no resources"}]'::jsonb,
    'age_bands', '["Infant","Child","Teen","Adult","Older adult"]'::jsonb,
    'sexes', '["Female","Male","Other"]'::jsonb) into j;
  return j;
end $$;

drop function if exists public.chart_open(jsonb, text, text, int, text, jsonb, text);
create or replace function public.chart_open(patient jsonb, complaint text, arrival text default 'walk_in', esi int default null,
                                             department text default null, entries jsonb default null, disposition text default null,
                                             room text default null, symptoms jsonb default null, history jsonb default null, diagnosis text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare dep text := public.chart_dept_for(department); cid bigint; nm text := nullif(btrim(coalesce(patient->>'name', '')), ''); e jsonb;
        nato text[] := array['Alpha','Bravo','Charlie','Delta','Echo','Foxtrot','Golf','Hotel','India','Juliet','Kilo','Lima','Mike','November','Oscar','Papa','Quebec','Romeo','Sierra','Tango','Uniform','Victor','Whiskey','X-ray','Yankee','Zulu'];
        cp text := nullif(btrim(coalesce(complaint, '')), '');
begin
  if cp is null then raise exception 'Pick or write the chief complaint.'; end if;
  if char_length(cp) > 120 then raise exception 'Keep the complaint under 120 characters.'; end if;
  if coalesce(arrival, 'walk_in') not in ('walk_in', 'ambulance', 'helicopter') then raise exception 'Arrival must be walk-in, ambulance or helicopter.'; end if;
  if nm is not null and char_length(nm) > 80 then raise exception 'Keep the patient name under 80 characters.'; end if;
  if patient ? 'age_band' and patient->>'age_band' is not null and patient->>'age_band' not in ('Infant', 'Child', 'Teen', 'Adult', 'Older adult') then raise exception 'Unknown age band.'; end if;
  if patient ? 'sex' and patient->>'sex' is not null and patient->>'sex' not in ('Female', 'Male', 'Other') then raise exception 'Unknown sex.'; end if;
  if esi is not null and (esi < 1 or esi > 5) then raise exception 'ESI must be 1 to 5.'; end if;
  if patient ? 'age' and patient->>'age' is not null and (patient->>'age' !~ '^\d{1,3}$' or (patient->>'age')::int > 120) then raise exception 'Age must be 0 to 120.'; end if;
  if esi is not null and not public.chart_scope_any('esi') then raise exception 'Only RN-level staff and above can set the ESI.'; end if;
  insert into public.chart_cases (patient_name, patient_alias, age_band, sex, roblox_username, complaint, arrival, esi, esi_by, esi_by_name,
                                  department, opened_by, opened_by_name, session_id, shift_id)
  values (coalesce(nm, 'Unknown'), nm is null, patient->>'age_band', patient->>'sex', nullif(btrim(coalesce(patient->>'roblox_username', '')), ''),
          cp, coalesce(arrival, 'walk_in'), esi, case when esi is not null then public.my_discord_id() end, case when esi is not null then public.chart_my_name() end,
          dep, public.my_discord_id(), public.chart_my_name(), public.chart_live_session(), public.chart_my_shift())
  returning id into cid;
  update public.chart_cases x set age = (patient->>'age')::smallint, room = nullif(btrim(coalesce(chart_open.room, '')), ''),
         symptoms = public.chart_norm_symptoms(chart_open.symptoms)
   where x.id = cid;
  if history is not null or diagnosis is not null then
    perform public.chart_update_core(cid, coalesce(history, '{}'::jsonb) || case when diagnosis is not null then jsonb_build_object('diagnosis', diagnosis) else '{}'::jsonb end, true);
  end if;
  if nm is null then update public.chart_cases set patient_name = 'Unknown ' || nato[1 + (cid % 26)::int] || '-' || cid where id = cid; end if;
  if esi is not null then
    insert into public.chart_entries (case_id, kind, department, data, author, author_name, author_rank, author_rank_label, shift_id, session_id)
    select cid, 'triage', dep, jsonb_build_object('esi', esi), public.my_discord_id(), public.chart_my_name(), x.rank, x.rank_label, public.chart_my_shift(), public.chart_live_session()
    from public.chart_my_depts() x where x.name = dep;
  end if;
  if entries is not null then
    if jsonb_typeof(entries) <> 'array' or jsonb_array_length(entries) > 30 then raise exception 'Quick log entries must be a list of at most 30.'; end if;
    for e in select * from jsonb_array_elements(entries) loop
      perform public.chart_add_core(cid, e->>'kind', e->'data', dep);
    end loop;
  end if;
  if disposition is not null then perform public.chart_close(cid, disposition, null); end if;
  return public.chart_get(cid);
end $$;


-- Fill details in as the case goes (owner: cases take ~11 minutes). Each call logs an 'update' entry (old -> new), and a
-- diagnosis change logs a 'diagnosis' entry; nothing is overwritten silently. quiet = true (from chart_open) skips the log.
create or replace function public.chart_update_core(case_id bigint, changes jsonb, quiet boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c public.chart_cases; dep text; k text; ch jsonb := '{}'::jsonb; t text; ok text[] := array['room', 'age', 'sex', 'roblox_username', 'symptoms', 'allergies',
        'nkda', 'past_history', 'last_intake', 'onset', 'diagnosis']; newsym text[]; dx text;
begin
  if not public.chart_can_write() then raise exception 'Only clinical staff can write in the CBH Chart.'; end if;
  if changes is null or jsonb_typeof(changes) <> 'object' then raise exception 'Nothing to change.'; end if;
  for k in select jsonb_object_keys(changes) loop
    if not k = any (ok) then raise exception 'Can''t change "%".', k; end if;
  end loop;
  select * into c from public.chart_cases where id = chart_update_core.case_id for update;
  if c.id is null then raise exception 'That case doesn''t exist.'; end if;
  if c.status <> 'open' then raise exception 'This case is %.', c.status; end if;
  dep := public.chart_dept_for(null);
  foreach k in array array['room', 'roblox_username', 'allergies', 'past_history', 'last_intake', 'onset'] loop
    if changes ? k then
      t := nullif(btrim(coalesce(changes->>k, '')), '');
      if t is not null and char_length(t) > (array[40, 200])[1 + (not k = any (array['room', 'roblox_username']))::int] then raise exception 'Keep % shorter.', replace(k, '_', ' '); end if;
      if t is distinct from (to_jsonb(c)->>k) then ch := ch || jsonb_build_object(k, jsonb_build_array(to_jsonb(c)->k, t)); end if;
    end if;
  end loop;
  if changes ? 'age' then
    if changes->>'age' is not null and (changes->>'age' !~ '^\d{1,3}$' or (changes->>'age')::int > 120) then raise exception 'Age must be 0 to 120.'; end if;
    if (changes->>'age')::int is distinct from c.age then ch := ch || jsonb_build_object('age', jsonb_build_array(c.age, (changes->>'age')::int)); end if;
  end if;
  if changes ? 'sex' then
    if changes->>'sex' is not null and changes->>'sex' not in ('Female', 'Male', 'Other') then raise exception 'Unknown sex.'; end if;
    if changes->>'sex' is distinct from c.sex then ch := ch || jsonb_build_object('sex', jsonb_build_array(c.sex, changes->>'sex')); end if;
  end if;
  if changes ? 'nkda' then
    if changes->>'nkda' is not null and jsonb_typeof(changes->'nkda') <> 'boolean' then raise exception 'No known allergies must be true or false.'; end if;
    if (changes->>'nkda')::boolean is distinct from c.nkda then ch := ch || jsonb_build_object('nkda', jsonb_build_array(c.nkda, (changes->>'nkda')::boolean)); end if;
  end if;
  if changes ? 'symptoms' then
    newsym := public.chart_norm_symptoms(changes->'symptoms');
    if newsym is distinct from c.symptoms then ch := ch || jsonb_build_object('symptoms', jsonb_build_array(to_jsonb(c.symptoms), to_jsonb(newsym))); end if;
  end if;
  if changes ? 'diagnosis' then
    dx := nullif(btrim(coalesce(changes->>'diagnosis', '')), '');
    if dx is not null and char_length(dx) > 60 then raise exception 'Keep the diagnosis under 60 characters.'; end if;
  end if;
  update public.chart_cases x set
      room = case when ch ? 'room' then ch->'room'->>1 else x.room end,
      roblox_username = case when ch ? 'roblox_username' then ch->'roblox_username'->>1 else x.roblox_username end,
      allergies = case when ch ? 'allergies' then ch->'allergies'->>1 else x.allergies end,
      past_history = case when ch ? 'past_history' then ch->'past_history'->>1 else x.past_history end,
      last_intake = case when ch ? 'last_intake' then ch->'last_intake'->>1 else x.last_intake end,
      onset = case when ch ? 'onset' then ch->'onset'->>1 else x.onset end,
      age = case when ch ? 'age' then (ch->'age'->>1)::smallint else x.age end,
      sex = case when ch ? 'sex' then ch->'sex'->>1 else x.sex end,
      nkda = case when ch ? 'nkda' then (ch->'nkda'->>1)::boolean else x.nkda end,
      symptoms = case when ch ? 'symptoms' then newsym else x.symptoms end,
      last_at = now()
  where x.id = c.id;
  if ch <> '{}'::jsonb and not quiet then
    insert into public.chart_entries (case_id, kind, department, data, author, author_name, author_rank, author_rank_label, shift_id, session_id)
    select c.id, 'update', dep, jsonb_build_object('changed', ch), public.my_discord_id(), public.chart_my_name(), x.rank, x.rank_label, public.chart_my_shift(), public.chart_live_session()
    from public.chart_my_depts() x where x.name = dep;
  end if;
  if changes ? 'diagnosis' and dx is distinct from c.diagnosis then
    update public.chart_cases set diagnosis = dx, diagnosis_by = case when dx is null then null else public.my_discord_id() end,
           diagnosis_by_name = case when dx is null then null else public.chart_my_name() end, diagnosis_at = case when dx is null then null else now() end, last_at = now()
    where id = c.id;
    insert into public.chart_entries (case_id, kind, department, data, author, author_name, author_rank, author_rank_label, shift_id, session_id)
    select c.id, 'diagnosis', dep, jsonb_strip_nulls(jsonb_build_object('id', dx, 'label', case when dx is null then 'Pending' else public.chart_label('diagnosis', dx) end,
           'from', case when c.diagnosis is null then null else public.chart_label('diagnosis', c.diagnosis) end)),
           public.my_discord_id(), public.chart_my_name(), x.rank, x.rank_label, public.chart_my_shift(), public.chart_live_session()
    from public.chart_my_depts() x where x.name = dep;
  end if;
  return public.chart_case_json(c.id);
end $$;

create or replace function public.chart_update(case_id bigint, changes jsonb)
returns jsonb language sql security definer set search_path = '' as $$
  select public.chart_update_core(case_id, changes, false)
$$;


create or replace function public.chart_activity(since timestamptz, until timestamptz default now(), department text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare me text := public.my_discord_id();
begin
  if not public.chart_can_read() then raise exception 'The CBH Chart is for clinical staff and Administration.'; end if;
  if since is null then raise exception 'Give a start date.'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('discord_id', a.who, 'name', coalesce(m.display_name, a.who), 'department', a.dept,
      'cases_led', a.cases_led, 'entries', a.entries, 'handoffs', a.handoffs, 'cosigns_given', a.cosigns, 'active_days', a.days)
      order by a.dept, a.entries + a.cases_led desc)
    from (
      select x.who, x.dept, sum(x.cases_led)::int cases_led, sum(x.entries)::int entries, sum(x.handoffs)::int handoffs, sum(x.cosigns)::int cosigns,
             count(distinct x.d_day) filter (where x.d_day is not null)::int days
      from (
        select c.opened_by who, c.department dept, 1 cases_led, 0 entries, 0 handoffs, 0 cosigns, (c.opened_at at time zone 'UTC')::date as d_day
          from public.chart_cases c where c.status <> 'void' and c.opened_at >= since and c.opened_at <= until
        union all
        select e.author, e.department, 0, 1, (e.kind = 'handoff')::int, 0, (e.at at time zone 'UTC')::date
          from public.chart_entries e join public.chart_cases c on c.id = e.case_id
          where e.error_at is null and e.kind <> 'update' and c.status <> 'void' and e.at >= since and e.at <= until
        union all
        select e.cosigned_by, e.department, 0, 0, 0, 1, null::date
          from public.chart_entries e where e.cosigned_at >= since and e.cosigned_at <= until and e.error_at is null
      ) x
      where (chart_activity.department is null or x.dept = chart_activity.department)
        and (public.is_exec() or x.who = me or public.has_perm('activity.view', x.dept))
      group by x.who, x.dept
    ) a left join public.members m on m.discord_id = a.who), '[]'::jsonb);
end $$;

create or replace function public.chart_recognition(since timestamptz, until timestamptz, top_n int default 3)
returns jsonb language sql stable security definer set search_path = '' as $$
  with x as (
    select c.opened_by who, c.department dept, 1 cases_led, 0 entries, 0 handoffs
      from public.chart_cases c where c.status <> 'void' and c.opened_at >= since and c.opened_at < until
    union all
    select e.author, e.department, 0, 1, (e.kind = 'handoff')::int
      from public.chart_entries e join public.chart_cases c on c.id = e.case_id
      where e.error_at is null and e.kind <> 'update' and c.status <> 'void' and e.at >= since and e.at < until
  ), per as (
    select who, dept, sum(cases_led)::int cases_led, sum(entries)::int entries, sum(handoffs)::int handoffs,
           (3 * sum(cases_led) + sum(entries) + 2 * sum(handoffs))::int points
    from x group by who, dept
  ), ranked as (
    select p.*, row_number() over (partition by dept order by points desc, cases_led desc, who) rn from per p
  )
  select coalesce(jsonb_object_agg(d.dept, d.j), '{}'::jsonb) from (
    select r.dept, jsonb_build_object(
      'cases', (select sum(cases_led) from per q where q.dept = r.dept), 'entries', (select sum(entries) from per q where q.dept = r.dept),
      'people', (select count(*) from per q where q.dept = r.dept),
      'top', jsonb_agg(jsonb_build_object('discord_id', r.who, 'name', coalesce(m.display_name, r.who), 'cases_led', r.cases_led,
               'entries', r.entries, 'handoffs', r.handoffs, 'points', r.points) order by r.rn) filter (where r.rn <= greatest(top_n, 1))) j
    from ranked r left join public.members m on m.discord_id = r.who
    group by r.dept
    having (select sum(cases_led) + sum(entries) from per q where q.dept = r.dept) > 0
  ) d
$$;


do $g$
declare f text;
begin
  foreach f in array array['chart_norm_symptoms(jsonb)', 'chart_label(text, text)', 'chart_latest_vitals(bigint)', 'chart_case_json(bigint)', 'chart_add_core(bigint, text, jsonb, text)', 'chart_update_core(bigint, jsonb, boolean)'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['chart_open(jsonb, text, text, int, text, jsonb, text, text, jsonb, jsonb, text)', 'chart_update(bigint, jsonb)',
                           'chart_list(text, boolean, bigint, text, text, bigint, int)', 'chart_error(bigint, text)', 'chart_catalog()',
                           'chart_activity(timestamptz, timestamptz, text)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  revoke execute on function public.chart_recognition(timestamptz, timestamptz, int) from public, anon, authenticated;
  grant execute on function public.chart_recognition(timestamptz, timestamptz, int) to service_role;
end $g$;

