-- Plan 59: area-scoped LGU administrators.
-- Keep this enum change first; no statement in this migration uses the new value.
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'area_admin';

CREATE TABLE IF NOT EXISTS admin_area_assignments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  area_id TEXT NOT NULL REFERENCES admin_areas(id),
  powers TEXT[] NOT NULL CHECK (
    powers <@ ARRAY['destinations','quests_quizzes','merchants_vouchers','analytics']::text[]
    AND cardinality(powers) > 0
  ),
  granted_by TEXT NOT NULL REFERENCES users(id),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  UNIQUE (user_id, area_id)
);
CREATE INDEX IF NOT EXISTS idx_admin_area_assignments_user_active
  ON admin_area_assignments(user_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES users(id),
  actor_role TEXT NOT NULL,
  area_id TEXT REFERENCES admin_areas(id),
  action TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  before JSONB,
  after JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created ON admin_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_subject ON admin_audit_log(subject_type, subject_id, created_at DESC);

ALTER TABLE merchants ADD COLUMN IF NOT EXISTS town_area_id TEXT REFERENCES admin_areas(id);
CREATE INDEX IF NOT EXISTS idx_merchants_town_area ON merchants(town_area_id);

-- Backfill only where municipality and the province named in location identify
-- exactly one town. Ambiguous or incomplete location strings remain unassigned.
WITH candidates AS (
  SELECT m.id AS merchant_id, a.id AS area_id,
         COUNT(*) OVER (PARTITION BY m.id) AS match_count
  FROM merchants m
  JOIN admin_areas town ON town.level = 'town'
    AND lower(regexp_replace(trim(town.name), '\s+', ' ', 'g')) =
        lower(regexp_replace(trim(m.municipality), '\s+', ' ', 'g'))
  JOIN admin_areas province ON province.level = 'province' AND town.parent_id = province.id
    AND position(lower(trim(province.name)) IN lower(m.location)) > 0
  JOIN admin_areas a ON a.id = town.id
  WHERE m.town_area_id IS NULL AND NULLIF(trim(m.municipality), '') IS NOT NULL
)
UPDATE merchants m SET town_area_id = c.area_id
FROM candidates c
WHERE m.id = c.merchant_id AND c.match_count = 1;
