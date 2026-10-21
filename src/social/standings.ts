import { getPool } from '../db/pool.js';
import { MJDQ_PER_JDQ } from '../governance/store.js';
import type { Queryable } from './activity.js';
import {
  weekStartUtc,
  nextWeekStartUtc,
  weekStartDate,
  weekId,
} from './time.js';
import { computeLeaderboard } from '../services/leaderboard.js';

export interface WeeklyScoreRow {
  user_id: string;
  score: number;
  quests: number;
}

export interface UserRankInput {
  user_id: string;
  score: number;
  quests: number;
  created_at?: Date | string;
  home_town?: string | null;
  prev_rank?: number | null;
}

export interface StandingEntry {
  rank: number;
  user_id: string | null;
  display_name: string;
  handle: string | null;
  avatar_url: string | null;
  score: number;
  quests: number;
  home_town: string | null;
  delta: number | null;
  is_self: boolean;
  is_following: boolean;
}

export interface RivalEntry {
  rank: number;
  user_id: string | null;
  display_name: string;
  handle: string | null;
  avatar_url: string | null;
  score: number;
  gap?: number;
  is_following: boolean;
}

export interface TownBoardEntry {
  rank: number;
  town: string;
  score_sum: number;
  active_explorers: number;
  top_explorer: {
    display_name: string;
    handle: string | null;
    avatar_url: string | null;
  } | null;
  is_my_town: boolean;
}

export interface GetBoardInput {
  client?: Queryable | null;
  viewerId?: string | null;
  isTest: boolean;
  board?: 'everyone' | 'following' | 'town';
  period?: 'weekly' | 'all_time';
  metric?: 'scout_reputation' | 'quests_completed' | 'points';
  limit?: number;
  afterRank?: number | null;
}

export interface GetBoardResult {
  board: 'everyone' | 'following' | 'town';
  period: 'weekly' | 'all_time';
  week: {
    id: string;
    starts_at: string;
    ends_at: string;
    resets_in_seconds: number;
  };
  me: {
    rank: number;
    score: number;
    quests: number;
    delta: number | null;
    gap_to_next: number | null;
  } | null;
  podium: StandingEntry[];
  entries: StandingEntry[];
  rivals: {
    above: RivalEntry[];
    below: RivalEntry[];
  };
  town: { name: string } | null;
  total: number;
  next_after_rank: number | null;
  provenance_note?: string;
  reason?: string;
}

/**
 * Computes weekly scores from governance_ledger quest rewards.
 */
export async function computeWeeklyScores(
  client: Queryable,
  startUtc: Date,
  endUtc: Date,
  isTest: boolean,
): Promise<WeeklyScoreRow[]> {
  const sql = `
    SELECT l.account AS user_id,
           (SUM(l.amount_mjdq) / $4)::int AS score,
           COUNT(DISTINCT l.reference_id)::int AS quests
      FROM governance_ledger l
      JOIN users u ON u.id = l.account AND u.is_test = $3 AND u.role <> 'admin'
     WHERE l.type IN ('quest_reward_credit', 'quest_reward_paid', 'trail_reward_credit')
       AND l.amount_mjdq > 0
       AND l.created_at >= $1 AND l.created_at < $2
     GROUP BY l.account
  `;
  const res = await client.query(sql, [startUtc, endUtc, isTest, MJDQ_PER_JDQ]);
  return res.rows.map((r: any) => ({
    user_id: r.user_id,
    score: Number(r.score || 0),
    quests: Number(r.quests || 0),
  }));
}

/**
 * Computes each user's primary home town (the municipality with the most approved completions all-time).
 * Ties: alphabetical.
 */
