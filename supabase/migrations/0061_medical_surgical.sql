-- 0061: Medical and Surgical departments (owner approved names and colours, 18 Nov 2026; Bravo). Additive.
-- Department rows (the website, bot and database read public.departments, 0060), rank defaults like Nursing (Year 5 and
-- Year 4 review applications), office keys (Director + Year 5 + Year 4, active), and "Medical/Surgical Application"
-- forms that start CLOSED (a Director or executive opens them). Ranks are labelled by the bot (roles.py) on its next sync.
insert into public.departments (name, id, color, icon, sort, meeting_channel_id, team_channel_id) values
  ('Medical', 'medical', x'2F7AF2'::int, 'stethoscope', 50, '1572467680764493907', '1572467684770189384'),
  ('Surgical', 'surgical', x'229147'::int, 'scalpel', 60, '1572467693121044620', '1572467697306832956')
on conflict (name) do nothing;

insert into public.rank_permissions (role_id, perm, granted_by) values
  ('1572467324974268497', 'applications.review', 'seed-0061'),
  ('1572467327042330754', 'applications.review', 'seed-0061'),
  ('1572467339642019974', 'applications.review', 'seed-0061'),
  ('1572467341709672519', 'applications.review', 'seed-0061')
on conflict do nothing;

insert into public.office_keys (department, role_id, ranks, active) values
  ('Medical', '1572467336030593035', array['1572467322919325708', '1572467324974268497', '1572467327042330754'], true),
  ('Surgical', '1572467349322211331', array['1572467337477488701', '1572467339642019974', '1572467341709672519'], true)
on conflict (department) do nothing;

insert into public.forms (key, title, description, kind, audience, review_team, open, questions, sort, department, stages,
                          accept_rank_role_id, accept_role_ids, cooldown_days, section, rank_set_at, rank_set_by_name) values
  ('medical-application', 'Medical Application', 'Apply to join the Medical department.', 'application', 'member', 'Medical', false,
   '[{"id": "roblox", "type": "text", "label": "Roblox username", "required": true}, {"id": "age", "type": "number", "label": "How old are you?", "required": true}, {"id": "timezone", "type": "text", "label": "Your time zone", "required": true}, {"id": "why", "type": "long", "label": "Why do you want to join Medical?", "required": true}, {"id": "experience", "type": "long", "label": "Any roleplay hospital experience?", "required": false}]'::jsonb, coalesce((select max(sort) from public.forms), 0) + 5, 'Medical', '["In review"]'::jsonb, '1572467334373842974', '{}', 14, 'General', now(), 'Set up with the department'),
  ('surgical-application', 'Surgical Application', 'Apply to join the Surgical department.', 'application', 'member', 'Surgical', false,
   '[{"id": "roblox", "type": "text", "label": "Roblox username", "required": true}, {"id": "age", "type": "number", "label": "How old are you?", "required": true}, {"id": "timezone", "type": "text", "label": "Your time zone", "required": true}, {"id": "why", "type": "long", "label": "Why do you want to join Surgical?", "required": true}, {"id": "experience", "type": "long", "label": "Any roleplay hospital experience?", "required": false}]'::jsonb, coalesce((select max(sort) from public.forms), 0) + 6, 'Surgical', '["In review"]'::jsonb, '1572467347841622036', '{}', 14, 'General', now(), 'Set up with the department')
on conflict (key) do nothing;

-- Administration's colour follows its Director role, recoloured in Discord to #7B61FF (Delta, 18 Nov 2026).
update public.departments set color = x'7B61FF'::int where name = 'Administration';
