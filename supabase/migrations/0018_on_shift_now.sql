-- 0018: who is on shift right now, across every department, for staff (Staff & roster on-shift dots).
-- Same audience as home_counts().on_shift (owner decision 17 Nov 2026: hospital-wide for staff; see docs/ACCESS.md).
-- Only the person's ID, department and on-shift / on-break status; nothing from Records.
create or replace function public.on_shift_now()
returns table (discord_id text, department text, status text)
language sql stable security definer set search_path = '' as $$
  select s.discord_id, s.department, s.status from public.shifts s
  where public.is_team() and s.status <> 'ended'
$$;
revoke execute on function public.on_shift_now() from public, anon;
grant execute on function public.on_shift_now() to authenticated;
