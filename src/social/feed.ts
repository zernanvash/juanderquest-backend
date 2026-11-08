import { getPool } from '../db/pool.js';
import { spotStore } from '../spots/store.js';
import type { ActivityVerb, Queryable } from './activity.js';
import { getHomeTown } from './homeTown.js';
import { computeHomeTowns } from './standings.js';
import { MANILA_OFFSET_MS, weekId } from './time.js';

export { Queryable };

export class PlazaError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'PlazaError';
  }
}

export type ActivityReason = 'you' | 'following' | 'nearby' | 'rival' | 'saved_spot';

export interface ActivityItem {
  id: string;
  verb: ActivityVerb;
  actor: {
    user_id: string;
    display_name: string;
    handle: string | null;
    avatar_url: string | null;
    is_following: boolean;
  };
  subject: {
    type: string;
    id: string;
    title: string;
    href: string;
  };
  municipality: string | null;
  payload: Record<string, unknown>;
  reason: ActivityReason;
  reason_label?: string;
  cheer_count: number;
  cheered_by_me: boolean;
  comment_count: number;
  can_hide: boolean;
  created_at: string;
}

export interface GetFeedInput {
  viewerId?: string | null;
  isTest: boolean;
  cursor?: string | null;
  limit?: number;
  scope?: 'mixed' | 'following' | 'town';
  now?: Date;
}

export interface GetFeedResult {
  items: ActivityItem[];
  next_cursor: string | null;
  reason?: string;
}

function parseCursor(cursor?: string | null): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const delimiterIndex = decoded.indexOf('|');
    if (delimiterIndex === -1) {
      throw new Error('Missing delimiter');
    }
    const timeStr = decoded.slice(0, delimiterIndex);
    const id = decoded.slice(delimiterIndex + 1);
    if (!timeStr || !id) {
      throw new Error('Empty cursor field');
    }
    const createdAt = new Date(timeStr);
    if (isNaN(createdAt.getTime())) {
      throw new Error('Invalid cursor timestamp');
    }
    return { createdAt, id };
  } catch {
    throw new PlazaError('INVALID_CURSOR', 400, 'Invalid pagination cursor.');
  }
}

const VERB_WEIGHTS: Record<string, number> = {
  weekly_champion: 1.8,
  town_completed: 1.8,
  spot_posted: 1.6,
  first_photo: 1.6,
  trail_completed: 1.4,
  quest_completed: 1.4,
  rank_top10: 1.2,
  badge_earned: 1.2,
  streak_milestone: 1.2,
  quiz_aced: 1.0,
  level_up: 1.0,
  juanchoice_voted: 0.75,
};

interface ViewerPlazaContext {
  viewerHomeTown: string | null;
  topAffinityTowns: Set<string>;
  savedOrLikedSpotIds: Set<string>;
  topCategories: Set<string>;
  rivalRanksByUserId: Map<string, number>;
}

