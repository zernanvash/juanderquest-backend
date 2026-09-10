import { GovernanceStore } from '../src/governance/store.js';
import { db, MemoryDb } from '../src/db/index.js';
import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { setPool } from '../src/db/pool.js';
import { submissionsService } from '../src/services/submissions.js';
import { vouchersService } from '../src/services/vouchers.js';
import { randomUUID } from 'crypto';

describe('Governance Concurrency & Accounting Fixes (V1–V5)', () => {
  let testDb: TestDbInstance;

  beforeAll(async () => {
    testDb = await createTestDb();
    setPool(testDb.pool);
  });

  afterAll(async () => {
    setPool(null);
    await testDb.close();
  });

  describe('V1: Accounting query errors bubble up & aborted transactions prevent phantom memory updates', () => {
    it('recordQuestRewardTx propagates SQL errors without swallowing', async () => {
      const mockDb = { users: [], submissions: [], quests: [] } as unknown as MemoryDb;
      const store = new GovernanceStore(mockDb);
      const failingClient = {
        query: jest.fn().mockRejectedValue(new Error('PG_CONNECTION_DROPPED')),
      };

      await expect(
        store.recordQuestRewardTx('user_1', 'quest_1', 'sub_1', 10, 'admin_1', failingClient)
      ).rejects.toThrow('PG_CONNECTION_DROPPED');
    });

    it('recordVoucherRedemptionTx propagates SQL errors without swallowing', async () => {
      const mockDb = { users: [], submissions: [], quests: [] } as unknown as MemoryDb;
      const store = new GovernanceStore(mockDb);
      const failingClient = {
        query: jest.fn().mockRejectedValue(new Error('PG_DISK_FULL')),
      };

      await expect(
        store.recordVoucherRedemptionTx('user_1', 10, 'voucher_1', 'rdm_1', failingClient)
      ).rejects.toThrow('PG_DISK_FULL');
    });

    it('submissionsService rejects and aborts if commit returns ROLLBACK', async () => {
      // Create user, admin, and quest in DB
      await testDb.pool.query(`
        INSERT INTO users (id, seed_id, display_name, email, role, demo_points, is_public)
        VALUES 
          ('usr_v1_sub', 'seed_v1_sub', 'V1 Sub User', 'v1sub@test.com', 'user', 50, true),
          ('usr_admin_v1', 'seed_admin_v1', 'V1 Admin', 'v1admin@test.com', 'admin', 500, true)
        ON CONFLICT (id) DO UPDATE SET demo_points = EXCLUDED.demo_points;
      `);
      await testDb.pool.query(`
        INSERT INTO quests (id, title, description, category, location_name, gps_lat, gps_lng, radius_meters, reward_points, marker_code, marker_image_url, is_active)
        VALUES ('q_v1_sub', 'V1 Quest', 'Desc', 'cultural', 'Dagupan', 16.0, 120.0, 100, 20, 'MK_V1', '', true)
        ON CONFLICT (id) DO NOTHING;
      `);

      // Sync in-memory db with PG
      await db.hydrateFromPg(testDb.pool);

      // Insert pending submission
      const subId = `sub_v1_${Date.now()}`;
      await testDb.pool.query(`
        INSERT INTO submissions (id, user_id, quest_id, scanned_marker_code, captured_lat, captured_lng, captured_accuracy, status, idempotency_key, created_at)
        VALUES ($1, 'usr_v1_sub', 'q_v1_sub', 'MK_V1', 16.0, 120.0, 5.0, 'pending', $2, NOW())
      `, [subId, `idemp_sub_${Date.now()}`]);

      // Mock pg Client to simulate COMMIT returning { command: 'ROLLBACK' }
      const realConnect = testDb.pool.connect.bind(testDb.pool);
      const spy = jest.spyOn(testDb.pool, 'connect').mockImplementation(async () => {
        const client = await realConnect();
        const origQuery = client.query.bind(client);
        const origRelease = client.release.bind(client);
        client.query = (async (text: any, params: any) => {
          if (typeof text === 'string' && text.trim().toUpperCase() === 'COMMIT') {
            await origQuery('ROLLBACK').catch(() => {});
            return { command: 'ROLLBACK', rowCount: 0, rows: [] } as any;
          }
          return origQuery(text, params);
        }) as any;
        client.release = ((err?: any) => {
          client.query = origQuery;
          client.release = origRelease;
          return origRelease(err);
        }) as any;
        return client;
      });

      try {
        // reviewSubmission should fail because commit returned ROLLBACK
        await expect(
          submissionsService.reviewSubmission(subId, 'approve', 'usr_admin_v1')
        ).rejects.toThrow('TRANSACTION_ABORTED: commit returned ROLLBACK');
      } finally {
        spy.mockRestore();
      }

      // Verify points were NOT incremented in memory
      const memUser = db.findUserById('usr_v1_sub');
      expect(memUser?.demo_points).toBe(50);
      if (process.env.JDQ_REAL_PG_URL) {
        const userRes = await testDb.pool.query('SELECT demo_points FROM users WHERE id = $1', ['usr_v1_sub']);
        expect(userRes.rows[0].demo_points).toBe(50);
      }
    });

    it('vouchersService rejects and aborts if commit returns ROLLBACK', async () => {
      // Ensure user, merchant, and voucher exist
      await testDb.pool.query(`
        INSERT INTO users (id, seed_id, display_name, email, role, demo_points, is_public)
        VALUES ('usr_v1_vch', 'seed_v1_vch', 'V1 Vch User', 'v1vch@test.com', 'user', 100, true)
        ON CONFLICT (id) DO UPDATE SET demo_points = EXCLUDED.demo_points;
      `);
      await testDb.pool.query(`
        INSERT INTO merchants (id, name, location, description)
        VALUES ('m_v1', 'V1 Merchant', 'Dagupan', 'Desc')
        ON CONFLICT (id) DO NOTHING;
      `);
      await testDb.pool.query(`
        INSERT INTO vouchers (id, merchant_id, title, description, cost_points, is_active)
        VALUES ('v_v1', 'm_v1', 'Voucher V1', 'Desc', 30, true)
        ON CONFLICT (id) DO NOTHING;
      `);

      // Sync in-memory db with PG
      await db.hydrateFromPg(testDb.pool);

      // Mock pg Client to simulate COMMIT returning { command: 'ROLLBACK' }
      const realConnect = testDb.pool.connect.bind(testDb.pool);
      const spy = jest.spyOn(testDb.pool, 'connect').mockImplementation(async () => {
        const client = await realConnect();
        const origQuery = client.query.bind(client);
        const origRelease = client.release.bind(client);
        client.query = (async (text: any, params: any) => {
          if (typeof text === 'string' && text.trim().toUpperCase() === 'COMMIT') {
            await origQuery('ROLLBACK').catch(() => {});
            return { command: 'ROLLBACK', rowCount: 0, rows: [] } as any;
          }
          return origQuery(text, params);
        }) as any;
        client.release = ((err?: any) => {
          client.query = origQuery;
          client.release = origRelease;
          return origRelease(err);
        }) as any;
        return client;
      });

      try {
        await expect(
          vouchersService.redeemVoucher('v_v1', 'usr_v1_vch', randomUUID())
        ).rejects.toThrow('TRANSACTION_ABORTED: commit returned ROLLBACK');
      } finally {
        spy.mockRestore();
      }

      // Verify points were not deducted in memory
      const memUser = db.findUserById('usr_v1_vch');
      expect(memUser?.demo_points).toBe(100);
      if (process.env.JDQ_REAL_PG_URL) {
        const userRes = await testDb.pool.query('SELECT demo_points FROM users WHERE id = $1', ['usr_v1_vch']);
        expect(userRes.rows[0].demo_points).toBe(100);
      }
    });
  });

  describe('V2: Partial / fresh snapshot seed restores safely without "proposals is not iterable"', () => {
    it('handles partial snapshot seed {"ledger":[],"audit":[],"balances":{}} defensively', () => {
      const mockDb = {
        users: [{ id: 'usr_org', display_name: 'Organizer', role: 'user', demo_points: 10 }],
        findUserById: () => ({ id: 'usr_org', display_name: 'Organizer', role: 'user', demo_points: 10 }),
      } as unknown as MemoryDb;

      const store = new GovernanceStore(mockDb);
      // Simulate decoding the initial migration snapshot seed which only had ledger, audit, balances
      const partialSeed = { ledger: [], audit: [], balances: {} };

      expect(() => store.restore(partialSeed as any)).not.toThrow();

      // Proposals should be seeded and iterable
      const proposals = store.listProposals();
      expect(Array.isArray(proposals)).toBe(true);
      expect(proposals.length).toBeGreaterThan(0);

      // Other methods should function normally
      const overview = store.getOverview();
      expect(overview.active_votes).toBe(0);
      expect(overview.controls.pause_votes).toBe(false);

      const tokenomics = store.getTokenomics();
      expect(tokenomics.unit).toBe('mJDQ');
      expect(tokenomics.burned_mjdq).toBe(0);
    });
  });

  describe('V3: Commands load authoritative state under row-lock', () => {
    it('preserves proposals created by two stale workers', async () => {
      await testDb.pool.query(`INSERT INTO users (id, seed_id, display_name, email, role, demo_points)
        VALUES ('usr_w_a','usr_w_a','Worker A','worker-a@test.com','user',500),
               ('usr_w_b','usr_w_b','Worker B','worker-b@test.com','user',500)`);
      const mockUserA = { id: 'usr_w_a', display_name: 'Worker A', role: 'user', demo_points: 500 };
      const mockUserB = { id: 'usr_w_b', display_name: 'Worker B', role: 'user', demo_points: 500 };
      const mockDb = {
        users: [mockUserA, mockUserB],
        findUserById: (uid: string) => (uid === mockUserA.id ? mockUserA : mockUserB),
        quests: [],
        submissions: [],
        upsertQuest: () => {},
      } as unknown as MemoryDb;

      const workerAStore = new GovernanceStore(mockDb);
      workerAStore.attachPg(testDb.pool);

      const workerBStore = new GovernanceStore(mockDb);
      workerBStore.attachPg(testDb.pool);

      // Worker A creates proposal A and Worker B creates proposal B
      const propA = await workerAStore.createProposal({
        title: 'Worker A Proposal',
        location_name: 'Location A',
        category: 'eco',
        description: 'Description A',
        submitted_by_id: mockUserA.id,
      });

      const propB = await workerBStore.createProposal({
        title: 'Worker B Proposal',
        location_name: 'Location B',
        category: 'cultural',
        description: 'Description B',
        submitted_by_id: mockUserB.id,
      });

      expect(propA.id).toBeDefined();
      expect(propB.id).toBeDefined();

      // Query database snapshot directly to verify BOTH exist in the merged DB state
      const { rows } = await testDb.pool.query('SELECT data FROM governance_snapshot WHERE id = 1');
      expect(rows.length).toBe(1);
      const snap = rows[0].data;
      const ids = snap.proposals.map((p: any) => p.id);
      expect(ids).toContain(propA.id);
      expect(ids).toContain(propB.id);

      expect(workerBStore.listProposals().map((p) => p.id)).toEqual(expect.arrayContaining([propA.id, propB.id]));
    });
  });

  describe('V4: Voucher redemptions are settlement debits and do not inflate burnedMjdq', () => {
    it('does not increment burnedMjdq when consuming points for voucher redemption', async () => {
      const mockUser = { id: 'usr_v4', display_name: 'V4 User', role: 'user', demo_points: 100 };
      const mockDb = {
        users: [mockUser],
        findUserById: () => mockUser,
        submissions: [],
      } as unknown as MemoryDb;

      const store = new GovernanceStore(mockDb);
      const initialBurned = store.getTokenomics().burned_mjdq;
      expect(initialBurned).toBe(0);

      // Redeem voucher for 20 points (20,000 mJDQ)
      await store.consumePoints(mockUser.id, 20, 'vch_v4', 'rdm_v4');

      const tokenomics = store.getTokenomics();
      // burnedMjdq must STILL be 0 because voucher redemption is merchant settlement, not burn
      expect(tokenomics.burned_mjdq).toBe(0);

      // Check ledger entries: should have debit on user and credit on merchant_settlement
      const ledger = store.getLedger();
      const settlementEntry = ledger.find((e) => e.account === 'merchant_settlement');
      expect(settlementEntry).toBeDefined();
      expect(settlementEntry?.amount_mjdq).toBe(20000);

      const burnEntry = ledger.find((e) => e.account === 'burn');
      expect(burnEntry).toBeUndefined();
    });
  });

  describe('V5: 64-bit ledger hydration and unmigrated table error handling', () => {
    it('hydrates large amount_mjdq > 2.1B (safe 64-bit) without int32 overflow', async () => {
      const mockDb = { users: [], submissions: [] } as unknown as MemoryDb;
      const store = new GovernanceStore(mockDb);

      const largeAmount = 5_000_000_000; // 5 billion > 2^31 - 1
      const ledId = `led_large_${Date.now()}`;
      await testDb.pool.query(`
        INSERT INTO governance_ledger (id, transaction_group_id, type, account, amount_mjdq, reference_type, reference_id, actor_id, metadata, created_at)
        VALUES ($1, 'txg_large', 'large_test', 'treasury', $2, 'test', 'ref_large', 'admin', '{}', NOW())
      `, [ledId, largeAmount]);

      await store.hydrateFromPg(testDb.pool);

      const hydratedEntry = store.getLedger().find((e) => e.id === ledId);
      expect(hydratedEntry).toBeDefined();
      expect(hydratedEntry?.amount_mjdq).toBe(largeAmount);
    });

    it('throws LEDGER_AMOUNT_OVERFLOW when amount_mjdq exceeds Number.MAX_SAFE_INTEGER', async () => {
      const mockDb = { users: [], submissions: [] } as unknown as MemoryDb;
      const store = new GovernanceStore(mockDb);

      const overflowId = `led_overflow_${Date.now()}`;
      // Fits within PostgreSQL BIGINT (< 9.22e18) but exceeds JavaScript Number.MAX_SAFE_INTEGER (9.007e15)
      const unsafeJsAmount = '9100000000000000';
      await testDb.pool.query(`
        INSERT INTO governance_ledger (id, transaction_group_id, type, account, amount_mjdq, reference_type, reference_id, actor_id, metadata, created_at)
        VALUES ($1, 'txg_ovf', 'overflow_test', 'treasury', $2, 'test', 'ref_ovf', 'admin', '{}', NOW())
      `, [overflowId, unsafeJsAmount]);

      await expect(store.hydrateFromPg(testDb.pool)).rejects.toThrow('LEDGER_AMOUNT_OVERFLOW');
    });

    it('re-throws query failures that are not 42P01 (relation does not exist)', async () => {
      const mockDb = { users: [], submissions: [] } as unknown as MemoryDb;
      const store = new GovernanceStore(mockDb);

      const failingPool = {
        query: jest.fn().mockRejectedValue(new Error('CONNECTION_FAILURE_FATAL')),
        connect: jest.fn(),
      } as any;

      await expect(store.hydrateFromPg(failingPool)).rejects.toThrow('CONNECTION_FAILURE_FATAL');
    });
  });
});
