-- 0032: Applications v2 (Alpha; number from Charlie). Owner, 18-19 Nov 2026: applications live in each department
-- page; several applications per department under named groups; each has its own audience, sections of questions,
-- stages, roles on accept and reapply wait; a builder with autosaved drafts kept apart from the published form.
-- Permissions (rank permissions, 0027): applications.settings ("Edit applications") = create, edit, publish, archive;
-- applications.review ("Review applications") = the queue, notes, votes, accept / not accept.
-- Audience (enforced here): audience_ranks null/empty = everyone in the server who isn't in the department yet;
-- otherwise only people holding one of those ranks of the department (e.g. "Become a Leader": Trainee, Team Member).
-- Accept may give Leader or Year 4/5 (owner), never Director. The rank check sits with whoever puts a rank on the form
-- (Charlie, option b): publishing a form whose ranks are new or changed needs app_can_give for each rank (exec, the
-- Director, or members.edit with a window covering it), recorded as rank_set_by/at. Reviewers then accept with the
-- form's published roles as they stand; changing them at accept time needs app_can_give (and Edit applications).
-- Additive: new columns, new functions, replaced app_* functions, column-level read on forms (drafts hidden).

alter table public.forms
  add column if not exists section text,
  add column if not exists audience_ranks text[],
  add column if not exists draft jsonb,
  add column if not exists draft_saved_at timestamptz,
  add column if not exists draft_by_name text,
  add column if not exists archived boolean not null default false,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists published_at timestamptz,
  add column if not exists rank_set_by text,
  add column if not exists rank_set_by_name text,
  add column if not exists rank_set_at timestamptz;
alter table public.forms drop constraint if exists forms_draft_size;
alter table public.forms add constraint forms_draft_size check (draft is null or pg_column_size(draft) < 200000);

-- (Hiding the draft columns from plain table reads is a separate migration, applied with the release, because
-- the live 0.19 page still reads forms with select *.)

-- ---------- who ----------
create or replace function public.app_can_edit(dept text)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_exec() or coalesce(public.has_perm('applications.settings', dept), false)
$$;

