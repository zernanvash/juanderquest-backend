-- Plan 119: Persisted follow-suggestion dismissals and lookup indexes for people discovery.

CREATE TABLE IF NOT EXISTS user_suggestion_dismissals (
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dismissed_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, dismissed_user_id),
  CHECK (user_id <> dismissed_user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_suggestion_dismissals_user
  ON user_suggestion_dismissals (user_id, created_at DESC);

-- PGMEM_SKIP_BEGIN
-- People search (handle / display name only; never email).
CREATE INDEX IF NOT EXISTS idx_users_handle_trgm
  ON users USING gin (lower(handle) extensions.gin_trgm_ops) WHERE is_public = TRUE;
CREATE INDEX IF NOT EXISTS idx_users_display_name_trgm
  ON users USING gin (f_unaccent(lower(display_name)) extensions.gin_trgm_ops) WHERE is_public = TRUE;

CREATE INDEX IF NOT EXISTS idx_users_public_active_hometown
  ON users (is_test, lower(home_municipality))
  WHERE is_public = TRUE AND suspended_at IS NULL;
-- PGMEM_SKIP_END
