-- 0073: one department per person (Alpha). Owner decision, 18 Nov 2026: adding or accepting someone into another
-- department is a TRANSFER: their rank (and division) roles in every other department are removed when the new rank
-- is given. Owners (Hospital Director, COO) are exempt. People who are ALREADY in several departments are left alone
-- (the owner sorts them out); dept_multi_members() lists them for owners. The bot does the Discord side (action
-- 'transfer' in role_changes: remove remove_role_ids, then add the new rank) and posts a clear line in #server-logs.

alter table public.role_changes add column if not exists remove_role_ids text[];
alter table public.role_changes add column if not exists transfer_from text[];   -- e.g. {"Nursing · Year 2"}, for the log and the site
alter table public.role_changes drop constraint if exists role_changes_action_check;
alter table public.role_changes add constraint role_changes_action_check check (action in ('set_rank', 'add', 'remove', 'grant', 'transfer'));

-- What a person would lose by joining dept: their department/rank roles in every OTHER department. Empty for owners.
create or replace function public.dept_transfer_from(target text, dept text)
returns table (department text, rank_label text, role_ids text[]) language sql stable security definer set search_path = '' as $$
  select r.department,
         (select x.rank_label from public.roles x where x.id = any (m.role_ids) and x.department = r.department and x.kind = 'rank'
           order by x.rank_order desc nulls last limit 1),
         array_agg(r.id order by r.id)
  from public.members m join public.roles r on r.id = any (m.role_ids)
  where m.discord_id = target and r.kind in ('department', 'rank') and r.department is not null and r.department <> dept
    and not exists (select 1 from unnest(m.role_ids) o where public.is_owner_role(o))
  group by r.department, m.role_ids
$$;
revoke execute on function public.dept_transfer_from(text, text) from public, anon, authenticated;

create or replace function public.dept_transfer_json(target text, dept text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('transfer', count(*) > 0,
    'owner', exists (select 1 from public.members m, unnest(m.role_ids) o where m.discord_id = target and public.is_owner_role(o)),
    'from', coalesce(jsonb_agg(jsonb_build_object('department', t.department, 'rank_label', t.rank_label) order by t.department) filter (where t.department is not null), '[]'::jsonb))
  from public.dept_transfer_from(target, dept) t
$$;
revoke execute on function public.dept_transfer_json(text, text) from public, anon, authenticated;

-- For the site's warning before "Add to <dept>": who can add people to dept may ask.
create or replace function public.dept_transfer_preview(target text, department text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.has_perm('members.edit', dept_transfer_preview.department) then raise exception 'You can''t add people to %.', dept_transfer_preview.department; end if;
  return public.dept_transfer_json(target, dept_transfer_preview.department);
end $$;

-- For the warning before accepting an application: whoever can review it may ask.
create or replace function public.app_transfer_preview(sub_id bigint)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare s public.form_submissions;
begin
  select * into s from public.form_submissions where id = sub_id;
  if s.id is null or not public.can_review_form(s.form_key) then raise exception 'You can''t review this application.'; end if;
  return public.dept_transfer_json(s.submitter_discord_id, public.form_department(s.form_key));
end $$;

-- Owners: everyone who is currently in more than one department (for sorting out by hand).
create or replace function public.dept_multi_members()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_exec() then raise exception 'Only owners can see this list.'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('discord_id', x.discord_id, 'name', x.display_name, 'owner', x.owner,
      'departments', x.depts) order by x.display_name)
    from (select m.discord_id, m.display_name, exists (select 1 from unnest(m.role_ids) o where public.is_owner_role(o)) owner,
                 jsonb_agg(jsonb_build_object('department', d.department, 'rank_label', d.rank_label) order by d.department) depts
          from public.members m
          cross join lateral (select r.department, (select x.rank_label from public.roles x where x.id = any (m.role_ids) and x.department = r.department
                                                     and x.kind = 'rank' order by x.rank_order desc nulls last limit 1) rank_label
                              from public.roles r where r.id = any (m.role_ids) and r.kind in ('department', 'rank') and r.department is not null
                              group by r.department) d
          group by m.discord_id, m.display_name, m.role_ids
          having count(*) > 1) x), '[]'::jsonb);
end $$;

-- dept_add (via role_change_request): an add for someone in another department becomes a transfer.
create or replace function public.role_change_request(target text, department text, rank_role_id text, action text, reason text)
returns public.role_changes
language plpgsql security definer set search_path = '' as $$
declare t public.members; c public.role_changes; label text; why text := nullif(trim(coalesce(reason, '')), '');
        rm text[]; frm text[]; act text := action;
