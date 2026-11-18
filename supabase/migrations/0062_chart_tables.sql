-- 0062: CBH Chart v1 tables + catalogue (Alpha). Owner, 18 Nov 2026: one shared Case per patient visit, append-only
-- entries, scope of practice by COSIGN (never a hard block), US practice (ESI triage, SBAR handoff, °F).
-- Research and the scope table: Plans/CareBeyond/chart-recommendation.md. RPC contract: Plans/CareBeyond/chart/CONTRACT.md.
-- Additive only. Reads and writes go through 0063's SECURITY DEFINER RPCs; the select policies are a safety net.

alter table public.departments add column if not exists clinical boolean not null default false;
update public.departments set clinical = true where name in ('Nursing', 'Paramedicine', 'Medical', 'Surgical') and not clinical;

-- The form catalogue and scope of practice, as data. scope = { "<department>": <minimum rank_order> }; a department
-- missing from scope always needs a cosign. kind 'cap' rows are capabilities (esi, disposition), not chips.
create table if not exists public.chart_catalog (
  id       text primary key,
  kind     text not null check (kind in ('complaint', 'intervention', 'medication', 'assessment', 'cap')),
  label    text not null,
  grp      text,
  in_game  boolean not null default true,
  scope    jsonb not null default '{}'::jsonb,
  sort     int not null default 100,
  active   boolean not null default true
);

create table if not exists public.chart_cases (
  id               bigint generated always as identity primary key,
  patient_name     text not null check (char_length(patient_name) between 1 and 80),
  patient_alias    boolean not null default false,
  age_band         text,
  sex              text,
  roblox_username  text check (roblox_username is null or char_length(roblox_username) <= 40),
  complaint        text not null check (char_length(complaint) between 1 and 120),
  arrival          text not null default 'walk_in' check (arrival in ('walk_in', 'ambulance', 'helicopter')),
  esi              smallint check (esi between 1 and 5),
  esi_by           text,
  esi_by_name      text,
  status           text not null default 'open' check (status in ('open', 'closed', 'void')),
  disposition      text check (disposition in ('discharged', 'admitted', 'or', 'transferred', 'deceased', 'ama')),
  department       text not null,
  opened_by        text not null,
  opened_by_name   text,
  opened_at        timestamptz not null default now(),
  closed_by        text,
  closed_at        timestamptz,
  void_reason      text,
  session_id       bigint,
  shift_id         bigint,
  last_at          timestamptz not null default now()
);
create index if not exists chart_cases_status on public.chart_cases (status, opened_at desc);
create index if not exists chart_cases_opener on public.chart_cases (opened_by, opened_at desc);
create index if not exists chart_cases_session on public.chart_cases (session_id);

create table if not exists public.chart_entries (
  id                bigint generated always as identity primary key,
  case_id           bigint not null references public.chart_cases (id) on delete cascade,
  kind              text not null check (kind in ('vitals', 'intervention', 'medication', 'assessment', 'handoff', 'note', 'triage', 'disposition')),
  department        text not null,
  item              text,                    -- catalogue id for intervention / medication / disposition
  data              jsonb not null default '{}'::jsonb,
  author            text not null,
  author_name       text,
  author_rank       smallint,
  author_rank_label text,
  shift_id          bigint,
  session_id        bigint,
  at                timestamptz not null default now(),
  needs_cosign      boolean not null default false,
  cosigned_by       text,
  cosigned_by_name  text,
  cosigned_at       timestamptz,
  error_at          timestamptz,
  error_by          text,
  error_by_name     text,
  error_reason      text
);
create index if not exists chart_entries_case on public.chart_entries (case_id, at);
create index if not exists chart_entries_author on public.chart_entries (author, at desc);
create index if not exists chart_entries_cosign on public.chart_entries (at desc) where needs_cosign and cosigned_at is null and error_at is null;

-- Who may read: owners, clinical members, Administration (QA).
create or replace function public.chart_can_read()
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_exec()
      or exists (select 1 from public.my_roles() r join public.departments d on d.name = r.department
                 where r.kind in ('department', 'rank') and (d.clinical or d.name = 'Administration'))
$$;
revoke execute on function public.chart_can_read() from public, anon;
grant execute on function public.chart_can_read() to authenticated;

alter table public.chart_catalog enable row level security;
alter table public.chart_cases enable row level security;
alter table public.chart_entries enable row level security;
revoke all on public.chart_catalog, public.chart_cases, public.chart_entries from anon, authenticated;
grant select on public.chart_catalog, public.chart_cases, public.chart_entries to authenticated;
drop policy if exists chart_catalog_read on public.chart_catalog;
create policy chart_catalog_read on public.chart_catalog for select to authenticated using (public.chart_can_read());
drop policy if exists chart_cases_read on public.chart_cases;
create policy chart_cases_read on public.chart_cases for select to authenticated using (public.chart_can_read());
drop policy if exists chart_entries_read on public.chart_entries;
create policy chart_entries_read on public.chart_entries for select to authenticated using (public.chart_can_read());