function mapActivityRow(
  row: any,
  viewerId: string | null,
  ctx?: ViewerPlazaContext,
): ActivityItem {
  const isSelf = Boolean(viewerId && viewerId === row.actor_id);
  const viaFollow = Boolean(row.via_follow);
  const rivalRank = !isSelf && !viaFollow ? ctx?.rivalRanksByUserId.get(row.actor_id) : undefined;
  const isSavedSpot =
    !isSelf &&
    !viaFollow &&
    rivalRank === undefined &&
    row.subject_type === 'spot' &&
    Boolean(ctx?.savedOrLikedSpotIds.has(row.subject_id));

  let reason: ActivityReason;
  let reason_label: string | undefined;
  if (isSelf) {
    reason = 'you';
    reason_label = 'You';
  } else if (viaFollow) {
    reason = 'following';
    reason_label = 'Following';
  } else if (rivalRank !== undefined) {
    reason = 'rival';
    reason_label = `Rival · #${rivalRank} This Week`;
  } else if (isSavedSpot) {
    reason = 'saved_spot';
    reason_label = 'At a spot you saved';
  } else {
    reason = 'nearby';
    if (row.municipality) {
      reason_label = `In ${row.municipality}`;
    }
  }

  let parsedPayload: Record<string, unknown> = {};
  if (row.payload) {
    if (typeof row.payload === 'string') {
      try {
        parsedPayload = JSON.parse(row.payload);
      } catch {
        parsedPayload = {};
      }
    } else if (typeof row.payload === 'object') {
      parsedPayload = row.payload as Record<string, unknown>;
    }
  }

  return {
    id: row.id,
    verb: row.verb as ActivityVerb,
    actor: {
      user_id: row.actor_id,
      display_name: row.display_name,
      handle: row.handle ?? null,
      avatar_url: row.avatar_url ?? null,
      is_following: viaFollow,
    },
    subject: {
      type: row.subject_type,
      id: row.subject_id,
      title: row.subject_title,
      href: row.subject_href,
    },
    municipality: row.municipality ?? null,
    payload: parsedPayload,
    reason,
    ...(reason_label ? { reason_label } : {}),
    cheer_count: Number(row.cheer_count || 0),
    cheered_by_me: Boolean(row.cheered_by_me),
    comment_count: Number(row.comment_count || 0),
    can_hide: isSelf,
    created_at: new Date(row.created_at).toISOString(),
  };
}

async function resolveViewerHomeTown(
  queryable: Queryable,
  viewerId: string,
  isTest: boolean,
): Promise<string | null> {
  try {
    const homeTowns = await computeHomeTowns(queryable, isTest);
    const fromBoard = homeTowns.get(viewerId);
    if (fromBoard) return fromBoard;
  } catch {
    // Fallback to direct lookup
  }
  try {
    const direct = await getHomeTown(viewerId);
    if (direct) return direct;
  } catch {
    // Ignore
  }
  try {
    const { rows } = await queryable.query(
      'SELECT home_municipality FROM users WHERE id = $1',
      [viewerId],
    );
    return (rows[0]?.home_municipality as string | null) ?? null;
  } catch {
    return null;
  }
}

