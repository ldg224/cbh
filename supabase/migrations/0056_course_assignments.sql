-- 0056: course assignments (Alpha; number from Charlie). Owner, 20 Nov 2026: "assign certain courses to certain
-- members ... it shows up in their DMs, it shows up in their courses, and it shows up as a To do on the website".
-- An assignment is IN ADDITION to the course's rank audience: an assigned person (any member of the server) can open
-- the course, but open dates and prerequisites still apply. Optional per-person due date and note.
-- Who may assign / unassign: courses.manage ("Edit courses") or courses.assess ("Assess courses") in the department.
-- DMs: course_notices kind 'assigned' (Bravo's bot labels it). To do: course_my_todo() for my_todo / Home (Bravo).

create table if not exists public.course_assignments (
  id               bigint generated always as identity primary key,
  course_id        uuid not null references public.courses (id) on delete cascade,
  discord_id       text not null,
  assigned_by      text not null,
  assigned_by_name text,
  due_at           timestamptz,
  note             text check (note is null or char_length(note) <= 500),
  created_at       timestamptz not null default now(),
  completed_at     timestamptz,
  unique (course_id, discord_id)
);
create index if not exists course_assignments_who on public.course_assignments (discord_id);
alter table public.course_assignments enable row level security;
revoke all on public.course_assignments from anon, authenticated;
grant select on public.course_assignments to authenticated;
drop policy if exists course_assignments_read on public.course_assignments;
-- Course editors/assessors of the course's department (a definer helper: authenticated can't read courses directly).
create or replace function public.course_assign_ok(cid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.courses c where c.id = cid and (public.course_can_edit(c.department) or public.course_can_assess(c.department)))
$$;
revoke execute on function public.course_assign_ok(uuid) from public, anon;
grant execute on function public.course_assign_ok(uuid) to authenticated;
create policy course_assignments_read on public.course_assignments for select to authenticated using (
  discord_id = public.my_discord_id() or public.course_assign_ok(course_id));
-- writes only through course_assign / course_unassign

alter table public.course_notices drop constraint if exists course_notices_kind_check;
alter table public.course_notices add constraint course_notices_kind_check check (kind in ('opened', 'due_soon', 'overdue', 'result', 'assigned'));

-- In the audience: the course's ranks in its department (0048), or assigned to it.
create or replace function public.course_in_audience(cid uuid, who text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.courses c join public.members m on m.discord_id = who
    where c.id = cid and c.status = 'published'
      and ((exists (select 1 from public.roles r where r.id = any (m.role_ids) and r.kind in ('department', 'rank') and r.department = c.department)
            and (coalesce(cardinality(c.audience_ranks), 0) = 0 or m.role_ids && c.audience_ranks))
           or exists (select 1 from public.course_assignments a where a.course_id = cid and a.discord_id = who)))
$$;

-- A person's due date: their assignment's, else the course's.
create or replace function public.course_due_for(cid uuid, who text)
returns timestamptz language sql stable security definer set search_path = '' as $$
  select coalesce((select a.due_at from public.course_assignments a where a.course_id = cid and a.discord_id = who), public.course_due_at(cid))
$$;

create or replace function public.course_can_assign(dept text)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.course_can_edit(dept) or public.course_can_assess(dept)
$$;

-- The Courses tab list (0048) with my assignment and my due date.
create or replace function public.course_list(dept text)
returns jsonb language sql stable security definer set search_path = '' as $$
  with me as (select public.my_discord_id() id)
  select coalesce(jsonb_agg(x order by x->>'sort_key'), '[]'::jsonb) from (
    select jsonb_build_object('id', c.id, 'title', c.content->>'title', 'description', c.content->>'description',
      'kind', c.content->>'kind', 'color', c.content->>'color', 'audience_ranks', c.audience_ranks,
      'opens_at', c.opens_at, 'due_at', public.course_due_for(c.id, me.id),
      'prereq', (select p.content->>'title' from public.courses p where p.id = c.prereq_id),
      'lock', public.course_lock(c.id, me.id), 'mine', public.course_in_audience(c.id, me.id),
      'complete', public.course_complete(c.id, me.id), 'counts', public.course_counts(c.id, me.id),
      'assigned', (select jsonb_build_object('by', a.assigned_by_name, 'at', a.created_at, 'due_at', a.due_at, 'note', a.note)
                   from public.course_assignments a where a.course_id = c.id and a.discord_id = me.id),
      'sort_key', lpad(c.sort::text, 6, '0') || coalesce(c.content->>'title', '')) x
    from public.courses c, me
    where c.department = dept and c.status = 'published'
      and (public.course_in_audience(c.id, me.id) or public.course_can_edit(dept) or public.course_can_assess(dept))
  ) q
