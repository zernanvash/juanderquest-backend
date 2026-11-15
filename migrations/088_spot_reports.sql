-- 088 (Plan 92b): spot reports survive restarts and admins can resolve them.
-- The reason list matches SpotReportReason in src/spots/field-logs.ts.
CREATE TABLE IF NOT EXISTS spot_reports (
  id TEXT PRIMARY KEY,
  spot_id TEXT NOT NULL REFERENCES spots(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  reporter_name VARCHAR(80) NOT NULL DEFAULT 'Anonymous Scout',
  reason VARCHAR(40) NOT NULL CHECK (reason IN ('inaccurate_location','site_closed_or_hazard','misleading_photo','spam_or_scam','environmental_concern','other')),
  details TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','reviewed','dismissed')),
  resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  resolution_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_spot_reports_spot ON spot_reports(spot_id);
CREATE INDEX IF NOT EXISTS idx_spot_reports_status_created ON spot_reports(status, created_at DESC);
