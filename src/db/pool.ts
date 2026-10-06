import { Pool } from 'pg';
import { readFileSync } from 'fs';
import { join } from 'path';
import { env } from '../config/env.js';
import {
  DatabaseRuntimePolicy,
  isDevelopmentSeedEnabled,
  isInMemoryFallbackAllowed,
} from './policy.js';

const rootDir = join(__dirname, '..', '..');
export const MIGRATIONS = [
  '001_init.sql',
  '002_runtime.sql',
  '003_spot_discovery.sql',
  '004_spot_photos.sql',
  '005_crowd_diversion.sql',
  '006_web_analytics.sql',
  '007_public_profiles.sql',
  '008_user_follows.sql',
  '009_synthetic_qa_isolation.sql',
  '010_redemptions_user_voucher_unique.sql',
  '011_governance_ledger.sql',
  '012_qa_evaluator_role.sql',
  '013_progression_identity_foundation.sql',
  '014_progression_hardening_and_retrofits.sql',
  '015_progression_legacy_013_upgrade.sql',
  '016_juanchoice_pilot.sql',
  '017_juanchoice_supporter_quest.sql',
  '018_juanchoice_retention_foundation.sql',
  '019_juanchoice_partnerships_and_budget_guardrails.sql',
  '020_juanchoice_monthly_schedules.sql',
  '021_juanchoice_unverified_offer_quarantine.sql',
  '022_juanchoice_unfunded_budget_quarantine.sql',
  '023_juanchoice_promotion_assessments.sql',
  '024_user_wallet_binding.sql',
];

let pool: Pool | null = null;

export function getPool(): Pool | null {
  return pool;
}

export function setPool(nextPool: Pool | null): void {
  pool = nextPool;
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

  // pg emits errors from idle clients on the Pool itself. Without this
  // listener, a database restart terminates the entire API process.
  if (typeof candidate.on === 'function') {
    candidate.on('error', (error: Error) => {
      console.error(`[db] Idle PostgreSQL connection error: ${error.message}`);
    });
  }

  try {
    await candidate.query('SELECT 1');
    await applyMigrations(candidate);
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

export async function applyMigrations(pg: Pool) {
  await pg.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  for (const file of MIGRATIONS) {
    const applied = await pg.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [file]);
    if (applied.rowCount) continue;

    const client = await pg.connect();
    try {
      await client.query('BEGIN');
      await client.query(readFileSync(join(rootDir, 'migrations', file), 'utf8'));
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

export async function seedDevelopmentData(pg: Pick<Pool, 'query'>) {
  // The seed file is intentionally idempotent. Always replay it when local
  // seeding is enabled so a partially populated development database repairs
  // missing dependency rows (for example quests referenced by seeded spots).
  const seedSql = readFileSync(join(rootDir, 'seeds', 'development.sql'), 'utf8');
  await pg.query(seedSql);
}
