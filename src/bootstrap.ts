import { initPostgres, getPool } from './db/pool.js';
import { db } from './db/index.js';
import { governanceStore } from './routes/proposals.js';

// Boot orchestration: connect PostgreSQL (when available), hydrate memory + governance, fall back to in-memory.
export async function bootstrap() {
  const pgAvailable = await initPostgres();
  const pool = getPool();
  if (pool) {
    await db.hydrateFromPg(pool);
    await governanceStore.hydrateFromPg(pool);
  } else {
    governanceStore.refreshBalances();
  }
  console.log(
    `[bootstrap] storage: ${pgAvailable ? 'postgres' : 'in-memory'} (${db.users.length} users, ${db.quests.length} quests, ${db.submissions.length} submissions, ${db.vouchers.length} vouchers)`
  );
}
