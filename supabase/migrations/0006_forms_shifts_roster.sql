-- 0006: forms (applications + incident reports, replacing Google Forms + Zapier), shifts (replacing Trident),
-- the staff roster and the weekly hours report.

-- ---------- forms ----------
-- A form's questions live here so they can change without a website release. Each question:
--   {"id": "why", "label": "Why do you want to join?", "type": "text" | "long" | "choice" | "number" | "yesno",
--    "required": true, "options": ["…"] (choice only)}
create table if not exists public.forms (
  key          text primary key,
  title        text not null,
  description  text,
  kind         text not null check (kind in ('application', 'report')),
  audience     text not null default 'member' check (audience in ('member', 'team', 'admin')),  -- who may submit
  review_team  text,                -- leads of this department review it (execs always can); null = execs only
  open         boolean not null default true,
  questions    jsonb not null default '[]'::jsonb,
  sort         integer not null default 0
);
alter table public.forms enable row level security;
drop policy if exists forms_read on public.forms;
create policy forms_read on public.forms for select to authenticated using (public.is_member());

-- Starter forms. The owner will give the real questions (from the old Google Forms); edit them in Supabase.
insert into public.forms (key, title, description, kind, audience, review_team, questions, sort) values
('admin-application', 'Administration Team Application', 'Apply to join the Administration team.', 'application',
 'member', 'Administration', '[
   {"id":"roblox","label":"Roblox username","type":"text","required":true},
   {"id":"age","label":"How old are you?","type":"number","required":true},
   {"id":"timezone","label":"Your time zone","type":"text","required":true},
   {"id":"why","label":"Why do you want to join the Administration team?","type":"long","required":true},
   {"id":"experience","label":"Any moderation or admin experience?","type":"long","required":false},
   {"id":"scenario","label":"Someone is breaking the rules during a session. What do you do?","type":"long","required":true}
 ]', 1),
('ce-application', 'Community Engagement Team Application', 'Apply to join the Community Engagement team.', 'application',
 'member', 'Community Engagement', '[
   {"id":"roblox","label":"Roblox username","type":"text","required":true},
   {"id":"age","label":"How old are you?","type":"number","required":true},
   {"id":"timezone","label":"Your time zone","type":"text","required":true},
   {"id":"why","label":"Why do you want to join Community Engagement?","type":"long","required":true},
   {"id":"ideas","label":"An event or partnership idea you would run","type":"long","required":true}
 ]', 2),
('incident-report', 'Incident Report', 'Report something that happened in game or on Discord.', 'report',
 'admin', null, '[
   {"id":"when","label":"When did it happen?","type":"text","required":true},
   {"id":"where","label":"Where?","type":"choice","options":["In game","Discord","Both"],"required":true},
   {"id":"who","label":"Who was involved (usernames)?","type":"text","required":true},
   {"id":"what","label":"What happened?","type":"long","required":true},
   {"id":"action","label":"What action did you take?","type":"long","required":false},
   {"id":"evidence","label":"Evidence links (screenshots, clips)","type":"text","required":false}
 ]', 3)
on conflict (key) do nothing;

create or replace function public.can_review_form(f text) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_exec() or exists (
    select 1 from public.forms x where x.key = f and x.review_team is not null and public.leads_team(x.review_team))
$$;
revoke execute on function public.can_review_form(text) from public, anon;
grant execute on function public.can_review_form(text) to authenticated;

create table if not exists public.form_submissions (
  id                    bigint generated always as identity primary key,
  form_key              text not null references public.forms (key),
  submitter_discord_id  text not null,
  submitter_name        text,
  answers               jsonb not null,               -- {"question id": "answer", …}
  status                text not null default 'pending' check (status in ('pending', 'accepted', 'denied', 'reviewed')),
  reviewer_discord_id   text,
  reviewer_name         text,
  review_note           text,                          -- shown to the applicant
  message_id            text,                          -- the post in #form-submissions (set by the bot)
  created_at            timestamptz not null default now(),
  reviewed_at           timestamptz
);
create index if not exists form_submissions_form on public.form_submissions (form_key, status, created_at desc);
create index if not exists form_submissions_mine on public.form_submissions (submitter_discord_id, created_at desc);
alter table public.form_submissions enable row level security;

drop policy if exists form_submissions_read on public.form_submissions;
create policy form_submissions_read on public.form_submissions for select to authenticated
  using (submitter_discord_id = public.my_discord_id() or public.can_review_form(form_key));
