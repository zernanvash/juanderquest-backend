import jwt from 'jsonwebtoken';
import { buildDisposableWalletReaderIdentities } from '../scripts/juanchoice-capacity-reader-identities.js';
import {
  seedDisposableWalletReaderFixture,
  type SqlQueryable,
} from '../scripts/juanchoice-capacity-reader-fixture.js';

interface RecordedQuery {
  text: string;
  values?: unknown[];
}

class RecordingQueryStub implements SqlQueryable {
  public queries: RecordedQuery[] = [];
  public failAtIndex: number | null = null;
  public failureError: Error = new Error('Simulated query failure');

  async query(text: string, values?: unknown[]): Promise<unknown> {
    if (this.failAtIndex !== null && this.queries.length === this.failAtIndex) {
      throw this.failureError;
    }
    this.queries.push({ text, values });
    return { rows: [], rowCount: 1 };
  }
}

describe('Disposable wallet reader fixture helper', () => {
  const testSecret = 'capacity-test-secret-key-for-unit-testing-32b';

  describe('valid fixture seeding and token signing', () => {
    it('executes exact SQL parameter mappings for 100 records and returns verified tokens', async () => {
      const identities = buildDisposableWalletReaderIdentities(100);
      const stub = new RecordingQueryStub();

      const fixture = await seedDisposableWalletReaderFixture(stub, identities, testSecret);

      expect(fixture.tokens).toHaveLength(100);
      expect(stub.queries).toHaveLength(100);

      const tokenSet = new Set<string>();

      for (let i = 0; i < identities.length; i++) {
        const identity = identities[i];
        const recorded = stub.queries[i];
        const token = fixture.tokens[i];

        // SQL query text structure
        expect(recorded.text).toContain('INSERT INTO users');
        expect(recorded.text).toContain('is_test');
        expect(recorded.text).toContain('false');

        // Parameter mapping: [id, seed, displayName, email, createdAt]
        const vals = recorded.values!;
        expect(vals).toHaveLength(5);
        expect(vals[0]).toBe(identity.id);
        expect(vals[1]).toBe(identity.seed);
        expect(vals[2]).toBe(identity.displayName);
        expect(vals[3]).toBe(identity.email);

        // Created at timestamp should be a valid Date object within the expected past window
        const createdAt = vals[4] as Date;
        expect(createdAt instanceof Date).toBe(true);
        expect(Number.isNaN(createdAt.getTime())).toBe(false);
        const ageMs = Date.now() - createdAt.getTime();
        expect(ageMs).toBeGreaterThanOrEqual(3 * 86_400_000);
        expect(ageMs).toBeLessThanOrEqual(5 * 86_400_000);

        // JWT token verification and payload claims
        const decoded = jwt.verify(token, testSecret) as {
          id: string;
          seed_id: string;
          role: string;
        };
        expect(decoded.id).toBe(identity.id);
        expect(decoded.seed_id).toBe(identity.seed);
        expect(decoded.role).toBe('user');

        tokenSet.add(token);
      }

      // Uniqueness of tokens
      expect(tokenSet.size).toBe(100);
    });

    it('preserves exact 1:1 input ordering in returned tokens', async () => {
      const identities = buildDisposableWalletReaderIdentities(5);
      const stub = new RecordingQueryStub();

      const fixture = await seedDisposableWalletReaderFixture(stub, identities, testSecret);

      expect(fixture.tokens).toHaveLength(5);
      for (let i = 0; i < identities.length; i++) {
        const decoded = jwt.verify(fixture.tokens[i], testSecret) as { id: string; seed_id: string };
        expect(decoded.id).toBe(identities[i].id);
        expect(decoded.seed_id).toBe(identities[i].seed);
      }
    });

    it('rejects tokens signed with another secret', async () => {
      const identities = buildDisposableWalletReaderIdentities(1);
      const stub = new RecordingQueryStub();

      const fixture = await seedDisposableWalletReaderFixture(stub, identities, testSecret);
      const token = fixture.tokens[0];

      expect(() => jwt.verify(token, 'different-wrong-secret')).toThrow();
    });
  });

  describe('error handling and propagation', () => {
    it('propagates database query failure at the specified index without leaking tokens', async () => {
      const identities = buildDisposableWalletReaderIdentities(10);
      const stub = new RecordingQueryStub();
      stub.failAtIndex = 4;
      stub.failureError = new Error('simulated connection closed');

      await expect(
        seedDisposableWalletReaderFixture(stub, identities, testSecret)
      ).rejects.toThrow('Failed to insert disposable wallet reader at index 4');

      // Stopped at failure point
      expect(stub.queries).toHaveLength(4);
    });

    it('does not leak user credentials or token secrets in query errors', async () => {
      const identities = buildDisposableWalletReaderIdentities(1);
      const stub = new RecordingQueryStub();
      stub.failAtIndex = 0;
      stub.failureError = new Error('unique constraint violation');

      try {
        await seedDisposableWalletReaderFixture(stub, identities, testSecret);
        throw new Error('Should have failed');
      } catch (err: unknown) {
        const message = (err as Error).message;
        expect(message).toBe('Failed to insert disposable wallet reader at index 0');
        expect(message).not.toContain(identities[0].id);
        expect(message).not.toContain(identities[0].seed);
        expect(message).not.toContain(identities[0].email);
        expect(message).not.toContain(testSecret);
      }
    });

    it('sanitizes synthetic driver errors containing email, seed, ID, and secret without leakage', async () => {
      const identities = buildDisposableWalletReaderIdentities(3);
      const target = identities[1];
      const stub = new RecordingQueryStub();
      stub.failAtIndex = 1;
      stub.failureError = new Error(
        `FATAL pg driver error: duplicate key violates constraint with email=${target.email}, seed=${target.seed}, id=${target.id}, secret=${testSecret}`
      );

      try {
        await seedDisposableWalletReaderFixture(stub, identities, testSecret);
        throw new Error('Should have failed');
      } catch (err: unknown) {
        const error = err as Error;
        expect(error.message).toBe('Failed to insert disposable wallet reader at index 1');
        expect(error.message).not.toContain(target.email);
        expect(error.message).not.toContain(target.seed);
        expect(error.message).not.toContain(target.id);
        expect(error.message).not.toContain(testSecret);
        expect(error.message).not.toContain('FATAL pg driver error');
      }
    });

    it('rejects invalid pool / query interface', async () => {
      const identities = buildDisposableWalletReaderIdentities(1);
      await expect(
        seedDisposableWalletReaderFixture(null as unknown as SqlQueryable, identities, testSecret)
      ).rejects.toThrow('A valid disposable query interface must be provided');

      await expect(
        seedDisposableWalletReaderFixture({} as unknown as SqlQueryable, identities, testSecret)
      ).rejects.toThrow('A valid disposable query interface must be provided');
    });

    it('rejects empty or out-of-bounds identities', async () => {
      const stub = new RecordingQueryStub();
      await expect(
        seedDisposableWalletReaderFixture(stub, [], testSecret)
      ).rejects.toThrow('identities must contain between 1 and 100 records');

      const overLimit = Array.from({ length: 101 }, (_, i) => ({
        id: `id-${i}`,
        seed: `wallet:capacity-${i}`,
        email: `id-${i}@example.test`,
        displayName: `Reader ${i}`,
      }));
      await expect(
        seedDisposableWalletReaderFixture(stub, overLimit, testSecret)
      ).rejects.toThrow('identities must contain between 1 and 100 records');
    });

    it('rejects empty or invalid JWT secret', async () => {
      const stub = new RecordingQueryStub();
      const identities = buildDisposableWalletReaderIdentities(1);

      await expect(
        seedDisposableWalletReaderFixture(stub, identities, '')
      ).rejects.toThrow('testJwtSecret must be a non-empty string');

      await expect(
        seedDisposableWalletReaderFixture(stub, identities, '   ')
      ).rejects.toThrow('testJwtSecret must be a non-empty string');
    });
  });

  describe('contract purity and isolation', () => {
    it('does not mutate process.env', async () => {
      const originalEnv = { ...process.env };
      const identities = buildDisposableWalletReaderIdentities(10);
      const stub = new RecordingQueryStub();

      await seedDisposableWalletReaderFixture(stub, identities, testSecret);
      expect(process.env).toEqual(originalEnv);
    });
  });
});
