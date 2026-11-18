-- 0063: CBH Chart v1 RPCs (Alpha). Contract: Plans/CareBeyond/chart/CONTRACT.md. All writes go through here.

-- ---------- internal helpers (not callable by clients) ----------
-- My rank in a department: rank_order of my highest rank there (Y1..Y5 = 1..5, Director = 6); a member with no rank = 1;
-- owners count as 6 everywhere; not a member = 0.
create or replace function public.chart_rank(dept text)
returns int language sql stable security definer set search_path = '' as $$
  select case when public.is_exec() then 6
              else coalesce((select max(coalesce(r.rank_order, 1)) from public.my_roles() r where r.department = dept and r.kind in ('department', 'rank')), 0) end
$$;

-- My clinical departments with rank (owners: every clinical department at 6).
create or replace function public.chart_my_depts()
returns table (name text, rank int, rank_label text) language sql stable security definer set search_path = '' as $$
  select d.name, public.chart_rank(d.name),
         case when public.is_exec() and not exists (select 1 from public.my_roles() r where r.department = d.name and r.kind = 'rank') then 'Owner'
              else (select r.rank_label from public.my_roles() r where r.department = d.name and r.kind = 'rank' order by r.rank_order desc nulls last limit 1) end
  from public.departments d
  where d.clinical and public.chart_rank(d.name) > 0
  order by public.chart_rank(d.name) desc, d.sort, d.name
$$;

create or replace function public.chart_can_write()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.chart_my_depts())
$$;

-- The department I'm acting for: the one asked (must be mine), else my highest-ranked clinical department.
create or replace function public.chart_dept_for(dept text)
returns text language plpgsql stable security definer set search_path = '' as $$
declare d text;
begin
  if dept is not null then
    select x.name into d from public.chart_my_depts() x where x.name = dept;
    if d is null then raise exception 'You''re not in % as clinical staff.', dept; end if;
    return d;
  end if;
  select x.name into d from public.chart_my_depts() x limit 1;
  if d is null then raise exception 'Only clinical staff can write in the CBH Chart.'; end if;
  return d;
end $$;

-- In scope: my rank in that department meets the catalogue minimum. Unknown items and missing departments: out of scope.
create or replace function public.chart_scope_ok(item text, dept text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select public.chart_rank(dept) >= (c.scope->>dept)::int from public.chart_catalog c where c.id = item and c.scope ? dept), false)
$$;
-- In scope in ANY of my clinical departments (catalogue "mine", cosigning).
create or replace function public.chart_scope_any(item text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.chart_my_depts() d where public.chart_scope_ok(item, d.name))
$$;

create or replace function public.chart_my_name()
returns text language sql stable security definer set search_path = '' as $$
  select coalesce((select m.display_name from public.members m where m.discord_id = public.my_discord_id()), public.my_discord_id())
$$;
create or replace function public.chart_my_shift()
returns bigint language sql stable security definer set search_path = '' as $$
  select s.id from public.shifts s where s.discord_id = public.my_discord_id() and s.status <> 'ended' order by s.started_at desc limit 1
$$;
create or replace function public.chart_live_session()
returns bigint language sql stable security definer set search_path = '' as $$
  select coalesce((select s.session_id from public.shifts s where s.discord_id = public.my_discord_id() and s.status <> 'ended' and s.session_id is not null order by s.started_at desc limit 1),
                  (select x.id from public.sessions x where x.status = 'live' order by x.started_at desc nulls last limit 1))
$$;