-- Could I give this rank directly on the Members tab? (exec, the Director, or members.edit with a window covering it)
create or replace function public.app_can_give(dept text, rank_id text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare rk public.roles; w record;
begin
  select * into rk from public.roles where id = rank_id;
  if not found or rk.kind <> 'rank' or rk.department is distinct from dept or rk.rank_label = 'Director' then return false; end if;
  if public.is_exec() or public.directs_dept(dept) then return true; end if;
  if not coalesce(public.has_perm('members.edit', dept), false) then return false; end if;
  select * into w from public.my_members_window(dept) x;
  return w.lo is not null and rk.rank_order between w.lo and w.hi;
end $$;

-- Roles an application may give: this department's ranks (never Director), pings, statuses and community roles.
-- Never leadership, executive, office keys, bot, verified, other departments, or Server Booster.
create or replace function public.app_role_allowed(role_id text, dept text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.roles r where r.id = role_id
      and r.id <> '1472796097960480778'
      and (r.kind in ('ping', 'status', 'community') or (r.kind in ('rank', 'department') and r.department = dept))
      and coalesce(r.rank_label, '') <> 'Director')
$$;

-- Is this person in the department (any of its department or rank roles)?
create or replace function public.app_in_dept(who text, dept text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.members m join public.roles r on r.id = any (m.role_ids)
                 where m.discord_id = who and r.kind in ('department', 'rank') and r.department = dept)
$$;

-- May this person see and apply to this form?
create or replace function public.app_audience_ok(f text, who text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.forms x where x.key = f and x.kind = 'application' and not x.archived
      and exists (select 1 from public.members m where m.discord_id = who)
      and case when coalesce(cardinality(x.audience_ranks), 0) = 0
               then not public.app_in_dept(who, coalesce(x.department, x.review_team))
               else exists (select 1 from public.members m where m.discord_id = who and m.role_ids && x.audience_ranks) end)
$$;

-- When this person may apply to this form again: one waiting application per form, and the wait after "Not accepted".
create or replace function public.app_next_allowed(f text, who text)
returns timestamptz language sql stable security definer set search_path = '' as $$
  select max(t) from (
    select 'infinity'::timestamptz as t from public.form_submissions s
      where s.submitter_discord_id = who and s.status = 'pending' and s.form_key = f
    union all
    select s.reviewed_at + make_interval(days => x.cooldown_days) from public.form_submissions s
      join public.forms x on x.key = s.form_key
      where s.submitter_discord_id = who and s.status = 'denied' and s.form_key = f
        and s.reviewed_at + make_interval(days => x.cooldown_days) > now()
  ) q
$$;

create or replace function public.app_before_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare nxt timestamptz; x public.forms;
begin
  select * into x from public.forms where key = new.form_key;
  if x.kind = 'application' then
    if not x.open or x.archived then raise exception 'This application is closed.'; end if;
    if not public.app_audience_ok(new.form_key, new.submitter_discord_id) then raise exception 'This application isn''t open to you.'; end if;
    nxt := public.app_next_allowed(new.form_key, new.submitter_discord_id);
    if nxt = 'infinity' then raise exception 'You already have this application waiting.'; end if;
    if nxt is not null then raise exception 'You can apply again on %.', to_char(nxt at time zone 'Australia/Sydney', 'FMDD Mon YYYY'); end if;
    new.stage := null;
  end if;
  return new;
end $$;

-- ---------- applicant ----------
create or replace function public.app_my_forms()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'key', x.key, 'title', x.title, 'description', x.description, 'department', coalesce(x.department, x.review_team),
    'section', x.section, 'open', x.open, 'questions', x.questions, 'stages', x.stages,
    'can_apply', public.app_audience_ok(x.key, public.my_discord_id()),
    'next_allowed', public.app_next_allowed(x.key, public.my_discord_id()),
    'latest', (select jsonb_build_object('id', s.id, 'status', s.status, 'stage', s.stage, 'created_at', s.created_at,
                                         'reviewed_at', s.reviewed_at, 'review_note', s.review_note)
               from public.form_submissions s where s.form_key = x.key and s.submitter_discord_id = public.my_discord_id()
               order by s.created_at desc limit 1)) order by x.sort, x.title), '[]'::jsonb)
  from public.forms x
  where public.is_member() and x.kind = 'application' and not x.archived
    and (public.app_audience_ok(x.key, public.my_discord_id())
         or exists (select 1 from public.form_submissions s where s.form_key = x.key and s.submitter_discord_id = public.my_discord_id()))
$$;

-- ---------- builders ----------
-- Every application of a department, with its draft and how many are waiting.
create or replace function public.app_forms_admin(dept text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(to_jsonb(x) || jsonb_build_object(
      'waiting', (select count(*) from public.form_submissions s where s.form_key = x.key and s.status = 'pending'),
      'total', (select count(*) from public.form_submissions s where s.form_key = x.key))
    order by coalesce(x.section, ''), x.sort, x.title), '[]'::jsonb)
  from public.forms x
  where public.app_can_edit(dept) and x.kind = 'application' and not x.archived and coalesce(x.department, x.review_team) = dept
$$;

create or replace function public.app_form_create(dept text, title text)
returns text language plpgsql security definer set search_path = '' as $$
declare k text := 'app-' || substr(md5(random()::text || clock_timestamp()::text), 1, 10);
        nm text := (select display_name from public.members where discord_id = public.my_discord_id());
        t text := coalesce(nullif(btrim(title), ''), 'New application');
begin
  if dept not in ('Administration', 'Community Engagement', 'Nursing', 'Paramedicine') then raise exception 'Unknown department.'; end if;
  if not public.app_can_edit(dept) then raise exception 'You can''t create % applications.', dept; end if;
  insert into public.forms (key, title, description, kind, audience, review_team, open, questions, sort, department, stages,
                            accept_rank_role_id, accept_role_ids, cooldown_days, section, draft, draft_saved_at, draft_by_name)
  values (k, left(t, 80), null, 'application', 'member', dept, false, '[]'::jsonb,
          coalesce((select max(sort) from public.forms), 0) + 1, dept, '["In review"]'::jsonb,
          (select id from public.roles where kind = 'rank' and department = dept order by rank_order limit 1), '{}', 14, 'General',
          jsonb_build_object('title', left(t, 80), 'description', null, 'section', 'General', 'audience_ranks', '[]'::jsonb, 'open', false,
                             'questions', '[]'::jsonb, 'stages', '["In review"]'::jsonb,
                             'accept_rank_role_id', (select id from public.roles where kind = 'rank' and department = dept order by rank_order limit 1),
                             'accept_role_ids', '[]'::jsonb, 'cooldown_days', 14),
          now(), nm);
  return k;
