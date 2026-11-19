-- 0083: security-definer audit fixes (Bravo, 19 Nov 2026; for the next release, NOT applied until then).
-- The audit covered 31 security-definer functions that any logged-in user could run and whose body has no identity
-- gate. A rolled-back probe as a logged-in NON-member (qa-harness/audit_probe.py) proved:
--   * ev_upsert_session / ev_upsert_meeting: anyone could overwrite any session's or meeting's event card (title,
--     time, host, status, location) by passing a hand-made row. Only the mirror triggers should call them.
--   * event_set_post: anyone could clear an event's "needs reposting" flag and swap its Discord message ID (the
--     revision number is guessable), so the bot loses the post. Only the bot (service role) should call it.
--   * event_series_materialize: anyone could run the series job early. Bot only.
--   * ev_roles / ev_is_owner / ev_in_dept / ev_leads / event_visible_to: anyone could read ANY person's Discord roles
--     (incl. the Hospital Director's) or probe them, although members can only read their own member row.
-- The rest are harmless (gated inside the functions they call, self-only, pure catalogue lookups, or trigger
-- functions that can't be called directly); trigger functions are still locked down here for tidiness.
-- Every function here is owned by postgres and is only ever called from other security-definer functions (which run
-- as postgres), from triggers, or by the bot with the service role, so revoking EXECUTE from public, anon and
-- authenticated changes nothing for the site or the bot. The two helpers that RLS policies call get self-only
-- wrappers; the six policies are recreated with identical meaning on the wrappers.
-- Additive in effect: no table, column or data changes; down file restores the old grants and policies.

-- 1. Bot/trigger/internal only: no direct calls by website users.
do $$
declare f text;
begin
  foreach f in array array[
    'public.ev_upsert_meeting(public.meetings)', 'public.ev_upsert_session(public.sessions)',
    'public.event_set_post(bigint, text, integer)', 'public.event_series_materialize(integer)',
    'public.ev_roles(text)', 'public.ev_is_owner(text)', 'public.ev_in_dept(text, text)',
    'public.app_reviewer_role_ok(text, text)', 'public.app_role_allowed(text, text)', 'public.form_department(text)',
    'public.delete_posted_removed_warning()', 'public.sessions_shape()',
    'public.ev_mirror_meeting()', 'public.ev_mirror_meeting_attendance()', 'public.ev_mirror_session()',
    'public.ev_mirror_session_hosts()'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- 2. Self-only wrappers for the two helpers RLS policies need (a policy runs as the reader, so it needs EXECUTE).
create or replace function public.ev_leads_me(d text) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.ev_leads(public.my_discord_id(), d)
$$;
create or replace function public.event_visible_to_me(p_id bigint) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.event_visible_to(p_id, public.my_discord_id())
$$;
revoke execute on function public.ev_leads_me(text) from public, anon;
revoke execute on function public.event_visible_to_me(bigint) from public, anon;
grant execute on function public.ev_leads_me(text) to authenticated, service_role;
grant execute on function public.event_visible_to_me(bigint) to authenticated, service_role;

-- 3. The six policies, same meaning, on the wrappers.
drop policy if exists events_read on public.events;
create policy events_read on public.events for select to authenticated using (public.event_visible_to_me(id));
drop policy if exists event_hosts_read on public.event_hosts;
create policy event_hosts_read on public.event_hosts for select to authenticated using (public.event_visible_to_me(event_id));
drop policy if exists event_rsvps_read on public.event_rsvps;
create policy event_rsvps_read on public.event_rsvps for select to authenticated using (
  discord_id = public.my_discord_id() or public.is_exec() or exists (
    select 1 from public.events e where e.id = event_rsvps.event_id
      and (e.host_discord_id = public.my_discord_id() or (e.department is not null and public.ev_leads_me(e.department)))));
drop policy if exists event_attendance_read on public.event_attendance;
create policy event_attendance_read on public.event_attendance for select to authenticated using (
  discord_id = public.my_discord_id() or public.is_exec() or exists (
    select 1 from public.events e where e.id = event_attendance.event_id
      and (e.host_discord_id = public.my_discord_id() or (e.department is not null and public.ev_leads_me(e.department)))));
drop policy if exists event_log_read on public.event_log;
create policy event_log_read on public.event_log for select to authenticated using (
  public.is_exec() or (department is not null and public.ev_leads_me(department)));
drop policy if exists event_series_read on public.event_series;
create policy event_series_read on public.event_series for select to authenticated using (
  public.is_exec() or (department is not null and public.ev_leads_me(department)) or audience = 'hospital');

-- 4. Now the two any-person helpers can be internal too.
revoke execute on function public.ev_leads(text, text) from public, anon, authenticated;
revoke execute on function public.event_visible_to(bigint, text) from public, anon, authenticated;
grant execute on function public.ev_leads(text, text) to service_role;
grant execute on function public.event_visible_to(bigint, text) to service_role;
