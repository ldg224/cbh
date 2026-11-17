-- 0042: Delta A1-A3 (Alpha; number from Charlie). Owner's answer to A1 (19 Nov 2026): the person who presses the final
-- Accept DOES count as one of the approvals ("Include the decider"), so approvals_needed keeps its meaning and default.
-- What changes: only approvals from people who are STILL eligible reviewers of that form count (A1/A3), and the
-- detail marks the others; app_approval_count is no longer callable directly (A2).

-- Is this person (not the caller) an eligible reviewer of this form right now? Mirrors can_review_form (0037).
create or replace function public.app_is_reviewer(f text, who text)
returns boolean language sql stable security definer set search_path = '' as $$
  with me as (select coalesce(m.role_ids, '{}') ids from public.members m where m.discord_id = who),
       x as (select fx.*, coalesce(fx.department, fx.review_team) dept from public.forms fx where fx.key = f),
       ex as (select exists (select 1 from me, public.roles r where r.id = any (me.ids) and r.kind in ('leadership', 'executive')) v)
  select case when coalesce(cardinality(x.reviewer_roles), 0) > 0
              then exists (select 1 from me where me.ids && x.reviewer_roles) or (x.final_by_exec and (select v from ex))
              else (select v from ex)
                or exists (select 1 from me, public.roles r where r.id = any (me.ids) and r.kind = 'rank' and r.department = x.dept and r.rank_label = 'Director')
                or exists (select 1 from me, public.roles r join public.rank_permissions p on p.role_id = r.id
                           where r.id = any (me.ids) and r.kind = 'rank' and r.department = x.dept and p.perm = 'applications.review') end
  from x
$$;
revoke execute on function public.app_is_reviewer(text, text) from public, anon, authenticated;

create or replace function public.app_approval_count(sub_id bigint)
returns integer language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.application_approvals a join public.form_submissions s on s.id = a.submission_id
  where a.submission_id = sub_id and a.decision = 1 and a.reviewer_discord_id <> s.submitter_discord_id
    and public.app_is_reviewer(s.form_key, a.reviewer_discord_id)
$$;
revoke execute on function public.app_approval_count(bigint) from public, anon, authenticated;

create or replace function public.app_detail(sub_id bigint)
returns jsonb language sql stable security definer set search_path = '' as $$
  select d || jsonb_build_object(
    'approvals', (select coalesce(jsonb_agg(jsonb_build_object('name', a.reviewer_name, 'decision', a.decision, 'at', a.created_at,
                    'mine', a.reviewer_discord_id = public.my_discord_id(),
                    'eligible', public.app_is_reviewer(s.form_key, a.reviewer_discord_id)) order by a.created_at), '[]'::jsonb)
                  from public.application_approvals a where a.submission_id = sub_id),
    'approvals_count', public.app_approval_count(sub_id),
    'approvals_needed', x.approvals_needed, 'final_by_exec', x.final_by_exec, 'is_exec', public.is_exec())
  from public.app_detail_core(sub_id) d
  join public.form_submissions s on s.id = sub_id join public.forms x on x.key = s.form_key
  where d is not null
$$;
revoke execute on function public.app_detail(bigint) from public, anon;
grant execute on function public.app_detail(bigint) to authenticated;
