-- 0048: Courses on the department pages (Alpha; number from Charlie). Owner-approved mockup, 19 Nov 2026.
-- A course belongs to a department; its whole structure (modules and steps) is one jsonb document: `content` is
-- what people see once published, `draft` is what builders edit (autosaved, published with course_publish).
-- Steps: lesson (written on the site), slides (Google Slides embed), link (Google Docs or any https page), video
-- (YouTube), file (uploaded pdf/pptx/image in the private course-files bucket, 0051), quiz (quiz or formal exam),
-- eval (practical evaluation: competencies marked Not yet / Developing / Standard / Exceeding).
-- Rules enforced here (Charlie's conditions): audiences (chosen ranks, or everyone in the department), open dates,
-- prerequisites and due dates are checked in the database; members never read the courses table, only course_list
-- and course_view, which strip answer keys and show nothing past the header before a course opens; quiz answers
-- are marked by quiz_submit / course_mark_attempt; a quiz with anything needing a person to mark is HELD until it's
-- all marked; "done" for reading/watching is client-reported progress, but completion and prerequisites rest on
-- quizzes and assessor reports being passed. Permissions: courses.manage ("Edit courses") builds, courses.assess
-- ("Assess courses") marks and evaluates; execs and the department's Director always pass (has_perm).

create table if not exists public.courses (
  id             uuid primary key default gen_random_uuid(),
  department     text not null check (department in ('Administration', 'Community Engagement', 'Nursing', 'Paramedicine')),
  title          text not null check (char_length(title) between 1 and 100),
  status         text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  content        jsonb,            -- published: { title, description, kind, color, audience_ranks, opens_at, due_days, prereq, modules }
  draft          jsonb check (draft is null or pg_column_size(draft) < 1000000),
  draft_saved_at timestamptz,
  draft_by_name  text,
  audience_ranks text[],           -- from content, for fast checks; null/empty = everyone in the department
  opens_at       timestamptz,
  due_days       integer check (due_days is null or due_days between 1 and 365),
  prereq_id      uuid references public.courses (id) on delete set null,
  sort           integer not null default 0,
  created_by     text,
  created_at     timestamptz not null default now(),
  published_at   timestamptz
);
create index if not exists courses_dept on public.courses (department) where status <> 'archived';

create table if not exists public.course_progress (
  course_id  uuid not null references public.courses (id) on delete cascade,
  discord_id text not null,
  item_id    text not null,
  done_at    timestamptz not null default now(),
  primary key (course_id, discord_id, item_id)
);

create table if not exists public.course_attempts (
  id            bigint generated always as identity primary key,
  course_id     uuid not null references public.courses (id) on delete cascade,
  item_id       text not null,
  discord_id    text not null,
  started_at    timestamptz not null default now(),
  submitted_at  timestamptz,
  answers       jsonb,
  marks         jsonb,             -- { question_id: points } (auto + manual)
  score         numeric,
  max_score     numeric,
  status        text not null default 'in_progress' check (status in ('in_progress', 'marking', 'marked')),
  passed        boolean,
  marked_by     text,
  marked_by_name text,
  marked_at     timestamptz
);
create index if not exists course_attempts_who on public.course_attempts (course_id, item_id, discord_id);

create table if not exists public.course_extra_tries (
  course_id uuid not null references public.courses (id) on delete cascade,
  item_id text not null, discord_id text not null, extra integer not null default 0,
  primary key (course_id, item_id, discord_id)
);

create table if not exists public.course_evaluations (
  id            bigint generated always as identity primary key,
  course_id     uuid not null references public.courses (id) on delete cascade,
  item_id       text not null,
  discord_id    text not null,     -- the person evaluated
  assessor_id   text not null,
  assessor_name text,
  levels        jsonb not null default '{}',   -- { competency_id: 1..4 }
  comments      jsonb not null default '{}',   -- { competency_id: text, _overall: text }
  status        text not null default 'draft' check (status in ('draft', 'submitted')),
  passed        boolean,
  observed_on   date,
  created_at    timestamptz not null default now(),
  submitted_at  timestamptz
);
create index if not exists course_evals_who on public.course_evaluations (course_id, item_id, discord_id);

-- For CareBeyond Helper's DMs (Bravo): rows created by course_notices_due() and on exam results; the bot sends them.
create table if not exists public.course_notices (
  id         bigint generated always as identity primary key,
  course_id  uuid not null references public.courses (id) on delete cascade,
  discord_id text not null,
  kind       text not null check (kind in ('opened', 'due_soon', 'overdue', 'result')),
  title      text, department text, url text, detail text,
  ref        text not null default '',          -- e.g. the attempt id for results, so each result is sent once
  created_at timestamptz not null default now(),
  claimed_at timestamptz,                         -- the bot claims a row before sending (claim-before-send)
  sent_at    timestamptz, error text,
  unique (course_id, discord_id, kind, ref)      -- one per kind; results carry the attempt/evaluation id in ref
);

alter table public.courses enable row level security;
alter table public.course_progress enable row level security;
alter table public.course_attempts enable row level security;
alter table public.course_extra_tries enable row level security;
alter table public.course_evaluations enable row level security;
alter table public.course_notices enable row level security;
revoke all on public.courses, public.course_progress, public.course_attempts, public.course_extra_tries,
  public.course_evaluations, public.course_notices from anon, authenticated;
-- everything goes through the functions below; the bot uses the service role

-- ---------- who ----------
create or replace function public.course_can_edit(dept text)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_exec() or coalesce(public.has_perm('courses.manage', dept), false)
$$;
create or replace function public.course_can_assess(dept text)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_exec() or coalesce(public.has_perm('courses.assess', dept), false)
$$;
create or replace function public.dept_id_of(dept text)
returns text language sql immutable as $$
  select case dept when 'Administration' then 'administration' when 'Nursing' then 'nursing'
                   when 'Paramedicine' then 'paramedicine' when 'Community Engagement' then 'community' end
$$;

-- Is this person in the course's audience? (in the department, and holding one of its ranks if it names any)
create or replace function public.course_in_audience(cid uuid, who text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.courses c join public.members m on m.discord_id = who
    where c.id = cid and c.status = 'published'
      and exists (select 1 from public.roles r where r.id = any (m.role_ids) and r.kind in ('department', 'rank') and r.department = c.department)
      and (coalesce(cardinality(c.audience_ranks), 0) = 0 or m.role_ids && c.audience_ranks))
$$;

-- Has this person finished the course? Every step done; every quiz passed (marked and released); every
-- evaluation submitted and passed. Reading/watching steps count from course_progress.
create or replace function public.course_complete(cid uuid, who text)
returns boolean language sql stable security definer set search_path = '' as $$
  select c.status = 'published' and not exists (
    select 1 from jsonb_array_elements(coalesce(c.content->'modules', '[]')) m, jsonb_array_elements(coalesce(m->'items', '[]')) i
    where case i->>'kind'
      when 'quiz' then not exists (select 1 from public.course_attempts a where a.course_id = cid and a.item_id = i->>'id'
                                     and a.discord_id = who and a.status = 'marked' and a.passed)
      when 'eval' then not exists (select 1 from public.course_evaluations e where e.course_id = cid and e.item_id = i->>'id'
                                     and e.discord_id = who and e.status = 'submitted' and e.passed)
      else not exists (select 1 from public.course_progress p where p.course_id = cid and p.item_id = i->>'id' and p.discord_id = who) end)
  from public.courses c where c.id = cid
$$;

-- Why a course isn't open for this person yet (null = open): 'draft', 'date', 'prereq'.
create or replace function public.course_lock(cid uuid, who text)
returns text language sql stable security definer set search_path = '' as $$
  select case when c.status <> 'published' then 'draft'
              when c.opens_at is not null and c.opens_at > now() then 'date'
              when c.prereq_id is not null and not public.course_complete(c.prereq_id, who) then 'prereq'
              else null end
  from public.courses c where c.id = cid
$$;

create or replace function public.course_can_see(cid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.courses c where c.id = cid and c.status <> 'archived'
    and (public.course_can_edit(c.department) or (c.status = 'published' and public.course_can_assess(c.department))
         or public.course_in_audience(cid, public.my_discord_id())))
$$;

-- A step from the published content.
create or replace function public.course_item(cid uuid, iid text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select i from public.courses c, jsonb_array_elements(coalesce(c.content->'modules', '[]')) m, jsonb_array_elements(coalesce(m->'items', '[]')) i
  where c.id = cid and i->>'id' = iid limit 1
$$;

-- What a member may see of a step: no answer keys, no questions (they come from quiz_start), no model answers.
create or replace function public.course_strip(i jsonb)
returns jsonb language sql immutable as $$
  select case i->>'kind'
    when 'quiz' then (i - 'questions') || jsonb_build_object('question_count',
                       (select count(*) from jsonb_array_elements(coalesce(i->'questions', '[]')) q where q->>'type' <> 'section'),
                       'points', (select coalesce(sum(coalesce((q->>'points')::numeric, 1)), 0) from jsonb_array_elements(coalesce(i->'questions', '[]')) q where q->>'type' <> 'section'))
    else i end
$$;

create or replace function public.course_due_at(cid uuid)
returns timestamptz language sql stable security definer set search_path = '' as $$
  select case when c.due_days is null then null else coalesce(c.opens_at, c.published_at) + make_interval(days => c.due_days) end
  from public.courses c where c.id = cid
$$;

-- Steps done / total for a person.
create or replace function public.course_counts(cid uuid, who text)
returns jsonb language sql stable security definer set search_path = '' as $$
  with items as (
    select i from public.courses c, jsonb_array_elements(coalesce(c.content->'modules', '[]')) m, jsonb_array_elements(coalesce(m->'items', '[]')) i where c.id = cid)
  select jsonb_build_object('total', (select count(*) from items),
    'done', (select count(*) from items where case i->>'kind'
      when 'quiz' then exists (select 1 from public.course_attempts a where a.course_id = cid and a.item_id = i->>'id' and a.discord_id = who and a.status = 'marked' and a.passed)
      when 'eval' then exists (select 1 from public.course_evaluations e where e.course_id = cid and e.item_id = i->>'id' and e.discord_id = who and e.status = 'submitted' and e.passed)
      else exists (select 1 from public.course_progress p where p.course_id = cid and p.item_id = i->>'id' and p.discord_id = who) end))
$$;

-- ---------- members ----------
-- The Courses tab: courses this person can see in a department, with their state.
create or replace function public.course_list(dept text)
returns jsonb language sql stable security definer set search_path = '' as $$
  with me as (select public.my_discord_id() id)
  select coalesce(jsonb_agg(x order by x->>'sort_key'), '[]'::jsonb) from (
    select jsonb_build_object('id', c.id, 'title', c.content->>'title', 'description', c.content->>'description',
      'kind', c.content->>'kind', 'color', c.content->>'color', 'audience_ranks', c.audience_ranks,
      'opens_at', c.opens_at, 'due_at', public.course_due_at(c.id),
      'prereq', (select p.content->>'title' from public.courses p where p.id = c.prereq_id),
      'lock', public.course_lock(c.id, me.id), 'mine', public.course_in_audience(c.id, me.id),
      'complete', public.course_complete(c.id, me.id), 'counts', public.course_counts(c.id, me.id),
      'sort_key', lpad(c.sort::text, 6, '0') || coalesce(c.content->>'title', '')) x
    from public.courses c, me
    where c.department = dept and c.status = 'published'
      and (public.course_in_audience(c.id, me.id) or public.course_can_edit(dept) or public.course_can_assess(dept))
  ) q
$$;

-- One course for a member: the header always; modules and steps only once it's open for them (or for builders
-- and assessors, who always see the structure). Answer keys never leave the database.
create or replace function public.course_view(cid uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c public.courses; me text := public.my_discord_id(); lock text; staff boolean;
begin
  select * into c from public.courses where id = cid;
  if c.id is null or c.status <> 'published' or not public.course_can_see(cid) then return null; end if;
  lock := public.course_lock(cid, me);
  staff := public.course_can_edit(c.department) or public.course_can_assess(c.department);
  return jsonb_build_object('id', c.id, 'department', c.department,
    'title', c.content->>'title', 'description', c.content->>'description', 'kind', c.content->>'kind',
    'color', c.content->>'color', 'audience_ranks', c.audience_ranks, 'opens_at', c.opens_at, 'due_at', public.course_due_at(cid),
    'prereq', (select jsonb_build_object('id', p.id, 'title', p.content->>'title') from public.courses p where p.id = c.prereq_id),
    'lock', lock, 'mine', public.course_in_audience(cid, me), 'complete', public.course_complete(cid, me),
    'counts', public.course_counts(cid, me), 'can_edit', public.course_can_edit(c.department), 'can_assess', public.course_can_assess(c.department),
    'modules', case when lock is null or staff then (
      select coalesce(jsonb_agg(jsonb_build_object('id', m->>'id', 'title', m->>'title',
        'items', (select coalesce(jsonb_agg(public.course_strip(i)), '[]'::jsonb) from jsonb_array_elements(coalesce(m->'items', '[]')) i))), '[]'::jsonb)
      from jsonb_array_elements(coalesce(c.content->'modules', '[]')) m) else null end,
    'done', (select coalesce(jsonb_agg(p.item_id), '[]'::jsonb) from public.course_progress p where p.course_id = cid and p.discord_id = me),
    'attempts', (select coalesce(jsonb_agg(jsonb_build_object('item_id', a.item_id, 'id', a.id, 'status', a.status,
                   'submitted_at', a.submitted_at, 'score', case when a.status = 'marked' then a.score end,
                   'max_score', case when a.status = 'marked' then a.max_score end,
                   'passed', case when a.status = 'marked' then a.passed end) order by a.started_at), '[]'::jsonb)
                 from public.course_attempts a where a.course_id = cid and a.discord_id = me),
    'evaluations', (select coalesce(jsonb_agg(jsonb_build_object('item_id', e.item_id, 'levels', e.levels, 'comments', e.comments,
                      'passed', e.passed, 'assessor', e.assessor_name, 'submitted_at', e.submitted_at)), '[]'::jsonb)
                    from public.course_evaluations e where e.course_id = cid and e.discord_id = me and e.status = 'submitted'));
end $$;

-- Reading/watching steps: client-reported progress (not proof); only for open courses and non-assessed steps.
create or replace function public.course_item_done(cid uuid, iid text)
returns void language plpgsql security definer set search_path = '' as $$
declare me text := public.my_discord_id(); i jsonb := public.course_item(cid, iid);
begin
  if i is null or not public.course_in_audience(cid, me) then raise exception 'This course isn''t open to you.'; end if;
  if public.course_lock(cid, me) is not null then raise exception 'This course isn''t open yet.'; end if;
  if i->>'kind' in ('quiz', 'eval') then raise exception 'Quizzes and evaluations are marked, not ticked.'; end if;
  insert into public.course_progress (course_id, discord_id, item_id) values (cid, me, iid) on conflict do nothing;
end $$;

-- ---------- quizzes and exams ----------
-- Tries left and when the next try is allowed.
create or replace function public.quiz_tries(cid uuid, iid text, who text)
returns jsonb language sql stable security definer set search_path = '' as $$
  with i as (select public.course_item(cid, iid) j),
       a as (select * from public.course_attempts where course_id = cid and item_id = iid and discord_id = who and status <> 'in_progress')
  select jsonb_build_object(
    'allowed', coalesce(((select j->>'tries' from i))::int, 3) + coalesce((select extra from public.course_extra_tries x where x.course_id = cid and x.item_id = iid and x.discord_id = who), 0),
    'used', (select count(*) from a),
    'next_at', (select max(submitted_at) + make_interval(hours => coalesce(((select j->>'wait_hours' from i))::int, 0)) from a))
$$;

-- Start (or resume) a try: returns the questions WITHOUT keys.
create or replace function public.quiz_start(cid uuid, iid text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare me text := public.my_discord_id(); i jsonb := public.course_item(cid, iid); a public.course_attempts; t jsonb;
begin
  if i is null or i->>'kind' <> 'quiz' then raise exception 'Unknown quiz.'; end if;
  if not public.course_in_audience(cid, me) then raise exception 'This course isn''t open to you.'; end if;
  if public.course_lock(cid, me) is not null then raise exception 'This course isn''t open yet.'; end if;
  if exists (select 1 from public.course_attempts x where x.course_id = cid and x.item_id = iid and x.discord_id = me and x.status = 'marking') then
    raise exception 'Your last try is still being marked.'; end if;
  if exists (select 1 from public.course_attempts x where x.course_id = cid and x.item_id = iid and x.discord_id = me and x.status = 'marked' and x.passed) then
    raise exception 'You''ve already passed this.'; end if;
  select * into a from public.course_attempts x where x.course_id = cid and x.item_id = iid and x.discord_id = me and x.status = 'in_progress';
  if a.id is null then
    t := public.quiz_tries(cid, iid, me);
    if (t->>'used')::int >= (t->>'allowed')::int then raise exception 'You''ve used all your tries. Ask the department for another.'; end if;
    if (t->>'next_at') is not null and (t->>'next_at')::timestamptz > now() then
      raise exception 'You can try again on %.', to_char((t->>'next_at')::timestamptz at time zone 'Australia/Sydney', 'FMDD Mon "at" FMHH12:MI am'); end if;
    insert into public.course_attempts (course_id, item_id, discord_id) values (cid, iid, me) returning * into a;
  end if;
  return jsonb_build_object('attempt_id', a.id, 'started_at', a.started_at, 'answers', coalesce(a.answers, '{}'::jsonb),
    'title', i->>'title', 'exam', coalesce((i->>'exam')::boolean, false), 'time_limit_min', i->'time_limit_min',
    'questions', (select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', q->>'id', 'type', q->>'type', 'text', q->>'text',
                    'points', coalesce((q->>'points')::numeric, 1),
                    'options', (select jsonb_agg(jsonb_build_object('id', o->>'id', 'text', o->>'text')) from jsonb_array_elements(coalesce(q->'options', '[]')) o)))), '[]'::jsonb)
                  from jsonb_array_elements(coalesce(i->'questions', '[]')) q));
