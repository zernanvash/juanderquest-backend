import { db } from '../db/index.js';
import { MANILA_OFFSET_MS, manilaHour } from '../social/time.js';
import type { CrowdMetrics } from './crowd.js';
import { computeP95LogEngagers, spotQualityScore } from './quality.js';
import { blendExploreSlots, type BlendableSpotItem, type SlotBlendCandidate } from './slotBlender.js';
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
  // Plan 116 national scale: map viewport [west, south, east, north], admin area (town, barangay,
  // province or region id) and launch tier filters.
  bbox?: [number, number, number, number];
  areaId?: string;
  tier?: 'featured' | 'standard' | 'review';
  refreshSeed?: string;
}

// Plan 116: bounds that keep one Explore request cheap with a national catalogue.
// Small catalogues (tests, Pangasinan) never reach them, so ranking is unchanged there.
export const RANK_CANDIDATE_CAP = 2000; // spots scored per request
export const DIVERSITY_WINDOW = 300; // MMR diversity is O(n^2); apply it to the head only
export const CACHED_HEAD = 600; // ranked items kept per cache entry

export interface RankedPage {
  items: RankedSpotItem[];
  total: number;
}

export interface UserTasteProfile {
  userId?: string;
  hasSignals: boolean;
  categoryWeights: Map<string, number>;
  rawCategoryWeights: Map<string, number>;
  subcategoryWeights: Map<string, number>;
  rawSubcategoryWeights: Map<string, number>;
  tagWeights: Map<string, number>;
  municipalityWeights: Map<string, number>;
  rawMunicipalityWeights: Map<string, number>;
  interactionCount: number;
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
  const input = `${manilaDay}:${viewerKey || 'anon'}:${spotId}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0xffffffff;
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

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function buildUserTasteProfile(
  store: SpotStore,
  userId: string | undefined,
  nowMs: number = Date.now(),
): UserTasteProfile {
  const rawCategoryWeights = new Map<string, number>();
  const rawSubcategoryWeights = new Map<string, number>();
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
  let interactionCount = 0;

  if (!userId) {
    return {
      userId,
      hasSignals: false,
      categoryWeights: new Map(),
      rawCategoryWeights,
      subcategoryWeights: new Map(),
      rawSubcategoryWeights,
      tagWeights: new Map(),
      municipalityWeights: new Map(),
      rawMunicipalityWeights,
      interactionCount: 0,
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

  // 1. Persisted spot_interactions for viewer with 21-day half-life decay
  const userInteractions = store.interactions.get(userId);
  if (userInteractions) {
    for (const entry of userInteractions) {
      const sep = entry.lastIndexOf(':');
      if (sep <= 0) continue;
      const spotId = entry.slice(0, sep);
      const type = entry.slice(sep + 1);
      const spot = spotById.get(spotId);
      if (!spot) continue;

      const ts = store.interactionTimestamps.get(`${userId}:${spotId}:${type}`);
      const ageDays = ts && Number.isFinite(ts) ? Math.max(0, (nowMs - ts) / 86_400_000) : 0;
      const decay = Math.pow(0.5, ageDays / 21);

      if (type === 'visit') {
        interactionCount++;
        visitedSpotIds.add(spot.id);
        if (spot.quest_id) completedQuestIds.add(spot.quest_id);
        positiveSpotsById.set(spot.id, spot);
        addWeight(rawCategoryWeights, spot.category, 5.0 * decay);
        if (spot.subcategory) addWeight(rawSubcategoryWeights, spot.subcategory, 5.0 * decay);
        for (const t of spot.tags) addWeight(rawTagWeights, t, 4.0 * decay);
        addWeight(rawMunicipalityWeights, spot.municipality, 3.0 * decay);
        if (!lastActiveSpot) lastActiveSpot = spot;
      } else if (type === 'save') {
        interactionCount++;
        savedSpotIds.add(spot.id);
        positiveSpotsById.set(spot.id, spot);
        addWeight(rawCategoryWeights, spot.category, 3.0 * decay);
        if (spot.subcategory) addWeight(rawSubcategoryWeights, spot.subcategory, 3.0 * decay);
        for (const t of spot.tags) addWeight(rawTagWeights, t, 2.5 * decay);
        addWeight(rawMunicipalityWeights, spot.municipality, 2.0 * decay);
      } else if (type === 'directions') {
        interactionCount++;
        addWeight(rawCategoryWeights, spot.category, 3.0 * decay);
        if (spot.subcategory) addWeight(rawSubcategoryWeights, spot.subcategory, 3.0 * decay);
        for (const t of spot.tags) addWeight(rawTagWeights, t, 2.5 * decay);
        addWeight(rawMunicipalityWeights, spot.municipality, 2.0 * decay);
        if (!lastActiveSpot) lastActiveSpot = spot;
      } else if (type === 'like' || type === 'helpful') {
        interactionCount++;
        likedSpotIds.add(spot.id);
        positiveSpotsById.set(spot.id, spot);
        addWeight(rawCategoryWeights, spot.category, 2.0 * decay);
        if (spot.subcategory) addWeight(rawSubcategoryWeights, spot.subcategory, 2.0 * decay);
        for (const t of spot.tags) addWeight(rawTagWeights, t, 1.5 * decay);
        addWeight(rawMunicipalityWeights, spot.municipality, 1.0 * decay);
      } else if (type === 'view') {
        addWeight(rawCategoryWeights, spot.category, 0.5 * decay);
        if (spot.subcategory) addWeight(rawSubcategoryWeights, spot.subcategory, 0.5 * decay);
        for (const t of spot.tags) addWeight(rawTagWeights, t, 0.4 * decay);
        if (!lastActiveSpot) lastActiveSpot = spot;
      }
    }
  }

  // 2. Explicit onboarding preferences (2.5 when < 3 interactions, else 1.5)
  const prefs = store.preferences.get(userId);
  if (prefs) {
    const prefCatWeight = interactionCount < 3 ? 2.5 : 1.5;
    const prefTagWeight = interactionCount < 3 ? 2.0 : 1.2;
    for (const cat of prefs.categories || []) {
      addWeight(rawCategoryWeights, cat, prefCatWeight);
    }
    for (const tag of [...(prefs.tags || []), ...(prefs.occasions || [])]) {
      addWeight(rawTagWeights, tag, prefTagWeight);
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
  const subcategoryWeights = normalizeWeights(rawSubcategoryWeights);
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
    subcategoryWeights,
    rawSubcategoryWeights,
    tagWeights,
    municipalityWeights,
    rawMunicipalityWeights,
    interactionCount,
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
  like_count: number;
  trend_score: number;
}

export function applyExploreDiversity<T extends BlendableSpotItem = RankedSpotItem>(
  items: T[],
  taste: UserTasteProfile,
  enableSerendipitySlot: boolean,
  options?: { actorKey?: string; manilaDay?: string; refreshSeed?: string; preserveSlotOrder?: boolean },
): T[] {
  if (items.length <= 2) return [...items];

  const pool = [...items];
  const result: T[] = [];
  const gemSalt = `${options?.actorKey || 'anon'}:${options?.refreshSeed || ''}`;
  const gemDay = options?.manilaDay || manilaDayKey(Date.now());

  while (pool.length > 0) {
    const slotIdx = result.length;
    const prev1 = result[slotIdx - 1];
    const prev2 = result[slotIdx - 2];
    const prev3 = result[slotIdx - 3];
    const prev4 = result[slotIdx - 4];
    const a1 = prev1?.created_by;
    const a2 = prev2?.created_by;
    const a3 = prev3?.created_by;
    const a4 = prev4?.created_by;
    const hasRecentAuthor = Boolean(a1 || a2 || a3 || a4);
    const isRecentAuthor = (author?: string | null) =>
      Boolean(author && (author === a1 || author === a2 || author === a3 || author === a4));

    // 1-in-5 Serendipity / Hidden Gem slot (every 5th card: index 4, 9, 14...)
    // Collect top 5 eligible gems and rotate deterministically via dailyExploreJitter + refreshSeed.
    if (enableSerendipitySlot && slotIdx % 5 === 4 && pool.length > 1) {
      const gemIndices: number[] = [];
      for (let idx = 0; idx < pool.length && gemIndices.length < 5; idx++) {
        const c = pool[idx];
        if (taste.visitedSpotIds.has(c.id)) continue;
        if (c.crowd_status === 'estimated_busy') continue;
        if (prev1 && prev2 && prev1.municipality === c.municipality && prev2.municipality === c.municipality) {
          continue;
        }
        if (isRecentAuthor(c.created_by)) continue;
        const catWeight = taste.categoryWeights.get(c.category) ?? 0;
        const muniWeight = taste.municipalityWeights.get(c.municipality) ?? 0;
        const isUnderExplored = !taste.hasSignals || catWeight < 0.5 || muniWeight === 0;
        if (isUnderExplored && (c.crowd_status === 'quiet' || c.tags.includes('hidden_gem'))) {
          gemIndices.push(idx);
        }
      }

      if (gemIndices.length > 0) {
        let chosenGemIdx = gemIndices[0];
        if (gemIndices.length > 1) {
          let bestJitter = -Infinity;
          for (const gIdx of gemIndices) {
            const j = dailyExploreJitter(gemSalt, pool[gIdx].id, gemDay);
            if (j > bestJitter) {
              bestJitter = j;
              chosenGemIdx = gIdx;
            }
          }
        }
        const [gem] = pool.splice(chosenGemIdx, 1);
        const gemReason = `Quiet Hidden Gem in ${gem.municipality}`;
        if (gem.crowd_status === 'quiet' && !gem.recommendation_reasons.includes(gemReason)) {
          gem.recommendation_reasons = [gemReason, ...gem.recommendation_reasons];
        }
        result.push(gem);
        continue;
      }
    }

    const scanLimit = Math.min(pool.length, 48);
    let hasDifferentMuni = false;
    if (prev1 && prev2 && prev1.municipality === prev2.municipality) {
      for (let k = 0; k < pool.length; k++) {
        if (pool[k].municipality !== prev1.municipality) {
          hasDifferentMuni = true;
          break;
        }
      }
    }
    let hasDifferentCat = false;
    if (prev1 && prev2 && prev1.category === prev2.category) {
      for (let k = 0; k < scanLimit; k++) {
        if (pool[k].category !== prev1.category) {
          hasDifferentCat = true;
          break;
        }
      }
    }
    let hasDifferentAuthor = false;
    if (hasRecentAuthor) {
      for (let k = 0; k < pool.length; k++) {
        if (!isRecentAuthor(pool[k].created_by)) {
          hasDifferentAuthor = true;
          break;
        }
      }
    }

    let bestIdx = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < scanLimit; i++) {
      const cand = pool[i];
      let adj = options?.preserveSlotOrder ? 1 / (1 + i) : Math.max(0.0001, cand.recommendation_score);

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

      // R5 Author spacing guard: max 1 card per author in any 5-card window when alternatives exist
      if (hasDifferentAuthor && isRecentAuthor(cand.created_by)) {
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
  items: RankedSpotItem[]; // head of the ranking (≤ CACHED_HEAD)
  total: number; // all matches, for paging
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
  const spotsSig = `${store.spots.length}:${store.spots.map((s) => `${s.id}:${s.status}:${store.isSuppressed(s) ? 1 : 0}:${s.recommendation_suppressed_until || ''}`).join(',')}`;
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
  return rankExploreSpotsPage(store, q).items;
}

function matchesExploreFilters(s: Spot, q: ExploreListQuery): boolean {
  if (q.search && !`${s.name} ${s.description} ${s.tags.join(' ')}`.toLowerCase().includes(q.search.toLowerCase()))
    return false;
  if (q.categories?.length && !q.categories.includes(s.category)) return false;
  if (q.tags?.length && !q.tags.some((t) => s.tags.includes(t))) return false;
  if (q.municipality && s.municipality.toLowerCase() !== q.municipality.toLowerCase()) return false;
  if (q.hasQuest && !s.quest_id) return false;
  if (q.tier && s.launch_tier !== q.tier) return false;
  if (q.areaId && ![s.town_area_id, s.barangay_area_id, s.province_area_id, s.region_area_id].includes(q.areaId))
    return false;
  if (q.bbox) {
    const [west, south, east, north] = q.bbox;
    if (s.gps_lat < south || s.gps_lat > north || s.gps_lng < west || s.gps_lng > east) return false;
  }
  if (
    q.radius &&
    q.lat !== undefined &&
    q.lng !== undefined &&
    distanceKm(q.lat, q.lng, s.gps_lat, s.gps_lng) > q.radius
  )
    return false;
  return true;
}

// Deterministic, cheap prior used only to pick which spots to score when a request would
// otherwise score more than RANK_CANDIDATE_CAP (national catalogue, no location given).
function candidatePrior(s: Spot, trends: Map<string, number>): number {
  const trust = { lgu_verified: 0.45, editorial: 0.38, community: 0.3, open_data: 0.22 }[s.trust_level] ?? 0.1;
  const tier = s.launch_tier === 'featured' ? 0.3 : 0;
  return trust + tier + (s.quest_id ? 0.2 : 0) + Math.min(0.3, (trends.get(s.id) ?? 0) / 15);
}

export function rankExploreSpotsPage(store: SpotStore, q: ExploreListQuery): RankedPage {
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
    bbox: q.bbox ? q.bbox.map((v) => Number(v.toFixed(3))) : null,
    areaId: q.areaId || null,
    tier: q.tier || null,
    refreshSeed: q.refreshSeed || '',
    hourBucket: q.intent ? 'intent' : Math.floor(manilaHour(new Date(nowMs)) / 4),
  });

  const cacheKey = `${actorKey}|${manilaDay}|${filterKey}`;
  const stateFingerprint = computeStateFingerprint(store, profileUserId || q.userId, resolvedHomeTown);
  const cached = exploreCache.get(cacheKey);
  const requestedOffset = Math.max(0, q.offset ?? 0);
  const requestedEnd = q.limit !== undefined ? requestedOffset + q.limit : Math.max(CACHED_HEAD, requestedOffset);
  if (
    cached &&
    cached.expiresAt > nowMs &&
    cached.stateFingerprint === stateFingerprint &&
    // Only the head of each ranking is cached; deeper pages are recomputed.
    (requestedEnd <= cached.items.length || cached.items.length === cached.total)
  ) {
    // Other travelers' likes do not change the fingerprint, so like counts are always fresh.
    const freshLikes = store.likeCounts();
    const cloned = cached.items.slice(requestedOffset, requestedEnd).map((item) => ({
      ...item,
      recommendation_reasons: [...item.recommendation_reasons],
      like_count: store.likeCount(item.id, q.userId || actorKey, freshLikes),
    }));
    return { items: cloned, total: cached.total };
  }

  // Evict expired cache entries
  for (const [k, v] of exploreCache.entries()) {
    if (v.expiresAt <= nowMs) exploreCache.delete(k);
  }

  const taste = buildUserTasteProfile(store, profileUserId, nowMs);
  const prefs = profileUserId ? store.getPreferences(profileUserId) : undefined;
  const trends = store.trendScores();
  const likeCounts = store.likeCounts();
  const spotMerits = computeSpotMeritMap(store, nowMs);
  const bySpot = store.eventsBySpot();
  const currentHour = manilaHour(new Date(nowMs));

  // Tier 3 anchor town: users.home_municipality first; when NULL, top-affinity town
  const tier3Town = resolvedHomeTown || taste.topAffinityTowns[0] || null;
  const tier3Centroid =
    q.lat === undefined && !taste.lastActiveSpot && tier3Town
      ? computeTownCentroids(store.spots).get(tier3Town.toLowerCase())
      : undefined;

  // Plan 116: cheap filters run before scoring (same result, far less work).
  let eligibleSpots = store.spots.filter(
    (s) =>
      s.status === 'published' &&
      !store.isSuppressed(s, nowMs) &&
      (q.allowTest || !s.is_test) &&
      matchesExploreFilters(s, q),
  );
  let createdAtById: Map<string, number> | undefined;
  const total = eligibleSpots.length;
  if (eligibleSpots.length > RANK_CANDIDATE_CAP) {
    // Step 6: 2,000-spot candidate budget = 1,200 prior/anchor + 500 unseen/under-explored + 300 newest.
    const anchor =
      q.lat !== undefined && q.lng !== undefined
        ? { lat: q.lat, lng: q.lng }
        : taste.lastActiveSpot
          ? { lat: taste.lastActiveSpot.gps_lat, lng: taste.lastActiveSpot.gps_lng }
          : tier3Centroid;

    const priorSorted = anchor
      ? [...eligibleSpots]
          .map((s) => ({ s, d: distanceKm(anchor.lat, anchor.lng, s.gps_lat, s.gps_lng) }))
          .sort((a, b) => a.d - b.d || cmpStr(a.s.id, b.s.id))
          .map((x) => x.s)
      : [...eligibleSpots]
          .map((s) => ({ s, p: candidatePrior(s, trends) }))
          .sort((a, b) => b.p - a.p || cmpStr(a.s.id, b.s.id))
          .map((x) => x.s);

    const selected = new Map<string, Spot>();
    for (const s of priorSorted.slice(0, 1200)) {
      selected.set(s.id, s);
    }

    let underAdded = 0;
    for (const s of eligibleSpots) {
      if (underAdded >= 500) break;
      if (selected.has(s.id)) continue;
      const isVisited =
        taste.visitedSpotIds.has(s.id) || Boolean(s.quest_id && taste.completedQuestIds.has(s.quest_id));
      const isSaved = store.isSaved(q.userId || actorKey, s.id) || taste.savedSpotIds.has(s.id);
      const catW = taste.categoryWeights.get(s.category) ?? 0;
      const muniW = taste.municipalityWeights.get(s.municipality) ?? 0;
      if (!isVisited && !isSaved && (catW < 0.35 || muniW < 0.25)) {
        selected.set(s.id, s);
        underAdded++;
      }
    }

    const tsMap = new Map<string, number>();
    for (const s of eligibleSpots) {
      tsMap.set(s.id, Date.parse(s.created_at) || 0);
    }
    createdAtById = tsMap;
    const newestSorted = [...eligibleSpots].sort(
      (a, b) => (tsMap.get(b.id) ?? 0) - (tsMap.get(a.id) ?? 0) || cmpStr(a.id, b.id),
    );
    let newestAdded = 0;
    for (const s of newestSorted) {
      if (newestAdded >= 300) break;
      if (selected.has(s.id)) continue;
      selected.set(s.id, s);
      newestAdded++;
    }

    if (selected.size < RANK_CANDIDATE_CAP) {
      for (const s of priorSorted) {
        if (selected.size >= RANK_CANDIDATE_CAP) break;
        if (!selected.has(s.id)) selected.set(s.id, s);
      }
    }

    eligibleSpots = [...selected.values()];
  }

  const engagerCounts = store.uniqueEngagerCounts();
  const p95LogEngagers = computeP95LogEngagers(engagerCounts.values());
  const viewerKey = q.userId || actorKey;
  const viewerIsTest = Boolean(viewerKey && db.findUserById(viewerKey)?.is_test);
  const viewerInteractions = store.interactions.get(viewerKey);
  const isR4Default =
    sortMode === 'recommended' &&
    !q.search &&
    !q.intent &&
    (!q.categories || q.categories.length !== 1) &&
    !q.municipality;
  interface ScoredDraft extends BlendableSpotItem {
    spot: Spot;
    crowd: CrowdMetrics;
    distance_km: number | undefined;
    saved: boolean;
    liked: boolean;
    like_count: number;
    trend_score: number;
    createdAtStr: string;
    intentMatch: boolean;
    isVisited: boolean;
    friendHandles: string[];
    similarSpot: Spot | undefined;
    catWeight: number;
    maxTagWeight: number;
    bestMatchedTag: string | undefined;
    hasActivePopularMerit: boolean;
    activeLikes: number;
    activeMeritPoints: number;
    hasUnclaimedQuest: boolean;
  }

  const blendCandidates: SlotBlendCandidate<ScoredDraft>[] = [];
  const emptyCrowdCache = new Map<string, ReturnType<typeof store.crowd>>();

  const scored = eligibleSpots.map((s): ScoredDraft => {
    const trendScore = trends.get(s.id) ?? 0;
    const merit = spotMerits.get(s.id) ?? { activeLikes: 0, activeMeritPoints: 0 };
    const spotEvents = bySpot.get(s.id);
    let crowd;
    if (spotEvents && spotEvents.length > 0) {
      crowd = store.crowd(s, nowMs, bySpot);
    } else {
      const band = s.crowd_capacity_band || 'medium';
      crowd = emptyCrowdCache.get(band);
      if (!crowd) {
        crowd = store.crowd(s, nowMs, bySpot);
        emptyCrowdCache.set(band, crowd);
      }
    }
    const liveDistance =
      q.lat !== undefined && q.lng !== undefined ? distanceKm(q.lat, q.lng, s.gps_lat, s.gps_lng) : undefined;

    // 1. Taste Score [0, 1] (Step 2: 0.5*cat + 0.3*tag + 0.2*subcategory; no muniWeight)
    let tasteScore = 0.3;
    const catWeight = taste.categoryWeights.get(s.category) ?? 0;
    const subcatWeight = s.subcategory ? (taste.subcategoryWeights.get(s.subcategory) ?? 0) : 0;
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
      tasteScore = 0.5 * catWeight + 0.3 * maxTagWeight + 0.2 * subcatWeight;
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

    // 4. Quality & Crowd Score [0, 1] (Step 1: spotQuality replaces trustBase; no freshnessBoost)
    const photoCount = store.photoCounts.get(s.id) ?? 0;
    const qualityScoreVal = spotQualityScore(
      s,
      engagerCounts.get(s.id) ?? 0,
      p95LogEngagers,
      store.upheldReportCounts.get(s.id) ?? 0,
      photoCount,
    );
    const crowdMod =
      crowd.crowd_status === 'quiet'
        ? 0.25
        : crowd.crowd_status === 'moderate'
          ? 0.15
          : crowd.crowd_status === 'estimated_busy'
            ? -0.2
            : 0.1;
    const trendNorm = Math.min(0.3, trendScore / 15);
    const createdTs = createdAtById?.get(s.id) ?? Date.parse(s.created_at);
    const ageDays = Math.max(0, (nowMs - createdTs) / 86_400_000);
    const qualityAndCrowd = Math.max(0, Math.min(1, 0.6 * qualityScoreVal + crowdMod + trendNorm));

    // 5. Intent or Time-of-Day Score [0, 1]
    const intentQuery = (q.intent || '').trim().toLowerCase();
    const intentMatch =
      intentQuery.length > 0 &&
      [s.category, s.subcategory, ...s.tags, s.name].some((v) => v.toLowerCase().includes(intentQuery));
    const intentOrTime = intentQuery.length > 0 ? (intentMatch ? 1.0 : 0.0) : computeTimeOfDayBoost(s, currentHour);

    // 6. Deterministic Daily Explore Jitter [0, 1]
    const jitter = dailyExploreJitter(`${actorKey}:${q.refreshSeed || ''}`, s.id, manilaDay);

    // Base score (Step 2: when no live GPS, proximity 0.22->0.14 and qualityAndCrowd 0.15->0.23)
    const proxWeight = liveDistance !== undefined ? 0.22 : 0.14;
    const qualWeight = liveDistance !== undefined ? 0.15 : 0.23;
    let baseScore =
      0.3 * tasteScore +
      proxWeight * proximityScore +
      0.18 * questAndSocial +
      qualWeight * qualityAndCrowd +
      0.1 * intentOrTime +
      0.05 * jitter;

    // Explicit intent query boost so intent searches strongly prioritize matching destinations
    if (intentMatch) {
      baseScore += 0.5;
    }

    // 7. Novelty, Merit Breakout & Completion Multiplier
    const isVisited = taste.visitedSpotIds.has(s.id) || Boolean(s.quest_id && taste.completedQuestIds.has(s.quest_id));
    const isSaved = Boolean(viewerInteractions?.has(`${s.id}:save`)) || taste.savedSpotIds.has(s.id);
    const isLiked = Boolean(viewerInteractions?.has(`${s.id}:like`)) || taste.likedSpotIds.has(s.id);
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
    } else if (isR4Default && isSaved && !isVisited) {
      noveltyMultiplier = 0.55;
    } else if (isR4Default && isLiked && !isSaved && !isVisited) {
      noveltyMultiplier = 0.7;
    } else if (views24h >= 3 && !isSaved && !isLiked) {
      noveltyMultiplier = 0.65;
    }

    const finalScore = baseScore * noveltyMultiplier;

    const draft: ScoredDraft = {
      id: s.id,
      slug: s.slug,
      description: s.description,
      category: s.category,
      municipality: s.municipality,
      crowd_status: crowd.crowd_status,
      created_by: s.created_by,
      tags: s.tags,
      recommendation_score: Math.round(finalScore * 10000) / 10000,
      recommendation_reasons: [],
      spot: s,
      crowd,
      distance_km: liveDistance,
      saved: isSaved,
      liked: isLiked,
      like_count: (likeCounts.get(s.id) ?? 0) + (viewerIsTest && isLiked ? 1 : 0),
      trend_score: trendScore,
      createdAtStr: s.created_at,
      intentMatch,
      isVisited,
      friendHandles,
      similarSpot,
      catWeight,
      maxTagWeight,
      bestMatchedTag,
      hasActivePopularMerit,
      activeLikes: merit.activeLikes,
      activeMeritPoints: merit.activeMeritPoints,
      hasUnclaimedQuest,
    };
    if (isR4Default) {
      blendCandidates.push({
        item: draft,
        qualityScore: qualityScoreVal,
        tasteScore,
        ageDays,
        hasPhoto: Boolean(s.image_url && s.image_url.trim().length > 0) || photoCount > 0,
        isVisited,
        isSaved,
        isLiked,
        views24h,
        catWeight,
        townAffinity: muniWeight,
        seedJitter: jitter,
      });
    }
    return draft;
  });

  // Initial sort
  if (sortMode !== 'recommended' || !isR4Default) {
    scored.sort((a, b) => {
      if (sortMode === 'nearest') {
        return (a.distance_km ?? 999) - (b.distance_km ?? 999) || cmpStr(a.slug, b.slug);
      }
      if (sortMode === 'newest') {
        return Date.parse(b.createdAtStr) - Date.parse(a.createdAtStr) || cmpStr(a.slug, b.slug);
      }
      if (sortMode === 'trending') {
        return (
          b.trend_score - a.trend_score || b.recommendation_score - a.recommendation_score || cmpStr(a.slug, b.slug)
        );
      }
      return b.recommendation_score - a.recommendation_score || cmpStr(a.slug, b.slug);
    });
  }

  // Apply Slot Blending (Interest 50%, Discovery 30%, New 20%) + MMR diversity under R4
  const shouldDiversify =
    sortMode === 'recommended' && !q.search && (!q.categories || q.categories.length !== 1) && !q.municipality;

  const enableSerendipitySlot = shouldDiversify && !q.intent;
  const diversityOpts = { actorKey, manilaDay, refreshSeed: q.refreshSeed };
  if (isR4Default) {
    blendCandidates.sort(
      (a, b) => b.item.recommendation_score - a.item.recommendation_score || cmpStr(a.item.slug, b.item.slug),
    );
  }
  const rankedDrafts = isR4Default
    ? blendExploreSlots({
        candidates: blendCandidates,
        headLimit: Math.max(DIVERSITY_WINDOW, requestedEnd),
        taste,
        formatCategoryLabel,
        applyDiversity: (items) => [
          ...applyExploreDiversity(items.slice(0, DIVERSITY_WINDOW), taste, enableSerendipitySlot, {
            ...diversityOpts,
            preserveSlotOrder: true,
          }),
          ...items.slice(DIVERSITY_WINDOW),
        ],
      })
    : shouldDiversify
      ? [
          ...applyExploreDiversity(scored.slice(0, DIVERSITY_WINDOW), taste, enableSerendipitySlot, diversityOpts),
          ...scored.slice(DIVERSITY_WINDOW),
        ]
      : scored;

  // 8. Materialize RankedSpotItem & populate explainable reasons ONLY for cached head / requested window
  const materializeLimit = Math.min(rankedDrafts.length, Math.max(CACHED_HEAD, requestedEnd));
  const ranked: RankedSpotItem[] = new Array(materializeLimit);
  for (let i = 0; i < materializeLimit; i++) {
    const d = rankedDrafts[i];
    const reasons = d.recommendation_reasons;
    const pushReason = (r: string) => {
      if (r && !reasons.includes(r)) reasons.push(r);
    };
    if (d.intentMatch && q.intent) {
      pushReason(`Matches ${q.intent}`);
    }
    if (profileUserId && d.saved && !d.isVisited) {
      pushReason('Saved in your wishlist');
    }
    if (profileUserId && d.friendHandles.length > 0) {
      pushReason(`Visited by ${d.friendHandles[0]}`);
    }
    if (profileUserId && d.similarSpot && !d.isVisited) {
      pushReason(`Because you liked ${d.similarSpot.name}`);
    }
    if (profileUserId && d.catWeight >= 0.4) {
      pushReason(`Matches your ${formatCategoryLabel(d.category)} interests`);
    } else if (profileUserId && d.maxTagWeight >= 0.5 && d.bestMatchedTag) {
      pushReason(`Matches your #${d.bestMatchedTag} interest`);
    }
    if (d.hasActivePopularMerit && d.activeLikes >= 2) {
      pushReason(`Popular · ${d.activeLikes} likes`);
    }
    if (d.hasUnclaimedQuest) {
      if (d.distance_km !== undefined && d.distance_km <= 15) {
        pushReason('Unclaimed Quest nearby');
      } else {
        pushReason('Quest available');
      }
    }
    if (!d.isVisited && d.crowd_status === 'quiet' && d.tags.includes('hidden_gem')) {
      pushReason(`Quiet Hidden Gem in ${d.municipality}`);
    } else if (d.crowd_status === 'quiet') {
      pushReason('Quiet now');
    }
    if (d.spot.trust_level === 'lgu_verified') {
      pushReason('LGU verified');
    }
    if (d.distance_km !== undefined) {
      pushReason(
        `${d.distance_km < 1 ? Math.round(d.distance_km * 1000) + ' m' : d.distance_km.toFixed(1) + ' km'} away`,
      );
    }
    if (d.hasActivePopularMerit || (d.trend_score >= 2 && d.activeMeritPoints > 0)) {
      pushReason(`Trending in ${d.municipality}`);
    }
    if (reasons.length === 0) {
      pushReason(`Explore ${d.municipality}`);
    }

    ranked[i] = {
      ...d.spot,
      ...d.crowd,
      distance_km: d.distance_km,
      recommendation_score: d.recommendation_score,
      recommendation_reasons: reasons,
      saved: d.saved,
      liked: d.liked,
      like_count: d.like_count,
      trend_score: d.trend_score,
    };
  }

  if (exploreCache.size >= 250) {
    const oldestKey = exploreCache.keys().next().value;
    if (oldestKey) exploreCache.delete(oldestKey);
  }
  exploreCache.set(cacheKey, {
    expiresAt: nowMs + EXPLORE_CACHE_TTL_MS,
    stateFingerprint,
    items: ranked.slice(0, CACHED_HEAD),
    total,
  });

  return { items: ranked.slice(requestedOffset, requestedEnd), total };
}

export const scoreAndRankSpots = rankExploreSpots;
