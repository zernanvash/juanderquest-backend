import { Router, Response } from 'express';
import { optionalAuthenticateToken, checkQAAuthorization, isAuthorizedQA, AuthRequest } from '../middleware/auth.js';
import { spotStore, Spot } from '../spots/store.js';
import { rankedFeedPage } from '../feed-pagination.js';

export const feedRouter = Router();

export interface FeedItem extends Spot {
  feed_score: number;
  recommendation_reasons: string[];
  crowd_status: string;
  crowd_confidence: string;
  saved: boolean;
}

// Applies municipal diversity spacing: at most 2 consecutive items from the same municipality
export function applyMunicipalDiversity<T extends { municipality: string }>(
  items: T[],
  maxConsecutive = 2
): T[] {
  if (items.length <= maxConsecutive) return [...items];

  const pool = [...items];
  const result: T[] = [];

  while (pool.length > 0) {
    let candidateIdx = 0;

    // Check if the first candidate violates the maxConsecutive rule
    const len = result.length;
    if (
      len >= maxConsecutive &&
      result
        .slice(len - maxConsecutive)
        .every((item) => item.municipality === pool[candidateIdx].municipality)
    ) {
      // Find the first item from a DIFFERENT municipality
      const avoidMuni = pool[candidateIdx].municipality;
      const alternativeIdx = pool.findIndex((item) => item.municipality !== avoidMuni);
      if (alternativeIdx !== -1) {
        candidateIdx = alternativeIdx;
      }
    }

    result.push(pool.splice(candidateIdx, 1)[0]);
  }

  return result;
}

feedRouter.get('/feed', optionalAuthenticateToken, checkQAAuthorization, (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  const prefs = userId ? spotStore.getPreferences(userId) : undefined;
  const hasUserPrefs =
    Boolean(prefs) &&
    ((prefs?.categories && prefs.categories.length > 0) ||
      (prefs?.tags && prefs.tags.length > 0) ||
      (prefs?.occasions && prefs.occasions.length > 0));

  const allowQA = isAuthorizedQA(req);

  // 1. Eligible Published & Non-suppressed Spots (strictly excluding synthetic test data unless authorized QA)
  const eligibleSpots = spotStore.spots.filter(
    (s) => s.status === 'published' && !s.recommendation_suppressed && (allowQA || !s.is_test)
  );

  // 2. Score Spots with Persisted Signals
  const scoredItems: FeedItem[] = eligibleSpots.map((spot) => {
    let score = 0;
    const reasons: string[] = [];

    // Trust signal
    if (spot.trust_level === 'lgu_verified') {
      score += 0.25;
      reasons.push('LGU Verified');
    } else if (spot.trust_level === 'editorial') {
      score += 0.2;
      reasons.push('Editorial Pick');
    } else if (spot.trust_level === 'open_data') {
      score += 0.15;
    } else {
      score += 0.1;
    }

    // Personalization signals (only when user has declared preferences)
    if (hasUserPrefs && prefs) {
      const matchedCat = prefs.categories.find((c) => c === spot.category);
      if (matchedCat) {
        score += 0.3;
        const formattedCat = matchedCat.replace(/_/g, ' ');
        reasons.push(`Matches your ${formattedCat} interest`);
      }

      const matchedTag = prefs.tags.find((t) => spot.tags.includes(t));
      if (matchedTag && reasons.length < 3) {
        score += 0.2;
        reasons.push(`Matches your #${matchedTag} interest`);
      }
    }

    // Trend & Interaction signals
    const trend = spotStore.trend(spot.id);
    if (trend > 0) {
      score += Math.min(0.2, trend / 10);
      if (trend >= 2 && reasons.length < 3) {
        reasons.push(`Trending in ${spot.municipality}`);
      }
    }

    // Freshness
    const ageDays = (Date.now() - Date.parse(spot.created_at)) / 86400000;
    if (ageDays <= 30) {
      score += 0.1;
      if (reasons.length < 3) {
        reasons.push('Recently added');
      }
    }

    // Active Quest
    if (spot.quest_id) {
      score += 0.05;
      if (reasons.length < 3) {
        reasons.push('Active quest available');
      }
    }

    // Crowd Condition
    const crowdInfo = spotStore.crowd(spot);
    if (crowdInfo.crowd_status === 'quiet' && reasons.length < 3) {
      score += 0.05;
      reasons.push('Currently quiet');
    }

    // Fallback reason for guests if none assigned
    if (reasons.length === 0) {
      reasons.push(`Explore ${spot.municipality}`);
    }

    return {
      ...spot,
      feed_score: Number(score.toFixed(4)),
      recommendation_reasons: reasons,
      crowd_status: crowdInfo.crowd_status,
      crowd_confidence: crowdInfo.crowd_confidence,
      saved: Boolean(spotStore.isSaved(userId, spot.id)),
    };
  });

  // 3. Initial Score Ordering (with stable slug tie-breaker)
  scoredItems.sort((a, b) => b.feed_score - a.feed_score || a.slug.localeCompare(b.slug));

  // 4. Municipal Diversity Reranking (Max 2 consecutive from same town)
  const diversifiedItems = applyMunicipalDiversity(scoredItems, 2);

  const requestedLimit = Number(req.query.limit) || 20;
  const limit = Math.min(50, Math.max(1, Math.floor(requestedLimit)));
  let page;
  try {
    page = rankedFeedPage(diversifiedItems, JSON.stringify([userId || 'guest', allowQA ? 'qa' : 'public']),
      typeof req.query.cursor === 'string' ? req.query.cursor : undefined, limit);
  } catch {
    return res.status(400).json({ success: false, error: {
      code: 'INVALID_CURSOR', message: 'This feed session has expired. Refresh to start a new feed.',
    } });
  }
  res.setHeader('Cache-Control', 'private, no-store');
  if (allowQA) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  }

  return res.status(200).json({
    success: true,
    data: page,
    meta: {
      ranking_version: 'feed-v2',
      personalized: Boolean(hasUserPrefs),
      guest_mode: !userId,
    },
  });
});
