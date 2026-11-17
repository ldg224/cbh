-- 0017: supervisor review of mod actions (Alpha, approved by Charlie). Any admin can send a done case for review
-- (once while a review is open). A supervisor (execs, or whoever directs Administration) resolves it as upheld,
-- changed or overturned, with a note. Nobody reviews their own case or their own request. Everything is recorded.
-- Additive only.

alter table public.mod_cases add column if not exists review_status text check (review_status in ('requested', 'reviewed'));
alter table public.mod_cases add column if not exists review_requested_by text;
alter table public.mod_cases add column if not exists review_requested_by_name text;
alter table public.mod_cases add column if not exists review_requested_at timestamptz;
alter table public.mod_cases add column if not exists review_note text;
alter table public.mod_cases add column if not exists reviewed_by text;
alter table public.mod_cases add column if not exists reviewed_by_name text;
alter table public.mod_cases add column if not exists reviewed_at timestamptz;
alter table public.mod_cases add column if not exists review_outcome text check (review_outcome in ('upheld', 'changed', 'overturned'));
alter table public.mod_cases add column if not exists review_result_note text;
create index if not exists mod_cases_review_open on public.mod_cases (review_requested_at) where review_status = 'requested';

-- Who counts as a supervisor. One place to change it.
create or replace function public.is_supervisor() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_exec() or public.directs_dept('Administration')
$$;
revoke execute on function public.is_supervisor() from public, anon;
grant execute on function public.is_supervisor() to authenticated;

create or replace function public.request_review(case_id bigint, note text)
returns public.mod_cases
language plpgsql security definer set search_path = '' as $$
declare c public.mod_cases; me text := public.my_discord_id();
begin
  if not public.is_admin() then raise exception 'Only admins can send an action for review'; end if;
  if char_length(trim(coalesce(request_review.note, ''))) = 0 then raise exception 'Say what the supervisor should look at'; end if;
  select * into c from public.mod_cases x where x.id = case_id for update;
  if not found then raise exception 'That case doesn''t exist'; end if;
  if c.status <> 'done' then raise exception 'Only actions that went through can be reviewed'; end if;
  if c.review_status = 'requested' then raise exception 'That action is already waiting for review'; end if;
  update public.mod_cases set review_status = 'requested', review_requested_by = me,
    review_requested_by_name = (select m.display_name from public.members m where m.discord_id = me),
    review_requested_at = now(), review_note = left(trim(request_review.note), 1000),
    reviewed_by = null, reviewed_by_name = null, reviewed_at = null, review_outcome = null, review_result_note = null
  where id = case_id returning * into c;
  return c;
end $$;
revoke execute on function public.request_review(bigint, text) from public, anon;
grant execute on function public.request_review(bigint, text) to authenticated;

create or replace function public.resolve_review(case_id bigint, outcome text, note text)
returns public.mod_cases
language plpgsql security definer set search_path = '' as $$
declare c public.mod_cases; me text := public.my_discord_id();
begin
  if not public.is_supervisor() then raise exception 'Only supervisors can review actions'; end if;
  if resolve_review.outcome not in ('upheld', 'changed', 'overturned') then raise exception 'Choose upheld, changed or overturned'; end if;
  if char_length(trim(coalesce(resolve_review.note, ''))) = 0 then raise exception 'Add a short note about your decision'; end if;
  select * into c from public.mod_cases x where x.id = case_id for update;
  if not found then raise exception 'That case doesn''t exist'; end if;
  if c.review_status is distinct from 'requested' then raise exception 'That action isn''t waiting for review'; end if;
  if c.moderator_discord_id = me then raise exception 'You can''t review your own action'; end if;
  if c.review_requested_by = me then raise exception 'You can''t review an action you sent for review'; end if;
  update public.mod_cases set review_status = 'reviewed', reviewed_by = me,
    reviewed_by_name = (select m.display_name from public.members m where m.discord_id = me),
    reviewed_at = now(), review_outcome = resolve_review.outcome, review_result_note = left(trim(resolve_review.note), 1000)
  where id = case_id returning * into c;
  return c;
end $$;
revoke execute on function public.resolve_review(bigint, text, text) from public, anon;
grant execute on function public.resolve_review(bigint, text, text) to authenticated;
-- Reading: the review columns are on mod_cases, which admins can already read (mod_cases_read). No direct writes:
-- authenticated has no update on mod_cases, so only these functions change review fields.

-- New cases can't arrive with review fields filled in (admins may insert website cases directly).
create or replace function public.mod_cases_no_review_on_insert() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated', 'anon') then
    new.review_status := null; new.review_requested_by := null; new.review_requested_by_name := null;
    new.review_requested_at := null; new.review_note := null; new.reviewed_by := null; new.reviewed_by_name := null;
    new.reviewed_at := null; new.review_outcome := null; new.review_result_note := null;
  end if;
  return new;
end $$;
drop trigger if exists mod_cases_no_review_on_insert on public.mod_cases;
create trigger mod_cases_no_review_on_insert before insert on public.mod_cases
  for each row execute function public.mod_cases_no_review_on_insert();
