-- Migration 044: Durable Quest Step Evidence & Attempt State Contract
-- Adds immutable per-attempt step snapshot, verified step ledger, and
-- per-step evidence records for location, QR, photo, action, and quiz checkpoints.

DO $$ BEGIN
    CREATE TYPE quest_step_status AS ENUM (
        'not_started',
        'ready',
        'pending_review',
        'needs_changes',
        'verified',
        'skipped_optional'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE quest_attempts ADD COLUMN IF NOT EXISTS steps_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE quest_attempts ADD COLUMN IF NOT EXISTS verified_steps INT NOT NULL DEFAULT 0;
ALTER TABLE quest_attempts ADD COLUMN IF NOT EXISTS required_steps INT NOT NULL DEFAULT 1;
ALTER TABLE quest_attempts ADD COLUMN IF NOT EXISTS review_notes TEXT;
ALTER TABLE quest_attempts ADD COLUMN IF NOT EXISTS reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE quest_attempts ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS quest_step_evidence (
    id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL REFERENCES quest_attempts(id) ON DELETE CASCADE,
    quest_id TEXT NOT NULL REFERENCES quests(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    step_order INT NOT NULL,
    checkpoint_type TEXT NOT NULL,
    status quest_step_status NOT NULL DEFAULT 'not_started',
    required BOOLEAN NOT NULL DEFAULT true,
    title TEXT NOT NULL,
    description TEXT,
    idempotency_key TEXT,
    evidence_payload JSONB,
    rejection_reason TEXT,
    verified_at TIMESTAMPTZ,
    reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_attempt_step_order UNIQUE (attempt_id, step_order)
);

CREATE INDEX IF NOT EXISTS idx_step_evidence_user ON quest_step_evidence (user_id, status);
CREATE INDEX IF NOT EXISTS idx_step_evidence_attempt ON quest_step_evidence (attempt_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_step_evidence_idempotency ON quest_step_evidence (attempt_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
