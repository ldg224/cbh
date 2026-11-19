-- 0083 down: restore the old grants and policies exactly (reopens the holes; only for an emergency rollback).
do $$
declare f text;
begin
  foreach f in array array[
    'public.ev_upsert_meeting(public.meetings)', 'public.ev_upsert_session(public.sessions)',
    'public.event_set_post(bigint, text, integer)', 'public.event_series_materialize(integer)',
    'public.ev_roles(text)', 'public.ev_is_owner(text)', 'public.ev_in_dept(text, text)',
    'public.app_reviewer_role_ok(text, text)', 'public.app_role_allowed(text, text)', 'public.form_department(text)',
    'public.ev_mirror_meeting()', 'public.ev_mirror_meeting_attendance()', 'public.ev_mirror_session()',
    'public.ev_mirror_session_hosts()', 'public.ev_leads(text, text)', 'public.event_visible_to(bigint, text)'] loop
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
grant execute on function public.delete_posted_removed_warning() to public, anon, authenticated;
grant execute on function public.sessions_shape() to public, anon, authenticated;

drop policy if exists events_read on public.events;
create policy events_read on public.events for select to authenticated using (public.event_visible_to(id, public.my_discord_id()));
drop policy if exists event_hosts_read on public.event_hosts;
create policy event_hosts_read on public.event_hosts for select to authenticated using (public.event_visible_to(event_id, public.my_discord_id()));
drop policy if exists event_rsvps_read on public.event_rsvps;
create policy event_rsvps_read on public.event_rsvps for select to authenticated using (
  discord_id = public.my_discord_id() or public.is_exec() or exists (
    select 1 from public.events e where e.id = event_rsvps.event_id
      and (e.host_discord_id = public.my_discord_id() or (e.department is not null and public.ev_leads(public.my_discord_id(), e.department)))));
drop policy if exists event_attendance_read on public.event_attendance;
create policy event_attendance_read on public.event_attendance for select to authenticated using (
  discord_id = public.my_discord_id() or public.is_exec() or exists (
    select 1 from public.events e where e.id = event_attendance.event_id
      and (e.host_discord_id = public.my_discord_id() or (e.department is not null and public.ev_leads(public.my_discord_id(), e.department)))));
drop policy if exists event_log_read on public.event_log;
create policy event_log_read on public.event_log for select to authenticated using (
  public.is_exec() or (department is not null and public.ev_leads(public.my_discord_id(), department)));
drop policy if exists event_series_read on public.event_series;
create policy event_series_read on public.event_series for select to authenticated using (
  public.is_exec() or (department is not null and public.ev_leads(public.my_discord_id(), department)) or audience = 'hospital');

drop function if exists public.ev_leads_me(text);
drop function if exists public.event_visible_to_me(bigint);
