const { Pool } = require('pg');
const { MemoryDb } = require('../../dist/db/index.js');
const { GovernanceStore } = require('../../dist/governance/store.js');
const [connectionString, schema, user] = process.argv.slice(2);
const url = new URL(connectionString);
if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/jdq_reliability_test' || !/^jdq_test_[a-f0-9]+$/.test(schema)) {
  throw new Error('Disposable test database required');
}
const pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 2, connectionTimeoutMillis: 5000 });
const store = new GovernanceStore(new MemoryDb());
store.attachPg(pool);
store.castProposalVote('cmd-p', user, 'yes', `process-${user}`)
  .then(() => pool.end())
  .catch(async (error) => { console.error(error); await pool.end(); process.exitCode = 1; });
