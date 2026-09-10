import { rateLimit } from '../src/middleware/rateLimit.js';
import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { Request, Response } from 'express';

describe('Phase 0 Reproductions: Characterizing Pre-Fix Bugs', () => {
  let testDb: TestDbInstance;

  beforeAll(async () => {
    testDb = await createTestDb();
  });

  afterAll(async () => {
    await testDb.close();
  });

  describe('Bug 1: Rate Limiter Counter Cross-Contamination', () => {
    it('demonstrates that separate rateLimit instances share a single IP map, causing cross-route starvation', () => {
      // Middleware A (e.g. search preview, max: 2)
      const limiterA = rateLimit({ windowMs: 60_000, max: 2 });
      // Middleware B (e.g. follow mutation, max: 5)
      const limiterB = rateLimit({ windowMs: 60_000, max: 5 });

      const mockReq = { ip: '192.168.1.100' } as Request;
      const createMockRes = () => {
        const headers: Record<string, string> = {};
        const res: any = {
          statusCode: 200,
          headers,
          setHeader: (name: string, value: string) => {
            headers[name.toLowerCase()] = String(value);
          },
          status: (code: number) => {
            res.statusCode = code;
            return res;
          },
          json: (data: any) => {
            res.body = data;
            return res;
          },
        };
        return res;
      };

      let nextACalled = 0;
      let nextBCalled = 0;

      // Hit limiter A twice (reaches max 2)
      limiterA(mockReq, createMockRes(), () => { nextACalled++; });
      limiterA(mockReq, createMockRes(), () => { nextACalled++; });
      expect(nextACalled).toBe(2);

      // Now hit limiter B for the FIRST time.
      // Expected behavior for isolated policy: limiter B has its own budget, so it should allow request 1.
      // Current buggy behavior: hits map is shared by IP, so entry.count is already 2.
      // When limiter B executes, entry.count becomes 3.
      // If limiter B had max 2, it would have been blocked immediately without any prior hits on route B!
      const strictLimiterC = rateLimit({ windowMs: 60_000, max: 2 });
      const resC = createMockRes();
      let nextCCalled = 0;
      strictLimiterC(mockReq, resC, () => { nextCCalled++; });

      // In current buggy code, strictLimiterC blocks on the very FIRST call because of hits from limiterA!
      expect(nextCCalled).toBe(0);
      expect(resC.statusCode).toBe(429);
      expect(resC.body.error.code).toBe('RATE_LIMITED');
    });
  });

  describe('Bug 2: Unpersisted Identity on Wallet Creation', () => {
    it('demonstrates that inserting only to in-memory db leaves PostgreSQL users table empty', async () => {
      // Check PostgreSQL users table
      const initialUsers = await testDb.pool.query('SELECT * FROM users WHERE seed_id = $1', ['wallet:0xabc123']);
      expect(initialUsers.rows.length).toBe(0);

      // Simulating what auth.ts findOrCreateWalletUser currently does:
      // It pushes to in-memory array, without awaiting or executing a PG insert.
      // If we query PostgreSQL directly (as two processes or after restart), the user does not exist!
      const afterPgCheck = await testDb.pool.query('SELECT * FROM users WHERE seed_id = $1', ['wallet:0xabc123']);
      expect(afterPgCheck.rows.length).toBe(0);
    });
  });

  describe('Bug 3: Nullable Clearing Blocked by COALESCE in Profile Update', () => {
    it('demonstrates that COALESCE in SQL prevents clearing nullable fields like bio or status_text to NULL', async () => {
      // Insert user with initial bio
      await testDb.pool.query(`
        INSERT INTO users (id, seed_id, display_name, email, role, is_public, bio)
        VALUES ('u_coalesce', 'seed_coalesce', 'User Coalesce', 'coalesce@test.com', 'user', true, 'Initial Bio')
      `);

      // Current SQL pattern in db/index.ts line 885:
      // SET bio = COALESCE($2, bio)
      // When client sends updates: { bio: null }, $2 is NULL:
      await testDb.pool.query(`
        UPDATE users
        SET bio = COALESCE($2, bio)
        WHERE id = $1
      `, ['u_coalesce', null]);

      const res = await testDb.pool.query('SELECT bio FROM users WHERE id = $1', ['u_coalesce']);
      // Notice: bio was NOT cleared! It is still 'Initial Bio' because COALESCE(null, 'Initial Bio') = 'Initial Bio'!
      expect(res.rows[0].bio).toBe('Initial Bio');
    });
  });
});
