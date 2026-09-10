import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { vouchersService } from '../src/services/vouchers.js';
import { setPool } from '../src/db/pool.js';

const realIt = process.env.JDQ_REAL_PG_URL ? it : it.skip;

function runWorker(
  connectionString: string,
  searchPath: string,
  userId: string,
  voucherId: string,
  idempotencyKey: string
): Promise<{ stdout: string; stderr: string; code: number; json: any }> {
  const workerPath = path.resolve(__dirname, 'helpers/concurrency-worker.cjs');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [workerPath, connectionString, searchPath, userId, voucherId, idempotencyKey]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => {
      let json = null;
      try {
        json = JSON.parse(stdout);
      } catch {}
      resolve({ stdout, stderr, code: code ?? 0, json });
    });
  });
}

describe('Real PostgreSQL Concurrency and Multi-Process Verification', () => {
  let testDb: TestDbInstance;
  let connectionUrl: string;
  let searchPath: string;

  beforeAll(async () => {
    testDb = await createTestDb();
    setPool(testDb.pool);

    // Extract search_path schema
    const schemaRes = await testDb.pool.query('SELECT current_schema() as cs;');
    searchPath = schemaRes.rows[0].cs;
    connectionUrl = process.env.JDQ_REAL_PG_URL || '';
  });

  afterAll(async () => {
    await testDb.close();
  });

  realIt('runs two independent OS processes concurrently with zero lost ledger updates', async () => {

    // 1. Arrange 2 users in PostgreSQL
    await testDb.pool.query(`
      INSERT INTO users (id, seed_id, display_name, email, handle, is_public, role, demo_points, is_test)
      VALUES 
        ('proc_user_1', 'seed_p1', 'Proc One', 'p1@test.dev', 'proc1', true, 'user', 500, false),
        ('proc_user_2', 'seed_p2', 'Proc Two', 'p2@test.dev', 'proc2', true, 'user', 500, false)
      ON CONFLICT (id) DO UPDATE SET demo_points = 500;
    `);

    // Ensure vouchers exist
    await testDb.pool.query(`
      INSERT INTO merchants (id, name, location, description)
      VALUES ('m_concur', 'Concur Cafe', 'Dagupan', 'Test')
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO vouchers (id, merchant_id, title, description, cost_points, is_active)
      VALUES 
        ('v_p1', 'm_concur', 'Voucher P1', 'Test', 80, true),
        ('v_p2', 'm_concur', 'Voucher P2', 'Test', 120, true)
      ON CONFLICT (id) DO NOTHING;
    `);

    // 2. Launch Process A and Process B concurrently
    const promiseA = runWorker(connectionUrl, searchPath, 'proc_user_1', 'v_p1', 'key_p1_tx');
    const promiseB = runWorker(connectionUrl, searchPath, 'proc_user_2', 'v_p2', 'key_p2_tx');

    const [resA, resB] = await Promise.all([promiseA, promiseB]);

    expect(resA.code).toBe(0);
    expect(resA.json?.success).toBe(true);

    expect(resB.code).toBe(0);
    expect(resB.json?.success).toBe(true);

    // 3. Verify exact balance decrements in database
    const user1 = await testDb.pool.query('SELECT demo_points FROM users WHERE id = $1', ['proc_user_1']);
    const user2 = await testDb.pool.query('SELECT demo_points FROM users WHERE id = $1', ['proc_user_2']);

    expect(user1.rows[0].demo_points).toBe(420); // 500 - 80
    expect(user2.rows[0].demo_points).toBe(380); // 500 - 120

    // 4. Verify governance_ledger table contains rows for both independent processes
    const ledgerP1 = await testDb.pool.query(
      "SELECT * FROM governance_ledger WHERE account = 'proc_user_1' AND type = 'voucher_redemption_debit'"
    );
    const ledgerP2 = await testDb.pool.query(
      "SELECT * FROM governance_ledger WHERE account = 'proc_user_2' AND type = 'voucher_redemption_debit'"
    );

    expect(ledgerP1.rows.length).toBe(1);
    expect(Number(ledgerP1.rows[0].amount_mjdq)).toBe(-80000);

    expect(ledgerP2.rows.length).toBe(1);
    expect(Number(ledgerP2.rows[0].amount_mjdq)).toBe(-120000);

    // 5. Verify governance_snapshot in Postgres retained both debits
    const snapRes = await testDb.pool.query('SELECT data FROM governance_snapshot WHERE id = 1');
    expect(snapRes.rows.length).toBe(1);
    const snapData = snapRes.rows[0].data;
    expect(snapData.ledger.some((e: any) => e.account === 'proc_user_1')).toBe(true);
    expect(snapData.ledger.some((e: any) => e.account === 'proc_user_2')).toBe(true);
  }, 30000);

  realIt('prevents double-spending race condition on the same account under concurrency', async () => {

    // Arrange 2 distinct vouchers costing 80 points each and set user to 100 points
    await testDb.pool.query(`
      INSERT INTO vouchers (id, merchant_id, title, description, cost_points, is_active)
      VALUES 
        ('v_race_a', 'm_concur', 'Race Voucher A', 'Test', 80, true),
        ('v_race_b', 'm_concur', 'Race Voucher B', 'Test', 80, true)
      ON CONFLICT (id) DO NOTHING;
      UPDATE users SET demo_points = 100 WHERE id = 'proc_user_1';
    `);

    // Two workers both attempt to redeem 80 points concurrently on the same user
    const promise1 = runWorker(connectionUrl, searchPath, 'proc_user_1', 'v_race_a', 'key_race_1');
    const promise2 = runWorker(connectionUrl, searchPath, 'proc_user_1', 'v_race_b', 'key_race_2');

    const [res1, res2] = await Promise.all([promise1, promise2]);

    const successes = [res1, res2].filter((r) => r.json?.success === true);
    const failures = [res1, res2].filter((r) => r.json?.success === false);

    // Exactly one must win and one must fail
    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);
    expect(failures[0].json?.error?.code).toBe('INSUFFICIENT_POINTS');

    // Balance in PostgreSQL must be exactly 20 (NOT negative)
    const userRes = await testDb.pool.query('SELECT demo_points FROM users WHERE id = $1', ['proc_user_1']);
    expect(userRes.rows[0].demo_points).toBe(20);
  }, 30000);

  it('verifies normal idempotent replay preserves single deduction and barcode', async () => {
    // 0. Arrange user and voucher for this test (guarantees isolation in both real PG and pg-mem)
    await testDb.pool.query(`
      INSERT INTO users (id, seed_id, display_name, email, handle, is_public, role, demo_points, is_test)
      VALUES ('proc_user_2', 'seed_p2', 'Proc Two', 'p2@test.dev', 'proc2', true, 'user', 500, false)
      ON CONFLICT (id) DO UPDATE SET demo_points = 500;
      INSERT INTO merchants (id, name, location, description)
      VALUES ('m_concur', 'Concur Cafe', 'Dagupan', 'Test')
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO vouchers (id, merchant_id, title, description, cost_points, is_active)
      VALUES ('v_p1', 'm_concur', 'Voucher P1', 'Test', 80, true)
      ON CONFLICT (id) DO NOTHING;
    `);

    // 1. Initial redemption
    const key = 'uncertain_commit_replay_key';
    const res1 = await vouchersService.redeemVoucher('v_p1', 'proc_user_2', key);
    expect(res1.success).toBe(true);
    expect(res1.data?.replayed).toBe(false);
    const initialCode = res1.data?.redemption.code;

    const balanceAfterFirst = (await testDb.pool.query('SELECT demo_points FROM users WHERE id = $1', ['proc_user_2'])).rows[0].demo_points;

    // 2. Client retry with identical idempotency key (simulating network dropped response)
    const res2 = await vouchersService.redeemVoucher('v_p1', 'proc_user_2', key);
    expect(res2.success).toBe(true);
    expect(res2.data?.replayed).toBe(true);
    expect(res2.data?.redemption.code).toBe(initialCode);

    // 3. Balance must remain identical (zero additional charges)
    const balanceAfterSecond = (await testDb.pool.query('SELECT demo_points FROM users WHERE id = $1', ['proc_user_2'])).rows[0].demo_points;
    expect(balanceAfterSecond).toBe(balanceAfterFirst);

    // 4. Exactly one redemption row exists for this key
    const countRes = await testDb.pool.query('SELECT COUNT(*)::text as cnt FROM redemptions WHERE idempotency_key = $1', [key]);
    expect(countRes.rows[0].cnt).toBe('1');
  });
});
