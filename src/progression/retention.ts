import { randomUUID } from 'crypto';
import { Pool, PoolClient } from 'pg';
import { getPool } from '../db/pool.js';
import { progressionRepo } from './repository.js';

type Queryable = Pick<Pool | PoolClient, 'query'>;

function computeOfficialStreak(rows: Array<{ round_number: number | string; status: string; participated: boolean }>) {
  let current = 0; let longest = 0; let running = 0; let previousRound: number | null = null; let observed = 0;
  for (const row of rows) {
    const roundNumber = Number(row.round_number);
    if (previousRound !== null && roundNumber !== previousRound + 1) running = 0;
    if (row.status !== 'cancelled') {
      observed += 1;
      running = row.participated ? running + 1 : 0;
      longest = Math.max(longest, running);
      current = running;
    }
    previousRound = roundNumber;
  }
  return { current, longest, observed };
}

function pool(): Pool {
  const value = getPool();
  if (!value) throw new Error('DATABASE_OUTAGE');
  return value;
}

async function metricCount(metric: string, userId: string, start: Date, end: Date, isTest: boolean): Promise<number> {
  if (metric === 'juanchoice_participations') {
    const result = await pool().query(
      `SELECT COUNT(*)::bigint AS count FROM juanchoice_participations p
       JOIN juanchoice_campaigns c ON c.id = p.campaign_id
       WHERE p.user_id = $1 AND p.is_test = $4 AND p.rewarded_at >= $2 AND p.rewarded_at < $3
         AND c.status IN ('finalized', 'archived')`, [userId, start, end, isTest]);
    return Number(result.rows[0].count);
  }
  const expression = metric === 'verified_visits' ? 'COUNT(*)'
    : metric === 'unique_destinations' ? 'COUNT(DISTINCT spot_id)' : 'COUNT(DISTINCT municipality_id)';
  const result = await pool().query(
    `SELECT ${expression}::bigint AS count FROM verified_visits
     WHERE user_id = $1 AND occurred_at >= $2 AND occurred_at < $3
       AND is_test = $4 AND revoked_at IS NULL`, [userId, start, end, isTest]);
  return Number(result.rows[0].count);
}

export async function getEngagementSummary(userId: string, allowTest = false) {
  const actor = (await pool().query('SELECT id, is_test FROM users WHERE id = $1', [userId])).rows[0];
  if (!actor || (!allowTest && actor.is_test)) return null;
  const isTest = Boolean(actor.is_test);
  const rounds = (await pool().query(
    `SELECT c.round_number, c.id, c.status, (p.user_id IS NOT NULL) AS participated
     FROM juanchoice_campaigns c
     LEFT JOIN juanchoice_participations p ON p.campaign_id = c.id AND p.user_id = $1
     WHERE c.counts_for_streak = TRUE AND c.series_key = 'pangasinan-primary'
       AND c.status IN ('finalized', 'archived', 'cancelled') AND c.is_test = $2
     ORDER BY c.round_number`, [userId, isTest])).rows;
  const streak = computeOfficialStreak(rounds);
  const current = streak.current;
  const longest = streak.longest;
  const milestones = [4, 8, 16, 32, 52];
  const nextMilestone = milestones.find((value) => value > current) ?? null;
  const [impactResult, challengesResult, goals, participationsResult] = await Promise.all([
    pool().query(
      `SELECT COUNT(*) FILTER (WHERE revoked_at IS NULL)::bigint AS verified_visits,
              COUNT(DISTINCT spot_id) FILTER (WHERE revoked_at IS NULL)::bigint AS unique_destinations,
              COUNT(DISTINCT municipality_id) FILTER (WHERE revoked_at IS NULL AND municipality_id IS NOT NULL)::bigint AS municipalities
       FROM verified_visits WHERE user_id = $1 AND is_test = $2`, [userId, isTest]),
    pool().query(
      `SELECT * FROM engagement_challenges WHERE starts_at <= NOW() AND ends_at > NOW() AND is_test = $1
       ORDER BY ends_at, id LIMIT 20`, [isTest]),
    listCommunityGoals(isTest),
    pool().query(
      `SELECT COUNT(*)::bigint AS count FROM juanchoice_participations p
       JOIN juanchoice_campaigns c ON c.id = p.campaign_id
       WHERE p.user_id = $1 AND p.is_test = $2 AND c.status IN ('finalized', 'archived')`, [userId, isTest]),
  ]);
  const challenges: Array<Record<string, unknown>> = [];
  for (const row of challengesResult.rows) {
    const progress = await metricCount(row.metric, userId, new Date(row.starts_at), new Date(row.ends_at), isTest);
    challenges.push({ id: row.id, slug: row.slug, title: row.title, description: row.description,
      cadence: row.cadence, metric: row.metric, target: Number(row.target), progress,
      complete: progress >= Number(row.target), starts_at: row.starts_at, ends_at: row.ends_at });
  }
  const impact = impactResult.rows[0];
  const shareAchievements = await getAchievementSharing(userId);
  return {
    streak: { series_key: 'pangasinan-primary', current, longest, next_milestone: nextMilestone, rounds_observed: streak.observed },
    next_goal: nextMilestone ? { kind: 'official_round_streak', target: nextMilestone, remaining: nextMilestone - current } : null,
    impact: { verified_visits: Number(impact.verified_visits), unique_destinations: Number(impact.unique_destinations),
      municipalities: Number(impact.municipalities), finalized_participations: Number(participationsResult.rows[0].count) },
    challenges,
    share_achievements: shareAchievements,
    community_goals: goals,
  };
}

