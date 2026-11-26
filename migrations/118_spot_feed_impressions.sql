-- Migration 118 (Plan 123b): track per-user daily destination feed impressions for Explore fatigue (R1).

CREATE TABLE IF NOT EXISTS spot_feed_impressions (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  spot_id TEXT NOT NULL REFERENCES spots(id) ON DELETE CASCADE,
  manila_day DATE NOT NULL,
  seen_count SMALLINT NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, spot_id, manila_day)
);

CREATE INDEX IF NOT EXISTS idx_spot_feed_impressions_day
  ON spot_feed_impressions (manila_day);

-- PGMEM_SKIP_BEGIN
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jdq_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE spot_feed_impressions TO jdq_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jdq_readonly') THEN
    GRANT SELECT ON TABLE spot_feed_impressions TO jdq_readonly;
  END IF;
END
$$;
-- PGMEM_SKIP_END
