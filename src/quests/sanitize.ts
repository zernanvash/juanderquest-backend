import type { QuestRow, QuestStep, QuestAttemptRow } from '../db/index.js';

/** Hide QR secrets from traveler-facing quest projections and frozen attempts. */
export function sanitizeQuestSteps<T extends QuestStep>(steps: T[] | undefined): T[] {
  if (!Array.isArray(steps)) return [];
  return steps.map((step) => {
    const { marker_code: _markerCode, ...publicStep } = step as T & { marker_code?: string };
    return publicStep as T;
  });
}

export function sanitizeQuestForViewer<T extends QuestRow>(quest: T, canInspectMarker: boolean): T {
  if (canInspectMarker) return quest;
  const { marker_code: _markerCode, ...publicQuest } = quest;
  return { ...publicQuest, steps: sanitizeQuestSteps(quest.steps) } as T;
}

export function sanitizeAttemptSnapshot<T extends QuestAttemptRow>(attempt: T): T {
  return { ...attempt, steps_snapshot: sanitizeQuestSteps(attempt.steps_snapshot) };
}