end $$;

-- Save answers while working (so a closed tab doesn't lose them).
create or replace function public.quiz_save(attempt_id bigint, answers jsonb)
returns void language sql security definer set search_path = '' as $$
  update public.course_attempts set answers = quiz_save.answers
  where id = attempt_id and discord_id = public.my_discord_id() and status = 'in_progress' and pg_column_size(quiz_save.answers) < 200000
$$;

-- Points for one auto-marked question (null = needs a person).
create or replace function public.quiz_auto_mark(q jsonb, ans jsonb)
returns numeric language plpgsql immutable as $$
declare pts numeric := coalesce((q->>'points')::numeric, 1); want text[]; got text[];
begin
  case q->>'type'
    when 'single', 'truefalse' then
      return case when ans is not null and ans #>> '{}' = any (array(select jsonb_array_elements_text(coalesce(q->'key', '[]')))) then pts else 0 end;
    when 'multi' then
      want := array(select v from jsonb_array_elements_text(coalesce(q->'key', '[]')) v order by 1);
      got := case when jsonb_typeof(ans) = 'array' then array(select v from jsonb_array_elements_text(ans) v order by 1) else '{}' end;
      return case when want = got then pts else 0 end;
    when 'short' then
      if coalesce(jsonb_array_length(q->'accepted'), 0) = 0 then return null; end if;
      return case when lower(btrim(coalesce(ans #>> '{}', ''))) = any (array(select lower(btrim(v)) from jsonb_array_elements_text(q->'accepted') v)) then pts else 0 end;
    else return null;   -- long answers: a person marks them
  end case;
end $$;

-- Submit: marks what it can. Anything left for a person HOLDS the whole result ("Submitted. Results usually within…").
create or replace function public.quiz_submit(attempt_id bigint, answers jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a public.course_attempts; i jsonb; q jsonb; m jsonb := '{}'; held boolean := false; total numeric := 0; maxs numeric := 0; p numeric;
begin
  select * into a from public.course_attempts x where x.id = attempt_id and x.discord_id = public.my_discord_id() for update;
  if a.id is null or a.status <> 'in_progress' then raise exception 'This try has already been sent.'; end if;
  i := public.course_item(a.course_id, a.item_id);
  if i->>'time_limit_min' is not null and now() > a.started_at + make_interval(mins => (i->>'time_limit_min')::int + 2) then
    answers := coalesce(a.answers, '{}');   -- over time: what was saved counts
  end if;
  for q in select * from jsonb_array_elements(coalesce(i->'questions', '[]')) loop
    continue when q->>'type' = 'section';
    maxs := maxs + coalesce((q->>'points')::numeric, 1);
    p := public.quiz_auto_mark(q, answers->(q->>'id'));
    if p is null then held := true; else m := m || jsonb_build_object(q->>'id', p); total := total + p; end if;
  end loop;
  update public.course_attempts set answers = quiz_submit.answers, submitted_at = now(), marks = m, max_score = maxs,
    score = case when held then null else total end, status = case when held then 'marking' else 'marked' end,
    passed = case when held then null else total >= ceil(maxs * coalesce((i->>'pass_pct')::numeric, 80) / 100) end,
    marked_at = case when held then null else now() end
  where id = a.id;
  return public.quiz_result(a.id);
end $$;

-- What the candidate sees of a try. Held tries show nothing but "Submitted". Answers are revealed only per the
-- quiz's setting: 'now' (straight after an auto-marked result), 'after' (once marked), 'never'.
create or replace function public.quiz_result(attempt_id bigint)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when a.status = 'marking' then jsonb_build_object('status', 'marking', 'results_in', i->>'results_in')
    else jsonb_build_object('status', a.status, 'score', a.score, 'max_score', a.max_score, 'passed', a.passed,
      'pass_pct', coalesce((i->>'pass_pct')::numeric, 80),
      'review', case when a.status = 'marked' and coalesce(i->>'reveal', 'after') in ('now', 'after') then (
        select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', q->>'id', 'type', q->>'type', 'text', q->>'text', 'points', coalesce((q->>'points')::numeric, 1),
          'options', q->'options', 'key', q->'key', 'accepted', q->'accepted', 'answer', a.answers->(q->>'id'), 'got', a.marks->(q->>'id'))))
        from jsonb_array_elements(coalesce(i->'questions', '[]')) q where q->>'type' <> 'section') end) end
  from public.course_attempts a, lateral (select public.course_item(a.course_id, a.item_id) i) x
  where a.id = attempt_id and (a.discord_id = public.my_discord_id())
$$;

-- ---------- assessors ----------
-- Tries waiting for a person to mark, with the questions, keys and model answers.
create or replace function public.course_marking(dept text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'course_id', a.course_id, 'course', c.content->>'title',
    'item_id', a.item_id, 'quiz', i->>'title', 'discord_id', a.discord_id, 'name', coalesce(m.display_name, a.discord_id),
    'avatar_url', m.avatar_url, 'submitted_at', a.submitted_at, 'answers', a.answers, 'marks', a.marks, 'questions', i->'questions')
    order by a.submitted_at), '[]'::jsonb)
  from public.course_attempts a join public.courses c on c.id = a.course_id
  left join public.members m on m.discord_id = a.discord_id
  cross join lateral (select public.course_item(a.course_id, a.item_id) i) x
  where c.department = dept and a.status = 'marking' and public.course_can_assess(dept) and a.discord_id <> public.my_discord_id()
