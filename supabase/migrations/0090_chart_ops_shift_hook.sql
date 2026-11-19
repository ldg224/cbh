-- 0090: CBH Chart operations, shift hook (Bravo, 19 Nov 2026; BACKEND-PLAN §4.6). A new AFTER UPDATE trigger on the live
-- shifts table: when a shift ends (website clock-out, staff end, or the bot's auto clock-out) the person's patients are
-- handed back ("Clocked out" / "Auto clock-out", lost nurse), their beds go Open, their accepted requests reopen and their
-- Chart row goes; when nobody is left on shift, the remaining open cases close as "session ended". Break mirrors into
-- chart_staff. GUARDED: any error inside is caught and logged, so ending a shift can never fail because of the Chart.
-- The existing shift functions are not changed.

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
        delete from public.chart_staff;
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

drop trigger if exists chart_shift_hook on public.shifts;
create trigger chart_shift_hook after update of status on public.shifts for each row execute function public.chart_shift_hook();

revoke execute on function public.chart_shift_hook() from public, anon, authenticated;
grant execute on function public.chart_shift_hook() to service_role;
