import type { UserTasteProfile } from './recommender.js';

export interface BlendableSpotItem {
  id: string;
  slug: string;
  description: string;
  category: string;
  municipality: string;
  crowd_status: string;
  created_by?: string | null;
  recommendation_score: number;
  recommendation_reasons: string[];
  tags: string[];
}

export interface SlotBlendCandidate<T extends BlendableSpotItem = BlendableSpotItem> {
  item: T;
  qualityScore: number;
  tasteScore: number;
  ageDays: number;
  hasPhoto: boolean;
  isVisited: boolean;
  isSaved: boolean;
  isLiked: boolean;
  views24h: number;
  catWeight: number;
  townAffinity: number;
  seedJitter: number;
}

export interface SlotBlendOptions<T extends BlendableSpotItem = BlendableSpotItem> {
  candidates: SlotBlendCandidate<T>[];
  taste: UserTasteProfile;
  formatCategoryLabel: (category: string) => string;
  applyDiversity: (items: T[]) => T[];
}

function slotTypeForIndex(index: number): 'interest' | 'discovery' | 'new' {
  const m = index % 10;
  if (m === 1 || m === 5 || m === 9) return 'discovery';
  if (m === 3 || m === 7) return 'new';
  return 'interest';
}

function prependReason(item: BlendableSpotItem, reason: string) {
  if (!reason) return;
  if (!item.recommendation_reasons.includes(reason)) {
    item.recommendation_reasons = [reason, ...item.recommendation_reasons];
  }
}

/**
 * Partition scored spots into disjoint Interest (50%: 0,2,4,6,8),
 * Discovery (30%: 1,5,9) and New (20%: 3,7) pools, blend them by global
 * mod-10 index, and run post-blend diversity.
 */
