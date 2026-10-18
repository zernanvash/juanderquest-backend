import { getPool } from '../db/pool.js';
import type { Queryable } from './activity.js';
import {
  weekStartUtc,
  nextWeekStartUtc,
  weekStartDate,
  prevWeekId,
  manilaHour,
  manilaDayOfWeek,
} from './time.js';
import { notify } from './notify.js';

export const PLAZA_WEEKLY_RECAP_LOCK_KEY = 410042;

export interface RecapSummary {
  evaluatedUsers: number;
  recapsSent: number;
  jobKey: string;
  skippedReason?: string;
}

/**
 * Runs the weekly recap job.
 * Condition: Monday in Manila, hour >= 9, job has not run for previous week.
 */
export async function runWeeklyRecap(
  client: Queryable,
  overrideNow?: Date,
  forceRun = false,
): Promise<RecapSummary> {
  const now = overrideNow || new Date();
  const day = manilaDayOfWeek(now);
  const hour = manilaHour(now);

  if (!forceRun) {
    if (day !== 1 || hour < 9) {
      return {
        evaluatedUsers: 0,
        recapsSent: 0,
        jobKey: '',
        skippedReason: 'NOT_MONDAY_AFTER_0900',
      };
    }
  }

  const pWeekId = prevWeekId(now);
  const jobKey = `recap:${pWeekId}`;

  // Check if job already ran
  const runCheck = await client.query('SELECT 1 FROM plaza_job_runs WHERE job_key = $1', [jobKey]);
  if (runCheck.rows.length > 0 && !forceRun) {
    return {
      evaluatedUsers: 0,
      recapsSent: 0,
      jobKey,
      skippedReason: 'ALREADY_RUN',
    };
  }

  // Previous week boundaries
  const currentWeekStart = weekStartUtc(now);
  const prevWeekStart = new Date(currentWeekStart.getTime() - 7 * 24 * 60 * 60 * 1000);
  const prevWeekEnd = currentWeekStart;
  const prevWeekMondayDate = weekStartDate(prevWeekStart);

  // Eligible users: users with at least one active device and push_weekly_recap enabled
  const usersRes = await client.query(
    `SELECT DISTINCT u.id, u.is_test
       FROM users u
       JOIN user_devices d ON d.user_id = u.id AND d.disabled_at IS NULL
       LEFT JOIN user_notification_preferences p ON p.user_id = u.id
      WHERE COALESCE(p.push_weekly_recap, TRUE) = TRUE`,
  );

  const users = usersRes.rows;
  let recapsSent = 0;

  for (const user of users) {
    const userId = user.id;
    const isTest = Boolean(user.is_test);

    // 1. Weekly standing for previous week
    const standingRes = await client.query(
      `SELECT rank, prev_rank, score, quests
         FROM plaza_weekly_scores
        WHERE user_id = $1 AND week_start = $2`,
      [userId, prevWeekMondayDate],
    );

    const standing = standingRes.rows[0];
    const isRanked = standing && standing.rank != null && Number(standing.score) > 0;

    // 2. Count friends' quest completions
    const friendsRes = await client.query(
      `SELECT COUNT(DISTINCT a.actor_id)::int AS friend_count,
              COUNT(a.id)::int AS quest_count
         FROM social_activities a
         JOIN user_follows f ON f.following_id = a.actor_id
        WHERE f.follower_id = $1
          AND a.verb = 'quest_completed'
          AND a.created_at >= $2 AND a.created_at < $3
          AND a.is_test = $4`,
      [userId, prevWeekStart, prevWeekEnd, isTest],
    );

    const friendCount = Number(friendsRes.rows[0]?.friend_count || 0);
    const questCount = Number(friendsRes.rows[0]?.quest_count || 0);

    // 3. Suggested quest
    let suggestedQuest: string | null = null;
    if (friendCount > 0) {
      const friendQRes = await client.query(
        `SELECT a.subject_title, COUNT(*)::int AS cnt
           FROM social_activities a
           JOIN user_follows f ON f.following_id = a.actor_id
          WHERE f.follower_id = $1
            AND a.verb = 'quest_completed'
            AND a.created_at >= $2 AND a.created_at < $3
            AND a.is_test = $4
            AND a.subject_id NOT IN (
              SELECT quest_id FROM submissions WHERE user_id = $1 AND status = 'approved'
            )
          GROUP BY a.subject_title
          ORDER BY cnt DESC
          LIMIT 1`,
        [userId, prevWeekStart, prevWeekEnd, isTest],
      );
      if (friendQRes.rows.length > 0) {
        suggestedQuest = friendQRes.rows[0].subject_title;
      }
    }

    if (!suggestedQuest) {
      const overallQRes = await client.query(
        `SELECT subject_title, COUNT(*)::int AS cnt
           FROM social_activities
          WHERE verb = 'quest_completed'
            AND created_at >= $1 AND created_at < $2
            AND is_test = $3
            AND subject_id NOT IN (
              SELECT quest_id FROM submissions WHERE user_id = $4 AND status = 'approved'
            )
          GROUP BY subject_title
          ORDER BY cnt DESC
          LIMIT 1`,
        [prevWeekStart, prevWeekEnd, isTest, userId],
      );
      if (overallQRes.rows.length > 0) {
        suggestedQuest = overallQRes.rows[0].subject_title;
      }
    }

    // 4. Construct body
    let body = '';
    if (isRanked) {
      const rank = standing.rank;
      const prevRank = standing.prev_rank;
      const delta = prevRank && rank ? prevRank - rank : 0;
      const deltaStr = delta > 0 ? `▲${delta}` : delta < 0 ? `▼${Math.abs(delta)}` : '―';
      const suggestStr = suggestedQuest ? ` Try ${suggestedQuest}?` : '';
      body = `You finished #${rank} (${deltaStr}) with ${standing.score} pts. ${friendCount} explorers you follow completed ${questCount} quests.${suggestStr}`;
    } else {
      const suggestStr = suggestedQuest ? ` Start yours with ${suggestedQuest}.` : '';
      body = `${friendCount} explorers you follow completed ${questCount} quests last week.${suggestStr}`;
    }

    // Trim to 240 chars
    body = body.slice(0, 240);

    const notifId = await notify(client, {
      userId,
      kind: 'weekly_recap',
      eventKey: `weekly_recap:${pWeekId}:${userId}`,
      title: 'Your week on the Plaza',
      message: body,
      href: '/plaza?period=weekly',
      isTest,
      push: {
        category: 'weekly_recap',
        collapseKey: `recap:${userId}:${pWeekId}`,
      },
    });

    if (notifId) {
      recapsSent++;
    }
  }

  // Record job completion
  await client.query(
    `INSERT INTO plaza_job_runs (job_key, finished_at)
     VALUES ($1, NOW())
     ON CONFLICT (job_key) DO NOTHING`,
    [jobKey],
  );

  return {
    evaluatedUsers: users.length,
    recapsSent,
    jobKey,
  };
}

