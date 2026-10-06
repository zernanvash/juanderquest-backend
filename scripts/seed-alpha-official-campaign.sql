BEGIN;

-- 1. Create or update schedule
INSERT INTO juanchoice_schedules (
  id, schedule_key, region_key, display_region, timezone, cadence,
  enabled, effective_period, preparation_lead_days, minimum_candidates,
  target_candidates, maximum_candidates, themes, policy_version, is_test
) VALUES (
  'a0000000-0000-4000-8000-000000000001',
  'pangasinan-monthly',
  'pangasinan',
  'Pangasinan',
  'Asia/Manila',
  'monthly',
  true,
  '2026-10-01',
  7,
  3,
  4,
  6,
  '["Coastal Discoveries", "Heritage Trails", "Culinary Journeys", "Eco Adventures"]'::jsonb,
  'juanchoice-pilot-v1',
  false
) ON CONFLICT (schedule_key, is_test) DO UPDATE SET
  enabled = true,
  effective_period = '2026-10-01',
  updated_at = NOW();

-- 2. Insert or update the official October 2026 Spotlight Campaign
INSERT INTO juanchoice_campaigns (
  id, slug, region, theme, status, opens_at, closes_at, is_test, policy_version, counts_for_streak
) VALUES (
  'e73f5869-797c-4e28-8bab-2c0b2d38eb20',
  'juanchoice-october-2026-spotlight',
  'pangasinan',
  'Coastal Discoveries — October 2026 Community Spotlight',
  'voting',
  '2026-10-01 00:00:00+08',
  '2026-10-10 23:59:59+08',
  false,
  'juanchoice-pilot-v1',
  false
) ON CONFLICT (id) DO UPDATE SET
  slug = EXCLUDED.slug,
  theme = EXCLUDED.theme,
  status = 'voting',
  opens_at = EXCLUDED.opens_at,
  closes_at = EXCLUDED.closes_at,
  is_test = false;

-- 3. Link campaign to schedule period
INSERT INTO juanchoice_schedule_periods (
  id, schedule_id, period_start, opens_at, closes_at, campaign_id,
  status, selected_theme, policy_snapshot, selection_seed, prepared_at
) VALUES (
  'b0000000-0000-4000-8000-000000000001',
  'a0000000-0000-4000-8000-000000000001',
  '2026-10-01',
  '2026-10-01 00:00:00+08',
  '2026-10-10 23:59:59+08',
  'e73f5869-797c-4e28-8bab-2c0b2d38eb20',
  'prepared',
  'Coastal Discoveries — October 2026 Community Spotlight',
  '{"policy_version": "juanchoice-pilot-v1"}'::jsonb,
  'october-2026-seed',
  '2026-09-28 00:00:00+08'
) ON CONFLICT (schedule_id, period_start) DO UPDATE SET
  campaign_id = EXCLUDED.campaign_id,
  opens_at = EXCLUDED.opens_at,
  closes_at = EXCLUDED.closes_at,
  status = 'prepared',
  updated_at = NOW();

-- 4. Ensure candidates exist for this campaign
INSERT INTO juanchoice_candidates (id, campaign_id, spot_id, status, is_test) VALUES
  ('607c0233-8b19-4587-9d5d-b91c957b142c', 'e73f5869-797c-4e28-8bab-2c0b2d38eb20', 'spot-tambobong-beach', 'eligible', false),
  ('64db69f1-3ebe-45ec-8f5c-c57a6f50d3a1', 'e73f5869-797c-4e28-8bab-2c0b2d38eb20', 'spot-cabongaoan-beach', 'eligible', false),
  ('c7808ce7-69b4-4682-813a-872b80c0dc5a', 'e73f5869-797c-4e28-8bab-2c0b2d38eb20', 'spot-cape-bolinao-lighthouse', 'eligible', false),
  ('596009a3-3035-4544-9063-846a7aeff680', 'e73f5869-797c-4e28-8bab-2c0b2d38eb20', 'spot-tondol-beach', 'eligible', false)
