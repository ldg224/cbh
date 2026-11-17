-- 0028: Applications redesign (Alpha; number from Charlie, after Bravo's 0027 rank permissions / has_perm).
-- Owner-approved plan (18 Nov 2026): one application per department; each department sets its own review stages,
-- the roles given on accept and the wait before reapplying; private reviewer notes with a thumbs up/down; applicants
-- track their application and can withdraw; one waiting application per department; Incident Report leaves Apply.
-- Who may: review = has_perm('applications.review', dept); department settings (stages, roles, wait) =
-- has_perm('applications.settings', dept); questions, title, open/closed = executives. Execs and the department's
-- Director always pass has_perm (0027).
-- The bot (Bravo) gives roles from role_changes ('add' = department + starting rank, 'grant' = extra roles), sends
-- the result DM (status accepted/denied, notified=false) and refreshes the #form-submissions post when post_dirty.
-- Additive: new columns, wider checks, new table, new functions; can_review_form now uses has_perm.

-- ---------- columns ----------
alter table public.forms
  add column if not exists department text,
  add column if not exists stages jsonb not null default '["In review"]'::jsonb,
  add column if not exists accept_rank_role_id text,
  add column if not exists accept_role_ids text[] not null default '{}',
  add column if not exists cooldown_days integer not null default 14;
alter table public.forms drop constraint if exists forms_department_check;
alter table public.forms add constraint forms_department_check
  check (department is null or department in ('Administration', 'Community Engagement', 'Nursing', 'Paramedicine'));
alter table public.forms drop constraint if exists forms_cooldown_check;
alter table public.forms add constraint forms_cooldown_check check (cooldown_days between 0 and 365);
alter table public.forms drop constraint if exists forms_stages_check;
alter table public.forms add constraint forms_stages_check
  check (jsonb_typeof(stages) = 'array' and jsonb_array_length(stages) <= 8);

alter table public.form_submissions
  add column if not exists stage text,
  add column if not exists post_dirty boolean not null default false,
  add column if not exists withdrawn_at timestamptz;
alter table public.form_submissions drop constraint if exists form_submissions_status_check;
alter table public.form_submissions add constraint form_submissions_status_check
  check (status in ('pending', 'accepted', 'denied', 'reviewed', 'withdrawn'));

alter table public.role_changes add column if not exists role_ids text[];
alter table public.role_changes drop constraint if exists role_changes_action_check;
alter table public.role_changes add constraint role_changes_action_check
  check (action in ('set_rank', 'add', 'remove', 'grant'));

-- ---------- the four department applications ----------
update public.forms set department = 'Administration', review_team = 'Administration',
  accept_rank_role_id = coalesce(accept_rank_role_id, '1472806484877250772') where key = 'admin-application';
update public.forms set department = 'Community Engagement', review_team = 'Community Engagement',
  accept_rank_role_id = coalesce(accept_rank_role_id, '1572101884473376768') where key = 'ce-application';
insert into public.forms (key, title, description, kind, audience, review_team, open, questions, sort, department, accept_rank_role_id)
values
  ('nursing-application', 'Nursing Application', 'Apply to join the Nursing department.', 'application', 'member', 'Nursing', false,
   '[{"id":"roblox","type":"text","label":"Roblox username","required":true},
     {"id":"age","type":"number","label":"How old are you?","required":true},
     {"id":"timezone","type":"text","label":"Your time zone","required":true},
     {"id":"why","type":"long","label":"Why do you want to join Nursing?","required":true},
     {"id":"experience","type":"long","label":"Any roleplay hospital experience?","required":false}]'::jsonb, 3, 'Nursing', '1472804164038823987'),
  ('paramedicine-application', 'Paramedicine Application', 'Apply to join the Paramedicine department.', 'application', 'member', 'Paramedicine', false,
   '[{"id":"roblox","type":"text","label":"Roblox username","required":true},
     {"id":"age","type":"number","label":"How old are you?","required":true},
     {"id":"timezone","type":"text","label":"Your time zone","required":true},
     {"id":"why","type":"long","label":"Why do you want to join Paramedicine?","required":true},
     {"id":"experience","type":"long","label":"Any roleplay hospital experience?","required":false}]'::jsonb, 4, 'Paramedicine', '1478678191127400570')
on conflict (key) do nothing;
update public.forms set open = false where key = 'incident-report';

-- ---------- reviewer notes ----------
create table if not exists public.application_notes (
  id             bigint generated always as identity primary key,
  submission_id  bigint not null references public.form_submissions (id) on delete cascade,
  author_discord_id text not null,
  author_name    text,
  body           text check (body is null or char_length(body) <= 2000),
  vote           smallint check (vote in (-1, 1)),
  created_at     timestamptz not null default now(),
  check (body is not null or vote is not null)
);
create index if not exists application_notes_sub on public.application_notes (submission_id);
alter table public.application_notes enable row level security;
revoke all on public.application_notes from anon, authenticated;
-- read and written only through the functions below

-- ---------- helpers ----------
create or replace function public.form_department(f text)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce(x.department, x.review_team) from public.forms x where x.key = f
$$;

create or replace function public.can_review_form(f text)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_exec() or coalesce(public.has_perm('applications.review', public.form_department(f)), false)
$$;

-- Extra roles a department may give on accept: never leadership, executive, bot, verified, other departments'
-- ranks, the Presidential or Directors office keys, or Server Booster.
create or replace function public.app_role_allowed(role_id text, dept text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.roles r where r.id = role_id
      and r.id not in ('1464027453339992269', '1464028008909377686', '1472796097960480778')
      and (r.kind in ('office', 'ping', 'status', 'community') or (r.kind in ('rank', 'department') and r.department = dept))
      and coalesce(r.rank_label, '') not in ('Director', 'Leader'))
$$;

-- When this person may apply to this form again (null = now). One waiting application per department, and the
-- form's wait after a "Not accepted".
create or replace function public.app_next_allowed(f text, who text)
returns timestamptz language sql stable security definer set search_path = '' as $$
  select max(t) from (
    select 'infinity'::timestamptz as t from public.form_submissions s
      where s.submitter_discord_id = who and s.status = 'pending'
        and public.form_department(s.form_key) is not distinct from public.form_department(f)
    union all
    select s.reviewed_at + make_interval(days => x.cooldown_days) from public.form_submissions s
      join public.forms x on x.key = s.form_key
      where s.submitter_discord_id = who and s.status = 'denied' and s.form_key = f
        and s.reviewed_at + make_interval(days => x.cooldown_days) > now()
  ) q
$$;

-- Every new submission (website insert) obeys the rules above.
create or replace function public.app_before_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare nxt timestamptz;
begin
  if (select kind from public.forms where key = new.form_key) = 'application' then
    nxt := public.app_next_allowed(new.form_key, new.submitter_discord_id);
    if nxt = 'infinity' then raise exception 'You already have an application waiting for this department.'; end if;
    if nxt is not null then raise exception 'You can apply again on %.', to_char(nxt at time zone 'Australia/Sydney', 'FMDD Mon YYYY'); end if;
    new.stage := null;
  end if;
  return new;
end $$;
drop trigger if exists app_before_insert on public.form_submissions;
create trigger app_before_insert before insert on public.form_submissions for each row execute function public.app_before_insert();

-- ---------- applicant ----------
-- Forms open to me, with my latest application to each and when I may apply again.
create or replace function public.app_my_forms()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'key', x.key, 'title', x.title, 'description', x.description, 'department', x.department, 'open', x.open,
    'questions', x.questions, 'stages', x.stages,
    'next_allowed', public.app_next_allowed(x.key, public.my_discord_id()),
    'latest', (select jsonb_build_object('id', s.id, 'status', s.status, 'stage', s.stage, 'created_at', s.created_at,
                                         'reviewed_at', s.reviewed_at, 'review_note', s.review_note)
               from public.form_submissions s where s.form_key = x.key and s.submitter_discord_id = public.my_discord_id()
               order by s.created_at desc limit 1)) order by x.sort), '[]'::jsonb)
  from public.forms x
  where public.is_member() and x.kind = 'application'
    and ((x.audience = 'member') or (x.audience = 'team' and public.is_team()) or (x.audience = 'admin' and public.is_admin()))
