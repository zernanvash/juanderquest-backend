import { Pool } from 'pg';
import { UsersRepository } from '../src/repositories/users.js';

describe('UsersRepository - findAlphaSessionScopesByIds (Iteration 20a)', () => {
  it('projects only id, seed_id, and is_test, excluding private or extraneous fields', async () => {
    const mockQuery = jest.fn().mockResolvedValue({
      rows: [
        {
          id: 'user-uuid-1',
          seed_id: 'wallet:0x123',
          is_test: false,
          // Intentionally simulate DB or mock returning extraneous fields to verify projection exclusion
          email: 'secret@example.com',
          role: 'admin',
          demo_points: 1000,
          mjdq_balance: 50000,
        },
      ],
    });
    const fakePool = { query: mockQuery } as unknown as Pool;
    const repo = new UsersRepository(fakePool);

    const result = await repo.findAlphaSessionScopesByIds(['user-uuid-1']);

    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(1);
    expect(result.has('user-uuid-1')).toBe(true);

    const projected = result.get('user-uuid-1')!;
    expect(projected).toEqual({
      id: 'user-uuid-1',
      seed_id: 'wallet:0x123',
      is_test: false,
    });
    expect((projected as any).email).toBeUndefined();
    expect((projected as any).role).toBeUndefined();
    expect((projected as any).demo_points).toBeUndefined();
    expect((projected as any).mjdq_balance).toBeUndefined();
  });

  it('uses exact parameterized query and binds exact array parameter', async () => {
    const mockQuery = jest.fn().mockResolvedValue({
      rows: [
        { id: 'user-1', seed_id: 'seed-1', is_test: false },
        { id: 'user-2', seed_id: 'seed-2', is_test: true },
      ],
    });
    const fakePool = { query: mockQuery } as unknown as Pool;
    const repo = new UsersRepository(fakePool);

    const ids = ['user-1', 'user-2'];
    await repo.findAlphaSessionScopesByIds(ids);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toBe('SELECT id, seed_id, is_test FROM users WHERE id = ANY($1::text[])');
    expect(params).toEqual([['user-1', 'user-2']]);
  });

  it('deduplicates exact strings while preserving case and queries once', async () => {
    const mockQuery = jest.fn().mockResolvedValue({
      rows: [
        { id: 'User-A', seed_id: 'seed-A', is_test: false },
        { id: 'user-a', seed_id: 'seed-a', is_test: false },
      ],
    });
    const fakePool = { query: mockQuery } as unknown as Pool;
    const repo = new UsersRepository(fakePool);

    // Exact duplicate 'User-A' should be collapsed to 1; distinct case 'user-a' is preserved
    const result = await repo.findAlphaSessionScopesByIds(['User-A', 'User-A', 'user-a', 'User-A']);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [, params] = mockQuery.mock.calls[0];
    expect(params[0]).toEqual(['User-A', 'user-a']);
    expect(result.size).toBe(2);
    expect(result.get('User-A')?.seed_id).toBe('seed-A');
    expect(result.get('user-a')?.seed_id).toBe('seed-a');
  });

  it('omits missing users from the returned map without throwing', async () => {
    const mockQuery = jest.fn().mockResolvedValue({
      rows: [
        { id: 'user-found', seed_id: 'seed-found', is_test: false },
      ],
    });
    const fakePool = { query: mockQuery } as unknown as Pool;
    const repo = new UsersRepository(fakePool);

    const result = await repo.findAlphaSessionScopesByIds(['user-found', 'user-missing']);

    expect(result.size).toBe(1);
    expect(result.has('user-found')).toBe(true);
    expect(result.has('user-missing')).toBe(false);
  });

  it('throws rather than silently falling back to in-memory when pool is missing', async () => {
    const repo = new UsersRepository(null);

    await expect(repo.findAlphaSessionScopesByIds(['user-1'])).rejects.toThrow(
      'UsersRepository.findAlphaSessionScopesByIds requires an active PostgreSQL pool.'
    );
  });

  it('rejects empty array or non-array inputs', async () => {
    const fakePool = { query: jest.fn() } as unknown as Pool;
    const repo = new UsersRepository(fakePool);

    await expect(repo.findAlphaSessionScopesByIds([])).rejects.toThrow(
      'findAlphaSessionScopesByIds requires a nonempty array of user IDs.'
    );
    await expect(repo.findAlphaSessionScopesByIds(null as any)).rejects.toThrow(
      'findAlphaSessionScopesByIds requires a nonempty array of user IDs.'
    );
    await expect(repo.findAlphaSessionScopesByIds(undefined as any)).rejects.toThrow(
      'findAlphaSessionScopesByIds requires a nonempty array of user IDs.'
    );
  });

  it('rejects raw input exceeding 100 IDs before Set allocation (asserts no SQL query occurs)', async () => {
    const mockQuery = jest.fn();
    const fakePool = { query: mockQuery } as unknown as Pool;
    const repo = new UsersRepository(fakePool);

    const repeatedIds = Array.from({ length: 101 }, () => 'user-repeated-1');
    await expect(repo.findAlphaSessionScopesByIds(repeatedIds)).rejects.toThrow(
      'findAlphaSessionScopesByIds accepts at most 100 IDs.'
    );
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('rejects invalid or malformed IDs (whitespace, empty, non-string, overlength) with static message', async () => {
    const fakePool = { query: jest.fn() } as unknown as Pool;
    const repo = new UsersRepository(fakePool);

    await expect(repo.findAlphaSessionScopesByIds([''])).rejects.toThrow('Invalid user ID.');
    await expect(repo.findAlphaSessionScopesByIds(['   '])).rejects.toThrow('Invalid user ID.');
    await expect(repo.findAlphaSessionScopesByIds([123 as any])).rejects.toThrow('Invalid user ID.');
    await expect(repo.findAlphaSessionScopesByIds(['a'.repeat(129)])).rejects.toThrow('Invalid user ID.');
  });

  it('uses a static identifier-safe error message that never leaks the rejected value', async () => {
    const fakePool = { query: jest.fn() } as unknown as Pool;
    const repo = new UsersRepository(fakePool);

    const sentinelSecretId = 'SUPER_SECRET_TOKEN_OR_SEED_12345_DO_NOT_LEAK';
    let caughtError: Error | undefined;

    try {
      // Overlength to trigger invalid user ID validation while using secret-like string
      await repo.findAlphaSessionScopesByIds([sentinelSecretId + 'x'.repeat(100)]);
    } catch (err: any) {
      caughtError = err;
    }

    expect(caughtError).toBeDefined();
    expect(caughtError?.message).toBe('Invalid user ID.');
    expect(caughtError?.message).not.toContain(sentinelSecretId);
  });

  it('propagates PostgreSQL errors unchanged', async () => {
    const pgError = new Error('connection timeout');
    (pgError as any).code = '57P01';

    const mockQuery = jest.fn().mockRejectedValue(pgError);
    const fakePool = { query: mockQuery } as unknown as Pool;
    const repo = new UsersRepository(fakePool);

    await expect(repo.findAlphaSessionScopesByIds(['user-1'])).rejects.toThrow(pgError);
  });
});

