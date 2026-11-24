import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { env } from '../config/env.js';
import { getPool } from '../db/pool.js';
import {
  evaluateAllRiskRules,
  loadRiskThresholds,
  RISK_RULE_NAMES,
  type RiskCandidate,
  type RiskRuleName,
} from '../admin/riskRules.js';
import { log } from '../utils/logger.js';

// Distinct 32-bit advisory lock key ("RISK" = 0x5249534b) so concurrent cron ticks
// or overlapping manual scans cannot run duplicate detections at once.
export const RISK_SCAN_ADVISORY_LOCK_KEY = 0x5249534b;
const RISK_SCAN_INTERVAL_MS = 15 * 60_000;

export interface RiskScanSummary {
  acquired: boolean;
  scanned_at: string;
  total_flagged: number;
  counts_by_rule: Record<RiskRuleName, number>;
}

function emptyCounts(): Record<RiskRuleName, number> {
  return Object.fromEntries(RISK_RULE_NAMES.map((name) => [name, 0])) as Record<RiskRuleName, number>;
}

async function upsertCandidate(pool: { query: Pool['query'] }, candidate: RiskCandidate): Promise<void> {
  await pool.query(
    `INSERT INTO risk_flags (id, user_id, rule, severity, window_start, window_end, evidence, status, is_test)
     VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7::jsonb, 'open', $8)
     ON CONFLICT (user_id, rule, window_start) DO UPDATE
       SET window_end = EXCLUDED.window_end,
           evidence = EXCLUDED.evidence,
           severity = EXCLUDED.severity
     WHERE risk_flags.status = 'open'`,
    [
      `rf_${randomUUID()}`,
      candidate.user_id,
      candidate.rule,
      candidate.severity,
      candidate.window_start.toISOString(),
      candidate.window_end.toISOString(),
      JSON.stringify(candidate.evidence),
      candidate.is_test,
    ],
  );
}

export async function runRiskScan(
  pool: Pool,
  options: { now?: Date; beforeUnlockHook?: () => Promise<void> } = {},
): Promise<RiskScanSummary> {
  const counts = emptyCounts();
  const client = await pool.connect();
  let lockHeld = false;
  try {
    const lockRes = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [
      RISK_SCAN_ADVISORY_LOCK_KEY,
    ]);
    lockHeld = Boolean(lockRes.rows[0]?.locked);
    const now =
      options.now ?? new Date((await client.query<{ db_now: Date }>('SELECT NOW() AS db_now')).rows[0].db_now);
    if (!lockHeld) {
      return {
        acquired: false,
        scanned_at: now.toISOString(),
        total_flagged: 0,
        counts_by_rule: counts,
      };
    }

    const thresholds = await loadRiskThresholds(client);
    const candidates = await evaluateAllRiskRules(client, now, thresholds);

    for (const candidate of candidates) {
      await upsertCandidate(client, candidate);
      counts[candidate.rule] += 1;
    }

    if (options.beforeUnlockHook) {
      await options.beforeUnlockHook();
    }

    return {
      acquired: true,
      scanned_at: now.toISOString(),
      total_flagged: candidates.length,
      counts_by_rule: counts,
    };
  } finally {
    if (lockHeld) {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [RISK_SCAN_ADVISORY_LOCK_KEY]);
      } catch (err) {
        log.error('[risk-scan] failed to release advisory lock:', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    client.release();
  }
}

let timer: NodeJS.Timeout | null = null;
let firstTimeout: NodeJS.Timeout | null = null;

async function tick(): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  try {
    const res = await runRiskScan(pool);
    if (res.acquired) {
      log.info('[risk-scan] completed', {
        total_flagged: res.total_flagged,
        counts_by_rule: res.counts_by_rule,
      });
    }
  } catch (err) {
    log.error('[risk-scan] error:', { error: err instanceof Error ? err.message : String(err) });
  }
}

export function startRiskScanJob(): void {
  if (!env.RISK_SCAN_ENABLED || timer) return;
  firstTimeout = setTimeout(() => void tick(), 60_000);
  firstTimeout.unref?.();
  timer = setInterval(() => void tick(), RISK_SCAN_INTERVAL_MS);
  timer.unref?.();
}

export function stopRiskScanJob(): void {
  if (firstTimeout) {
    clearTimeout(firstTimeout);
    firstTimeout = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
