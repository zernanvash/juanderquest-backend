-- 102 (owner 2026-11-18): tell travelers when a new quest is published near
-- their home town. Additive: a preference column, a push category, an inbox
-- kind, and two small bookkeeping tables.

ALTER TABLE user_notification_preferences
  ADD COLUMN IF NOT EXISTS push_nearby_quest BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE push_deliveries DROP CONSTRAINT IF EXISTS push_deliveries_category_check;
ALTER TABLE push_deliveries ADD CONSTRAINT push_deliveries_category_check
  CHECK (category IN ('overtaken', 'friend_activity', 'social', 'weekly_recap', 'account', 'nearby_quest'));

-- Full list from 092 (the last migration to set it) plus 'nearby_quest'.
ALTER TABLE user_notifications DROP CONSTRAINT IF EXISTS user_notifications_kind_check;
ALTER TABLE user_notifications ADD CONSTRAINT user_notifications_kind_check CHECK (kind IN (
  'quest_funding','sponsorship','quest_reward',
  'follow','cheer','comment','overtaken','weekly_recap','weekly_champion',
  'chain_alert','spot_photo_approved','spot_moderation','nearby_quest'
));

-- One announcement per quest: only its first publish fans out.
CREATE TABLE IF NOT EXISTS nearby_quest_announcements (
  quest_id TEXT PRIMARY KEY,
  recipients INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Quests that were already live before this migration are not "new".
INSERT INTO nearby_quest_announcements (quest_id)
SELECT id FROM quests WHERE status <> 'draft'
ON CONFLICT (quest_id) DO NOTHING;

-- At most one nearby-quest push per traveler per Manila day.
CREATE TABLE IF NOT EXISTS nearby_quest_push_days (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  manila_day DATE NOT NULL,
  quest_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, manila_day)
);
