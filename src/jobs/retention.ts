import type { Pool, PoolClient } from 'pg';
import { env } from '../config/env.js';
import { getPool } from '../db/pool.js';

/**
 * Plan 116 §6.5 retention: deletes rows nobody reads again. Off unless RETENTION_JOB_ENABLED.
 * Each run logs the counts first; with RETENTION_DRY_RUN it only logs.
 * web_analytics_events (raw 180 d → daily aggregates) is deferred until that table holds real volume.
 */
export const RETENTION_RULES = [
  // Sent, skipped or failed push notifications older than 90 days; queued or sending ones are never touched.
  {
    name: 'push_deliveries',
    where: `status IN ('sent', 'skipped', 'failed') AND created_at < now() - interval '90 days'`,
  },
  // One-time codes that expired (or were used) over 30 days ago.
  { name: 'auth_challenges', where: `expires_at < now() - interval '30 days'` },
  // Mail outbox rows that were sent or gave up over 30 days ago.
  { name: 'auth_mail_outbox', where: `status <> 'pending' AND created_at < now() - interval '30 days'` },
] as const;

export interface RetentionResult {
  table: string;
  due: number;
  deleted: number;
}

export async function runRetention(
  pool: Pool | PoolClient,
  options: { dryRun?: boolean } = {},
): Promise<RetentionResult[]> {
  const results: RetentionResult[] = [];
  for (const rule of RETENTION_RULES) {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${rule.name} WHERE ${rule.where}`);
    const due = Number(rows[0]?.n ?? 0);
    let deleted = 0;
    if (due > 0 && !options.dryRun) {
      const res = await pool.query(`DELETE FROM ${rule.name} WHERE ${rule.where}`);
      deleted = res.rowCount ?? 0;
    }
    results.push({ table: rule.name, due, deleted });
  }
  return results;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

async function tick(): Promise<void> {
  const pool = getPool();
  if (!pool || running) return;
  running = true;
  try {
    const results = await runRetention(pool, { dryRun: env.RETENTION_DRY_RUN });
    console.log(
      `[retention]${env.RETENTION_DRY_RUN ? ' dry-run' : ''} ${results.map((r) => `${r.table} due=${r.due} deleted=${r.deleted}`).join(', ')}`,
    );
  } catch (error) {
    console.error('[retention]', error);
  } finally {
    running = false;
  }
}

export function startRetentionJob(): void {
  if (!env.RETENTION_JOB_ENABLED || timer) return;
  const first = setTimeout(() => void tick(), 5 * 60_000); // after boot settles
  first.unref?.();
  timer = setInterval(() => void tick(), 24 * 60 * 60_000);
  timer.unref?.();
}

export function stopRetentionJob(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
