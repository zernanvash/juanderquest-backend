-- Migration 036: Location-triggered Cultural Quizzes
-- Implements versioned cultural quizzes, questions/options, attempt tracking,
-- private server grading, and immutable completion scopes for Explorer XP.

DO $$ BEGIN
    CREATE TYPE cultural_quiz_status AS ENUM ('draft', 'published', 'paused', 'archived');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE cultural_quiz_attempt_status AS ENUM ('in_progress', 'passed', 'failed', 'abandoned', 'expired');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS cultural_quizzes (
    id TEXT PRIMARY KEY,
    destination_id TEXT NOT NULL REFERENCES spots(id) ON DELETE RESTRICT,
    reward_scope_id UUID NOT NULL UNIQUE,
    status cultural_quiz_status NOT NULL DEFAULT 'draft',
    current_version INT NOT NULL DEFAULT 1,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    is_test BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cultural_quizzes_destination ON cultural_quizzes(destination_id);
CREATE INDEX IF NOT EXISTS idx_cultural_quizzes_status ON cultural_quizzes(status);

CREATE TABLE IF NOT EXISTS cultural_quiz_versions (
    id TEXT PRIMARY KEY,
    quiz_id TEXT NOT NULL REFERENCES cultural_quizzes(id) ON DELETE CASCADE,
    version INT NOT NULL,
    title VARCHAR(200) NOT NULL,
    description TEXT NOT NULL,
    language VARCHAR(10) NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'fil', 'ilo', 'pag')),
    radius_meters INT NOT NULL DEFAULT 200 CHECK (radius_meters BETWEEN 100 AND 1000),
    xp_reward INT NOT NULL DEFAULT 25 CHECK (xp_reward > 0),
    time_limit_minutes INT NOT NULL DEFAULT 30 CHECK (time_limit_minutes BETWEEN 5 AND 120),
    cooldown_hours INT NOT NULL DEFAULT 24 CHECK (cooldown_hours BETWEEN 1 AND 168),
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    published_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_cultural_quiz_version UNIQUE (quiz_id, version)
);

CREATE INDEX IF NOT EXISTS idx_cultural_quiz_versions_quiz ON cultural_quiz_versions(quiz_id, version DESC);

CREATE TABLE IF NOT EXISTS cultural_quiz_questions (
    id TEXT PRIMARY KEY,
    version_id TEXT NOT NULL REFERENCES cultural_quiz_versions(id) ON DELETE CASCADE,
    ordinal INT NOT NULL CHECK (ordinal BETWEEN 1 AND 5),
    question_text TEXT NOT NULL,
    explanation TEXT NOT NULL,
    source_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_cultural_quiz_question_ordinal UNIQUE (version_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_cultural_quiz_questions_version ON cultural_quiz_questions(version_id, ordinal);

CREATE TABLE IF NOT EXISTS cultural_quiz_options (
    id TEXT PRIMARY KEY,
    question_id TEXT NOT NULL REFERENCES cultural_quiz_questions(id) ON DELETE CASCADE,
    ordinal INT NOT NULL CHECK (ordinal BETWEEN 1 AND 4),
    option_text TEXT NOT NULL,
    is_correct BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_cultural_quiz_option_ordinal UNIQUE (question_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_cultural_quiz_options_question ON cultural_quiz_options(question_id, ordinal);

CREATE TABLE IF NOT EXISTS cultural_quiz_attempts (
    id TEXT PRIMARY KEY,
    quiz_id TEXT NOT NULL REFERENCES cultural_quizzes(id) ON DELETE CASCADE,
    version_id TEXT NOT NULL REFERENCES cultural_quiz_versions(id) ON DELETE RESTRICT,
    reward_scope_id UUID NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status cultural_quiz_attempt_status NOT NULL DEFAULT 'in_progress',
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    score INT,
    total_questions INT NOT NULL DEFAULT 5,
    xp_awarded INT NOT NULL DEFAULT 0,
    location_validated BOOLEAN NOT NULL DEFAULT TRUE,
    distance_meters INT,
    idempotency_key TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_cultural_quiz_attempt_idempotency UNIQUE (user_id, quiz_id, idempotency_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_active_cultural_quiz_attempt 
    ON cultural_quiz_attempts (quiz_id, user_id) 
    WHERE status = 'in_progress';

CREATE INDEX IF NOT EXISTS idx_cultural_quiz_attempts_user 
    ON cultural_quiz_attempts (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cultural_quiz_attempts_quiz 
    ON cultural_quiz_attempts (quiz_id, status);

CREATE TABLE IF NOT EXISTS cultural_quiz_attempt_answers (
    attempt_id TEXT NOT NULL REFERENCES cultural_quiz_attempts(id) ON DELETE CASCADE,
    question_id TEXT NOT NULL REFERENCES cultural_quiz_questions(id) ON DELETE CASCADE,
    selected_option_id TEXT NOT NULL REFERENCES cultural_quiz_options(id) ON DELETE RESTRICT,
    is_correct BOOLEAN NOT NULL,
    answered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (attempt_id, question_id)
);

CREATE TABLE IF NOT EXISTS cultural_quiz_completions (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reward_scope_id UUID NOT NULL,
    progression_event_id UUID NOT NULL,
    completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, reward_scope_id)
);

CREATE INDEX IF NOT EXISTS idx_cultural_quiz_completions_user 
    ON cultural_quiz_completions (user_id);
