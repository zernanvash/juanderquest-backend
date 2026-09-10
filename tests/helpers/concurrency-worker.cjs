const { Pool } = require('pg');
const { setPool } = require('../../dist/db/pool.js');
const { vouchersService } = require('../../dist/services/vouchers.js');

const [connectionString, searchPath, userId, voucherId, idempotencyKey] = process.argv.slice(2);

if (!connectionString || !searchPath || !userId || !voucherId || !idempotencyKey) {
  console.error('Missing required arguments');
  process.exit(1);
}

const pool = new Pool({
  connectionString,
  options: `-c search_path=${searchPath}`,
  max: 3,
  connectionTimeoutMillis: 5000,
});

setPool(pool);

vouchersService
  .redeemVoucher(voucherId, userId, idempotencyKey)
  .then((res) => {
    process.stdout.write(JSON.stringify(res));
    return pool.end();
  })
  .catch((err) => {
    process.stderr.write(err.message || String(err));
    pool.end().finally(() => process.exit(1));
  });
