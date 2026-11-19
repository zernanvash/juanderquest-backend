// Plan 116: owner-only migration command for clusters built by scripts/prod-db/bootstrap.sh.
// The runtime connects as jdq_app with DB_MIGRATION_MODE=verify (no DDL rights), so
// migrations are applied separately with the jdq_owner URL:
//   JDQ_MIGRATE_URL=postgres://jdq_owner:…@127.0.0.1:55461/juanderquest_prod npx tsx scripts/prod-db/migrate.ts
// Afterwards it checks that the app role can see every table (default privileges worked)
// and prints the ledger count. It never prints the URL.
import { Pool } from 'pg';
import { MIGRATIONS, applyMigrations, verifyMigrations } from '../../src/db/migrations.js';

async function main() {
  const url = process.env.JDQ_MIGRATE_URL;
  if (!url) throw new Error('Set JDQ_MIGRATE_URL to the jdq_owner connection string.');
  const parsed = new URL(url);
  if (parsed.username !== 'jdq_owner') throw new Error('JDQ_MIGRATE_URL must use the jdq_owner role.');
  if (!['127.0.0.1', 'localhost'].includes(parsed.hostname)) throw new Error('Loopback hosts only.');

  const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000 });
  try {
    const started = Date.now();
    await applyMigrations(pool);
    await verifyMigrations(pool);
    const { rows } = await pool.query(`
      SELECT count(*)::int AS tables,
             count(*) FILTER (WHERE NOT has_table_privilege('jdq_app', c.oid, 'SELECT,INSERT,UPDATE,DELETE'))::int AS app_missing,
             count(*) FILTER (WHERE NOT has_table_privilege('jdq_readonly', c.oid, 'SELECT'))::int AS ro_missing
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`);
    const r = rows[0];
    console.log(
      `[migrate] db=${parsed.pathname.slice(1)} migrations=${MIGRATIONS.length} tables=${r.tables} ` +
        `app_missing_grants=${r.app_missing} readonly_missing_grants=${r.ro_missing} in ${Date.now() - started} ms`,
    );
    if (r.app_missing || r.ro_missing) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`[migrate] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
