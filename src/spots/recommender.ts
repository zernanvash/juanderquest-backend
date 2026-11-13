import { createHash } from 'crypto';
import { db } from '../db/index.js';
import { MANILA_OFFSET_MS, manilaHour } from '../social/time.js';
import type { CrowdMetrics } from './crowd.js';
import { distanceKm, type Spot, type SpotStore } from './store.js';

export interface ExploreListQuery {
  search?: string;
  categories?: string[];
  tags?: string[];
  municipality?: string;
  lat?: number;
  lng?: number;
  radius?: number;
  intent?: string;
  sort?: string;
  hasQuest?: boolean;
  userId?: string;
  actorId?: string;
  homeTown?: string | null;
  allowTest?: boolean;
  limit?: number;
  offset?: number;
  now?: number;
}

export interface UserTasteProfile {
  userId?: string;
  hasSignals: boolean;
  categoryWeights: Map<string, number>;
  rawCategoryWeights: Map<string, number>;
  tagWeights: Map<string, number>;
  municipalityWeights: Map<string, number>;
  rawMunicipalityWeights: Map<string, number>;
  topCategories: string[];
  topAffinityTowns: string[];
  visitedSpotIds: Set<string>;
  completedQuestIds: Set<string>;
  savedSpotIds: Set<string>;
  likedSpotIds: Set<string>;
  positiveSpots: Spot[];
  recentViewCounts24h: Map<string, number>;
  friendHandlesBySpotId: Map<string, string[]>;
  lastActiveSpot?: Spot;
}

export function manilaDayKey(nowMs: number = Date.now()): string {
  return new Date(nowMs + MANILA_OFFSET_MS).toISOString().slice(0, 10);
}

export function dailyExploreJitter(viewerKey: string, spotId: string, manilaDay: string): number {
  const digest = createHash('sha256')
    .update(`${manilaDay}:${viewerKey || 'anon'}:${spotId}`)
    .digest();
  return digest.readUInt32BE(0) / 0xffffffff;
}

const CATEGORY_LABELS: Record<string, string> = {
  eat_drink: 'Eat & Drink',
  nature_outdoors: 'Nature & Outdoors',
  culture_heritage: 'Culture & Heritage',
  activities_wellness: 'Activities & Wellness',
  shopping_local: 'Shopping & Local Finds',
  stay: 'Stay',
};

export function formatCategoryLabel(category: string): string {
  return (
    CATEGORY_LABELS[category] ||
    category
      .split('_')
      .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ''))
      .join(' ')
  );
}

function normalizeWeights(raw: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  let max = 0;
  for (const v of raw.values()) {
    if (v > max) max = v;
  }
  if (max <= 0) return out;
  for (const [k, v] of raw.entries()) {
    if (v > 0) out.set(k, Math.min(1, v / max));
  }
  return out;
}

function addWeight(map: Map<string, number>, key: string | undefined | null, delta: number): void {
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + delta);
}

