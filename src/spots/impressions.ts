import type { Pool } from 'pg';
import { manilaDayKey } from './recommender.js';
import type { SpotStore } from './store.js';

const PRUNE_INTERVAL_MS = 3_600_000; // once per process per hour
let lastPruneAtMs = 0;

function shiftManilaDay(manilaDay: string, deltaDays: number): string {
  const baseMs = Date.parse(`${manilaDay}T00:00:00Z`);
  return new Date(baseMs + deltaDays * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Deletes spot_feed_impressions older than 14 days (both PG and in-memory).
 */
export async function pruneOldFeedImpressions(
  store: SpotStore,
  pool: Pool | null,
  manilaDay: string = manilaDayKey(),
): Promise<number> {
  const cutoffDay = shiftManilaDay(manilaDay, -14);
  store.pruneFeedImpressionsBefore(cutoffDay);
  if (!pool) return 0;
  try {
    const res = await pool.query(`DELETE FROM spot_feed_impressions WHERE manila_day < $1::date`, [cutoffDay]);
    return res.rowCount ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Records up to 30 published spot impressions for today (Manila day) with
 * seen_count = LEAST(seen_count + 1, 10), and prunes rows older than 14 days
 * once per process per hour.
 */
export async function recordSpotFeedImpressions(
  store: SpotStore,
  pool: Pool | null,
  userId: string,
  spotIds: string[],
  nowMs: number = Date.now(),
): Promise<number> {
  const publishedSet = new Set<string>();
  for (const s of store.spots) {
    if (s.status === 'published') publishedSet.add(s.id);
  }
  const uniqueValid: string[] = [];
  const seen = new Set<string>();
  for (const id of spotIds) {
    if (seen.has(id) || !publishedSet.has(id)) continue;
    seen.add(id);
    uniqueValid.push(id);
  }
  if (uniqueValid.length === 0) return 0;

  const manilaDay = manilaDayKey(nowMs);
  store.recordFeedImpressions(userId, uniqueValid, manilaDay);

  if (pool) {
    await pool.query(
      `INSERT INTO spot_feed_impressions (user_id, spot_id, manila_day, seen_count)
       SELECT $1, spot_id, $3::date, 1
       FROM UNNEST($2::text[]) AS t(spot_id)
       ON CONFLICT (user_id, spot_id, manila_day)
       DO UPDATE SET seen_count = LEAST(spot_feed_impressions.seen_count + 1, 10)`,
      [userId, uniqueValid, manilaDay],
    );
  }

  if (nowMs - lastPruneAtMs >= PRUNE_INTERVAL_MS) {
    lastPruneAtMs = nowMs;
    await pruneOldFeedImpressions(store, pool, manilaDay);
  }

  return uniqueValid.length;
}

/**
 * Loads distinct impression days in the 7 days strictly BEFORE `manilaDay`
 * once per (user, manilaDay) and caches on SpotStore so today's ranking and
 * state fingerprint remain stable across same-day impressions (R1).
 */
/** Caches one user's fatigue map for `manilaDay`, dropping maps from earlier days so the cache stays bounded. */
function cacheFatigueDays(store: SpotStore, userId: string, manilaDay: string, map: Map<string, number>): void {
  const suffix = `|${manilaDay}`;
  for (const key of store.feedImpressionDaysCache.keys()) {
    if (!key.endsWith(suffix)) store.feedImpressionDaysCache.delete(key);
  }
  store.feedImpressionDaysCache.set(`${userId}${suffix}`, map);
}

export async function loadUserFatigueDays(
  store: SpotStore,
  pool: Pool | null,
  userId: string | undefined,
  manilaDay: string = manilaDayKey(),
): Promise<Map<string, number>> {
  if (!userId) return new Map();
  const cacheKey = `${userId}|${manilaDay}`;
  const cached = store.feedImpressionDaysCache.get(cacheKey);
  if (cached) return cached;

  if (!pool) {
    const computed = store.computeFatigueDaysFromMemory(userId, manilaDay);
    cacheFatigueDays(store, userId, manilaDay, computed);
    return computed;
  }

  const startDay = shiftManilaDay(manilaDay, -7);
  try {
    const { rows } = await pool.query<{ spot_id: string; days: number }>(
      `SELECT spot_id, COUNT(DISTINCT manila_day)::int AS days
       FROM spot_feed_impressions
       WHERE user_id = $1
         AND manila_day >= $2::date
         AND manila_day < $3::date
       GROUP BY spot_id`,
      [userId, startDay, manilaDay],
    );
    const map = new Map<string, number>();
    for (const r of rows) {
      map.set(String(r.spot_id), Number(r.days) || 0);
    }
    cacheFatigueDays(store, userId, manilaDay, map);
    return map;
  } catch {
    const computed = store.computeFatigueDaysFromMemory(userId, manilaDay);
    cacheFatigueDays(store, userId, manilaDay, computed);
    return computed;
  }
}

export function resetImpressionPruneTimerForTest(): void {
  lastPruneAtMs = 0;
}