export async function computeHomeTowns(
  client: Queryable,
  isTest?: boolean,
): Promise<Map<string, string>> {
  const sql = `
    SELECT sub.user_id,
           COALESCE(s.municipality, q.location_name) AS municipality,
           COUNT(*)::int AS count
      FROM submissions sub
      JOIN quests q ON q.id = sub.quest_id
      LEFT JOIN reviewed_quest_spot_bindings b ON b.quest_id = q.id AND b.status = 'active'
      LEFT JOIN spots s ON s.id = b.spot_id
     WHERE sub.status = 'approved'
       AND ($1::boolean IS NULL OR sub.is_test = $1)
     GROUP BY sub.user_id, COALESCE(s.municipality, q.location_name)
     ORDER BY sub.user_id ASC, count DESC, municipality ASC
  `;
  const res = await client.query(sql, [isTest ?? null]);
  const map = new Map<string, string>();
  for (const r of res.rows) {
    if (r.municipality && !map.has(r.user_id)) {
      map.set(r.user_id, r.municipality);
    }
  }
  return map;
}

/**
 * Standard competition ranking (1, 2, 2, 4) sorted by score DESC, quests DESC, user created_at ASC, user_id ASC.
 */
export function rankRows<T extends UserRankInput>(rows: T[]): (T & { rank: number })[] {
  if (!rows.length) return [];

  const sorted = [...rows].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.quests !== a.quests) return b.quests - a.quests;
    const aDate = a.created_at ? new Date(a.created_at).getTime() : 0;
    const bDate = b.created_at ? new Date(b.created_at).getTime() : 0;
    if (aDate !== bDate) return aDate - bDate;
    return a.user_id.localeCompare(b.user_id);
  });

  const result: (T & { rank: number })[] = [];
  let currentRank = 1;

  for (let i = 0; i < sorted.length; i++) {
    if (i > 0) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (cur.score === prev.score && cur.quests === prev.quests) {
        result.push({ ...cur, rank: currentRank });
        continue;
      }
    }
    currentRank = i + 1;
    result.push({ ...sorted[i], rank: currentRank });
  }

  return result;
}

interface UserInfo {
  id: string;
  display_name: string;
  handle: string | null;
  avatar_url: string | null;
  is_public: boolean;
  share_activity: boolean;
  created_at: Date;
}

async function fetchUserInfos(client: Queryable, userIds: string[]): Promise<Map<string, UserInfo>> {
  const map = new Map<string, UserInfo>();
  if (!userIds.length) return map;

  const placeholders = userIds.map((_, i) => `$${i + 1}`).join(', ');
  const res = await client.query(
    `SELECT id, display_name, handle, avatar_url, is_public, share_activity, created_at
       FROM users
      WHERE id IN (${placeholders})`,
    userIds,
  );

  for (const u of res.rows) {
    map.set(u.id, {
      id: u.id,
      display_name: u.display_name,
      handle: u.handle ?? null,
      avatar_url: u.avatar_url ?? null,
      is_public: Boolean(u.is_public),
      share_activity: Boolean(u.share_activity),
      created_at: new Date(u.created_at),
    });
  }

  return map;
}

/**
 * Retrieves standings for Plaza (everyone, following, or town).
 */