async function goalCount(row: Record<string, unknown>, client: Queryable = pool()): Promise<number> {
  if (row.metric === 'finalized_participants') {
    const result = row.campaign_id
      ? await client.query(
        `SELECT COUNT(DISTINCT p.user_id)::bigint AS count FROM juanchoice_participations p
         JOIN juanchoice_campaigns c ON c.id = p.campaign_id
         WHERE p.is_test = $1 AND p.rewarded_at >= $2 AND p.rewarded_at < $3
           AND c.status IN ('finalized', 'archived') AND c.id = $4`, [row.is_test, row.starts_at, row.ends_at, row.campaign_id])
      : await client.query(
        `SELECT COUNT(DISTINCT p.user_id)::bigint AS count FROM juanchoice_participations p
         JOIN juanchoice_campaigns c ON c.id = p.campaign_id
         WHERE p.is_test = $1 AND p.rewarded_at >= $2 AND p.rewarded_at < $3
           AND c.status IN ('finalized', 'archived')`, [row.is_test, row.starts_at, row.ends_at]);
    return Number(result.rows[0].count);
  }
  const result = await client.query(
    `SELECT COUNT(*)::bigint AS count FROM verified_visits
     WHERE is_test = $1 AND verified_at >= $2 AND verified_at < $3 AND revoked_at IS NULL`,
    [row.is_test, row.starts_at, row.ends_at]);
  return Number(result.rows[0].count);
}

export async function listCommunityGoals(isTest = false) {
  const rows = (await pool().query(
    `SELECT g.*, u.unlocked_at FROM community_goals g
     LEFT JOIN community_goal_unlocks u ON u.goal_id = g.id
     WHERE g.is_test = $1 AND g.status IN ('active', 'reached') AND g.ends_at > NOW()
     ORDER BY g.ends_at, g.id LIMIT 20`, [isTest])).rows;
  return Promise.all(rows.map(async (row) => ({ ...row, target: Number(row.target), progress: await goalCount(row),
    reached: Boolean(row.unlocked_at) })));
}

export async function setAchievementSharing(userId: string, shareAchievements: boolean) {
  return (await pool().query(
    `INSERT INTO user_engagement_preferences(user_id, share_achievements, updated_at) VALUES($1, $2, NOW())
     ON CONFLICT(user_id) DO UPDATE SET share_achievements = EXCLUDED.share_achievements, updated_at = NOW()
     RETURNING share_achievements, updated_at`, [userId, shareAchievements])).rows[0];
}

export async function getAchievementSharing(userId: string): Promise<boolean> {
  const row = (await pool().query(
    'SELECT share_achievements FROM user_engagement_preferences WHERE user_id = $1', [userId])).rows[0];
  return Boolean(row?.share_achievements);
}

