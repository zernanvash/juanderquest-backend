import { randomUUID } from 'crypto';
import { getPool } from '../db/pool.js';
import { EconomicOutboxService } from '../economy/outbox.js';

const INTERVAL_MS = 10_000;
const CONSUMER_KEY = 'internal-audit-v1';
let timer: NodeJS.Timeout | null = null;
let processing = false;
const workerId = `economy-outbox-${process.pid}-${randomUUID()}`;

// Local, durable consumption only. This does not send notifications, index a
// chain, or activate any public economic feature.
export async function drainEconomicOutbox(): Promise<number> {
  if (process.env.JDQ_ENV !== 'dev') return 0;
  const pool = getPool();
  if (!pool) return 0;
  const outbox = new EconomicOutboxService(pool);
  const claims = await outbox.claimBatch(workerId, 20);
  let completed = 0;
  for (const claim of claims) {
    try {
      if (await outbox.complete(claim, CONSUMER_KEY)) completed++;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      try { await outbox.fail(claim, reason); } catch (failure) {
        console.error('[economy-outbox] failure transition unavailable', failure);
      }
    }
  }
  return completed;
}

export function initEconomicOutboxWorker(): void {
  if (timer || process.env.JDQ_ENV !== 'dev' || !getPool()) return;
  timer = setInterval(() => {
    if (processing) return;
    processing = true;
    void drainEconomicOutbox().catch((error) => {
      console.error('[economy-outbox] batch unavailable', error);
    }).finally(() => { processing = false; });
  }, INTERVAL_MS);
  timer.unref();
}
