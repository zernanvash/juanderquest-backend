import { getPool } from '../db/pool.js';
import { EconomyService } from '../economy/service.js';

let timer: NodeJS.Timeout | null = null;

export async function sweepEconomyReservations(): Promise<number> {
  if (process.env.JDQ_ENV !== 'dev') return 0;
  const pool = getPool();
  if (!pool) return 0;
  const realPostgres = process.env.NODE_ENV !== 'test' || Boolean(process.env.JDQ_REAL_PG_URL);
  const rows = await pool.query(realPostgres
    ? `SELECT r.id FROM reward_reservations r
       WHERE (r.status = 'reserved' AND r.expires_at <= now())
          OR (r.status = 'appeal' AND r.appeal_until <= now()
            AND NOT EXISTS (SELECT 1 FROM reward_appeals a
              WHERE a.reservation_id = r.id AND a.status IN ('submitted','approved')))
       ORDER BY r.created_at ASC LIMIT 100`
    : `SELECT id FROM reward_reservations
       WHERE (status = 'reserved' AND expires_at <= now())
          OR (status = 'appeal' AND appeal_until <= now())
       ORDER BY created_at ASC LIMIT 100`);
  const economy = new EconomyService(pool);
  let released = 0;
  for (const row of rows.rows) {
    try {
      if (await economy.releaseExpiredReservation(row.id)) released++;
    } catch (error) {
      console.error('[economy] reservation sweep failed', row.id, error);
    }
  }
  return released;
}

export function initEconomyReservationWorker(): void {
  if (timer || process.env.JDQ_ENV !== 'dev' || !getPool()) return;
  timer = setInterval(() => {
    void sweepEconomyReservations().catch((error) => {
      console.error('[economy] reservation sweep unavailable', error);
    });
  }, 60_000);
  timer.unref();
}
