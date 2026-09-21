-- Forward repair for databases that recorded an early version of migration 013.
-- Abort before changing constraints if old logical-award duplicates need reconciliation.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM progression_events a
    JOIN progression_events b
      ON a.user_id = b.user_id
     AND a.source_type = b.source_type
     AND a.source_id = b.source_id
     AND a.award_kind = b.award_kind
     AND a.id <> b.id
    LIMIT 1
  ) THEN
    RAISE EXCEPTION 'Migration 015: duplicate logical progression awards require manual reconciliation';
  END IF;
END $$;

-- The original constraint included rule_version. The application uses a logical
-- proof key independent of that version.
ALTER TABLE progression_events DROP CONSTRAINT IF EXISTS uq_progression_events_source;
ALTER TABLE progression_events ADD CONSTRAINT uq_progression_events_source
  UNIQUE (user_id, source_type, source_id, award_kind);

-- The original table-level uniqueness blocked multiple archived bindings.
ALTER TABLE reviewed_quest_spot_bindings DROP CONSTRAINT IF EXISTS uq_quest_binding_status;
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_active_quest_binding
  ON reviewed_quest_spot_bindings (quest_id) WHERE status = 'active';

-- Change the default for future accounts only. Historical reputation is evidence
-- requiring separate review and is deliberately left untouched.
ALTER TABLE users ALTER COLUMN scout_reputation SET DEFAULT 0;

INSERT INTO municipalities (id, name, type, district) VALUES
  ('basista', 'Basista', 'municipality', 2),
  ('binmaley', 'Binmaley', 'municipality', 2)
ON CONFLICT (id) DO NOTHING;
