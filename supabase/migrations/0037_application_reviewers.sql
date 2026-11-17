-- 0037: who reviews each application, and how many approvals it needs (Alpha; number from Charlie). On top of 0032.
-- Owner, 19 Nov 2026: "Become a Leader could only be reviewed by people with Board of Directors. Or maybe it needs so
-- many approvals to actually go ahead." Decisions (owner): a separate Approve / Reject per reviewer, shown as
-- "2 of 3 approvals"; a Reject is shown but doesn't block; when approvals are needed an executive gives the final
-- Accept and the message (final_by_exec); reviewer roles = leadership, Executive, or ranks of the department.
-- Guard (Charlie): only execs and the department's Director may set or change reviewer_roles, approvals_needed or
-- final_by_exec; recorded as review_set_by/at. Nobody reviews, approves or decides their own application.

alter table public.forms
  add column if not exists reviewer_roles text[],
  add column if not exists approvals_needed integer not null default 1,
  add column if not exists final_by_exec boolean not null default false,
  add column if not exists review_set_by text,
  add column if not exists review_set_by_name text,
  add column if not exists review_set_at timestamptz;
alter table public.forms drop constraint if exists forms_approvals_check;
alter table public.forms add constraint forms_approvals_check check (approvals_needed between 1 and 10);

create table if not exists public.application_approvals (
  submission_id      bigint not null references public.form_submissions (id) on delete cascade,
  reviewer_discord_id text not null,
  reviewer_name      text,
  decision           smallint not null check (decision in (-1, 1)),
  created_at         timestamptz not null default now(),
  primary key (submission_id, reviewer_discord_id)
);
alter table public.application_approvals enable row level security;
revoke all on public.application_approvals from anon, authenticated;
-- read and written only through the functions below

-- Roles that may be chosen as an application's reviewers.
create or replace function public.app_reviewer_role_ok(role_id text, dept text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.roles r where r.id = role_id
                 and (r.kind in ('leadership', 'executive') or (r.kind = 'rank' and r.department = dept)))
$$;

-- Who may review this form: its own reviewer roles if it has any (plus execs when an exec gives the final Accept),
-- otherwise the department's applications.review holders (execs and the Director always).
create or replace function public.can_review_form(f text)
returns boolean language sql stable security definer set search_path = '' as $$
  select case when coalesce(cardinality(x.reviewer_roles), 0) > 0
              then exists (select 1 from public.my_roles() r where r.id = any (x.reviewer_roles)) or (x.final_by_exec and public.is_exec())
              else public.is_exec() or coalesce(public.has_perm('applications.review', coalesce(x.department, x.review_team)), false) end
  from public.forms x where x.key = f
$$;

-- Approve / Reject (1 / -1), or 0 to take it back.
create or replace function public.app_approve(sub_id bigint, decision smallint)
returns void language plpgsql security definer set search_path = '' as $$
declare s public.form_submissions; me text := public.my_discord_id();
begin
  select * into s from public.form_submissions where id = sub_id;
  if s.id is null or not public.can_review_form(s.form_key) then raise exception 'You can''t review this application.'; end if;
  if s.status <> 'pending' then raise exception 'This application has already been decided.'; end if;
  if s.submitter_discord_id = me then raise exception 'You can''t approve your own application.'; end if;
  if decision = 0 then delete from public.application_approvals a where a.submission_id = sub_id and a.reviewer_discord_id = me; return; end if;
  if decision not in (-1, 1) then raise exception 'Approve or reject.'; end if;
  insert into public.application_approvals (submission_id, reviewer_discord_id, reviewer_name, decision)
  values (sub_id, me, (select display_name from public.members where discord_id = me), decision)
  on conflict (submission_id, reviewer_discord_id) do update set decision = excluded.decision, created_at = now();
end $$;

create or replace function public.app_approval_count(sub_id bigint)
returns integer language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.application_approvals a join public.form_submissions s on s.id = a.submission_id
  where a.submission_id = sub_id and a.decision = 1 and a.reviewer_discord_id <> s.submitter_discord_id
$$;

-- Accept needs enough approvals (when more than one is needed) and an exec when the form says so.
-- Wraps the 0032 rules: the rename keeps them in one place.
alter function public.app_decide(bigint, boolean, text, text, text[]) rename to app_decide_core;
revoke execute on function public.app_decide_core(bigint, boolean, text, text, text[]) from public, anon, authenticated;
create or replace function public.app_decide(sub_id bigint, accept boolean, note text default null,
                                            rank_role_id text default null, role_ids text[] default null)
returns void language plpgsql security definer set search_path = '' as $$
declare x public.forms; n int;
begin
  select f.* into x from public.forms f join public.form_submissions s on s.form_key = f.key where s.id = sub_id;
  if accept and x.key is not null then
    if x.final_by_exec and not public.is_exec() then raise exception 'An executive gives the final Accept for this application.'; end if;
    if x.approvals_needed > 1 then
      n := public.app_approval_count(sub_id);
      if n < x.approvals_needed then raise exception 'This needs % approvals first (% so far).', x.approvals_needed, n; end if;
    end if;
  end if;
  perform public.app_decide_core(sub_id, accept, note, rank_role_id, role_ids);
end $$;
revoke execute on function public.app_decide(bigint, boolean, text, text, text[]) from public, anon;
grant execute on function public.app_decide(bigint, boolean, text, text, text[]) to authenticated;

