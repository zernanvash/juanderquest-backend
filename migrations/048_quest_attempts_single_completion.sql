-- A traveler may receive completion rewards only once per quest, regardless
-- of whether completion came through an approved submission or reviewed attempt.
-- Fail closed if historical duplicates exist; reconcile them before deploying.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM quest_attempts
    WHERE status = 'completed'
    GROUP BY user_id, quest_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Migration 048 blocked: duplicate completed quest attempts exist; reconcile before retrying';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_quest_attempts_single_completion
  ON quest_attempts (user_id, quest_id)
  WHERE status = 'completed';
