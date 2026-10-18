import { randomUUID } from 'crypto';
import { runIsolatedProducer, type Queryable } from './activity.js';
import { enqueuePush } from '../push/enqueue.js';

export type NotificationKind =
  | 'follow'
  | 'cheer'
  | 'comment'
  | 'overtaken'
  | 'weekly_recap'
  | 'weekly_champion';

export interface NotifyInput {
  userId: string;
  kind: NotificationKind;
  eventKey: string;
  title: string;
  message: string;
  href: string;
  isTest: boolean;
  push?: {
    category: 'overtaken' | 'social' | 'weekly_recap';
    collapseKey: string;
    actorName?: string;
  };
}

/**
 * Creates an in-app user notification and optionally enqueues a push delivery.
 * Deduplicated atomically via UNIQUE (user_id, event_key).
 */
export async function notify(client: Queryable, input: NotifyInput): Promise<string | null> {
  const notifId = `notif_${randomUUID()}`;
  const title = input.title.trim().slice(0, 120);
  const message = input.message.trim().slice(0, 500);

  const res = await client.query(
    `INSERT INTO user_notifications (
       id, user_id, event_key, kind, title, message, href, is_test
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (user_id, event_key) DO NOTHING
     RETURNING id`,
    [
      notifId,
      input.userId,
      input.eventKey,
      input.kind,
      title,
      input.message,
      input.href,
      Boolean(input.isTest),
    ],
  );

  if (!res.rows.length || res.rows[0].id !== notifId) {
    return null;
  }

  if (input.push) {
    await runIsolatedProducer(client, '[notify:push] Failed to enqueue push:', async () => {
      await enqueuePush(client, {
        userId: input.userId,
        category: input.push.category,
        collapseKey: input.push.collapseKey,
        notificationId: notifId,
        title,
        body: message.slice(0, 240),
        href: input.href,
        actorName: input.push.actorName,
        isTest: input.isTest,
      });
    });
  }

  return notifId;
}
