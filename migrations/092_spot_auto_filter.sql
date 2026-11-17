-- 092 (Plan 60): keeps 'spot_photo_approved' from 096 (live before 092 runs).
-- 092 (Plan 60): destination auto-filter moderation events, spot hold/hide statuses, weighted reports, and author notifications.

CREATE TABLE IF NOT EXISTS spot_moderation_events (
  id TEXT PRIMARY KEY,
  spot_id TEXT NOT NULL REFERENCES spots(id) ON DELETE CASCADE,
  actor TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('published', 'held', 'hidden_pending_review', 'appealed', 'removed', 'kept_hidden')),
  reason_codes TEXT[] NOT NULL DEFAULT '{}',
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_spot_moderation_events_spot
  ON spot_moderation_events(spot_id, created_at DESC);

ALTER TABLE spots DROP CONSTRAINT IF EXISTS chk_spots_status;
ALTER TABLE spots DROP CONSTRAINT IF EXISTS spots_status_check;
ALTER TABLE spots ADD CONSTRAINT chk_spots_status
  CHECK (status IN (
    'published',
    'needs_review',
    'unpublished',
    'approved',
    'pending',
    'rejected',
    'archived',
    'held',
    'hidden_pending_review'
  ));

ALTER TABLE spot_reports ADD COLUMN IF NOT EXISTS weight INT NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_spot_reports_spot_user ON spot_reports(spot_id, user_id);

ALTER TABLE user_notifications DROP CONSTRAINT IF EXISTS user_notifications_kind_check;
ALTER TABLE user_notifications ADD CONSTRAINT user_notifications_kind_check CHECK (kind IN (
  'quest_funding','sponsorship','quest_reward',
  'follow','cheer','comment','overtaken','weekly_recap','weekly_champion',
  'chain_alert','spot_photo_approved','spot_moderation'
));
