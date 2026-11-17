-- 0034: hide application drafts from plain table reads (Alpha; number from Charlie). APPLY AT RELEASE, together with
-- the site push of Applications v2: the 0.19 page reads forms with select *, which this would break.
-- Builders read drafts through app_forms_admin() (0032); everyone else reads only the published columns.
revoke select on public.forms from authenticated, anon;
grant select (key, title, description, kind, audience, review_team, open, questions, sort, department, stages,
              accept_rank_role_id, accept_role_ids, cooldown_days, section, audience_ranks, archived, created_at, published_at,
              rank_set_by_name, rank_set_at)
  on public.forms to authenticated;
