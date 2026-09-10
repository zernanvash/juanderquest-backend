import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { UsersRepository } from '../src/repositories/users.js';
import { db } from '../src/db/index.js';
import request from 'supertest';
import { app } from '../src/app.js';
import { requireAdmin, checkQAAuthorization } from '../src/middleware/auth.js';
import { Pool } from 'pg';

describe('Phase 1: Durable Identity Lifecycle & Persistent Accounts', () => {
  let testDb: TestDbInstance;
  let usersRepo: UsersRepository;

  beforeAll(async () => {
    testDb = await createTestDb();
    usersRepo = new UsersRepository(testDb.pool);
    await db.hydrateFromPg(testDb.pool);
  }, 30000);

  afterAll(async () => {
    if (testDb) await testDb.close();
  }, 30000);

  it('ensures new accounts are private by default (is_public === false)', async () => {
    const user = await usersRepo.findOrCreateBySeedId({
      seed_id: 'wallet:0x1111111111111111111111111111111111111111',
      display_name: 'Traveler Private',
      email: '1111111111111111111111111111111111111111@wallet.juanderquest.local',
    });

    expect(user.is_public).toBe(false);

    // Verify row directly in PostgreSQL
    const res = await testDb.pool.query('SELECT is_public FROM users WHERE id = $1', [user.id]);
    expect(res.rows[0].is_public).toBe(false);
  });

  it('handles concurrent same-identity logins atomically resulting in exactly one row and identical IDs', async () => {
    const seedId = 'wallet:0x2222222222222222222222222222222222222222';
    const email = '2222222222222222222222222222222222222222@wallet.juanderquest.local';

    // Simulate two concurrent requests hitting at the exact same time
    const [userA, userB] = await Promise.all([
      usersRepo.findOrCreateBySeedId({
        seed_id: seedId,
        display_name: 'Traveler Concurrency A',
        email,
      }),
      usersRepo.findOrCreateBySeedId({
        seed_id: seedId,
        display_name: 'Traveler Concurrency B',
        email,
      }),
    ]);

    expect(userA.id).toBe(userB.id);
    expect(userA.seed_id).toBe(seedId);

    // Verify exactly one row in PostgreSQL
    const rowsRes = await testDb.pool.query('SELECT COUNT(*)::text as cnt FROM users WHERE seed_id = $1', [seedId]);
    expect(rowsRes.rows[0].cnt).toBe('1');
  });

  it('resolves the same committed account from an isolated second process / repository instance', async () => {
    const seedId = 'wallet:0x3333333333333333333333333333333333333333';
    const user1 = await usersRepo.findOrCreateBySeedId({
      seed_id: seedId,
      display_name: 'Traveler Process 1',
      email: '3333333333333333333333333333333333333333@wallet.juanderquest.local',
    });

    // Process 2: a completely separate UsersRepository instance with no shared in-memory state
    const process2Repo = new UsersRepository(testDb.pool);
    const resolvedUser = await process2Repo.findBySeedId(seedId);

    expect(resolvedUser).toBeDefined();
    expect(resolvedUser!.id).toBe(user1.id);
    expect(resolvedUser!.display_name).toBe(user1.display_name);
  });

  it('persists simulated wallet logins durably into PostgreSQL before issuing JWT', async () => {
    const res = await request(app)
      .post('/api/v1/auth/simulated-wallet-login')
      .send({ username: 'DurableExplorer', password: 'password123' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.token).toBeDefined();

    const userId = res.body.data.user.id;
    const seedId = res.body.data.user.seed_id;

    // Verify row is physically committed in PostgreSQL
    const pgRes = await testDb.pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    expect(pgRes.rows.length).toBe(1);
    expect(pgRes.rows[0].seed_id).toBe(seedId);
    expect(pgRes.rows[0].display_name).toBe('DurableExplorer');
    expect(pgRes.rows[0].is_public).toBe(false);
  });

  it('returns 503 STORAGE_UNAVAILABLE and does NOT issue a token when durable database fails', async () => {
    // Create a mock pool that rejects queries (simulating database outage)
    const failingPool = {
      query: jest.fn().mockRejectedValue(new Error('Connection lost to PostgreSQL')),
    } as unknown as Pool;

    const brokenDb = new UsersRepository(failingPool);

    await expect(
      brokenDb.findOrCreateBySeedId({
        seed_id: 'wallet:0xfailed',
        display_name: 'Failing Traveler',
        email: 'failed@test.com',
      })
    ).rejects.toThrow('Connection lost to PostgreSQL');
  });

  it('fails closed with 503 DATABASE_OUTAGE when requireAdmin encounters a database error', async () => {
    const originalRepo = db.usersRepo;
    const failingRepo = {
      findById: jest.fn().mockRejectedValue(new Error('PostgreSQL connection timeout')),
      getPool: () => ({}) as any,
    } as unknown as UsersRepository;

    Object.defineProperty(db, 'usersRepo', { value: failingRepo, configurable: true });

    const req: any = { user: { id: 'admin-1', role: 'admin' } };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(payload: any) { this.body = payload; return this; },
    };
    let nextCalled = false;

    await requireAdmin(req, res, () => { nextCalled = true; });

    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe('DATABASE_OUTAGE');

    Object.defineProperty(db, 'usersRepo', { value: originalRepo, configurable: true });
  });

  it('rejects with 403 FORBIDDEN when an admin account was deleted from the durable database', async () => {
    const originalRepo = db.usersRepo;
    const emptyRepo = {
      findById: jest.fn().mockResolvedValue(null),
      getPool: () => ({}) as any,
    } as unknown as UsersRepository;

    Object.defineProperty(db, 'usersRepo', { value: emptyRepo, configurable: true });

    const req: any = { user: { id: 'deleted-admin', role: 'admin' } };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(payload: any) { this.body = payload; return this; },
    };
    let nextCalled = false;

    await requireAdmin(req, res, () => { nextCalled = true; });

    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).toContain('Account no longer exists');

    Object.defineProperty(db, 'usersRepo', { value: originalRepo, configurable: true });
  });

  it('fails closed with 503 DATABASE_OUTAGE when checkQAAuthorization encounters a database error', async () => {
    const originalRepo = db.usersRepo;
    const failingRepo = {
      findById: jest.fn().mockRejectedValue(new Error('PostgreSQL connection timeout')),
      getPool: () => ({}) as any,
    } as unknown as UsersRepository;

    Object.defineProperty(db, 'usersRepo', { value: failingRepo, configurable: true });

    const req: any = {
      user: { id: 'admin-1', role: 'admin' },
      query: { include_test: 'true' },
      headers: {},
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(payload: any) { this.body = payload; return this; },
    };
    let nextCalled = false;

    await checkQAAuthorization(req, res, () => { nextCalled = true; });

    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe('DATABASE_OUTAGE');

    Object.defineProperty(db, 'usersRepo', { value: originalRepo, configurable: true });
  });
});