end $$;

create or replace function public.app_form_draft_save(form_key text, draft jsonb)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare dept text := public.form_department(form_key); t timestamptz := now();
begin
  if not public.app_can_edit(dept) then raise exception 'You can''t edit % applications.', dept; end if;
  if jsonb_typeof(draft) <> 'object' then raise exception 'Draft must be an object.'; end if;
  update public.forms f set draft = app_form_draft_save.draft, draft_saved_at = t,
    draft_by_name = (select display_name from public.members where discord_id = public.my_discord_id())
  where f.key = form_key and not f.archived;
  if not found then raise exception 'This application no longer exists.'; end if;
  return t;
end $$;

create or replace function public.app_form_discard(form_key text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.app_can_edit(public.form_department(form_key)) then raise exception 'You can''t edit this application.'; end if;
  update public.forms set draft = null, draft_saved_at = null, draft_by_name = null where key = form_key;
end $$;

-- Check the draft and make it the live form.
create or replace function public.app_form_publish(form_key text)
returns void language plpgsql security definer set search_path = '' as $$
declare x public.forms; d jsonb; dept text; q jsonb; r text; ids text[] := '{}'; ranks text[]; rk text; extra text[];
        ranks_new text[]; ranks_old text[]; rank_changed boolean;
begin
  select * into x from public.forms where key = form_key and kind = 'application' and not archived for update;
  if x.key is null then raise exception 'This application no longer exists.'; end if;
  dept := coalesce(x.department, x.review_team);
  if not public.app_can_edit(dept) then raise exception 'You can''t edit % applications.', dept; end if;
  d := x.draft;
  if d is null then return; end if;
  if char_length(btrim(coalesce(d->>'title', ''))) not between 1 and 80 then raise exception 'Give the application a title (up to 80 characters).'; end if;
  if char_length(coalesce(d->>'description', '')) > 300 then raise exception 'Keep the description under 300 characters.'; end if;
  if char_length(coalesce(d->>'section', '')) > 40 then raise exception 'Keep the group name under 40 characters.'; end if;
  if jsonb_typeof(d->'questions') <> 'array' or jsonb_array_length(d->'questions') > 80 then raise exception 'Too many questions (80 at most).'; end if;
  if not exists (select 1 from jsonb_array_elements(d->'questions') e where e->>'type' <> 'section') then raise exception 'Add at least one question.'; end if;
  for q in select * from jsonb_array_elements(d->'questions') loop
    if coalesce(q->>'type', '') not in ('section', 'text', 'long', 'number', 'choice', 'yesno') then raise exception 'Unknown question type.'; end if;
    if char_length(btrim(coalesce(q->>'label', ''))) not between 1 and 300 then raise exception 'Every question and section needs some text.'; end if;
    if coalesce(q->>'id', '') = '' or q->>'id' = any (ids) then raise exception 'Question ids must be unique.'; end if;
    ids := ids || (q->>'id');
    if q->>'type' = 'choice' and (jsonb_typeof(q->'options') <> 'array' or jsonb_array_length(q->'options') not between 1 and 25) then
      raise exception '“%” needs at least one choice.', q->>'label'; end if;
  end loop;
  if jsonb_typeof(d->'stages') <> 'array' or jsonb_array_length(d->'stages') > 8
     or exists (select 1 from jsonb_array_elements(d->'stages') e where jsonb_typeof(e) <> 'string' or char_length(e #>> '{}') not between 1 and 40) then
    raise exception 'Stages must be short names (8 at most).'; end if;
  ranks := array(select jsonb_array_elements_text(coalesce(d->'audience_ranks', '[]'::jsonb)));
  if exists (select 1 from unnest(ranks) a where not exists (select 1 from public.roles where id = a and kind = 'rank' and department = dept)) then
    raise exception 'Who can apply must be % ranks.', dept; end if;
  rk := nullif(d->>'accept_rank_role_id', '');
  extra := array(select jsonb_array_elements_text(coalesce(d->'accept_role_ids', '[]'::jsonb)));
  if rk is not null and not public.app_role_allowed(rk, dept) then raise exception 'That rank can''t be given by an application.'; end if;
  foreach r in array extra loop
    if not public.app_role_allowed(r, dept) then raise exception 'One of the extra roles can''t be given by an application.'; end if;
  end loop;
  -- Ranks this form gives, before and after. New or changed ranks need the publisher to be able to give each one.
  ranks_new := array(select u.i from unnest(array_remove(array[rk], null) || extra) as u(i) where (select kind from public.roles where id = u.i) = 'rank' order by 1);
  ranks_old := case when x.published_at is null then '{}'::text[] else
    array(select u.i from unnest(array_remove(array[x.accept_rank_role_id], null) || coalesce(x.accept_role_ids, '{}')) as u(i)
          where (select kind from public.roles where id = u.i) = 'rank' order by 1) end;
  rank_changed := x.published_at is null or ranks_new is distinct from ranks_old;
  if rank_changed then
    foreach r in array ranks_new loop
      if not public.app_can_give(dept, r) then
        raise exception 'You can''t give %. Ask the Director.', (select name from public.roles where id = r); end if;
    end loop;
  end if;
  if coalesce((d->>'cooldown_days')::int, 14) not between 0 and 365 then raise exception 'The wait must be 0 to 365 days.'; end if;
  update public.forms set
    title = btrim(d->>'title'), description = nullif(btrim(coalesce(d->>'description', '')), ''),
    section = coalesce(nullif(btrim(coalesce(d->>'section', '')), ''), 'General'),
    audience_ranks = case when cardinality(ranks) = 0 then null else ranks end,
    open = coalesce((d->>'open')::boolean, false), questions = d->'questions', stages = d->'stages',
    accept_rank_role_id = rk, accept_role_ids = extra, cooldown_days = coalesce((d->>'cooldown_days')::int, 14),
    draft = null, draft_saved_at = null, draft_by_name = null, published_at = now(),
    rank_set_by = case when rank_changed then public.my_discord_id() else rank_set_by end,
    rank_set_by_name = case when rank_changed then (select display_name from public.members where discord_id = public.my_discord_id()) else rank_set_by_name end,
    rank_set_at = case when rank_changed then now() else rank_set_at end
  where key = form_key;
end $$;

-- Remove an application from the department (old applications to it stay in Decided).
create or replace function public.app_form_archive(form_key text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.app_can_edit(public.form_department(form_key)) then raise exception 'You can''t edit this application.'; end if;
  if exists (select 1 from public.form_submissions where form_submissions.form_key = app_form_archive.form_key and status = 'pending') then
    raise exception 'Decide or wait for the waiting applications first.'; end if;
  update public.forms set archived = true, open = false where key = form_key;
end $$;

-- ---------- reviewers ----------
create or replace function public.app_review_queue(include_done boolean default false, dept text default null)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', s.id, 'form_key', s.form_key, 'form_title', x.title, 'section', x.section, 'department', public.form_department(s.form_key),
    'status', s.status, 'stage', s.stage, 'stages', x.stages,
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
    and (app_review_queue.dept is null or coalesce(x.department, x.review_team) = app_review_queue.dept)
    and (s.status = 'pending' or (include_done and s.created_at > now() - interval '180 days'))
$$;

create or replace function public.app_detail(sub_id bigint)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'sub', to_jsonb(s) - 'message_id' - 'notified' - 'post_dirty' - 'post_rev',
    'form', jsonb_build_object('key', x.key, 'title', x.title, 'section', x.section, 'department', public.form_department(x.key),
                               'questions', x.questions, 'stages', x.stages, 'accept_rank_role_id', x.accept_rank_role_id,
                               'accept_role_ids', x.accept_role_ids),
    'applicant', (select jsonb_build_object('display_name', m.display_name, 'username', m.username, 'avatar_url', m.avatar_url,
                                            'joined_at', m.joined_at, 'account_created_at', m.account_created_at)
                  from public.members m where m.discord_id = s.submitter_discord_id),
    'history', (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'form_key', o.form_key, 'form_title', ox.title, 'status', o.status,
                                  'created_at', o.created_at, 'reviewed_at', o.reviewed_at) order by o.created_at desc), '[]'::jsonb)
                from public.form_submissions o join public.forms ox on ox.key = o.form_key
                where o.submitter_discord_id = s.submitter_discord_id and o.id <> s.id),
    'notes', (select coalesce(jsonb_agg(jsonb_build_object('id', n.id, 'author_discord_id', n.author_discord_id, 'author_name', n.author_name,
                                'body', n.body, 'vote', n.vote, 'created_at', n.created_at, 'mine', n.author_discord_id = public.my_discord_id())
                                order by n.created_at), '[]'::jsonb)
              from public.application_notes n where n.submission_id = s.id),
    'can_settings', public.app_can_edit(public.form_department(x.key)))
  from public.form_submissions s join public.forms x on x.key = s.form_key
  where s.id = sub_id and public.can_review_form(s.form_key)