export function buildUserTasteProfile(
  store: SpotStore,
  userId: string | undefined,
  nowMs: number = Date.now(),
): UserTasteProfile {
  const rawCategoryWeights = new Map<string, number>();
  const rawTagWeights = new Map<string, number>();
  const rawMunicipalityWeights = new Map<string, number>();
  const visitedSpotIds = new Set<string>();
  const completedQuestIds = new Set<string>();
  const savedSpotIds = new Set<string>();
  const likedSpotIds = new Set<string>();
  const positiveSpotsById = new Map<string, Spot>();
  const recentViewCounts24h = new Map<string, number>();
  const friendHandlesBySpotId = new Map<string, string[]>();
  let lastActiveSpot: Spot | undefined;
  let lastActiveTs = 0;

  if (!userId) {
    return {
      userId,
      hasSignals: false,
      categoryWeights: new Map(),
      rawCategoryWeights,
      tagWeights: new Map(),
      municipalityWeights: new Map(),
      rawMunicipalityWeights,
      topCategories: [],
      topAffinityTowns: [],
      visitedSpotIds,
      completedQuestIds,
      savedSpotIds,
      likedSpotIds,
      positiveSpots: [],
      recentViewCounts24h,
      friendHandlesBySpotId,
    };
  }

  const spotById = new Map<string, Spot>();
  const spotByQuestId = new Map<string, Spot>();
  for (const s of store.spots) {
    spotById.set(s.id, s);
    if (s.quest_id) spotByQuestId.set(s.quest_id, s);
  }

  // 1. Explicit onboarding preferences
  const prefs = store.preferences.get(userId);
  if (prefs) {
    for (const cat of prefs.categories || []) {
      addWeight(rawCategoryWeights, cat, 2.5);
    }
    for (const tag of [...(prefs.tags || []), ...(prefs.occasions || [])]) {
      addWeight(rawTagWeights, tag, 2.0);
    }
  }

  // 2. Persisted spot_interactions for viewer
  const userInteractions = store.interactions.get(userId);
  if (userInteractions) {
    for (const entry of userInteractions) {
      const sep = entry.lastIndexOf(':');
      if (sep <= 0) continue;
      const spotId = entry.slice(0, sep);
      const type = entry.slice(sep + 1);
      const spot = spotById.get(spotId);
      if (!spot) continue;

      if (type === 'visit') {
        visitedSpotIds.add(spot.id);
        if (spot.quest_id) completedQuestIds.add(spot.quest_id);
        positiveSpotsById.set(spot.id, spot);
        addWeight(rawCategoryWeights, spot.category, 5.0);
        for (const t of spot.tags) addWeight(rawTagWeights, t, 4.0);
        addWeight(rawMunicipalityWeights, spot.municipality, 3.0);
        if (!lastActiveSpot) lastActiveSpot = spot;
      } else if (type === 'save') {
        savedSpotIds.add(spot.id);
        positiveSpotsById.set(spot.id, spot);
        addWeight(rawCategoryWeights, spot.category, 3.0);
        for (const t of spot.tags) addWeight(rawTagWeights, t, 2.5);
        addWeight(rawMunicipalityWeights, spot.municipality, 2.0);
      } else if (type === 'directions') {
        addWeight(rawCategoryWeights, spot.category, 3.0);
        for (const t of spot.tags) addWeight(rawTagWeights, t, 2.5);
        addWeight(rawMunicipalityWeights, spot.municipality, 2.0);
        if (!lastActiveSpot) lastActiveSpot = spot;
      } else if (type === 'like' || type === 'helpful') {
        likedSpotIds.add(spot.id);
        positiveSpotsById.set(spot.id, spot);
        addWeight(rawCategoryWeights, spot.category, 2.0);
        for (const t of spot.tags) addWeight(rawTagWeights, t, 1.5);
        addWeight(rawMunicipalityWeights, spot.municipality, 1.0);
      } else if (type === 'view') {
        addWeight(rawCategoryWeights, spot.category, 0.5);
        for (const t of spot.tags) addWeight(rawTagWeights, t, 0.4);
        if (!lastActiveSpot) lastActiveSpot = spot;
      }
    }
  }

  // 3. Recent 24h / 7d activity events (for view-fatigue & 7-day location anchor)
  const sevenDaysMs = 7 * 86_400_000;
  const oneDayMs = 86_400_000;
  for (const ev of store.activityEvents) {
    if (ev.user_id !== userId) continue;
    const spot = spotById.get(ev.spot_id);
    if (!spot) continue;
    const ts = Date.parse(ev.created_at);
    const ageMs = Number.isFinite(ts) ? nowMs - ts : 0;

    if (ev.activity_type === 'view' && ageMs >= 0 && ageMs <= oneDayMs) {
      recentViewCounts24h.set(spot.id, (recentViewCounts24h.get(spot.id) ?? 0) + 1);
    }
    if (
      (ev.activity_type === 'visit' || ev.activity_type === 'directions' || ev.activity_type === 'view') &&
      ageMs >= 0 &&
      ageMs <= sevenDaysMs &&
      ts >= lastActiveTs
    ) {
      lastActiveTs = ts;
      lastActiveSpot = spot;
    }
  }

  // 4. Approved quest submissions & completed quest attempts
  for (const sub of db.submissions) {
    if (sub.user_id !== userId || sub.status !== 'approved') continue;
    completedQuestIds.add(sub.quest_id);
    const spot = spotByQuestId.get(sub.quest_id);
    if (spot) {
      if (!visitedSpotIds.has(spot.id)) {
        visitedSpotIds.add(spot.id);
        positiveSpotsById.set(spot.id, spot);
        addWeight(rawCategoryWeights, spot.category, 5.0);
        for (const t of spot.tags) addWeight(rawTagWeights, t, 4.0);
        addWeight(rawMunicipalityWeights, spot.municipality, 3.0);
      }
    } else {
      const quest = db.quests.find((q) => q.id === sub.quest_id);
      if (quest?.location_name) {
        addWeight(rawMunicipalityWeights, quest.location_name, 3.0);
      }
    }
  }

  for (const att of db.quest_attempts) {
    if (att.user_id !== userId || att.status !== 'completed') continue;
    completedQuestIds.add(att.quest_id);
    const spot = spotByQuestId.get(att.quest_id);
    if (spot && !visitedSpotIds.has(spot.id)) {
      visitedSpotIds.add(spot.id);
      positiveSpotsById.set(spot.id, spot);
      addWeight(rawCategoryWeights, spot.category, 5.0);
      for (const t of spot.tags) addWeight(rawTagWeights, t, 4.0);
      addWeight(rawMunicipalityWeights, spot.municipality, 3.0);
    }
  }

  // 5. Friend Signals: ONLY followed public profiles, shown as @handle, never IDs, never test users
  const followedIds = new Set<string>();
  for (const f of db.follows) {
    if (f.follower_id === userId && f.following_id !== userId) {
      followedIds.add(f.following_id);
    }
  }

  for (const friendId of followedIds) {
    const friend = db.findUserById(friendId);
    if (!friend) continue;
    if (friend.is_public !== true || friend.share_activity !== true) continue;
    if (friend.is_test) continue;
    const rawHandle = typeof friend.handle === 'string' ? friend.handle.trim().replace(/^@+/, '') : '';
    if (!rawHandle) continue;
    // Never expose a UUID or seed_id as a handle
    if (rawHandle === friend.id || rawHandle === friend.seed_id) continue;
    const formattedHandle = `@${rawHandle}`;

    const friendSpotIds = new Set<string>();
    const fInteractions = store.interactions.get(friendId);
    if (fInteractions) {
      for (const entry of fInteractions) {
        const sep = entry.lastIndexOf(':');
        if (sep <= 0) continue;
        const sId = entry.slice(0, sep);
        const iType = entry.slice(sep + 1);
        if (iType === 'visit' || iType === 'save' || iType === 'like') {
          friendSpotIds.add(sId);
        }
      }
    }
    for (const sub of db.submissions) {
      if (sub.user_id === friendId && sub.status === 'approved') {
        const spot = spotByQuestId.get(sub.quest_id);
        if (spot) friendSpotIds.add(spot.id);
      }
    }

    for (const sId of friendSpotIds) {
      const list = friendHandlesBySpotId.get(sId) ?? [];
      if (!list.includes(formattedHandle)) {
        list.push(formattedHandle);
        friendHandlesBySpotId.set(sId, list);
      }
    }
  }

  const categoryWeights = normalizeWeights(rawCategoryWeights);
  const tagWeights = normalizeWeights(rawTagWeights);
  const municipalityWeights = normalizeWeights(rawMunicipalityWeights);

  const topCategories = [...rawCategoryWeights.entries()]
    .filter(([, w]) => w > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k]) => k);

  const topAffinityTowns = [...rawMunicipalityWeights.entries()]
    .filter(([, w]) => w > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k]) => k);

  const hasSignals =
    rawCategoryWeights.size > 0 ||
    rawTagWeights.size > 0 ||
    rawMunicipalityWeights.size > 0 ||
    visitedSpotIds.size > 0 ||
    savedSpotIds.size > 0 ||
    likedSpotIds.size > 0 ||
    friendHandlesBySpotId.size > 0;

  return {
    userId,
    hasSignals,
    categoryWeights,
    rawCategoryWeights,
    tagWeights,
    municipalityWeights,
    rawMunicipalityWeights,
    topCategories,
    topAffinityTowns,
    visitedSpotIds,
    completedQuestIds,
    savedSpotIds,
    likedSpotIds,
    positiveSpots: [...positiveSpotsById.values()],
    recentViewCounts24h,
    friendHandlesBySpotId,
    lastActiveSpot,
  };
}

