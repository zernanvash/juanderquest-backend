CREATE TABLE IF NOT EXISTS user_notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL CHECK (length(event_key) BETWEEN 1 AND 240),
  kind TEXT NOT NULL CHECK (kind IN ('quest_funding', 'sponsorship', 'quest_reward')),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 500),
  href TEXT NOT NULL CHECK (href LIKE '/%' AND href NOT LIKE '//%' AND length(href) <= 500),
  is_test BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  read_at TIMESTAMPTZ,
  CONSTRAINT uq_user_notifications_event UNIQUE (user_id, event_key)
);

CREATE INDEX IF NOT EXISTS idx_user_notifications_owner_created
  ON user_notifications (user_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_user_notifications_unread
  ON user_notifications (user_id, created_at DESC, id DESC)
  WHERE read_at IS NULL;