$$;

-- Every course assigned to me in any department (for My courses: assigned courses outside my departments too).
create or replace function public.course_my_assigned()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'department', c.department, 'title', c.content->>'title',
      'kind', c.content->>'kind', 'color', c.content->>'color', 'audience_ranks', c.audience_ranks, 'opens_at', c.opens_at,
      'due_at', public.course_due_for(c.id, a.discord_id), 'prereq', (select p.content->>'title' from public.courses p where p.id = c.prereq_id),
      'lock', public.course_lock(c.id, a.discord_id), 'mine', true, 'complete', public.course_complete(c.id, a.discord_id),
      'counts', public.course_counts(c.id, a.discord_id),
      'assigned', jsonb_build_object('by', a.assigned_by_name, 'at', a.created_at, 'due_at', a.due_at, 'note', a.note))), '[]'::jsonb)
  from public.course_assignments a join public.courses c on c.id = a.course_id and c.status = 'published'
  where a.discord_id = public.my_discord_id()
$$;

-- Assign a course to people (members of the server), with an optional due date and note.
create or replace function public.course_assign(cid uuid, ids text[], due_at timestamptz default null, note text default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare c public.courses; me text := public.my_discord_id(); nm text := (select display_name from public.members where discord_id = public.my_discord_id());
        who text; n int := 0; aid bigint;
begin
  select * into c from public.courses where id = cid;
  if c.id is null or c.status <> 'published' then raise exception 'Publish the course before assigning it.'; end if;
  if not public.course_can_assign(c.department) then raise exception 'You can''t assign % courses.', c.department; end if;
  if cardinality(ids) > 200 then raise exception 'Assign at most 200 people at a time.'; end if;
  if due_at is not null and due_at < now() then raise exception 'Pick a due date in the future.'; end if;
  note := nullif(btrim(coalesce(note, '')), '');
  foreach who in array coalesce(ids, '{}') loop
    continue when not exists (select 1 from public.members m where m.discord_id = who);
    insert into public.course_assignments (course_id, discord_id, assigned_by, assigned_by_name, due_at, note)
    values (cid, who, me, nm, course_assign.due_at, note)
    on conflict (course_id, discord_id) do update set due_at = excluded.due_at, note = excluded.note,
      assigned_by = excluded.assigned_by, assigned_by_name = excluded.assigned_by_name
    returning id into aid;
    insert into public.course_notices (course_id, discord_id, kind, title, department, url, detail, ref)
    values (cid, who, 'assigned', c.content->>'title', c.department, 'https://ldg224.github.io/cbh/#courses/' || cid,
            coalesce(nullif(btrim(regexp_replace(nm, '[^[:alnum:][:space:][:punct:]]', '', 'g')), ''), 'Your department') || ' assigned you this course'
              || case when course_assign.due_at is not null then ' · Due ' || to_char(course_assign.due_at at time zone 'Australia/Sydney', 'FMDD Mon') else '' end
              || case when note is not null then E'\n' || note else '' end,
            aid::text)
    on conflict do nothing;
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function public.course_unassign(cid uuid, who text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.courses c where c.id = cid and public.course_can_assign(c.department)) then raise exception 'You can''t change this course''s assignments.'; end if;
  delete from public.course_assignments where course_id = cid and discord_id = who;
end $$;

-- Assessors / builders: who's assigned and who has finished.
create or replace function public.course_assignments_report(cid uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('discord_id', a.discord_id, 'name', coalesce(m.display_name, a.discord_id), 'avatar_url', m.avatar_url,
      'assigned_by', a.assigned_by_name, 'at', a.created_at, 'due_at', a.due_at, 'note', a.note,
      'complete', public.course_complete(cid, a.discord_id), 'counts', public.course_counts(cid, a.discord_id)) order by a.created_at desc), '[]'::jsonb)
  from public.course_assignments a left join public.members m on m.discord_id = a.discord_id
  join public.courses c on c.id = a.course_id
  where a.course_id = cid and public.course_can_assign(c.department)