drop policy if exists form_submissions_submit on public.form_submissions;
create policy form_submissions_submit on public.form_submissions for insert to authenticated
  with check (submitter_discord_id = public.my_discord_id() and status = 'pending' and reviewer_discord_id is null
    and message_id is null and exists (
      select 1 from public.forms f where f.key = form_key and f.open and (
        f.audience = 'member' and public.is_member() or f.audience = 'team' and public.is_team()
        or f.audience = 'admin' and public.is_admin())));
drop policy if exists form_submissions_review on public.form_submissions;
create policy form_submissions_review on public.form_submissions for update to authenticated
  using (public.can_review_form(form_key)) with check (public.can_review_form(form_key));

revoke all on public.forms, public.form_submissions from anon;
revoke insert, update, delete, truncate on public.forms from authenticated;
revoke update, delete, truncate on public.form_submissions from authenticated;
grant select on public.forms to authenticated;
grant select, insert on public.form_submissions to authenticated;
grant update (status, reviewer_discord_id, reviewer_name, review_note, reviewed_at) on public.form_submissions to authenticated;

-- ---------- shifts ----------
create table if not exists public.shifts (
  id                bigint generated always as identity primary key,
  discord_id        text not null,
  name              text,
  department        text not null check (department in ('Administration', 'Nursing', 'Paramedicine', 'Community Engagement')),
  status            text not null default 'active' check (status in ('active', 'break', 'ended')),
  started_at        timestamptz not null default now(),
  ended_at          timestamptz,
  break_started_at  timestamptz,
  break_seconds     integer not null default 0,
  ended_by          text,                              -- 'self', 'auto' (after 8 hours) or a Discord ID
  session_id        bigint references public.sessions (id)
);
create index if not exists shifts_person on public.shifts (discord_id, started_at desc);
create index if not exists shifts_dept on public.shifts (department, started_at desc);
create unique index if not exists shifts_one_open on public.shifts (discord_id) where status <> 'ended';
alter table public.shifts enable row level security;
-- Your own shifts; team members see their team's shifts (who's on now); execs everything.
drop policy if exists shifts_read on public.shifts;
create policy shifts_read on public.shifts for select to authenticated
  using (discord_id = public.my_discord_id() or public.is_exec()
         or exists (select 1 from public.my_roles() r where r.kind in ('department', 'rank') and r.department = shifts.department));
revoke all on public.shifts from anon;
revoke insert, update, delete, truncate on public.shifts from authenticated;
grant select on public.shifts to authenticated;

-- Worked seconds of a shift (breaks taken off; an open shift counts up to now).
create or replace function public.shift_seconds(s public.shifts) returns integer
language sql stable set search_path = '' as $$
  select greatest(0, extract(epoch from (coalesce(s.ended_at, now()) - s.started_at))::integer
    - s.break_seconds
    - case when s.status = 'break' and s.break_started_at is not null
           then extract(epoch from (now() - s.break_started_at))::integer else 0 end)
$$;

-- Weekly hours report (execs): hours per person per department between two times.
create or replace function public.shift_report(from_ts timestamptz, to_ts timestamptz)
returns table (discord_id text, name text, department text, shifts bigint, hours numeric)
language sql stable security definer set search_path = '' as $$
  select s.discord_id, max(s.name), s.department, count(*), round(sum(public.shift_seconds(s)) / 3600.0, 2)
  from public.shifts s
  where public.is_exec() and s.started_at >= from_ts and s.started_at < to_ts
  group by s.discord_id, s.department
  order by 5 desc
$$;
revoke execute on function public.shift_report(timestamptz, timestamptz) from public, anon;
grant execute on function public.shift_report(timestamptz, timestamptz) to authenticated;

-- ---------- roster (staff only) ----------
-- Everyone in a department, with their badges' data, for team members and execs. Only public profile fields.
create or replace function public.roster()
returns table (discord_id text, display_name text, avatar_url text, role_ids text[])
language sql stable security definer set search_path = '' as $$
  select m.discord_id, m.display_name, m.avatar_url, m.role_ids
  from public.members m
  where public.is_team() and exists (
    select 1 from public.roles r where r.id = any (m.role_ids) and r.kind in ('leadership', 'executive', 'department', 'rank'))
  order by m.display_name
$$;
revoke execute on function public.roster() from public, anon;
grant execute on function public.roster() to authenticated;

-- Team members can read the role catalogue already (roles_read_if_member), so badges can be built from role_ids.

-- The bot has told the applicant about the review decision (website or Discord).
alter table public.form_submissions add column if not exists notified boolean not null default false;
