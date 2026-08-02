import { Pool } from 'pg';
import { readFileSync } from 'fs';
import { join } from 'path';
import { env } from '../config/env.js';

const rootDir = join(__dirname, '..', '..');
const MIGRATIONS = ['001_init.sql', '002_runtime.sql'];

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
  for (const file of MIGRATIONS) {
    await pool.query(readFileSync(join(rootDir, 'migrations', file), 'utf8'));
  }
  await seedIfEmpty(pool);
  return true;
}

async function seedIfEmpty(pg: Pool) {
  const { rows } = await pg.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM users');
  if (Number(rows[0].count) === 0) {
    const seedSql = readFileSync(join(rootDir, 'seeds', 'development.sql'), 'utf8');
    await pg.query(seedSql);
  }
}
