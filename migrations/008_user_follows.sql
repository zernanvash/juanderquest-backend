-- Migration 008: Social Follow Graph (User Follows)
-- Alpha follow relationships: public-to-public only.
-- Supports idempotent follow/unfollow, visibility enforcement, and keyset cursor pagination.

CREATE TABLE IF NOT EXISTS user_follows (
  follower_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  following_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, following_id),
  CHECK (follower_id <> following_id)
);

CREATE INDEX IF NOT EXISTS user_follows_outgoing_page
  ON user_follows (follower_id, created_at DESC, following_id DESC);

CREATE INDEX IF NOT EXISTS user_follows_incoming_page
  ON user_follows (following_id, created_at DESC, follower_id DESC);
