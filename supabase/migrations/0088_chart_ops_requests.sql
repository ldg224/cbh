-- 0088: CBH Chart operations, requests (consults) and charting (Bravo, 19 Nov 2026; BACKEND-PLAN §4.3-4.4, CONTRACT v1.2).
-- Request accept is atomic first-wins under the Chart lock. Entries keep the old chart_entries table (+ 0085 columns);
-- free text feeds chart_suggestions. Internal helpers revoked; the RPCs are for logged-in users only.

-- May I write in this case's record? The owner or pair, anyone who worked on it, an accepter of an open request, a Supervisor.
create or replace function public.chart_can_chart(c public.chart_cases, me text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(c.owner_id = me, false) or coalesce(c.pair_id = me, false) or coalesce(me = any (c.worked_by), false) or public.chart_is_sup()
      or exists (select 1 from public.chart_requests q where q.case_id = c.id and q.accepted_by = me and q.done_at is null and q.cancelled_at is null)
$$;

create or replace function public.chart_suggest_learn(p_kind text, p_text text) returns void
language sql volatile security definer set search_path = '' as $$
  insert into public.chart_suggestions as s (kind, norm, label, uses, last_used)
  select p_kind, lower(btrim(p_text)), left(btrim(p_text), 120), 1, now()
  where p_kind is not null and nullif(btrim(coalesce(p_text, '')), '') is not null and char_length(btrim(p_text)) <= 120
  on conflict (kind, norm) do update set uses = s.uses + 1, last_used = now(), label = excluded.label
$$;

-- Validate and write one entry. Returns its id.
create or replace function public.chart_add_entry(p_case bigint, p_kind text, p_data jsonb, p_entered_for text default null) returns bigint
language plpgsql volatile security definer set search_path = '' as $$
declare me text := public.my_discord_id(); k text; v numeric; lim numeric[]; txt text; d jsonb := coalesce(p_data, '{}'::jsonb); id bigint;
  ranges constant jsonb := '{"hr":[20,250],"sys":[40,260],"dia":[20,160],"temp":[85,110],"spo2":[50,100],"co2":[5,80],"rr":[4,60],"pain":[0,10]}';
begin
  if p_kind not in ('vitals', 'intervention', 'order', 'result', 'diagnosis', 'note', 'handoff') then perform public.chart_err('bad_input', 'Unknown entry type.'); end if;
  if jsonb_typeof(d) <> 'object' then perform public.chart_err('bad_input', 'Entry data must be an object.'); end if;
  if p_kind = 'vitals' then
    if d = '{}'::jsonb then perform public.chart_err('bad_input', 'Add at least one number.'); end if;
    for k in select jsonb_object_keys(d) loop
      if not ranges ? k then perform public.chart_err('bad_input', format('Unknown vital "%s".', k)); end if;
      begin v := (d->>k)::numeric; exception when others then perform public.chart_err('bad_input', format('%s must be a number.', k)); end;
      if v < (ranges->k->>0)::numeric or v > (ranges->k->>1)::numeric then
        perform public.chart_err('bad_input', format('%s must be between %s and %s.', k, ranges->k->>0, ranges->k->>1));
      end if;
    end loop;
  else
    txt := nullif(btrim(coalesce(d->>'text', '')), '');
    if txt is null then perform public.chart_err('bad_input', 'Type something first.'); end if;
    if char_length(txt) > 300 then perform public.chart_err('too_long', 'Keep it under 300 characters.'); end if;
    if p_kind = 'diagnosis' and char_length(txt) > 60 then perform public.chart_err('too_long', 'Keep the diagnosis under 60 characters.'); end if;
    for k in select jsonb_object_keys(d) loop
      if k not in ('text', 'who', 'order_id') then perform public.chart_err('bad_input', format('Unknown field "%s".', k)); end if;
    end loop;
    d := jsonb_strip_nulls(jsonb_build_object('text', txt, 'who', left(nullif(btrim(coalesce(d->>'who', '')), ''), 40),
                                              'order_id', case when d ? 'order_id' then (d->>'order_id')::bigint end));
  end if;
  insert into public.chart_entries (case_id, kind, department, data, author, author_name, entered_for, shift_id, session_id)
  values (p_case, p_kind, coalesce((select s.department from public.chart_staff s where s.discord_id = me), 'Nursing'), d, me,
          public.chart_short(me), nullif(p_entered_for, ''), (select s.shift_id from public.chart_staff s where s.discord_id = me), public.chart_session_live())
  returning chart_entries.id into id;
  if p_kind = 'diagnosis' then
    update public.chart_cases set diagnosis = txt, diagnosis_by = me, diagnosis_by_name = public.chart_short(me), diagnosis_at = now() where chart_cases.id = p_case;
  end if;
  perform public.chart_suggest_learn(case p_kind when 'intervention' then 'did' when 'order' then 'order' when 'result' then 'result' when 'diagnosis' then 'diagnosis' end, txt);
  perform public.chart_worked(p_case, coalesce(nullif(p_entered_for, ''), me));
  return id;
end $$;

-- ---------- requests ----------
create or replace function public.chart_request(p_case bigint, p_kind text, p_note text default null, p_surgery_mode text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare me public.chart_staff := public.chart_begin(); c public.chart_cases := public.chart_case_row(p_case); rid bigint;
begin
  if c.status <> 'open' then perform public.chart_err('bad_state', 'That visit has ended.'); end if;
  if p_kind not in ('doctor', 'surgery', 'imaging', 'help') then perform public.chart_err('bad_input', 'Pick Doctor, Surgery, Imaging or Help (Code has its own button).'); end if;
  if not public.chart_can_chart(c, me.discord_id) then perform public.chart_err('no_access', 'Only someone on this patient can ask.'); end if;
  if p_kind = 'surgery' and coalesce(p_surgery_mode, 'come_down') not in ('come_down', 'take_to_surgery') then perform public.chart_err('bad_input', 'Come down, or take to surgery?'); end if;
  if char_length(coalesce(p_note, '')) > 200 then perform public.chart_err('too_long', 'Keep the note under 200 characters.'); end if;
  if exists (select 1 from public.chart_requests q where q.case_id = c.id and q.kind = p_kind and q.done_at is null and q.cancelled_at is null) then
    perform public.chart_err('bad_state', 'There''s already an open request of that kind.');
  end if;
  insert into public.chart_requests (case_id, kind, surgery_mode, note, red, asked_by)
  values (c.id, p_kind, case when p_kind = 'surgery' then coalesce(p_surgery_mode, 'come_down') end, nullif(btrim(coalesce(p_note, '')), ''), c.esi = 1, me.discord_id)
  returning id into rid;
  if p_kind = 'imaging' then update public.chart_cases set off_ward = coalesce(off_ward, 'Radiology') where id = c.id; end if;
  perform public.chart_act('request', c.id, jsonb_build_object('kind', p_kind, 'note', p_note), null, rid);
  return public.chart_done(jsonb_build_object('request_id', rid));
end $$;

create or replace function public.chart_req_row(p_id bigint) returns public.chart_requests
language plpgsql stable security definer set search_path = '' as $$
declare q public.chart_requests;
begin
  select * into q from public.chart_requests x where x.id = p_id;
  if q.id is null then perform public.chart_err('bad_state', 'That request is gone.'); end if;
  return q;
end $$;

create or replace function public.chart_request_accept(p_id bigint) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare me public.chart_staff := public.chart_begin(); q public.chart_requests := public.chart_req_row(p_id); n int;
begin
  if q.kind = 'imaging' then perform public.chart_err('wrong_role', 'The nurse does imaging: it''s only a marker.'); end if;
  if q.kind = 'doctor' and not ((coalesce(me.role, '') = 'on_call' and coalesce(me.department, '') = 'Medical') or coalesce(me.role, '') = 'supervisor') then
    perform public.chart_err('wrong_role', 'Doctor requests are for Medical on call.'); end if;
  if q.kind = 'surgery' and not (coalesce(me.role, '') = 'on_call' and coalesce(me.department, '') = 'Surgical') then perform public.chart_err('wrong_role', 'Surgery requests are for Surgical on call.'); end if;
  if q.kind = 'help' and (me.role is null or coalesce(me.role, '') = 'reception') then perform public.chart_err('wrong_role', 'Help is for Patient Care.'); end if;
  if q.kind = 'code' and me.role is null then perform public.chart_err('wrong_role', 'Pick a role first.'); end if;
  if q.asked_by = me.discord_id and q.kind <> 'code' then perform public.chart_err('wrong_role', 'You asked for this one.'); end if;
  update public.chart_requests set accepted_by = me.discord_id, accepted_at = now()
  where id = q.id and accepted_by is null and done_at is null and cancelled_at is null;
  get diagnostics n = row_count;
  if n = 0 then
    select * into q from public.chart_requests where id = p_id;
    if q.accepted_by is not null then perform public.chart_err('taken', format('%s took it.', rtrim(public.chart_short(q.accepted_by), '.'))); end if;
    perform public.chart_err('bad_state', 'That request is closed.');
  end if;
  perform public.chart_worked(q.case_id, me.discord_id);
  perform public.chart_notice(q.asked_by, format('%s is coming for %s.', rtrim(public.chart_short(me.discord_id), '.'),
          (select public.checkin_short_name(c.patient_name) from public.chart_cases c where c.id = q.case_id)));
  perform public.chart_act('request_accept', q.case_id, jsonb_build_object('kind', q.kind), null, q.id);
  return public.chart_done();
end $$;

create or replace function public.chart_request_here(p_id bigint) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare me public.chart_staff := public.chart_begin(); q public.chart_requests := public.chart_req_row(p_id);
begin
  if q.accepted_by is distinct from me.discord_id or q.done_at is not null or q.cancelled_at is not null then perform public.chart_err('bad_state', 'That isn''t your open request.'); end if;
  update public.chart_requests set here_at = coalesce(here_at, now()) where id = q.id;
  perform public.chart_act('request_here', q.case_id, '{}', null, q.id);
  return public.chart_done();
end $$;

create or replace function public.chart_request_done(p_id bigint, p_note text default null, p_entries jsonb default '[]'::jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare me public.chart_staff := public.chart_begin(); q public.chart_requests := public.chart_req_row(p_id); e jsonb;
begin
  if q.accepted_by is distinct from me.discord_id and not public.chart_is_sup() then perform public.chart_err('bad_state', 'That isn''t your request.'); end if;
  if q.done_at is not null or q.cancelled_at is not null then perform public.chart_err('bad_state', 'That request is closed.'); end if;
  if char_length(coalesce(p_note, '')) > 500 then perform public.chart_err('too_long', 'Keep the note under 500 characters.'); end if;
  if p_entries is not null and jsonb_typeof(p_entries) = 'array' then
    if jsonb_array_length(p_entries) > 12 then perform public.chart_err('bad_input', 'Up to 12 entries at once.'); end if;
    for e in select * from jsonb_array_elements(p_entries) loop
      perform public.chart_add_entry(q.case_id, e->>'kind', e->'data', null);
    end loop;
  end if;
  update public.chart_requests set done_at = now(), done_note = nullif(btrim(coalesce(p_note, '')), ''), here_at = coalesce(here_at, now()) where id = q.id;
  if q.kind = 'imaging' then update public.chart_cases set off_ward = null where id = q.case_id and off_ward = 'Radiology'; end if;
  perform public.chart_act('request_done', q.case_id, jsonb_build_object('kind', q.kind), null, q.id);
  return public.chart_done();
end $$;

create or replace function public.chart_request_cancel(p_id bigint, p_reason text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare me public.chart_staff := public.chart_begin(); q public.chart_requests := public.chart_req_row(p_id);
begin
  if q.asked_by is distinct from me.discord_id and not public.chart_is_sup() then perform public.chart_err('no_access', 'Only who asked, or the Supervisor, can cancel it.'); end if;
  if q.done_at is not null or q.cancelled_at is not null then perform public.chart_err('bad_state', 'That request is closed.'); end if;
  update public.chart_requests set cancelled_at = now(), cancelled_by = me.discord_id, cancel_reason = coalesce(left(nullif(btrim(p_reason), ''), 120), 'Cancelled') where id = q.id;
  if q.kind = 'imaging' then update public.chart_cases set off_ward = null where id = q.case_id and off_ward = 'Radiology'; end if;
  if q.accepted_by is not null then perform public.chart_notice(q.accepted_by, 'A request you took was cancelled.'); end if;
  perform public.chart_act('request_cancel', q.case_id, jsonb_build_object('reason', p_reason), null, q.id);
  return public.chart_done();
end $$;

create or replace function public.chart_request_reopen(p_id bigint) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare me public.chart_staff := public.chart_begin(); q public.chart_requests := public.chart_req_row(p_id);
begin
  if q.asked_by is distinct from me.discord_id and not public.chart_is_sup() then perform public.chart_err('no_access', 'Only who asked, or the Supervisor, can ask someone else.'); end if;
  if q.accepted_by is null or q.here_at is not null or q.done_at is not null or q.cancelled_at is not null then perform public.chart_err('bad_state', 'Nothing to reopen.'); end if;
  if q.accepted_at > now() - interval '10 minutes' then perform public.chart_err('too_soon', 'Give them 10 minutes to arrive.'); end if;
  perform public.chart_notice(q.accepted_by, 'A request you took was given to someone else.');
  update public.chart_requests set accepted_by = null, accepted_at = null, reopened = reopened + 1 where id = q.id;
  perform public.chart_act('request_reopen', q.case_id, '{}', null, q.id);
  return public.chart_done();
end $$;

create or replace function public.chart_request_send(p_id bigint, p_person text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare q public.chart_requests;
begin
  perform public.chart_begin(); perform public.chart_need_sup();
  q := public.chart_req_row(p_id);
  if q.accepted_by is not null or q.done_at is not null or q.cancelled_at is not null then perform public.chart_err('bad_state', 'That request isn''t waiting.'); end if;
  if not exists (select 1 from public.chart_staff s where s.discord_id = p_person) then perform public.chart_err('not_on_shift', 'They aren''t on the Chart.'); end if;
  update public.chart_requests set sent_to = p_person, sent_by = public.my_discord_id() where id = q.id;
  perform public.chart_notice(p_person, format('%s asked you to take a %s request.', rtrim(public.chart_short(public.my_discord_id()), '.'), q.kind));
  perform public.chart_act('request_send', q.case_id, jsonb_build_object('to', p_person), null, q.id, p_person);
  return public.chart_done();
end $$;

create or replace function public.chart_request_chase(p_id bigint) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare me public.chart_staff := public.chart_begin(); q public.chart_requests := public.chart_req_row(p_id);
begin
  if q.asked_by is distinct from me.discord_id and not public.chart_is_sup() then perform public.chart_err('no_access', 'Only who asked, or the Supervisor, can chase it.'); end if;
  if q.accepted_by is not null then perform public.chart_err('taken', 'Someone already took it.'); end if;
  if q.done_at is not null or q.cancelled_at is not null then perform public.chart_err('bad_state', 'That request is closed.'); end if;
  update public.chart_requests set chased = chased + 1, chased_at = now() where id = q.id;
  perform public.chart_act('request_chase', q.case_id, '{}', null, q.id);
  return public.chart_done();
end $$;

-- ---------- charting ----------
create or replace function public.chart_entry_add(p_case bigint, p_kind text, p_data jsonb, p_entered_for text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare me public.chart_staff := public.chart_begin(); c public.chart_cases := public.chart_case_row(p_case); id bigint;
begin
  if c.status <> 'open' then perform public.chart_err('bad_state', 'That visit has ended.'); end if;
  if not public.chart_can_chart(c, me.discord_id) and not (p_entered_for is not null and public.chart_is_desk(me)) then
    perform public.chart_err('no_access', 'Only someone on this patient can chart.');
  end if;
  id := public.chart_add_entry(c.id, p_kind, p_data, p_entered_for);
  return public.chart_done(jsonb_build_object('entry_id', id));
end $$;

create or replace function public.chart_order_done(p_entry bigint, p_result text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare me public.chart_staff := public.chart_begin(); e public.chart_entries; c public.chart_cases;
begin
  select * into e from public.chart_entries x where x.id = p_entry;
  if e.id is null or e.kind <> 'order' then perform public.chart_err('bad_input', 'That isn''t an order.'); end if;
  c := public.chart_case_row(e.case_id);
  if not public.chart_can_chart(c, me.discord_id) then perform public.chart_err('no_access', 'Only someone on this patient can do that.'); end if;
  if char_length(coalesce(p_result, '')) > 300 then perform public.chart_err('too_long', 'Keep the result under 300 characters.'); end if;
  update public.chart_entries set done_at = coalesce(done_at, now()), done_by = me.discord_id, done_by_name = public.chart_short(me.discord_id),
         result = coalesce(nullif(btrim(coalesce(p_result, '')), ''), result) where id = e.id;
  perform public.chart_suggest_learn('result', p_result);
  perform public.chart_worked(c.id, me.discord_id);
  perform public.chart_act('order_done', c.id, jsonb_build_object('entry', e.id));
  return public.chart_done();
end $$;

create or replace function public.chart_entry_error(p_entry bigint, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare me public.chart_staff := public.chart_begin(); e public.chart_entries;
begin
  select * into e from public.chart_entries x where x.id = p_entry;
  if e.id is null then perform public.chart_err('bad_input', 'That entry doesn''t exist.'); end if;
  if e.author is distinct from me.discord_id and not public.chart_is_sup() then perform public.chart_err('no_access', 'Only who wrote it, or the Supervisor, can strike it.'); end if;
  if e.error_at is not null then perform public.chart_err('bad_state', 'Already struck.'); end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then perform public.chart_err('reason_needed', 'Say why it''s wrong.'); end if;
  update public.chart_entries set error_at = now(), error_by = me.discord_id, error_by_name = public.chart_short(me.discord_id), error_reason = left(btrim(p_reason), 200)
  where id = e.id;
  perform public.chart_act('entry_error', e.case_id, jsonb_build_object('entry', e.id, 'reason', p_reason));
  return public.chart_done();
end $$;

-- ---------- grants ----------
do $$
declare f record;
begin
  for f in select p.oid::regprocedure::text sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('chart_can_chart', 'chart_suggest_learn', 'chart_add_entry', 'chart_req_row',
             'chart_request', 'chart_request_accept', 'chart_request_here', 'chart_request_done', 'chart_request_cancel', 'chart_request_reopen',
             'chart_request_send', 'chart_request_chase', 'chart_entry_add', 'chart_order_done', 'chart_entry_error') loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
    if f.proname not in ('chart_can_chart', 'chart_suggest_learn', 'chart_add_entry', 'chart_req_row') then
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end $$;
