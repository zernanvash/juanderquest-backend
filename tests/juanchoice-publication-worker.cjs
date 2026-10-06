// Disposable PostgreSQL integration worker for admin publication contention.
const { Pool } = require('pg');
const { setPool } = require('../dist/db/pool.js');
const { publishCampaign } = require('../dist/juanchoice/service.js');

(async () => {
  const pool = new Pool({
    connectionString: process.env.JDQ_REAL_PG_URL,
    options: process.env.JDQ_POOL_OPTIONS,
    max: 2,
  });
  setPool(pool);
  try {
    try {
      const campaign = await publishCampaign(process.env.JDQ_CAMPAIGN_ID, process.env.JDQ_ACTOR_ID);
      process.stdout.write(JSON.stringify({ ok: true, status: campaign.status }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, code: error.code || 'UNKNOWN' }));
    }
  } finally {
    setPool(null);
    await pool.end();
  }
})().catch(error => {
  process.stderr.write(String(error));
  process.exitCode = 1;
});
