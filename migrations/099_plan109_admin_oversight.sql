-- Plan 109: Admin funding oversight, crowd monitoring indexes, destination/quest controls, and crowd-suggestion dismissals.

ALTER TABLE quest_funding_plans
  ADD COLUMN IF NOT EXISTS holds_paused BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS holds_paused_reason TEXT,
  ADD COLUMN IF NOT EXISTS holds_paused_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS admin_flagged BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS admin_flag_note TEXT,
  ADD COLUMN IF NOT EXISTS admin_flagged_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS admin_flagged_by TEXT REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE merchants
  ADD COLUMN IF NOT EXISTS sponsoring_suspended BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS sponsoring_suspended_reason TEXT,
  ADD COLUMN IF NOT EXISTS sponsoring_suspended_at TIMESTAMPTZ;

ALTER TABLE quests
  ADD COLUMN IF NOT EXISTS is_featured BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE spots
  ADD COLUMN IF NOT EXISTS recommendation_suppressed_until TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS crowd_suggestion_dismissals (
  spot_id TEXT NOT NULL REFERENCES spots(id) ON DELETE CASCADE,
  suggestion_key TEXT NOT NULL,
  dismissed_until TIMESTAMPTZ NOT NULL,
  dismissed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (spot_id, suggestion_key)
);

CREATE INDEX IF NOT EXISTS idx_verified_visits_spot_occurred ON verified_visits (spot_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_spot_activity_events_created ON spot_activity_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quest_attempts_quest_created ON quest_attempts (quest_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trail_checkins_verified ON trail_checkins (verified_at DESC);