ON CONFLICT (campaign_id, spot_id) DO UPDATE SET
  status = 'eligible',
  is_test = false;

-- 5. Curate scout users to is_test = false and update display names
UPDATE users SET display_name = 'Scout Aira (Verified Scout)', is_test = false WHERE id = 'qa-sim-20260927-u01';
UPDATE users SET display_name = 'Scout Ben', is_test = false WHERE id = 'qa-sim-20260927-u02';
UPDATE users SET display_name = 'Scout Celine', is_test = false WHERE id = 'qa-sim-20260927-u03';
UPDATE users SET display_name = 'Scout Diego', is_test = false WHERE id = 'qa-sim-20260927-u04';
UPDATE users SET display_name = 'Scout Ella', is_test = false WHERE id = 'qa-sim-20260927-u05';
UPDATE users SET display_name = 'Scout Franco', is_test = false WHERE id = 'qa-sim-20260927-u06';

-- 6. Insert community ballots from scouts (leaving Scout Aira unvoted for live demo)
DELETE FROM juanchoice_ballots WHERE campaign_id = 'e73f5869-797c-4e28-8bab-2c0b2d38eb20';
DELETE FROM juanchoice_participations WHERE campaign_id = 'e73f5869-797c-4e28-8bab-2c0b2d38eb20';

INSERT INTO juanchoice_ballots (campaign_id, user_id, candidate_id, version, is_test, created_at, updated_at) VALUES
  ('e73f5869-797c-4e28-8bab-2c0b2d38eb20', 'qa-sim-20260927-u02', '607c0233-8b19-4587-9d5d-b91c957b142c', 1, false, '2026-10-02 10:00:00+08', '2026-10-02 10:00:00+08'),
  ('e73f5869-797c-4e28-8bab-2c0b2d38eb20', 'qa-sim-20260927-u03', '64db69f1-3ebe-45ec-8f5c-c57a6f50d3a1', 1, false, '2026-10-02 11:30:00+08', '2026-10-02 11:30:00+08'),
  ('e73f5869-797c-4e28-8bab-2c0b2d38eb20', 'qa-sim-20260927-u04', 'c7808ce7-69b4-4682-813a-872b80c0dc5a', 1, false, '2026-10-03 14:15:00+08', '2026-10-03 14:15:00+08'),
  ('e73f5869-797c-4e28-8bab-2c0b2d38eb20', 'qa-sim-20260927-u05', '607c0233-8b19-4587-9d5d-b91c957b142c', 1, false, '2026-10-04 09:00:00+08', '2026-10-04 09:00:00+08'),
  ('e73f5869-797c-4e28-8bab-2c0b2d38eb20', 'qa-sim-20260927-u06', '596009a3-3035-4544-9063-846a7aeff680', 1, false, '2026-10-04 16:45:00+08', '2026-10-04 16:45:00+08');

INSERT INTO juanchoice_participations (campaign_id, user_id, civic_xp, stamps, is_test, rewarded_at) VALUES
  ('e73f5869-797c-4e28-8bab-2c0b2d38eb20', 'qa-sim-20260927-u02', 25, 1, false, '2026-10-02 10:00:00+08'),
  ('e73f5869-797c-4e28-8bab-2c0b2d38eb20', 'qa-sim-20260927-u03', 25, 1, false, '2026-10-02 11:30:00+08'),
  ('e73f5869-797c-4e28-8bab-2c0b2d38eb20', 'qa-sim-20260927-u04', 25, 1, false, '2026-10-03 14:15:00+08'),
  ('e73f5869-797c-4e28-8bab-2c0b2d38eb20', 'qa-sim-20260927-u05', 25, 1, false, '2026-10-04 09:00:00+08'),
  ('e73f5869-797c-4e28-8bab-2c0b2d38eb20', 'qa-sim-20260927-u06', 25, 1, false, '2026-10-04 16:45:00+08');

COMMIT;
