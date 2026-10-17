import { Pool } from 'pg';
import { env } from '../config/env.js';
import {
  DatabaseRuntimePolicy,
  isDevelopmentSeedEnabled,
  isInMemoryFallbackAllowed,
} from './policy.js';
import { applyMigrations, seedDevelopmentData, verifyMigrations } from './migrations.js';

// Migration helpers live in a config-free module so scripts and the test
// harness can migrate a database without loading runtime configuration.
export { MIGRATIONS, applyMigrations, seedDevelopmentData, verifyMigrations } from './migrations.js';

let pool: Pool | null = null;
const benchmarkDurationsMs: number[] = [];
let benchmarkQueryCount = 0;
let benchmarkQueryErrors = 0;
const benchmarkTelemetryEnabled = process.env.ECONOMY_BENCH_TRACE === 'true' &&
  process.env.JDQ_ENV === 'dev' && process.env.NODE_ENV !== 'production' &&
  /\/jdq_economy_lab_[a-f0-9]{12}_dev(?:\?|$)/.test(process.env.DATABASE_URL || '');

function recordBenchmarkQuery(begin: bigint, failed: boolean) {
  benchmarkQueryCount++;
  if (failed) benchmarkQueryErrors++;
  benchmarkDurationsMs.push(Number(process.hrtime.bigint() - begin) / 1_000_000);
  if (benchmarkDurationsMs.length > 20000) benchmarkDurationsMs.shift();
}

export function getEconomyBenchmarkTelemetry() {
  if (!benchmarkTelemetryEnabled || !pool) return null;
  const sorted = [...benchmarkDurationsMs].sort((a, b) => a - b);
  const percentile = (fraction: number) => sorted.length
    ? Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] * 100) / 100 : null;
  return { enabled: true, query_count: benchmarkQueryCount, query_errors: benchmarkQueryErrors,
    sql_roundtrip_ms: { sample_count: sorted.length, p50: percentile(0.5), p95: percentile(0.95),
      p99: percentile(0.99), max: sorted.length ? Math.round(sorted.at(-1)! * 100) / 100 : null },
    pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount, max: 5 },
    note: 'Client-side PostgreSQL query round trip, including network/lock wait; not server execution-only time.' };
}

export function getPool(): Pool | null {
  return pool;
}

export function setPool(nextPool: Pool | null): void {
  pool = nextPool;
}

// Graceful shutdown helper: stop handing out connections and close the pool.
export async function closePool(): Promise<void> {
  const current = pool;
  pool = null;
  if (current) await current.end();
}

export interface InitPostgresOptions {
  policy?: DatabaseRuntimePolicy;
  poolFactory?: () => Pool;
}

function runtimePolicy(): DatabaseRuntimePolicy {
  return {
    nodeEnv: env.NODE_ENV,
    allowInMemoryFallback: env.ALLOW_IN_MEMORY_FALLBACK,
    seedDevelopmentData: env.SEED_DEVELOPMENT_DATA,
  };
}

// Connects PostgreSQL and applies migrations before exposing the pool as ready.
// The only fallback is an explicitly enabled development/test memory fixture.
export async function initPostgres(options: InitPostgresOptions = {}): Promise<boolean> {
  const policy = options.policy ?? runtimePolicy();
  const fallbackAllowed = isInMemoryFallbackAllowed(policy);

  if (policy.nodeEnv === 'test' && fallbackAllowed && !options.poolFactory) return false;

  const candidate = options.poolFactory?.() ?? new Pool({
    connectionString: env.DATABASE_URL,
    connectionTimeoutMillis: 3000,
    query_timeout: 5000,
    max: 5,
  });
  if (benchmarkTelemetryEnabled && !options.poolFactory) {
    candidate.on('connect', (client) => {
      const target = client as unknown as { query: (...args: unknown[]) => Promise<unknown> };
      const original = target.query.bind(client);
      target.query = (...args: unknown[]) => {
        const begin = process.hrtime.bigint();
        const outcome = original(...args);
        if (!outcome || typeof outcome.then !== 'function') return outcome;
        return outcome.then(value => { recordBenchmarkQuery(begin, false); return value; },
          error => { recordBenchmarkQuery(begin, true); throw error; });
      };
    });
  }

  // pg emits errors from idle clients on the Pool itself. Without this
  // listener, a database restart terminates the entire API process.
  if (typeof candidate.on === 'function') {
    candidate.on('error', (error: Error) => {
      console.error(`[db] Idle PostgreSQL connection error: ${error.message}`);
    });
  }

  try {
    await candidate.query('SELECT 1');
    if (env.DB_MIGRATION_MODE === 'verify') await verifyMigrations(candidate);
    else await applyMigrations(candidate);
    if (isDevelopmentSeedEnabled(policy)) {
      await seedDevelopmentData(candidate);
    }
    pool = candidate;
    return true;
  } catch (error) {
    pool = null;
    try {
      await candidate.end();
    } catch {
      // Preserve the initialization failure as the actionable startup error.
    }

    const reason = error instanceof Error ? error.message : 'unknown PostgreSQL error';
    if (fallbackAllowed) {
      console.warn(`[db] PostgreSQL initialization failed; explicit in-memory fallback is active. ${reason}`);
      return false;
    }

    throw new Error(`PostgreSQL initialization failed; refusing to start without durable storage. ${reason}`, {
      cause: error,
    });
  }
}
