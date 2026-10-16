-- Migration 046: Guarantee a single pending proof per traveler and quest.
-- Deterministically reject stale duplicates before enforcing the partial index.

UPDATE submissions AS submission
SET status = 'rejected',
    rejection_reason = 'system: duplicate of an approved submission (QA 2026-10-16)',
    reviewed_at = NOW(),
    updated_at = NOW()
WHERE submission.status = 'pending'
  AND EXISTS (
    SELECT 1
    FROM submissions AS approved
    WHERE approved.user_id = submission.user_id
      AND approved.quest_id = submission.quest_id
      AND approved.status = 'approved'
  );

UPDATE submissions AS submission
SET status = 'rejected',
    rejection_reason = 'system: superseded by a newer pending submission (QA 2026-10-16)',
    reviewed_at = NOW(),
    updated_at = NOW()
WHERE submission.status = 'pending'
  AND EXISTS (
    SELECT 1
    FROM submissions AS newer
    WHERE newer.user_id = submission.user_id
      AND newer.quest_id = submission.quest_id
      AND newer.status = 'pending'
      AND (newer.created_at, newer.id) > (submission.created_at, submission.id)
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_submissions_unique_pending
  ON submissions(user_id, quest_id)
  WHERE status = 'pending';