create or replace function public.chart_entry_json(e public.chart_entries)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', e.id, 'case_id', e.case_id, 'kind', e.kind, 'department', e.department, 'item', e.item,
    'label', (select c.label from public.chart_catalog c where c.id = e.item), 'data', e.data,
    'author', e.author, 'author_name', e.author_name, 'author_rank_label', e.author_rank_label, 'at', e.at,
    'shift_id', e.shift_id, 'session_id', e.session_id,
    'needs_cosign', e.needs_cosign, 'cosigned_by_name', e.cosigned_by_name, 'cosigned_at', e.cosigned_at,
    'error', case when e.error_at is null then null else jsonb_build_object('by_name', e.error_by_name, 'at', e.error_at, 'reason', e.error_reason) end)
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
    'patient', jsonb_build_object('name', c.patient_name, 'alias', c.patient_alias, 'age_band', c.age_band, 'sex', c.sex, 'roblox_username', c.roblox_username),
    'complaint', c.complaint, 'complaint_label', coalesce((select k.label from public.chart_catalog k where k.id = c.complaint and k.kind = 'complaint'), c.complaint),
    'arrival', c.arrival, 'esi', c.esi, 'esi_by_name', c.esi_by_name, 'status', c.status, 'disposition', c.disposition, 'void_reason', c.void_reason,
    'opened_by', c.opened_by, 'opened_by_name', c.opened_by_name, 'department', c.department, 'opened_at', c.opened_at,
    'closed_at', c.closed_at, 'session_id', c.session_id, 'shift_id', c.shift_id, 'last_at', c.last_at,
    'latest_vitals', public.chart_latest_vitals(c.id),
    'pending_cosign', (select count(*) from public.chart_entries e where e.case_id = c.id and e.needs_cosign and e.cosigned_at is null and e.error_at is null))
  from public.chart_cases c where c.id = cid
$$;

-- Validate and insert one entry (shared by chart_add and chart_open's quick log). Returns the new entry id.
create or replace function public.chart_add_core(cid bigint, k text, d jsonb, dept text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare cs public.chart_cases; dep text := public.chart_dept_for(dept); it text; cat public.chart_catalog; v text; n numeric; eid bigint;
        lim jsonb := '{"hr":[0,300],"sbp":[0,300],"dbp":[0,200],"rr":[0,80],"spo2":[0,100],"temp_f":[80,110],"glucose":[10,900],"pain":[0,10]}';
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
  elsif k = 'note' then
    if nullif(btrim(coalesce(d->>'text', '')), '') is null then raise exception 'Write the note first.'; end if;
    clean := jsonb_build_object('text', left(btrim(d->>'text'), 1000));
  else
    raise exception 'Unknown entry kind "%".', k;
  end if;
  insert into public.chart_entries (case_id, kind, department, item, data, author, author_name, author_rank, author_rank_label, shift_id, session_id, needs_cosign)
  select cid, k, dep, case when k in ('intervention', 'medication') then it end, clean, public.my_discord_id(), public.chart_my_name(),
         x.rank, x.rank_label, public.chart_my_shift(), public.chart_live_session(), cosign
  from public.chart_my_depts() x where x.name = dep
  returning id into eid;
  update public.chart_cases set last_at = now() where id = cid;
  return eid;
end $$;

-- ---------- client RPCs ----------
create or replace function public.chart_me()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare ds jsonb;
begin
  if not public.chart_can_read() then
    return jsonb_build_object('can_read', false, 'can_write', false, 'owner', false, 'qa', false, 'departments', '[]'::jsonb, 'can_esi', false, 'cosign_waiting', 0);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('name', x.name, 'rank', x.rank, 'rank_label', x.rank_label)), '[]'::jsonb) into ds from public.chart_my_depts() x;
  return jsonb_build_object('can_read', true, 'can_write', public.chart_can_write(), 'owner', public.is_exec(), 'qa', public.in_dept('Administration'),
    'departments', ds, 'default_department', ds->0->>'name', 'can_esi', public.chart_scope_any('esi'),
    'shift_id', public.chart_my_shift(), 'session_id', public.chart_live_session(),
    'cosign_waiting', (select count(*) from public.chart_entries e
                        where e.needs_cosign and e.cosigned_at is null and e.error_at is null and e.author <> public.my_discord_id()
                          and public.chart_scope_any(coalesce(e.item, case when e.kind = 'disposition' then 'disposition' end))));
end $$;

