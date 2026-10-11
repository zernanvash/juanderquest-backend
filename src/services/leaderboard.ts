import { db, UserRow, SubmissionRow } from '../db/index.js';

export interface LeaderboardRankEntry {
  rank: number;
  user_id: string;
  display_name: string;
  handle: string | null;
  avatar_url: string;
  scout_reputation: number;
  approved_quests: number;
  points_earned: number;
  badge: string;
  primary_town: string;
  is_self?: boolean;
}

export interface MunicipalityAggregate {
  name: string;
  quests_completed: number;
  active_scouts: number;
  share_percentage: number;
}

export interface LeaderboardResponse {
  timeframe: 'weekly' | 'all_time';
  metric: 'scout_reputation' | 'quests_completed' | 'points';
  total_active_scouts: number;
  is_sparse_pilot: boolean;
  provenance_note: string;
  top_scouts: LeaderboardRankEntry[];
  top_municipalities: MunicipalityAggregate[];
  my_rank?: LeaderboardRankEntry | null;
}

function resolveScoutBadge(quests: number, reputation: number): string {
  if (quests >= 20 || reputation >= 500) return '👑 Grandmaster Scout';
  if (quests >= 10 || reputation >= 250) return '⚔️ Vanguard Scout';
  if (quests >= 5 || reputation >= 150) return '🧭 Trailblazer';
  return '🌱 Active Scout';
}

