-- 0044: the final Accept counts as the decider's approval (owner, 19 Nov 2026: "Include the decider"; Delta re-test).
-- Accepting records the decider's approval in the same transaction (if they're an eligible reviewer and haven't
-- approved yet), then checks the count; a refused Accept rolls it back. Not accepting adds nothing.
create or replace function public.app_decide(sub_id bigint, accept boolean, note text default null,
                                            rank_role_id text default null, role_ids text[] default null)
returns void language plpgsql security definer set search_path = '' as $$
declare x public.forms; s public.form_submissions; n int; me text := public.my_discord_id();
begin
  select * into s from public.form_submissions where id = sub_id;
  select * into x from public.forms where key = s.form_key;
  if accept and x.key is not null then
    if x.final_by_exec and not public.is_exec() then raise exception 'An executive gives the final Accept for this application.'; end if;
    if x.approvals_needed > 1 then
      if s.status = 'pending' and s.submitter_discord_id is distinct from me and public.can_review_form(s.form_key) then
        insert into public.application_approvals (submission_id, reviewer_discord_id, reviewer_name, decision)
        values (sub_id, me, (select display_name from public.members where discord_id = me), 1)
        on conflict (submission_id, reviewer_discord_id) do update set decision = 1, created_at = now();
      end if;
      n := public.app_approval_count(sub_id);
      if n < x.approvals_needed then raise exception 'This needs % approvals, including yours (% so far).', x.approvals_needed, n; end if;
    end if;
  end if;
  perform public.app_decide_core(sub_id, accept, note, rank_role_id, role_ids);
end $$;
revoke execute on function public.app_decide(bigint, boolean, text, text, text[]) from public, anon;
grant execute on function public.app_decide(bigint, boolean, text, text, text[]) to authenticated;
