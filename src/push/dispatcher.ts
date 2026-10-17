import { getPool } from '../db/pool.js';
import type { Queryable } from '../social/activity.js';
import { env } from '../config/env.js';
import { sendToTokens, MulticastPayload, SendResult } from './fcm.js';
import { getUserPreferences, checkDailyCaps } from './enqueue.js';

export const PLAZA_PUSH_DISPATCHER_LOCK_KEY = 410043;

export interface DispatchOptions {
  limit?: number;
  fcmSender?: (tokens: string[], payload: MulticastPayload) => Promise<SendResult>;
  now?: Date;
}

export interface DispatchSummary {
  claimed: number;
  sent: number;
  skipped: number;
  failed: number;
}

function formatBatchedContent(row: any): { title: string; body: string } {
  if (Number(row.batch_count) <= 1) {
    return { title: row.title, body: row.body };
  }

  let names: string[] = [];
  try {
    names = typeof row.batch_names === 'string'
      ? JSON.parse(row.batch_names)
      : Array.isArray(row.batch_names)
      ? row.batch_names
      : [];
  } catch {
    names = [];
  }

  const firstActor = names[0] || 'Someone';
  const othersCount = Math.max(1, Number(row.batch_count) - 1);

  if (row.category === 'friend_activity') {
    return {
      title: `${firstActor} is exploring`,
      body: `${firstActor} and ${othersCount} other${othersCount > 1 ? 's' : ''} completed quests. See what's new.`,
    };
  }

  if (row.category === 'social') {
    return {
      title: 'Plaza activity',
      body: `${firstActor} and ${othersCount} other${othersCount > 1 ? 's' : ''} cheered or commented.`,
    };
  }

  return { title: row.title, body: row.body };
}

/**
 * Dispatches due queued push notifications.
 * Implements atomic claim with SKIP LOCKED (falling back gracefully for pg-mem).
 */
