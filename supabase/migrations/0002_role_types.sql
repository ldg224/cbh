-- 0002: what each Discord role means, so the website can show department, year/rank and leadership badges.
-- Filled in by the bot (cbh/roles.py) on every sync. Additive only.

alter table public.roles add column if not exists kind        text not null default 'other';
  -- leadership | executive | verified | department | rank | status | ping | office | community | bot | other
alter table public.roles add column if not exists department  text;      -- e.g. 'Nursing' (department and rank roles)
alter table public.roles add column if not exists rank_label  text;      -- e.g. 'Year 5', 'Director', 'Leader'
alter table public.roles add column if not exists rank_order  integer;   -- higher = more senior within the department
alter table public.roles add column if not exists badge_color integer;   -- colour to use for this role's badge
