-- 0055: Exam lock (Alpha; number from Charlie). Owner, 20 Nov 2026: "lock the screen into full screen. If they try
-- to exit, give them a big warning. If they do it twice, or are out of full screen for 30 seconds or more, it kicks
-- them out of their exam."
-- A quiz step's `lock` setting: 'off', 'fullscreen' (computer only, full screen required) or 'phones' (full screen
-- where the browser has it, otherwise stay-on-this-page). Formal exams default to locked (the builder sets it).
-- The page reports exits and returns; the SERVER decides: the 2nd exit, or a return more than 30 s after an exit,
-- ends the try ("Ended: left the exam screen"). Coming back to a locked try (reload, another device) counts as an
-- exit. Every call on the try first ends it if it has been out for more than 30 s, so a page that stops reporting
-- can't keep it open. An ended try uses a try, isn't marked (answers are kept for assessors), and counts as not passed.

alter table public.course_attempts
  add column if not exists lock_mode text not null default 'off',
  add column if not exists exits integer not null default 0,
  add column if not exists out_since timestamptz,
  add column if not exists ended_reason text;
alter table public.course_attempts drop constraint if exists course_attempts_status_check;
alter table public.course_attempts add constraint course_attempts_status_check check (status in ('in_progress', 'marking', 'marked', 'ended'));
alter table public.course_attempts drop constraint if exists course_attempts_lock_check;
alter table public.course_attempts add constraint course_attempts_lock_check check (lock_mode in ('off', 'fullscreen', 'phones'));

create table if not exists public.course_attempt_events (
  id         bigint generated always as identity primary key,
  attempt_id bigint not null references public.course_attempts (id) on delete cascade,
  kind       text not null check (kind in ('start', 'exit', 'return', 'resume', 'ended', 'timeout')),
  detail     text check (detail is null or char_length(detail) <= 60),
  at         timestamptz not null default now()
);
create index if not exists course_attempt_events_a on public.course_attempt_events (attempt_id);
alter table public.course_attempt_events enable row level security;
revoke all on public.course_attempt_events from anon, authenticated;

-- End a try for leaving the exam screen (keeps the answers, no marks, not passed).
create or replace function public.quiz_lock_end(aid bigint, why text)
returns void language sql security definer set search_path = '' as $$
  with u as (
    update public.course_attempts set status = 'ended', ended_reason = why, submitted_at = now(), passed = false, score = null, out_since = null
    where id = aid and status = 'in_progress' returning id)
  insert into public.course_attempt_events (attempt_id, kind, detail) select id, 'ended', why from u
$$;

-- Out for more than 30 seconds: ended. Called at the top of every call on a try.
create or replace function public.quiz_lock_check(aid bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.course_attempts where id = aid and status = 'in_progress' and lock_mode <> 'off'
             and out_since is not null and out_since < now() - interval '30 seconds') then
    insert into public.course_attempt_events (attempt_id, kind) values (aid, 'timeout');
    perform public.quiz_lock_end(aid, 'Out of the exam screen for more than 30 seconds');
  end if;
end $$;

