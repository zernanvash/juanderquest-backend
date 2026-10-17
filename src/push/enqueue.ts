import type { Queryable } from '../social/activity.js';

export { Queryable };

export interface EnqueueFriendActivityInput {
  id: string;
  actor_id: string;
  verb: string;
  subject_title: string;
  is_test: boolean;
}

/**
 * Phase 1 stub for friend push notifications.
 * Full batching, follower fan-out (capped at 500), and FCM delivery
 * will be completed in Phase 4 per Plan 41 §8.3.
 */
export async function enqueueFriendActivityPush(
  _client: Queryable,
  _activity: EnqueueFriendActivityInput,
): Promise<void> {
  // Phase 1 stub: no-op until Phase 4 push dispatcher and batching queue land
}
