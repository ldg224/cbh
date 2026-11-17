-- 0040: member_display_name() was executable by any signed-in person, so anyone could check whether a Discord ID is in
-- the server and learn their name (Charlie, 18 Nov 2026). It's only needed inside the sessions_shape trigger. That
-- trigger ran as the caller, so revoking alone would break handing the lead host to someone else: it now runs as
-- security definer (it reads and sets only the session row being written, plus the host's name), and the helper is
-- revoked from public, anon and authenticated.
alter function public.sessions_shape() security definer;
revoke execute on function public.member_display_name(text) from public, anon, authenticated;
