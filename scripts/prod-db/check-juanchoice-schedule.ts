// Plan 116: prove a carried JuanChoice schedule starts elections on a fresh database. Runs the real
// scheduler once (reconcileMonthlySchedulesAt) against DATABASE_URL and prints the periods and
// campaigns it created. Use a scratch database (it writes periods/campaigns/candidates).
//   NODE_ENV=test JUANCHOICE_ENABLED=true JUANCHOICE_SCHEDULER_ENABLED=true DATABASE_URL=<scratch owner url> \
//     node node_modules/tsx/dist/cli.mjs scripts/prod-db/check-juanchoice-schedule.ts [iso-now]
import pg from 'pg';
import { setPool } from '../../src/db/pool.js';
import { reconcileMonthlySchedulesAt } from '../../src/juanchoice/monthly-service.js';

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  setPool(pool);
  const now = process.argv[2] ? new Date(process.argv[2]) : new Date();
  console.log('now', now.toISOString(), JSON.stringify(await reconcileMonthlySchedulesAt(now)));
  const periods = await pool.query(
    `SELECT s.schedule_key, to_char(p.period_start,'YYYY-MM-DD') AS week, p.status, p.reason_code, p.selected_theme,
            c.status AS campaign, to_char(c.opens_at,'MM-DD HH24:MI') AS opens,
            (SELECT count(*) FROM juanchoice_candidates k WHERE k.campaign_id=c.id) AS candidates
       FROM juanchoice_schedule_periods p JOIN juanchoice_schedules s ON s.id=p.schedule_id
       LEFT JOIN juanchoice_campaigns c ON c.id=p.campaign_id ORDER BY p.period_start`,
  );
  console.table(periods.rows);
  await pool.end();
}
void main();
