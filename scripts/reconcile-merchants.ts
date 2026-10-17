import { closePool, getPool, initPostgres } from '../src/db/pool.js';
import { db } from '../src/db/index.js';

// One-off, log-only reconciliation for merchant affiliation durability.
// Reports in-memory merchant entities that have no PostgreSQL row, plus
// affiliation children (audits/memberships) whose parents are missing in the
// database. It never auto-fixes anything.
async function main(): Promise<void> {
  // A read-only report must never migrate the database it inspects: initPostgres()
  // applies pending migrations unless DB_MIGRATION_MODE=verify (2026-10-17 incident,
  // where this script migrated the live alpha DB to 051 with no backup).
  if (process.env.DB_MIGRATION_MODE !== 'verify') {
    console.error('[reconcile] refusing to run: set DB_MIGRATION_MODE=verify so the report cannot migrate the database.');
    process.exit(2);
  }
  await initPostgres();
  const pool = getPool();
  if (!pool) {
    console.log('[reconcile] no PostgreSQL pool available — nothing to reconcile against.');
    process.exit(0);
  }

  await db.hydrateFromPg(pool);

  const { rows: merchantRows } = await pool.query('SELECT id FROM merchants');
  const durableMerchantIds = new Set<string>(merchantRows.map((row: { id: string }) => row.id));
  const memoryOnlyMerchants = db.merchants.filter((merchant) => !durableMerchantIds.has(merchant.id));

  const { rows: applicationRows } = await pool.query('SELECT id FROM merchant_affiliate_applications');
  const durableApplicationIds = new Set<string>(applicationRows.map((row: { id: string }) => row.id));
  const memoryOnlyApplications = db.affiliate_applications.filter((app) => !durableApplicationIds.has(app.id));

  const { rows: membershipRows } = await pool.query('SELECT merchant_id FROM merchant_memberships');
  const orphanMemberships = membershipRows.filter((row: { merchant_id: string }) => !durableMerchantIds.has(row.merchant_id));

  console.log(`[reconcile] merchants: durable=${durableMerchantIds.size} memory=${db.merchants.length} memory-only=${memoryOnlyMerchants.length}`);
  for (const merchant of memoryOnlyMerchants) {
    console.log(`[reconcile]   memory-only merchant ${merchant.id} "${merchant.name}" (application ${merchant.source_application_id ?? 'none'})`);
  }

  console.log(`[reconcile] applications: durable=${durableApplicationIds.size} memory=${db.affiliate_applications.length} memory-only=${memoryOnlyApplications.length}`);
  for (const app of memoryOnlyApplications) {
    console.log(`[reconcile]   memory-only application ${app.id} (user ${app.user_id}, status ${app.status})`);
  }

  console.log(`[reconcile] memberships with missing merchant rows in PostgreSQL: ${orphanMemberships.length}`);
  for (const membership of orphanMemberships) {
    console.log(`[reconcile]   orphan membership -> merchant ${membership.merchant_id}`);
  }

  await closePool();
  process.exit(0);
}

main().catch((error) => {
  console.error('[reconcile] failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