$$;

create or replace function public.app_withdraw(sub_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.form_submissions set status = 'withdrawn', withdrawn_at = now(), notified = true, post_dirty = true
  where id = sub_id and submitter_discord_id = public.my_discord_id() and status = 'pending';
  if not found then raise exception 'This application can''t be withdrawn any more.'; end if;
end $$;

-- ---------- reviewers ----------
-- Applications I may review (newest first), with note and vote counts.
create or replace function public.app_review_list(include_done boolean default false)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', s.id, 'form_key', s.form_key, 'department', public.form_department(s.form_key), 'status', s.status, 'stage', s.stage,
    'submitter_discord_id', s.submitter_discord_id, 'submitter_name', coalesce(m.display_name, s.submitter_name),
    'avatar_url', m.avatar_url, 'created_at', s.created_at, 'reviewed_at', s.reviewed_at, 'reviewer_name', s.reviewer_name,
    'up', (select count(*) from public.application_notes n where n.submission_id = s.id and n.vote = 1),
    'down', (select count(*) from public.application_notes n where n.submission_id = s.id and n.vote = -1),
    'notes', (select count(*) from public.application_notes n where n.submission_id = s.id and n.body is not null))
    order by s.created_at desc), '[]'::jsonb)
  from public.form_submissions s
  join public.forms x on x.key = s.form_key and x.kind = 'application'
  left join public.members m on m.discord_id = s.submitter_discord_id
  where public.can_review_form(s.form_key)
    and (s.status = 'pending' or (include_done and s.created_at > now() - interval '180 days'))
