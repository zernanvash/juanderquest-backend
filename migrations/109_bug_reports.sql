CREATE TABLE IF NOT EXISTS bug_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_code TEXT NOT NULL UNIQUE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  category TEXT NOT NULL CHECK (category IN ('crash', 'auth', 'map', 'ar', 'quests', 'ui', 'other')),
  summary TEXT NOT NULL,
  description TEXT NOT NULL,
  app_version TEXT,
  device_info TEXT,
  contact_email TEXT,
  page_url TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'triaged', 'resolved', 'wont_fix')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bug_reports_status_created
  ON bug_reports (status, created_at DESC);