function computeTownCentroids(spots: Spot[]): Map<string, { lat: number; lng: number }> {
  const sums = new Map<string, { lat: number; lng: number; count: number }>();
  for (const s of spots) {
    if (s.status !== 'published') continue;
    const key = s.municipality.toLowerCase();
    const cur = sums.get(key) ?? { lat: 0, lng: 0, count: 0 };
    cur.lat += s.gps_lat;
    cur.lng += s.gps_lng;
    cur.count += 1;
    sums.set(key, cur);
  }
  const centroids = new Map<string, { lat: number; lng: number }>();
  for (const [k, v] of sums.entries()) {
    if (v.count > 0) {
      centroids.set(k, { lat: v.lat / v.count, lng: v.lng / v.count });
    }
  }
  return centroids;
}

function computeTimeOfDayBoost(spot: Spot, hour: number): number {
  const cat = spot.category;
  const sub = spot.subcategory.toLowerCase();
  const tags = spot.tags.map((t) => t.toLowerCase());

  if (hour >= 6 && hour <= 10) {
    if (
      cat === 'nature_outdoors' ||
      cat === 'culture_heritage' ||
      sub === 'beach' ||
      sub === 'cafe' ||
      sub === 'bakery' ||
      tags.some((t) => ['hiking', 'pilgrimage', 'coffee', 'breakfast', 'running'].includes(t))
    ) {
      return 0.85;
    }
  } else if (hour >= 11 && hour <= 14) {
    if (
      cat === 'eat_drink' ||
      cat === 'shopping_local' ||
      sub === 'museum' ||
      sub === 'restaurant' ||
      sub === 'carinderia' ||
      tags.some((t) => ['local_food', 'seafood', 'market'].includes(t))
    ) {
      return 0.85;
    }
  } else if (hour >= 15 && hour <= 18) {
    if (
      sub === 'beach' ||
      sub === 'viewpoint' ||
      sub === 'running_spot' ||
      sub === 'park' ||
      tags.some((t) => ['sunset', 'scenic', 'walking', 'beach'].includes(t))
    ) {
      return 0.85;
    }
  } else if (hour >= 19 && hour <= 22) {
    if (
      cat === 'eat_drink' ||
      cat === 'stay' ||
      tags.some((t) => ['friends', 'night_market', 'local_food'].includes(t))
    ) {
      return 0.85;
    }
  }
  return 0.4;
}

