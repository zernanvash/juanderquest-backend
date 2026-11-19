import type { Pool } from 'pg';
import { getPool } from '../db/pool.js';
import { env } from '../config/env.js';
import { canonicalSettings } from '../settings/schema.js';
import { lockGovernanceSnapshot, commitGovernanceTransaction } from '../governance/transaction.js';
import { fundingTx, publishFunding } from '../funding/transaction.js';
import { finalizePlan, lockPlan, refreshQuestMirror } from '../funding/plans.js';
import { releaseFundingHold } from '../funding/holds.js';
import { notify } from '../social/notify.js';

/**
 * Accepted-quest idle window (team review 2026-11-19, migration 105).
 * An in-progress attempt expires when the traveler makes no progress for
 * `quest_accept_idle_hours`; the clock starts at acceptance and resets on every
 * verified or submitted task. Expired attempts keep their history, release any
 * reserved funding, and the traveler may accept again.
 */
export const IDLE_REMINDER_HOURS = 12;
const DEFAULT_IDLE_HOURS = 72;

type Queryable = Pick<Pool, 'query'>;

export async function idleWindowHours(q: Queryable): Promise<number> {
  try {
    const result = await q.query('SELECT values FROM system_settings_document WHERE id=1');
    const hours = Number(canonicalSettings(result.rows[0]?.values ?? {}).quest_accept_idle_hours);
    return Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_IDLE_HOURS;
  } catch {
    return DEFAULT_IDLE_HOURS;
  }
}

export function idleExpiresAt(lastProgressAt: unknown, hours: number): string | null {
  const start = new Date(String(lastProgressAt ?? '')).getTime();
  return Number.isFinite(start) ? new Date(start + hours * 3_600_000).toISOString() : null;
}

/** Quests without authored steps are not subject to the idle window. */
function hasAuthoredSteps(steps: unknown): boolean {
  if (typeof steps === 'string') {
    try {
      return hasAuthoredSteps(JSON.parse(steps));
    } catch {
      return false;
    }
  }
  return Array.isArray(steps) && steps.length > 0;
}

/**
 * Expire idle in-progress attempts (optionally only one traveler's / one quest's).
 * Cheap when nothing is due: a single indexed read, no locks.
 */
export async function expireIdleAttempts(
  pool: Pool,
  scope: { userId?: string; questId?: string } = {},
  limit = 100,
): Promise<number> {
  const hours = await idleWindowHours(pool);
  const params: unknown[] = [hours, limit];
  let filter = '';
  if (scope.userId) {
    params.push(scope.userId);
    filter += ` AND a.user_id=$${params.length}`;
  }
  if (scope.questId) {
    params.push(scope.questId);
    filter += ` AND a.quest_id=$${params.length}`;
  }
  const due = await pool.query(
    `SELECT a.id, q.steps FROM quest_attempts a JOIN quests q ON q.id=a.quest_id
      WHERE a.status='in_progress' AND a.last_progress_at <= NOW() - ($1::int * INTERVAL '1 hour')${filter}
      ORDER BY a.last_progress_at LIMIT $2`,
    params,
  );
  let expired = 0;
  for (const row of due.rows) {
    if (!hasAuthoredSteps(row.steps)) continue;
    if (await expireOne(pool, String(row.id), hours)) expired += 1;
  }
  return expired;
}

async function expireOne(pool: Pool, attemptId: string, hours: number): Promise<boolean> {
  const client = await pool.connect();
  const tx = fundingTx(client);
  let questId: string | null = null;
  try {
    await client.query('BEGIN');
    await lockGovernanceSnapshot(client);
    const updated = await client.query(
      `UPDATE quest_attempts SET status='expired', expired_at=NOW(), updated_at=NOW()
        WHERE id=$1 AND status='in_progress' AND last_progress_at <= NOW() - ($2::int * INTERVAL '1 hour')
        RETURNING id, quest_id, user_id`,
      [attemptId, hours],
    );
    const attempt = updated.rows[0];
    if (!attempt) {
      await client.query('ROLLBACK');
      return false;
    }
    questId = String(attempt.quest_id);
    const held = await client.query(
      "SELECT * FROM quest_funding_holds WHERE attempt_id=$1 AND status='held' ORDER BY created_at LIMIT 1",
      [attemptId],
    );
    if (held.rows[0]) {
      const plan = await lockPlan(client, held.rows[0].plan_id);
      const hold = (await client.query('SELECT * FROM quest_funding_holds WHERE id=$1 FOR UPDATE', [held.rows[0].id]))
        .rows[0];
      await releaseFundingHold(tx, hold, plan, String(attempt.user_id), 'idle_expired');
      if (plan.status === 'closing') await finalizePlan(tx, plan, String(attempt.user_id));
    }
    await commitGovernanceTransaction(client);
    publishFunding(tx.groups);
    if (held.rows[0]) await refreshQuestMirror(pool, questId);
    return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * One reminder per acceptance window when about IDLE_REMINDER_HOURS remain.
 * The event key carries the window start, so a reset window can remind again.
 */
export async function sendIdleReminders(pool: Pool, limit = 200): Promise<number> {
  const hours = await idleWindowHours(pool);
  const lead = Math.min(IDLE_REMINDER_HOURS, Math.max(1, Math.floor(hours / 2)));
  const due = await pool.query(
    `SELECT a.id, a.user_id, a.quest_id, a.last_progress_at, q.title, q.steps, u.is_test
       FROM quest_attempts a JOIN quests q ON q.id=a.quest_id JOIN users u ON u.id=a.user_id
      WHERE a.status='in_progress'
        AND a.last_progress_at <= NOW() - (($1::int - $2::int) * INTERVAL '1 hour')
        AND a.last_progress_at > NOW() - ($1::int * INTERVAL '1 hour')
      ORDER BY a.last_progress_at LIMIT $3`,
    [hours, lead, limit],
  );
  let sent = 0;
  for (const row of due.rows) {
    if (!hasAuthoredSteps(row.steps)) continue;
    const windowStart = new Date(row.last_progress_at).getTime();
    const questId = String(row.quest_id);
    const id = await notify(pool, {
      userId: String(row.user_id),
      kind: 'quest_idle',
      eventKey: `quest-idle:${row.id}:${windowStart}`,
      title: 'Your quest is about to expire',
      message: `Complete a task in "${String(row.title).slice(0, 80)}" within ${lead} hours to keep your accepted quest.`,
      href: `/quests/${encodeURIComponent(questId)}`,
      isTest: Boolean(row.is_test),
      push: { category: 'account', collapseKey: `quest-idle:${row.id}` },
    });
    if (id) sent += 1;
  }
  return sent;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

/** Light periodic sweep (5 min); expiry is also evaluated lazily on read/accept. */
export function initQuestIdleSweep(): void {
  if (timer || env.NODE_ENV === 'test') return;
  const tick = async () => {
    const pool = getPool();
    if (!pool || running) return;
    running = true;
    try {
      await expireIdleAttempts(pool);
      await sendIdleReminders(pool);
    } catch (error) {
      console.error('[quest-idle]', error);
    } finally {
      running = false;
    }
  };
  timer = setInterval(() => void tick(), 5 * 60_000);
  timer.unref?.();
}
