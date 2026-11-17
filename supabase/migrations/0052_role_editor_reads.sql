-- 0052: read side of the website role editor (R1, Bravo, 18 Nov 2026). Executives only; read-only. Additive.
--   role_overview()        every role the website knows, in Discord's order, with how many members hold it
--   role_members(role_id)  who holds one role (name, photo)
create or replace function public.role_overview() returns table (id text, name text, color integer, "position" integer,
  kind text, department text, rank_label text, rank_order integer, badge_color integer, members integer)
language sql stable security definer set search_path = '' as $$
  select r.id, r.name, r.color, r.position, r.kind, r.department, r.rank_label, r.rank_order, r.badge_color,
    (select count(*)::int from public.members m where r.id = any (m.role_ids))
  from public.roles r
  where public.is_exec()
  order by r.position desc
$$;
create or replace function public.role_members(role_id text) returns table (discord_id text, display_name text, avatar_url text)
language sql stable security definer set search_path = '' as $$
  select m.discord_id, m.display_name, m.avatar_url from public.members m
  where public.is_exec() and role_members.role_id = any (m.role_ids)
  order by m.display_name
$$;
revoke execute on function public.role_overview(), public.role_members(text) from public, anon;
grant execute on function public.role_overview(), public.role_members(text) to authenticated;