export function blendExploreSlots<T extends BlendableSpotItem>(
  opts: SlotBlendOptions<T> & { headLimit?: number },
): T[] {
  const { candidates, formatCategoryLabel, applyDiversity, headLimit = 300 } = opts;
  const total = candidates.length;
  if (total === 0) return [];
  const blendCount = Math.min(total, Math.max(1, headLimit));

  // `candidates` is already sorted by Interest (recommendation_score DESC, slug ASC).
  const sortedByInterest = candidates;

  // Preserve the #1 overall Interest pick for slot 0 when there is more than one spot.
  const topInterestId = total > 1 ? sortedByInterest[0].item.id : null;
  const assigned = new Set<string>();

  // 1. New pool (slots 3, 7 -> 20% of head): <= 14d (expand to <= 21d if < 2 qualify),
  // photo or description >= 40 chars, not visited, R5 1 per author per 10-card page.
  const maxNewNeeded = Math.max(2, Math.ceil(blendCount * 0.2));
  const isNewEligible = (c: SlotBlendCandidate<T>, maxAgeDays: number) =>
    !c.isVisited && c.ageDays <= maxAgeDays && (c.hasPhoto || (c.item.description || '').trim().length >= 40);

  let rawNew = candidates.filter((c) => isNewEligible(c, 14));
  if (rawNew.length < 2) {
    rawNew = candidates.filter((c) => isNewEligible(c, 21));
  }

  const scoredNew = rawNew
    .filter((c) => c.item.id !== topInterestId || rawNew.length === 1)
    .map((c) => ({
      c,
      newScore: 0.65 * Math.exp(-c.ageDays / 5) + 0.25 * c.tasteScore + 0.1 * c.qualityScore,
    }))
    .sort(
      (a, b) => b.newScore - a.newScore || (a.c.item.slug < b.c.item.slug ? -1 : a.c.item.slug > b.c.item.slug ? 1 : 0),
    );

  const newPool: SlotBlendCandidate<T>[] = [];
  const newAuthorPages = new Map<string, number>(); // author -> count in current 10-card block
  const deferredNew: SlotBlendCandidate<T>[] = [];

  for (const { c } of scoredNew) {
    if (newPool.length >= maxNewNeeded) break;
    const author = c.item.created_by;
    const blockIdx = Math.floor(newPool.length / 2); // 2 New slots per 10-card page
    const blockKey = author ? `${blockIdx}:${author}` : null;
    if (blockKey && (newAuthorPages.get(blockKey) ?? 0) >= 1) {
      deferredNew.push(c);
      continue;
    }
    if (blockKey) newAuthorPages.set(blockKey, (newAuthorPages.get(blockKey) ?? 0) + 1);
    newPool.push(c);
    assigned.add(c.item.id);
  }
  // Only fill remaining New slots with deferred same-author items if we have no other authors left
  // and still need items to avoid leaving a page short (R5: "when alternatives exist").
  if (newPool.length < maxNewNeeded) {
    for (const c of deferredNew) {
      if (newPool.length >= maxNewNeeded) break;
      if (assigned.has(c.item.id)) continue;
      // Only relax R5 if no other author is available in the entire New pool;
      // keeping per-page author cap strict when >=2 slots already filled or alternatives exist.
      const author = c.item.created_by;
      const blockIdx = Math.floor(newPool.length / 2);
      const alreadyInBlock = author
        ? newPool.slice(blockIdx * 2, blockIdx * 2 + 2).some((p) => p.item.created_by === author)
        : false;
      if (alreadyInBlock) continue;
      newPool.push(c);
      assigned.add(c.item.id);
    }
  }

  // 2. Discovery pool (slots 1, 5, 9 -> 30% of head):
  // not visited, not saved, not estimated_busy, (catWeight < 0.35 || townAffinity < 0.25).
  const maxDiscoveryNeeded = Math.max(3, Math.ceil(blendCount * 0.3));
  const rawDiscovery = candidates.filter(
    (c) =>
      !assigned.has(c.item.id) &&
      !c.isVisited &&
      !c.isSaved &&
      c.item.crowd_status !== 'estimated_busy' &&
      (c.catWeight < 0.35 || c.townAffinity < 0.25),
  );

  const scoredDiscovery = rawDiscovery
    .filter((c) => c.item.id !== topInterestId || rawDiscovery.length === 1)
    .map((c) => {
      const underExplored = Math.max(0, Math.min(1, 0.5 * (1 - c.catWeight) + 0.5 * (1 - c.townAffinity)));
      const novelty = c.isLiked ? 0.5 : c.views24h >= 3 ? 0.4 : 1.0;
      const discoveryScore = 0.45 * c.qualityScore + 0.3 * underExplored + 0.15 * novelty + 0.1 * c.seedJitter;
      return { c, discoveryScore };
    })
    .sort(
      (a, b) =>
        b.discoveryScore - a.discoveryScore ||
        (a.c.item.slug < b.c.item.slug ? -1 : a.c.item.slug > b.c.item.slug ? 1 : 0),
    );

  const discoveryPool: SlotBlendCandidate<T>[] = [];
  for (const { c } of scoredDiscovery) {
    if (discoveryPool.length >= maxDiscoveryNeeded) break;
    discoveryPool.push(c);
    assigned.add(c.item.id);
  }

  // 3. Interest pool: only need up to blendCount items in Interest order.
  const interestPool: SlotBlendCandidate<T>[] = [];
  for (let i = 0; i < sortedByInterest.length && interestPool.length < blendCount; i++) {
    const c = sortedByInterest[i];
    if (!assigned.has(c.item.id)) interestPool.push(c);
  }

  // 4. Interleave by global mod-10 slot position with fallbacks:
  // New -> Discovery -> Interest; Discovery -> Interest; Interest -> Discovery -> New.
  const blended: T[] = [];
  let iIdx = 0;
  let dIdx = 0;
  let nIdx = 0;

  const takeInterest = () => (iIdx < interestPool.length ? interestPool[iIdx++] : undefined);
  const takeDiscovery = (annotate: boolean) => {
    if (dIdx >= discoveryPool.length) return undefined;
    const picked = discoveryPool[dIdx++];
    if (annotate) {
      const reason =
        picked.townAffinity < 0.25
          ? `Discover ${picked.item.municipality}`
          : `Try ${formatCategoryLabel(picked.item.category)}`;
      prependReason(picked.item, reason);
    }
    return picked;
  };
  const takeNew = (annotate: boolean) => {
    if (nIdx >= newPool.length) return undefined;
    const picked = newPool[nIdx++];
    if (annotate) {
      prependReason(picked.item, picked.ageDays <= 7 ? 'New on JuanderQuest' : 'Posted recently');
    }
    return picked;
  };

  for (let slotIdx = 0; slotIdx < blendCount; slotIdx++) {
    const kind = slotTypeForIndex(slotIdx);
    let chosen: SlotBlendCandidate<T> | undefined;

    if (kind === 'new') {
      chosen = takeNew(true) ?? takeDiscovery(true) ?? takeInterest();
    } else if (kind === 'discovery') {
      chosen = takeDiscovery(true) ?? takeInterest() ?? takeNew(false);
    } else {
      chosen = takeInterest() ?? takeDiscovery(false) ?? takeNew(false);
    }

    if (!chosen) break;
    blended.push(chosen.item);
  }

  const diversifiedHead = applyDiversity(blended);
  if (blendCount >= total) return diversifiedHead;

  const usedInHead = new Set(diversifiedHead.map((i) => i.id));
  const tail: T[] = [];
  const tailCap = Math.max(600, blendCount) - diversifiedHead.length;
  for (let i = 0; i < sortedByInterest.length && tail.length < tailCap; i++) {
    const c = sortedByInterest[i];
    if (!usedInHead.has(c.item.id)) tail.push(c.item);
  }
  return [...diversifiedHead, ...tail];
}
