-- Migration 026: Progressive Destination-Author Quest Slice
-- Adds author ownership tracking, status lifecycle, ordered steps, and server-owned attempts.

DO $$ BEGIN
    CREATE TYPE quest_status AS ENUM ('draft', 'published', 'paused', 'archived');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE quests ADD COLUMN IF NOT EXISTS author_id TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE quests ADD COLUMN IF NOT EXISTS status quest_status NOT NULL DEFAULT 'published';
ALTER TABLE quests ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1;
ALTER TABLE quests ADD COLUMN IF NOT EXISTS steps JSONB NOT NULL DEFAULT '[]'::jsonb;

DO $$ BEGIN
    CREATE TYPE quest_attempt_status AS ENUM ('in_progress', 'submitted', 'completed', 'abandoned');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS quest_attempts (
    id TEXT PRIMARY KEY,
    quest_id TEXT NOT NULL REFERENCES quests(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    version INT NOT NULL DEFAULT 1,
    current_step INT NOT NULL DEFAULT 1,
    total_steps INT NOT NULL DEFAULT 1,
    status quest_attempt_status NOT NULL DEFAULT 'in_progress',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_active_quest_attempt ON quest_attempts (quest_id, user_id) WHERE status = 'in_progress';
CREATE INDEX IF NOT EXISTS idx_quest_attempts_user ON quest_attempts (user_id, status);
CREATE INDEX IF NOT EXISTS idx_quests_status ON quests (status);
CREATE INDEX IF NOT EXISTS idx_quests_author ON quests (author_id);
