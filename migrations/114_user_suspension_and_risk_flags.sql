-- Migration 113 (Plan 117): user suspension columns, search/sort indexes, risk_flags table, and risk thresholds.
-- Additive. Default privileges created by scripts/prod-db/bootstrap.sh grant SELECT,INSERT,UPDATE,DELETE
-- on risk_flags to jdq_app and SELECT to jdq_readonly when applied as jdq_owner.

ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_reason TEXT;
ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_users_suspended_reason;
ALTER TABLE users ADD CONSTRAINT chk_users_suspended_reason
  CHECK (suspended_reason IS NULL OR char_length(suspended_reason) BETWEEN 3 AND 300);
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_by TEXT REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_users_suspended ON users (suspended_at) WHERE suspended_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_created_id ON users (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_users_demo_points_id ON users (demo_points DESC, id DESC);

-- PGMEM_SKIP_BEGIN
CREATE INDEX IF NOT EXISTS idx_users_search_trgm
  ON users USING gin (
    f_unaccent(lower(coalesce(display_name, '') || ' ' || coalesce(handle, '') || ' ' || coalesce(email, ''))) extensions.gin_trgm_ops
  );
-- PGMEM_SKIP_END

CREATE TABLE IF NOT EXISTS risk_flags (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rule TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed', 'actioned')),
  reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  review_note TEXT CHECK (review_note IS NULL OR char_length(review_note) BETWEEN 3 AND 300),
  is_test BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, rule, window_start)
);

CREATE INDEX IF NOT EXISTS idx_risk_flags_open ON risk_flags (status, severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_risk_flags_user_created ON risk_flags (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_risk_flags_rule_created ON risk_flags (rule, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_submissions_user_status_created ON submissions (user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stamp_ledger_positive_created ON stamp_ledger (created_at DESC) WHERE delta > 0;
-- PGMEM_SKIP_BEGIN
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'quest_step_evidence'
      AND column_name = 'failed_tries'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_quest_step_evidence_failed ON quest_step_evidence (user_id, updated_at DESC) WHERE failed_tries > 0;
  END IF;
END $$;
-- PGMEM_SKIP_END

-- PGMEM_SKIP_BEGIN
-- Seed default risk thresholds into system_settings_document.values.risk_thresholds if absent.
UPDATE system_settings_document
SET values = jsonb_set(
  values,
  '{risk_thresholds}',
  '{
    "stamp_spike_multiplier": 5,
    "stamp_spike_medium_min": 50,
    "stamp_spike_high_min": 200,
    "points_spike_multiplier": 5,
    "points_spike_medium_min": 500,
    "impossible_travel_kmh": 250,
    "gps_fail_burst_count": 15,
    "proof_rejections_count": 5,
    "report_target_medium_count": 3,
    "report_target_high_count": 6,
    "vote_burst_account_age_hours": 48,
    "vote_burst_min_accounts": 10,
    "admin_grant_large_points": 2000
  }'::jsonb,
  TRUE
)
WHERE id = 1 AND NOT (values ? 'risk_thresholds');
-- PGMEM_SKIP_END