$$;

create or replace function public.course_mark_attempt(attempt_id bigint, marks jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare a public.course_attempts; c public.courses; i jsonb; q jsonb; mm jsonb; total numeric := 0; p numeric; me text := public.my_discord_id();
begin
  select * into a from public.course_attempts where id = attempt_id for update;
  select * into c from public.courses where id = a.course_id;
  if a.id is null or not public.course_can_assess(c.department) then raise exception 'You can''t mark this.'; end if;
  if a.discord_id = me then raise exception 'You can''t mark your own try.'; end if;
  if a.status <> 'marking' then raise exception 'This try has already been marked.'; end if;
  i := public.course_item(a.course_id, a.item_id); mm := coalesce(a.marks, '{}');
  for q in select * from jsonb_array_elements(coalesce(i->'questions', '[]')) loop
    continue when q->>'type' = 'section';
    if mm ? (q->>'id') then total := total + (mm->>(q->>'id'))::numeric; continue; end if;
    p := (marks->>(q->>'id'))::numeric;
    if p is null or p < 0 or p > coalesce((q->>'points')::numeric, 1) then raise exception 'Give every written answer a mark from 0 to its points.'; end if;
    mm := mm || jsonb_build_object(q->>'id', p); total := total + p;
  end loop;
  update public.course_attempts set marks = mm, score = total, status = 'marked',
    passed = total >= ceil(max_score * coalesce((i->>'pass_pct')::numeric, 80) / 100),
    marked_by = me, marked_by_name = (select display_name from public.members where discord_id = me), marked_at = now()
  where id = a.id;
  insert into public.course_notices (course_id, discord_id, kind, title, department, url, detail, ref)
  values (c.id, a.discord_id, 'result', c.content->>'title', c.department,
          'https://ldg224.github.io/cbh/#directors/' || public.dept_id_of(c.department) || '/courses/' || c.id,
          coalesce(i->>'title', 'Your exam') || ' has been marked', a.id::text) on conflict do nothing;
end $$;

create or replace function public.course_grant_try(cid uuid, iid text, who text)
returns void language plpgsql security definer set search_path = '' as $$
declare d text := (select department from public.courses where id = cid);
begin
  if not (public.course_can_assess(d) or public.course_can_edit(d)) then raise exception 'You can''t give extra tries here.'; end if;
  insert into public.course_extra_tries (course_id, item_id, discord_id, extra) values (cid, iid, who, 1)
  on conflict (course_id, item_id, discord_id) do update set extra = public.course_extra_tries.extra + 1;
end $$;

-- Practical evaluations: levels 1 Not yet, 2 Developing, 3 Standard, 4 Exceeding. Passed = every competency at the
-- step's pass level (default 3, Standard) or above.
create or replace function public.course_eval_save(cid uuid, iid text, who text, levels jsonb, comments jsonb, submit boolean, observed_on date default null)
returns bigint language plpgsql security definer set search_path = '' as $$
declare c public.courses; i jsonb := public.course_item(cid, iid); me text := public.my_discord_id(); e public.course_evaluations;
        need int; ok boolean := true; comp jsonb; v int;
begin
  select * into c from public.courses where id = cid;
  if c.id is null or i is null or i->>'kind' <> 'eval' then raise exception 'Unknown evaluation.'; end if;
  if not public.course_can_assess(c.department) then raise exception 'You can''t carry out % evaluations.', c.department; end if;
  if who = me then raise exception 'You can''t evaluate yourself.'; end if;
  if not public.course_in_audience(cid, who) then raise exception 'That person isn''t on this course.'; end if;
  need := coalesce((i->>'pass_level')::int, 3);
  for comp in select * from jsonb_array_elements(coalesce(i->'competencies', '[]')) loop
    v := (levels->>(comp->>'id'))::int;
    if submit and (v is null or v not between 1 and 4) then raise exception 'Mark every competency before submitting.'; end if;
    if v is null or v < need then ok := false; end if;
  end loop;
  select * into e from public.course_evaluations x where x.course_id = cid and x.item_id = iid and x.discord_id = who and x.status = 'draft' and x.assessor_id = me;
  if e.id is null then
    insert into public.course_evaluations (course_id, item_id, discord_id, assessor_id, assessor_name, levels, comments, observed_on)
    values (cid, iid, who, me, (select display_name from public.members where discord_id = me), coalesce(levels, '{}'), coalesce(comments, '{}'), observed_on)
    returning * into e;
  else
    update public.course_evaluations set levels = coalesce(course_eval_save.levels, '{}'), comments = coalesce(course_eval_save.comments, '{}'),
      observed_on = coalesce(course_eval_save.observed_on, observed_on) where id = e.id;
  end if;
  if submit then
    update public.course_evaluations set status = 'submitted', submitted_at = now(), passed = ok where id = e.id;
    insert into public.course_notices (course_id, discord_id, kind, title, department, url, detail, ref)
    values (cid, who, 'result', c.content->>'title', c.department,
            'https://ldg224.github.io/cbh/#directors/' || public.dept_id_of(c.department) || '/courses/' || cid,
            coalesce(i->>'title', 'Your evaluation') || (case when ok then ': passed' else ': not passed yet' end), 'eval-' || e.id) on conflict do nothing;
  end if;
  return e.id;
end $$;

-- Everyone on a course and where they are (Progress tab; builders and assessors).
create or replace function public.course_progress_report(cid uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('discord_id', m.discord_id, 'name', m.display_name, 'avatar_url', m.avatar_url,
      'rank', (select r.rank_label from public.roles r where r.id = any (m.role_ids) and r.kind = 'rank' and r.department = c.department order by r.rank_order desc limit 1),
      'counts', public.course_counts(cid, m.discord_id), 'complete', public.course_complete(cid, m.discord_id),
      'quizzes', (select coalesce(jsonb_agg(jsonb_build_object('item_id', a.item_id, 'status', a.status, 'score', a.score, 'max_score', a.max_score, 'passed', a.passed) order by a.started_at), '[]'::jsonb)
                  from public.course_attempts a where a.course_id = cid and a.discord_id = m.discord_id and a.status <> 'in_progress'),
      'evaluations', (select coalesce(jsonb_agg(jsonb_build_object('item_id', e.item_id, 'status', e.status, 'passed', e.passed, 'levels', e.levels, 'assessor', e.assessor_name)), '[]'::jsonb)
                      from public.course_evaluations e where e.course_id = cid and e.discord_id = m.discord_id))
      order by m.display_name), '[]'::jsonb)
  from public.courses c join public.members m on public.course_in_audience(c.id, m.discord_id)
  where c.id = cid and (public.course_can_edit(c.department) or public.course_can_assess(c.department))
