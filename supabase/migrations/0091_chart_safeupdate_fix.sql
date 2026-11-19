-- 0091: pg_safeupdate fix (Bravo, 19 Nov 2026; found in the owner test). Supabase runs pg_safeupdate on API (PostgREST)
-- requests: any DELETE/UPDATE with no WHERE is refused, even inside security-definer functions and on temp tables. The
-- rolled-back tests run through the Management API, which doesn't load it, so they never saw it. A scan of every
-- 0084-0090 function body found exactly two:
--   * chart_shift_hook (0090): the "last person off shift" cleanup `delete from public.chart_staff;`. The guard caught it
--     (hook_error logged, the shift still ended), but the Chart cleanup was skipped.
--   * chart_give_room (0087): `delete from chart_tmp_moves;` would have failed a Supervisor's "give a nurse a room".
-- Both are re-created unchanged except for `where true`. Same signatures and grants (create or replace keeps them).

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
  delete from chart_tmp_moves where true;
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

create or replace function public.chart_shift_hook() returns trigger
language plpgsql security definer set search_path = '' as $$
declare note text; x bigint;
begin
  begin
    if new.status = 'ended' and old.status is distinct from 'ended' then
      perform public.chart_lock();
      if exists (select 1 from public.chart_staff s where s.discord_id = new.discord_id)
         and (public.chart_shift_of(new.discord_id)).id is null then                       -- no other open shift for them
        note := case when new.ended_by = 'auto' then 'Auto clock-out' else 'Clocked out' end;
        perform public.chart_hand_back_all(new.discord_id, note, true);
        update public.chart_beds set owner_id = null, owner_since = null where owner_id = new.discord_id;
        delete from public.chart_staff where discord_id = new.discord_id;
        insert into public.chart_log (subject_id, actor_name, action, detail) values (new.discord_id, 'Auto', 'shift_end', jsonb_build_object('by', new.ended_by));
      end if;
      if not exists (select 1 from public.shifts s where s.status <> 'ended') then
        for x in select c.id from public.chart_cases c where c.status = 'open' and c.state is not null loop
          perform public.chart_close_case(x, 'session_ended', 'session_ended');
        end loop;
        delete from public.chart_staff where true;
        update public.chart_beds set owner_id = null, owner_since = null where owner_id is not null;
        insert into public.chart_log (actor_name, action) values ('Auto', 'session_end');
      end if;
      perform public.chart_bump();
    elsif new.status is distinct from old.status then
      update public.chart_staff set on_break = (new.status = 'break'),
             ready = case when new.status = 'break' then false else ready end,
             ready_since = case when new.status = 'break' then null else ready_since end
      where discord_id = new.discord_id;
      perform public.chart_bump();
    end if;
  exception when others then
    begin
      insert into public.chart_log (subject_id, actor_name, action, detail) values (new.discord_id, 'Auto', 'hook_error', jsonb_build_object('error', sqlerrm));
    exception when others then
      raise warning 'chart_shift_hook: %', sqlerrm;
    end;
  end;
  return null;
end $$;
