import type { Pool } from 'pg';
import { getPool } from '../db/pool.js';
import { distanceMeters } from '../maps/geometry.js';
import { enqueuePush } from '../push/enqueue.js';
import { canonicalSettings } from '../settings/schema.js';
import { runIsolatedProducer, type Queryable } from './activity.js';
import { notify } from './notify.js';
import { MANILA_OFFSET_MS } from './time.js';

/** Travelers whose home-town centre is within this distance of the quest pin hear about it. */
export const NEARBY_QUEST_RADIUS_METERS = 10_000;
const MAX_RECIPIENTS = 2000;

export interface NearbyQuest {
  id: string;
  title: string;
  location_name?: string | null;
  gps_lat: number;
  gps_lng: number;
  author_id?: string | null;
  is_test?: boolean;
}

function manilaDay(now: Date): string {
  return new Date(now.getTime() + MANILA_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Owner 2026-11-18: when a quest is published for the first time, add an inbox
 * notification for travelers whose home town is nearby, and push at most one
 * of them per traveler per Manila day. Quiet hours defer the push (enqueuePush).
 * Returns the number of travelers notified. Safe to call on every publish: the
 * announcement row makes later publishes of the same quest a no-op.
 */
export async function announceNearbyQuest(client: Queryable, quest: NearbyQuest, now = new Date()): Promise<number> {
  if (quest.is_test || !Number.isFinite(quest.gps_lat) || !Number.isFinite(quest.gps_lng)) return 0;

  const stored = await client.query(
    `SELECT q.is_test AS quest_test, u.is_test AS author_test
       FROM (SELECT 1) one
       LEFT JOIN quests q ON q.id = $1
       LEFT JOIN users u ON u.id = $2`,
    [quest.id, quest.author_id ?? null],
  );
  if (stored.rows[0]?.quest_test || stored.rows[0]?.author_test) return 0;

  const settings = await client.query('SELECT values FROM system_settings_document WHERE id=1');
  if (canonicalSettings(settings.rows[0]?.values ?? {}).nearby_quest_push_enabled !== true) return 0;

  const claim = await client.query(
    'INSERT INTO nearby_quest_announcements (quest_id) VALUES ($1) ON CONFLICT (quest_id) DO NOTHING RETURNING quest_id',
    [quest.id],
  );
  if (!claim.rows.length) return 0;

  const towns = await client.query(`SELECT name, label_lat, label_lng FROM admin_areas WHERE level = 'town'`);
  const nearbyTowns = new Set<string>();
  for (const town of towns.rows) {
    const lat = Number(town.label_lat);
    const lng = Number(town.label_lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (distanceMeters(quest.gps_lat, quest.gps_lng, lat, lng) <= NEARBY_QUEST_RADIUS_METERS) {
      nearbyTowns.add(String(town.name).trim().toLowerCase());
    }
  }
  if (!nearbyTowns.size) return 0;

  const recipients = await client.query(
    `SELECT u.id, u.home_municipality
       FROM users u
       LEFT JOIN user_notification_preferences p ON p.user_id = u.id
      WHERE lower(trim(u.home_municipality)) = ANY($1::text[])
        AND u.is_test = FALSE
        AND u.id IS DISTINCT FROM $2
        AND COALESCE(p.push_nearby_quest, TRUE) = TRUE
      ORDER BY u.id
      LIMIT ${MAX_RECIPIENTS}`,
    [[...nearbyTowns], quest.author_id ?? null],
  );

  const day = manilaDay(now);
  const where = quest.location_name?.trim();
  const message = where ? `${quest.title} at ${where}. Tap to take a look.` : `${quest.title}. Tap to take a look.`;
  const href = `/quests/${encodeURIComponent(quest.id)}`;
  let notified = 0;

  for (const row of recipients.rows) {
    await runIsolatedProducer(client, '[nearby-quest] Failed to notify a traveler:', async () => {
      const title = `New quest near ${row.home_municipality}`;
      const notificationId = await notify(client, {
        userId: row.id,
        kind: 'nearby_quest',
        eventKey: `nearby_quest:${quest.id}`,
        title,
        message,
        href,
        isTest: false,
      });
      if (!notificationId) return;
      notified++;
      const slot = await client.query(
        `INSERT INTO nearby_quest_push_days (user_id, manila_day, quest_id) VALUES ($1, $2::date, $3)
         ON CONFLICT (user_id, manila_day) DO NOTHING RETURNING user_id`,
        [row.id, day, quest.id],
      );
      if (!slot.rows.length) return;
      await enqueuePush(
        client,
        {
          userId: row.id,
          category: 'nearby_quest',
          collapseKey: `nearby_quest:${row.id}:${day}`,
          notificationId,
          title,
          body: message,
          href,
          isTest: false,
        },
        now,
      );
    });
  }

  await client.query('UPDATE nearby_quest_announcements SET recipients = $2 WHERE quest_id = $1', [quest.id, notified]);
  return notified;
}

/** Runs the announcement in its own transaction, separate from the publish request. */
export async function runNearbyQuestAnnouncement(pool: Pool, quest: NearbyQuest, now = new Date()): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const notified = await announceNearbyQuest(client, quest, now);
    await client.query('COMMIT');
    return notified;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const pending = new Set<Promise<unknown>>();

/**
 * Called after a quest is published and saved. Runs in the background; a
 * failure is logged and never affects the publish response.
 */
export function scheduleNearbyQuestAnnouncement(quest: NearbyQuest): void {
  const pool = getPool();
  if (!pool || quest.is_test) return;
  const snapshot = { ...quest };
  const job = new Promise<void>((resolve) => setImmediate(resolve))
    .then(() => runNearbyQuestAnnouncement(pool, snapshot))
    .catch((error) => console.error('[nearby-quest] announcement failed:', error))
    .finally(() => pending.delete(job));
  pending.add(job);
}

/** Test helper: waits for scheduled announcements to finish. */
export async function waitForNearbyQuestAnnouncements(): Promise<void> {
  while (pending.size) await Promise.all([...pending]);
}