export async function evaluateCommunityGoals(limit = 20) {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const goals = (await client.query(
      `SELECT * FROM community_goals WHERE status = 'active' AND starts_at <= NOW() AND ends_at > NOW()
       ORDER BY ends_at, id LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit])).rows;
    let unlocked = 0;
    for (const goal of goals) {
      if ((await client.query('SELECT goal_id FROM community_goal_unlocks WHERE goal_id = $1', [goal.id])).rowCount) continue;
      const count = await goalCount(goal, client);
      if (count < Number(goal.target)) continue;
      const outboxId = randomUUID();
      await client.query(
        `INSERT INTO outbox_events(id, event_key, event_type, payload)
         VALUES($1, $2, 'community_goal_reached', $3::jsonb)`,
        [outboxId, `community-goal:${goal.id}`, JSON.stringify({ goal_id: goal.id, observed_count: count,
          rule_version: 'community-goal-v1', is_test: goal.is_test })]);
      await client.query(
        `INSERT INTO community_goal_unlocks(goal_id, observed_count, rule_version, outbox_event_id)
         VALUES($1, $2, 'community-goal-v1', $3)`, [goal.id, count, outboxId]);
      await client.query("UPDATE community_goals SET status = 'reached' WHERE id = $1", [goal.id]);
      unlocked += 1;
    }
    await client.query('COMMIT');
    return { examined: goals.length, unlocked };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const streakAwards = [
  { threshold: 4, id: 'civic_regular_voter' },
  { threshold: 8, id: 'civic_community_supporter' },
  { threshold: 16, id: 'civic_tourism_advocate' },
  { threshold: 32, id: 'civic_community_pathfinder' },
  { threshold: 52, id: 'civic_voice_of_pangasinan' },
];

export async function evaluateFinalizedCampaignRetention(
  campaignId: string,
  winnerCandidateIds: string[],
  client: PoolClient,
) {
  const campaign = (await client.query('SELECT * FROM juanchoice_campaigns WHERE id = $1', [campaignId])).rows[0];
  if (!campaign) return { streak_awards: 0, early_discoverer_awards: 0 };
  let streakAwardCount = 0;
  if (campaign.counts_for_streak) {
    const participants = (await client.query(
      'SELECT user_id FROM juanchoice_participations WHERE campaign_id = $1 AND is_test = $2',
      [campaignId, campaign.is_test],
    )).rows;
    for (const participant of participants) {
      const rounds = (await client.query(
         `SELECT c.round_number, c.status, (p.user_id IS NOT NULL) AS participated
         FROM juanchoice_campaigns c
         LEFT JOIN juanchoice_participations p ON p.campaign_id = c.id AND p.user_id = $1
         WHERE c.counts_for_streak = TRUE AND c.series_key = $2
           AND c.status IN ('finalized', 'archived', 'cancelled') AND c.is_test = $3
         ORDER BY c.round_number`,
        [participant.user_id, campaign.series_key, campaign.is_test],
      )).rows;
      const streak = computeOfficialStreak(rounds);
      for (const definition of streakAwards.filter((entry) => streak.current >= entry.threshold)) {
        const alreadyAwarded = await client.query(
          'SELECT 1 FROM achievement_awards WHERE user_id = $1 AND achievement_id = $2 AND season = $3',
          [participant.user_id, definition.id, 'all_time'],
        );
        if (alreadyAwarded.rowCount) continue;
        const award = await progressionRepo.awardAchievement({
          id: randomUUID(), user_id: participant.user_id, achievement_id: definition.id,
          season: 'all_time', source_evidence_id: campaignId, evidence_version: 'juanchoice-finalization-v1',
          awarded_at: new Date().toISOString(), is_test: Boolean(campaign.is_test),
        }, client);
        if (award) streakAwardCount += 1;
      }
    }
  }

  let earlyDiscovererAwardCount = 0;
  if (winnerCandidateIds.length > 0) {
    const discoverers = (await client.query(
      `SELECT DISTINCT v.user_id
       FROM verified_visits v
       JOIN juanchoice_candidates n ON n.spot_id = v.spot_id
       WHERE n.campaign_id = $1 AND n.id = ANY($2::uuid[])
         AND v.occurred_at < $3 AND v.revoked_at IS NULL
         AND v.is_test = $4 AND n.is_test = $4`,
      [campaignId, winnerCandidateIds, campaign.opens_at, campaign.is_test],
    )).rows;
    for (const discoverer of discoverers) {
      const award = await progressionRepo.awardAchievement({
        id: randomUUID(), user_id: discoverer.user_id, achievement_id: 'early_discoverer',
        season: 'all_time', source_evidence_id: campaignId, evidence_version: 'juanchoice-early-discovery-v1',
        awarded_at: new Date().toISOString(), is_test: Boolean(campaign.is_test),
      }, client);
      if (award) earlyDiscovererAwardCount += 1;
    }
  }
  return { streak_awards: streakAwardCount, early_discoverer_awards: earlyDiscovererAwardCount };
}