-- Catalogue v1. Items match Maple Hospital (maplehospital.wiki); in_game = false marks roleplay-only realism.
-- Scope: N/P/M/S minimum ranks from the recommendation's section 4 (rank 6 = Director; owners count as 6).
insert into public.chart_catalog (id, kind, label, grp, in_game, scope, sort) values
  -- capabilities
  ('esi',          'cap', 'Set ESI triage',         null, true, '{"Nursing":3,"Paramedicine":4,"Medical":2,"Surgical":3}', 1),
  ('disposition',  'cap', 'Discharge / admit / transfer', null, true, '{"Nursing":3,"Medical":2,"Surgical":3}', 2),
  -- complaints (the five treatable game illnesses first)
  ('appendicitis', 'complaint', 'Appendicitis',  'Game illness', true,  '{}', 1),
  ('broken_bone',  'complaint', 'Broken bone',   'Game illness', true,  '{}', 2),
  ('burn',         'complaint', 'Burn',          'Game illness', true,  '{}', 3),
  ('diabetes',     'complaint', 'Diabetes',      'Game illness', true,  '{}', 4),
  ('flu',          'complaint', 'Flu',           'Game illness', true,  '{}', 5),
  ('anaphylaxis',  'complaint', 'Anaphylaxis',   'Game status',  true,  '{}', 10),
  ('asthma',       'complaint', 'Asthma attack', 'Game status',  true,  '{}', 11),
  ('concussion',   'complaint', 'Concussion',    'Game status',  true,  '{}', 12),
  ('dehydrated',   'complaint', 'Dehydration',   'Game status',  true,  '{}', 13),
  ('hypoglycemia', 'complaint', 'Hypoglycemia',  'Game status',  true,  '{}', 14),
  ('kidney_stones','complaint', 'Kidney stones', 'Game status',  true,  '{}', 15),
  ('seizure',      'complaint', 'Seizure',       'Game status',  true,  '{}', 16),
  ('pregnant',     'complaint', 'Pregnancy / labor', 'Game status', true, '{}', 17),
  ('tonsillitis',  'complaint', 'Tonsillitis',   'Game status',  true,  '{}', 18),
  ('chest_pain',   'complaint', 'Chest pain',    'Roleplay',     false, '{}', 30),
  ('sob',          'complaint', 'Shortness of breath', 'Roleplay', false, '{}', 31),
  ('trauma',       'complaint', 'Trauma (MVC / fall)', 'Roleplay', false, '{}', 32),
  ('stroke',       'complaint', 'Stroke symptoms', 'Roleplay',   false, '{}', 33),
  ('overdose',     'complaint', 'Overdose',      'Roleplay',     false, '{}', 34),
  ('cardiac_arrest','complaint','Cardiac arrest','Roleplay',     false, '{}', 35),
  ('sepsis',       'complaint', 'Sepsis',        'Roleplay',     false, '{}', 36),
  -- assessment chips (ABCDE)
  ('a_patent',     'assessment', 'Airway patent',        'A', true, '{}', 1),
  ('a_compromised','assessment', 'Airway compromised',   'A', true, '{}', 2),
  ('b_normal',     'assessment', 'Breathing normal',     'B', true, '{}', 3),
  ('b_distress',   'assessment', 'Respiratory distress', 'B', true, '{}', 4),
  ('c_normal',     'assessment', 'Skin warm, pink, dry', 'C', true, '{}', 5),
  ('c_poor',       'assessment', 'Pale, cool, clammy',   'C', true, '{}', 6),
  ('c_bleeding',   'assessment', 'Active bleeding',      'C', true, '{}', 7),
  ('d_alert',      'assessment', 'Alert and oriented',   'D', true, '{}', 8),
  ('d_confused',   'assessment', 'Confused',             'D', true, '{}', 9),
  ('d_reflexes',   'assessment', 'Reflexes normal',      'D', true, '{}', 10),
  ('e_injury',     'assessment', 'Visible injury',       'E', true, '{}', 11),
  ('e_rash',       'assessment', 'Rash / swelling',      'E', true, '{}', 12),
  -- interventions
  ('vitals_cart',  'intervention', 'Vitals cart',          'Assessment', true,  '{"Nursing":1,"Paramedicine":1,"Medical":1,"Surgical":1}', 1),
  ('glucose_check','intervention', 'Glucose check',        'Assessment', true,  '{"Nursing":1,"Paramedicine":1,"Medical":1,"Surgical":2}', 2),
  ('gown',         'intervention', 'Gown',                 'Care', true,  '{"Nursing":1,"Paramedicine":1,"Medical":1,"Surgical":1}', 10),
  ('comfort',      'intervention', 'Water / call light / cough drops', 'Care', true, '{"Nursing":1,"Paramedicine":1,"Medical":1,"Surgical":1}', 11),
  ('cold_compress','intervention', 'Cold compress',        'Care', true,  '{"Nursing":1,"Paramedicine":1,"Medical":1,"Surgical":1}', 12),
  ('hob_up',       'intervention', 'Head of bed up',       'Care', true,  '{"Nursing":1,"Paramedicine":1,"Medical":1,"Surgical":1}', 13),
  ('wheelchair',   'intervention', 'Wheelchair',           'Care', true,  '{"Nursing":1,"Paramedicine":1,"Medical":1,"Surgical":1}', 14),
  ('crutches',     'intervention', 'Crutches',             'Care', true,  '{"Nursing":1,"Paramedicine":1,"Medical":1,"Surgical":2}', 15),
  ('o2_mask',      'intervention', 'Oxygen mask',          'Airway & breathing', true,  '{"Nursing":2,"Paramedicine":1,"Medical":1,"Surgical":2}', 20),
  ('bvm',          'intervention', 'Ambu bag (BVM)',       'Airway & breathing', true,  '{"Nursing":4,"Paramedicine":2,"Medical":1,"Surgical":2}', 21),
  ('cpap',         'intervention', 'CPAP',                 'Airway & breathing', false, '{"Nursing":3,"Paramedicine":2,"Medical":2,"Surgical":3}', 22),
  ('intubation',   'intervention', 'Intubation (laryngoscope)', 'Airway & breathing', true, '{"Paramedicine":4,"Medical":3,"Surgical":3}', 23),
  ('blood_draw',   'intervention', 'Blood draw (to lab)',  'Samples', true,  '{"Nursing":2,"Paramedicine":3,"Medical":1,"Surgical":2}', 30),
  ('urine_sample', 'intervention', 'Urine sample (to lab)','Samples', true,  '{"Nursing":2,"Paramedicine":3,"Medical":1,"Surgical":2}', 31),
  ('throat_swab',  'intervention', 'Throat swab (to lab)', 'Samples', true,  '{"Nursing":2,"Paramedicine":3,"Medical":1,"Surgical":2}', 32),
  ('xray',         'intervention', 'X-ray',                'Imaging', true,  '{"Nursing":5,"Medical":2,"Surgical":3}', 40),
  ('ct',           'intervention', 'CT scan',              'Imaging', true,  '{"Nursing":5,"Medical":2,"Surgical":3}', 41),
  ('mri',          'intervention', 'MRI',                  'Imaging', true,  '{"Nursing":5,"Medical":2,"Surgical":3}', 42),
  ('ultrasound',   'intervention', 'Ultrasound',           'Imaging', true,  '{"Nursing":5,"Medical":2,"Surgical":3}', 43),
  ('eeg',          'intervention', 'EEG',                  'Imaging', true,  '{"Nursing":5,"Medical":2,"Surgical":3}', 44),
  ('iv_start',     'intervention', 'IV access',            'Lines & wounds', true,  '{"Nursing":3,"Paramedicine":3,"Medical":2,"Surgical":3}', 50),
  ('remove_iv',    'intervention', 'Remove IV',            'Lines & wounds', true,  '{"Nursing":2,"Paramedicine":3,"Medical":2,"Surgical":2}', 51),
  ('wound_clean',  'intervention', 'Clean wound (sterile saline)', 'Lines & wounds', true, '{"Nursing":2,"Paramedicine":1,"Medical":1,"Surgical":2}', 52),
  ('bandage',      'intervention', 'Nonstick bandage',     'Lines & wounds', true,  '{"Nursing":2,"Paramedicine":1,"Medical":1,"Surgical":2}', 53),
  ('splint',       'intervention', 'Splint / immobilize',  'Lines & wounds', false, '{"Nursing":2,"Paramedicine":1,"Medical":1,"Surgical":2}', 54),
  ('cast_kit',     'intervention', 'Cast',                 'Lines & wounds', true,  '{"Nursing":2,"Paramedicine":2,"Medical":2,"Surgical":2}', 55),
  ('diagnosis',    'intervention', 'Diagnosis given',      'Provider', true,  '{"Nursing":5,"Medical":2,"Surgical":3}', 60),
  ('order_tests',  'intervention', 'Tests ordered',        'Provider', true,  '{"Nursing":5,"Medical":2,"Surgical":3}', 61),
  ('consent',      'intervention', 'Consent form signed',  'Provider', true,  '{"Nursing":3,"Medical":2,"Surgical":3}', 62),
  ('cardiac_monitor','intervention','Cardiac monitor / 12-lead', 'Code', false, '{"Nursing":3,"Paramedicine":4,"Medical":2,"Surgical":3}', 70),
  ('cpr',          'intervention', 'CPR / revive',         'Code', true,  '{"Nursing":1,"Paramedicine":1,"Medical":1,"Surgical":1}', 71),
  ('aed',          'intervention', 'AED',                  'Code', false, '{"Nursing":1,"Paramedicine":2,"Medical":1,"Surgical":2}', 72),
  ('defib',        'intervention', 'Manual defibrillation','Code', false, '{"Nursing":4,"Paramedicine":4,"Medical":3,"Surgical":3}', 73),
  ('or_tray',      'intervention', 'OR tray + Betadine prep', 'Surgery', true, '{"Surgical":1}', 80),
  ('pre_op',       'intervention', 'To Pre-Op',            'Surgery', true,  '{"Nursing":3,"Medical":2,"Surgical":1}', 81),
  ('surgery_assist','intervention','Assist in surgery',    'Surgery', true,  '{"Surgical":2}', 82),
  ('surgery',      'intervention', 'Operation performed',  'Surgery', true,  '{"Surgical":4}', 83),
  ('ambulance',    'intervention', 'Ambulance transport',  'Transport', true,  '{"Paramedicine":1}', 90),
  ('helicopter',   'intervention', 'Helicopter transport', 'Transport', true,  '{"Paramedicine":5}', 91),
  ('restraints',   'intervention', 'Restrained (Code White)', 'Safety', true, '{"Nursing":1,"Paramedicine":1,"Medical":1,"Surgical":1}', 95),
  -- medications (MedStation, IV, pharmacy, crash cart, plus EMS roleplay drugs)
  ('antiemetic',   'medication', 'Antiemetic',        'MedStation', true,  '{"Nursing":3,"Paramedicine":3,"Medical":2,"Surgical":3}', 1),
  ('iv_pain',      'medication', 'IV pain medicine',  'MedStation', true,  '{"Nursing":3,"Paramedicine":3,"Medical":2,"Surgical":3}', 2),
  ('rapid_insulin','medication', 'Rapid insulin',     'MedStation', true,  '{"Nursing":3,"Medical":2,"Surgical":3}', 3),
  ('insulin',      'medication', 'Insulin',           'MedStation', true,  '{"Nursing":3,"Medical":2,"Surgical":3}', 4),
  ('antiviral',    'medication', 'Antiviral',         'MedStation', true,  '{"Nursing":3,"Medical":2,"Surgical":3}', 5),
  ('iv_antibiotics','medication','Antibiotics IV',    'IV', true,  '{"Nursing":3,"Paramedicine":4,"Medical":2,"Surgical":3}', 10),
  ('iv_saline',    'medication', 'Saline IV',         'IV', true,  '{"Nursing":3,"Paramedicine":3,"Medical":2,"Surgical":3}', 11),
  ('dextrose',     'medication', 'Dextrose IV',       'IV', false, '{"Nursing":3,"Paramedicine":3,"Medical":2,"Surgical":3}', 12),
  ('burn_ointment','medication', 'Burn ointment',     'Pharmacy', true, '{"Nursing":2,"Paramedicine":1,"Medical":2,"Surgical":2}', 20),
  ('oral_glucose', 'medication', 'Oral glucose',      'EMS', false, '{"Nursing":2,"Paramedicine":1,"Medical":2,"Surgical":3}', 30),
  ('epi_auto',     'medication', 'Epinephrine auto-injector', 'EMS', false, '{"Nursing":2,"Paramedicine":1,"Medical":2,"Surgical":3}', 31),
  ('naloxone',     'medication', 'Naloxone',          'EMS', false, '{"Nursing":3,"Paramedicine":1,"Medical":2,"Surgical":3}', 32),
  ('aspirin',      'medication', 'Aspirin',           'EMS', false, '{"Nursing":3,"Paramedicine":2,"Medical":2,"Surgical":3}', 33),
  ('epinephrine',  'medication', 'Epinephrine (code)', 'Crash cart', true, '{"Nursing":4,"Paramedicine":4,"Medical":3,"Surgical":3}', 40),
  ('adenosine',    'medication', 'Adenosine',         'Crash cart', true,  '{"Nursing":4,"Paramedicine":4,"Medical":3,"Surgical":4}', 41),
  ('lidocaine',    'medication', 'Lidocaine IV',      'Crash cart', true,  '{"Nursing":4,"Paramedicine":4,"Medical":3,"Surgical":4}', 42),
  ('beta_blocker', 'medication', 'Beta blocker',      'Crash cart', true,  '{"Nursing":4,"Paramedicine":4,"Medical":3,"Surgical":4}', 43),
  ('sedative',     'medication', 'Sedative',          'Crash cart', true,  '{"Nursing":4,"Paramedicine":4,"Medical":3,"Surgical":3}', 44)
on conflict (id) do nothing;
