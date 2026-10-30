import type { QuestRow, QuestStep, QuestAttemptRow } from '../db/index.js';

/** Hide QR secrets from traveler-facing quest projections and frozen attempts. */
export function sanitizeQuestSteps<T extends QuestStep>(steps: T[] | undefined): T[] {
  if (!Array.isArray(steps)) return [];
  return steps.map((step) => {
    const { marker_code: _markerCode, ...publicStep } = step as any;
    if (publicStep.verification && publicStep.verification.type === 'qr') {
      const { marker_code: _qrCode, ...publicVerification } = publicStep.verification;
      publicStep.verification = publicVerification;
    }
    return publicStep as T;
  });
}

export function sanitizeQuestForViewer<T extends QuestRow>(quest: T, canInspectMarker: boolean): T {
  if (canInspectMarker) return quest;
  const { marker_code: _markerCode, ...publicQuest } = quest;
  return { ...publicQuest, steps: sanitizeQuestSteps(quest.steps) } as T;
}

export function sanitizeAttemptSnapshot<T extends QuestAttemptRow>(attempt: T): T {
  const snapshot = sanitizeQuestSteps(attempt.steps_snapshot);
  // Step evidence rows carry status only; clients also need each task's public settings (QR scan mode,
  // AR object, in-app task) to show the right action, so copy them from the frozen snapshot (no markers).
  const rows = (attempt as { steps?: unknown }).steps;
  if (!Array.isArray(rows) || snapshot.length === 0) return { ...attempt, steps_snapshot: snapshot };
  const steps = rows.map((row: any) => {
    if (row?.verification) return row;
    const def: any = snapshot.find((item: any) =>
      (row?.task_key && item.key === row.task_key) || (item.step_order ?? item.order) === row?.step_order);
    return def?.verification ? { ...row, verification: def.verification } : row;
  });
  return { ...attempt, steps_snapshot: snapshot, steps } as T;
}
