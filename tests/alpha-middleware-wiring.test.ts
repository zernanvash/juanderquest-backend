import { checkQAAuthorization, isAuthorizedQA, AuthRequest } from '../src/middleware/auth.js';
import { db } from '../src/db/index.js';
import { env } from '../src/config/env.js';
import { Pool } from 'pg';

describe('Iteration 20c: AlphaSessionScopeBatcher Middleware Wiring & Fail-Closed Tests', () => {
  let originalRepo: any;
  let originalAlphaFlag: boolean;

  beforeEach(() => {
    originalRepo = db.usersRepo;
    originalAlphaFlag = env.ALPHA_WALLET_SIMULATION_ENABLED;
    Reflect.set(env, 'ALPHA_WALLET_SIMULATION_ENABLED', true);
  });

  afterEach(() => {
    Object.defineProperty(db, 'usersRepo', { value: originalRepo, configurable: true, writable: true });
    Reflect.set(env, 'ALPHA_WALLET_SIMULATION_ENABLED', originalAlphaFlag);
  });

  function createMockRes() {
    const headers: Record<string, string> = {};
    const res: any = {
      statusCode: 200,
      headers,
      setHeader: jest.fn((k: string, v: string) => {
        headers[k.toLowerCase()] = v;
      }),
      status: jest.fn(function (code: number) {
        res.statusCode = code;
        return res;
      }),
      json: jest.fn(function (body: any) {
        res.body = body;
        return res;
      }),
    };
    return res;
  }

  function createMockPool(queryFn: (sql: string, params?: any[]) => Promise<any>): Pool {
    return {
      query: jest.fn(queryFn),
    } as unknown as Pool;
  }

  it('coalesces 100 concurrent wallet GETs into exactly one bound array query with private/no-index headers', async () => {
    let capturedQueryCount = 0;
    let capturedIds: string[] = [];

    const mockPool = createMockPool(async (sql: string, params?: any[]) => {
      capturedQueryCount++;
      const ids: string[] = params?.[0] ?? [];
      capturedIds = ids;
      const rows = ids.map(id => ({
        id,
        seed_id: `wallet:0x${id}`,
        is_test: false,
      }));
      return { rows };
    });

    const repoWithPool = {
      getPool: () => mockPool,
      findById: jest.fn(),
    };
    Object.defineProperty(db, 'usersRepo', { value: repoWithPool, configurable: true, writable: true });

    const requests = Array.from({ length: 100 }, (_, i) => {
      const id = `user-${i + 1}`;
      const req: AuthRequest = {
        method: 'GET',
        query: {},
        headers: {},
        user: { id, seed_id: `wallet:0x${id}`, role: 'user' },
      } as any;
      const res = createMockRes();
      let nextCalled = false;
      const promise = checkQAAuthorization(req, res, () => { nextCalled = true; }).then(() => {
        return { req, res, nextCalled };
      });
      return promise;
    });

    const results = await Promise.all(requests);

    expect(capturedQueryCount).toBe(1);
    expect(capturedIds.length).toBe(100);

    for (const r of results) {
      expect(r.nextCalled).toBe(true);
      expect(r.req.isQAAuthorized).toBe(true);
      expect(r.res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
      expect(r.res.setHeader).toHaveBeenCalledWith('X-Robots-Tag', 'noindex, nofollow');
    }
  });

  it('splits 101 concurrent wallet GET requests across two sequential bound batch queries', async () => {
    let capturedQueryCount = 0;
    const mockPool = createMockPool(async (sql: string, params?: any[]) => {
      capturedQueryCount++;
      const ids: string[] = params?.[0] ?? [];
      const rows = ids.map(id => ({
        id,
        seed_id: `wallet:0x${id}`,
        is_test: false,
      }));
      return { rows };
    });

    const repoWithPool = {
      getPool: () => mockPool,
      findById: jest.fn(),
    };
    Object.defineProperty(db, 'usersRepo', { value: repoWithPool, configurable: true, writable: true });

    const requests = Array.from({ length: 101 }, (_, i) => {
      const id = `user-split-${i + 1}`;
      const req: AuthRequest = {
        method: 'GET',
        query: {},
        headers: {},
        user: { id, seed_id: `wallet:0x${id}`, role: 'user' },
      } as any;
      const res = createMockRes();
      let nextCalled = false;
      return checkQAAuthorization(req, res, () => { nextCalled = true; }).then(() => ({ req, res, nextCalled }));
    });

    const results = await Promise.all(requests);

    expect(capturedQueryCount).toBe(2);
    for (const r of results) {
      expect(r.nextCalled).toBe(true);
      expect(r.req.isQAAuthorized).toBe(true);
    }
  });

  it('coalesces duplicate callers with the same ID into a single array parameter entry and settles each independently', async () => {
    let capturedIds: string[] = [];
    let capturedQueryCount = 0;

    const mockPool = createMockPool(async (sql: string, params?: any[]) => {
      capturedQueryCount++;
      capturedIds = params?.[0] ?? [];
      const rows = capturedIds.map(id => ({
        id,
        seed_id: `wallet:0x${id}`,
        is_test: false,
      }));
      return { rows };
    });

    const repoWithPool = {
      getPool: () => mockPool,
      findById: jest.fn(),
    };
    Object.defineProperty(db, 'usersRepo', { value: repoWithPool, configurable: true, writable: true });

    const sharedId = 'duplicate-wallet-user';
    const makeReq = () => {
      const req: AuthRequest = {
        method: 'GET',
        query: {},
        headers: {},
        user: { id: sharedId, seed_id: `wallet:0x${sharedId}`, role: 'user' },
      } as any;
      const res = createMockRes();
      let nextCalled = false;
      return checkQAAuthorization(req, res, () => { nextCalled = true; }).then(() => ({ req, res, nextCalled }));
    };

    const results = await Promise.all([makeReq(), makeReq(), makeReq()]);

    expect(capturedQueryCount).toBe(1);
    expect(capturedIds).toEqual([sharedId]);
    for (const r of results) {
      expect(r.nextCalled).toBe(true);
      expect(r.req.isQAAuthorized).toBe(true);
    }
  });

  it('issues a fresh query for later requests and observes changed or missing scope without stale caching', async () => {
    let queryCallCount = 0;
    let currentUserState: { id: string; seed_id: string; is_test: boolean } | null = {
      id: 'fresh-user-1',
      seed_id: 'wallet:0xfresh-user-1',
      is_test: false,
    };

    const mockPool = createMockPool(async (_sql: string, params?: any[]) => {
      queryCallCount++;
      const ids: string[] = params?.[0] ?? [];
      const rows: any[] = [];
      for (const id of ids) {
        if (currentUserState && currentUserState.id === id) {
          rows.push(currentUserState);
        }
      }
      return { rows };
    });

    const repoWithPool = {
      getPool: () => mockPool,
      findById: jest.fn(),
    };
    Object.defineProperty(db, 'usersRepo', { value: repoWithPool, configurable: true, writable: true });

    // Request 1: Active user
    const req1: AuthRequest = {
      method: 'GET', query: {}, headers: {},
      user: { id: 'fresh-user-1', seed_id: 'wallet:0xfresh-user-1', role: 'user' },
    } as any;
    const res1 = createMockRes();
    let nextCalled1 = false;
    await checkQAAuthorization(req1, res1, () => { nextCalled1 = true; });

    expect(nextCalled1).toBe(true);
    expect(req1.isQAAuthorized).toBe(true);
    expect(queryCallCount).toBe(1);

    // Identity state changes: deleted from DB
    currentUserState = null;

    // Request 2: Arrives after prior batch completed
    const req2: AuthRequest = {
      method: 'GET', query: {}, headers: {},
      user: { id: 'fresh-user-1', seed_id: 'wallet:0xfresh-user-1', role: 'user' },
    } as any;
    const res2 = createMockRes();
    let nextCalled2 = false;
    await checkQAAuthorization(req2, res2, () => { nextCalled2 = true; });

    expect(nextCalled2).toBe(true);
    expect(req2.isQAAuthorized).toBe(false); // falls back to live public view (unauthorized synthetic)
    expect(queryCallCount).toBe(2); // fresh query executed, no cached scope
  });

  it('fails closed with 503 DATABASE_OUTAGE and generic error message on DB query error, overload, or batcher close', async () => {
    const mockPool = createMockPool(async () => {
      throw new Error('Database connection failed with secret credentials postgres://user:secretpw@localhost:5432/db');
    });

    const repoWithPool = {
      getPool: () => mockPool,
      findById: jest.fn(),
    };
    Object.defineProperty(db, 'usersRepo', { value: repoWithPool, configurable: true, writable: true });

    const req: AuthRequest = {
      method: 'GET', query: {}, headers: {},
      user: { id: 'wallet-err-user', seed_id: 'wallet:0xerr', role: 'user' },
    } as any;
    const res = createMockRes();
    let nextCalled = false;

    await checkQAAuthorization(req, res, () => { nextCalled = true; });

    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      success: false,
      error: {
        code: 'DATABASE_OUTAGE',
        message: 'Wallet session could not be verified.',
      },
    });

    // Ensure no secrets appear in response or error objects
    const jsonStr = JSON.stringify(res.body);
    expect(jsonStr).not.toContain('secretpw');
    expect(jsonStr).not.toContain('postgres://');
  });

  it('leaves isQAAuthorized=false when test/scope/seed mismatch occurs (is_test=true, seed mismatch, missing)', async () => {
    const mockPool = createMockPool(async (_sql: string, params?: any[]) => {
      const ids: string[] = params?.[0] ?? [];
      const rows: any[] = [];
      for (const id of ids) {
        if (id === 'test-actor') {
          rows.push({ id: 'test-actor', seed_id: 'wallet:0xtest', is_test: true });
        } else if (id === 'seed-mismatch') {
          rows.push({ id: 'seed-mismatch', seed_id: 'wallet:0xdifferent', is_test: false });
        }
      }
      return { rows };
    });

    const repoWithPool = {
      getPool: () => mockPool,
      findById: jest.fn(),
    };
    Object.defineProperty(db, 'usersRepo', { value: repoWithPool, configurable: true, writable: true });

    // Case 1: is_test === true
    const req1: AuthRequest = {
      method: 'GET', query: {}, headers: {},
      user: { id: 'test-actor', seed_id: 'wallet:0xtest', role: 'user' },
    } as any;
    const res1 = createMockRes();
    let next1 = false;
    await checkQAAuthorization(req1, res1, () => { next1 = true; });
    expect(next1).toBe(true);
    expect(req1.isQAAuthorized).toBe(false);

    // Case 2: seed_id mismatch
    const req2: AuthRequest = {
      method: 'GET', query: {}, headers: {},
      user: { id: 'seed-mismatch', seed_id: 'wallet:0xoriginal', role: 'user' },
    } as any;
    const res2 = createMockRes();
    let next2 = false;
    await checkQAAuthorization(req2, res2, () => { next2 = true; });
    expect(next2).toBe(true);
    expect(req2.isQAAuthorized).toBe(false);

    // Case 3: missing actor
    const req3: AuthRequest = {
      method: 'GET', query: {}, headers: {},
      user: { id: 'not-in-db', seed_id: 'wallet:0xmissing', role: 'user' },
    } as any;
    const res3 = createMockRes();
    let next3 = false;
    await checkQAAuthorization(req3, res3, () => { next3 = true; });
    expect(next3).toBe(true);
    expect(req3.isQAAuthorized).toBe(false);
  });

  it('isolates batchers across Pool instances when db.usersRepo pool is replaced', async () => {
    let pool1Executed = false;
    let pool2Executed = false;

    const mockPool1 = createMockPool(async () => {
      pool1Executed = true;
      return { rows: [{ id: 'user-p1', seed_id: 'wallet:0xp1', is_test: false }] };
    });

    const mockPool2 = createMockPool(async () => {
      pool2Executed = true;
      return { rows: [{ id: 'user-p2', seed_id: 'wallet:0xp2', is_test: false }] };
    });

    // Run against Pool 1
    const repoPool1 = { getPool: () => mockPool1, findById: jest.fn() };
    Object.defineProperty(db, 'usersRepo', { value: repoPool1, configurable: true, writable: true });

    const req1: AuthRequest = {
      method: 'GET', query: {}, headers: {},
      user: { id: 'user-p1', seed_id: 'wallet:0xp1', role: 'user' },
    } as any;
    const res1 = createMockRes();
    await checkQAAuthorization(req1, res1, () => {});
    expect(pool1Executed).toBe(true);
    expect(pool2Executed).toBe(false);

    // Replace pool with Pool 2
    const repoPool2 = { getPool: () => mockPool2, findById: jest.fn() };
    Object.defineProperty(db, 'usersRepo', { value: repoPool2, configurable: true, writable: true });

    const req2: AuthRequest = {
      method: 'GET', query: {}, headers: {},
      user: { id: 'user-p2', seed_id: 'wallet:0xp2', role: 'user' },
    } as any;
    const res2 = createMockRes();
    await checkQAAuthorization(req2, res2, () => {});
    expect(pool2Executed).toBe(true);
  });

  it('preserves explicit QA/admin path unchanged and does not use batcher for explicit preview', async () => {
    const mockBatchPool = createMockPool(async () => {
      throw new Error('Batch query should not be called!');
    });
    const repo = {
      getPool: () => mockBatchPool,
      findById: jest.fn().mockResolvedValue({
        id: 'admin-actor',
        seed_id: 'admin:seed',
        role: 'admin',
        is_test: false,
      }),
    };
    Object.defineProperty(db, 'usersRepo', { value: repo, configurable: true, writable: true });

    const req: AuthRequest = {
      method: 'GET',
      query: { include_test: 'true' }, // explicit QA request
      headers: {},
      user: { id: 'admin-actor', seed_id: 'admin:seed', role: 'admin' },
    } as any;
    const res = createMockRes();
    let nextCalled = false;

    await checkQAAuthorization(req, res, () => { nextCalled = true; });

    expect(nextCalled).toBe(true);
    expect(req.isQAAuthorized).toBe(true);
    // Verified that findById was called directly (authorizing QA preview), and batchPool was NOT invoked
    expect(repo.findById).toHaveBeenCalledWith('admin-actor');
    expect(mockBatchPool.query).not.toHaveBeenCalled();
  });

  it('preserves existing no-Pool local in-memory fallback exactly as presently scoped', async () => {
    const noPoolRepo = {
      getPool: () => null,
      findById: jest.fn(),
    };
    Object.defineProperty(db, 'usersRepo', { value: noPoolRepo, configurable: true, writable: true });

    const findUserSpy = jest.spyOn(db, 'findUserById').mockReturnValue({
      id: 'mem-user',
      seed_id: 'wallet:0xmem',
      display_name: 'Memory Traveler',
      email: 'mem@test.com',
      avatar_url: '',
      role: 'user',
      demo_points: 100,
      mjdq_balance: 100000,
      jdq_governance_balance: 15,
      scout_reputation: 250,
      is_public: false,
      handle: null,
      bio: null,
      status_text: null,
      is_test: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const req: AuthRequest = {
      method: 'GET', query: {}, headers: {},
      user: { id: 'mem-user', seed_id: 'wallet:0xmem', role: 'user' },
    } as any;
    const res = createMockRes();
    let nextCalled = false;

    await checkQAAuthorization(req, res, () => { nextCalled = true; });

    expect(findUserSpy).toHaveBeenCalledWith('mem-user');
    expect(nextCalled).toBe(true);
    expect(req.isQAAuthorized).toBe(true);

    findUserSpy.mockRestore();
  });

  it('does not invoke batcher or authorize simulation when ALPHA_WALLET_SIMULATION_ENABLED is false', async () => {
    Reflect.set(env, 'ALPHA_WALLET_SIMULATION_ENABLED', false);

    const mockPool = createMockPool(async () => {
      throw new Error('Should not be invoked!');
    });
    const repoWithPool = {
      getPool: () => mockPool,
      findById: jest.fn(),
    };
    Object.defineProperty(db, 'usersRepo', { value: repoWithPool, configurable: true, writable: true });

    const req: AuthRequest = {
      method: 'GET', query: {}, headers: {},
      user: { id: 'user-disabled', seed_id: 'wallet:0xdisabled', role: 'user' },
    } as any;
    const res = createMockRes();
    let nextCalled = false;

    await checkQAAuthorization(req, res, () => { nextCalled = true; });

    expect(nextCalled).toBe(true);
    expect(req.isQAAuthorized).toBe(false);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('fails closed with generic 503 DATABASE_OUTAGE when Pool is replaced while lookup is pending', async () => {
    let resolveDeferredQuery!: (value: any) => void;
    const deferredPromise = new Promise((resolve) => {
      resolveDeferredQuery = resolve;
    });

    const mockPool1 = createMockPool(async () => {
      return deferredPromise;
    });

    const mockPool2 = createMockPool(async () => {
      return { rows: [] };
    });

    const repoPool1 = {
      getPool: () => mockPool1,
      findById: jest.fn(),
    };
    Object.defineProperty(db, 'usersRepo', { value: repoPool1, configurable: true, writable: true });

    const req: AuthRequest = {
      method: 'GET',
      query: {},
      headers: {},
      user: { id: 'user-race-pool', seed_id: 'wallet:0xrace-pool', role: 'user' },
    } as any;
    const res = createMockRes();
    let nextCalled = false;

    const authPromise = checkQAAuthorization(req, res, () => {
      nextCalled = true;
    });

    // Replace the pool in db.usersRepo while lookup query is still deferred / pending
    const repoPool2 = {
      getPool: () => mockPool2,
      findById: jest.fn(),
    };
    Object.defineProperty(db, 'usersRepo', { value: repoPool2, configurable: true, writable: true });

    // Now resolve the deferred query from the old pool
    resolveDeferredQuery({
      rows: [
        {
          id: 'user-race-pool',
          seed_id: 'wallet:0xrace-pool',
          is_test: false,
        },
      ],
    });

    await authPromise;

    expect(nextCalled).toBe(false);
    expect(req.isQAAuthorized).toBe(false);
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      success: false,
      error: {
        code: 'DATABASE_OUTAGE',
        message: 'Wallet session could not be verified.',
      },
    });
    // Ensure no sensitive values leaked in response body
    expect(JSON.stringify(res.body)).not.toContain('wallet:0xrace-pool');
    expect(JSON.stringify(res.body)).not.toContain('user-race-pool');
  });

  it('does not authorize synthetic preview and continues to live public data if alpha flag is disabled while lookup is pending', async () => {
    let resolveDeferredQuery!: (value: any) => void;
    const deferredPromise = new Promise((resolve) => {
      resolveDeferredQuery = resolve;
    });

    const mockPool = createMockPool(async () => {
      return deferredPromise;
    });

    const repoWithPool = {
      getPool: () => mockPool,
      findById: jest.fn(),
    };
    Object.defineProperty(db, 'usersRepo', { value: repoWithPool, configurable: true, writable: true });

    const req: AuthRequest = {
      method: 'GET',
      query: {},
      headers: {},
      user: { id: 'user-race-flag', seed_id: 'wallet:0xrace-flag', role: 'user' },
    } as any;
    const res = createMockRes();
    let nextCalled = false;

    const authPromise = checkQAAuthorization(req, res, () => {
      nextCalled = true;
    });

    // Disable the master alpha flag while the lookup read is deferred / pending
    Reflect.set(env, 'ALPHA_WALLET_SIMULATION_ENABLED', false);

    // Resolve deferred query with valid matching scope
    resolveDeferredQuery({
      rows: [
        {
          id: 'user-race-flag',
          seed_id: 'wallet:0xrace-flag',
          is_test: false,
        },
      ],
    });

    await authPromise;

    // Must continue to live public data with isQAAuthorized=false
    expect(nextCalled).toBe(true);
    expect(req.isQAAuthorized).toBe(false);
    expect(res.statusCode).toBe(200);
    expect(res.setHeader).not.toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    expect(res.setHeader).not.toHaveBeenCalledWith('X-Robots-Tag', 'noindex, nofollow');
  });
});
