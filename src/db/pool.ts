import { Pool } from 'pg';
import { readFileSync } from 'fs';
import { join } from 'path';
import { env } from '../config/env.js';

const rootDir = join(__dirname, '..', '..');
const MIGRATIONS = ['001_init.sql', '002_runtime.sql', '003_spot_discovery.sql', '004_spot_photos.sql'];

let pool: Pool | null = null;

export function getPool(): Pool | null {
  return pool;
}

// Tries to connect to PostgreSQL and applies migrations + seed. Returns true when PG is active.
export async function initPostgres(): Promise<boolean> {
  if (env.NODE_ENV === 'test') return false;
  const candidate = new Pool({
    connectionString: env.DATABASE_URL,
    connectionTimeoutMillis: 3000,
    max: 5,
  });
  try {
    await candidate.query('SELECT 1');
  } catch (error) {
    console.warn(`[db] PostgreSQL unreachable at ${env.DATABASE_URL} - running with in-memory store.`, (error as Error).message);
    await candidate.end();
    return false;
  }
  pool = candidate;
  await applyMigrations(pool);
  await seedIfEmpty(pool);
  return true;
}

async function applyMigrations(pg: Pool) {
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
