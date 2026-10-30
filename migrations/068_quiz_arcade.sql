-- Migration 068: Cultural Quiz Arcade Phase 2 Data Model
-- Extends cultural quizzes with new question types (multiple_choice, true_false, picture, order, map_drop),
-- media/hints/rounds, server-only answer payloads, version host lines & themes,
-- and attempt lifelines (50/50, ask_local, skip) & style scoring.

ALTER TABLE cultural_quiz_questions
    ADD COLUMN IF NOT EXISTS question_type VARCHAR(50) NOT NULL DEFAULT 'multiple_choice'
        CHECK (question_type IN ('multiple_choice', 'true_false', 'picture', 'order', 'map_drop')),
    ADD COLUMN IF NOT EXISTS media_url TEXT NULL,
    ADD COLUMN IF NOT EXISTS hint TEXT NULL,
    ADD COLUMN IF NOT EXISTS round VARCHAR(50) NOT NULL DEFAULT 'main'
        CHECK (round IN ('main', 'special', 'lightning')),
    ADD COLUMN IF NOT EXISTS answer_payload JSONB NULL;

ALTER TABLE cultural_quiz_versions
    ADD COLUMN IF NOT EXISTS host_lines JSONB NULL,
    ADD COLUMN IF NOT EXISTS theme VARCHAR(50) NOT NULL DEFAULT 'crt';

ALTER TABLE cultural_quiz_attempts
    ADD COLUMN IF NOT EXISTS lifelines_used TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS style_score INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS streak_max INT NOT NULL DEFAULT 0;