function findSimilarLikedSpot(candidate: Spot, positiveSpots: Spot[]): Spot | undefined {
  let best: Spot | undefined;
  let bestOverlap = 0;
  for (const liked of positiveSpots) {
    if (liked.id === candidate.id) continue;
    const sameCat = liked.category === candidate.category;
    const sharedTags = candidate.tags.filter((t) => liked.tags.includes(t)).length;
    const score = (sameCat ? 2 : 0) + sharedTags;
    if (sameCat && (sharedTags >= 1 || liked.subcategory === candidate.subcategory) && score > bestOverlap) {
      bestOverlap = score;
      best = liked;
    }
  }
  return best;
}

export interface RankedSpotItem extends Spot, CrowdMetrics {
  distance_km: number | undefined;
  recommendation_score: number;
  recommendation_reasons: string[];
  saved: boolean;
  liked: boolean;
  trend_score: number;
}

export function applyExploreDiversity(
  items: RankedSpotItem[],
  taste: UserTasteProfile,
  enableSerendipitySlot: boolean,
): RankedSpotItem[] {
  if (items.length <= 2) return [...items];

  const pool = [...items];
  const result: RankedSpotItem[] = [];

  while (pool.length > 0) {
    const slotIdx = result.length;

    // 1-in-5 Serendipity / Hidden Gem slot (every 5th card: index 4, 9, 14...)
    if (enableSerendipitySlot && slotIdx % 5 === 4 && pool.length > 1) {
      const prev1 = result[slotIdx - 1];
      const prev2 = result[slotIdx - 2];
      const gemIdx = pool.findIndex((c) => {
        if (taste.visitedSpotIds.has(c.id)) return false;
        if (c.crowd_status === 'estimated_busy') return false;
        if (prev1 && prev2 && prev1.municipality === c.municipality && prev2.municipality === c.municipality) {
          return false;
        }
        const catWeight = taste.categoryWeights.get(c.category) ?? 0;
        const muniWeight = taste.municipalityWeights.get(c.municipality) ?? 0;
        const isUnderExplored = !taste.hasSignals || catWeight < 0.5 || muniWeight === 0;
        return isUnderExplored && (c.crowd_status === 'quiet' || c.tags.includes('hidden_gem'));
      });

      if (gemIdx !== -1) {
        const [gem] = pool.splice(gemIdx, 1);
        const gemReason = `Quiet Hidden Gem in ${gem.municipality}`;
        if (gem.crowd_status === 'quiet' && !gem.recommendation_reasons.includes(gemReason)) {
          gem.recommendation_reasons = [gemReason, ...gem.recommendation_reasons];
        }
        result.push(gem);
        continue;
      }
    }

    const prev1 = result[slotIdx - 1];
    const prev2 = result[slotIdx - 2];
    const hasDifferentMuni =
      prev1 && prev2 && prev1.municipality === prev2.municipality
        ? pool.some((c) => c.municipality !== prev1.municipality)
        : false;
    const hasDifferentCat =
      prev1 && prev2 && prev1.category === prev2.category ? pool.some((c) => c.category !== prev1.category) : false;

    let bestIdx = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < pool.length; i++) {
      const cand = pool[i];
      let adj = Math.max(0.0001, cand.recommendation_score);

      // Hard municipal diversity guard: never allow 3 consecutive items from the same municipality when alternatives exist
      if (
        hasDifferentMuni &&
        prev1 &&
        prev2 &&
        cand.municipality === prev1.municipality &&
        cand.municipality === prev2.municipality
      ) {
        continue;
      }

      // MMR sliding-window category penalty (last 2 cards)
      const catRepeats =
        (prev1 && prev1.category === cand.category ? 1 : 0) + (prev2 && prev2.category === cand.category ? 1 : 0);
      if (catRepeats >= 2 && hasDifferentCat) {
        adj *= 0.36;
      } else if (catRepeats === 1) {
        adj *= 0.6;
      }

      // MMR sliding-window municipality penalty (last 2 cards)
      const muniRepeats =
        (prev1 && prev1.municipality === cand.municipality ? 1 : 0) +
        (prev2 && prev2.municipality === cand.municipality ? 1 : 0);
      if (muniRepeats >= 1) {
        adj *= 0.7;
      }

      if (adj > bestScore) {
        bestScore = adj;
        bestIdx = i;
      }
    }

    result.push(pool.splice(bestIdx, 1)[0]);
  }

  return result;
}

