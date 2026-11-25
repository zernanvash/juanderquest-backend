-- Removes exactly what seed.sql added. Refuses if travelers already played the seeded content.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM cultural_quiz_attempts WHERE quiz_id LIKE 'seed-r1-quiz-%')
     OR EXISTS (SELECT 1 FROM quest_attempts WHERE quest_id LIKE '%-seedr1') THEN
    RAISE EXCEPTION 'seeded content already has attempts; archive instead of deleting';
  END IF;
END $$;
UPDATE spots SET quest_id = NULL, updated_at = NOW() WHERE quest_id LIKE '%-seedr1';
DELETE FROM reviewed_quest_spot_bindings WHERE quest_id LIKE '%-seedr1';
DELETE FROM quests WHERE id LIKE '%-seedr1';
DELETE FROM question_of_the_day WHERE question_id LIKE 'qotd-r1-%';
DELETE FROM qotd_questions WHERE id LIKE 'qotd-r1-%';
DELETE FROM cultural_quizzes WHERE id LIKE 'seed-r1-quiz-%';
COMMIT;