$$;

-- One application in full: answers, the applicant, their other applications, notes, and the form's settings.
create or replace function public.app_detail(sub_id bigint)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'sub', to_jsonb(s) - 'message_id' - 'notified' - 'post_dirty',
    'form', jsonb_build_object('key', x.key, 'title', x.title, 'department', public.form_department(x.key), 'questions', x.questions,
                               'stages', x.stages, 'accept_rank_role_id', x.accept_rank_role_id, 'accept_role_ids', x.accept_role_ids),
    'applicant', (select jsonb_build_object('display_name', m.display_name, 'username', m.username, 'avatar_url', m.avatar_url,
                                            'joined_at', m.joined_at, 'account_created_at', m.account_created_at, 'in_server', true)
                  from public.members m where m.discord_id = s.submitter_discord_id),
    'history', (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'form_key', o.form_key, 'status', o.status,
                                  'created_at', o.created_at, 'reviewed_at', o.reviewed_at) order by o.created_at desc), '[]'::jsonb)
                from public.form_submissions o where o.submitter_discord_id = s.submitter_discord_id and o.id <> s.id),
    'notes', (select coalesce(jsonb_agg(jsonb_build_object('id', n.id, 'author_discord_id', n.author_discord_id, 'author_name', n.author_name,
                                'body', n.body, 'vote', n.vote, 'created_at', n.created_at, 'mine', n.author_discord_id = public.my_discord_id())
                                order by n.created_at), '[]'::jsonb)
              from public.application_notes n where n.submission_id = s.id),
    'can_settings', public.is_exec() or coalesce(public.has_perm('applications.settings', public.form_department(x.key)), false))
  from public.form_submissions s join public.forms x on x.key = s.form_key
  where s.id = sub_id and public.can_review_form(s.form_key)
$$;

-- A note and/or a thumbs up/down. One vote per reviewer per application (a new vote replaces the old one).
create or replace function public.app_note(sub_id bigint, p_note text default null, p_vote smallint default null)
returns void language plpgsql security definer set search_path = '' as $$
declare me text := public.my_discord_id(); nm text := (select display_name from public.members where discord_id = public.my_discord_id());
begin
  if not exists (select 1 from public.form_submissions s where s.id = sub_id and public.can_review_form(s.form_key)) then
    raise exception 'You can''t review this application.'; end if;
  p_note := nullif(btrim(coalesce(p_note, '')), '');
  if p_note is null and p_vote is null then raise exception 'Write a note or choose thumbs up or down.'; end if;
  if p_vote is not null then
    delete from public.application_notes n where n.submission_id = sub_id and n.author_discord_id = me and n.body is null and n.vote is not null;
    update public.application_notes n set vote = null where n.submission_id = sub_id and n.author_discord_id = me and n.body is not null;
  end if;
  insert into public.application_notes (submission_id, author_discord_id, author_name, body, vote) values (sub_id, me, nm, p_note, p_vote);