export async function dispatchDuePushes(
  client: Queryable,
  options: DispatchOptions = {},
): Promise<DispatchSummary> {
  const limit = options.limit ?? 100;
  const fcm = options.fcmSender ?? sendToTokens;
  const now = options.now ?? new Date();

  let claimedRows: any[] = [];

  // Try PostgreSQL atomic claim with SKIP LOCKED
  try {
    const claimRes = await client.query(
      `UPDATE push_deliveries
          SET status = 'sending', attempts = attempts + 1
        WHERE id IN (
          SELECT id
            FROM push_deliveries
           WHERE status = 'queued' AND send_after <= NOW()
           ORDER BY send_after ASC
           LIMIT $1
           FOR UPDATE SKIP LOCKED
        )
       RETURNING *`,
      [limit],
    );
    claimedRows = claimRes.rows;
  } catch (err: any) {
    // Fallback for pg-mem or engines lacking FOR UPDATE SKIP LOCKED
    try {
      const selectRes = await client.query(
        `SELECT id
           FROM push_deliveries
          WHERE status = 'queued' AND send_after <= NOW()
          ORDER BY send_after ASC
          LIMIT $1`,
        [limit],
      );

      if (selectRes.rows.length > 0) {
        const ids = selectRes.rows.map((r: any) => r.id);
        const placeholders = ids.map((_: string, i: number) => `$${i + 1}`).join(', ');
        const upRes = await client.query(
          `UPDATE push_deliveries
              SET status = 'sending', attempts = attempts + 1
            WHERE id IN (${placeholders})
           RETURNING *`,
          ids,
        );
        claimedRows = upRes.rows;
      }
    } catch (innerErr) {
      console.error('[dispatcher] failed to claim queued pushes:', innerErr);
      return { claimed: 0, sent: 0, skipped: 0, failed: 0 };
    }
  }

  const summary: DispatchSummary = {
    claimed: claimedRows.length,
    sent: 0,
    skipped: 0,
    failed: 0,
  };

  for (const row of claimedRows) {
    // 1. Re-check preferences
    const prefs = await getUserPreferences(client, row.user_id);
    const categoryAllowed =
      row.category === 'overtaken'
        ? prefs.push_overtaken
        : row.category === 'friend_activity'
        ? prefs.push_friend_activity
        : row.category === 'social'
        ? prefs.push_social
        : prefs.push_weekly_recap;

    if (!categoryAllowed) {
      await client.query(
        "UPDATE push_deliveries SET status = 'skipped', skip_reason = 'PREF_OFF' WHERE id = $1",
        [row.id],
      );
      summary.skipped++;
      continue;
    }

    // 2. Re-check daily caps
    const { totalSent, countsByCategory } = await checkDailyCaps(client, row.user_id, now);
    const catSent = countsByCategory[row.category] || 0;
    const overCap =
      totalSent >= 6 ||
      (row.category === 'overtaken' && catSent >= 1) ||
      (row.category === 'friend_activity' && catSent >= 2) ||
      (row.category === 'social' && catSent >= 4);

    if (overCap) {
      await client.query(
        "UPDATE push_deliveries SET status = 'skipped', skip_reason = 'CAP_REACHED' WHERE id = $1",
        [row.id],
      );
      summary.skipped++;
      continue;
    }

    // 3. Load active user devices
    const devRes = await client.query(
      'SELECT token FROM user_devices WHERE user_id = $1 AND disabled_at IS NULL',
      [row.user_id],
    );

    const tokens = devRes.rows.map((r: any) => r.token);
    if (!tokens.length) {
      await client.query(
        "UPDATE push_deliveries SET status = 'skipped', skip_reason = 'NO_DEVICE' WHERE id = $1",
        [row.id],
      );
      summary.skipped++;
      continue;
    }

    // 4. Send via FCM
    const { title, body } = formatBatchedContent(row);
    const channelId =
      row.category === 'overtaken'
        ? 'plaza_competition'
        : row.category === 'friend_activity'
        ? 'plaza_friends'
        : row.category === 'social'
        ? 'plaza_social'
        : 'plaza_recap';

    const sendRes = await fcm(tokens, {
      title,
      body,
      data: {
        href: row.href,
        category: row.category,
        notification_id: row.notification_id || '',
      },
      channelId,
      collapseKey: row.collapse_key,
    });

    // Disable unregistered tokens
    if (sendRes.unregisteredTokens.length > 0) {
      for (const tok of sendRes.unregisteredTokens) {
        await client.query(
          `UPDATE user_devices
              SET disabled_at = NOW(), disabled_reason = 'unregistered'
            WHERE token = $1`,
          [tok],
        );
      }
    }

    if (sendRes.successCount > 0) {
      await client.query(
        "UPDATE push_deliveries SET status = 'sent', sent_at = NOW() WHERE id = $1",
        [row.id],
      );
      summary.sent++;
    } else {
      if (Number(row.attempts) >= 5) {
        await client.query(
          "UPDATE push_deliveries SET status = 'failed', last_error = $1 WHERE id = $2",
          [sendRes.transientError || 'All tokens failed', row.id],
        );
        summary.failed++;
      } else {
        const delayMinutes = Math.pow(2, Number(row.attempts));
        await client.query(
          `UPDATE push_deliveries
              SET status = 'queued',
                  send_after = NOW() + ($1 * INTERVAL '1 minute'),
                  last_error = $2
            WHERE id = $3`,
          [delayMinutes, sendRes.transientError || 'Transient error', row.id],
        );
      }
    }
  }

  return summary;
}

let dispatcherTimer: NodeJS.Timeout | null = null;
let isDispatching = false;

export async function runPushDispatcherTick(): Promise<void> {
  if (isDispatching) return;
  const pool = getPool();
  if (!pool) return;

  const client = await pool.connect();
  let locked = false;
  try {
    const lockRes = await client.query('SELECT pg_try_advisory_lock($1) AS acquired', [
      PLAZA_PUSH_DISPATCHER_LOCK_KEY,
    ]);
    locked = Boolean(lockRes.rows[0]?.acquired);
    if (!locked) return;

    isDispatching = true;
    await dispatchDuePushes(client);
  } catch (err) {
    console.error('[dispatcher:tick] Error executing push dispatch:', err);
  } finally {
    isDispatching = false;
    if (locked) {
      await client.query('SELECT pg_advisory_unlock($1)', [PLAZA_PUSH_DISPATCHER_LOCK_KEY]).catch(() => {});
    }
    client.release();
  }
}

export function startPushDispatcher(): void {
  if (dispatcherTimer) return;
  if (!env.PUSH_ENABLED) {
    console.log('[dispatcher] PUSH_ENABLED is false; dispatcher dormant');
    return;
  }

  const intervalMs = env.PUSH_DISPATCH_INTERVAL_MS || 30000;
  dispatcherTimer = setInterval(() => {
    void runPushDispatcherTick();
  }, intervalMs);

  console.log(`[dispatcher] Push dispatcher started (interval: ${intervalMs} ms)`);
}

export function stopPushDispatcher(): void {
  if (dispatcherTimer) {
    clearInterval(dispatcherTimer);
    dispatcherTimer = null;
    console.log('[dispatcher] Push dispatcher stopped');
  }
}
