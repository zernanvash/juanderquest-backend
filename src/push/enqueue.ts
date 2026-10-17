import { randomUUID } from 'crypto';
import type { Queryable } from '../social/activity.js';
import { manilaHour, next0800ManilaUtc, manilaDayStartUtc } from '../social/time.js';

export { Queryable };

export interface EnqueueFriendActivityInput {
  id: string;
  actor_id: string;
  verb: string;
  subject_title: string;
  is_test: boolean;
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

export interface UserNotificationPreferences {
  push_overtaken: boolean;
  push_friend_activity: boolean;
  push_social: boolean;
  push_weekly_recap: boolean;
  quiet_hours: boolean;
}

const DEFAULT_PREFERENCES: UserNotificationPreferences = {
  push_overtaken: true,
  push_friend_activity: true,
  push_social: true,
  push_weekly_recap: true,
  quiet_hours: true,
};

export async function getUserPreferences(
  client: Queryable,
  userId: string,
): Promise<UserNotificationPreferences> {
  const res = await client.query(
    `SELECT push_overtaken, push_friend_activity, push_social, push_weekly_recap, quiet_hours
       FROM user_notification_preferences
      WHERE user_id = $1`,
    [userId],
  );

  if (!res.rows.length) {
    return { ...DEFAULT_PREFERENCES };
  }

  const row = res.rows[0];
  return {
    push_overtaken: Boolean(row.push_overtaken),
    push_friend_activity: Boolean(row.push_friend_activity),
    push_social: Boolean(row.push_social),
    push_weekly_recap: Boolean(row.push_weekly_recap),
    quiet_hours: Boolean(row.quiet_hours),
  };
}

export async function checkDailyCaps(
  client: Queryable,
  userId: string,
  now: Date,
): Promise<{ totalSent: number; countsByCategory: Record<string, number> }> {
  const dayStart = manilaDayStartUtc(now);
  const res = await client.query(
    `SELECT category, COUNT(*)::int AS cnt
       FROM push_deliveries
      WHERE user_id = $1 AND status = 'sent' AND sent_at >= $2
      GROUP BY category`,
    [userId, dayStart],
  );

  let totalSent = 0;
  const countsByCategory: Record<string, number> = {
    overtaken: 0,
    friend_activity: 0,
    social: 0,
    weekly_recap: 0,
  };

  for (const r of res.rows) {
    const c = Number(r.cnt || 0);
    countsByCategory[r.category] = c;
    totalSent += c;
  }

  return { totalSent, countsByCategory };
}

/**
 * Enqueues a push delivery, applying user preferences, caps, quiet hours deferral, and collapse batching.
 */
export async function enqueuePush(
  client: Queryable,
  input: EnqueuePushInput,
  overrideNow?: Date,
): Promise<string> {
  const now = overrideNow || new Date();
  const pushId = `push_${randomUUID()}`;

  // 1. Preference check
  const prefs = await getUserPreferences(client, input.userId);
  const categoryAllowed =
    input.category === 'overtaken'
      ? prefs.push_overtaken
      : input.category === 'friend_activity'
      ? prefs.push_friend_activity
      : input.category === 'social'
      ? prefs.push_social
      : prefs.push_weekly_recap;

  if (!categoryAllowed) {
    await client.query(
      `INSERT INTO push_deliveries (
         id, user_id, category, collapse_key, notification_id,
         title, body, href, batch_count, batch_names,
         status, skip_reason, send_after, is_test
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, 'skipped', 'PREF_OFF', $10, $11)`,
      [
        pushId,
        input.userId,
        input.category,
        input.collapseKey,
        input.notificationId ?? null,
        input.title.slice(0, 120),
        input.body.slice(0, 240),
        input.href,
        JSON.stringify(input.actorName ? [input.actorName] : []),
        now,
        Boolean(input.isTest),
      ],
    );
    return pushId;
  }

  // 2. Cap check
  const { totalSent, countsByCategory } = await checkDailyCaps(client, input.userId, now);
  const catSent = countsByCategory[input.category] || 0;

  const isOverCap =
    totalSent >= 6 ||
    (input.category === 'overtaken' && catSent >= 1) ||
    (input.category === 'friend_activity' && catSent >= 2) ||
    (input.category === 'social' && catSent >= 4);

  if (isOverCap) {
    await client.query(
      `INSERT INTO push_deliveries (
         id, user_id, category, collapse_key, notification_id,
         title, body, href, batch_count, batch_names,
         status, skip_reason, send_after, is_test
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, 'skipped', 'CAP_REACHED', $10, $11)`,
      [
        pushId,
        input.userId,
        input.category,
        input.collapseKey,
        input.notificationId ?? null,
        input.title.slice(0, 120),
        input.body.slice(0, 240),
        input.href,
        JSON.stringify(input.actorName ? [input.actorName] : []),
        now,
        Boolean(input.isTest),
      ],
    );
    return pushId;
  }

  // 3. Quiet hours check
  let sendAfter = now;
  if (prefs.quiet_hours) {
    const hour = manilaHour(now);
    if (hour >= 21 || hour < 8) {
      sendAfter = next0800ManilaUtc(now);
    }
  }

  // 4. Collapse batching upsert on open collapse key
  const existingRes = await client.query(
    `SELECT id, batch_count, batch_names
       FROM push_deliveries
      WHERE user_id = $1 AND collapse_key = $2 AND status = 'queued'`,
    [input.userId, input.collapseKey],
  );

  if (existingRes.rows.length > 0) {
    const existing = existingRes.rows[0];
    let names: string[] = [];
    try {
      names = typeof existing.batch_names === 'string'
        ? JSON.parse(existing.batch_names)
        : Array.isArray(existing.batch_names)
        ? existing.batch_names
        : [];
    } catch {
      names = [];
    }

    if (input.actorName && names.length < 5 && !names.includes(input.actorName)) {
      names.push(input.actorName);
    }

    await client.query(
      `UPDATE push_deliveries
          SET batch_count = batch_count + 1,
              batch_names = $1
        WHERE id = $2`,
      [JSON.stringify(names), existing.id],
    );

    return existing.id;
  }

  // Insert newly queued push
  const names = input.actorName ? [input.actorName] : [];
  await client.query(
    `INSERT INTO push_deliveries (
       id, user_id, category, collapse_key, notification_id,
       title, body, href, batch_count, batch_names,
       status, send_after, is_test
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, 'queued', $10, $11)`,
    [
      pushId,
      input.userId,
      input.category,
      input.collapseKey,
      input.notificationId ?? null,
      input.title.slice(0, 120),
      input.body.slice(0, 240),
      input.href,
      JSON.stringify(names),
      sendAfter,
      Boolean(input.isTest),
    ],
  );

  return pushId;
}

/**
 * Enqueues friend activity push notifications to followers of the actor.
 * Caps fan-out at 500 followers per activity.
 */
export async function enqueueFriendActivityPush(
  client: Queryable,
  activity: EnqueueFriendActivityInput,
  overrideNow?: Date,
): Promise<void> {
  const actorRes = await client.query(
    'SELECT display_name, is_public FROM users WHERE id = $1',
    [activity.actor_id],
  );
  const actor = actorRes.rows[0];
  const actorName = actor && actor.is_public ? actor.display_name : 'Someone';

  const followersRes = await client.query(
    `SELECT uf.follower_id
       FROM user_follows uf
       JOIN users u ON u.id = uf.follower_id
       LEFT JOIN user_notification_preferences p ON p.user_id = uf.follower_id
      WHERE uf.following_id = $1
        AND u.is_test = $2
        AND COALESCE(p.push_friend_activity, TRUE) = TRUE
      LIMIT 501`,
    [activity.actor_id, Boolean(activity.is_test)],
  );

  const rows = followersRes.rows;
  if (rows.length > 500) {
    console.warn(`[push:friend] Fan-out truncated at 500 followers for activity ${activity.id}`);
  }
  const followers = rows.slice(0, 500);

  const now = overrideNow || new Date();
  const epochMinutes = Math.floor(now.getTime() / (60 * 1000));
  const bucket30 = Math.floor(epochMinutes / 30);

  for (const f of followers) {
    const collapseKey = `friend:${f.follower_id}:${bucket30}`;
    await enqueuePush(
      client,
      {
        userId: f.follower_id,
        category: 'friend_activity',
        collapseKey,
        notificationId: null, // push only, no inbox row
        title: `${actorName} is exploring`,
        body: `${actorName} completed ${activity.subject_title}. Your turn?`,
        href: '/plaza',
        actorName,
        isTest: activity.is_test,
      },
      now,
    );
  }
}