$$;

-- To do (for my_todo / Home): my assigned, unfinished courses by department; overdue = red, the rest = orange.
create or replace function public.course_my_todo()
returns jsonb language sql stable security definer set search_path = '' as $$
  with mine as (
    select c.department, c.id, c.content->>'title' title, public.course_due_for(c.id, a.discord_id) due_at, a.assigned_by_name
    from public.course_assignments a join public.courses c on c.id = a.course_id and c.status = 'published'
    where a.discord_id = public.my_discord_id() and not public.course_complete(c.id, a.discord_id))
  select coalesce(jsonb_object_agg(d.department, jsonb_build_object(
      'courses', (select count(*) from mine x where x.department = d.department and x.due_at < now()),
      'courses_note', (select count(*) from mine x where x.department = d.department and (x.due_at is null or x.due_at >= now())),
      'courses_list', (select jsonb_agg(jsonb_build_object('id', x.id, 'title', x.title, 'due_at', x.due_at, 'overdue', x.due_at < now(),
                         'assigned_by_name', x.assigned_by_name) order by x.due_at nulls last) from mine x where x.department = d.department))), '{}'::jsonb)
  from (select distinct department from mine) d
$$;

-- Reminders (0048) with each person's own due date (assignment or course).
create or replace function public.course_notices_due()
returns integer language plpgsql security definer set search_path = '' as $$
declare n int := 0; k int;
begin
  insert into public.course_notices (course_id, discord_id, kind, title, department, url, detail)
  select c.id, m.discord_id, 'opened', c.content->>'title', c.department,
         'https://ldg224.github.io/cbh/#courses/' || c.id,
         case when public.course_due_for(c.id, m.discord_id) is not null then 'Due ' || to_char(public.course_due_for(c.id, m.discord_id) at time zone 'Australia/Sydney', 'FMDD Mon') else 'Open now' end
  from public.courses c join public.members m on public.course_in_audience(c.id, m.discord_id)
  where c.status = 'published' and coalesce(c.opens_at, c.published_at) <= now() and coalesce(c.opens_at, c.published_at) > now() - interval '7 days'
    and not public.course_complete(c.id, m.discord_id)
    and not exists (select 1 from public.course_assignments a where a.course_id = c.id and a.discord_id = m.discord_id and a.created_at > coalesce(c.opens_at, c.published_at))
  on conflict do nothing;
  get diagnostics k = row_count; n := n + k;
  insert into public.course_notices (course_id, discord_id, kind, title, department, url, detail)
  select c.id, m.discord_id, case when public.course_due_for(c.id, m.discord_id) < now() then 'overdue' else 'due_soon' end, c.content->>'title', c.department,
         'https://ldg224.github.io/cbh/#courses/' || c.id,
         'Due ' || to_char(public.course_due_for(c.id, m.discord_id) at time zone 'Australia/Sydney', 'FMDD Mon')
  from public.courses c join public.members m on public.course_in_audience(c.id, m.discord_id)
  where c.status = 'published' and public.course_due_for(c.id, m.discord_id) is not null
    and public.course_due_for(c.id, m.discord_id) between now() - interval '1 day' and now() + interval '3 days'
    and public.course_lock(c.id, m.discord_id) is distinct from 'date' and not public.course_complete(c.id, m.discord_id)
  on conflict do nothing;
  get diagnostics k = row_count; n := n + k;
  return n;
end $$;
revoke execute on function public.course_notices_due() from public, anon, authenticated;

do $g$
declare f text;
begin
  foreach f in array array['course_my_assigned()', 'course_assign(uuid, text[], timestamptz, text)', 'course_unassign(uuid, text)',
                           'course_assignments_report(uuid)', 'course_my_todo()'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array['course_due_for(uuid, text)', 'course_can_assign(text)'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
end $g$;
