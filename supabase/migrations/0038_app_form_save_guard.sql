-- 0038: Delta V1 + V2 (Alpha; number from Charlie). Tightens only; apply when tested.
-- V1: the 0.19 settings form still calls app_form_save (retired at the v2 release in 0034). Until then it follows the
--     same rule as app_form_publish (0032): setting or changing the ranks a form gives needs app_can_give for each rank,
--     recorded as rank_set_by/at; Director and anything app_role_allowed refuses stay impossible.
-- V2: app_in_dept and app_audience_ok are only used inside SECURITY DEFINER functions; nobody may call them directly.

create or replace function public.app_form_save(form_key text, patch jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare x public.forms; dept text; ex boolean := public.is_exec(); st boolean; r text;
        rk text; extra text[]; ranks_new text[]; ranks_old text[]; rank_changed boolean;
begin
  select * into x from public.forms f where f.key = app_form_save.form_key and f.kind = 'application';
  if x.key is null then raise exception 'Unknown form.'; end if;
  dept := coalesce(x.department, x.review_team);
  st := public.app_can_edit(dept);
  if (patch ?| array['title', 'description', 'questions', 'open']) and not ex then
    raise exception 'Only executives can change the questions or open and close the form.'; end if;
  if (patch ?| array['stages', 'accept_rank_role_id', 'accept_role_ids', 'cooldown_days']) and not st then
    raise exception 'You can''t change this department''s application settings.'; end if;
  if patch ? 'stages' and (jsonb_typeof(patch->'stages') <> 'array'
      or exists (select 1 from jsonb_array_elements(patch->'stages') e where jsonb_typeof(e) <> 'string' or char_length(e #>> '{}') not between 1 and 40)) then
    raise exception 'Stages must be short names.'; end if;
  if patch ? 'questions' and (jsonb_typeof(patch->'questions') <> 'array' or jsonb_array_length(patch->'questions') > 30) then
    raise exception 'Questions must be a list of at most 30.'; end if;
  rk := case when patch ? 'accept_rank_role_id' then nullif(patch->>'accept_rank_role_id', '') else x.accept_rank_role_id end;
  extra := case when patch ? 'accept_role_ids' then array(select jsonb_array_elements_text(patch->'accept_role_ids')) else coalesce(x.accept_role_ids, '{}') end;
  if rk is not null and not public.app_role_allowed(rk, dept) then raise exception 'That rank can''t be given by an application.'; end if;
  foreach r in array extra loop
    if not public.app_role_allowed(r, dept) then raise exception 'One of the extra roles can''t be given from here.'; end if;
  end loop;
  ranks_new := array(select u.i from unnest(array_remove(array[rk], null) || extra) as u(i) where (select kind from public.roles where id = u.i) = 'rank' order by 1);
  ranks_old := array(select u.i from unnest(array_remove(array[x.accept_rank_role_id], null) || coalesce(x.accept_role_ids, '{}')) as u(i)
                     where (select kind from public.roles where id = u.i) = 'rank' order by 1);
  rank_changed := ranks_new is distinct from ranks_old;
  if rank_changed then
    foreach r in array ranks_new loop
      if not public.app_can_give(dept, r) then raise exception 'You can''t give %. Ask the Director.', (select name from public.roles where id = r); end if;
    end loop;
  end if;
  update public.forms f set
    title = case when patch ? 'title' then coalesce(nullif(btrim(patch->>'title'), ''), f.title) else f.title end,
    description = case when patch ? 'description' then nullif(btrim(patch->>'description'), '') else f.description end,
    questions = case when patch ? 'questions' then patch->'questions' else f.questions end,
    open = case when patch ? 'open' then (patch->>'open')::boolean else f.open end,
    stages = case when patch ? 'stages' then patch->'stages' else f.stages end,
    accept_rank_role_id = rk, accept_role_ids = extra,
    cooldown_days = case when patch ? 'cooldown_days' then least(365, greatest(0, (patch->>'cooldown_days')::int)) else f.cooldown_days end,
    rank_set_by = case when rank_changed then public.my_discord_id() else f.rank_set_by end,
    rank_set_by_name = case when rank_changed then (select display_name from public.members where discord_id = public.my_discord_id()) else f.rank_set_by_name end,
    rank_set_at = case when rank_changed then now() else f.rank_set_at end
  where f.key = x.key;
end $$;
revoke execute on function public.app_form_save(text, jsonb) from public, anon;
grant execute on function public.app_form_save(text, jsonb) to authenticated;

revoke execute on function public.app_in_dept(text, text) from public, anon, authenticated;
revoke execute on function public.app_audience_ok(text, text) from public, anon, authenticated;