async function buildViewerPlazaContext(
  queryable: Queryable,
  viewerId: string | null,
  isTest: boolean,
  now: Date,
): Promise<ViewerPlazaContext> {
  const topAffinityTowns = new Set<string>();
  const savedOrLikedSpotIds = new Set<string>();
  const topCategories = new Set<string>();
  const rivalRanksByUserId = new Map<string, number>();

  if (!viewerId) {
    return {
      viewerHomeTown: null,
      topAffinityTowns,
      savedOrLikedSpotIds,
      topCategories,
      rivalRanksByUserId,
    };
  }

  const viewerHomeTown = await resolveViewerHomeTown(queryable, viewerId, isTest);

  // In-memory spotStore interactions & preferences
  const memInteractions = spotStore.interactions.get(viewerId);
  const catCounts = new Map<string, number>();
  const townCounts = new Map<string, number>();
  const spotById = new Map(spotStore.spots.map((s) => [s.id, s]));

  if (memInteractions) {
    for (const entry of memInteractions) {
      const sep = entry.lastIndexOf(':');
      if (sep <= 0) continue;
      const sId = entry.slice(0, sep);
      const iType = entry.slice(sep + 1);
      if (iType === 'save' || iType === 'like' || iType === 'visit') {
        savedOrLikedSpotIds.add(sId);
        const spot = spotById.get(sId);
        if (spot) {
          catCounts.set(spot.category, (catCounts.get(spot.category) ?? 0) + 2);
          townCounts.set(spot.municipality, (townCounts.get(spot.municipality) ?? 0) + 2);
        }
      }
    }
  }

  const prefs = spotStore.preferences.get(viewerId);
  if (prefs?.categories) {
    for (const c of prefs.categories) {
      catCounts.set(c, (catCounts.get(c) ?? 0) + 2.5);
    }
  }

  // DB spot_interactions
  try {
    const siRes = await queryable.query(
      `SELECT si.spot_id, s.category, s.municipality
         FROM spot_interactions si
         LEFT JOIN spots s ON s.id = si.spot_id
        WHERE si.user_id = $1
          AND si.interaction_type IN ('save', 'like', 'visit')`,
      [viewerId],
    );
    for (const r of siRes.rows) {
      savedOrLikedSpotIds.add(r.spot_id);
      if (r.category) catCounts.set(r.category, (catCounts.get(r.category) ?? 0) + 2);
      if (r.municipality) townCounts.set(r.municipality, (townCounts.get(r.municipality) ?? 0) + 2);
    }
  } catch {
    // Ignore if table empty
  }

  // When home_municipality is NULL, fall back to top-affinity towns for the +0.30 boost
  if (!viewerHomeTown) {
    try {
      const subRes = await queryable.query(
        `SELECT COALESCE(s.municipality, q.location_name) AS municipality,
                COUNT(*)::int AS count
           FROM submissions sub
           JOIN quests q ON q.id = sub.quest_id
           LEFT JOIN reviewed_quest_spot_bindings b ON b.quest_id = q.id AND b.status = 'active'
           LEFT JOIN spots s ON s.id = b.spot_id
          WHERE sub.user_id = $1
            AND sub.status = 'approved'
          GROUP BY COALESCE(s.municipality, q.location_name)
          ORDER BY count DESC, municipality ASC
          LIMIT 3`,
        [viewerId],
      );
      for (const r of subRes.rows) {
        if (r.municipality) {
          townCounts.set(r.municipality, (townCounts.get(r.municipality) ?? 0) + Number(r.count) * 3);
        }
      }
    } catch {
      // Ignore
    }

    const sortedTowns = [...townCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 2)
      .map(([t]) => t);
    for (const t of sortedTowns) topAffinityTowns.add(t);
  }

  const sortedCats = [...catCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 2)
    .map(([c]) => c);
  for (const c of sortedCats) topCategories.add(c);

  // Weekly Leaderboard Rivals (+/- 3 ranks of viewer on weekly everyone board)
  try {
    const currentWeekId = weekId(now);
    const snapRes = await queryable.query(
      `SELECT user_id, rank
         FROM standings_snapshots
        WHERE period = $1
          AND board = 'everyone'
          AND is_test = $2`,
      [currentWeekId, isTest],
    );
    const mySnap = snapRes.rows.find((r: any) => r.user_id === viewerId);
    if (mySnap) {
      for (const r of snapRes.rows) {
        if (r.user_id !== viewerId && Math.abs(Number(r.rank) - Number(mySnap.rank)) <= 3) {
          rivalRanksByUserId.set(r.user_id, Number(r.rank));
        }
      }
    }
  } catch {
    // Ignore if snapshot not populated
  }

  return {
    viewerHomeTown,
    topAffinityTowns,
    savedOrLikedSpotIds,
    topCategories,
    rivalRanksByUserId,
  };
}

