import { buildDisposableWalletReaderIdentities } from '../scripts/juanchoice-capacity-reader-identities.js';

describe('Disposable wallet reader identities helper', () => {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  describe('valid identity generation', () => {
    it('generates exactly 100 reader identity records when readerCount is 100', () => {
      const records = buildDisposableWalletReaderIdentities(100);
      expect(records).toHaveLength(100);

      const ids = new Set<string>();
      const seeds = new Set<string>();
      const emails = new Set<string>();

      for (let i = 0; i < records.length; i++) {
        const record = records[i];

        // Valid UUID id
        expect(record.id).toMatch(uuidRegex);
        ids.add(record.id);

        // Exact wallet:capacity- prefix and length <= 50 chars for users.seed_id VARCHAR(50)
        expect(record.seed.startsWith('wallet:capacity-')).toBe(true);
        expect(record.seed.length).toBeLessThanOrEqual(50);
        seeds.add(record.seed);

        // Benign example.test email matching id
        expect(record.email).toBe(`${record.id}@example.test`);
        expect(record.email.endsWith('@example.test')).toBe(true);
        emails.add(record.email);

        // Display name
        expect(record.displayName).toBe(`Capacity reader ${i + 1}`);
      }

      // Uniqueness of all 100 records
      expect(ids.size).toBe(100);
      expect(seeds.size).toBe(100);
      expect(emails.size).toBe(100);
    });

    it('generates exactly the requested count for 1 reader', () => {
      const records = buildDisposableWalletReaderIdentities(1);
      expect(records).toHaveLength(1);
      expect(records[0].id).toMatch(uuidRegex);
      expect(records[0].seed.startsWith('wallet:capacity-')).toBe(true);
      expect(records[0].seed.length).toBeLessThanOrEqual(50);
      expect(records[0].email).toBe(`${records[0].id}@example.test`);
      expect(records[0].displayName).toBe('Capacity reader 1');
    });

    it('generates 50 reader identity records without overlap', () => {
      const records = buildDisposableWalletReaderIdentities(50);
      expect(records).toHaveLength(50);
      const ids = new Set(records.map(r => r.id));
      const seeds = new Set(records.map(r => r.seed));
      expect(ids.size).toBe(50);
      expect(seeds.size).toBe(50);
      for (const record of records) {
        expect(record.seed.length).toBeLessThanOrEqual(50);
      }
    });
  });

  describe('PostgreSQL schema compatibility (users.seed_id VARCHAR(50)) and 96-bit suffix entropy', () => {
    const SEED_ID_MAX_LENGTH = 50;

    it('guarantees every seed in a 100-reader fixture fits users.seed_id VARCHAR(50), has exactly 24 lowercase hex suffix characters, and yields 100 unique seeds', () => {
      const records = buildDisposableWalletReaderIdentities(100);
      expect(records).toHaveLength(100);

      const uniqueSeeds = new Set<string>();

      for (let i = 0; i < records.length; i++) {
        const seed = records[i].seed;
        expect(seed.length).toBeLessThanOrEqual(SEED_ID_MAX_LENGTH);
        expect(Buffer.byteLength(seed, 'utf8')).toBeLessThanOrEqual(SEED_ID_MAX_LENGTH);
        expect(seed.startsWith(`wallet:capacity-${i}-`)).toBe(true);

        // Assert exactly 24 lowercase hex suffix characters (96 random bits from randomBytes(12))
        const suffixMatch = seed.match(/^wallet:capacity-\d+-([0-9a-f]+)$/);
        expect(suffixMatch).not.toBeNull();
        const suffix = suffixMatch![1];
        expect(suffix).toHaveLength(24);
        expect(suffix).toMatch(/^[0-9a-f]{24}$/);

        uniqueSeeds.add(seed);
      }

      // Assert exactly 100 unique seeds across the 100 records without a probabilistic collision test
      expect(uniqueSeeds.size).toBe(100);
    });

    it('validates seed length bounds at boundary reader indices (0 and 99)', () => {
      const records = buildDisposableWalletReaderIdentities(100);
      // Index 0: 1-digit index
      expect(records[0].seed.startsWith('wallet:capacity-0-')).toBe(true);
      expect(records[0].seed.length).toBeLessThanOrEqual(SEED_ID_MAX_LENGTH);

      // Index 99: 2-digit index
      expect(records[99].seed.startsWith('wallet:capacity-99-')).toBe(true);
      expect(records[99].seed.length).toBeLessThanOrEqual(SEED_ID_MAX_LENGTH);
    });
  });

  describe('input validation and edge case rejection', () => {
    it('rejects 0 count', () => {
      expect(() => buildDisposableWalletReaderIdentities(0)).toThrow(
        'readerCount must be a positive safe integer no greater than 100'
      );
    });

    it('rejects negative count', () => {
      expect(() => buildDisposableWalletReaderIdentities(-1)).toThrow(
        'readerCount must be a positive safe integer no greater than 100'
      );
      expect(() => buildDisposableWalletReaderIdentities(-100)).toThrow(
        'readerCount must be a positive safe integer no greater than 100'
      );
    });

    it('rejects count greater than 100', () => {
      expect(() => buildDisposableWalletReaderIdentities(101)).toThrow(
        'readerCount must be a positive safe integer no greater than 100'
      );
      expect(() => buildDisposableWalletReaderIdentities(500)).toThrow(
        'readerCount must be a positive safe integer no greater than 100'
      );
    });

    it('rejects fractional numbers', () => {
      expect(() => buildDisposableWalletReaderIdentities(1.5)).toThrow(
        'readerCount must be a positive safe integer no greater than 100'
      );
      expect(() => buildDisposableWalletReaderIdentities(99.99)).toThrow(
        'readerCount must be a positive safe integer no greater than 100'
      );
    });

    it('rejects non-safe or non-finite numbers', () => {
      expect(() => buildDisposableWalletReaderIdentities(Number.MAX_SAFE_INTEGER + 1)).toThrow(
        'readerCount must be a positive safe integer no greater than 100'
      );
      expect(() => buildDisposableWalletReaderIdentities(Infinity)).toThrow(
        'readerCount must be a positive safe integer no greater than 100'
      );
      expect(() => buildDisposableWalletReaderIdentities(NaN)).toThrow(
        'readerCount must be a positive safe integer no greater than 100'
      );
    });

    it('rejects non-number inputs at runtime', () => {
      expect(() => buildDisposableWalletReaderIdentities('100' as unknown as number)).toThrow(
        'readerCount must be a positive safe integer no greater than 100'
      );
      expect(() => buildDisposableWalletReaderIdentities(null as unknown as number)).toThrow(
        'readerCount must be a positive safe integer no greater than 100'
      );
      expect(() => buildDisposableWalletReaderIdentities(undefined as unknown as number)).toThrow(
        'readerCount must be a positive safe integer no greater than 100'
      );
    });
  });

  describe('contract purity and isolation', () => {
    it('does not mutate process.env', () => {
      const originalEnv = { ...process.env };
      buildDisposableWalletReaderIdentities(100);
      expect(process.env).toEqual(originalEnv);
    });
  });
});
