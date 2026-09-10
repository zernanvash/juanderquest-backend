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

  try {
    await candidate.query('SELECT 1');
    await applyMigrations(candidate);
    if (isDevelopmentSeedEnabled(policy)) {
      await seedIfEmpty(candidate);
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

async function seedIfEmpty(pg: Pool) {
  const { rows } = await pg.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM users');
  if (Number(rows[0].count) === 0) {
    const seedSql = readFileSync(join(rootDir, 'seeds', 'development.sql'), 'utf8');
    await pg.query(seedSql);
  }
}