interface CachedExploreEntry {
  expiresAt: number;
  stateFingerprint: string;
  items: RankedSpotItem[];
}

const exploreCache = new Map<string, CachedExploreEntry>();
const EXPLORE_CACHE_TTL_MS = 60_000;

export function clearExploreRankingCache(): void {
  exploreCache.clear();
}

function computeStateFingerprint(
  store: SpotStore,
  userId: string | undefined,
  homeTown: string | null | undefined,
): string {
  const userSet = userId ? store.interactions.get(userId) : undefined;
  const userInteractionsSig = userSet ? [...userSet].sort().join(',') : '';
  const prefs = userId ? store.preferences.get(userId) : undefined;
  const prefsSig = prefs
    ? `${prefs.categories.join(',')}|${prefs.tags.join(',')}|${prefs.occasions.join(',')}|${prefs.radius_km}`
    : '';
  const followsSig = userId
    ? db.follows
        .filter((f) => f.follower_id === userId)
        .map((f) => {
          const u = db.findUserById(f.following_id);
          return `${f.following_id}:${u?.is_public ? 1 : 0}:${u?.share_activity ? 1 : 0}:${u?.handle || ''}:${store.interactions.get(f.following_id)?.size ?? 0}`;
        })
        .join(',')
    : '';
  const subsCount = userId
    ? db.submissions.filter((s) => s.user_id === userId && s.status === 'approved').length +
      db.quest_attempts.filter((a) => a.user_id === userId && a.status === 'completed').length
    : 0;
  let globalInteractionsCount = 0;
  for (const [, set] of store.interactions.entries()) {
    globalInteractionsCount += set.size;
  }
  const spotsSig = `${store.spots.length}:${store.spots.map((s) => `${s.id}:${s.status}:${s.recommendation_suppressed ? 1 : 0}`).join(',')}`;
  return `${homeTown ?? ''}|${userInteractionsSig}|${prefsSig}|${followsSig}|${subsCount}|${globalInteractionsCount}|${store.activityEvents.length}|${spotsSig}`;
}

interface SpotMeritInfo {
  activeLikes: number;
  activeMeritPoints: number;
}

/**
 * Computes time-decayed popularity merit per spot with a 14-day exhaustion duration:
 * - 0..3 days: 100% merit power (peak breakout window)
 * - 3..14 days: linear decay to 0 (cooldown window)
 * - >14 days: 0% breakout power (exhausted — prevents old popular spots from dominating forever)
 */
function computeSpotMeritMap(store: SpotStore, nowMs: number): Map<string, SpotMeritInfo> {
  const weights: Record<string, number> = {
    visit: 4.5,
    directions: 2.5,
    save: 2.5,
    like: 2.5,
    helpful: 2.0,
  };
  const result = new Map<string, SpotMeritInfo>();

  for (const [userId, values] of store.interactions.entries()) {
    if (db.findUserById(userId)?.is_test) continue;
    for (const key of values) {
      const at = key.lastIndexOf(':');
      if (at <= 0) continue;
      const spotId = key.slice(0, at);
      const type = key.slice(at + 1);
      const baseWeight = weights[type];
      if (baseWeight === undefined) continue;

      const tsKey = `${userId}:${spotId}:${type}`;
      const createdAtMs = store.interactionTimestamps.get(tsKey) ?? nowMs;
      const ageDays = Math.max(0, (nowMs - createdAtMs) / 86_400_000);

      // Exhaustion cutoff at 14 days
      if (ageDays > 14) continue;

      const freshness = ageDays <= 3 ? 1.0 : Math.max(0, 1 - (ageDays - 3) / 11);
      if (freshness <= 0) continue;

      const info = result.get(spotId) ?? { activeLikes: 0, activeMeritPoints: 0 };
      info.activeMeritPoints += baseWeight * freshness;
      if (type === 'like' || type === 'helpful') {
        info.activeLikes += 1;
      }
      result.set(spotId, info);
    }
  }

  return result;
}

