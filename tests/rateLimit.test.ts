import {
  rateLimit,
  resetRateLimits,
  getRateLimitStoreSize,
  pruneAllExpired,
  DEFAULT_MAX_ENTRIES_PER_POLICY,
} from '../src/middleware/rateLimit.js';
import { Request, Response } from 'express';

describe('Phase 2: Rate Limiter Policy Separation & Actor Budgeting', () => {
  beforeEach(() => {
    resetRateLimits();
  });

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

  it('verifies that distinct policy IDs maintain separate budgets and do not cross-contaminate', () => {
    let mockTime = 1000;
    const clock = () => mockTime;

    const searchLimiter = rateLimit({
      policyId: 'search:query',
      windowMs: 60_000,
      max: 2,
      now: clock,
    });

    const followLimiter = rateLimit({
      policyId: 'users:follow-mutation',
      windowMs: 60_000,
      max: 2,
      now: clock,
    });

    const req = { ip: '198.51.100.1' } as Request;

    // Hit search limiter to its max
    searchLimiter(req, createMockRes(), () => {});
    searchLimiter(req, createMockRes(), () => {});

    // Third search request should be 429
    const searchRes3 = createMockRes();
    searchLimiter(req, searchRes3, () => {});
    expect(searchRes3.statusCode).toBe(429);
    expect(searchRes3.body.error.code).toBe('RATE_LIMITED');

    // Follow limiter on the SAME IP must NOT be blocked!
    let followNextCalled = false;
    const followRes = createMockRes();
    followLimiter(req, followRes, () => {
      followNextCalled = true;
    });
    expect(followNextCalled).toBe(true);
    expect(followRes.statusCode).toBe(200);
  });

  it('allocates distinct budgets to different authenticated actors sharing the same IP address (NAT scenario)', () => {
    let mockTime = 5000;
    const clock = () => mockTime;

    const limiter = rateLimit({
      policyId: 'submissions:create',
      windowMs: 60_000,
      max: 2,
      keyStrategy: 'actor',
      now: clock,
    });

    const sharedIp = '203.0.113.50';
    const reqUserA = { ip: sharedIp, user: { id: 'usr_alice' } } as unknown as Request;
    const reqUserB = { ip: sharedIp, user: { id: 'usr_bob' } } as unknown as Request;

    // Alice uses all 2 requests
    limiter(reqUserA, createMockRes(), () => {});
    limiter(reqUserA, createMockRes(), () => {});

    // Alice is now rate limited
    const aliceRes3 = createMockRes();
    limiter(reqUserA, aliceRes3, () => {});
    expect(aliceRes3.statusCode).toBe(429);

    // Bob, on the exact same IP, still has his full budget of 2 requests
    let bobNextCalled = false;
    const bobRes = createMockRes();
    limiter(reqUserB, bobRes, () => {
      bobNextCalled = true;
    });
    expect(bobNextCalled).toBe(true);
    expect(bobRes.statusCode).toBe(200);
  });

  it('includes standard rate limit and Retry-After headers with seconds remaining', () => {
    let mockTime = 100_000;
    const clock = () => mockTime;

    const limiter = rateLimit({
      policyId: 'auth:wallet-login',
      windowMs: 30_000,
      max: 1,
      now: clock,
    });

    const req = { ip: '10.0.0.1' } as Request;

    // Request 1: OK
    const res1 = createMockRes();
    limiter(req, res1, () => {});
    expect(res1.statusCode).toBe(200);
    expect(res1.headers['x-ratelimit-remaining']).toBe('0');
    expect(res1.headers['x-ratelimit-limit']).toBe('1');

    // Advance clock by 10 seconds (20 seconds left until reset)
    mockTime += 10_000;

    // Request 2: Blocked
    const res2 = createMockRes();
    limiter(req, res2, () => {});
    expect(res2.statusCode).toBe(429);
    expect(res2.headers['retry-after']).toBe('20');
    expect(res2.body.error.code).toBe('RATE_LIMITED');
  });

  it('resets counters cleanly after window expiry without requiring real sleep', () => {
    let mockTime = 10_000;
    const clock = () => mockTime;

    const limiter = rateLimit({
      policyId: 'users:public-profile',
      windowMs: 60_000,
      max: 1,
      now: clock,
    });

    const req = { ip: '172.16.0.5' } as Request;

    // Request 1: Allowed
    let called = false;
    limiter(req, createMockRes(), () => { called = true; });
    expect(called).toBe(true);

    // Request 2 (within window): Blocked
    const resBlocked = createMockRes();
    limiter(req, resBlocked, () => {});
    expect(resBlocked.statusCode).toBe(429);

    // Advance clock past the 60s window
    mockTime += 60_001;

    // Request 3 (after window): Allowed again
    let calledAfterReset = false;
    const resReset = createMockRes();
    limiter(req, resReset, () => { calledAfterReset = true; });
    expect(calledAfterReset).toBe(true);
    expect(resReset.statusCode).toBe(200);
  });

  it('triggers coarse IP guard if an IP abuses multiple actors', () => {
    let mockTime = 20_000;
    const clock = () => mockTime;

    const limiter = rateLimit({
      policyId: 'actor-with-ip-guard',
      windowMs: 60_000,
      max: 10,
      keyStrategy: 'actor',
      coarseIpMax: 3,
      now: clock,
    });

    const maliciousIp = '198.51.100.99';

    // Attacker uses 3 different actor tokens from same IP
    limiter({ ip: maliciousIp, user: { id: 'actor_1' } } as any, createMockRes(), () => {});
    limiter({ ip: maliciousIp, user: { id: 'actor_2' } } as any, createMockRes(), () => {});
    limiter({ ip: maliciousIp, user: { id: 'actor_3' } } as any, createMockRes(), () => {});

    // 4th request from actor_4 from same IP triggers coarse IP guard
    const blockedRes = createMockRes();
    limiter({ ip: maliciousIp, user: { id: 'actor_4' } } as any, blockedRes, () => {});
    expect(blockedRes.statusCode).toBe(429);
    expect(blockedRes.body.error.message).toContain('Too many requests from this IP address');
  });

  it('strictly enforces bounded memory capacity when flooded with distinct unexpired keys', () => {
    let mockTime = 50_000;
    const clock = () => mockTime;

    const maxCapacity = 10;
    const limiter = rateLimit({
      policyId: 'bounded-flood',
      windowMs: 60_000,
      max: 5,
      maxEntries: maxCapacity,
      now: clock,
    });

    // Flood with 30 distinct unexpired keys within the same window
    for (let i = 0; i < 30; i++) {
      const res = createMockRes();
      limiter({ ip: `192.168.1.${i}` } as Request, res, () => {});
      expect(getRateLimitStoreSize('bounded-flood')).toBeLessThanOrEqual(maxCapacity);
    }

    expect(getRateLimitStoreSize('bounded-flood')).toBe(maxCapacity);
  });

  it('protects blocked abusers from eviction while evicting unblocked entries', () => {
    let mockTime = 10_000;
    const clock = () => mockTime;

    const limiter = rateLimit({
      policyId: 'bounded-eviction',
      windowMs: 60_000,
      max: 1, // 1 request allowed, 2nd request blocks
      maxEntries: 3,
      now: clock,
    });

    const abuserIp = '10.0.0.1';
    const innocent1 = '10.0.0.2';
    const innocent2 = '10.0.0.3';
    const intruder = '10.0.0.4';

    // Abuser makes 2 requests and gets blocked
    limiter({ ip: abuserIp } as Request, createMockRes(), () => {});
    const blockRes = createMockRes();
    limiter({ ip: abuserIp } as Request, blockRes, () => {});
    expect(blockRes.statusCode).toBe(429);

    // Innocents make 1 request each (not blocked)
    limiter({ ip: innocent1 } as Request, createMockRes(), () => {});
    limiter({ ip: innocent2 } as Request, createMockRes(), () => {});
    expect(getRateLimitStoreSize('bounded-eviction')).toBe(3);

    // A 4th IP arrives; capacity is 3, so unblocked innocent1 is evicted
    limiter({ ip: intruder } as Request, createMockRes(), () => {});
    expect(getRateLimitStoreSize('bounded-eviction')).toBe(3);

    // Crucial check: Abuser IP MUST STILL BE BLOCKED!
    const retestAbuserRes = createMockRes();
    limiter({ ip: abuserIp } as Request, retestAbuserRes, () => {});
    expect(retestAbuserRes.statusCode).toBe(429);
    expect(retestAbuserRes.body.error.code).toBe('RATE_LIMITED');
  });

  it('rejects new admission with 429 when capacity is fully saturated with active abusers', () => {
    let mockTime = 10_000;
    const clock = () => mockTime;

    const limiter = rateLimit({
      policyId: 'bounded-saturated',
      windowMs: 60_000,
      max: 1,
      maxEntries: 2,
      now: clock,
    });

    // Sature all 2 slots with active abusers
    for (const ip of ['1.1.1.1', '2.2.2.2']) {
      limiter({ ip } as Request, createMockRes(), () => {});
      limiter({ ip } as Request, createMockRes(), () => {}); // blocked
    }
    expect(getRateLimitStoreSize('bounded-saturated')).toBe(2);

    // New IP attempts to connect while store has zero evictable slots
    const saturatedRes = createMockRes();
    limiter({ ip: '3.3.3.3' } as Request, saturatedRes, () => {});
    expect(saturatedRes.statusCode).toBe(429);
    expect(saturatedRes.body.error.message).toContain('capacity saturated');
  });

  it('prunes expired entries cleanly across all policy stores', () => {
    let mockTime = 100_000;
    const clock = () => mockTime;

    const limiter = rateLimit({
      policyId: 'prune-test',
      windowMs: 10_000,
      max: 5,
      now: clock,
    });

    for (let i = 0; i < 5; i++) {
      limiter({ ip: `10.99.0.${i}` } as Request, createMockRes(), () => {});
    }
    expect(getRateLimitStoreSize('prune-test')).toBe(5);

    // Advance clock past 10s window
    mockTime += 15_000;

    const prunedCount = pruneAllExpired(mockTime);
    expect(prunedCount).toBe(5);
    expect(getRateLimitStoreSize('prune-test')).toBe(0);
  });
});