let recapJobTimer: NodeJS.Timeout | null = null;
let isRecapRunning = false;

export async function runWeeklyRecapTick(): Promise<void> {
  if (isRecapRunning) return;
  const pool = getPool();
  if (!pool) return;

  const client = await pool.connect();
  let locked = false;
  try {
    const lockRes = await client.query('SELECT pg_try_advisory_lock($1) AS acquired', [
      PLAZA_WEEKLY_RECAP_LOCK_KEY,
    ]);
    locked = Boolean(lockRes.rows[0]?.acquired);
    if (!locked) return;

    isRecapRunning = true;
    await runWeeklyRecap(client);
  } catch (err) {
    console.error('[weeklyRecapJob:tick] Error executing weekly recap:', err);
  } finally {
    isRecapRunning = false;
    if (locked) {
      await client.query('SELECT pg_advisory_unlock($1)', [PLAZA_WEEKLY_RECAP_LOCK_KEY]).catch(() => {});
    }
    client.release();
  }
}

export function startWeeklyRecapJob(): void {
  if (recapJobTimer) return;
  // Checks every 10 minutes
  recapJobTimer = setInterval(() => {
    void runWeeklyRecapTick();
  }, 10 * 60 * 1000);
  // Never keep the process alive on its own (graceful shutdown, test runners).
  recapJobTimer.unref?.();

  console.log('[weeklyRecapJob] Started weekly recap job (checks every 10 min)');
}

export function stopWeeklyRecapJob(): void {
  if (recapJobTimer) {
    clearInterval(recapJobTimer);
    recapJobTimer = null;
    console.log('[weeklyRecapJob] Stopped weekly recap job');
  }
}
