/**
 * Plan 56 phase 1: drafts save anything; publishing needs these. Returns the
 * missing items (empty = ready to publish).
 */
export type PublishChecklistItem = 'title' | 'description';

export const PUBLISH_MIN_TITLE = 5;
export const PUBLISH_MIN_DESCRIPTION = 15;

export function publishChecklist(quest: {
  title?: string | null;
  description?: string | null;
}): PublishChecklistItem[] {
  const missing: PublishChecklistItem[] = [];
  if ((quest.title ?? '').trim().length < PUBLISH_MIN_TITLE) missing.push('title');
  if ((quest.description ?? '').trim().length < PUBLISH_MIN_DESCRIPTION) missing.push('description');
  return missing;
}

export function publishChecklistError(missing: PublishChecklistItem[]) {
  return {
    success: false,
    error: {
      code: 'PUBLISH_CHECKLIST',
      message: `Finish these before publishing: ${missing.join(', ')}.`,
      missing,
    },
  };
}
