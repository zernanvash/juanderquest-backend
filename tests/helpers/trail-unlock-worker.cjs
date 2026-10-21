const { Pool } = require('pg');
const { unlockTrail } = require('../../dist/trails/progress.js');
const [schema, userId, trailId, key] = process.argv.slice(2);
if (!/^jdq_test_[a-f0-9]+$/.test(schema || '') || !process.env.JDQ_REAL_PG_URL) {
  throw new Error('Disposable real-PostgreSQL test schema required');
}
const pool = new Pool({ connectionString: process.env.JDQ_REAL_PG_URL, options: `-c search_path=${schema}`, max: 2, connectionTimeoutMillis: 5000 });
unlockTrail(pool, userId, trailId, key)
  .then(async result => { process.stdout.write(JSON.stringify({ success: true, result })); await pool.end(); })
  .catch(async error => { process.stdout.write(JSON.stringify({ success: false, code: error.code || error.message })); await pool.end(); process.exitCode = 1; });
