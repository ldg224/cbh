-- 0085: CBH Chart operations, additive columns on chart_cases / chart_entries (Bravo, 19 Nov 2026; BACKEND-PLAN §1.1-1.2).
-- status (open/closed/void) stays the coarse lifecycle; `state` is the new state machine. The one relaxation:
-- complaint and department lose NOT NULL (online check-ins type symptoms, and a case has no department lock now).
-- Every existing row stays valid.

alter table public.chart_cases
  add column if not exists state               text check (state in ('incoming', 'checked_in', 'waiting', 'assigned', 'called', 'in_care',
                                                   'waiting_in_room', 'discharged', 'left_before_seen', 'left_during_care', 'died', 'session_ended')),
  add column if not exists source              text check (source in ('desk', 'online', 'walk_in', 'incoming', 'npc')),
  add column if not exists npc                 boolean not null default false,
  add column if not exists child               boolean not null default false,
  add column if not exists team                text,
  add column if not exists extra_teams         text[] not null default '{}',
  add column if not exists visit_token_hash    bytea,
  add column if not exists visit_expires_at    timestamptz,
  add column if not exists online_confirmed_at timestamptz,
  add column if not exists online_confirmed_by text,
  add column if not exists owner_id            text,
  add column if not exists bed_id              text references public.chart_beds (id),
  add column if not exists pair_id             text,
  add column if not exists said                text check (said in ('a_little', 'quite_bad', 'very_bad')),
  add column if not exists colour_confirmed    boolean not null default false,
  add column if not exists priority            smallint not null default 0,
  add column if not exists queued_at           timestamptz,
  add column if not exists assigned_at         timestamptz,
  add column if not exists assign_expires_at   timestamptz,
  add column if not exists assign_from         text,                     -- the state to go back to if Got it times out
  add column if not exists called_at           timestamptz,
  add column if not exists with_patient_at     timestamptz,
  add column if not exists no_show_count       smallint not null default 0,
  add column if not exists handback_count      smallint not null default 0,
  add column if not exists handback_note       text check (handback_note is null or char_length(handback_note) <= 300),
  add column if not exists handed_back_by      text,                     -- auto-assign never gives the case back to them
  add column if not exists lost_nurse          boolean not null default false,
  add column if not exists off_ward            text check (off_ward is null or char_length(off_ward) <= 40),
  add column if not exists code_at             timestamptz,
  add column if not exists code_by             text,
  add column if not exists outcome             text check (outcome in ('home', 'follow_up', 'admitted', 'transferred', 'left_before_seen',
                                                   'left_during_care', 'died', 'session_ended')),
  add column if not exists advice              text check (advice is null or char_length(advice) <= 500),
  add column if not exists discharged_at       timestamptz,
  add column if not exists discharged_by       text,
  add column if not exists aftercare_at        timestamptz,
  add column if not exists aftercare_by        text,
  add column if not exists papers              boolean not null default false,
  add column if not exists rating              smallint check (rating between 1 and 5),
  add column if not exists rating_comment      text check (rating_comment is null or char_length(rating_comment) <= 500),
  add column if not exists rated_at            timestamptz,
  add column if not exists rating_by           text,
  add column if not exists rating_source       text check (rating_source in ('patient', 'reception')),
  add column if not exists eta_at              timestamptz,
  add column if not exists previous_case_id    bigint,
  add column if not exists worked_by           text[] not null default '{}',
  add column if not exists departments         text[] not null default '{}',
  add column if not exists flag_supervisor     boolean not null default false,
  add column if not exists called_out_at       timestamptz,              -- Reception's call-out card (Delta, CONTRACT v1.1)
  add column if not exists prioritised         boolean not null default false,   -- Reception/Supervisor "Prioritise" on Up next
  add column if not exists admitted_to         text check (admitted_to is null or char_length(admitted_to) <= 80),
  add column if not exists left_note           text check (left_note is null or char_length(left_note) <= 500),
  add column if not exists time_of_death       timestamptz,
  add column if not exists death_confirmed_by  text check (death_confirmed_by is null or char_length(death_confirmed_by) <= 80),
  add column if not exists pain                smallint check (pain between 1 and 10),         -- check-in pain 1-10 (CONTRACT v1.2; replaces how bad)
  add column if not exists care_notes          text check (care_notes is null or char_length(care_notes) <= 300),  -- care requirements, shown prominently
  add column if not exists roblox_user_id      bigint;                                          -- confirmed via "Is this you?" (avatar for staff)

alter table public.chart_cases alter column complaint drop not null;
alter table public.chart_cases alter column department drop not null;

create index if not exists chart_cases_queue on public.chart_cases (state, esi, prioritised desc, priority desc, queued_at) where status = 'open';
create index if not exists chart_cases_owner on public.chart_cases (owner_id) where status = 'open';
create unique index if not exists chart_cases_one_per_bed on public.chart_cases (bed_id) where status = 'open' and bed_id is not null;
create unique index if not exists chart_cases_one_online on public.chart_cases (lower(roblox_username)) where status = 'open' and source = 'online';
create unique index if not exists chart_cases_visit_token on public.chart_cases (visit_token_hash) where visit_token_hash is not null;

alter table public.chart_entries add column if not exists entered_for text;
alter table public.chart_entries add column if not exists done_at timestamptz;
alter table public.chart_entries add column if not exists done_by text;
alter table public.chart_entries add column if not exists done_by_name text;
alter table public.chart_entries add column if not exists result text check (result is null or char_length(result) <= 300);
