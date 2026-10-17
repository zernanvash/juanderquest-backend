import { randomUUID } from 'crypto';
import type { Pool, PoolClient } from 'pg';
import { getPool } from '../db/pool.js';
import { env } from '../config/env.js';
import type { Queryable } from './activity.js';
import { recordActivity } from './activity.js';
import { notify } from './notify.js';
import {
  computeWeeklyScores,
  computeHomeTowns,
  rankRows,
  type UserRankInput,
} from './standings.js';
import {
  weekStartUtc,
  nextWeekStartUtc,
  weekStartDate,
  weekId,
} from './time.js';

export const PLAZA_STANDINGS_LOCK_KEY = 410041;

let timer: NodeJS.Timeout | null = null;
let running: Promise<void> | null = null;
let stopped = true;
let consecutiveFailures = 0;
let lastAttemptAt: string | null = null;
let lastSuccessAt: string | null = null;

export function getStandingsJobStatus() {
  return {
    active: !stopped,
    in_flight: running !== null,
    consecutive_failures: consecutiveFailures,
    last_attempt_at: lastAttemptAt,
    last_success_at: lastSuccessAt,
  };
}

export interface StandingsTickResult {
  scoresUpdated: number;
  overtakesNotified: number;
  top10Announced: number;
  weeklyFinalized: boolean;
}

/**
 * Runs a single tick of the standings job for both production and test scopes.
 * May be invoked directly by tests with a custom timestamp and transaction/pool.
 */
