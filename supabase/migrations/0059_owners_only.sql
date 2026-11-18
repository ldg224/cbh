-- 0059: full access = Hospital Director and Chief Operations Officer only (owner decision, 18 Nov 2026; Bravo).
-- is_exec() no longer means "any leadership or the Executive role": Board of Directors becomes every department
-- Director's Discord leader-channel role and gives nothing extra on the website, and the Executive role is being
-- deleted. Everything that checks is_exec() (RLS, has_perm, has_hperm, directs_*, my_access, the role editor,
-- hospital tools) follows. Directors keep their own department through directs_dept()'s Director-rank branch.
-- Also: application reviewing by "executive" now means the owners only; the role editor can now give Board of
-- Directors permissions (only HD and COO are "always everything").
create or replace function public.is_owner_role(role_id text) returns boolean language sql immutable set search_path = '' as $$
  select role_id in ('1464007138882883725', '1472796994316534005')   -- Hospital Director, Chief Operations Officer
$$;
create or replace function public.is_exec() returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.my_roles() r where public.is_owner_role(r.id))
$$;
CREATE OR REPLACE FUNCTION public.app_is_reviewer(f text, who text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with me as (select coalesce(m.role_ids, '{}') ids from public.members m where m.discord_id = who),
       x as (select fx.*, coalesce(fx.department, fx.review_team) dept from public.forms fx where fx.key = f),
       ex as (select exists (select 1 from me, public.roles r where r.id = any (me.ids) and r.id in ('1464007138882883725', '1472796994316534005')) v)   -- owners only (0059)
  select case when coalesce(cardinality(x.reviewer_roles), 0) > 0
              then exists (select 1 from me where me.ids && x.reviewer_roles) or (x.final_by_exec and (select v from ex))
              else (select v from ex)
                or exists (select 1 from me, public.roles r where r.id = any (me.ids) and r.kind = 'rank' and r.department = x.dept and r.rank_label = 'Director')
                or exists (select 1 from me, public.roles r join public.rank_permissions p on p.role_id = r.id
                           where r.id = any (me.ids) and r.kind = 'rank' and r.department = x.dept and p.perm = 'applications.review') end
  from x
$function$;

CREATE OR REPLACE FUNCTION public.set_role_hperm(role_id text, perm text, allow boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r public.roles;
begin
  if not public.is_exec() then raise exception 'Only the Hospital Director and Chief Operations Officer can change hospital permissions'; end if;
  select * into r from public.roles x where x.id = set_role_hperm.role_id;
  if not found then raise exception 'That role doesn''t exist'; end if;
  if r.id in ('1464007138882883725', '1472796994316534005') then raise exception 'The Hospital Director and Chief Operations Officer always have every permission'; end if;
  if r.kind in ('bot', 'community') then raise exception 'Bot and booster roles can''t be given permissions'; end if;
  if allow then
    insert into public.role_permissions (role_id, perm, granted_by) values (set_role_hperm.role_id, set_role_hperm.perm, public.my_discord_id())
    on conflict do nothing;
  else
    delete from public.role_permissions p where p.role_id = set_role_hperm.role_id and p.perm = set_role_hperm.perm;
  end if;
  return allow;
end $function$;

CREATE OR REPLACE FUNCTION public.set_role_cmd(role_id text, command text, allow boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r public.roles;
begin
  if not public.is_exec() then raise exception 'Only the Hospital Director and Chief Operations Officer can change bot commands'; end if;
  select * into r from public.roles x where x.id = set_role_cmd.role_id;
  if not found then raise exception 'That role doesn''t exist'; end if;
  if r.id in ('1464007138882883725', '1472796994316534005') then raise exception 'The Hospital Director and Chief Operations Officer can always use every command'; end if;
  if r.kind in ('bot', 'community') or r.managed then raise exception 'Bot and booster roles can''t be given commands'; end if;
  if allow then
    insert into public.role_cmd_perms (role_id, command, granted_by) values (set_role_cmd.role_id, set_role_cmd.command, public.my_discord_id())
    on conflict do nothing;
  else
    delete from public.role_cmd_perms p where p.role_id = set_role_cmd.role_id and p.command = set_role_cmd.command;
  end if;
  return allow;
end $function$;