create or replace function public.chart_catalog()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare j jsonb;
begin
  if not public.chart_can_read() then raise exception 'The CBH Chart is for clinical staff and Administration.'; end if;
  select jsonb_build_object(
    'complaints',    coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'label', c.label, 'group', c.grp, 'in_game', c.in_game) order by c.sort, c.label) from public.chart_catalog c where c.kind = 'complaint' and c.active), '[]'),
    'interventions', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'label', c.label, 'group', c.grp, 'in_game', c.in_game, 'scope', c.scope, 'mine', public.chart_scope_any(c.id)) order by c.sort, c.label) from public.chart_catalog c where c.kind = 'intervention' and c.active), '[]'),
    'medications',   coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'label', c.label, 'group', c.grp, 'in_game', c.in_game, 'scope', c.scope, 'mine', public.chart_scope_any(c.id)) order by c.sort, c.label) from public.chart_catalog c where c.kind = 'medication' and c.active), '[]'),
    'assessments',   coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'label', c.label, 'group', c.grp) order by c.sort) from public.chart_catalog c where c.kind = 'assessment' and c.active), '[]'),
    'capabilities',  coalesce((select jsonb_object_agg(c.id, jsonb_build_object('label', c.label, 'scope', c.scope, 'mine', public.chart_scope_any(c.id))) from public.chart_catalog c where c.kind = 'cap'), '{}'),
    'vitals', '[{"key":"hr","label":"HR","unit":"bpm","min":0,"max":300},{"key":"sbp","label":"BP sys","unit":"mmHg","min":0,"max":300},{"key":"dbp","label":"BP dia","unit":"mmHg","min":0,"max":200},{"key":"rr","label":"RR","unit":"/min","min":0,"max":80},{"key":"spo2","label":"SpO₂","unit":"%","min":0,"max":100},{"key":"temp_f","label":"Temp","unit":"°F","min":80,"max":110},{"key":"glucose","label":"Glucose","unit":"mg/dL","min":10,"max":900},{"key":"pain","label":"Pain","unit":"/10","min":0,"max":10},{"key":"avpu","label":"AVPU","options":["A","V","P","U"]}]'::jsonb,
    'arrivals', '[{"id":"walk_in","label":"Walk-in"},{"id":"ambulance","label":"Ambulance"},{"id":"helicopter","label":"Helicopter"}]'::jsonb,
    'dispositions', '[{"id":"discharged","label":"Discharged"},{"id":"admitted","label":"Admitted"},{"id":"or","label":"To surgery"},{"id":"transferred","label":"Transferred"},{"id":"deceased","label":"Deceased"},{"id":"ama","label":"Left against advice"}]'::jsonb,
    'esi', '[{"level":1,"label":"Resuscitation","hint":"Needs a lifesaving action now"},{"level":2,"label":"Emergent","hint":"High risk, confused, or severe pain or distress"},{"level":3,"label":"Urgent","hint":"Needs two or more kinds of resources"},{"level":4,"label":"Less urgent","hint":"Needs one kind of resource"},{"level":5,"label":"Non-urgent","hint":"Needs no resources"}]'::jsonb,
    'age_bands', '["Infant","Child","Teen","Adult","Older adult"]'::jsonb,
    'sexes', '["Female","Male","Other"]'::jsonb) into j;
  return j;
end $$;

-- Open a case. Optional quick log (Delta): entries [{kind, data}] and a disposition, all in this one transaction.
create or replace function public.chart_open(patient jsonb, complaint text, arrival text default 'walk_in', esi int default null,
                                             department text default null, entries jsonb default null, disposition text default null)
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
  if esi is not null and not public.chart_scope_any('esi') then raise exception 'Only RN-level staff and above can set the ESI.'; end if;
  insert into public.chart_cases (patient_name, patient_alias, age_band, sex, roblox_username, complaint, arrival, esi, esi_by, esi_by_name,
                                  department, opened_by, opened_by_name, session_id, shift_id)
  values (coalesce(nm, 'Unknown'), nm is null, patient->>'age_band', patient->>'sex', nullif(btrim(coalesce(patient->>'roblox_username', '')), ''),
          cp, coalesce(arrival, 'walk_in'), esi, case when esi is not null then public.my_discord_id() end, case when esi is not null then public.chart_my_name() end,
          dep, public.my_discord_id(), public.chart_my_name(), public.chart_live_session(), public.chart_my_shift())
  returning id into cid;
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

