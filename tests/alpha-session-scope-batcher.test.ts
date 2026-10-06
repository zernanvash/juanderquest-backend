import {
  AlphaSessionScopeBatcher,
  AlphaBatchQueryFn,
} from '../src/auth/alphaSessionScopeBatcher.js';
import type { AlphaSessionScope } from '../src/repositories/users.js';

describe('AlphaSessionScopeBatcher (Iteration 20b)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('coalesces 100 concurrent unique IDs into a single query call and resolves distinct fresh results', async () => {
    const mockQuery = jest.fn(async (ids: string[]) => {
      const map = new Map<string, AlphaSessionScope>();
      for (const id of ids) {
        map.set(id, { id, seed_id: `seed-${id}`, is_test: false });
      }
      return map;
    });

    const batcher = new AlphaSessionScopeBatcher(mockQuery, { delayMs: 2, maxBatchSize: 100 });

    const promises = Array.from({ length: 100 }, (_, i) => batcher.lookup(`user-${i}`));

    // Since 100 IDs reaches maxBatchSize, executeBatch is triggered immediately
    const results = await Promise.all(promises);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const calledIds = mockQuery.mock.calls[0][0];
    expect(calledIds.length).toBe(100);
    expect(calledIds[0]).toBe('user-0');
    expect(calledIds[99]).toBe('user-99');

    expect(results.length).toBe(100);
    expect(results[0]).toEqual({ id: 'user-0', seed_id: 'seed-user-0', is_test: false });
    expect(results[99]).toEqual({ id: 'user-99', seed_id: 'seed-user-99', is_test: false });

    batcher.close();
  });

  it('splits 101 concurrent unique IDs into 100 + 1 across two sequential calls', async () => {
    let resolveFirstBatch: (val: Map<string, AlphaSessionScope>) => void = () => {};
    let resolveSecondBatch: (val: Map<string, AlphaSessionScope>) => void = () => {};

    let callCount = 0;
    const mockQuery = jest.fn((ids: string[]) => {
      callCount++;
      return new Promise<Map<string, AlphaSessionScope>>((resolve) => {
        if (callCount === 1) {
          resolveFirstBatch = resolve;
        } else {
          resolveSecondBatch = resolve;
        }
      });
    });

    const batcher = new AlphaSessionScopeBatcher(mockQuery, { delayMs: 2, maxBatchSize: 100, maxUnresolvedCallers: 500 });

    const promises = Array.from({ length: 101 }, (_, i) => batcher.lookup(`user-${i}`));

    // First batch of 100 should be immediately in-flight
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][0].length).toBe(100);

    // Resolve first batch
    const firstMap = new Map<string, AlphaSessionScope>();
    for (let i = 0; i < 100; i++) {
      firstMap.set(`user-${i}`, { id: `user-${i}`, seed_id: `seed-${i}`, is_test: false });
    }
    resolveFirstBatch(firstMap);

    // Allow promise microtasks to run
    await Promise.resolve();
    await Promise.resolve();

    // Advance timer for the remaining 1 item batch (since queue.size < 100, delay applies)
    jest.advanceTimersByTime(2);
    await Promise.resolve();

    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery.mock.calls[1][0]).toEqual(['user-100']);

    const secondMap = new Map<string, AlphaSessionScope>();
    secondMap.set('user-100', { id: 'user-100', seed_id: 'seed-100', is_test: false });
    resolveSecondBatch(secondMap);

    const results = await Promise.all(promises);
    expect(results.length).toBe(101);
    expect(results[0]?.id).toBe('user-0');
    expect(results[100]?.id).toBe('user-100');

    batcher.close();
  });

  it('coalesces duplicate callers for the same ID into one query entry while giving each caller its own settled promise', async () => {
    const mockQuery = jest.fn(async (ids: string[]) => {
      const map = new Map<string, AlphaSessionScope>();
      for (const id of ids) {
        map.set(id, { id, seed_id: `seed-${id}`, is_test: false });
      }
      return map;
    });

    const batcher = new AlphaSessionScopeBatcher(mockQuery, { delayMs: 2 });

    const p1 = batcher.lookup('user-shared');
    const p2 = batcher.lookup('user-shared');
    const p3 = batcher.lookup('user-shared');

    expect(p1).not.toBe(p2);
    expect(p2).not.toBe(p3);

    jest.advanceTimersByTime(2);

    const [res1, res2, res3] = await Promise.all([p1, p2, p3]);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][0]).toEqual(['user-shared']);

    expect(res1).toEqual({ id: 'user-shared', seed_id: 'seed-user-shared', is_test: false });
    expect(res2).toEqual({ id: 'user-shared', seed_id: 'seed-user-shared', is_test: false });
    expect(res3).toEqual({ id: 'user-shared', seed_id: 'seed-user-shared', is_test: false });

    batcher.close();
  });

  it('issues a fresh query for a request arriving after prior batch completion without result caching', async () => {
    const mockQuery = jest.fn(async (ids: string[]) => {
      const map = new Map<string, AlphaSessionScope>();
      for (const id of ids) {
        map.set(id, { id, seed_id: `seed-${id}`, is_test: false });
      }
      return map;
    });

    const batcher = new AlphaSessionScopeBatcher(mockQuery, { delayMs: 2 });

    const p1 = batcher.lookup('user-1');
    jest.advanceTimersByTime(2);
    const res1 = await p1;

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(res1?.id).toBe('user-1');

    // New request arriving after prior batch has completed
    const p2 = batcher.lookup('user-1');
    jest.advanceTimersByTime(2);
    const res2 = await p2;

    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery.mock.calls[1][0]).toEqual(['user-1']);
    expect(res2?.id).toBe('user-1');

    batcher.close();
  });

  it('resolves null for missing user IDs when query function omits them from the map', async () => {
    const mockQuery = jest.fn(async (ids: string[]) => {
      const map = new Map<string, AlphaSessionScope>();
      // Only return user-found, omit user-missing
      if (ids.includes('user-found')) {
        map.set('user-found', { id: 'user-found', seed_id: 'seed-found', is_test: false });
      }
      return map;
    });

    const batcher = new AlphaSessionScopeBatcher(mockQuery, { delayMs: 2 });

    const pFound = batcher.lookup('user-found');
    const pMissing = batcher.lookup('user-missing');

    jest.advanceTimersByTime(2);

    const [resFound, resMissing] = await Promise.all([pFound, pMissing]);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][0]).toEqual(['user-found', 'user-missing']);
    expect(resFound).toEqual({ id: 'user-found', seed_id: 'seed-found', is_test: false });
    expect(resMissing).toBeNull();

    batcher.close();
  });

  it('rejects every caller in the batch when query fails and preserves fail-closed behavior', async () => {
    const dbError = new Error('Database pool connection timeout');
    const mockQuery = jest.fn(async () => {
      throw dbError;
    });

    const batcher = new AlphaSessionScopeBatcher(mockQuery, { delayMs: 2 });

    const p1 = batcher.lookup('user-1');
    const p2 = batcher.lookup('user-2');

    jest.advanceTimersByTime(2);

    await expect(p1).rejects.toThrow('Database pool connection timeout');
    await expect(p2).rejects.toThrow('Database pool connection timeout');

    batcher.close();
  });

  it('rejects 501st unresolved caller with static error and prevents leaking ID or hanging caller', async () => {
    let resolveBatch: (val: Map<string, AlphaSessionScope>) => void = () => {};
    const mockQuery = jest.fn<Promise<Map<string, AlphaSessionScope>>, [string[]]>((_ids: string[]) => new Promise<Map<string, AlphaSessionScope>>((resolve) => {
      resolveBatch = resolve;
    }));

    const batcher = new AlphaSessionScopeBatcher(mockQuery, {
      delayMs: 2,
      maxBatchSize: 100,
      maxUnresolvedCallers: 500,
    });

    // Enqueue 500 callers: 100 are dispatched in-flight immediately, 400 remain pending in queue
    const promises: Promise<any>[] = [];
    for (let i = 0; i < 500; i++) {
      promises.push(batcher.lookup(`user-${i}`));
    }

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][0].length).toBe(100);

    // 501st caller should be rejected synchronously/immediately with static error
    const secretId = 'secret_user_id_do_not_leak_12345';
    let rejectedError: any;
    try {
      await batcher.lookup(secretId);
    } catch (err) {
      rejectedError = err;
    }

    expect(rejectedError).toBeDefined();
    expect(rejectedError.message).toBe('Batch capacity full.');
    expect(rejectedError.message).not.toContain(secretId);

    // Clean up unresolved callers by closing batcher (rejects all queued & in-flight)
    batcher.close();
    await Promise.allSettled(promises);
  });

  it('rejects invalid ID inputs with static error without calling query', async () => {
    const mockQuery = jest.fn();
    const batcher = new AlphaSessionScopeBatcher(mockQuery);

    const secretId = 'SECRET_TOKEN_OVERLENGTH_' + 'x'.repeat(150);

    await expect(batcher.lookup('')).rejects.toThrow('Invalid user ID.');
    await expect(batcher.lookup('   ')).rejects.toThrow('Invalid user ID.');
    await expect(batcher.lookup(123 as any)).rejects.toThrow('Invalid user ID.');

    let caughtError: any;
    try {
      await batcher.lookup(secretId);
    } catch (err) {
      caughtError = err;
    }
    expect(caughtError).toBeDefined();
    expect(caughtError.message).toBe('Invalid user ID.');
    expect(caughtError.message).not.toContain(secretId);

    expect(mockQuery).not.toHaveBeenCalled();
    batcher.close();
  });

  it('cancels timer and rejects pending and in-flight callers upon close()', async () => {
    let resolveQuery: (val: Map<string, AlphaSessionScope>) => void = () => {};
    const mockQuery = jest.fn<Promise<Map<string, AlphaSessionScope>>, [string[]]>((_ids: string[]) => new Promise<Map<string, AlphaSessionScope>>((resolve) => {
      resolveQuery = resolve;
    }));

    const batcher = new AlphaSessionScopeBatcher(mockQuery, { delayMs: 2, maxBatchSize: 2 });

    const pInFlight1 = batcher.lookup('user-1');
    const pInFlight2 = batcher.lookup('user-2'); // hits 2, fires immediately into inFlightQuery

    const pPending = batcher.lookup('user-3'); // queued

    expect(mockQuery).toHaveBeenCalledTimes(1);

    batcher.close();

    await expect(pInFlight1).rejects.toThrow('Batcher is closed.');
    await expect(pInFlight2).rejects.toThrow('Batcher is closed.');
    await expect(pPending).rejects.toThrow('Batcher is closed.');

    // Any new lookups after close are rejected
    await expect(batcher.lookup('user-4')).rejects.toThrow('Batcher is closed.');

    // Late query resolution after close must not resurrect or throw uncaught errors
    resolveQuery(new Map([['user-1', { id: 'user-1', seed_id: 'seed-1', is_test: false }]]));
    await Promise.resolve();
  });

  it('recovers after a query function throws synchronously instead of leaving the queue stuck', async () => {
    const query = jest.fn()
      .mockImplementationOnce(() => { throw new Error('synchronous database failure'); })
      .mockResolvedValueOnce(new Map([['second', { id: 'second', seed_id: 'wallet:second', is_test: false }]]));
    const batcher = new AlphaSessionScopeBatcher(query, { maxBatchSize: 1 });

    await expect(batcher.lookup('first')).rejects.toThrow('synchronous database failure');
    await expect(batcher.lookup('second')).resolves.toEqual({
      id: 'second', seed_id: 'wallet:second', is_test: false,
    });
    expect(query).toHaveBeenCalledTimes(2);
    batcher.close();
  });

  it('rejects invalid and over-cap constructor options with a static error', () => {
    const query = jest.fn(async () => new Map<string, AlphaSessionScope>());
    const invalidCases = [
      { maxBatchSize: 0 }, { maxBatchSize: -1 }, { maxBatchSize: 101 },
      { maxBatchSize: 1.5 }, { maxBatchSize: Number.NaN }, { maxBatchSize: Infinity },
      { maxUnresolvedCallers: 0 }, { maxUnresolvedCallers: 501 },
      { maxUnresolvedCallers: 2.5 }, { maxUnresolvedCallers: Infinity },
      { delayMs: -1 }, { delayMs: 3 }, { delayMs: 0.5 }, { delayMs: Number.NaN },
    ];
    for (const options of invalidCases) {
      expect(() => new AlphaSessionScopeBatcher(query, options))
        .toThrow('Invalid batcher options.');
    }
    expect(query).not.toHaveBeenCalled();
  });
});
