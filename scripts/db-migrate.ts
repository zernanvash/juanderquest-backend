// Applies migrations (and optionally development seeds) against the database
// configured by `.env.<JDQ_ENV>`. Deliberately avoids importing config/env.ts
// so migrations can run without full runtime configuration.
import { existsSync } from 'fs';
import { join } from 'path';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import { applyMigrations, seedDevelopmentData } from '../src/db/migrations.js';

function databaseNameFromUrl(connectionString: string): string {
  try {
    return new URL(connectionString).pathname.replace(/^\//, '') || '(unknown)';
  } catch {
    return '(unknown)';
  }
}

async function main() {
  const profile = process.env.JDQ_ENV?.trim() || 'dev';
  const seed = process.argv.includes('--seed');
  const rootDir = join(__dirname, '..');
  const profileFile = join(rootDir, `.env.${profile}`);

  if (!existsSync(profileFile)) {
    console.error(`[db-migrate] Missing ${profileFile}. Copy .env.${profile}.example to .env.${profile} first.`);
    process.exit(1);
  }
  dotenv.config({ path: profileFile });

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error(`[db-migrate] DATABASE_URL is not set in ${profileFile}.`);
    process.exit(1);
  }
  if (seed && profile !== 'dev') {
    console.error(`[db-migrate] Refusing to seed development fixtures into the "${profile}" profile.`);
    process.exit(1);
  }

  const pool = new Pool({ connectionString, connectionTimeoutMillis: 3000, max: 1 });
  try {
    await applyMigrations(pool);
    if (seed) {
      await seedDevelopmentData(pool);
    }
    const { rows } = await pool.query('SELECT filename FROM schema_migrations ORDER BY filename');
    console.log(`[db-migrate] profile=${profile} database=${databaseNameFromUrl(connectionString)} migrations=${rows.length}${seed ? ' seeded=yes' : ''}`);
    for (const row of rows) {
      console.log(`  ✓ ${row.filename}`);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[db-migrate] Failed for profile=${profile}: ${reason}`);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
