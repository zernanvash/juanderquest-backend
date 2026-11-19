-- 107 (v0.3.10 team review): profile pictures go live instantly; viewers can
-- report one. One report per viewer per picture; admins reset or dismiss.
CREATE TABLE IF NOT EXISTS avatar_reports (
  avatar_url TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (reason IN ('inappropriate','impersonation','spam','other')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','reset','dismissed')),
  resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (avatar_url, reporter_id)
);
CREATE INDEX IF NOT EXISTS idx_avatar_reports_status ON avatar_reports(status, created_at DESC);
