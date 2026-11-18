-- 0068: CBH Chart v2 catalogue (Alpha). Game-matched symptoms, diagnoses, orders, interventions and medicines (live patients only).
-- and the user's recorded case. Additive: new rows, relabels, in_game fixes; retired items are DEACTIVATED (active = false),
-- never deleted, so old entries keep their labels. Ids are prefixed where a kind would clash: sx_ symptoms, dx_ diagnoses, or_ orders.

-- symptoms (the Patient Portal's symptom list)
insert into public.chart_catalog (id, kind, label, grp, in_game, sort) values
  ('sx_nausea', 'symptom', 'Nausea', null, true, 1), ('sx_headache', 'symptom', 'Headache', null, true, 2), ('sx_dizzy', 'symptom', 'Dizzy', null, true, 3),
  ('sx_vomiting', 'symptom', 'Vomiting', null, true, 4), ('sx_cough', 'symptom', 'Cough', null, true, 5), ('sx_sneezing', 'symptom', 'Sneezing', null, true, 6),
  ('sx_runny_nose', 'symptom', 'Runny nose', null, true, 7), ('sx_fever', 'symptom', 'Fever', null, true, 8), ('sx_thirst', 'symptom', 'Thirst / dry mouth', null, true, 9),
  ('sx_pain', 'symptom', 'Pain', null, true, 10), ('sx_abdominal', 'symptom', 'Abdominal pain', null, true, 11), ('sx_chest_pain', 'symptom', 'Chest pain', null, true, 12),
  ('sx_sob', 'symptom', 'Shortness of breath', null, true, 13), ('sx_weak', 'symptom', 'Weakness / tired', null, true, 14), ('sx_confusion', 'symptom', 'Confusion', null, true, 15),
  ('sx_wound', 'symptom', 'Wound / burn', null, true, 16), ('sx_bleeding', 'symptom', 'Bleeding', null, true, 17), ('sx_deformity', 'symptom', 'Deformity / swelling', null, true, 18),
  ('sx_rash', 'symptom', 'Rash', null, true, 19), ('sx_seizure', 'symptom', 'Seizure', null, true, 20)
on conflict (id) do nothing;

-- diagnoses (what the game's doctor decides; shown as "Pending" until set)
insert into public.chart_catalog (id, kind, label, grp, in_game, sort) values
  ('dx_dehydrated', 'diagnosis', 'Dehydrated', 'Game diagnosis', true, 1), ('dx_flu', 'diagnosis', 'Flu A/B', 'Game diagnosis', true, 2),
  ('dx_diabetes', 'diagnosis', 'Diabetes', 'Game diagnosis', true, 3), ('dx_burn', 'diagnosis', 'Burn', 'Game diagnosis', true, 4),
  ('dx_broken_bone', 'diagnosis', 'Broken Bone', 'Game diagnosis', true, 5), ('dx_appendicitis', 'diagnosis', 'Appendicitis', 'Game diagnosis', true, 6),
  ('dx_cardiac_arrest', 'diagnosis', 'Cardiac arrest', 'Game diagnosis', true, 7),
  ('dx_seizure', 'diagnosis', 'Seizure', 'Seen in game', true, 20), ('dx_heart_attack', 'diagnosis', 'Heart attack', 'Seen in game', true, 21),
  ('dx_stroke', 'diagnosis', 'Stroke', 'Seen in game', true, 22), ('dx_pneumonia', 'diagnosis', 'Pneumonia', 'Seen in game', true, 23),
  ('dx_infected_wound', 'diagnosis', 'Infected wound', 'Seen in game', true, 24), ('dx_pregnancy', 'diagnosis', 'Pregnancy', 'Seen in game', true, 25),
  ('dx_tonsillitis', 'diagnosis', 'Tonsillitis', 'Seen in game', true, 26), ('dx_tumor', 'diagnosis', 'Tumor', 'Seen in game', true, 27),
  ('dx_hypoglycemia', 'diagnosis', 'Hypoglycemia', 'Other', true, 40), ('dx_anaphylaxis', 'diagnosis', 'Anaphylaxis', 'Other', true, 41),
  ('dx_asthma', 'diagnosis', 'Asthma', 'Other', true, 42), ('dx_kidney_stones', 'diagnosis', 'Kidney stones', 'Other', true, 43),
  ('dx_concussion', 'diagnosis', 'Concussion', 'Other', true, 44)
on conflict (id) do nothing;

-- light orders (what the game's doctor orders; a result is ticked back later)
insert into public.chart_catalog (id, kind, label, grp, in_game, sort) values
  ('or_blood', 'order', 'Blood sample', null, true, 1), ('or_urine', 'order', 'Urine sample', null, true, 2), ('or_swab', 'order', 'Throat swab', null, true, 3),
  ('or_xray', 'order', 'X-ray', null, true, 4), ('or_ct', 'order', 'CT scan', null, true, 5), ('or_mri', 'order', 'MRI', null, true, 6),
  ('or_us', 'order', 'Ultrasound', null, true, 7)
on conflict (id) do nothing;

-- new interventions and medicines seen in the game
insert into public.chart_catalog (id, kind, label, grp, in_game, scope, sort) values
  ('thermometer',      'intervention', 'Temperature (thermometer)',  'Assessment', true, '{"Nursing":1,"Paramedicine":1,"Medical":1,"Surgical":1}', 3),
  ('stethoscope',      'intervention', 'Heart & lung check',         'Assessment', true, '{"Nursing":1,"Paramedicine":1,"Medical":1,"Surgical":1}', 4),
  ('ekg',              'intervention', 'EKG / bedside monitor',      'Assessment', true, '{"Nursing":1,"Paramedicine":1,"Medical":1,"Surgical":2}', 5),
  ('pulse_ox',         'intervention', 'Pulse oximeter',             'Assessment', true, '{"Nursing":1,"Paramedicine":1,"Medical":1,"Surgical":1}', 6),
  ('history',          'intervention', 'History taken',              'Assessment', true, '{"Nursing":1,"Paramedicine":1,"Medical":1,"Surgical":1}', 7),
  ('water',            'intervention', 'Water cup',                  'Care', true, '{"Nursing":1,"Paramedicine":1,"Medical":1,"Surgical":1}', 16),
  ('crackers',         'intervention', 'Crackers',                   'Care', true, '{"Nursing":1,"Paramedicine":1,"Medical":1,"Surgical":1}', 17),
  ('fridge_item',      'intervention', 'Juice / glucose drink / ice pop', 'Care', true, '{"Nursing":1,"Paramedicine":1,"Medical":1,"Surgical":1}', 18),
  ('cough_drops',      'intervention', 'Cough drops',                'Care', true, '{"Nursing":1,"Paramedicine":1,"Medical":1,"Surgical":1}', 19),
  ('ice_pack',         'intervention', 'Ice pack',                   'Care', true, '{"Nursing":1,"Paramedicine":1,"Medical":1,"Surgical":1}', 20),
  ('rest',             'intervention', 'Rest',                       'Care', true, '{"Nursing":1,"Paramedicine":1,"Medical":1,"Surgical":1}', 21),
  ('stretcher',        'intervention', 'Stretcher',                  'Care', true, '{"Nursing":1,"Paramedicine":1,"Medical":1,"Surgical":1}', 22),
  ('crash_cart',       'intervention', 'Crash cart brought',         'Code', true, '{"Nursing":1,"Paramedicine":1,"Medical":1,"Surgical":1}', 74),
  ('defib_pads',       'intervention', 'Defib pads / rhythm check',  'Code', true, '{"Nursing":1,"Paramedicine":2,"Medical":1,"Surgical":2}', 75),
  ('time_of_death',    'intervention', 'Time of death reported',     'Code', true, '{"Nursing":3,"Paramedicine":4,"Medical":2,"Surgical":3}', 76),
  ('biopsy',           'intervention', 'Biopsy',                     'Provider', true, '{"Medical":3,"Surgical":3}', 63),
  ('baby_doppler',     'intervention', 'Baby doppler',               'Labor & delivery', true, '{"Nursing":2,"Paramedicine":3,"Medical":2,"Surgical":3}', 85),
  ('bulb_suction',     'intervention', 'Bulb suction',               'Labor & delivery', true, '{"Nursing":2,"Paramedicine":2,"Medical":2,"Surgical":3}', 86),
  ('delivery',         'intervention', 'Baby delivered',             'Labor & delivery', true, '{"Nursing":3,"Paramedicine":4,"Medical":2,"Surgical":3}', 87),
  ('birth_certificate','intervention', 'Birth certificate',          'Labor & delivery', true, '{"Nursing":1,"Paramedicine":1,"Medical":1,"Surgical":1}', 88),
  ('discharge_papers', 'intervention', 'Discharge papers given',     'Discharge', true, '{"Nursing":1,"Paramedicine":1,"Medical":1,"Surgical":1}', 96),
  ('epipen',           'medication',   'EpiPen',                     'EMS', true,  '{"Nursing":2,"Paramedicine":1,"Medical":2,"Surgical":3}', 31),
  ('inhaler',          'medication',   'Inhaler',                    'EMS', true,  '{"Nursing":2,"Paramedicine":1,"Medical":2,"Surgical":3}', 34),
  ('glucagon',         'medication',   'Glucagon',                   'EMS', true,  '{"Nursing":3,"Paramedicine":3,"Medical":2,"Surgical":3}', 35),
  ('nasal_saline',     'medication',   'Nasal saline',               'Pharmacy', true, '{"Nursing":2,"Paramedicine":1,"Medical":2,"Surgical":2}', 21),
  ('saline_flush',     'medication',   'Saline flush',               'Crash cart', true, '{"Nursing":3,"Paramedicine":3,"Medical":2,"Surgical":3}', 45)
on conflict (id) do nothing;

-- complaints seen in 2025-26 game updates
insert into public.chart_catalog (id, kind, label, grp, in_game, pathway, sort) values
  ('heart_attack',    'complaint', 'Heart attack',   'Seen in game', true, 'seen', 20),
  ('pneumonia',       'complaint', 'Pneumonia',      'Seen in game', true, 'seen', 21),
  ('infected_wound',  'complaint', 'Infected wound', 'Seen in game', true, 'seen', 22),
  ('first_trimester', 'complaint', '1st trimester',  'Seen in game', true, 'seen', 23)
on conflict (id) do nothing;

-- relabels and in-game corrections
update public.chart_catalog set label = 'Blood pressure (vitals cart)' where id = 'vitals_cart';
update public.chart_catalog set label = 'Glucose monitor' where id = 'glucose_check';
update public.chart_catalog set label = 'Blood sample (phlebotomy)' where id = 'blood_draw';
update public.chart_catalog set label = 'Surgery consent form' where id = 'consent';
update public.chart_catalog set label = 'CPR (Code Blue)' where id = 'cpr';
update public.chart_catalog set label = 'Shock (VT/VF)', in_game = true where id = 'defib';
update public.chart_catalog set in_game = true where id in ('aed', 'intubation');
update public.chart_catalog set label = 'Glucose drink', grp = 'Mini-fridge', in_game = true where id = 'oral_glucose';
update public.chart_catalog set label = 'Rapid insulin (insulin pen)' where id = 'rapid_insulin';
update public.chart_catalog set label = 'Dehydrated' where id = 'dehydrated' and kind = 'complaint';
update public.chart_catalog set in_game = true, grp = 'Game status' where id = 'cardiac_arrest';
update public.chart_catalog set in_game = true, grp = 'Seen in game' where id = 'stroke';

-- how sure we are that the game has a step-by-step pathway for each complaint
update public.chart_catalog set pathway = 'verified' where kind = 'complaint' and id in ('appendicitis', 'broken_bone', 'burn', 'diabetes', 'flu', 'dehydrated', 'cardiac_arrest');
update public.chart_catalog set pathway = 'seen' where kind = 'complaint' and id in ('seizure', 'pregnant', 'tonsillitis', 'stroke', 'heart_attack', 'pneumonia', 'infected_wound', 'first_trimester');
update public.chart_catalog set pathway = 'none' where kind = 'complaint' and pathway is null;

-- retired (kept for old entries' labels, hidden from the lists)
update public.chart_catalog set active = false where id in ('comfort', 'cardiac_monitor', 'diagnosis', 'order_tests', 'epi_auto');
