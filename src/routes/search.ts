import { Router, Response } from 'express';
import { db } from '../db/index.js';
import { spotStore } from '../spots/store.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { optionalAuthenticateToken, checkQAAuthorization, isAuthorizedQA, AuthRequest } from '../middleware/auth.js';

export const searchRouter = Router();

const searchRateLimiter = rateLimit({ policyId: 'search:query', windowMs: 60 * 1000, max: 180, keyStrategy: 'ip' });

export interface PlaceResultItem {
  id: string;
  slug: string;
  name: string;
  municipality: string;
  category: string;
  image_url: string;
  score: number;
}

export interface PersonResultItem {
  id: string;
  display_name: string;
  handle: string | null;
  avatar_url: string;
  bio: string | null;
  status_text: string | null;
  score: number;
}

export interface QuestResultItem {
  id: string;
  title: string;
  location_name: string;
  category: string;
  reward_points: number;
  score: number;
}

export type SearchResultItem =
  | ({ type: 'place' } & PlaceResultItem)
  | ({ type: 'person' } & PersonResultItem)
  | ({ type: 'quest' } & QuestResultItem);

export interface SearchGroup {
  type: 'places' | 'people' | 'quests';
  items: Array<PlaceResultItem | PersonResultItem | QuestResultItem>;
  has_more: boolean;
  total_matches?: number;
}

