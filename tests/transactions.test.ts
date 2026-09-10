import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { setPool } from '../src/db/pool.js';
import { db } from '../src/db/index.js';
import { submissionsService } from '../src/services/submissions.js';
import { vouchersService } from '../src/services/vouchers.js';
import { governanceStore } from '../src/routes/proposals.js';
import { randomUUID } from 'crypto';

describe('Phase 3: Atomic Submission, Review and Redemption Lifecycle', () => {
  let testDb: TestDbInstance;

  beforeAll(async () => {
    testDb = await createTestDb();
    setPool(testDb.pool);
    await db.hydrateFromPg(testDb.pool);

    // Ensure test users and test quests exist
    await testDb.pool.query(`
      INSERT INTO users (id, seed_id, display_name, email, role, demo_points, is_public)
      VALUES 
        ('usr_alice_tx', 'seed_alice_tx', 'Alice Tx', 'alice.tx@test.com', 'user', 100, true),
        ('usr_admin_tx', 'seed_admin_tx', 'Admin Tx', 'admin.tx@test.com', 'admin', 500, true)
      ON CONFLICT (id) DO UPDATE SET demo_points = EXCLUDED.demo_points;
    `);

    await testDb.pool.query(`
      INSERT INTO quests (id, title, description, category, location_name, gps_lat, gps_lng, radius_meters, reward_points, marker_code, marker_image_url, is_active)
      VALUES 
        ('q_active_tx', 'Active Quest', 'Active quest description', 'cultural', 'Dagupan', 16.0433, 120.3333, 100, 50, 'MARKER_ACTIVE', 'https://example.com/marker-active.png', true),
        ('q_inactive_tx', 'Archived Seasonal Quest', 'Archived quest', 'eco', 'Bolinao', 16.3842, 119.8936, 100, 75, 'MARKER_INACTIVE', 'https://example.com/marker-inactive.png', false)
      ON CONFLICT (id) DO NOTHING;
    `);

    await testDb.pool.query(`
      INSERT INTO merchants (id, name, location, description)
      VALUES ('m_test', 'Test Merchant', 'Dagupan City', 'Merchant for tests')
      ON CONFLICT (id) DO NOTHING;
    `);

    await testDb.pool.query(`
      INSERT INTO vouchers (id, merchant_id, title, description, cost_points, is_active)
      VALUES 
        ('v_cost_80_a', 'm_test', 'Voucher 80A', 'Costs 80 points', 80, true),
        ('v_cost_80_b', 'm_test', 'Voucher 80B', 'Costs 80 points', 80, true)
      ON CONFLICT (id) DO NOTHING;
    `);

    // Reload memory state
    await db.hydrateFromPg(testDb.pool);
  });

  afterAll(async () => {
    setPool(null);
    await testDb.close();
  });

  describe('Submissions Idempotency and Conflict Detection', () => {
    it('creates submission, and safely replays when receiving the same idempotency key with identical payload', async () => {
      const key = randomUUID();
      const payload = {
        idempotency_key: key,
        user_id: 'usr_alice_tx',
        quest_id: 'q_active_tx',
        scanned_marker_code: 'MARKER_ACTIVE',
        captured_lat: 16.0433,
        captured_lng: 120.3333,
        captured_accuracy: 5.0,
      };

      const first = await submissionsService.createSubmission(payload);
      expect(first.success).toBe(true);
      expect(first.statusCode).toBe(201);
      expect(first.data?.id).toBeDefined();

      // Second call: same key, same payload
      const replay = await submissionsService.createSubmission(payload);
      expect(replay.success).toBe(true);
      expect(replay.statusCode).toBe(200);
      expect(replay.data?.id).toBe(first.data?.id);
    });

    it('rejects with 409 IDEMPOTENCY_CONFLICT when receiving the same idempotency key with different parameters', async () => {
      const key = randomUUID();
      const payload1 = {
        idempotency_key: key,
        user_id: 'usr_alice_tx',
        quest_id: 'q_active_tx',
        scanned_marker_code: 'MARKER_ACTIVE',
        captured_lat: 16.0433,
        captured_lng: 120.3333,
        captured_accuracy: 5.0,
      };

      const first = await submissionsService.createSubmission(payload1);
      expect(first.success).toBe(true);

      // Same key, but different marker code / quest
      const conflictingPayload = {
        ...payload1,
        scanned_marker_code: 'DIFFERENT_MARKER',
      };

      const conflict = await submissionsService.createSubmission(conflictingPayload);
      expect(conflict.success).toBe(false);
      expect(conflict.statusCode).toBe(409);
      expect(conflict.error?.code).toBe('IDEMPOTENCY_CONFLICT');
    });
  });

  describe('Atomic Review Transitions and Anti-Double-Award Invariants', () => {
    it('concurrent approves award points only once, and second review call replays with awarded_points = 0', async () => {
      // Create a fresh pending submission
      const subRes = await submissionsService.createSubmission({
        idempotency_key: randomUUID(),
        user_id: 'usr_alice_tx',
        quest_id: 'q_active_tx',
        scanned_marker_code: 'MARKER_ACTIVE',
        captured_lat: 16.0433,
        captured_lng: 120.3333,
        captured_accuracy: 5.0,
      });
      const subId = subRes.data!.id;

      // Reset Alice's points to 100
      await testDb.pool.query('UPDATE users SET demo_points = 100 WHERE id = $1', ['usr_alice_tx']);

      // Call review approve twice concurrently
      const [res1, res2] = await Promise.all([
        submissionsService.reviewSubmission(subId, 'approve', 'usr_admin_tx'),
        submissionsService.reviewSubmission(subId, 'approve', 'usr_admin_tx'),
      ]);

      expect(res1.success).toBe(true);
      expect(res2.success).toBe(true);

      const totalAwarded = (res1.data?.awarded_points || 0) + (res2.data?.awarded_points || 0);
      // q_active_tx reward_points is 50. Total points awarded across both calls must be exactly 50!
      expect(totalAwarded).toBe(50);

      // Verify PostgreSQL user balance: 100 + 50 = 150
      const userRes = await testDb.pool.query('SELECT demo_points FROM users WHERE id = $1', ['usr_alice_tx']);
      expect(userRes.rows[0].demo_points).toBe(150);
    });

    it('rejects terminal state transitions (approve after reject) with 409 STATE_CONFLICT', async () => {
      // Clean previous submissions for active quest to allow fresh submission
      await testDb.pool.query('DELETE FROM submissions WHERE user_id = $1', ['usr_alice_tx']);
      db.submissions = [];

      const subRes = await submissionsService.createSubmission({
        idempotency_key: randomUUID(),
        user_id: 'usr_alice_tx',
        quest_id: 'q_active_tx',
        scanned_marker_code: 'MARKER_ACTIVE',
        captured_lat: 16.0433,
        captured_lng: 120.3333,
        captured_accuracy: 5.0,
      });
      expect(subRes.success).toBe(true);
      const subId = subRes.data!.id;

      // First action: reject
      const rejectRes = await submissionsService.reviewSubmission(subId, 'reject', 'usr_admin_tx', 'Blurry photo');
      expect(rejectRes.success).toBe(true);

      // Second conflicting action: approve
      const approveConflict = await submissionsService.reviewSubmission(subId, 'approve', 'usr_admin_tx');
      expect(approveConflict.success).toBe(false);
      expect(approveConflict.statusCode).toBe(409);
      expect(approveConflict.error?.code).toBe('STATE_CONFLICT');
    });

    it('retains inactive quests in history and review calculations without turning into Unknown Quest', async () => {
      const histId = `sub_hist_${Date.now()}`;
      await testDb.pool.query(`
        INSERT INTO submissions (id, idempotency_key, user_id, quest_id, scanned_marker_code, captured_lat, captured_lng, captured_accuracy, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'approved')
      `, [histId, randomUUID(), 'usr_alice_tx', 'q_inactive_tx', 'MARKER_INACTIVE', 16.3842, 119.8936, 5.0]);

      await db.hydrateFromPg(testDb.pool);

      // Verify history listing contains retained quest details
      const userHistory = db.listSubmissionsForUser('usr_alice_tx');
      const inactiveSub = userHistory.find((s) => s.id === histId);
      expect(inactiveSub).toBeDefined();
      expect(inactiveSub!.quest_title).toBe('Archived Seasonal Quest');
      expect(inactiveSub!.reward_points).toBe(75);
      expect(inactiveSub!.category).toBe('eco');
    });
  });

  describe('Atomic Voucher Redemptions and Anti-Overspending Invariants', () => {
    it('prevents overspending under concurrent redemptions: exactly one 80-pt redemption succeeds from a 100-pt balance', async () => {
      // Clean previous redemptions and set Alice's points to exactly 100
      await testDb.pool.query('DELETE FROM redemptions WHERE user_id = $1', ['usr_alice_tx']);
      await testDb.pool.query('UPDATE users SET demo_points = 100 WHERE id = $1', ['usr_alice_tx']);
      db.redemptions = [];

      // Attempt two concurrent redemptions of 80-point vouchers with different idempotency keys
      const [resA, resB] = await Promise.all([
        vouchersService.redeemVoucher('v_cost_80_a', 'usr_alice_tx', randomUUID()),
        vouchersService.redeemVoucher('v_cost_80_b', 'usr_alice_tx', randomUUID()),
      ]);

      const successCount = (resA.success ? 1 : 0) + (resB.success ? 1 : 0);
      const failCount = (!resA.success ? 1 : 0) + (!resB.success ? 1 : 0);

      // Exactly one must succeed, and one must fail due to INSUFFICIENT_POINTS
      expect(successCount).toBe(1);
      expect(failCount).toBe(1);

      const failedResult = !resA.success ? resA : resB;
      expect(failedResult.statusCode).toBe(409);
      expect(failedResult.error?.code).toBe('INSUFFICIENT_POINTS');

      // Check PostgreSQL user points: 100 - 80 = 20 (never negative!)
      const userRes = await testDb.pool.query('SELECT demo_points FROM users WHERE id = $1', ['usr_alice_tx']);
      expect(userRes.rows[0].demo_points).toBe(20);
    });

    it('rejects reuse of the same idempotency key with different voucher IDs with 409 IDEMPOTENCY_CONFLICT', async () => {
      // Clean redemptions and set points to 500
      await testDb.pool.query('DELETE FROM redemptions WHERE user_id = $1', ['usr_alice_tx']);
      await testDb.pool.query('UPDATE users SET demo_points = 500 WHERE id = $1', ['usr_alice_tx']);
      db.redemptions = [];

      const sharedKey = randomUUID();

      const first = await vouchersService.redeemVoucher('v_cost_80_a', 'usr_alice_tx', sharedKey);
      expect(first.success).toBe(true);

      // Reuse same key for voucher v_cost_80_b
      const second = await vouchersService.redeemVoucher('v_cost_80_b', 'usr_alice_tx', sharedKey);
      expect(second.success).toBe(false);
      expect(second.statusCode).toBe(409);
      expect(second.error?.code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('R2 regression: simultaneous requests cannot redeem the same voucher twice even with different keys and sufficient balance', async () => {
      // Alice has 500 points (plenty for multiple 80-pt redemptions)
      await testDb.pool.query('DELETE FROM redemptions WHERE user_id = $1', ['usr_alice_tx']);
      await testDb.pool.query('UPDATE users SET demo_points = 500 WHERE id = $1', ['usr_alice_tx']);
      db.redemptions = [];

      // Two simultaneous requests attempt to redeem the exact same voucher with different idempotency keys
      const [res1, res2] = await Promise.all([
        vouchersService.redeemVoucher('v_cost_80_a', 'usr_alice_tx', randomUUID()),
        vouchersService.redeemVoucher('v_cost_80_a', 'usr_alice_tx', randomUUID()),
      ]);

      const success = [res1, res2].filter((r) => r.success);
      const failures = [res1, res2].filter((r) => !r.success);

      expect(success).toHaveLength(1);
      expect(failures).toHaveLength(1);
      expect(failures[0].statusCode).toBe(409);
      expect(failures[0].error?.code).toBe('ALREADY_REDEEMED');

      // Alice was deducted exactly once: 500 - 80 = 420
      const userRes = await testDb.pool.query('SELECT demo_points FROM users WHERE id = $1', ['usr_alice_tx']);
      expect(userRes.rows[0].demo_points).toBe(420);

      // In database, exactly one row exists in redemptions for (user_id, voucher_id)
      const redRes = await testDb.pool.query('SELECT * FROM redemptions WHERE user_id = $1 AND voucher_id = $2', ['usr_alice_tx', 'v_cost_80_a']);
      expect(redRes.rows).toHaveLength(1);
    });

    it('R2 regression: simultaneous requests with the SAME idempotency key resolve to durable replay without 500 crashes', async () => {
      await testDb.pool.query('DELETE FROM redemptions WHERE user_id = $1', ['usr_alice_tx']);
      await testDb.pool.query('UPDATE users SET demo_points = 500 WHERE id = $1', ['usr_alice_tx']);
      db.redemptions = [];

      const sharedKey = `shared_key_${Date.now()}`;
      const [res1, res2] = await Promise.all([
        vouchersService.redeemVoucher('v_cost_80_a', 'usr_alice_tx', sharedKey),
        vouchersService.redeemVoucher('v_cost_80_a', 'usr_alice_tx', sharedKey),
      ]);

      expect(res1.success).toBe(true);
      expect(res2.success).toBe(true);
      expect(res1.data?.redemption.code).toBe(res2.data?.redemption.code);

      // Points deducted only once
      const userRes = await testDb.pool.query('SELECT demo_points FROM users WHERE id = $1', ['usr_alice_tx']);
      expect(userRes.rows[0].demo_points).toBe(420);
    });

    it('R3 regression: ledger updates and user points commit atomically in the same transaction', async () => {
      await testDb.pool.query('DELETE FROM redemptions WHERE user_id = $1', ['usr_alice_tx']);
      await testDb.pool.query('UPDATE users SET demo_points = 500 WHERE id = $1', ['usr_alice_tx']);
      db.redemptions = [];

      const result = await vouchersService.redeemVoucher('v_cost_80_a', 'usr_alice_tx', randomUUID());
      expect(result.success).toBe(true);

      // Verify governance_snapshot in Postgres has persisted the debit
      const snapRes = await testDb.pool.query('SELECT data FROM governance_snapshot WHERE id = 1');
      expect(snapRes.rows.length).toBeGreaterThan(0);
      const snapData = snapRes.rows[0].data;
      expect(snapData.ledger.some((e: any) => e.type === 'voucher_redemption_debit' && e.reference_id === 'v_cost_80_a')).toBe(true);
    });

    it('deducts voucher points exactly once across SQL, in-memory, and governance store (never twice)', async () => {
      await testDb.pool.query('DELETE FROM redemptions WHERE user_id = $1', ['usr_alice_tx']);
      await testDb.pool.query('UPDATE users SET demo_points = 100 WHERE id = $1', ['usr_alice_tx']);
      await db.hydrateFromPg(testDb.pool);
      db.redemptions = [];

      // Initial state: Alice has 100 points
      const initialMemUser = db.findUserById('usr_alice_tx');
      expect(initialMemUser?.demo_points).toBe(100);

      // Alice redeems voucher costing 80 points
      const result = await vouchersService.redeemVoucher('v_cost_80_a', 'usr_alice_tx', randomUUID());
      expect(result.success).toBe(true);

      // SQL balance must be exactly 20 (100 - 80)
      const sqlRes = await testDb.pool.query('SELECT demo_points FROM users WHERE id = $1', ['usr_alice_tx']);
      expect(sqlRes.rows[0].demo_points).toBe(20);

      // In-memory balance must be exactly 20 (NOT -60 from double deduction!)
      const memUser = db.findUserById('usr_alice_tx');
      expect(memUser?.demo_points).toBe(20);

      // Governance store balance must match (20 * 1,000 = 20,000 mJDQ)
      expect(governanceStore.balanceOf('usr_alice_tx')).toBe(20_000);
    });

    it('ensures governance rollback cleans up ledger entries and does not share mutated arrays', async () => {
      const initialLedgerCount = governanceStore.getLedger().length;
      const snapshot = governanceStore.snapshot();

      // Inject a transaction with a failing client query
      const failingClient = {
        query: jest.fn().mockRejectedValue(new Error('Simulated database write failure')),
      };

      try {
        await governanceStore.creditQuestReward(
          'usr_alice_tx',
          'q_active_tx',
          'sub_failing_tx',
          100,
          'admin_id',
          failingClient as any
        );
      } catch {
        governanceStore.restore(snapshot);
      }

      // Crucial: After rollback, ledger count must be restored to initial count (0 new entries)
      expect(governanceStore.getLedger().length).toBe(initialLedgerCount);
      expect(governanceStore.getLedger().some((e) => e.reference_id === 'sub_failing_tx')).toBe(false);
    });

    it('Migration 010 duplicate preflight aborts when duplicates exist without deleting any records', async () => {
      // Drop unique index temporarily to simulate a pre-migration legacy state with duplicate entries
      await testDb.pool.query('DROP INDEX IF EXISTS uq_redemptions_user_voucher;');
      await testDb.pool.query('DELETE FROM redemptions WHERE user_id = $1', ['usr_alice_tx']);

      try {
        await testDb.pool.query(`
          INSERT INTO redemptions (id, voucher_id, user_id, code, cost_points, idempotency_key, created_at)
          VALUES 
            ('dup_1', 'v_cost_80_a', 'usr_alice_tx', 'CODE_DUP_1', 80, 'key_dup_1', NOW()),
            ('dup_2', 'v_cost_80_a', 'usr_alice_tx', 'CODE_DUP_2', 80, 'key_dup_2', NOW());
        `);

        // Verify 2 rows exist
        const beforeCount = await testDb.pool.query('SELECT COUNT(*)::text as cnt FROM redemptions WHERE user_id = $1', ['usr_alice_tx']);
        expect(beforeCount.rows[0].cnt).toBe('2');

        // Run preflight check
        const preflightSql = `
          DO $$
          BEGIN
              IF EXISTS (
                  SELECT 1
                  FROM redemptions r1
                  JOIN redemptions r2 ON r1.user_id = r2.user_id 
                                     AND r1.voucher_id = r2.voucher_id 
                                     AND r1.id <> r2.id
                  LIMIT 1
              ) THEN
                  RAISE EXCEPTION 'Migration 010 aborted: Duplicate user-voucher redemptions exist. Manual reconciliation required before applying unique constraint.';
              END IF;
          END $$;
        `;

        await expect(testDb.pool.query(preflightSql)).rejects.toThrow('Migration 010 aborted');

        // Verify zero auto-deletion: both records must still be present!
        const afterCount = await testDb.pool.query('SELECT COUNT(*)::text as cnt FROM redemptions WHERE user_id = $1', ['usr_alice_tx']);
        expect(afterCount.rows[0].cnt).toBe('2');
      } finally {
        // Cleanup and re-establish constraint
        await testDb.pool.query('DELETE FROM redemptions WHERE user_id = $1', ['usr_alice_tx']);
        await testDb.pool.query('CREATE UNIQUE INDEX IF NOT EXISTS uq_redemptions_user_voucher ON redemptions(user_id, voucher_id);');
      }
    });
  });
});
