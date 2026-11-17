-- 0035: QA fixes from Delta (Alpha; number from Charlie). Closes holes only, apply as soon as tested.
-- F1: no direct UPDATE of form_submissions by signed-in people; every change goes through the SECURITY DEFINER app_*
--     functions (app_decide, app_set_stage, app_withdraw), which check the rules. The bot uses the service role.
-- F5: app_next_allowed only answers for yourself, or for reviewers of that form.
-- F6 + F9: an applicant's insert can't set any review, notify or post field, and submitter_name comes from members.
-- F8: restoring an incident clears who removed it; removal fields can't be set except by removing.
-- (F4, office roles as extra roles, is already in 0032.)

-- ---------- F1 ----------
drop policy if exists form_submissions_review on public.form_submissions;
revoke update, delete, truncate on public.form_submissions from authenticated, anon;

-- ---------- F5 ----------
create or replace function public.app_next_allowed(f text, who text)
returns timestamptz language sql stable security definer set search_path = '' as $$
  select case when who is distinct from public.my_discord_id() and not public.can_review_form(f) then null else (
    select max(t) from (
      select 'infinity'::timestamptz as t from public.form_submissions s
        where s.submitter_discord_id = who and s.status = 'pending' and s.form_key = f
      union all
      select s.reviewed_at + make_interval(days => x.cooldown_days) from public.form_submissions s
        join public.forms x on x.key = s.form_key
        where s.submitter_discord_id = who and s.status = 'denied' and s.form_key = f
          and s.reviewed_at + make_interval(days => x.cooldown_days) > now()
    ) q) end
$$;

-- ---------- F6 + F9 ----------
create or replace function public.app_before_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare nxt timestamptz; x public.forms;
begin
  -- Only the database fills these in.
  new.status := 'pending'; new.stage := null; new.reviewer_discord_id := null; new.reviewer_name := null;
  new.review_note := null; new.reviewed_at := null; new.message_id := null; new.notified := false;
  new.post_dirty := false; new.post_rev := 0; new.withdrawn_at := null; new.created_at := now();
  new.submitter_name := coalesce((select m.display_name from public.members m where m.discord_id = new.submitter_discord_id), new.submitter_name);
  select * into x from public.forms where key = new.form_key;
  if x.kind = 'application' then
    if not x.open or x.archived then raise exception 'This application is closed.'; end if;
    if not public.app_audience_ok(new.form_key, new.submitter_discord_id) then raise exception 'This application isn''t open to you.'; end if;
    nxt := public.app_next_allowed(new.form_key, new.submitter_discord_id);
    if nxt = 'infinity' then raise exception 'You already have this application waiting.'; end if;
    if nxt is not null then raise exception 'You can apply again on %.', to_char(nxt at time zone 'Australia/Sydney', 'FMDD Mon YYYY'); end if;
  end if;
  return new;
end $$;

-- ---------- F8 ----------
create or replace function public.incidents_stamp() returns trigger
language plpgsql set search_path = '' as $$
declare me text := public.my_discord_id();
begin
  if tg_op = 'INSERT' then
    new.created_at := now(); new.edited_at := null; new.removed_at := null; new.removed_by := null; new.removed_by_name := null;
    new.created_by_name := (select m.display_name from public.members m where m.discord_id = new.created_by);
  else
    new.created_by := old.created_by; new.created_by_name := old.created_by_name; new.created_at := old.created_at;
    new.target_discord_id := old.target_discord_id;
    if old.removed_at is not null and new.removed_at is null and not public.is_exec() then
      raise exception 'Only executives can bring back a removed incident';
    end if;
    if new.removed_at is not null and old.removed_at is null then
      new.removed_at := now(); new.removed_by := me;
      new.removed_by_name := (select m.display_name from public.members m where m.discord_id = me);
    elsif new.removed_at is null then            -- live, or just restored: nobody removed it
      new.removed_by := null; new.removed_by_name := null;
    else                                         -- still removed: keep who removed it and when
      new.removed_at := old.removed_at; new.removed_by := old.removed_by; new.removed_by_name := old.removed_by_name;
    end if;
    if new.title is distinct from old.title or new.body is distinct from old.body
       or new.happened_at is distinct from old.happened_at or new.evidence is distinct from old.evidence then
      new.edited_at := now();
    else
      new.edited_at := old.edited_at;
    end if;
  end if;
  return new;
end $$;