$$;

-- Accept or Not accept. Choosing roles other than the form's needs Edit applications; any rank given (the starting
-- rank or a rank among the extra roles) must be one the person accepting could give directly.
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
    insert into public.role_changes (target_discord_id, target_name, department, action, rank_role_id, rank_label, requested_by, requested_by_name, status, reason)
    values (s.submitter_discord_id, s.submitter_name, dept, 'add', rk, (select rank_label from public.roles where id = rk), me, nm, 'pending',
            'Application #' || s.id || ' accepted');
  end if;
  if array_length(extra, 1) > 0 then
    insert into public.role_changes (target_discord_id, target_name, department, action, role_ids, requested_by, requested_by_name, status, reason)
    values (s.submitter_discord_id, s.submitter_name, dept, 'grant', extra, me, nm, 'pending', 'Application #' || s.id || ' accepted');
  end if;
end $$;

-- Roles a department's applications may give, for the builder and the accept panel.
drop function if exists public.app_role_choices(text);
create or replace function public.app_role_choices(dept text)
returns table (id text, name text, kind text, rank_order integer, color bigint, can_give boolean)
language sql stable security definer set search_path = '' as $$
  select r.id, r.name, r.kind, r.rank_order, coalesce(r.badge_color, r.color)::bigint,
         case when r.kind = 'rank' then public.app_can_give(dept, r.id) else true end
  from public.roles r
  where (public.app_can_edit(dept) or coalesce(public.has_perm('applications.review', dept), false)) and public.app_role_allowed(r.id, dept)
  order by (r.kind = 'rank') desc, r.rank_order, r.name
$$;

-- This department's ranks (for "Who can apply").
create or replace function public.app_dept_ranks(dept text)
returns table (id text, name text, rank_label text, rank_order integer)
language sql stable security definer set search_path = '' as $$
  select r.id, r.name, r.rank_label, r.rank_order from public.roles r
  where public.is_member() and r.kind = 'rank' and r.department = dept order by r.rank_order
$$;

update public.forms set section = 'General' where kind = 'application' and section is null;
-- Forms already live count as published, their roles approved when they were set up (0028).
update public.forms set published_at = coalesce(published_at, now()), rank_set_by_name = coalesce(rank_set_by_name, 'Set up before 0.20'),
  rank_set_at = coalesce(rank_set_at, now()) where kind = 'application';

do $g$
declare f text;
begin
  foreach f in array array[
    'app_can_edit(text)', 'app_can_give(text, text)', 'app_in_dept(text, text)', 'app_audience_ok(text, text)',
    'app_forms_admin(text)', 'app_form_create(text, text)', 'app_form_draft_save(text, jsonb)', 'app_form_discard(text)',
    'app_form_publish(text)', 'app_form_archive(text)', 'app_review_queue(boolean, text)', 'app_dept_ranks(text)',
    'app_role_choices(text)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $g$;