$$;

-- An evaluation in progress or done, for its assessor (and other assessors).
create or replace function public.course_eval_get(cid uuid, iid text, who text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select (select to_jsonb(e) from public.course_evaluations e where e.course_id = cid and e.item_id = iid and e.discord_id = who
          order by (e.status = 'draft' and e.assessor_id = public.my_discord_id()) desc, e.created_at desc limit 1)
  from public.courses c where c.id = cid and public.course_can_assess(c.department)
$$;

-- Members tab chips: per member, courses done / their courses in this department.
create or replace function public.course_member_summary(dept text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(m.discord_id, jsonb_build_object('done', d.done, 'total', d.total)), '{}'::jsonb)
  from public.members m
  cross join lateral (select count(*) filter (where public.course_complete(c.id, m.discord_id)) done, count(*) total
                      from public.courses c where c.department = dept and c.status = 'published' and public.course_in_audience(c.id, m.discord_id)) d
  where d.total > 0 and (public.course_can_edit(dept) or public.course_can_assess(dept) or coalesce(public.has_perm('dept.view', dept), false))
$$;

-- ---------- builders ----------
create or replace function public.course_admin_list(dept text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'title', coalesce(c.draft->>'title', c.content->>'title', c.title), 'status', c.status,
      'has_draft', c.draft is not null, 'draft_saved_at', c.draft_saved_at, 'published_at', c.published_at,
      'color', coalesce(c.content->>'color', c.draft->>'color'), 'kind', coalesce(c.content->>'kind', c.draft->>'kind'),
      'audience_ranks', c.audience_ranks, 'opens_at', c.opens_at) order by c.sort, c.created_at), '[]'::jsonb)
  from public.courses c where c.department = dept and c.status <> 'archived' and public.course_can_edit(dept)
