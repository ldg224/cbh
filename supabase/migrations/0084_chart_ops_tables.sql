-- 0084: CBH Chart operations, new tables (Bravo, 19 Nov 2026; BACKEND-PLAN.md §1.3, CONTRACT.md v1).
-- Rooms and beds (the Maple main ward), the Chart side of a live shift, requests, the action log, typed-text
-- suggestions, the single ops row, and the online check-in attempt log. RLS on with no policies and no table grants:
-- the website only ever reaches these through the security-definer RPCs in 0087-0089. New tables only.

create table if not exists public.chart_rooms (
  id            text primary key,
  beds          smallint not null check (beds between 1 and 2),
  area          text,
  department    text not null,
  who           text not null default 'anyone' check (who in ('anyone', 'kids', 'adults')),
  closed        boolean not null default false,
  closed_reason text check (closed_reason is null or char_length(closed_reason) between 3 and 120),
  closed_by     text,
  closed_at     timestamptz,
  problem_note  text check (problem_note is null or char_length(problem_note) <= 200),
  problem_by    text,
  problem_at    timestamptz,
  sort          int not null default 100,
  active        boolean not null default true,
  updated_by    text,
  updated_at    timestamptz not null default now(),
  constraint chart_rooms_closed_reason check (not closed or closed_reason is not null)
);

create table if not exists public.chart_beds (
  id          text primary key,
  room_id     text not null references public.chart_rooms (id),
  label       text not null,
  owner_id    text,
  owner_since timestamptz,
  pair_id     text,
  available   boolean not null default true,
  off_reason  text check (off_reason is null or char_length(off_reason) between 3 and 120),
  off_by      text,
  off_at      timestamptz,
  constraint chart_beds_off_reason check (available or off_reason is not null)
);
create index if not exists chart_beds_owner on public.chart_beds (owner_id) where owner_id is not null;

create table if not exists public.chart_staff (
  discord_id     text primary key,
  shift_id       bigint,
  role           text check (role in ('reception', 'room', 'on_call', 'road', 'supervisor')),
  department     text,                      -- the team they work as (their shift's, or another clinical one they're in)
  ready          boolean not null default false,
  ready_since    timestamptz,
  last_active_at timestamptz not null default now(),
  on_break       boolean not null default false,
  offer_room_id  text,
  phone_mode     boolean not null default false,
  notices        jsonb not null default '[]'::jsonb,   -- one-shot messages for the person ("Bed 105 B was switched off")
  joined_at      timestamptz not null default now()
);

create table if not exists public.chart_requests (
  id            bigint generated always as identity primary key,
  case_id       bigint not null references public.chart_cases (id) on delete cascade,
  kind          text not null check (kind in ('doctor', 'surgery', 'imaging', 'help', 'code')),
  surgery_mode  text check (surgery_mode in ('come_down', 'take_to_surgery')),
  note          text check (note is null or char_length(note) <= 200),
  red           boolean not null default false,
  asked_by      text not null,
  asked_at      timestamptz not null default now(),
  sent_to       text,
  sent_by       text,
  accepted_by   text,
  accepted_at   timestamptz,
  here_at       timestamptz,
  done_at       timestamptz,
  done_note     text check (done_note is null or char_length(done_note) <= 500),
  cancelled_at  timestamptz,
  cancelled_by  text,
  cancel_reason text,
  reopened      smallint not null default 0,
  chased        smallint not null default 0,          -- "Chase" on an unaccepted request (Delta, CONTRACT v1.1)
  chased_at     timestamptz,
  auto          boolean not null default false        -- made from the check-in's extra teams
);
create index if not exists chart_requests_open on public.chart_requests (case_id) where done_at is null and cancelled_at is null;
create unique index if not exists chart_requests_one_code on public.chart_requests (case_id) where kind = 'code' and done_at is null and cancelled_at is null;

create table if not exists public.chart_log (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  case_id    bigint,
  room_id    text,
  request_id bigint,
  subject_id text,
  actor      text,
  actor_name text,
  actor_role text,
  action     text not null,
  detail     jsonb not null default '{}'::jsonb
);
create index if not exists chart_log_case on public.chart_log (case_id, at) where case_id is not null;

create table if not exists public.chart_suggestions (
  kind      text not null check (kind in ('symptom', 'did', 'order', 'result', 'diagnosis', 'follow_up', 'advice')),
  norm      text not null,
  label     text not null check (char_length(label) between 1 and 120),
  uses      int not null default 0,
  last_used timestamptz,
  seed      boolean not null default false,
  hidden    boolean not null default false,
  hidden_by text,
  primary key (kind, norm)
);

create table if not exists public.chart_ops (
  id             int primary key default 1 check (id = 1),
  rev            bigint not null default 1,
  last_tick_at   timestamptz not null default '-infinity',
  reception_open boolean not null default true,
  online_mode    text not null default 'open' check (online_mode in ('open', 'walk_ins_only')),
  ip_salt        text not null default encode(extensions.gen_random_bytes(16), 'hex'),
  ip_salt_day    date not null default current_date,
  updated_by     text,
  updated_at     timestamptz not null default now()
);
insert into public.chart_ops (id) values (1) on conflict do nothing;

create table if not exists public.chart_checkin_attempts (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  ip_hash     text,
  client_hash text,
  ok          boolean not null default false,
  kind        text not null default 'checkin' check (kind in ('checkin', 'lookup'))   -- lookup = the roblox-lookup Edge Function
);
create index if not exists chart_checkin_attempts_at on public.chart_checkin_attempts (at);

-- RLS on, no policies, no grants: RPCs only.
do $$
declare t text;
begin
  foreach t in array array['chart_rooms', 'chart_beds', 'chart_staff', 'chart_requests', 'chart_log', 'chart_suggestions',
                           'chart_ops', 'chart_checkin_attempts'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

-- Seed: Maple Hospital main ward (owner's map; prototype data.js). 109/110 are Paediatric Emergency (kids only).
insert into public.chart_rooms (id, beds, area, department, who, sort) values
  ('101', 2, 'r101', 'Nursing', 'anyone', 1), ('102', 1, 'r102', 'Nursing', 'anyone', 2), ('103', 1, 'r103', 'Nursing', 'anyone', 3),
  ('104', 1, 'r104', 'Nursing', 'anyone', 4), ('105', 2, 'r105', 'Medical', 'anyone', 5), ('106', 2, 'r106', 'Medical', 'anyone', 6),
  ('107', 2, 'r107', 'Medical', 'anyone', 7), ('108', 1, 'r108', 'Medical', 'anyone', 8), ('109', 1, 'r109', 'Paediatric', 'kids', 9),
  ('110', 1, 'r110', 'Paediatric', 'kids', 10)
on conflict (id) do nothing;
insert into public.chart_beds (id, room_id, label)
select r.id || x.s, r.id, case when r.beds > 1 then r.id || ' Bed ' || x.s else r.id end
from public.chart_rooms r cross join lateral (select unnest(case when r.beds > 1 then array['A', 'B'] else array[''] end) s) x
on conflict (id) do nothing;

-- Seed the suggestions from the 0068 catalogue labels (they start with 0 uses and grow from what staff type).
insert into public.chart_suggestions (kind, norm, label, seed)
select k, lower(btrim(c.label)), c.label, true from public.chart_catalog c
cross join lateral (select case c.kind when 'symptom' then 'symptom' when 'intervention' then 'did' when 'medication' then 'did'
                                       when 'order' then 'order' when 'diagnosis' then 'diagnosis' end k) m
where c.active and m.k is not null
on conflict do nothing;
