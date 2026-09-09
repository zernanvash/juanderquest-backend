// Read-only probes limited to the explicitly seeded QA actor; never print tokens.
require('dotenv').config();
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const assert = require('node:assert/strict');
const { env } = require('../dist/config/env.js');
const pool = new Pool({ connectionString: env.DATABASE_URL });
async function run() {
  const actor = 'qa-social-20260909-user-3';
  const counts = {};
  for (const table of ['users','spots','quests','submissions']) {
    const result = await pool.query(`SELECT count(*)::int AS count FROM ${table} WHERE id LIKE $1`, ['qa-social-20260909-%']);
    counts[table] = result.rows[0].count;
  }
  assert.deepEqual(counts, { users: 4, spots: 24, quests: 3, submissions: 9 });
  const token = jwt.sign({ id: actor, role: 'user' }, env.JWT_SECRET, { expiresIn: '60s' });
  for (const type of ['followers','following']) {
    const own = await fetch(`http://127.0.0.1:${env.PORT}/api/v1/users/me/${type}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(own.status, 200);
    const data = await own.json();
    assert.ok(Array.isArray(data.data.items));
    const publicResult = await fetch(`http://127.0.0.1:${env.PORT}/api/v1/users/${actor}/${type}`);
    assert.equal(publicResult.status, 404);
  }
  console.log({ counts, privateOwnerLists: 'passed', publicPrivacy: 'passed' });
}
run().catch(error => { console.error(error.message); process.exitCode=1; }).finally(() => pool.end());