export async function runStandingsTick(
  poolOrClient: Queryable,
  now = new Date(),
): Promise<StandingsTickResult> {
  const result: StandingsTickResult = {
    scoresUpdated: 0,
    overtakesNotified: 0,
    top10Announced: 0,
    weeklyFinalized: false,
  };

  const ws = weekStartUtc(now);
  const we = nextWeekStartUtc(now);
  const wDate = weekStartDate(now);
  const wId = weekId(now);

  for (const isTest of [false, true]) {
    // 1. Compute scores and home towns
    const rawScores = await computeWeeklyScores(poolOrClient, ws, we, isTest);
    const towns = await computeHomeTowns(poolOrClient, isTest);

    // Fetch user details for sorting and privacy
    const userIds = rawScores.map((s) => s.user_id);
    const userMap = new Map<string, { display_name: string; is_public: boolean; share_activity: boolean; created_at: Date }>();
    if (userIds.length > 0) {
      const placeholders = userIds.map((_, i) => `$${i + 1}`).join(', ');
      const uRes = await poolOrClient.query(
        `SELECT id, display_name, is_public, share_activity, created_at FROM users WHERE id IN (${placeholders})`,
        userIds,
      );
      for (const u of uRes.rows) {
        userMap.set(u.id, {
          display_name: u.display_name,
          is_public: Boolean(u.is_public),
          share_activity: Boolean(u.share_activity),
          created_at: new Date(u.created_at),
        });
      }
    }

    const itemsToRank: UserRankInput[] = rawScores.map((s) => ({
      user_id: s.user_id,
      score: s.score,
      quests: s.quests,
      home_town: towns.get(s.user_id) ?? null,
      created_at: userMap.get(s.user_id)?.created_at,
    }));

    const ranked = rankRows(itemsToRank);

    // 2. Load existing weekly scores to detect overtakes and preserve previous ranks
    const oldScoreRes = await poolOrClient.query(
      `SELECT user_id, rank, prev_rank, top10_announced
         FROM plaza_weekly_scores
        WHERE week_start = $1 AND is_test = $2`,
      [wDate, isTest],
    );

    const oldMap = new Map<string, { rank: number; prev_rank: number | null; top10_announced: boolean }>();
    for (const r of oldScoreRes.rows) {
      oldMap.set(r.user_id, {
        rank: Number(r.rank),
        prev_rank: r.prev_rank != null ? Number(r.prev_rank) : null,
        top10_announced: Boolean(r.top10_announced),
      });
    }

    const isFirstRun = oldMap.size === 0;

    // 3. Upsert ranked rows
    for (const r of ranked) {
      const old = oldMap.get(r.user_id);
      const prevRank = old ? old.rank : null;
      const top10Announced = old ? old.top10_announced : false;

      await poolOrClient.query(
        `INSERT INTO plaza_weekly_scores (
           week_start, user_id, score, quests, home_town, rank, prev_rank, top10_announced, is_test, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
         ON CONFLICT (week_start, user_id) DO UPDATE SET
           score = EXCLUDED.score,
           quests = EXCLUDED.quests,
           home_town = EXCLUDED.home_town,
           rank = EXCLUDED.rank,
           prev_rank = EXCLUDED.prev_rank,
           updated_at = NOW()`,
        [wDate, r.user_id, r.score, r.quests, r.home_town, r.rank, prevRank, top10Announced, isTest],
      );
      result.scoresUpdated++;
    }

    // 4. Overtakes (only if not the first run of the week)
    if (!isFirstRun && ranked.length > 1) {
      // Preload follow pairs among ranked users
      const placeholders = userIds.map((_, i) => `$${i + 1}`).join(', ');
      const followsRes = await poolOrClient.query(
        `SELECT follower_id, following_id FROM user_follows WHERE follower_id IN (${placeholders}) AND following_id IN (${placeholders})`,
        userIds,
      );
      const followSet = new Set<string>();
      for (const f of followsRes.rows) {
        followSet.add(`${f.follower_id}:${f.following_id}`);
      }

      for (const rB of ranked) {
        const oldB = oldMap.get(rB.user_id);
        if (!oldB || rB.rank <= oldB.rank) continue; // B must have dropped (new.rank > old.rank)
        if (rB.rank > 100) continue; // B ranks <= 100

        for (const rA of ranked) {
          if (rA.user_id === rB.user_id) continue;
          const oldA = oldMap.get(rA.user_id);
          if (!oldA) continue;

          // A was below B, now A is above B
          const aWasBelow = oldA.rank > oldB.rank;
          const aIsNowAbove = rA.rank < rB.rank;
          if (!aWasBelow || !aIsNowAbove) continue;

          const uA = userMap.get(rA.user_id);
          if (!uA || !uA.is_public || !uA.share_activity) continue;

          const aFollowsB = followSet.has(`${rA.user_id}:${rB.user_id}`);
          const bFollowsA = followSet.has(`${rB.user_id}:${rA.user_id}`);
          const rankClose = Math.abs(rA.rank - rB.rank) <= 3;

          if (aFollowsB || bFollowsA || rankClose) {
            const actorName = uA.display_name;
            await notify(poolOrClient, {
              userId: rB.user_id,
              kind: 'overtaken',
              eventKey: `overtaken:${wId}:${rB.user_id}:${rA.user_id}`,
              title: "You've been passed!",
              message: `${actorName} just passed you on this week's board (#${oldB.rank} → #${rB.rank}). Take it back!`,
              href: '/plaza?period=weekly',
              isTest,
              push: {
                category: 'overtaken',
                collapseKey: `overtaken:${rB.user_id}:${wDate.replace(/-/g, '')}`,
                actorName,
              },
            });
            result.overtakesNotified++;
          }
        }
      }
    }

    // 5. Top-10 entries
    for (const r of ranked) {
      if (r.rank <= 10 && r.score > 0) {
        const old = oldMap.get(r.user_id);
        if (!old || !old.top10_announced) {
          await recordActivity(poolOrClient, {
            eventKey: `rank_top10:${wId}:${r.user_id}`,
            actorId: r.user_id,
            verb: 'rank_top10',
            subjectType: 'rank',
            subjectId: wId,
            subjectTitle: 'Top 10',
            subjectHref: '/plaza?period=weekly',
            payload: { rank: r.rank, week: wId },
            isTest,
          });

          await poolOrClient.query(
            `UPDATE plaza_weekly_scores SET top10_announced = TRUE WHERE week_start = $1 AND user_id = $2`,
            [wDate, r.user_id],
          );
          result.top10Announced++;
        }
      }
    }

    // 6. Weekly finalize (now >= ws + 5 minutes and plaza_job_runs lacks finalize:{prevWeekId})
    const fiveMinutesMs = 5 * 60 * 1000;
    if (now.getTime() >= ws.getTime() + fiveMinutesMs) {
      const prevWeekMs = ws.getTime() - 24 * 60 * 60 * 1000;
      const prevWeekDateObj = new Date(prevWeekMs);
      const prevWId = weekId(prevWeekDateObj);
      const prevWDate = weekStartDate(prevWeekDateObj);
      const jobKey = `finalize:${prevWId}`;

      const jobRunRes = await poolOrClient.query(
        'SELECT 1 FROM plaza_job_runs WHERE job_key = $1',
        [jobKey],
      );

      if (jobRunRes.rows.length === 0) {
        const lastWeekWinners = await poolOrClient.query(
          `SELECT user_id, rank, score
             FROM plaza_weekly_scores
            WHERE week_start = $1 AND is_test = $2 AND score > 0
            ORDER BY rank ASC, user_id ASC
            LIMIT 3`,
          [prevWDate, isTest],
        );

        for (const winner of lastWeekWinners.rows) {
          const wRank = Number(winner.rank);
          const awardDefId = wRank === 1 ? 'weekly_champion' : 'weekly_podium';
          const title = wRank === 1 ? '🏆 Weekly Champion' : '🥈 Weekly Podium';

          // Insert achievement award
          await poolOrClient.query(
            `INSERT INTO achievement_awards (
               id, user_id, achievement_id, season, evidence_version, criteria_version, criteria_snapshot, is_test
             ) VALUES ($1, $2, $3, $4, 'v1', 'v1', '{}'::jsonb, $5)
             ON CONFLICT (user_id, achievement_id, season) DO NOTHING`,
            [randomUUID(), winner.user_id, awardDefId, prevWId, isTest],
          );

          // Record activity
          await recordActivity(poolOrClient, {
            eventKey: `weekly_champion:${prevWId}:${winner.user_id}`,
            actorId: winner.user_id,
            verb: 'weekly_champion',
            subjectType: 'rank',
            subjectId: prevWId,
            subjectTitle: wRank === 1 ? 'Weekly Champion' : 'Weekly Podium',
            subjectHref: '/plaza?period=weekly',
            payload: { place: wRank, week: prevWId },
            isTest,
          });

          // Notify winner
          await notify(poolOrClient, {
            userId: winner.user_id,
            kind: 'weekly_champion',
            eventKey: `weekly_champion:${prevWId}:${winner.user_id}`,
            title,
            message: `You finished #${wRank} on the Plaza for ${prevWId}. Badge unlocked!`,
            href: '/profile',
            isTest,
          });
        }

        await poolOrClient.query(
          `INSERT INTO plaza_job_runs (job_key, finished_at) VALUES ($1, NOW()) ON CONFLICT (job_key) DO NOTHING`,
          [jobKey],
        );
        result.weeklyFinalized = true;
      }
    }
  }

  return result;
}

