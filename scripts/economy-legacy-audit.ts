// Read-only Phase 0 audit of the disposable development economy.
// This script does not import the application bootstrap or migration runner.
import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';
import dotenv from 'dotenv';
import { setTimeout as delay } from 'timers/promises';
import { reconcileEconomy, summarizeEconomyReconciliation } from '../src/economy/reconcile.js';

interface AuditSummary {
  audited_at: string;
  profile: 'dev';
  database: string;
  migration_count: number;
  migration_028_present: boolean;
  user_count: number;
  legacy_classifications: Record<string, number>;
  legacy_unbalanced_group_count: number | null;
  pilot_account_drift_count: number | null;
  canonical_digest_sha256: string | null;
  cutover_eligible: false;
  status: 'complete' | 'migration_028_pending';
}

function developmentUrl(): URL {
  const filename = join(__dirname, '..', '.env.dev');
  const parsed = dotenv.parse(readFileSync(filename));
  if (!parsed.DATABASE_URL) throw new Error('DEVELOPMENT_DATABASE_URL_MISSING');
  const url = new URL(parsed.DATABASE_URL);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname) ||
      !database.endsWith('_dev') ||
      !['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('DEVELOPMENT_DATABASE_IDENTITY_MISMATCH');
  }
  return url;
}

export async function auditDevelopmentEconomy(): Promise<AuditSummary> {
  const url = developmentUrl();
  const pool = new Pool({
    connectionString: url.toString(),
    options: '-c default_transaction_read_only=on',
    max: 1,
    connectionTimeoutMillis: 3000,
    query_timeout: 10000,
  });
  try {
    const readOnly = await pool.query('SHOW default_transaction_read_only');
    if (readOnly.rows[0]?.default_transaction_read_only !== 'on') {
      throw new Error('READ_ONLY_SESSION_NOT_CONFIRMED');
    }
    const migrations = await pool.query('SELECT filename FROM schema_migrations ORDER BY filename');
    const has028 = migrations.rows.some((row) => row.filename === '028_economic_backbone.sql');
    const users = await pool.query('SELECT count(*)::int AS count FROM users');
    const result: AuditSummary = {
      audited_at: new Date().toISOString(),
      profile: 'dev',
      database: decodeURIComponent(url.pathname.slice(1)),
      migration_count: migrations.rows.length,
      migration_028_present: has028,
      user_count: Number(users.rows[0].count),
      legacy_classifications: {},
      legacy_unbalanced_group_count: null,
      pilot_account_drift_count: null,
      canonical_digest_sha256: null,
      cutover_eligible: false,
      status: has028 ? 'complete' : 'migration_028_pending',
    };
    if (!has028) return result;

    const findings = await reconcileEconomy(pool);
    const summary = summarizeEconomyReconciliation(findings);
    result.legacy_classifications = summary.legacyClassifications;
    result.legacy_unbalanced_group_count = summary.legacyUnbalancedGroupCount;
    result.pilot_account_drift_count = summary.pilotAccountDriftCount;
    result.canonical_digest_sha256 = summary.canonicalDigestSha256;
    return result;
  } finally {
    await pool.end();
  }
}

export function parseShadowRunArgs(args: string[]): { samples: number; intervalMs: number } {
  let samples = 1;
  let intervalMs = 60_000;
  const seen = new Set<string>();
  for (const arg of args) {
    const match = /^--(samples|interval-ms)=([0-9]+)$/.exec(arg);
    if (!match || seen.has(match[1])) throw new Error('INVALID_SHADOW_SCHEDULE');
    seen.add(match[1]);
    const value = Number(match[2]);
    if (!Number.isSafeInteger(value)) throw new Error('INVALID_SHADOW_SCHEDULE');
    if (match[1] === 'samples') samples = value;
    else intervalMs = value;
  }
  if (samples < 1 || samples > 288 || intervalMs < 1_000 || intervalMs > 86_400_000) {
    throw new Error('INVALID_SHADOW_SCHEDULE');
  }
  return { samples, intervalMs };
}

if (/economy-legacy-audit\.(?:ts|js)$/.test(process.argv[1] ?? '')) {
  (async () => {
    const schedule = parseShadowRunArgs(process.argv.slice(2));
    for (let sample = 1; sample <= schedule.samples; sample++) {
      const summary = await auditDevelopmentEconomy();
      process.stdout.write(JSON.stringify({ sample, ...summary }) + '\n');
      if (sample < schedule.samples) await delay(schedule.intervalMs);
    }
  })().catch((error: unknown) => {
    const knownMessage = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
      ? error.message : null;
    const pgCode = error && typeof error === 'object' && 'code' in error &&
      typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)
      ? error.code : null;
    const code = knownMessage ?? pgCode ?? 'AUDIT_UNAVAILABLE';
    process.stderr.write(code + '\n');
    process.exitCode = 1;
  });
}