-- The page reports: 'start' (in full screen / on the page), 'exit' (left full screen, switched tab/app, page hidden),
-- 'return' (back). Returns the try's lock state; ended = true when the server has ended it.
create or replace function public.quiz_lock_event(attempt_id bigint, kind text, detail text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a public.course_attempts; me text := public.my_discord_id();
begin
  select * into a from public.course_attempts x where x.id = quiz_lock_event.attempt_id and x.discord_id = me;
  if a.id is null then raise exception 'Unknown try.'; end if;
  if kind not in ('start', 'exit', 'return') then raise exception 'Unknown event.'; end if;
  perform public.quiz_lock_check(a.id);
  select * into a from public.course_attempts where id = a.id for update;
  if a.status = 'in_progress' and a.lock_mode <> 'off' then
    if kind = 'start' then
      insert into public.course_attempt_events (attempt_id, kind, detail) values (a.id, 'start', left(detail, 60));
    elsif kind = 'exit' and a.out_since is null then
      insert into public.course_attempt_events (attempt_id, kind, detail) values (a.id, 'exit', left(detail, 60));
      if a.exits + 1 >= 2 then
        update public.course_attempts set exits = exits + 1 where id = a.id;
        perform public.quiz_lock_end(a.id, 'Left the exam screen twice');
      else
        update public.course_attempts set exits = exits + 1, out_since = now() where id = a.id;
      end if;
    elsif kind = 'return' and a.out_since is not null then
      insert into public.course_attempt_events (attempt_id, kind, detail) values (a.id, 'return', left(detail, 60));
      update public.course_attempts set out_since = null where id = a.id;
    end if;
  end if;
  select * into a from public.course_attempts where id = a.id;
  return jsonb_build_object('status', a.status, 'ended', a.status = 'ended', 'ended_reason', a.ended_reason, 'exits', a.exits,
    'out_since', a.out_since, 'seconds_left', case when a.out_since is null then null else greatest(0, 30 - extract(epoch from now() - a.out_since))::int end);
end $$;

-- quiz_start (0048) with the lock: a new try takes the step's lock setting; coming back to a locked try counts as
-- an exit (a reload or another device), so the 2nd time ends it.
create or replace function public.quiz_start(cid uuid, iid text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare me text := public.my_discord_id(); i jsonb := public.course_item(cid, iid); a public.course_attempts; t jsonb; resumed boolean := false; st jsonb;
begin
  if i is null or i->>'kind' <> 'quiz' then raise exception 'Unknown quiz.'; end if;
  if not public.course_in_audience(cid, me) then raise exception 'This course isn''t open to you.'; end if;
  if public.course_lock(cid, me) is not null then raise exception 'This course isn''t open yet.'; end if;
  if exists (select 1 from public.course_attempts x where x.course_id = cid and x.item_id = iid and x.discord_id = me and x.status = 'marking') then
    raise exception 'Your last try is still being marked.'; end if;
  if exists (select 1 from public.course_attempts x where x.course_id = cid and x.item_id = iid and x.discord_id = me and x.status = 'marked' and x.passed) then
    raise exception 'You''ve already passed this.'; end if;
  select * into a from public.course_attempts x where x.course_id = cid and x.item_id = iid and x.discord_id = me and x.status = 'in_progress';
  if a.id is not null then
    perform public.quiz_lock_check(a.id);
    select * into a from public.course_attempts where id = a.id;
    if a.status = 'in_progress' and a.lock_mode <> 'off' then
      insert into public.course_attempt_events (attempt_id, kind) values (a.id, 'resume');
      st := public.quiz_lock_event(a.id, 'exit', 'Came back to the exam (reload or another device)');
      select * into a from public.course_attempts where id = a.id;
    end if;
    if a.status = 'ended' then
      return jsonb_build_object('attempt_id', a.id, 'ended', true, 'ended_reason', a.ended_reason);
    end if;
    resumed := true;
  end if;
  if a.id is null then
    t := public.quiz_tries(cid, iid, me);
    if (t->>'used')::int >= (t->>'allowed')::int then raise exception 'You''ve used all your tries. Ask the department for another.'; end if;
    if (t->>'next_at') is not null and (t->>'next_at')::timestamptz > now() then
      raise exception 'You can try again on %.', to_char((t->>'next_at')::timestamptz at time zone 'Australia/Sydney', 'FMDD Mon "at" FMHH12:MI am'); end if;
    insert into public.course_attempts (course_id, item_id, discord_id, lock_mode)
    values (cid, iid, me, case when coalesce(i->>'lock', 'off') in ('fullscreen', 'phones') then i->>'lock' else 'off' end) returning * into a;
  end if;
  return jsonb_build_object('attempt_id', a.id, 'started_at', a.started_at, 'answers', coalesce(a.answers, '{}'::jsonb), 'resumed', resumed,
    'lock', a.lock_mode, 'exits', a.exits, 'out_since', a.out_since,
    'seconds_left', case when a.out_since is null then null else greatest(0, 30 - extract(epoch from now() - a.out_since))::int end,
    'title', i->>'title', 'exam', coalesce((i->>'exam')::boolean, false), 'time_limit_min', i->'time_limit_min',
    'questions', (select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', q->>'id', 'type', q->>'type', 'text', q->>'text',
                    'points', coalesce((q->>'points')::numeric, 1),
                    'options', (select jsonb_agg(jsonb_build_object('id', o->>'id', 'text', o->>'text')) from jsonb_array_elements(coalesce(q->'options', '[]')) o)))), '[]'::jsonb)
                  from jsonb_array_elements(coalesce(i->'questions', '[]')) q));
end $$;

