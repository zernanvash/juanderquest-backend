-- Plan 41: inbox kinds for social, device tokens, push queue, preferences

CREATE TABLE IF NOT EXISTS user_notifications (            -- identical shape to 051
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL CHECK (length(event_key) BETWEEN 1 AND 240),
  kind TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 500),
  href TEXT NOT NULL CHECK (href LIKE '/%' AND href NOT LIKE '//%' AND length(href) <= 500),
  is_test BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  read_at TIMESTAMPTZ,
  CONSTRAINT uq_user_notifications_event UNIQUE (user_id, event_key)
);
CREATE INDEX IF NOT EXISTS idx_user_notifications_owner_created ON user_notifications (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_user_notifications_unread ON user_notifications (user_id, created_at DESC, id DESC) WHERE read_at IS NULL;

-- Widen the kind list (funding kinds kept, social kinds added).
ALTER TABLE user_notifications DROP CONSTRAINT IF EXISTS user_notifications_kind_check;
ALTER TABLE user_notifications ADD CONSTRAINT user_notifications_kind_check CHECK (kind IN (
  'quest_funding','sponsorship','quest_reward',
  'follow','cheer','comment','overtaken','weekly_recap','weekly_champion'));

CREATE TABLE IF NOT EXISTS user_devices (
  id TEXT PRIMARY KEY,                                   -- 'dev_' || uuid
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE CHECK (length(token) BETWEEN 20 AND 4096),
  platform TEXT NOT NULL CHECK (platform IN ('android')),
  app_build INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  disabled_at TIMESTAMPTZ,
  disabled_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_user_devices_user ON user_devices (user_id) WHERE disabled_at IS NULL;

CREATE TABLE IF NOT EXISTS user_notification_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  push_overtaken BOOLEAN NOT NULL DEFAULT TRUE,
  push_friend_activity BOOLEAN NOT NULL DEFAULT TRUE,
  push_social BOOLEAN NOT NULL DEFAULT TRUE,             -- follow / cheer / comment
  push_weekly_recap BOOLEAN NOT NULL DEFAULT TRUE,
  quiet_hours BOOLEAN NOT NULL DEFAULT TRUE,             -- 21:00–08:00 Manila
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS push_deliveries (
  id TEXT PRIMARY KEY,                                   -- 'push_' || uuid
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('overtaken','friend_activity','social','weekly_recap')),
  collapse_key TEXT NOT NULL CHECK (length(collapse_key) BETWEEN 1 AND 240),   -- batching key (§8.3)
  notification_id TEXT REFERENCES user_notifications(id) ON DELETE SET NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 240),
  href TEXT NOT NULL CHECK (href LIKE '/%' AND href NOT LIKE '//%' AND length(href) <= 300),
  batch_count INTEGER NOT NULL DEFAULT 1 CHECK (batch_count >= 1),
  batch_names JSONB NOT NULL DEFAULT '[]'::jsonb,        -- display names merged into this push (max 5 stored)
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','skipped','failed')),
  skip_reason TEXT,
  send_after TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  is_test BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_push_open_collapse ON push_deliveries (user_id, collapse_key) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_push_due ON push_deliveries (send_after) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_push_user_day ON push_deliveries (user_id, category, sent_at) WHERE status = 'sent';
