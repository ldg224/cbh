-- 0051: private storage for course files (Alpha; plan approved by Charlie). Bucket 'course-files': private, 50 MB,
-- only pdf / pptx / png / jpeg / webp / gif (no svg or html). Object path, strictly:
--   <dept-id>/<course uuid>/<file name of [A-Za-z0-9._-], 1-140 chars>
-- with no '..', no extra folders, no leading slash; the course must belong to that department.
-- Read: people who can edit or assess that department's courses, or who are in the course's audience while it's
-- open for them. Write (upload, replace, delete): courses.manage in that department. The site uses 10-minute signed
-- URLs (createSignedUrl), which go through the read rule.
-- Cleanup: archiving a course removes its folder from the site (the editor's Storage delete, same rule); objects
-- left behind by a failed delete are listed by course_files_orphans() for a later tidy (follow-up).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('course-files', 'course-files', false, 52428800,
        array['application/pdf', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
              'image/png', 'image/jpeg', 'image/webp', 'image/gif'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- The course a path belongs to, if (and only if) the path is well formed and the course is in that department.
create or replace function public.course_file_course(path text)
returns uuid language sql stable security definer set search_path = '' as $$
  select c.id from public.courses c
  where path ~ '^(administration|nursing|paramedicine|community)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Za-z0-9._-]{1,140}$'
    and path !~ '\.\.'
    and c.id = (split_part(path, '/', 2))::uuid
    and public.dept_id_of(c.department) = split_part(path, '/', 1)
    and c.status <> 'archived'
$$;

create or replace function public.course_file_ok(path text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select public.course_can_edit(c.department) or public.course_can_assess(c.department)
                     or (public.course_in_audience(c.id, public.my_discord_id()) and public.course_lock(c.id, public.my_discord_id()) is null)
                   from public.courses c where c.id = public.course_file_course(path)), false)
$$;

create or replace function public.course_file_write_ok(path text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select public.course_can_edit(c.department) from public.courses c where c.id = public.course_file_course(path)), false)
$$;

revoke execute on function public.course_file_course(text) from public, anon, authenticated;
revoke execute on function public.course_file_ok(text), public.course_file_write_ok(text) from public, anon;
grant execute on function public.course_file_ok(text), public.course_file_write_ok(text) to authenticated;

drop policy if exists course_files_read on storage.objects;
drop policy if exists course_files_insert on storage.objects;
drop policy if exists course_files_update on storage.objects;
drop policy if exists course_files_delete on storage.objects;
create policy course_files_read on storage.objects for select to authenticated
  using (bucket_id = 'course-files' and public.course_file_ok(name));
create policy course_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'course-files' and public.course_file_write_ok(name));
create policy course_files_update on storage.objects for update to authenticated
  using (bucket_id = 'course-files' and public.course_file_write_ok(name))
  with check (bucket_id = 'course-files' and public.course_file_write_ok(name));
create policy course_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'course-files' and public.course_file_write_ok(name));

-- Files whose course is gone or archived (for a later tidy through the Storage API).
create or replace function public.course_files_orphans()
returns table (name text) language sql stable security definer set search_path = '' as $$
  select o.name from storage.objects o
  where o.bucket_id = 'course-files' and not exists (
    select 1 from public.courses c where c.status <> 'archived' and c.id::text = split_part(o.name, '/', 2))
$$;
revoke execute on function public.course_files_orphans() from public, anon, authenticated;