export async function getBoard(input: GetBoardInput): Promise<GetBoardResult> {
  const client = input.client ?? getPool();
  const viewerId = input.viewerId ?? null;
  const isTest = Boolean(input.isTest);
  const board = input.board ?? 'everyone';
  const period = input.period ?? 'weekly';
  const metric = input.metric ?? 'scout_reputation';
  const limit = Math.min(50, Math.max(1, input.limit ?? 20));
  const afterRank = input.afterRank ?? null;

  const now = new Date();
  const ws = weekStartUtc(now);
  const we = nextWeekStartUtc(now);
  const wDate = weekStartDate(now);
  const wId = weekId(now);
  const resetsInSeconds = Math.max(0, Math.floor((we.getTime() - now.getTime()) / 1000));

  const weekMeta = {
    id: wId,
    starts_at: ws.toISOString(),
    ends_at: we.toISOString(),
    resets_in_seconds: resetsInSeconds,
  };

  if (!client) {
    return {
      board,
      period,
      week: weekMeta,
      me: null,
      podium: [],
      entries: [],
      rivals: { above: [], below: [] },
      town: null,
      total: 0,
      next_after_rank: null,
      provenance_note: 'Degraded offline mode',
    };
  }

  // Load viewer follows
  const followingSet = new Set<string>();
  if (viewerId) {
    const fRes = await client.query(
      'SELECT following_id FROM user_follows WHERE follower_id = $1',
      [viewerId],
    );
    for (const r of fRes.rows) {
      followingSet.add(r.following_id);
    }
  }

  let rankedAll: (UserRankInput & { rank: number })[] = [];
  let userInfos: Map<string, UserInfo>;

  if (period === 'weekly') {
    // Attempt reading from plaza_weekly_scores
    const scoreRes = await client.query(
      `SELECT user_id, score, quests, home_town, rank, prev_rank
         FROM plaza_weekly_scores
        WHERE week_start = $1 AND is_test = $2
        ORDER BY rank ASC, user_id ASC`,
      [wDate, isTest],
    );

    if (scoreRes.rows.length > 0) {
      const uIds = scoreRes.rows.map((r: any) => r.user_id);
      userInfos = await fetchUserInfos(client, uIds);

      rankedAll = scoreRes.rows.map((r: any) => ({
        user_id: r.user_id,
        score: Number(r.score),
        quests: Number(r.quests),
        home_town: r.home_town ?? null,
        rank: Number(r.rank),
        prev_rank: r.prev_rank != null ? Number(r.prev_rank) : null,
        created_at: userInfos.get(r.user_id)?.created_at,
      }));
    } else {
      // On-the-fly calculation for fresh deploy / pre-job run
      const rawScores = await computeWeeklyScores(client, ws, we, isTest);
      const towns = await computeHomeTowns(client, isTest);
      const uIds = rawScores.map((s) => s.user_id);
      userInfos = await fetchUserInfos(client, uIds);

      const itemsWithTown = rawScores.map((s) => ({
        user_id: s.user_id,
        score: s.score,
        quests: s.quests,
        home_town: towns.get(s.user_id) ?? null,
        created_at: userInfos.get(s.user_id)?.created_at,
      }));

      rankedAll = rankRows(itemsWithTown);
    }
  } else {
    // All-time period
    const lb = computeLeaderboard({
      timeframe: 'all_time',
      metric,
      limit: 1000,
      currentUserId: viewerId ?? undefined,
    });

    const uIds = lb.top_scouts.map((s) => s.user_id);
    userInfos = await fetchUserInfos(client, uIds);

    const items = lb.top_scouts.map((s) => {
      let scoreVal = s.scout_reputation;
      if (metric === 'quests_completed') scoreVal = s.approved_quests;
      if (metric === 'points') scoreVal = s.points_earned;

      return {
        user_id: s.user_id,
        score: scoreVal,
        quests: s.approved_quests,
        home_town: s.primary_town,
        created_at: userInfos.get(s.user_id)?.created_at,
      };
    });

    rankedAll = rankRows(items);
  }

  // Filter according to requested board
  let viewerHomeTown: string | null = null;
  if (viewerId) {
    const viewerRow = rankedAll.find((r) => r.user_id === viewerId);
    if (viewerRow?.home_town) {
      viewerHomeTown = viewerRow.home_town;
    } else {
      const towns = await computeHomeTowns(client, isTest);
      viewerHomeTown = towns.get(viewerId) ?? null;
    }
  }

  let filteredRanked: (UserRankInput & { rank: number })[] = [];
  let townMeta: { name: string } | null = null;

  if (board === 'following') {
    if (!viewerId) {
      filteredRanked = [];
    } else {
      const allowed = new Set<string>(followingSet);
      allowed.add(viewerId);
      const subset = rankedAll.filter((r) => allowed.has(r.user_id));
      filteredRanked = rankRows(subset);
    }
  } else if (board === 'town') {
    if (!viewerHomeTown) {
      return {
        board,
        period,
        week: weekMeta,
        me: null,
        podium: [],
        entries: [],
        rivals: { above: [], below: [] },
        town: null,
        total: 0,
        next_after_rank: null,
        reason: 'NO_HOME_TOWN',
      };
    }
    townMeta = { name: viewerHomeTown };
    const subset = rankedAll.filter((r) => r.home_town === viewerHomeTown);
    filteredRanked = rankRows(subset);
  } else {
    // Everyone
    filteredRanked = rankedAll;
  }

  const mapToStandingEntry = (r: UserRankInput & { rank: number }): StandingEntry => {
    const isSelf = Boolean(viewerId && viewerId === r.user_id);
    const u = userInfos.get(r.user_id);
    const isPublic = u ? u.is_public : true;
    const isFollowing = followingSet.has(r.user_id);

    let delta: number | null = null;
    if (period === 'weekly' && r.prev_rank != null) {
      delta = r.prev_rank - r.rank;
    }

    if (!isPublic && !isSelf) {
      return {
        rank: r.rank,
        user_id: null,
        display_name: 'Anonymous Explorer',
        handle: null,
        avatar_url: null,
        score: r.score,
        quests: r.quests,
        home_town: r.home_town ?? null,
        delta,
        is_self: false,
        is_following: false,
      };
    }

    return {
      rank: r.rank,
      user_id: r.user_id,
      display_name: u?.display_name ?? 'Explorer',
      handle: u?.handle ?? null,
      avatar_url: u?.avatar_url ?? null,
      score: r.score,
      quests: r.quests,
      home_town: r.home_town ?? null,
      delta,
      is_self: isSelf,
      is_following: isFollowing,
    };
  };

  const mapToRivalEntry = (r: UserRankInput & { rank: number }, viewerScore: number): RivalEntry => {
    const isSelf = Boolean(viewerId && viewerId === r.user_id);
    const u = userInfos.get(r.user_id);
    const isPublic = u ? u.is_public : true;

    const gap = r.score > viewerScore ? r.score - viewerScore + 1 : undefined;

    if (!isPublic && !isSelf) {
      return {
        rank: r.rank,
        user_id: null,
        display_name: 'Anonymous Explorer',
        handle: null,
        avatar_url: null,
        score: r.score,
        gap,
        is_following: false,
      };
    }

    return {
      rank: r.rank,
      user_id: r.user_id,
      display_name: u?.display_name ?? 'Explorer',
      handle: u?.handle ?? null,
      avatar_url: u?.avatar_url ?? null,
      score: r.score,
      gap,
      is_following: followingSet.has(r.user_id),
    };
  };

  // 'me' stats
  let meStats: GetBoardResult['me'] = null;
  let meIdx = -1;
  if (viewerId) {
    meIdx = filteredRanked.findIndex((r) => r.user_id === viewerId);
    if (meIdx !== -1) {
      const meRow = filteredRanked[meIdx];
      let delta: number | null = null;
      if (period === 'weekly' && meRow.prev_rank != null) {
        delta = meRow.prev_rank - meRow.rank;
      }

      let gapToNext: number | null = null;
      if (meIdx > 0) {
        const nextAbove = filteredRanked[meIdx - 1];
        gapToNext = nextAbove.score - meRow.score + 1;
      }

      meStats = {
        rank: meRow.rank,
        score: meRow.score,
        quests: meRow.quests,
        delta,
        gap_to_next: gapToNext,
      };
    }
  }

  // Rivals: 2 immediately above, 2 immediately below
  const rivalsAbove: RivalEntry[] = [];
  const rivalsBelow: RivalEntry[] = [];
  if (meIdx !== -1) {
    const viewerScore = filteredRanked[meIdx].score;
    const startAbove = Math.max(0, meIdx - 2);
    for (let i = startAbove; i < meIdx; i++) {
      rivalsAbove.push(mapToRivalEntry(filteredRanked[i], viewerScore));
    }
    const endBelow = Math.min(filteredRanked.length, meIdx + 3);
    for (let i = meIdx + 1; i < endBelow; i++) {
      rivalsBelow.push(mapToRivalEntry(filteredRanked[i], viewerScore));
    }
  }

  // Podium: top 3
  const podium = filteredRanked.slice(0, 3).map(mapToStandingEntry);

  // Entries: paging with after_rank
  let startIndex = 0;
  if (afterRank != null) {
    startIndex = filteredRanked.findIndex((r) => r.rank > afterRank);
    if (startIndex === -1) startIndex = filteredRanked.length;
  } else {
    // If after_rank is not specified, entries start after the podium (rank > 3)
    startIndex = filteredRanked.findIndex((r) => r.rank > 3);
    if (startIndex === -1) startIndex = filteredRanked.length;
  }

  const pagedRows = filteredRanked.slice(startIndex, startIndex + limit);
  const entries = pagedRows.map(mapToStandingEntry);

  let nextAfterRank: number | null = null;
  if (startIndex + limit < filteredRanked.length && entries.length > 0) {
    nextAfterRank = entries[entries.length - 1].rank;
  }

  return {
    board,
    period,
    week: weekMeta,
    me: meStats,
    podium,
    entries,
    rivals: {
      above: rivalsAbove,
      below: rivalsBelow,
    },
    town: townMeta,
    total: filteredRanked.length,
    next_after_rank: nextAfterRank,
  };
}