export function computeLeaderboard(options?: {
  timeframe?: 'weekly' | 'all_time';
  metric?: 'scout_reputation' | 'quests_completed' | 'points';
  limit?: number;
  currentUserId?: string;
}): LeaderboardResponse {
  const timeframe = options?.timeframe || 'all_time';
  const metric = options?.metric || 'scout_reputation';
  const limit = Math.min(Math.max(options?.limit ?? 20, 1), 50);
  const currentUserId = options?.currentUserId;

  const nowMs = Date.now();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

  // Filter approved, non-test submissions
  const eligibleSubmissions = db.submissions.filter((s: SubmissionRow) => {
    if (s.status !== 'approved' || s.is_test) return false;
    if (timeframe === 'weekly') {
      const subTime = new Date(s.created_at).getTime();
      return nowMs - subTime <= sevenDaysMs;
    }
    return true;
  });

  // Map quests for location resolution
  const questMap = new Map(db.quests.map((q) => [q.id, q]));

  // Count approved submissions and primary town per user
  const userSubsCount = new Map<string, number>();
  const userTownCounts = new Map<string, Map<string, number>>();

  for (const sub of eligibleSubmissions) {
    userSubsCount.set(sub.user_id, (userSubsCount.get(sub.user_id) || 0) + 1);

    const quest = questMap.get(sub.quest_id);
    const town = quest?.location_name || 'Pangasinan';
    if (!userTownCounts.has(sub.user_id)) {
      userTownCounts.set(sub.user_id, new Map());
    }
    const townMap = userTownCounts.get(sub.user_id)!;
    townMap.set(town, (townMap.get(town) || 0) + 1);
  }

  // Filter eligible non-test, non-admin users
  const eligibleUsers = db.users.filter((u: UserRow) => {
    if (u.is_test || u.role === 'admin') return false;
    return true;
  });

  // Calculate scout score entries
  const evaluatedScouts = eligibleUsers.map((u: UserRow) => {
    const approvedQuests = userSubsCount.get(u.id) || 0;
    const reputation = u.scout_reputation || 0;
    const points = u.demo_points || 0;

    // Resolve primary town from most completed quests
    let primaryTown = 'Pangasinan';
    const townMap = userTownCounts.get(u.id);
    if (townMap && townMap.size > 0) {
      let maxCount = 0;
      for (const [townName, count] of townMap.entries()) {
        if (count > maxCount) {
          maxCount = count;
          primaryTown = townName;
        }
      }
    }

    return {
      user: u,
      approvedQuests,
      reputation,
      points,
      primaryTown,
    };
  });

  // Deterministic multi-tier sort
  evaluatedScouts.sort((a, b) => {
    if (metric === 'quests_completed') {
      if (b.approvedQuests !== a.approvedQuests) return b.approvedQuests - a.approvedQuests;
      if (b.reputation !== a.reputation) return b.reputation - a.reputation;
    } else if (metric === 'points') {
      if (b.points !== a.points) return b.points - a.points;
      if (b.approvedQuests !== a.approvedQuests) return b.approvedQuests - a.approvedQuests;
    } else {
      // Default: scout_reputation
      if (b.reputation !== a.reputation) return b.reputation - a.reputation;
      if (b.approvedQuests !== a.approvedQuests) return b.approvedQuests - a.approvedQuests;
    }
    // Tie-breaker 1: earlier registration
    const timeDiff = new Date(a.user.created_at).getTime() - new Date(b.user.created_at).getTime();
    if (timeDiff !== 0) return timeDiff;
    // Tie-breaker 2: stable UUID sort
    return a.user.id.localeCompare(b.user.id);
  });

  // Assign ranks
  let currentRank = 1;
  const rankedEntries: LeaderboardRankEntry[] = evaluatedScouts.map((item, idx) => {
    const isPublic = item.user.is_public !== false;
    const isSelf = currentUserId === item.user.id;

    // Rank tie logic
    if (idx > 0) {
      const prev = evaluatedScouts[idx - 1];
      const sameScore =
        metric === 'quests_completed'
          ? item.approvedQuests === prev.approvedQuests
          : metric === 'points'
          ? item.points === prev.points
          : item.reputation === prev.reputation;
      if (!sameScore) {
        currentRank = idx + 1;
      }
    }

    const displayName = isPublic || isSelf ? item.user.display_name : 'Anonymous Scout';
    const handle = (isPublic || isSelf) && item.user.handle ? item.user.handle : null;
    const avatarUrl =
      isPublic || isSelf
        ? item.user.avatar_url || `https://api.dicebear.com/7.x/identicon/svg?seed=${item.user.id.slice(0, 6)}`
        : `https://api.dicebear.com/7.x/identicon/svg?seed=anon-${item.user.id.slice(0, 6)}`;

    return {
      rank: currentRank,
      user_id: item.user.id,
      display_name: displayName,
      handle,
      avatar_url: avatarUrl,
      scout_reputation: item.reputation,
      approved_quests: item.approvedQuests,
      points_earned: item.points,
      badge: resolveScoutBadge(item.approvedQuests, item.reputation),
      primary_town: item.primaryTown,
      is_self: isSelf,
    };
  });

  // Compute municipality aggregates from eligible submissions
  const townStats = new Map<string, { quests: number; scouts: Set<string> }>();
  for (const sub of eligibleSubmissions) {
    const quest = questMap.get(sub.quest_id);
    const town = quest?.location_name || 'Other Pangasinan';
    if (!townStats.has(town)) {
      townStats.set(town, { quests: 0, scouts: new Set() });
    }
    const stat = townStats.get(town)!;
    stat.quests += 1;
    stat.scouts.add(sub.user_id);
  }

  const totalQuests = eligibleSubmissions.length || 1;
  const topMunicipalities: MunicipalityAggregate[] = Array.from(townStats.entries())
    .map(([name, data]) => ({
      name,
      quests_completed: data.quests,
      active_scouts: data.scouts.size,
      share_percentage: Math.round((data.quests / totalQuests) * 100),
    }))
    .sort((a, b) => b.quests_completed - a.quests_completed)
    .slice(0, 8);

  const myRank = currentUserId ? rankedEntries.find((e) => e.user_id === currentUserId) || null : null;

  const activeScoutsWithActivity = rankedEntries.filter((e) => e.approved_quests > 0 || e.scout_reputation > 0);
  const isSparsePilot = activeScoutsWithActivity.length < 5;

  return {
    timeframe,
    metric,
    total_active_scouts: rankedEntries.length,
    is_sparse_pilot: isSparsePilot,
    provenance_note:
      'Rankings are aggregated dynamically from verified, admin-approved quest submissions and scout reputation ledgers. Synthetic placeholders are excluded.',
    top_scouts: rankedEntries.slice(0, limit),
    top_municipalities: topMunicipalities,
    my_rank: myRank,
  };
}
