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
 */
export async function enqueueFriendActivityPush(
  _client: Queryable,
  _activity: EnqueueFriendActivityInput,
): Promise<void> {
  // Phase 1 stub: no-op until Phase 4 push dispatcher and batching queue land
}

export interface EnqueuePushInput {
  userId: string;
  category: 'overtaken' | 'friend_activity' | 'social' | 'weekly_recap';
  collapseKey: string;
  notificationId?: string | null;
  title: string;
  body: string;
  href: string;
  actorName?: string;
  isTest: boolean;
}

export async function enqueuePush(
  _client: Queryable,
  _input: EnqueuePushInput,
): Promise<void> {
  // Phase 1/2 stub: full batching, quiet hours, and FCM queue land in Phase 4
}
