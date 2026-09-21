// Disposable real-PostgreSQL integration worker, called only by the test suite.
const { Pool } = require('pg');
const { setPool } = require('../dist/db/pool.js');
const { castBallot } = require('../dist/juanchoice/service.js');
const { env } = require('../dist/config/env.js');

(async () => {
  env.JUANCHOICE_ENABLED = true;
  env.JUANCHOICE_WRITES_ENABLED = true;
  env.PROGRESSION_ENABLED = true;
  const pool = new Pool({ connectionString: process.env.JDQ_REAL_PG_URL, options: process.env.JDQ_POOL_OPTIONS, max: 1 });
  setPool(pool);
  try {
    const result = await castBallot(JSON.parse(process.env.JDQ_BALLOT_INPUT));
    process.stdout.write(JSON.stringify({ ok: true, version: result.ballot.version }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, code: error.code || 'UNKNOWN' }));
  } finally {
    setPool(null);
    await pool.end();
  }
})().catch(error => {
  process.stderr.write(String(error));
  process.exitCode = 1;
});
