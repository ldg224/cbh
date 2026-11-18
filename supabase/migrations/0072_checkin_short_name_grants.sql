-- 0072: hardening (Alpha, 18 Nov 2026; Delta's 0.31.0 live check). checkin_short_name(text) is a pure formatter (first name + last
-- initial of the text it is given; no table access, invoker rights), so it leaks nothing, but it was the only check-in
-- function anon could execute. Only the SECURITY DEFINER check-in functions call it, and they run as the owner.
revoke execute on function public.checkin_short_name(text) from public, anon, authenticated;
