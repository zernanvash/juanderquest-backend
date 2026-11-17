-- 096 (Plan 102): traveler photo submissions for existing destinations, with admin approval.
CREATE TABLE IF NOT EXISTS spot_photo_submissions (
  id TEXT PRIMARY KEY,
  spot_id TEXT NOT NULL REFERENCES spots(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES spot_assets(id) ON DELETE CASCADE,
  caption VARCHAR(240),
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  reject_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_spot_photo_submissions_pending
  ON spot_photo_submissions (user_id, spot_id, asset_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_spot_photo_submissions_status_created
  ON spot_photo_submissions (status, created_at DESC);

ALTER TABLE user_notifications DROP CONSTRAINT IF EXISTS user_notifications_kind_check;
ALTER TABLE user_notifications ADD CONSTRAINT user_notifications_kind_check CHECK (kind IN (
  'quest_funding','sponsorship','quest_reward',
  'follow','cheer','comment','overtaken','weekly_recap','weekly_champion',
  'chain_alert','spot_photo_approved'
));
