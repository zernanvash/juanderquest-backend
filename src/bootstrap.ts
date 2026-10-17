import { initPostgres, getPool } from './db/pool.js';
import { db } from './db/index.js';
import { governanceStore } from './routes/proposals.js';
import { spotStore } from './spots/store.js';
import { assetStore } from './spots/asset-store.js';
import { initOutboxWorker } from './jobs/outbox-worker.js';
import { initJuanChoiceFinalizer } from './jobs/juanchoice-finalizer.js';
import { initJuanChoiceScheduler } from './jobs/juanchoice-scheduler.js';
import { initEconomyReservationWorker } from './jobs/economy-reservations.js';
import { initEconomicOutboxWorker } from './jobs/economy-outbox.js';
import { initFundingScheduler } from './funding/scheduler.js';
import { startStandingsJob } from './social/standingsJob.js';
import { initFcm } from './push/fcm.js';
import { startPushDispatcher } from './push/dispatcher.js';
import { startWeeklyRecapJob } from './social/weeklyRecapJob.js';

// Boot orchestration: connect PostgreSQL (when available), hydrate memory + governance, fall back to in-memory.
export async function bootstrap() {
  const pgAvailable = await initPostgres();
  const pool = getPool();
  if (pool) {
    await db.hydrateFromPg(pool);
    await governanceStore.hydrateFromPg(pool);
    await spotStore.hydrateFromPg(pool);
    await assetStore.hydrateFromPg(pool);
    startStandingsJob();
    initFcm();
    startPushDispatcher();
    startWeeklyRecapJob();
  } else {
    governanceStore.refreshBalances();
  }
  initOutboxWorker();
  initJuanChoiceFinalizer();
  initJuanChoiceScheduler();
  initEconomyReservationWorker();
  initEconomicOutboxWorker();
  initFundingScheduler();
  console.log(
    `[bootstrap] storage: ${pgAvailable ? 'postgres' : 'in-memory'} (${db.users.length} users, ${db.quests.length} quests, ${db.submissions.length} submissions, ${db.vouchers.length} vouchers)`
  );
}