$$;

create or replace function public.course_admin_get(cid uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', c.id, 'department', c.department, 'status', c.status, 'content', c.content, 'draft', c.draft,
    'draft_saved_at', c.draft_saved_at, 'draft_by_name', c.draft_by_name, 'published_at', c.published_at,
    'others', (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'title', coalesce(o.content->>'title', o.title))), '[]'::jsonb)
               from public.courses o where o.department = c.department and o.id <> c.id and o.status = 'published'))
  from public.courses c where c.id = cid and public.course_can_edit(c.department)
$$;

create or replace function public.course_create(dept text, title text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare t text := left(coalesce(nullif(btrim(title), ''), 'New course'), 100); id uuid;
begin
  if not public.course_can_edit(dept) then raise exception 'You can''t create % courses.', dept; end if;
  insert into public.courses (department, title, created_by, sort, draft, draft_saved_at)
  values (dept, t, public.my_discord_id(), coalesce((select max(sort) + 1 from public.courses where department = dept), 0),
          jsonb_build_object('title', t, 'description', '', 'kind', 'General skills', 'color', '#2ED3C6', 'audience_ranks', '[]'::jsonb,
                             'opens_at', null, 'due_days', null, 'prereq', null,
                             'modules', jsonb_build_array(jsonb_build_object('id', 'm' || substr(md5(random()::text), 1, 8), 'title', 'Module 1', 'items', '[]'::jsonb))),
          now())
  returning courses.id into id;
  return id;
end $$;

create or replace function public.course_draft_save(cid uuid, draft jsonb)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare t timestamptz := now();
begin
  if not exists (select 1 from public.courses c where c.id = cid and c.status <> 'archived' and public.course_can_edit(c.department)) then
    raise exception 'You can''t edit this course.'; end if;
  if jsonb_typeof(draft) <> 'object' then raise exception 'Draft must be an object.'; end if;
  update public.courses set draft = course_draft_save.draft, draft_saved_at = t,
    draft_by_name = (select display_name from public.members where discord_id = public.my_discord_id()) where id = cid;
  return t;
end $$;

create or replace function public.course_discard(cid uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.courses c where c.id = cid and public.course_can_edit(c.department)) then raise exception 'You can''t edit this course.'; end if;
  update public.courses set draft = null, draft_saved_at = null, draft_by_name = null where id = cid and status = 'published';
  delete from public.courses where id = cid and status = 'draft';   -- never published: discarding removes it
end $$;

-- Check the draft and make it the published course.
create or replace function public.course_publish(cid uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare c public.courses; d jsonb; m jsonb; i jsonb; q jsonb; ids text[] := '{}'; ranks text[]; pre uuid; k text; u text; o jsonb; nq int;
begin
  select * into c from public.courses where id = cid for update;
  if c.id is null or c.status = 'archived' or not public.course_can_edit(c.department) then raise exception 'You can''t edit this course.'; end if;
  d := c.draft;
  if d is null then return; end if;
  if char_length(btrim(coalesce(d->>'title', ''))) not between 1 and 100 then raise exception 'Give the course a title.'; end if;
  if char_length(coalesce(d->>'description', '')) > 1000 then raise exception 'Keep the description under 1000 characters.'; end if;
  if coalesce(d->>'color', '#2ED3C6') !~ '^#[0-9A-Fa-f]{6}$' then raise exception 'Pick a colour.'; end if;
  ranks := array(select jsonb_array_elements_text(coalesce(d->'audience_ranks', '[]')));
  if exists (select 1 from unnest(ranks) a where not exists (select 1 from public.roles where id = a and kind = 'rank' and department = c.department)) then
    raise exception 'Who it''s for must be % ranks.', c.department; end if;
  pre := nullif(d->>'prereq', '')::uuid;
  if pre is not null and (pre = cid or not exists (select 1 from public.courses p where p.id = pre and p.department = c.department and p.status = 'published')) then
    raise exception 'The course to finish first must be another published % course.', c.department; end if;
  if coalesce((d->>'due_days')::int, 1) not between 1 and 365 then raise exception 'Due must be 1 to 365 days after it opens.'; end if;
  if jsonb_typeof(d->'modules') <> 'array' or jsonb_array_length(d->'modules') = 0 then raise exception 'Add at least one module.'; end if;
  for m in select * from jsonb_array_elements(d->'modules') loop
    if coalesce(m->>'id', '') = '' or m->>'id' = any (ids) then raise exception 'Module ids must be unique.'; end if;
    ids := ids || (m->>'id');
    if char_length(btrim(coalesce(m->>'title', ''))) not between 1 and 120 then raise exception 'Every module needs a title.'; end if;
    for i in select * from jsonb_array_elements(coalesce(m->'items', '[]')) loop
      if coalesce(i->>'id', '') = '' or i->>'id' = any (ids) then raise exception 'Step ids must be unique.'; end if;
      ids := ids || (i->>'id');
      k := i->>'kind';
      if char_length(btrim(coalesce(i->>'title', ''))) not between 1 and 160 then raise exception 'Every step needs a title.'; end if;
      if k not in ('lesson', 'slides', 'link', 'video', 'file', 'quiz', 'eval') then raise exception 'Unknown step type.'; end if;
      u := coalesce(i->>'url', '');
      if k = 'lesson' and char_length(coalesce(i->>'body', '')) > 60000 then raise exception '"%" is too long.', i->>'title'; end if;
      if k = 'slides' and u !~ '^https://docs\.google\.com/presentation/d/[A-Za-z0-9_-]+' then raise exception '"%": paste a Google Slides link.', i->>'title'; end if;
      if k = 'video' and u !~ '^https://(www\.)?(youtube\.com/(watch\?v=|embed/|shorts/)|youtu\.be/)[A-Za-z0-9_-]{6,}' then raise exception '"%": paste a YouTube link.', i->>'title'; end if;
      if k = 'link' and u !~ '^https://[^\s<>"]+$' then raise exception '"%": paste an https:// link.', i->>'title'; end if;
      if k = 'file' and coalesce(i->>'path', '') !~ ('^' || public.dept_id_of(c.department) || '/' || cid::text || '/[A-Za-z0-9._-]{1,140}$') then
        raise exception '"%": upload the file again.', i->>'title'; end if;
      if k = 'quiz' then
        if jsonb_typeof(i->'questions') <> 'array' then raise exception '"%" has no questions.', i->>'title'; end if;
        nq := 0;
        for q in select * from jsonb_array_elements(i->'questions') loop
          continue when q->>'type' = 'section';
          nq := nq + 1;
          if coalesce(q->>'id', '') = '' or q->>'id' = any (ids) then raise exception 'Question ids must be unique.'; end if;
          ids := ids || (q->>'id');
          if q->>'type' not in ('single', 'multi', 'truefalse', 'short', 'long') then raise exception 'Unknown question type in "%".', i->>'title'; end if;
          if char_length(btrim(coalesce(q->>'text', ''))) not between 1 and 2000 then raise exception 'Every question in "%" needs text.', i->>'title'; end if;
          if coalesce((q->>'points')::numeric, 1) not between 0 and 100 then raise exception 'Points must be 0 to 100.'; end if;
          if q->>'type' in ('single', 'multi', 'truefalse') then
            if coalesce(jsonb_array_length(q->'options'), 0) < 2 then raise exception '"%" needs at least two choices.', q->>'text'; end if;
            if coalesce(jsonb_array_length(q->'key'), 0) = 0 then raise exception 'Mark the right answer for "%".', q->>'text'; end if;
            for o in select * from jsonb_array_elements(q->'key') loop
              if not exists (select 1 from jsonb_array_elements(q->'options') x where x->>'id' = o #>> '{}') then raise exception 'The answer key for "%" is wrong.', q->>'text'; end if;
            end loop;
          end if;
        end loop;
        if nq = 0 then raise exception '"%" has no questions.', i->>'title'; end if;
        if coalesce((i->>'pass_pct')::int, 80) not between 0 and 100 or coalesce((i->>'tries')::int, 3) not between 1 and 20
           or coalesce((i->>'wait_hours')::int, 0) not between 0 and 720 or coalesce(i->>'reveal', 'after') not in ('now', 'after', 'never') then
          raise exception 'Check the settings of "%".', i->>'title'; end if;
      end if;
      if k = 'eval' and (jsonb_typeof(i->'competencies') <> 'array' or jsonb_array_length(i->'competencies') = 0) then
        raise exception '"%" needs at least one competency.', i->>'title'; end if;
    end loop;
  end loop;
  update public.courses set content = d, title = btrim(d->>'title'), status = 'published',
    audience_ranks = case when cardinality(ranks) = 0 then null else ranks end,
    opens_at = nullif(d->>'opens_at', '')::timestamptz, due_days = nullif(d->>'due_days', '')::int, prereq_id = pre,
    published_at = coalesce(published_at, now()), draft = null, draft_saved_at = null, draft_by_name = null
  where id = cid;
end $$;

create or replace function public.course_archive(cid uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.courses c where c.id = cid and public.course_can_edit(c.department)) then raise exception 'You can''t edit this course.'; end if;
  update public.courses set status = 'archived', draft = null where id = cid;
end $$;

-- ---------- reminders (the bot calls this with the service role) ----------
create or replace function public.course_notices_due()
returns integer language plpgsql security definer set search_path = '' as $$
declare n int := 0; k int;
begin
  -- opened: published, open by date, for each audience member (prerequisites aside: they hear when it opens by date)
  insert into public.course_notices (course_id, discord_id, kind, title, department, url, detail)
  select c.id, m.discord_id, 'opened', c.content->>'title', c.department,
         'https://ldg224.github.io/cbh/#directors/' || public.dept_id_of(c.department) || '/courses/' || c.id,
         case when public.course_due_at(c.id) is not null then 'Due ' || to_char(public.course_due_at(c.id) at time zone 'Australia/Sydney', 'FMDD Mon') else 'Open now' end
  from public.courses c join public.members m on public.course_in_audience(c.id, m.discord_id)
  where c.status = 'published' and coalesce(c.opens_at, c.published_at) <= now() and coalesce(c.opens_at, c.published_at) > now() - interval '7 days'
    and not public.course_complete(c.id, m.discord_id)
  on conflict do nothing;
  get diagnostics k = row_count; n := n + k;
  insert into public.course_notices (course_id, discord_id, kind, title, department, url, detail)
  select c.id, m.discord_id, case when public.course_due_at(c.id) < now() then 'overdue' else 'due_soon' end, c.content->>'title', c.department,
         'https://ldg224.github.io/cbh/#directors/' || public.dept_id_of(c.department) || '/courses/' || c.id,
         'Due ' || to_char(public.course_due_at(c.id) at time zone 'Australia/Sydney', 'FMDD Mon')
  from public.courses c join public.members m on public.course_in_audience(c.id, m.discord_id)
  where c.status = 'published' and public.course_due_at(c.id) is not null
    and public.course_due_at(c.id) between now() - interval '1 day' and now() + interval '3 days'
    and public.course_lock(c.id, m.discord_id) is distinct from 'date' and not public.course_complete(c.id, m.discord_id)
  on conflict do nothing;
  get diagnostics k = row_count; n := n + k;
  return n;
end $$;
revoke execute on function public.course_notices_due() from public, anon, authenticated;

do $g$
declare f text;
begin
  foreach f in array array[
    'course_list(text)', 'course_view(uuid)', 'course_item_done(uuid, text)', 'quiz_start(uuid, text)', 'quiz_save(bigint, jsonb)',
    'quiz_submit(bigint, jsonb)', 'quiz_result(bigint)', 'course_marking(text)', 'course_mark_attempt(bigint, jsonb)',
    'course_grant_try(uuid, text, text)', 'course_eval_save(uuid, text, text, jsonb, jsonb, boolean, date)', 'course_eval_get(uuid, text, text)',
    'course_progress_report(uuid)', 'course_member_summary(text)', 'course_admin_list(text)', 'course_admin_get(uuid)',
    'course_create(text, text)', 'course_draft_save(uuid, jsonb)', 'course_discard(uuid)', 'course_publish(uuid)', 'course_archive(uuid)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array[
    'course_can_edit(text)', 'course_can_assess(text)', 'course_in_audience(uuid, text)', 'course_complete(uuid, text)', 'course_lock(uuid, text)',
    'course_can_see(uuid)', 'course_item(uuid, text)', 'course_due_at(uuid)', 'course_counts(uuid, text)', 'quiz_tries(uuid, text, text)',
    'quiz_auto_mark(jsonb, jsonb)', 'course_strip(jsonb)'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
end $g$;