create or replace function public.chart_get(case_id bigint)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c public.chart_cases; me text := public.my_discord_id();
begin
  if not public.chart_can_read() then raise exception 'The CBH Chart is for clinical staff and Administration.'; end if;
  select * into c from public.chart_cases where id = chart_get.case_id;
  if c.id is null then raise exception 'That case doesn''t exist.'; end if;
  return jsonb_build_object('case', public.chart_case_json(c.id),
    'entries', coalesce((select jsonb_agg(public.chart_entry_json(e) order by e.at, e.id) from public.chart_entries e where e.case_id = c.id), '[]'::jsonb),
    'can', jsonb_build_object(
      'add',   c.status = 'open' and public.chart_can_write(),
      'esi',   c.status = 'open' and public.chart_scope_any('esi'),
      'close', c.status = 'open' and public.chart_can_write(),
      'void',  c.status <> 'void' and (public.is_exec() or exists (select 1 from public.chart_my_depts() x where x.rank >= 6)
                 or (c.opened_by = me and not exists (select 1 from public.chart_entries e where e.case_id = c.id and e.author <> me)))));
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

create or replace function public.chart_add(case_id bigint, kind text, data jsonb, department text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare eid bigint; e public.chart_entries;
begin
  if not public.chart_can_write() then raise exception 'Only clinical staff can write in the CBH Chart.'; end if;
  eid := public.chart_add_core(chart_add.case_id, chart_add.kind, chart_add.data, chart_add.department);
  select * into e from public.chart_entries where id = eid;
  return public.chart_entry_json(e);
end $$;

create or replace function public.chart_set_esi(case_id bigint, esi int)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c public.chart_cases; dep text;
begin
  if not public.chart_scope_any('esi') then raise exception 'Only RN-level staff and above can set the ESI.'; end if;
  if esi is null or esi < 1 or esi > 5 then raise exception 'ESI must be 1 to 5.'; end if;
  select * into c from public.chart_cases where id = chart_set_esi.case_id for update;
  if c.id is null then raise exception 'That case doesn''t exist.'; end if;
  if c.status <> 'open' then raise exception 'This case is %.', c.status; end if;
  select x.name into dep from public.chart_my_depts() x where public.chart_scope_ok('esi', x.name) limit 1;
  update public.chart_cases set esi = chart_set_esi.esi, esi_by = public.my_discord_id(), esi_by_name = public.chart_my_name(), last_at = now() where id = c.id;
  insert into public.chart_entries (case_id, kind, department, data, author, author_name, author_rank, author_rank_label, shift_id, session_id)
  select c.id, 'triage', dep, jsonb_strip_nulls(jsonb_build_object('esi', chart_set_esi.esi, 'from', c.esi)), public.my_discord_id(), public.chart_my_name(),
         x.rank, x.rank_label, public.chart_my_shift(), public.chart_live_session()
  from public.chart_my_depts() x where x.name = dep;
  return public.chart_case_json(c.id);
end $$;

create or replace function public.chart_close(case_id bigint, disposition text, note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c public.chart_cases; dep text; cosign boolean;
begin
  if not public.chart_can_write() then raise exception 'Only clinical staff can write in the CBH Chart.'; end if;
  if disposition is null or disposition not in ('discharged', 'admitted', 'or', 'transferred', 'deceased', 'ama') then raise exception 'Pick a disposition.'; end if;
  select * into c from public.chart_cases where id = chart_close.case_id for update;
  if c.id is null then raise exception 'That case doesn''t exist.'; end if;
  if c.status <> 'open' then raise exception 'This case is already %.', c.status; end if;
  -- act for a department where it's in scope if I have one, else my main one (then it needs a cosign)
  select x.name into dep from public.chart_my_depts() x order by public.chart_scope_ok('disposition', x.name) desc, x.rank desc limit 1;
  cosign := disposition in ('discharged', 'admitted', 'transferred') and not public.chart_scope_ok('disposition', dep);
  insert into public.chart_entries (case_id, kind, department, item, data, author, author_name, author_rank, author_rank_label, shift_id, session_id, needs_cosign)
  select c.id, 'disposition', dep, 'disposition', jsonb_strip_nulls(jsonb_build_object('disposition', chart_close.disposition, 'note', left(nullif(btrim(coalesce(note, '')), ''), 500))),
         public.my_discord_id(), public.chart_my_name(), x.rank, x.rank_label, public.chart_my_shift(), public.chart_live_session(), cosign
  from public.chart_my_depts() x where x.name = dep;
  update public.chart_cases set status = 'closed', disposition = chart_close.disposition, closed_by = public.my_discord_id(), closed_at = now(), last_at = now() where id = c.id;
  return public.chart_case_json(c.id);
end $$;

create or replace function public.chart_cosign(entry_id bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare e public.chart_entries;
begin
  select * into e from public.chart_entries where id = entry_id for update;
  if e.id is null then raise exception 'That entry doesn''t exist.'; end if;
  if not e.needs_cosign then raise exception 'This entry doesn''t need a cosign.'; end if;
  if e.cosigned_at is not null then raise exception 'Already cosigned by %.', e.cosigned_by_name; end if;
  if e.error_at is not null then raise exception 'This entry was marked in error.'; end if;
  if e.author = public.my_discord_id() then raise exception 'Someone else has to cosign your entry.'; end if;
  if not public.chart_scope_any(e.item) then raise exception 'This is outside your scope too, so you can''t cosign it.'; end if;
  update public.chart_entries set cosigned_by = public.my_discord_id(), cosigned_by_name = public.chart_my_name(), cosigned_at = now() where id = e.id returning * into e;
  return public.chart_entry_json(e);
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
  if not (e.author = public.my_discord_id() or public.is_exec() or public.chart_rank(e.department) >= 6) then
    raise exception 'Only the author or the % Director can mark this in error.', e.department; end if;
  update public.chart_entries set error_at = now(), error_by = public.my_discord_id(), error_by_name = public.chart_my_name(), error_reason = left(why, 200)
  where id = e.id returning * into e;
  return public.chart_entry_json(e);
end $$;

create or replace function public.chart_void(case_id bigint, reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c public.chart_cases; me text := public.my_discord_id(); why text := nullif(btrim(coalesce(reason, '')), '');
begin
  select * into c from public.chart_cases where id = chart_void.case_id for update;
  if c.id is null then raise exception 'That case doesn''t exist.'; end if;
  if c.status = 'void' then raise exception 'Already void.'; end if;
  if why is null then raise exception 'Say why the case is void (e.g. duplicate).'; end if;
  if not (public.is_exec() or exists (select 1 from public.chart_my_depts() x where x.rank >= 6)
          or (c.opened_by = me and not exists (select 1 from public.chart_entries e where e.case_id = c.id and e.author <> me))) then
    raise exception 'Only the person who opened it (before others write in it) or a Director can void a case.'; end if;
  update public.chart_cases set status = 'void', void_reason = left(why, 200), last_at = now() where id = c.id;
  return public.chart_case_json(c.id);
end $$;

create or replace function public.chart_cosign_queue()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.chart_can_write() then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('entry_id', e.id, 'case_id', e.case_id, 'patient_name', c.patient_name, 'kind', e.kind,
      'item', e.item, 'label', coalesce(k.label, e.item), 'data', e.data, 'author_name', e.author_name, 'author_rank_label', e.author_rank_label,
      'department', e.department, 'at', e.at) order by e.at desc)
    from public.chart_entries e join public.chart_cases c on c.id = e.case_id left join public.chart_catalog k on k.id = e.item
    where e.needs_cosign and e.cosigned_at is null and e.error_at is null and c.status <> 'void'
      and e.author <> public.my_discord_id() and public.chart_scope_any(e.item)), '[]'::jsonb);
end $$;

-- grants: helpers stay private; client RPCs for signed-in members
do $g$
declare f text;
begin
  foreach f in array array['chart_rank(text)', 'chart_my_depts()', 'chart_can_write()', 'chart_dept_for(text)', 'chart_scope_ok(text, text)',
                           'chart_scope_any(text)', 'chart_my_name()', 'chart_my_shift()', 'chart_live_session()', 'chart_entry_json(public.chart_entries)',
                           'chart_latest_vitals(bigint)', 'chart_case_json(bigint)', 'chart_add_core(bigint, text, jsonb, text)'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['chart_me()', 'chart_catalog()', 'chart_open(jsonb, text, text, int, text, jsonb, text)', 'chart_get(bigint)',
                           'chart_list(text, boolean, bigint, text, text, bigint, int)', 'chart_add(bigint, text, jsonb, text)',
                           'chart_set_esi(bigint, int)', 'chart_close(bigint, text, text)', 'chart_cosign(bigint)', 'chart_error(bigint, text)',
                           'chart_void(bigint, text)', 'chart_cosign_queue()'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $g$;
