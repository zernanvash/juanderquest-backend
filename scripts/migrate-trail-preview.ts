import { Pool } from 'pg';
import { applyMigrations, MIGRATIONS } from '../src/db/migrations.js';

async function main() {
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/jdq_preview_codex_dev') {
    throw new Error('Refusing migration unless DATABASE_URL targets loopback jdq_preview_codex_dev.');
  }
  const pool = new Pool({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 3000 });
  try {
    const identity = await pool.query('SELECT current_database() AS name');
    if (identity.rows[0]?.name !== 'jdq_preview_codex_dev') throw new Error('Preview database identity mismatch.');
    const appliedRows = await pool.query('SELECT filename FROM schema_migrations');
    const applied = new Set(appliedRows.rows.map(row => String(row.filename)));
    const expected = new Set(MIGRATIONS.filter(filename => filename !== '055_trail_engine.sql'));
    const missing = [...expected].filter(filename => !applied.has(filename));
    const unknown = [...applied].filter(filename => !MIGRATIONS.includes(filename as typeof MIGRATIONS[number]));
    if (missing.length || unknown.length) throw new Error('Preview DB must be at this branch migration baseline before applying only the trail migration.');
    if (applied.has('055_trail_engine.sql')) {
      console.log('[trail-preview-migrate] migration 055 already recorded; no change.');
      return;
    }
    await applyMigrations(pool);
    const count = await pool.query("SELECT count(*)::int AS count FROM spots WHERE status='published' AND COALESCE(is_test,FALSE)=FALSE");
    console.log(`[trail-preview-migrate] database=jdq_preview_codex_dev migration=055_trail_engine.sql published_non_test_spots=${count.rows[0]?.count ?? 0}`);
  } finally { await pool.end(); }
}

main().catch(error => { console.error(`[trail-preview-migrate] ${error instanceof Error ? error.message : 'migration failed'}`); process.exitCode = 1; });
