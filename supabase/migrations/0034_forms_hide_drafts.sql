-- 0034: hide application drafts from plain table reads (Alpha; number from Charlie). APPLY AT RELEASE, together with
-- the site push of Applications v2: the 0.19 page reads forms with select *, which this would break.
-- Builders read drafts through app_forms_admin() (0032); everyone else reads only the published columns.
revoke select on public.forms from authenticated, anon;
grant select (key, title, description, kind, audience, review_team, open, questions, sort, department, stages,
              accept_rank_role_id, accept_role_ids, cooldown_days, section, audience_ranks, archived, created_at, published_at,
              rank_set_by_name, rank_set_at)
  on public.forms to authenticated;

-- The 0.19 page's write and list paths, replaced in v2 by the builder (app_form_draft_save / app_form_publish) and
-- app_review_queue. Retired here, at release, so nothing can call them afterwards.
revoke execute on function public.app_form_save(text, jsonb) from public, anon, authenticated;
revoke execute on function public.app_review_list(boolean) from public, anon, authenticated;