export function rankExploreSpots(store: SpotStore, q: ExploreListQuery): RankedSpotItem[] {
  const nowMs = q.now ?? Date.now();
  const manilaDay = manilaDayKey(nowMs);
  const sortMode = q.sort || 'recommended';
  const actorKey = q.actorId || q.userId || 'anon';
  // Only treat registered user IDs (or actors with stored preferences/interactions/follows) as authenticated for personal reasons
  const hasRegisteredUser = Boolean(
    q.userId &&
    (db.findUserById(q.userId) ||
      store.preferences.has(q.userId) ||
      store.interactions.has(q.userId) ||
      db.follows.some((f) => f.follower_id === q.userId) ||
      db.submissions.some((s) => s.user_id === q.userId)),
  );
  const profileUserId = hasRegisteredUser ? q.userId : undefined;

  // Resolve home town: explicit q.homeTown, or in-memory UserRow fallback if present
  const resolvedHomeTown =
    q.homeTown !== undefined
      ? q.homeTown
      : profileUserId
        ? ((db.findUserById(profileUserId) as { home_municipality?: string | null } | undefined)?.home_municipality ??
          null)
        : null;

  const filterKey = JSON.stringify({
    search: (q.search || '').trim().toLowerCase(),
    categories: [...(q.categories || [])].sort(),
    tags: [...(q.tags || [])].sort(),
    municipality: (q.municipality || '').trim().toLowerCase(),
    lat: q.lat !== undefined ? Number(q.lat.toFixed(4)) : null,
    lng: q.lng !== undefined ? Number(q.lng.toFixed(4)) : null,
    radius: q.radius ?? null,
    intent: (q.intent || '').trim().toLowerCase(),
    sort: sortMode,
    hasQuest: Boolean(q.hasQuest),
    allowTest: Boolean(q.allowTest),
    hourBucket: q.intent ? 'intent' : Math.floor(manilaHour(new Date(nowMs)) / 4),
  });

  const cacheKey = `${actorKey}|${manilaDay}|${filterKey}`;
  const stateFingerprint = computeStateFingerprint(store, profileUserId || q.userId, resolvedHomeTown);
  const cached = exploreCache.get(cacheKey);
  if (cached && cached.expiresAt > nowMs && cached.stateFingerprint === stateFingerprint) {
    const cloned = cached.items.map((item) => ({
      ...item,
      recommendation_reasons: [...item.recommendation_reasons],
    }));
    const offset = Math.max(0, q.offset ?? 0);
    return q.limit !== undefined ? cloned.slice(offset, offset + q.limit) : cloned.slice(offset);
  }

  // Evict expired cache entries
  for (const [k, v] of exploreCache.entries()) {
    if (v.expiresAt <= nowMs) exploreCache.delete(k);
  }

  const taste = buildUserTasteProfile(store, profileUserId, nowMs);
  const prefs = profileUserId ? store.getPreferences(profileUserId) : undefined;
  const trends = store.trendScores();
  const spotMerits = computeSpotMeritMap(store, nowMs);
  const bySpot = store.eventsBySpot();
  const centroids = computeTownCentroids(store.spots);
  const currentHour = manilaHour(new Date(nowMs));

  // Tier 3 anchor town: users.home_municipality first; when NULL, top-affinity town
  const tier3Town = resolvedHomeTown || taste.topAffinityTowns[0] || null;
  const tier3Centroid = tier3Town ? centroids.get(tier3Town.toLowerCase()) : undefined;

  const eligibleSpots = store.spots.filter(
    (s) => s.status === 'published' && !s.recommendation_suppressed && (q.allowTest || !s.is_test),
  );

  const scored = eligibleSpots
    .map((s): RankedSpotItem => {
      const trendScore = trends.get(s.id) ?? 0;
      const merit = spotMerits.get(s.id) ?? { activeLikes: 0, activeMeritPoints: 0 };
      const crowd = store.crowd(s, nowMs, bySpot);
      const liveDistance =
        q.lat !== undefined && q.lng !== undefined ? distanceKm(q.lat, q.lng, s.gps_lat, s.gps_lng) : undefined;

      // 1. Taste Score [0, 1]
      let tasteScore = 0.3;
      const catWeight = taste.categoryWeights.get(s.category) ?? 0;
      let maxTagWeight = 0;
      let bestMatchedTag: string | undefined;
      for (const t of s.tags) {
        const tw = taste.tagWeights.get(t) ?? 0;
        if (tw > maxTagWeight) {
          maxTagWeight = tw;
          bestMatchedTag = t;
        }
      }
      const muniWeight = taste.municipalityWeights.get(s.municipality) ?? 0;
      if (taste.hasSignals) {
        tasteScore = 0.5 * catWeight + 0.35 * maxTagWeight + 0.15 * muniWeight;
      }

      // 2. 3-Tier Location Anchor Proximity Score [0, 1]
      let proximityScore = 0.5;
      if (liveDistance !== undefined) {
        const radiusKm = Math.max(1, q.radius || prefs?.radius_km || 25);
        proximityScore = Math.exp(-liveDistance / radiusKm);
      } else if (taste.lastActiveSpot) {
        const anchorDist = distanceKm(taste.lastActiveSpot.gps_lat, taste.lastActiveSpot.gps_lng, s.gps_lat, s.gps_lng);
        proximityScore = Math.exp(-anchorDist / 30);
      } else if (tier3Town) {
        if (s.municipality.toLowerCase() === tier3Town.toLowerCase()) {
          proximityScore = 1.0;
        } else if (tier3Centroid) {
          const townDist = distanceKm(tier3Centroid.lat, tier3Centroid.lng, s.gps_lat, s.gps_lng);
          const decayed = Math.exp(-townDist / 35);
          proximityScore = muniWeight >= 0.5 ? Math.max(0.75, decayed) : decayed;
        } else if (muniWeight > 0) {
          proximityScore = 0.75;
        } else {
          proximityScore = 0.4;
        }
      }

      // 3. Quest & Social Score [0, 1]
      const hasUnclaimedQuest = Boolean(s.quest_id && !taste.completedQuestIds.has(s.quest_id));
      const friendHandles = taste.friendHandlesBySpotId.get(s.id) ?? [];
      const similarSpot = findSimilarLikedSpot(s, taste.positiveSpots);

      let questAndSocial = 0;
      if (hasUnclaimedQuest) questAndSocial += profileUserId ? 0.45 : 0.25;
      if (friendHandles.length > 0) questAndSocial += 0.35;
      if (similarSpot) questAndSocial += 0.2;
      questAndSocial = Math.min(1, questAndSocial);

      // 4. Quality & Crowd Score [0, 1]
      const trustBase =
        {
          lgu_verified: 0.45,
          editorial: 0.38,
          community: 0.3,
          open_data: 0.22,
        }[s.trust_level] ?? 0.1;
      const crowdMod =
        crowd.crowd_status === 'quiet'
          ? 0.25
          : crowd.crowd_status === 'moderate'
            ? 0.15
            : crowd.crowd_status === 'estimated_busy'
              ? -0.2
              : 0.1;
      const trendNorm = Math.min(0.3, trendScore / 15);
      const ageDays = Math.max(0, (nowMs - Date.parse(s.created_at)) / 86_400_000);
      const freshnessBoost = ageDays <= 30 ? 0.05 * (1 - ageDays / 30) : 0;
      const qualityAndCrowd = Math.max(0, Math.min(1, trustBase + crowdMod + trendNorm + freshnessBoost));

      // 5. Intent or Time-of-Day Score [0, 1]
      const intentQuery = (q.intent || '').trim().toLowerCase();
      const intentMatch =
        intentQuery.length > 0 &&
        [s.category, s.subcategory, ...s.tags, s.name].some((v) => v.toLowerCase().includes(intentQuery));
      const intentOrTime = intentQuery.length > 0 ? (intentMatch ? 1.0 : 0.0) : computeTimeOfDayBoost(s, currentHour);

      // 6. Deterministic Daily Explore Jitter [0, 1]
      const jitter = dailyExploreJitter(actorKey, s.id, manilaDay);

      // Base score
      let baseScore =
        0.3 * tasteScore +
        0.22 * proximityScore +
        0.18 * questAndSocial +
        0.15 * qualityAndCrowd +
        0.1 * intentOrTime +
        0.05 * jitter;

      // Explicit intent query boost so intent searches strongly prioritize matching destinations
      if (intentMatch) {
        baseScore += 0.5;
      }

      // 7. Novelty, Merit Breakout & Completion Multiplier
      const isVisited =
        taste.visitedSpotIds.has(s.id) || Boolean(s.quest_id && taste.completedQuestIds.has(s.quest_id));
      const isSaved = store.isSaved(q.userId || actorKey, s.id) || taste.savedSpotIds.has(s.id);
      const isLiked = store.isLiked(q.userId || actorKey, s.id) || taste.likedSpotIds.has(s.id);
      const views24h = taste.recentViewCounts24h.get(s.id) ?? 0;

      // Community Merit Audience Expansion (subject to 14-day global exhaustion and <2 views viewer exhaustion)
      const isViewerExhaustedForMerit = isVisited || (views24h >= 2 && !isSaved && !isLiked);
      const hasActivePopularMerit =
        !isViewerExhaustedForMerit && crowd.crowd_status !== 'estimated_busy' && merit.activeMeritPoints >= 4.0;
      if (hasActivePopularMerit) {
        const meritBreakoutBoost = Math.min(0.24, 0.08 * Math.log(1 + merit.activeMeritPoints));
        baseScore += meritBreakoutBoost;
      }

      let noveltyMultiplier = 1.0;
      if (isVisited && !q.search) {
        noveltyMultiplier = 0.3;
      } else if (isSaved && !isVisited) {
        noveltyMultiplier = 1.15;
      } else if (views24h >= 3 && !isSaved && !isLiked) {
        noveltyMultiplier = 0.65;
      }

      const finalScore = baseScore * noveltyMultiplier;

      // 8. Explainable Recommendation Reasons (truthful, prioritized)
      const reasons: string[] = [];
      const pushReason = (r: string) => {
        if (r && !reasons.includes(r)) reasons.push(r);
      };

      if (intentMatch && q.intent) {
        pushReason(`Matches ${q.intent}`);
      }
      if (profileUserId && isSaved && !isVisited) {
        pushReason('Saved in your wishlist');
      }
      if (profileUserId && friendHandles.length > 0) {
        pushReason(`Visited by ${friendHandles[0]}`);
      }
      if (profileUserId && similarSpot && !isVisited) {
        pushReason(`Because you liked ${similarSpot.name}`);
      }
      if (profileUserId && catWeight >= 0.4) {
        pushReason(`Matches your ${formatCategoryLabel(s.category)} interests`);
      } else if (profileUserId && maxTagWeight >= 0.5 && bestMatchedTag) {
        pushReason(`Matches your #${bestMatchedTag} interest`);
      }
      if (hasActivePopularMerit && merit.activeLikes >= 2) {
        pushReason(`Popular · ${merit.activeLikes} likes`);
      }
      if (hasUnclaimedQuest) {
        if (liveDistance !== undefined && liveDistance <= 15) {
          pushReason('Unclaimed Quest nearby');
        } else {
          pushReason('Quest available');
        }
      }
      if (!isVisited && crowd.crowd_status === 'quiet' && s.tags.includes('hidden_gem')) {
        pushReason(`Quiet Hidden Gem in ${s.municipality}`);
      } else if (crowd.crowd_status === 'quiet') {
        pushReason('Quiet now');
      }
      if (s.trust_level === 'lgu_verified') {
        pushReason('LGU verified');
      }
      if (liveDistance !== undefined) {
        pushReason(
          `${liveDistance < 1 ? Math.round(liveDistance * 1000) + ' m' : liveDistance.toFixed(1) + ' km'} away`,
        );
      }
      if (hasActivePopularMerit || (trendScore >= 2 && merit.activeMeritPoints > 0)) {
        pushReason(`Trending in ${s.municipality}`);
      }
      if (reasons.length === 0) {
        pushReason(`Explore ${s.municipality}`);
      }

      return {
        ...s,
        ...crowd,
        distance_km: liveDistance,
        recommendation_score: Number(finalScore.toFixed(4)),
        recommendation_reasons: reasons,
        saved: isSaved,
        liked: isLiked,
        trend_score: trendScore,
      };
    })
    .filter(
      (s) =>
        (!q.search ||
          `${s.name} ${s.description} ${s.tags.join(' ')}`.toLowerCase().includes(q.search.toLowerCase())) &&
        (!q.categories?.length || q.categories.includes(s.category)) &&
        (!q.tags?.length || q.tags.some((t) => s.tags.includes(t))) &&
        (!q.municipality || s.municipality.toLowerCase() === q.municipality.toLowerCase()) &&
        (!q.hasQuest || Boolean(s.quest_id)) &&
        (s.distance_km === undefined || !q.radius || s.distance_km <= q.radius),
    );

  // Initial sort
  scored.sort((a, b) => {
    if (sortMode === 'nearest') {
      return (a.distance_km ?? 999) - (b.distance_km ?? 999) || a.slug.localeCompare(b.slug);
    }
    if (sortMode === 'newest') {
      return Date.parse(b.created_at) - Date.parse(a.created_at) || a.slug.localeCompare(b.slug);
    }
    if (sortMode === 'trending') {
      return (
        b.trend_score - a.trend_score || b.recommendation_score - a.recommendation_score || a.slug.localeCompare(b.slug)
      );
    }
    return b.recommendation_score - a.recommendation_score || a.slug.localeCompare(b.slug);
  });

  // Apply MMR sliding-window diversity & 1-in-5 Hidden Gem slot on default 'recommended' sort
  const shouldDiversify =
    sortMode === 'recommended' && !q.search && (!q.categories || q.categories.length !== 1) && !q.municipality;

  const enableSerendipitySlot = shouldDiversify && !q.intent;
  const ranked = shouldDiversify ? applyExploreDiversity(scored, taste, enableSerendipitySlot) : scored;

  if (exploreCache.size >= 250) {
    const oldestKey = exploreCache.keys().next().value;
    if (oldestKey) exploreCache.delete(oldestKey);
  }
  exploreCache.set(cacheKey, {
    expiresAt: nowMs + EXPLORE_CACHE_TTL_MS,
    stateFingerprint,
    items: ranked,
  });

  const offset = Math.max(0, q.offset ?? 0);
  return q.limit !== undefined ? ranked.slice(offset, offset + q.limit) : ranked.slice(offset);
}

export const scoreAndRankSpots = rankExploreSpots;
