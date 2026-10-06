import jwt from 'jsonwebtoken';
import {
  assembleWalletReaderFixtureForHarness,
  type WalletReaderAssemblyResult,
} from '../scripts/juanchoice-capacity-reader-assembly.js';
import type { SqlQueryable } from '../scripts/juanchoice-capacity-reader-fixture.js';

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

describe('Capacity rehearsal wallet reader fixture assembly', () => {
  const testSecret = 'assembly-test-secret-key-32-chars-long!';

  describe('guest reader mode behavior', () => {
    it('seeds zero readers and produces empty tokens when mode is guest', async () => {
      const stub = new RecordingQueryStub();

      const result: WalletReaderAssemblyResult = await assembleWalletReaderFixtureForHarness(
        'guest',
        stub,
        testSecret,
        100
      );

      expect(result.seededCount).toBe(0);
      expect(result.tokens).toEqual([]);
      expect(result.readerUserIds).toEqual([]);
      expect(stub.queries).toHaveLength(0);
    });

    it('performs no database interaction even if target count is different', async () => {
      const stub = new RecordingQueryStub();

      const result = await assembleWalletReaderFixtureForHarness(
        'guest',
        stub,
        testSecret
      );

      expect(result.seededCount).toBe(0);
      expect(result.tokens).toEqual([]);
      expect(result.readerUserIds).toEqual([]);
      expect(stub.queries).toHaveLength(0);
    });
  });

  describe('wallet_alpha reader mode behavior', () => {
    it('seeds exactly 100 readers into the passed pool and returns 100 matching tokens in memory', async () => {
      const stub = new RecordingQueryStub();

      const result: WalletReaderAssemblyResult = await assembleWalletReaderFixtureForHarness(
        'wallet_alpha',
        stub,
        testSecret,
        100
      );

      expect(result.seededCount).toBe(100);
      expect(result.tokens).toHaveLength(100);
      expect(result.readerUserIds).toHaveLength(100);
      expect(stub.queries).toHaveLength(100);

      const seenSeeds = new Set<string>();
      const seenIds = new Set<string>();
      const seenTokens = new Set<string>();

      for (let i = 0; i < 100; i++) {
        const recorded = stub.queries[i];
        expect(recorded.text).toContain('INSERT INTO users');
        const vals = recorded.values!;
        expect(vals).toHaveLength(5);

        const id = vals[0] as string;
        const seed = vals[1] as string;
        const displayName = vals[2] as string;
        const email = vals[3] as string;

        expect(typeof id).toBe('string');
        expect(seed.startsWith('wallet:capacity-')).toBe(true);
        expect(displayName).toBe(`Capacity reader ${i + 1}`);
        expect(email.endsWith('@example.test')).toBe(true);

        // Verify readerUserIds ordering matches insertion and tokens
        expect(result.readerUserIds[i]).toBe(id);

        seenIds.add(id);
        seenSeeds.add(seed);

        const token = result.tokens[i];
        seenTokens.add(token);

        const decoded = jwt.verify(token, testSecret) as {
          id: string;
          seed_id: string;
          role: string;
        };
        expect(decoded.id).toBe(id);
        expect(decoded.id).toBe(result.readerUserIds[i]);
        expect(decoded.seed_id).toBe(seed);
        expect(decoded.role).toBe('user');
      }

      expect(seenIds.size).toBe(100);
      expect(seenSeeds.size).toBe(100);
      expect(seenTokens.size).toBe(100);
    });

    it('rejects targetReaderCount other than 100 for wallet_alpha', async () => {
      const stub = new RecordingQueryStub();

      await expect(
        assembleWalletReaderFixtureForHarness('wallet_alpha', stub, testSecret, 50)
      ).rejects.toThrow('Wallet reader fixture assembly requires exactly 100 readers');

      await expect(
        assembleWalletReaderFixtureForHarness('wallet_alpha', stub, testSecret, 101)
      ).rejects.toThrow('Wallet reader fixture assembly requires exactly 100 readers');

      expect(stub.queries).toHaveLength(0);
    });

    it('rejects empty or blank JWT secret for wallet_alpha', async () => {
      const stub = new RecordingQueryStub();

      await expect(
        assembleWalletReaderFixtureForHarness('wallet_alpha', stub, '', 100)
      ).rejects.toThrow('jwtSecret must be provided for wallet reader fixture assembly');

      await expect(
        assembleWalletReaderFixtureForHarness('wallet_alpha', stub, '   ', 100)
      ).rejects.toThrow('jwtSecret must be provided for wallet reader fixture assembly');

      expect(stub.queries).toHaveLength(0);
    });

    it('propagates database insertion failure through the query interface', async () => {
      const stub = new RecordingQueryStub();
      stub.failAtIndex = 5;

      await expect(
        assembleWalletReaderFixtureForHarness('wallet_alpha', stub, testSecret, 100)
      ).rejects.toThrow('Failed to insert disposable wallet reader at index 5');

      expect(stub.queries).toHaveLength(5);
    });
  });
});