export function rankPlazaCandidateRows(
  rows: any[],
  viewerId: string | null,
  ctx: ViewerPlazaContext,
  nowMs: number = Date.now(),
): ActivityItem[] {
  if (rows.length === 0) return [];

  const spotCategoryById = new Map<string, string>();
  for (const s of spotStore.spots) {
    spotCategoryById.set(s.id, s.category);
  }

  // Track same-actor + same-verb within 10 minutes for deduplication penalty
  const seenActorVerbTimestamps = new Map<string, number[]>();

  interface ScoredCandidate {
    item: ActivityItem;
    baseScore: number;
    createdAtMs: number;
  }

  const candidates: ScoredCandidate[] = rows.map((row) => {
    const item = mapActivityRow(row, viewerId, ctx);
    const createdAtMs = new Date(row.created_at).getTime();
    const ageHours = Math.max(0, (nowMs - createdAtMs) / 3_600_000);
    const ageMinutes = ageHours * 60;

    // 1. Actor Affinity
    let actorAffinity = 1.0;
    const isSelf = Boolean(viewerId && row.actor_id === viewerId);
    const isMutual = Boolean(row.is_mutual_follow);
    const viaFollow = Boolean(row.via_follow);
    const isRival = ctx.rivalRanksByUserId.has(row.actor_id);
    const sameHomeTown = Boolean(
      ctx.viewerHomeTown &&
        row.actor_home_municipality &&
        row.actor_home_municipality.toLowerCase() === ctx.viewerHomeTown.toLowerCase(),
    );

    if (isSelf) {
      actorAffinity = ageMinutes <= 30 ? 2.2 : 1.1;
    } else if (isMutual) {
      actorAffinity = 2.5;
    } else if (viaFollow) {
      actorAffinity = 2.0;
    } else if (isRival) {
      actorAffinity = 1.65;
    } else if (sameHomeTown) {
      actorAffinity = 1.35;
    }

    // 2. Verb Weight
    const verbWeight = VERB_WEIGHTS[row.verb] ?? 1.0;

    // 3. Subject & Town Affinity
    let subjectAffinity = 1.0;
    if (row.subject_type === 'spot' && ctx.savedOrLikedSpotIds.has(row.subject_id)) {
      subjectAffinity += 0.4;
    }
    if (row.municipality) {
      const muniLower = String(row.municipality).toLowerCase();
      const matchesHome =
        ctx.viewerHomeTown !== null && ctx.viewerHomeTown.toLowerCase() === muniLower;
      const matchesFallbackAffinity =
        ctx.viewerHomeTown === null &&
        [...ctx.topAffinityTowns].some((t) => t.toLowerCase() === muniLower);
      if (matchesHome || matchesFallbackAffinity) {
        subjectAffinity += 0.3;
      }
    }
    if (row.subject_type === 'spot') {
      const cat = row.spot_category || spotCategoryById.get(row.subject_id);
      if (cat && ctx.topCategories.has(cat)) {
        subjectAffinity += 0.2;
      }
    }

    // 4. Engagement Velocity
    const cheers = Number(row.cheer_count || 0);
    const comments = Number(row.comment_count || 0);
    const engagementFactor = 1 + 0.18 * Math.log(1 + cheers + 2 * comments);

    // 5. Gravity Time Decay
    const gravityDecay = Math.pow(ageHours + 2, 1.35);

    // 10-minute same-actor + same-verb burst penalty
    const avKey = `${row.actor_id}:${row.verb}`;
    const prevTimes = seenActorVerbTimestamps.get(avKey) ?? [];
    const hasRecentSameVerb = prevTimes.some((t) => Math.abs(t - createdAtMs) <= 10 * 60_000);
    prevTimes.push(createdAtMs);
    seenActorVerbTimestamps.set(avKey, prevTimes);
    const burstFactor = hasRecentSameVerb ? 0.5 : 1.0;

    const baseScore =
      ((actorAffinity * verbWeight * subjectAffinity * engagementFactor) / gravityDecay) *
      burstFactor;

    return {
      item,
      baseScore,
      createdAtMs,
    };
  });

  // Greedy selection with AuthorDiversity (0.50^k) and non-consecutive actor interleaving
  const pool = [...candidates];
  const result: ActivityItem[] = [];
  const actorCounts = new Map<string, number>();

  while (pool.length > 0) {
    const prevActorId =
      result.length > 0 ? result[result.length - 1].actor.user_id : null;
    const hasAlternativeActor =
      prevActorId !== null && pool.some((c) => c.item.actor.user_id !== prevActorId);

    let bestIdx = 0;
    let bestEffectiveScore = -Infinity;

    for (let i = 0; i < pool.length; i++) {
      const cand = pool[i];
      const actorId = cand.item.actor.user_id;

      // Enforce no two consecutive posts by the same actor whenever another actor is available
      if (hasAlternativeActor && actorId === prevActorId) {
        continue;
      }

      const k = actorCounts.get(actorId) ?? 0;
      const diversityPenalty = Math.pow(0.5, k);
      const effectiveScore = cand.baseScore * diversityPenalty;

      if (
        effectiveScore > bestEffectiveScore ||
        (effectiveScore === bestEffectiveScore &&
          (cand.createdAtMs > pool[bestIdx].createdAtMs ||
            (cand.createdAtMs === pool[bestIdx].createdAtMs &&
              cand.item.id > pool[bestIdx].item.id)))
      ) {
        bestEffectiveScore = effectiveScore;
        bestIdx = i;
      }
    }

    const [chosen] = pool.splice(bestIdx, 1);
    const chosenActorId = chosen.item.actor.user_id;
    actorCounts.set(chosenActorId, (actorCounts.get(chosenActorId) ?? 0) + 1);
    result.push(chosen.item);
  }

  return result;
}