-- quiz_save / quiz_submit (0048) first apply the 30-second rule; an ended try can't be saved or submitted.
create or replace function public.quiz_save(attempt_id bigint, answers jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.quiz_lock_check(quiz_save.attempt_id);
  update public.course_attempts set answers = quiz_save.answers
  where id = quiz_save.attempt_id and discord_id = public.my_discord_id() and status = 'in_progress' and pg_column_size(quiz_save.answers) < 200000;
end $$;

alter function public.quiz_submit(bigint, jsonb) rename to quiz_submit_core;
revoke execute on function public.quiz_submit_core(bigint, jsonb) from public, anon, authenticated;
create or replace function public.quiz_submit(attempt_id bigint, answers jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a public.course_attempts;
begin
  perform public.quiz_lock_check(quiz_submit.attempt_id);
  select * into a from public.course_attempts x where x.id = quiz_submit.attempt_id and x.discord_id = public.my_discord_id();
  if a.id is null then raise exception 'Unknown try.'; end if;
  if a.status = 'ended' then
    update public.course_attempts ca set answers = coalesce(quiz_submit.answers, ca.answers) where ca.id = a.id;
    return public.quiz_result(a.id);
  end if;
  if a.out_since is not null then update public.course_attempts set out_since = null where id = a.id; end if;
  return public.quiz_submit_core(quiz_submit.attempt_id, quiz_submit.answers);
end $$;
revoke execute on function public.quiz_submit(bigint, jsonb) from public, anon;
grant execute on function public.quiz_submit(bigint, jsonb) to authenticated;

-- What the candidate sees (0048) plus the ended state.
create or replace function public.quiz_result(attempt_id bigint)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when a.status = 'ended' then jsonb_build_object('status', 'ended', 'ended_reason', a.ended_reason)
    when a.status = 'marking' then jsonb_build_object('status', 'marking', 'results_in', i->>'results_in')
    else jsonb_build_object('status', a.status, 'score', a.score, 'max_score', a.max_score, 'passed', a.passed,
      'pass_pct', coalesce((i->>'pass_pct')::numeric, 80),
      'review', case when a.status = 'marked' and coalesce(i->>'reveal', 'after') in ('now', 'after') then (
        select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', q->>'id', 'type', q->>'type', 'text', q->>'text', 'points', coalesce((q->>'points')::numeric, 1),
          'options', q->'options', 'key', q->'key', 'accepted', q->'accepted', 'answer', a.answers->(q->>'id'), 'got', a.marks->(q->>'id'))))
        from jsonb_array_elements(coalesce(i->'questions', '[]')) q where q->>'type' <> 'section') end) end
  from public.course_attempts a, lateral (select public.course_item(a.course_id, a.item_id) i) x
  where a.id = quiz_result.attempt_id and a.discord_id = public.my_discord_id()
$$;

-- Assessors: a try's exit log and answers (also for ended tries).
create or replace function public.course_attempt_log(attempt_id bigint)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', a.id, 'status', a.status, 'ended_reason', a.ended_reason, 'lock', a.lock_mode, 'exits', a.exits,
    'started_at', a.started_at, 'submitted_at', a.submitted_at, 'answers', a.answers, 'questions', public.course_item(a.course_id, a.item_id)->'questions',
    'events', (select coalesce(jsonb_agg(jsonb_build_object('kind', e.kind, 'detail', e.detail, 'at', e.at) order by e.at), '[]'::jsonb)
               from public.course_attempt_events e where e.attempt_id = a.id))
  from public.course_attempts a join public.courses c on c.id = a.course_id
  where a.id = course_attempt_log.attempt_id and (public.course_can_assess(c.department) or public.course_can_edit(c.department))
$$;

-- The Progress tab (0048) with each try's id, status, exits and ending, so assessors can open the log.
create or replace function public.course_progress_report(cid uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('discord_id', m.discord_id, 'name', m.display_name, 'avatar_url', m.avatar_url,
      'rank', (select r.rank_label from public.roles r where r.id = any (m.role_ids) and r.kind = 'rank' and r.department = c.department order by r.rank_order desc limit 1),
      'counts', public.course_counts(cid, m.discord_id), 'complete', public.course_complete(cid, m.discord_id),
      'quizzes', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'item_id', a.item_id, 'status', a.status, 'score', a.score, 'max_score', a.max_score,
                    'passed', a.passed, 'exits', a.exits, 'lock', a.lock_mode, 'ended_reason', a.ended_reason) order by a.started_at), '[]'::jsonb)
                  from public.course_attempts a where a.course_id = cid and a.discord_id = m.discord_id),
      'evaluations', (select coalesce(jsonb_agg(jsonb_build_object('item_id', e.item_id, 'status', e.status, 'passed', e.passed, 'levels', e.levels, 'assessor', e.assessor_name)), '[]'::jsonb)
                      from public.course_evaluations e where e.course_id = cid and e.discord_id = m.discord_id))
      order by m.display_name), '[]'::jsonb)
  from public.courses c join public.members m on public.course_in_audience(c.id, m.discord_id)
  where c.id = cid and (public.course_can_edit(c.department) or public.course_can_assess(c.department))
$$;

-- course_view (0048): attempts also carry the ending, so the step can say why a try ended.
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
                   'max_score', case when a.status = 'marked' then a.max_score end, 'ended_reason', a.ended_reason,
                   'passed', case when a.status = 'marked' then a.passed end) order by a.started_at), '[]'::jsonb)
                 from public.course_attempts a where a.course_id = cid and a.discord_id = me),
    'evaluations', (select coalesce(jsonb_agg(jsonb_build_object('item_id', e.item_id, 'levels', e.levels, 'comments', e.comments,
                      'passed', e.passed, 'assessor', e.assessor_name, 'submitted_at', e.submitted_at)), '[]'::jsonb)
                    from public.course_evaluations e where e.course_id = cid and e.discord_id = me and e.status = 'submitted'));
end $$;

revoke execute on function public.quiz_lock_end(bigint, text), public.quiz_lock_check(bigint) from public, anon, authenticated;
revoke execute on function public.quiz_lock_event(bigint, text, text), public.course_attempt_log(bigint) from public, anon;
grant execute on function public.quiz_lock_event(bigint, text, text), public.course_attempt_log(bigint) to authenticated;
