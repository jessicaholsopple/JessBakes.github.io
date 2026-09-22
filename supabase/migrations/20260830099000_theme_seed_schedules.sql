-- ============================================================
-- Themes: seed draft schedules, Phase 4.
--
-- Seeds theme_schedules (the DRAFT table) ONLY -- never
-- theme_schedules_published -- so these have ZERO live effect until
-- Jessica reviews them and explicitly clicks Publish. All 12 rows are
-- deliberately chosen to be non-overlapping at the default
-- tier_priority (0), so the seeded draft is immediately publishable
-- without her first having to untangle a pre-existing conflict.
--
-- `rule_weekday` uses the same Sunday=0..Saturday=6 convention as
-- supabase/functions/_shared/schedule.mjs's WEEKDAY_INDEX, so
-- Thursday = 4.
-- ============================================================
begin;

insert into public.theme_schedules
  (theme_key, label, recurrence_type, annual_start_month, annual_start_day, annual_end_month, annual_end_day)
values
  ('spring',         'Spring',          'annual_fixed', 3, 20, 6, 20),
  ('summer',         'Summer',          'annual_fixed', 6, 21, 9, 22),
  ('autumn',         'Autumn',          'annual_fixed', 9, 23, 12, 20),
  ('winter',         'Winter',          'annual_fixed', 12, 21, 3, 19),
  ('new_years',      'New Year''s',     'annual_fixed', 12, 27, 1, 6),
  ('valentines',     'Valentine''s Day','annual_fixed', 2, 1, 2, 14),
  ('st_patricks',    'St. Patrick''s Day', 'annual_fixed', 3, 11, 3, 17),
  ('fourth_of_july', 'Fourth of July',  'annual_fixed', 6, 29, 7, 5),
  ('halloween',      'Halloween',       'annual_fixed', 10, 1, 10, 31),
  ('christmas',      'Christmas',       'annual_fixed', 12, 1, 12, 25);

insert into public.theme_schedules
  (theme_key, label, recurrence_type, rule_kind, window_start_offset_days, window_end_offset_days)
values
  ('easter', 'Easter (Palm Sunday through Easter Monday)', 'annual_rule', 'easter_offset', -7, 1);

insert into public.theme_schedules
  (theme_key, label, recurrence_type, rule_kind, rule_month, rule_weekday, rule_occurrence, window_start_offset_days, window_end_offset_days)
values
  ('thanksgiving', 'Thanksgiving (starting 7 days before)', 'annual_rule', 'nth_weekday_offset', 11, 4, 4, -7, 0);

commit;
