import type { MemoryDb } from '../db/index.js';

export interface QuestCompletionQuery {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<{ completed: boolean }> }>;
}

/**
 * The canonical repeat-completion check. A quest is complete through either
 * the legacy proof flow or the progressive-attempt review flow.
 */
export async function hasCompletedQuest(
  db: Pick<MemoryDb, 'hasCompletedQuest'>,
  userId: string,
  questId: string,
  queryable?: QuestCompletionQuery | null,
  excludeApprovedSubmissionId?: string,
): Promise<boolean> {
  if (!queryable) {
    return db.hasCompletedQuest(userId, questId, excludeApprovedSubmissionId);
  }

  const result = await queryable.query(
    `SELECT (
       EXISTS (SELECT 1 FROM submissions WHERE user_id = $1 AND quest_id = $2 AND status = 'approved'
         AND ($3::text IS NULL OR id <> $3))
       OR EXISTS (SELECT 1 FROM quest_attempts WHERE user_id = $1 AND quest_id = $2 AND status = 'completed')
     ) AS completed`,
    [userId, questId, excludeApprovedSubmissionId ?? null],
  );
  return result.rows[0]?.completed === true;
}
