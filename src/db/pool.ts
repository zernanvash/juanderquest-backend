import { Pool } from 'pg';
import { env } from '../config/env.js';
import {
  DatabaseRuntimePolicy,
  isDevelopmentSeedEnabled,
  isInMemoryFallbackAllowed,
} from './policy.js';
import { applyMigrations, seedDevelopmentData } from './migrations.js';

// Migration helpers live in a config-free module so scripts and the test
// harness can migrate a database without loading runtime configuration.
export { MIGRATIONS, applyMigrations, seedDevelopmentData } from './migrations.js';

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