end $$;

create or replace function public.app_note_delete(note_id bigint)
returns void language sql security definer set search_path = '' as $$
  delete from public.application_notes where id = note_id and author_discord_id = public.my_discord_id()
$$;

create or replace function public.app_set_stage(sub_id bigint, new_stage text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.form_submissions s set stage = nullif(new_stage, ''), post_dirty = true
  where s.id = sub_id and s.status = 'pending' and public.can_review_form(s.form_key)
    and (nullif(new_stage, '') is null or exists (select 1 from public.forms x where x.key = s.form_key and x.stages ? new_stage));
  if not found then raise exception 'Couldn''t move this application. It may have been decided already.'; end if;
end $$;

-- Accept or Not accept. On accept, roles: the starting rank (department + rank, 'add') and extra roles ('grant').
-- Choosing roles other than the department's defaults needs applications.settings.
create or replace function public.app_decide(sub_id bigint, accept boolean, note text default null,
                                            rank_role_id text default null, role_ids text[] default null)
returns void language plpgsql security definer set search_path = '' as $$
declare s public.form_submissions; x public.forms; dept text; me text := public.my_discord_id();
        nm text := (select display_name from public.members where discord_id = public.my_discord_id());
        rk text; extra text[]; r text;
begin
  select * into s from public.form_submissions where id = sub_id for update;
  if s.id is null or not public.can_review_form(s.form_key) then raise exception 'You can''t review this application.'; end if;
  if s.status <> 'pending' then raise exception 'This application has already been decided.'; end if;
  if s.submitter_discord_id = me then raise exception 'You can''t decide your own application.'; end if;
  select * into x from public.forms where key = s.form_key;
  dept := public.form_department(s.form_key);
  update public.form_submissions set status = case when accept then 'accepted' else 'denied' end,
    reviewer_discord_id = me, reviewer_name = nm, review_note = nullif(btrim(coalesce(note, '')), ''),
    reviewed_at = now(), notified = false, post_dirty = true
  where id = sub_id;
  if not accept then return; end if;
  rk := coalesce(rank_role_id, x.accept_rank_role_id);
  extra := coalesce(role_ids, x.accept_role_ids, '{}');
  if (rk is distinct from x.accept_rank_role_id or extra is distinct from x.accept_role_ids)
     and not (public.is_exec() or coalesce(public.has_perm('applications.settings', dept), false)) then
    raise exception 'Only people who can change this department''s settings can choose different roles.'; end if;
  if rk is not null and not exists (select 1 from public.roles where id = rk and kind = 'rank' and department = dept and rank_label not in ('Director', 'Leader')) then
    raise exception 'That starting rank isn''t a % rank.', dept; end if;
  foreach r in array extra loop
    if not public.app_role_allowed(r, dept) then raise exception 'One of the extra roles can''t be given from here.'; end if;
  end loop;
  if rk is not null then
    insert into public.role_changes (target_discord_id, target_name, department, action, rank_role_id, rank_label, requested_by, requested_by_name, status, reason)
    values (s.submitter_discord_id, s.submitter_name, dept, 'add', rk, (select rank_label from public.roles where id = rk), me, nm, 'pending',
            'Application #' || s.id || ' accepted');
  end if;
  if array_length(extra, 1) > 0 then
    insert into public.role_changes (target_discord_id, target_name, department, action, role_ids, requested_by, requested_by_name, status, reason)
    values (s.submitter_discord_id, s.submitter_name, dept, 'grant', extra, me, nm, 'pending', 'Application #' || s.id || ' accepted');
  end if;
end $$;

-- ---------- form settings ----------
-- Executives: title, description, questions, open. Department (applications.settings): stages, roles, wait.
create or replace function public.app_form_save(form_key text, patch jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare dept text := public.form_department(form_key); ex boolean := public.is_exec();
        st boolean := public.is_exec() or coalesce(public.has_perm('applications.settings', public.form_department(form_key)), false);
        r text;
begin
  if not exists (select 1 from public.forms where key = form_key and kind = 'application') then raise exception 'Unknown form.'; end if;
  if (patch ?| array['title', 'description', 'questions', 'open']) and not ex then
    raise exception 'Only executives can change the questions or open and close the form.'; end if;
  if (patch ?| array['stages', 'accept_rank_role_id', 'accept_role_ids', 'cooldown_days']) and not st then
    raise exception 'You can''t change this department''s application settings.'; end if;
  if patch ? 'stages' and (jsonb_typeof(patch->'stages') <> 'array'
      or exists (select 1 from jsonb_array_elements(patch->'stages') e where jsonb_typeof(e) <> 'string' or char_length(e #>> '{}') not between 1 and 40)) then
    raise exception 'Stages must be short names.'; end if;
  if patch ? 'accept_rank_role_id' and patch->>'accept_rank_role_id' is not null
     and not exists (select 1 from public.roles where id = patch->>'accept_rank_role_id' and kind = 'rank' and department = dept and rank_label not in ('Director', 'Leader')) then
    raise exception 'The starting rank must be a % rank.', dept; end if;
  if patch ? 'accept_role_ids' then
    for r in select jsonb_array_elements_text(patch->'accept_role_ids') loop
      if not public.app_role_allowed(r, dept) then raise exception 'One of the extra roles can''t be given from here.'; end if;
    end loop;
  end if;
  if patch ? 'questions' and (jsonb_typeof(patch->'questions') <> 'array' or jsonb_array_length(patch->'questions') > 30) then
    raise exception 'Questions must be a list of at most 30.'; end if;
  update public.forms f set
    title = case when patch ? 'title' then coalesce(nullif(btrim(patch->>'title'), ''), f.title) else f.title end,
    description = case when patch ? 'description' then nullif(btrim(patch->>'description'), '') else f.description end,
    questions = case when patch ? 'questions' then patch->'questions' else f.questions end,
    open = case when patch ? 'open' then (patch->>'open')::boolean else f.open end,
    stages = case when patch ? 'stages' then patch->'stages' else f.stages end,
    accept_rank_role_id = case when patch ? 'accept_rank_role_id' then patch->>'accept_rank_role_id' else f.accept_rank_role_id end,
    accept_role_ids = case when patch ? 'accept_role_ids' then array(select jsonb_array_elements_text(patch->'accept_role_ids')) else f.accept_role_ids end,
    cooldown_days = case when patch ? 'cooldown_days' then (patch->>'cooldown_days')::int else f.cooldown_days end
  where f.key = form_key;
end $$;

-- Roles a department may give on accept (for the settings form and the accept panel).
create or replace function public.app_role_choices(dept text)
returns table (id text, name text, kind text, rank_order integer, color bigint)
language sql stable security definer set search_path = '' as $$
  select r.id, r.name, r.kind, r.rank_order, coalesce(r.badge_color, r.color)::bigint from public.roles r
  where (public.is_exec() or coalesce(public.has_perm('applications.review', dept), false)) and public.app_role_allowed(r.id, dept)
  order by (r.kind = 'rank') desc, r.rank_order, r.name
$$;

do $g$
declare f text;
begin
  foreach f in array array[
    'form_department(text)', 'app_role_allowed(text, text)', 'app_next_allowed(text, text)', 'app_my_forms()',
    'app_withdraw(bigint)', 'app_review_list(boolean)', 'app_detail(bigint)', 'app_note(bigint, text, smallint)',
    'app_note_delete(bigint)', 'app_set_stage(bigint, text)', 'app_decide(bigint, boolean, text, text, text[])',
    'app_form_save(text, jsonb)', 'app_role_choices(text)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $g$;
revoke execute on function public.app_before_insert() from public, anon, authenticated;
