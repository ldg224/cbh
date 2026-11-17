-- 0031: Access hardening (user: "this is very important and needs to be safeguarded to prevent leaks"; Charlie's
-- audit, 18 Nov 2026; Bravo). Additive.
-- 1. rank_permissions was readable by every logged-in member. Now: executives, the department's Director, and members
--    of that department (their own department's rows only). has_perm() / my_perms() are SECURITY DEFINER and don't
--    depend on this policy.
-- 2. privileged_role_events: a record of privileged Discord roles (Director, Leader, leadership, office, Executive)
--    that someone gained in Discord without a website role change. Written only by CareBeyond Helper (service role);
--    readable only by executives. The bot also posts a red alert in #server-logs. Nothing is blocked or undone.

drop policy if exists rank_permissions_read on public.rank_permissions;
create policy rank_permissions_read on public.rank_permissions for select to authenticated using (
  public.is_exec() or exists (
    select 1 from public.roles r where r.id = rank_permissions.role_id
      and (public.directs_dept(r.department) or public.in_dept(r.department))));

create table if not exists public.privileged_role_events (
  id            bigint generated always as identity primary key,
  discord_id    text not null,
  member_name   text,
  role_id       text not null,
  role_name     text,
  kind          text,                -- director / leader / leadership / office / executive
  actor_id      text,                -- from the Discord audit log, when it can be read
  actor_name    text,
  note          text,
  created_at    timestamptz not null default now()
);
create index if not exists privileged_role_events_at on public.privileged_role_events (created_at desc);
alter table public.privileged_role_events enable row level security;
drop policy if exists privileged_role_events_read on public.privileged_role_events;
create policy privileged_role_events_read on public.privileged_role_events for select to authenticated using (public.is_exec());
revoke all on public.privileged_role_events from anon;
revoke insert, update, delete, truncate on public.privileged_role_events from authenticated;
grant select on public.privileged_role_events to authenticated;