interface CachedPlazaFeedEntry {
  expiresAt: number;
  stateFingerprint: string;
  items: ActivityItem[];
}

const plazaFeedCache = new Map<string, CachedPlazaFeedEntry>();
const PLAZA_CACHE_TTL_MS = 60_000;

export function clearPlazaFeedCache(): void {
  plazaFeedCache.clear();
}

export async function getFeed(
  client: Queryable | null | undefined,
  input: GetFeedInput,
): Promise<GetFeedResult> {
  const queryable = client ?? getPool();
  if (!queryable) {
    return { items: [], next_cursor: null };
  }

  const viewerId = input.viewerId ?? null;
  const isTest = Boolean(input.isTest);
  const limit = Math.min(50, Math.max(1, input.limit ?? 20));
  const requestedScope = input.scope ?? 'mixed';
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const manilaDay = new Date(nowMs + MANILA_OFFSET_MS).toISOString().slice(0, 10);

  const cursorData = parseCursor(input.cursor);

  // 1. Scope = 'town': strictly uses users.home_municipality only (never inferred)
  if (requestedScope === 'town') {
    if (!viewerId) {
      return { items: [], next_cursor: null, reason: 'NO_HOME_TOWN' };
    }
    const viewerHomeTown = await resolveViewerHomeTown(queryable, viewerId, isTest);
    if (!viewerHomeTown) {
      return { items: [], next_cursor: null, reason: 'NO_HOME_TOWN' };
    }

    const params: unknown[] = [isTest, viewerId, viewerHomeTown];
    let pIdx = 4;
    let cursorCondition = '';
    if (cursorData) {
      params.push(cursorData.createdAt);
      const cDateParam = `$${pIdx++}`;
      params.push(cursorData.id);
      const cIdParam = `$${pIdx++}`;
      cursorCondition = `WHERE (feed.created_at < ${cDateParam} OR (feed.created_at = ${cDateParam} AND feed.id < ${cIdParam}))`;
    }
    params.push(limit + 1);
    const limitParam = `$${pIdx++}`;

    const sql = `
      SELECT * FROM (
        SELECT a.id, a.event_key, a.actor_id, a.verb, a.subject_type, a.subject_id,
               a.subject_title, a.subject_href, a.municipality, a.payload,
               a.cheer_count, a.comment_count, a.created_at,
               u.display_name, u.handle, u.avatar_url, u.home_municipality AS actor_home_municipality,
               (f.follower_id IS NOT NULL) AS via_follow,
               (c.user_id IS NOT NULL) AS cheered_by_me
          FROM social_activities a
          JOIN users u ON u.id = a.actor_id AND u.is_test = a.is_test
          LEFT JOIN user_follows f ON $2::text IS NOT NULL AND f.follower_id = $2 AND f.following_id = a.actor_id
          LEFT JOIN social_cheers c ON $2::text IS NOT NULL AND c.activity_id = a.id AND c.user_id = $2
         WHERE a.is_test = $1
           AND a.hidden_at IS NULL
           AND u.is_public = TRUE
           AND u.share_activity = TRUE
           AND (a.municipality = $3 OR u.home_municipality = $3)
      ) feed
      ${cursorCondition}
      ORDER BY feed.created_at DESC, feed.id DESC
      LIMIT ${limitParam}
    `;

    const res = await queryable.query(sql, params);
    const rows = res.rows;
    const hasMore = rows.length > limit;
    const returnedRows = hasMore ? rows.slice(0, limit) : rows;
    const items = returnedRows.map((row: any) => {
      const mapped = mapActivityRow(row, viewerId);
      if (mapped.reason === 'nearby' && !mapped.reason_label) {
        mapped.reason_label = `In ${viewerHomeTown}`;
      }
      return mapped;
    });

    let next_cursor: string | null = null;
    if (hasMore && items.length > 0) {
      const lastItem = items[items.length - 1];
      next_cursor = Buffer.from(`${lastItem.created_at}|${lastItem.id}`).toString('base64url');
    }
    return { items, next_cursor };
  }

  const effectiveScope = viewerId ? requestedScope : 'mixed';

  // 2. Scope = 'following': chronological stream of followed users + self
  if (effectiveScope === 'following') {
    const params: unknown[] = [isTest, viewerId];
    let pIdx = 3;
    let cursorCondition = '';
    if (cursorData) {
      params.push(cursorData.createdAt);
      const cDateParam = `$${pIdx++}`;
      params.push(cursorData.id);
      const cIdParam = `$${pIdx++}`;
      cursorCondition = `WHERE (feed.created_at < ${cDateParam} OR (feed.created_at = ${cDateParam} AND feed.id < ${cIdParam}))`;
    }
    params.push(limit + 1);
    const limitParam = `$${pIdx++}`;

    const sql = `
      SELECT * FROM (
        SELECT a.id, a.event_key, a.actor_id, a.verb, a.subject_type, a.subject_id,
               a.subject_title, a.subject_href, a.municipality, a.payload,
               a.cheer_count, a.comment_count, a.created_at,
               u.display_name, u.handle, u.avatar_url,
               (f.follower_id IS NOT NULL) AS via_follow,
               (c.user_id IS NOT NULL) AS cheered_by_me
          FROM social_activities a
          JOIN users u ON u.id = a.actor_id AND u.is_test = a.is_test
          LEFT JOIN user_follows f ON $2::text IS NOT NULL AND f.follower_id = $2 AND f.following_id = a.actor_id
          LEFT JOIN social_cheers c ON $2::text IS NOT NULL AND c.activity_id = a.id AND c.user_id = $2
         WHERE a.is_test = $1
           AND a.hidden_at IS NULL
           AND u.is_public = TRUE
           AND u.share_activity = TRUE
           AND (f.follower_id IS NOT NULL OR a.actor_id = $2)
      ) feed
      ${cursorCondition}
      ORDER BY feed.created_at DESC, feed.id DESC
      LIMIT ${limitParam}
    `;

    const res = await queryable.query(sql, params);
    const rows = res.rows;
    const hasMore = rows.length > limit;
    const returnedRows = hasMore ? rows.slice(0, limit) : rows;
    const items = returnedRows.map((row: any) => mapActivityRow(row, viewerId));

    let next_cursor: string | null = null;
    if (hasMore && items.length > 0) {
      const lastItem = items[items.length - 1];
      next_cursor = Buffer.from(`${lastItem.created_at}|${lastItem.id}`).toString('base64url');
    }
    return { items, next_cursor };
  }

  // 3. Scope = 'mixed': PlazaRanker v2 with 60s per-viewer / Manila-day / filter ranked cache & slicing
  const candidateSql = `
    SELECT a.id, a.event_key, a.actor_id, a.verb, a.subject_type, a.subject_id,
           a.subject_title, a.subject_href, a.municipality, a.payload,
           a.cheer_count, a.comment_count, a.created_at,
           u.display_name, u.handle, u.avatar_url, u.home_municipality AS actor_home_municipality,
           (f.follower_id IS NOT NULL) AS via_follow,
           (mf.follower_id IS NOT NULL AND f.follower_id IS NOT NULL) AS is_mutual_follow,
           (c.user_id IS NOT NULL) AS cheered_by_me
      FROM social_activities a
      JOIN users u ON u.id = a.actor_id AND u.is_test = a.is_test
      LEFT JOIN user_follows f ON $2::text IS NOT NULL AND f.follower_id = $2 AND f.following_id = a.actor_id
      LEFT JOIN user_follows mf ON $2::text IS NOT NULL AND mf.follower_id = a.actor_id AND mf.following_id = $2
      LEFT JOIN social_cheers c ON $2::text IS NOT NULL AND c.activity_id = a.id AND c.user_id = $2
     WHERE a.is_test = $1
       AND a.hidden_at IS NULL
       AND u.is_public = TRUE
       AND u.share_activity = TRUE
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT 150
  `;

  const candidateRes = await queryable.query(candidateSql, [isTest, viewerId]);
  const candidateRows = candidateRes.rows;

  const cacheKey = `${viewerId || 'anon'}|${isTest ? 'test' : 'prod'}|${manilaDay}|mixed`;
  const rowsSig = candidateRows
    .map(
      (r: any) =>
        `${r.id}:${r.cheer_count}:${r.comment_count}:${r.via_follow ? 1 : 0}:${r.is_mutual_follow ? 1 : 0}:${r.cheered_by_me ? 1 : 0}:${r.actor_home_municipality ?? ''}`,
    )
    .join('|');

  for (const [k, v] of plazaFeedCache.entries()) {
    if (v.expiresAt <= nowMs) plazaFeedCache.delete(k);
  }

  let rankedItems: ActivityItem[];
  const cached = plazaFeedCache.get(cacheKey);
  if (cached && cached.expiresAt > nowMs && cached.stateFingerprint === rowsSig) {
    rankedItems = cached.items;
  } else {
    const ctx = await buildViewerPlazaContext(queryable, viewerId, isTest, now);
    rankedItems = rankPlazaCandidateRows(candidateRows, viewerId, ctx, nowMs);
    if (plazaFeedCache.size >= 250) {
      const oldest = plazaFeedCache.keys().next().value;
      if (oldest) plazaFeedCache.delete(oldest);
    }
    plazaFeedCache.set(cacheKey, {
      expiresAt: nowMs + PLAZA_CACHE_TTL_MS,
      stateFingerprint: rowsSig,
      items: rankedItems,
    });
  }

  let startIndex = 0;
  let sliceSource = rankedItems;
  if (cursorData) {
    const idx = rankedItems.findIndex((item) => item.id === cursorData.id);
    if (idx !== -1) {
      startIndex = idx + 1;
    } else {
      const cursorTimeMs = cursorData.createdAt.getTime();
      sliceSource = rankedItems.filter((item) => {
        const t = new Date(item.created_at).getTime();
        return t < cursorTimeMs || (t === cursorTimeMs && item.id < cursorData.id);
      });
      startIndex = 0;
    }
  }

  const items = sliceSource.slice(startIndex, startIndex + limit);
  const hasMore = startIndex + limit < sliceSource.length;

  let next_cursor: string | null = null;
  if (hasMore && items.length > 0) {
    const lastItem = items[items.length - 1];
    next_cursor = Buffer.from(`${lastItem.created_at}|${lastItem.id}`).toString('base64url');
  }

  return { items, next_cursor };
}

