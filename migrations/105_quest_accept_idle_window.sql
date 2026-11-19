-- 105 (owner team review 2026-11-19): an accepted quest expires when the traveler makes no
-- progress for `quest_accept_idle_hours` (admin setting, default 72). The clock starts at
-- acceptance and resets on every completed or submitted task. Expired acceptances are kept
-- (status 'expired'), their reserved funding is released, and the traveler may re-accept.

DO $$ BEGIN
    ALTER TYPE quest_attempt_status ADD VALUE IF NOT EXISTS 'expired';
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- Existing in-progress acceptances get a fresh window from the moment this migration runs.
ALTER TABLE quest_attempts
  ADD COLUMN IF NOT EXISTS last_progress_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS expired_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_quest_attempts_idle
  ON quest_attempts (last_progress_at) WHERE status = 'in_progress';

-- Full list from 103 (the last migration to set it) plus 'quest_idle'.
ALTER TABLE user_notifications DROP CONSTRAINT IF EXISTS user_notifications_kind_check;
ALTER TABLE user_notifications ADD CONSTRAINT user_notifications_kind_check CHECK (kind IN (
  'quest_funding','sponsorship','quest_reward',
  'follow','cheer','comment','overtaken','weekly_recap','weekly_champion',
  'chain_alert','spot_photo_approved','spot_moderation','nearby_quest','suki_reward','quest_idle'
));
