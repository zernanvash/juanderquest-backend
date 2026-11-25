import { Router, Response } from 'express';
import { optionalAuthenticateToken, checkQAAuthorization, isAuthorizedQA, AuthRequest } from '../middleware/auth.js';
import { rankExploreSpotsPage } from '../spots/recommender.js';
import { spotStore, Spot } from '../spots/store.js';
import { rankedFeedPage } from '../feed-pagination.js';

export const feedRouter = Router();

export interface FeedItem extends Spot {
  feed_score: number;
  recommendation_reasons: string[];
  crowd_status: string;
  crowd_confidence: string;
  saved: boolean;
  liked: boolean;
  like_count: number;
}

// Applies municipal diversity spacing: at most 2 consecutive items from the same municipality
export function applyMunicipalDiversity<T extends { municipality: string }>(items: T[], maxConsecutive = 2): T[] {
  if (items.length <= maxConsecutive) return [...items];

  const pool = [...items];
  const result: T[] = [];

  while (pool.length > 0) {
    let candidateIdx = 0;

    // Check if the first candidate violates the maxConsecutive rule
    const len = result.length;
    if (
      len >= maxConsecutive &&
      result.slice(len - maxConsecutive).every((item) => item.municipality === pool[candidateIdx].municipality)
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
  const actorId =
    req.user?.id || (req.headers['x-device-id'] as string) || (req.headers['x-forwarded-for'] as string) || req.ip;
  const rawRefreshSeed = req.query.refresh_seed;
  const refreshSeed = typeof rawRefreshSeed === 'string' && rawRefreshSeed.length > 0 ? rawRefreshSeed : undefined;
  if (refreshSeed !== undefined && !/^[A-Za-z0-9_-]{1,32}$/.test(refreshSeed)) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'refresh_seed must match ^[A-Za-z0-9_-]{1,32}$.',
      },
    });
  }

  const prefs = userId ? spotStore.getPreferences(userId) : undefined;
  const hasUserPrefs =
    Boolean(prefs) &&
    ((prefs?.categories && prefs.categories.length > 0) ||
      (prefs?.tags && prefs.tags.length > 0) ||
      (prefs?.occasions && prefs.occasions.length > 0));

  const allowQA = isAuthorizedQA(req);

  // Step 7: Web parity — rank via rankExploreSpotsPage (Explore v3) and map to FeedItem shape.
  const ranked = rankExploreSpotsPage(spotStore, {
    sort: 'recommended',
    userId,
    actorId,
    allowTest: allowQA,
    refreshSeed,
    offset: 0,
    limit: 600,
  });

  const diversifiedItems: FeedItem[] = ranked.items.map((item) => ({
    ...item,
    feed_score: item.recommendation_score,
    recommendation_reasons: item.recommendation_reasons.slice(0, 3),
    crowd_status: item.crowd_status,
    crowd_confidence: item.crowd_confidence,
    saved: item.saved,
    liked: item.liked,
    like_count: item.like_count,
  }));

  const requestedLimit = Number(req.query.limit) || 20;
  const limit = Math.min(50, Math.max(1, Math.floor(requestedLimit)));
  let page;
  try {
    page = rankedFeedPage(
      diversifiedItems,
      JSON.stringify([userId || 'guest', allowQA ? 'qa' : 'public', refreshSeed || '']),
      typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
      limit,
    );
  } catch {
    return res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_CURSOR',
        message: 'This feed session has expired. Refresh to start a new feed.',
      },
    });
  }
  res.setHeader('Cache-Control', 'private, no-store');
  if (allowQA) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  }

  return res.status(200).json({
    success: true,
    data: page,
    meta: {
      ranking_version: 'feed-v3',
      personalized: Boolean(hasUserPrefs),
      guest_mode: !userId,
    },
  });
});