// Search candidates helper functions
function searchPlaces(query: string, allowTest: boolean = false): PlaceResultItem[] {
  const qLower = query.toLowerCase();
  const results: PlaceResultItem[] = [];

  for (const spot of spotStore.spots) {
    if (spot.status !== 'published') continue;
    if (!allowTest && spot.is_test) continue;
    let score = 0;
    const nameLower = spot.name.toLowerCase();
    const muniLower = spot.municipality.toLowerCase();
    const catLower = spot.category.toLowerCase();
    const subLower = spot.subcategory.toLowerCase();
    const tagsLower = spot.tags.map((t) => t.toLowerCase()).join(' ');

    if (nameLower === qLower) score = 1.0;
    else if (nameLower.startsWith(qLower)) score = 0.95;
    else if (nameLower.includes(qLower)) score = 0.85;
    else if (muniLower === qLower) score = 0.8;
    else if (muniLower.includes(qLower)) score = 0.75;
    else if (catLower.includes(qLower) || subLower.includes(qLower)) score = 0.7;
    else if (tagsLower.includes(qLower)) score = 0.65;
    else if (spot.description.toLowerCase().includes(qLower)) score = 0.5;

    if (score > 0) {
      results.push({
        id: spot.id,
        slug: spot.slug,
        name: spot.name,
        municipality: spot.municipality,
        category: spot.category,
        image_url: spot.image_url || '',
        score: Number(score.toFixed(2)),
      });
    }
  }

  return results.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

async function searchPeople(query: string, isHandleIntent: boolean, allowTest: boolean = false): Promise<PersonResultItem[]> {
  if (db.usersRepo.getPool()) {
    return await db.usersRepo.searchPeople(query, isHandleIntent, allowTest);
  }

  const qLower = query.toLowerCase();
  const results: PersonResultItem[] = [];

  for (const user of db.users) {
    if (!user.is_public) continue; // Privacy rule: only explicitly public travelers
    if (!allowTest && user.is_test) continue;
    let score = 0;
    const nameLower = user.display_name.toLowerCase();
    const handleLower = (user.handle || '').toLowerCase();
    const bioLower = (user.bio || '').toLowerCase();
    const statusLower = (user.status_text || '').toLowerCase();

    if (handleLower && handleLower === qLower) score = isHandleIntent ? 1.0 : 0.95;
    else if (nameLower === qLower) score = isHandleIntent ? 0.9 : 1.0;
    else if (handleLower && handleLower.startsWith(qLower)) score = isHandleIntent ? 0.95 : 0.85;
    else if (nameLower.startsWith(qLower)) score = isHandleIntent ? 0.85 : 0.9;
    else if (handleLower && handleLower.includes(qLower)) score = 0.75;
    else if (nameLower.includes(qLower)) score = 0.7;
    else if (statusLower.includes(qLower) || bioLower.includes(qLower)) score = 0.45;

    if (score > 0) {
      results.push({
        id: user.id,
        display_name: user.display_name,
        handle: user.handle || null,
        avatar_url: user.avatar_url,
        bio: user.bio || null,
        status_text: user.status_text || null,
        score: Number(score.toFixed(2)),
      });
    }
  }

  return results.sort((a, b) => b.score - a.score || a.display_name.localeCompare(b.display_name));
}

function searchQuests(query: string, allowTest: boolean = false): QuestResultItem[] {
  const qLower = query.toLowerCase();
  const results: QuestResultItem[] = [];

  for (const quest of db.quests) {
    if (!quest.is_active) continue;
    if (!allowTest && quest.is_test) continue;
    let score = 0;
    const titleLower = quest.title.toLowerCase();
    const locLower = quest.location_name.toLowerCase();
    const catLower = quest.category.toLowerCase();
    const descLower = quest.description.toLowerCase();

    if (titleLower === qLower) score = 1.0;
    else if (titleLower.startsWith(qLower)) score = 0.95;
    else if (titleLower.includes(qLower)) score = 0.85;
    else if (locLower.includes(qLower)) score = 0.75;
    else if (catLower.includes(qLower)) score = 0.65;
    else if (descLower.includes(qLower)) score = 0.5;

    if (score > 0) {
      results.push({
        id: quest.id,
        title: quest.title,
        location_name: quest.location_name,
        category: quest.category,
        reward_points: quest.reward_points,
        score: Number(score.toFixed(2)),
      });
    }
  }

  return results.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
}

searchRouter.get(
  '/search',
  searchRateLimiter,
  optionalAuthenticateToken,
  checkQAAuthorization,
  async (req: AuthRequest, res: Response) => {
    const rawQ = typeof req.query.q === 'string' ? req.query.q : '';
    const normalized = rawQ.normalize('NFKC').trim().replace(/\s+/g, ' ');

    // Maximum 100 code points
    if (normalized.length > 100) {
      return res.status(400).json({
        success: false,
        error: { code: 'QUERY_TOO_LONG', message: 'Search query cannot exceed 100 characters.' },
      });
    }

    // Unicode letter or digit test: must contain at least 2 alphanumeric characters
    const alphanumericMatches = normalized.match(/[\p{L}\p{N}]/gu);
    if (!alphanumericMatches || alphanumericMatches.length < 2) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'QUERY_TOO_SHORT',
          message: 'Search query must contain at least 2 alphanumeric characters.',
        },
      });
    }

    const allowTest = isAuthorizedQA(req);
    if (allowTest) {
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    }

    const type = (typeof req.query.type === 'string' ? req.query.type.toLowerCase() : 'all') as
      | 'all'
      | 'places'
      | 'people'
      | 'quests';
    const mode = (typeof req.query.mode === 'string' ? req.query.mode.toLowerCase() : 'preview') as
      | 'preview'
      | 'results';

    const isHandleIntent = normalized.startsWith('@');
    const cleanTerm = normalized.replace(/^@/, '').trim();

    const places = type === 'all' || type === 'places' ? searchPlaces(cleanTerm, allowTest) : [];
    const people = type === 'all' || type === 'people' ? await searchPeople(cleanTerm, isHandleIntent, allowTest) : [];
    const quests = type === 'all' || type === 'quests' ? searchQuests(cleanTerm, allowTest) : [];

  // Preview Mode: Compact budget of 8 items maximum, capped at 4 items per group
  if (mode === 'preview') {
    const MAX_TOTAL_PREVIEW = 8;
    const MAX_PER_GROUP = 4;

    if (type !== 'all') {
      // Single type preview: capped at 4 items
      const candidateMap = { places, people, quests };
      const selected = candidateMap[type] || [];
      const items = selected.slice(0, MAX_PER_GROUP);
      const group: SearchGroup = {
        type,
        items,
        has_more: selected.length > MAX_PER_GROUP,
        total_matches: selected.length,
      };

      return res.status(200).json({
        success: true,
        data: {
          groups: [group],
        },
        meta: {
          query: normalized,
          mode: 'preview',
          type,
          ranking_version: 'search-v1',
          partial: false,
          unavailable_types: [],
        },
      });
    }

    // All mode: reserve 1 slot for each non-empty group, allocate remainder up to 8 total
    const candidateGroups = [
      { type: 'places' as const, candidates: places },
      { type: 'people' as const, candidates: people },
      { type: 'quests' as const, candidates: quests },
    ].filter((g) => g.candidates.length > 0);

    // Intent-aware ordering
    candidateGroups.sort((a, b) => {
      if (isHandleIntent) {
        if (a.type === 'people') return -1;
        if (b.type === 'people') return 1;
      }
      const topA = a.candidates[0]?.score || 0;
      const topB = b.candidates[0]?.score || 0;
      if (topB !== topA) return topB - topA;
      const order = { places: 0, people: 1, quests: 2 };
      return order[a.type] - order[b.type];
    });

    const allocatedCounts: Record<string, number> = { places: 0, people: 0, quests: 0 };
    // Step 1: Reserve 1 slot per non-empty group
    let totalAllocated = 0;
    for (const g of candidateGroups) {
      if (g.candidates.length > 0 && totalAllocated < MAX_TOTAL_PREVIEW) {
        allocatedCounts[g.type] = 1;
        totalAllocated += 1;
      }
    }

    // Step 2: Allocate remaining slots to highest scoring items up to MAX_PER_GROUP
    while (totalAllocated < MAX_TOTAL_PREVIEW) {
      let bestGroup: 'places' | 'people' | 'quests' | null = null;
      let bestScore = -1;

      for (const g of candidateGroups) {
        const currentCount = allocatedCounts[g.type];
        if (currentCount < MAX_PER_GROUP && currentCount < g.candidates.length) {
          const nextCandidate = g.candidates[currentCount];
          if (nextCandidate && nextCandidate.score > bestScore) {
            bestScore = nextCandidate.score;
            bestGroup = g.type;
          }
        }
      }

      if (!bestGroup) break;
      allocatedCounts[bestGroup] += 1;
      totalAllocated += 1;
    }

    const groups: SearchGroup[] = candidateGroups.map((g) => {
      const count = allocatedCounts[g.type];
      const items = g.candidates.slice(0, count);
      return {
        type: g.type,
        items,
        has_more: g.candidates.length > count,
        total_matches: g.candidates.length,
      };
    });

    return res.status(200).json({
      success: true,
      data: {
        groups,
      },
      meta: {
        query: normalized,
        mode: 'preview',
        type: 'all',
        ranking_version: 'search-v1',
        partial: false,
        unavailable_types: [],
      },
    });
  }

  // Results Mode: Full Search Results with Cursor Pagination
  if (type === 'all') {
    // Return grouped previews of up to 10 items per group
    const groups: SearchGroup[] = [
      { type: 'places' as const, items: places.slice(0, 10), has_more: places.length > 10, total_matches: places.length },
      { type: 'people' as const, items: people.slice(0, 10), has_more: people.length > 10, total_matches: people.length },
      { type: 'quests' as const, items: quests.slice(0, 10), has_more: quests.length > 10, total_matches: quests.length },
    ].filter((g) => g.total_matches && g.total_matches > 0);

    return res.status(200).json({
      success: true,
      data: {
        groups,
      },
      meta: {
        query: normalized,
        mode: 'results',
        type: 'all',
        ranking_version: 'search-v1',
        partial: false,
        unavailable_types: [],
      },
    });
  }

  // Single Type Results Mode with Cursor Pagination
  const candidateMap = { places, people, quests };
  const allCandidates = candidateMap[type] || [];

  let offset = 0;
  if (req.query.cursor && typeof req.query.cursor === 'string') {
    try {
      const decoded = JSON.parse(Buffer.from(req.query.cursor, 'base64').toString('utf8'));
      if (decoded.q !== normalized || decoded.type !== type) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_CURSOR',
            message: 'Search cursor does not match the provided query or category.',
          },
        });
      }
      offset = typeof decoded.offset === 'number' && decoded.offset >= 0 ? decoded.offset : 0;
    } catch {
      return res.status(400).json({
        success: false,
        error: { code: 'MALFORMED_CURSOR', message: 'Could not decode search cursor.' },
      });
    }
  }

  const requestedLimit = Number(req.query.limit) || 20;
  const limit = Math.min(50, Math.max(1, requestedLimit));
  const pageItems = allCandidates.slice(offset, offset + limit);
  const hasMore = offset + limit < allCandidates.length;

  let nextCursor: string | null = null;
  if (hasMore) {
    nextCursor = Buffer.from(
      JSON.stringify({ offset: offset + limit, q: normalized, type })
    ).toString('base64');
  }

  return res.status(200).json({
    success: true,
    data: {
      items: pageItems,
      cursor: nextCursor,
      has_more: hasMore,
      total_matches: allCandidates.length,
      offset,
      limit,
    },
    meta: {
      query: normalized,
      mode: 'results',
      type,
      ranking_version: 'search-v1',
      partial: false,
      unavailable_types: [],
    },
  });
});