export async function getActivityById(
  client: Queryable | null | undefined,
  activityId: string,
  viewerId: string | null = null,
  isTest = false,
): Promise<ActivityItem | null> {
  const queryable = client ?? getPool();
  if (!queryable) return null;

  const res = await queryable.query(
    `SELECT a.id, a.event_key, a.actor_id, a.verb, a.subject_type, a.subject_id,
            a.subject_title, a.subject_href, a.municipality, a.payload,
            a.cheer_count, a.comment_count, a.created_at,
            u.display_name, u.handle, u.avatar_url,
            (f.follower_id IS NOT NULL) AS via_follow,
            (c.user_id IS NOT NULL) AS cheered_by_me
       FROM social_activities a
       JOIN users u ON u.id = a.actor_id AND u.is_test = a.is_test
       LEFT JOIN user_follows f ON $2::text IS NOT NULL AND f.follower_id = $2 AND f.following_id = a.actor_id
       LEFT JOIN social_cheers c ON $2::text IS NOT NULL AND c.activity_id = a.id AND c.user_id = $2
      WHERE a.id = $1
        AND a.is_test = $3
        AND a.hidden_at IS NULL
        AND u.is_public = TRUE
        AND u.share_activity = TRUE
      LIMIT 1`,
    [activityId, viewerId, isTest],
  );

  if (!res.rows.length) return null;
  return mapActivityRow(res.rows[0], viewerId);
}