/**
 * Single tick execution wrapped in a PostgreSQL advisory lock.
 */
async function tick(): Promise<void> {
  if (stopped || running) return;

  const pool = getPool();
  if (!pool) return;

  running = (async () => {
    lastAttemptAt = new Date().toISOString();
    let lockClient: PoolClient | null = null;
    let lockAcquired = false;

    try {
      lockClient = await pool.connect();
      try {
        const lockRes = await lockClient.query(
          'SELECT pg_try_advisory_lock($1) AS locked',
          [PLAZA_STANDINGS_LOCK_KEY],
        );
        lockAcquired = Boolean(lockRes.rows[0]?.locked);
      } catch {
        // Limited environments like pg-mem ignore advisory locks
        lockAcquired = true;
      }

      if (!lockAcquired) {
        return;
      }

      await runStandingsTick(lockClient);
      consecutiveFailures = 0;
      lastSuccessAt = new Date().toISOString();
    } catch (err) {
      consecutiveFailures++;
      console.error('[plaza:standingsJob] Tick error:', err);
    } finally {
      if (lockClient) {
        if (lockAcquired) {
          try {
            await lockClient.query('SELECT pg_advisory_unlock($1)', [PLAZA_STANDINGS_LOCK_KEY]);
          } catch {
            // Ignore unlock errors during teardown
          }
        }
        lockClient.release();
      }
    }
  })();

  try {
    await running;
  } finally {
    running = null;
    if (!stopped) {
      const intervalMs = env.PLAZA_STANDINGS_INTERVAL_MS ?? 300000;
      timer = setTimeout(() => void tick(), intervalMs);
      timer.unref?.();
    }
  }
}

export function startStandingsJob(): void {
  if (!stopped) return;
  stopped = false;
  void tick();
}

export function stopStandingsJob(): void {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