begin
  t := public.role_change_check(target, department, rank_role_id, action);
  if action = 'add' and exists (select 1 from public.roles r where r.id = any (t.role_ids)
                                and r.department = role_change_request.department and r.kind in ('department', 'rank')) then
    raise exception '% is already in %', t.display_name, department;
  end if;
  if action in ('set_rank', 'remove') and not exists (select 1 from public.roles r where r.id = any (t.role_ids)
                                and r.department = role_change_request.department and r.kind in ('department', 'rank')) then
    raise exception '% isn''t in %', t.display_name, department;
  end if;
  if exists (select 1 from public.role_changes x where x.target_discord_id = target and x.department = role_change_request.department
             and x.status = 'pending') then
    raise exception 'There''s already a change waiting for % in %', t.display_name, department;
  end if;
  if char_length(why) > 500 then raise exception 'Keep the reason under 500 characters'; end if;
  if action = 'add' then
    select array_agg(r) , array_agg(f.department || coalesce(' · ' || f.rank_label, '')) into rm, frm
      from public.dept_transfer_from(target, role_change_request.department) f cross join lateral unnest(f.role_ids) r;
    -- array_agg over the unnest repeats the label per role; keep each department once
    frm := array(select distinct x from unnest(frm) x order by 1);
    if cardinality(rm) > 0 then act := 'transfer'; end if;
  end if;
  select r.rank_label into label from public.roles r where r.id = rank_role_id;
  insert into public.role_changes (target_discord_id, target_name, department, action, rank_role_id, rank_label,
                                   requested_by, requested_by_name, reason, remove_role_ids, transfer_from)
  values (target, t.display_name, department, act, case when action = 'remove' then null else rank_role_id end,
          case when action = 'remove' then null else label end, public.my_discord_id(),
          (select m.display_name from public.members m where m.discord_id = public.my_discord_id()), why,
          case when act = 'transfer' then rm end, case when act = 'transfer' then frm end)
  returning * into c;
  return c;
end $$;

-- Accepting an application into another department is a transfer too (same rule, same bot action).
create or replace function public.app_decide_core(sub_id bigint, accept boolean, note text default null, rank_role_id text default null, role_ids text[] default null)
returns void language plpgsql security definer set search_path = '' as $$
declare s public.form_submissions; x public.forms; dept text; me text := public.my_discord_id();
        nm text := (select display_name from public.members where discord_id = public.my_discord_id());
        rk text; extra text[]; r text; rm text[]; frm text[];
begin
  select * into s from public.form_submissions where id = sub_id for update;
  if s.id is null or not public.can_review_form(s.form_key) then raise exception 'You can''t review this application.'; end if;
  if s.status <> 'pending' then raise exception 'This application has already been decided.'; end if;
  if s.submitter_discord_id = me then raise exception 'You can''t decide your own application.'; end if;
  select * into x from public.forms where key = s.form_key;
  dept := public.form_department(s.form_key);
  if accept then
    rk := coalesce(rank_role_id, x.accept_rank_role_id);
    extra := coalesce(role_ids, x.accept_role_ids, '{}');
    if rk is not null and not public.app_role_allowed(rk, dept) then raise exception 'That rank can''t be given by an application.'; end if;
    foreach r in array extra loop
      if not public.app_role_allowed(r, dept) then raise exception 'One of the extra roles can''t be given from here.'; end if;
    end loop;
    -- The form's published roles were approved when it was published. Anything different needs Edit applications,
    -- and every rank that isn't on the form needs app_can_give.
    if rk is distinct from x.accept_rank_role_id or extra is distinct from x.accept_role_ids then
      if not public.app_can_edit(dept) then
        raise exception 'Only people who can edit this department''s applications can choose different roles.'; end if;
      foreach r in array (array_remove(array[rk], null) || extra) loop
        if (select kind from public.roles where id = r) = 'rank'
           and not (r = x.accept_rank_role_id or r = any (coalesce(x.accept_role_ids, '{}')))
           and not public.app_can_give(dept, r) then
          raise exception 'You can''t give %. Ask the Director.', (select name from public.roles where id = r); end if;
      end loop;
    end if;
  end if;
  update public.form_submissions set status = case when accept then 'accepted' else 'denied' end,
    reviewer_discord_id = me, reviewer_name = nm, review_note = nullif(btrim(coalesce(note, '')), ''),
    reviewed_at = now(), notified = false, post_dirty = true
  where id = sub_id;
  if not accept then return; end if;
  if rk is not null then
    select array_agg(rr), array(select distinct y from unnest(array_agg(f.department || coalesce(' · ' || f.rank_label, ''))) y order by 1)
      into rm, frm
      from public.dept_transfer_from(s.submitter_discord_id, dept) f cross join lateral unnest(f.role_ids) rr;
    insert into public.role_changes (target_discord_id, target_name, department, action, rank_role_id, rank_label, requested_by, requested_by_name, status, reason,
                                     remove_role_ids, transfer_from)
    values (s.submitter_discord_id, s.submitter_name, dept, case when cardinality(rm) > 0 then 'transfer' else 'add' end, rk,
            (select rank_label from public.roles where id = rk), me, nm, 'pending', 'Application #' || s.id || ' accepted',
            case when cardinality(rm) > 0 then rm end, case when cardinality(rm) > 0 then frm end);
  end if;
  if array_length(extra, 1) > 0 then
    insert into public.role_changes (target_discord_id, target_name, department, action, role_ids, requested_by, requested_by_name, status, reason)
    values (s.submitter_discord_id, s.submitter_name, dept, 'grant', extra, me, nm, 'pending', 'Application #' || s.id || ' accepted');
  end if;
end $$;

do $g$
declare f text;
begin
  foreach f in array array['dept_transfer_preview(text, text)', 'app_transfer_preview(bigint)', 'dept_multi_members()'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $g$;