export interface GetTownBoardInput {
  client?: Queryable | null;
  isTest: boolean;
  viewerHomeTown?: string | null;
  weekStartUtc?: Date;
}

export interface GetTownBoardResult {
  week: {
    id: string;
    starts_at: string;
    ends_at: string;
    resets_in_seconds: number;
  };
  towns: TownBoardEntry[];
}

/**
 * Aggregates weekly standings across municipalities.
 */
export async function getTownBoard(input: GetTownBoardInput): Promise<GetTownBoardResult> {
  const client = input.client ?? getPool();
  const isTest = Boolean(input.isTest);
  const viewerTown = input.viewerHomeTown ?? null;

  const now = input.weekStartUtc ?? new Date();
  const ws = weekStartUtc(now);
  const we = nextWeekStartUtc(now);
  const wDate = weekStartDate(now);
  const wId = weekId(now);
  const resetsInSeconds = Math.max(0, Math.floor((we.getTime() - now.getTime()) / 1000));

  const weekMeta = {
    id: wId,
    starts_at: ws.toISOString(),
    ends_at: we.toISOString(),
    resets_in_seconds: resetsInSeconds,
  };

  if (!client) {
    return { week: weekMeta, towns: [] };
  }

  // Aggregate scores by home_town from plaza_weekly_scores
  const aggRes = await client.query(
    `SELECT home_town AS town,
            SUM(score)::int AS score_sum,
            COUNT(CASE WHEN score > 0 THEN 1 END)::int AS active_explorers
       FROM plaza_weekly_scores
      WHERE week_start = $1
        AND is_test = $2
        AND home_town IS NOT NULL
      GROUP BY home_town
      ORDER BY score_sum DESC, town ASC
      LIMIT 20`,
    [wDate, isTest],
  );

  const towns: TownBoardEntry[] = [];
  for (let i = 0; i < aggRes.rows.length; i++) {
    const row = aggRes.rows[i];
    const townName = row.town;

    // Find top public explorer in this town
    const topExpRes = await client.query(
      `SELECT u.display_name, u.handle, u.avatar_url
         FROM plaza_weekly_scores s
         JOIN users u ON u.id = s.user_id AND u.is_test = s.is_test
        WHERE s.week_start = $1
          AND s.is_test = $2
          AND s.home_town = $3
          AND s.score > 0
          AND u.is_public = TRUE
        ORDER BY s.score DESC, u.created_at ASC
        LIMIT 1`,
      [wDate, isTest, townName],
    );

    let topExplorer: TownBoardEntry['top_explorer'] = null;
    if (topExpRes.rows.length > 0) {
      const top = topExpRes.rows[0];
      topExplorer = {
        display_name: top.display_name,
        handle: top.handle ?? null,
        avatar_url: top.avatar_url ?? null,
      };
    }

    towns.push({
      rank: i + 1,
      town: townName,
      score_sum: Number(row.score_sum || 0),
      active_explorers: Number(row.active_explorers || 0),
      top_explorer: topExplorer,
      is_my_town: viewerTown ? viewerTown === townName : false,
    });
  }

  return { week: weekMeta, towns };
}
