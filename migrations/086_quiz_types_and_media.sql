-- Migration 086: Cultural Quiz Question Types & Media (Plan 91b)
-- Additive-only extension ensuring question_type (4 canonical types), media_url,
-- nullable selected_option_id, and submitted_payload JSONB for sequence_order answers.

ALTER TABLE cultural_quiz_questions
    ADD COLUMN IF NOT EXISTS question_type VARCHAR(30) NOT NULL DEFAULT 'multiple_choice',
    ADD COLUMN IF NOT EXISTS media_url TEXT NULL;

UPDATE cultural_quiz_questions
SET question_type = CASE question_type
    WHEN 'picture' THEN 'photo_clue'
    WHEN 'order' THEN 'sequence_order'
    WHEN 'map_drop' THEN 'multiple_choice'
    ELSE question_type
END
WHERE question_type IN ('picture', 'order', 'map_drop');

ALTER TABLE cultural_quiz_questions
    DROP CONSTRAINT IF EXISTS cultural_quiz_questions_question_type_check;

ALTER TABLE cultural_quiz_questions
    ADD CONSTRAINT cultural_quiz_questions_question_type_check
    CHECK (question_type IN ('multiple_choice', 'true_false', 'photo_clue', 'sequence_order'));

ALTER TABLE cultural_quiz_attempt_answers
    ALTER COLUMN selected_option_id DROP NOT NULL;

ALTER TABLE cultural_quiz_attempt_answers
    ADD COLUMN IF NOT EXISTS submitted_payload JSONB NULL;

ALTER TABLE cultural_quiz_attempt_answers
    DROP CONSTRAINT IF EXISTS chk_cultural_quiz_attempt_answer_payload;

ALTER TABLE cultural_quiz_attempt_answers
    ADD CONSTRAINT chk_cultural_quiz_attempt_answer_payload
    CHECK (selected_option_id IS NOT NULL OR submitted_payload IS NOT NULL);
