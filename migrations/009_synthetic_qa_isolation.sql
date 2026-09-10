-- Migration 009: Synthetic QA Data Isolation
-- Adds durable is_test classification flag across primary domain tables and isolates known fixture batches.

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE quests ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE spots ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE spot_activity_events ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;

-- Exact batch identification for synthetic QA test fixtures
UPDATE users SET is_test = TRUE WHERE id LIKE 'qa-social-20260909-%' OR id LIKE 'qa-ui-20260909-%' OR seed_id LIKE 'qa-%' OR seed_id IN ('seed-qa-fixture', 'test-bot-1', 'qa-bot');
UPDATE spots SET is_test = TRUE WHERE id LIKE 'qa-social-20260909-%' OR id LIKE 'qa-ui-20260909-%' OR source_name IN ('QA Test Fixtures', 'QA Social Fixtures');
UPDATE quests SET is_test = TRUE WHERE id LIKE 'qa-social-20260909-%' OR id LIKE 'qa-ui-20260909-%';
UPDATE submissions SET is_test = TRUE WHERE id LIKE 'qa-social-20260909-%' OR id LIKE 'qa-ui-20260909-%' OR user_id LIKE 'qa-%' OR id = 'sub-seeded-governance-eligibility' OR idempotency_key LIKE 'seeded-%';
UPDATE spot_activity_events SET is_test = TRUE WHERE user_id LIKE 'qa-%' OR spot_id LIKE 'qa-%';

CREATE INDEX IF NOT EXISTS idx_users_is_test ON users(is_test);
CREATE INDEX IF NOT EXISTS idx_spots_is_test ON spots(is_test);
CREATE INDEX IF NOT EXISTS idx_quests_is_test ON quests(is_test);
CREATE INDEX IF NOT EXISTS idx_submissions_is_test ON submissions(is_test);