-- Publishing: the reviewer settings come from the draft too, and only execs or the Director may change them.
alter function public.app_form_publish(text) rename to app_form_publish_core;
revoke execute on function public.app_form_publish_core(text) from public, anon, authenticated;
create or replace function public.app_form_publish(form_key text)
returns void language plpgsql security definer set search_path = '' as $$
declare x public.forms; d jsonb; dept text; roles_new text[]; need int; fin boolean; changed boolean; r text;
begin
  select * into x from public.forms where key = form_key and kind = 'application' and not archived;
  if x.key is null then raise exception 'This application no longer exists.'; end if;
  dept := coalesce(x.department, x.review_team); d := x.draft;
  if d is null then return; end if;
  roles_new := array(select v from jsonb_array_elements_text(coalesce(d->'reviewer_roles', '[]'::jsonb)) v order by 1);
  need := coalesce((d->>'approvals_needed')::int, x.approvals_needed);
  fin := coalesce((d->>'final_by_exec')::boolean, x.final_by_exec);
  if need not between 1 and 10 then raise exception 'Approvals needed must be 1 to 10.'; end if;
  foreach r in array roles_new loop
    if not public.app_reviewer_role_ok(r, dept) then raise exception 'Reviewers must be leadership, Executive or % ranks.', dept; end if;
  end loop;
  changed := roles_new is distinct from array(select v from unnest(coalesce(x.reviewer_roles, '{}')) v order by 1)
             or need is distinct from x.approvals_needed or fin is distinct from x.final_by_exec;
  if changed and not (public.is_exec() or public.directs_dept(dept)) then
    raise exception 'Only executives and the % Director can change who reviews this application.', dept; end if;
  perform public.app_form_publish_core(form_key);
  if changed then
    update public.forms set reviewer_roles = case when cardinality(roles_new) = 0 then null else roles_new end,
      approvals_needed = need, final_by_exec = fin, review_set_by = public.my_discord_id(),
      review_set_by_name = (select display_name from public.members where discord_id = public.my_discord_id()), review_set_at = now()
    where key = form_key;
  end if;
end $$;
revoke execute on function public.app_form_publish(text) from public, anon;
grant execute on function public.app_form_publish(text) to authenticated;

-- Queue and detail: approvals so far and what's needed.
create or replace function public.app_review_queue(include_done boolean default false, dept text default null)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', s.id, 'form_key', s.form_key, 'form_title', x.title, 'section', x.section, 'department', public.form_department(s.form_key),
    'status', s.status, 'stage', s.stage, 'stages', x.stages,
    'submitter_discord_id', s.submitter_discord_id, 'submitter_name', coalesce(m.display_name, s.submitter_name),
    'avatar_url', m.avatar_url, 'created_at', s.created_at, 'reviewed_at', s.reviewed_at, 'reviewer_name', s.reviewer_name,
    'up', (select count(*) from public.application_notes n where n.submission_id = s.id and n.vote = 1),
    'down', (select count(*) from public.application_notes n where n.submission_id = s.id and n.vote = -1),
    'notes', (select count(*) from public.application_notes n where n.submission_id = s.id and n.body is not null),
    'approvals', public.app_approval_count(s.id), 'approvals_needed', x.approvals_needed)
    order by s.created_at desc), '[]'::jsonb)
  from public.form_submissions s
  join public.forms x on x.key = s.form_key and x.kind = 'application'
  left join public.members m on m.discord_id = s.submitter_discord_id
  where public.can_review_form(s.form_key)
    and (app_review_queue.dept is null or coalesce(x.department, x.review_team) = app_review_queue.dept)
    and (s.status = 'pending' or (include_done and s.created_at > now() - interval '180 days'))
$$;

alter function public.app_detail(bigint) rename to app_detail_core;
revoke execute on function public.app_detail_core(bigint) from public, anon, authenticated;
create or replace function public.app_detail(sub_id bigint)
returns jsonb language sql stable security definer set search_path = '' as $$
  select d || jsonb_build_object(
    'approvals', (select coalesce(jsonb_agg(jsonb_build_object('name', a.reviewer_name, 'decision', a.decision, 'at', a.created_at,
                    'mine', a.reviewer_discord_id = public.my_discord_id()) order by a.created_at), '[]'::jsonb)
                  from public.application_approvals a where a.submission_id = sub_id),
    'approvals_needed', x.approvals_needed, 'final_by_exec', x.final_by_exec, 'is_exec', public.is_exec())
  from public.app_detail_core(sub_id) d
  join public.form_submissions s on s.id = sub_id join public.forms x on x.key = s.form_key
  where d is not null
$$;
revoke execute on function public.app_detail(bigint) from public, anon;
grant execute on function public.app_detail(bigint) to authenticated;

-- Roles that can be picked as reviewers (for the builder).
create or replace function public.app_reviewer_choices(dept text)
returns table (id text, name text, kind text, rank_order integer)
language sql stable security definer set search_path = '' as $$
  select r.id, r.name, r.kind, r.rank_order from public.roles r
  where public.app_can_edit(dept) and public.app_reviewer_role_ok(r.id, dept)
  order by (r.kind = 'rank'), r.position desc, r.rank_order
$$;

do $g$
declare f text;
begin
  foreach f in array array['app_reviewer_role_ok(text, text)', 'app_approve(bigint, smallint)', 'app_approval_count(bigint)', 'app_reviewer_choices(text)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $g$;
