-- Migration 014: Progression Hardening and Retrofits
-- Forward-only, transactional upgrade for databases that applied earlier revisions of Migration 013.
-- Safely applies additive columns, column type retrofits (BIGINT), safe-integer bounds checks,
-- and verified quest binding references without mutating migration history.

-- 1. Preflight: Read-only bounds check on existing progression_totals records.
-- Aborts migration if incompatible records exist without modifying or deleting data.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM progression_totals
        WHERE explorer_xp < 0 OR explorer_xp > 9007199254740991
           OR civic_xp < 0 OR civic_xp > 9007199254740991
           OR civic_stamps < 0 OR civic_stamps > 9007199254740991
        LIMIT 1
    ) THEN
        RAISE EXCEPTION 'Migration 014 aborted: progression_totals contains values outside JavaScript safe integer range [0, 9007199254740991]. Manual reconciliation required.';
    END IF;
END $$;

-- 2. Retrofit verified_visits with binding_id foreign key
-- Note: occurred_at in verified_visits represents submission creation/receipt time, not physical capture time.
ALTER TABLE verified_visits ADD COLUMN IF NOT EXISTS binding_id UUID REFERENCES reviewed_quest_spot_bindings(id);

-- 3. Retrofit achievement_awards with immutable criteria snapshot and versioning columns
ALTER TABLE achievement_awards ADD COLUMN IF NOT EXISTS evidence_version VARCHAR(50) NOT NULL DEFAULT 'v1';
ALTER TABLE achievement_awards ADD COLUMN IF NOT EXISTS criteria_version VARCHAR(50) NOT NULL DEFAULT 'v1';
ALTER TABLE achievement_awards ADD COLUMN IF NOT EXISTS criteria_snapshot JSONB NOT NULL DEFAULT '{}';

-- 4. Retrofit outbox_events with per-claim token UUID
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS claim_token UUID;

-- 5. Upgrade progression_totals columns to BIGINT for full JavaScript safe-integer support (9007199254740991)
ALTER TABLE progression_totals ALTER COLUMN civic_stamps TYPE BIGINT;
ALTER TABLE progression_totals ALTER COLUMN explorer_xp TYPE BIGINT;
ALTER TABLE progression_totals ALTER COLUMN civic_xp TYPE BIGINT;

-- 6. Enforce safe integer check constraints on progression_totals
ALTER TABLE progression_totals DROP CONSTRAINT IF EXISTS progression_totals_explorer_xp_check;
ALTER TABLE progression_totals DROP CONSTRAINT IF EXISTS progression_totals_civic_xp_check;
ALTER TABLE progression_totals DROP CONSTRAINT IF EXISTS progression_totals_civic_stamps_check;
ALTER TABLE progression_totals DROP CONSTRAINT IF EXISTS chk_progression_totals_explorer_xp;
ALTER TABLE progression_totals DROP CONSTRAINT IF EXISTS chk_progression_totals_civic_xp;
ALTER TABLE progression_totals DROP CONSTRAINT IF EXISTS chk_progression_totals_civic_stamps;

ALTER TABLE progression_totals ADD CONSTRAINT chk_progression_totals_explorer_xp CHECK (explorer_xp BETWEEN 0 AND 9007199254740991);
ALTER TABLE progression_totals ADD CONSTRAINT chk_progression_totals_civic_xp CHECK (civic_xp BETWEEN 0 AND 9007199254740991);
ALTER TABLE progression_totals ADD CONSTRAINT chk_progression_totals_civic_stamps CHECK (civic_stamps BETWEEN 0 AND 9007199254740991);
