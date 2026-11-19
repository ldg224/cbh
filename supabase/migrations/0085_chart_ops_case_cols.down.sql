-- 0085 down: drop only what 0085 added (restoring NOT NULL needs every row to have complaint and department).
drop index if exists public.chart_cases_queue;
drop index if exists public.chart_cases_owner;
drop index if exists public.chart_cases_one_per_bed;
drop index if exists public.chart_cases_one_online;
drop index if exists public.chart_cases_visit_token;
alter table public.chart_entries drop column if exists entered_for, drop column if exists done_at, drop column if exists done_by,
  drop column if exists done_by_name, drop column if exists result;
alter table public.chart_cases
  drop column if exists state, drop column if exists source, drop column if exists npc, drop column if exists child, drop column if exists team,
  drop column if exists extra_teams, drop column if exists visit_token_hash, drop column if exists visit_expires_at,
  drop column if exists online_confirmed_at, drop column if exists online_confirmed_by, drop column if exists owner_id, drop column if exists bed_id,
  drop column if exists pair_id, drop column if exists said, drop column if exists colour_confirmed, drop column if exists priority,
  drop column if exists queued_at, drop column if exists assigned_at, drop column if exists assign_expires_at, drop column if exists assign_from, drop column if exists called_at,
  drop column if exists with_patient_at, drop column if exists no_show_count, drop column if exists handback_count, drop column if exists handback_note,
  drop column if exists lost_nurse, drop column if exists off_ward, drop column if exists code_at, drop column if exists code_by,
  drop column if exists outcome, drop column if exists advice, drop column if exists discharged_at, drop column if exists discharged_by,
  drop column if exists aftercare_at, drop column if exists aftercare_by, drop column if exists papers, drop column if exists rating,
  drop column if exists rating_comment, drop column if exists rated_at, drop column if exists rating_by, drop column if exists rating_source,
  drop column if exists eta_at, drop column if exists previous_case_id, drop column if exists worked_by, drop column if exists departments,
  drop column if exists flag_supervisor, drop column if exists called_out_at, drop column if exists prioritised, drop column if exists admitted_to,
  drop column if exists left_note, drop column if exists time_of_death, drop column if exists death_confirmed_by,
  drop column if exists pain, drop column if exists care_notes, drop column if exists roblox_user_id;
update public.chart_cases set complaint = coalesce(complaint, 'Unknown'), department = coalesce(department, 'Nursing')
  where complaint is null or department is null;
alter table public.chart_cases alter column complaint set not null;
alter table public.chart_cases alter column department set not null;
