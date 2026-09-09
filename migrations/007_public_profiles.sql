-- Migration 007: Public User Profiles and Privacy Controls
-- Adds visibility flag, unique handle, bio, and status text to users.
-- Default visibility is FALSE (private by default) to preserve privacy.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS handle VARCHAR(50) UNIQUE,
  ADD COLUMN IF NOT EXISTS bio TEXT,
  ADD COLUMN IF NOT EXISTS status_text VARCHAR(120);

CREATE INDEX IF NOT EXISTS idx_users_is_public ON users(is_public);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_lower_handle ON users(LOWER(handle)) WHERE handle IS NOT NULL;
