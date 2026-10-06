// Disposable PostgreSQL integration worker. Never point JDQ_REAL_PG_URL at alpha data.
const { Pool } = require('pg');
const { setPool } = require('../dist/db/pool.js');
const { env } = require('../dist/config/env.js');
const { reconcileMonthlySchedulesAt } = require('../dist/juanchoice/monthly-service.js');

(async () => {
  env.JUANCHOICE_ENABLED = true;
  env.JUANCHOICE_SCHEDULER_ENABLED = true;
  env.JUANCHOICE_WRITES_ENABLED = false;
  const pool = new Pool({
    connectionString: process.env.JDQ_REAL_PG_URL,
    options: process.env.JDQ_POOL_OPTIONS,
    max: 2,
  });
  setPool(pool);
  try {
    const summary = await reconcileMonthlySchedulesAt(new Date(process.env.JDQ_MONTHLY_NOW));
    process.stdout.write(JSON.stringify(summary));
  } finally {
    setPool(null);
    await pool.end();
  }
})().catch(error => {
  process.stderr.write(String(error));
  process.exitCode = 1;
});
