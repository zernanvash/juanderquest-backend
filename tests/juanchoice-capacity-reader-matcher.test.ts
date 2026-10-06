import {
  countDisposableWalletReaderBatchChecks,
  isDisposableWalletReaderLookup,
} from '../scripts/juanchoice-capacity-reader-matcher.js';

describe('isDisposableWalletReaderLookup pure SQL matcher', () => {
  const readerId1 = '00000000-0000-0000-0000-000000000001';
  const readerId2 = '00000000-0000-0000-0000-000000000002';
  const ballotVoterId = '00000000-0000-0000-0000-000000000099';
  const unknownId = '00000000-0000-0000-0000-000000000999';

  const disposableReaderIds = new Set<string>([readerId1, readerId2]);

  describe('positive matches', () => {
    it('matches exact canonical SQL string with matching reader id', () => {
      const result = isDisposableWalletReaderLookup(
        'SELECT * FROM users WHERE id = $1',
        [readerId1],
        disposableReaderIds
      );
      expect(result).toBe(true);
    });

    it('matches { text: string } query object configuration', () => {
      const result = isDisposableWalletReaderLookup(
        { text: 'SELECT * FROM users WHERE id = $1' },
        [readerId2],
        disposableReaderIds
      );
      expect(result).toBe(true);
    });

    it('matches queries with extra internal and leading/trailing whitespace', () => {
      const variedWhitespaceQueries = [
        '  SELECT * FROM users WHERE id = $1  ',
        'SELECT   *   FROM   users   WHERE   id = $1',
        '\nSELECT *\nFROM users\nWHERE id = $1\n',
        '\tSELECT * FROM users WHERE id = $1\t',
        'SELECT * FROM users WHERE id = $1;',
        '  SELECT * FROM users WHERE id = $1;  ',
      ];

      for (const query of variedWhitespaceQueries) {
        expect(isDisposableWalletReaderLookup(query, [readerId1], disposableReaderIds)).toBe(true);
      }
    });
  });

  describe('negative matches - voter IDs and unknown IDs', () => {
    it('rejects ballot voter IDs even with exact query form', () => {
      const result = isDisposableWalletReaderLookup(
        'SELECT * FROM users WHERE id = $1',
        [ballotVoterId],
        disposableReaderIds
      );
      expect(result).toBe(false);
    });

    it('rejects unlisted IDs not in allowed disposable set', () => {
      const result = isDisposableWalletReaderLookup(
        'SELECT * FROM users WHERE id = $1',
        [unknownId],
        disposableReaderIds
      );
      expect(result).toBe(false);
    });
  });

  describe('negative matches - set boundary safety', () => {
    it('rejects any query when reader ID set is empty', () => {
      const emptySet = new Set<string>();
      expect(
        isDisposableWalletReaderLookup(
          'SELECT * FROM users WHERE id = $1',
          [readerId1],
          emptySet
        )
      ).toBe(false);
    });
  });

  describe('negative matches - bound value safety and malformed parameters', () => {
    it('rejects missing or non-array values', () => {
      expect(isDisposableWalletReaderLookup('SELECT * FROM users WHERE id = $1', undefined, disposableReaderIds)).toBe(false);
      expect(isDisposableWalletReaderLookup('SELECT * FROM users WHERE id = $1', null, disposableReaderIds)).toBe(false);
      expect(isDisposableWalletReaderLookup('SELECT * FROM users WHERE id = $1', readerId1, disposableReaderIds)).toBe(false);
      expect(isDisposableWalletReaderLookup('SELECT * FROM users WHERE id = $1', {}, disposableReaderIds)).toBe(false);
    });

    it('rejects empty bound parameter array', () => {
      expect(isDisposableWalletReaderLookup('SELECT * FROM users WHERE id = $1', [], disposableReaderIds)).toBe(false);
    });

    it('rejects multiple bound parameters', () => {
      expect(
        isDisposableWalletReaderLookup(
          'SELECT * FROM users WHERE id = $1',
          [readerId1, 'extra_param'],
          disposableReaderIds
        )
      ).toBe(false);
    });

    it('rejects non-string bound parameter values', () => {
      expect(isDisposableWalletReaderLookup('SELECT * FROM users WHERE id = $1', [12345], disposableReaderIds)).toBe(false);
      expect(isDisposableWalletReaderLookup('SELECT * FROM users WHERE id = $1', [null], disposableReaderIds)).toBe(false);
      expect(isDisposableWalletReaderLookup('SELECT * FROM users WHERE id = $1', [''], disposableReaderIds)).toBe(false);
      expect(isDisposableWalletReaderLookup('SELECT * FROM users WHERE id = $1', [{ id: readerId1 }], disposableReaderIds)).toBe(false);
    });
  });

  describe('negative matches - lookalike and non-target SQL queries', () => {
    const lookalikes = [
      'SELECT id, email FROM users WHERE id = $1',
      'SELECT * FROM users WHERE id = $1 AND is_public = TRUE',
      'SELECT * FROM users WHERE id = $1 AND is_test = false',
      'SELECT * FROM users WHERE email = $1',
      'SELECT * FROM users WHERE seed_id = $1',
      'SELECT * FROM spots WHERE id = $1',
      'SELECT * FROM juanchoice_campaigns WHERE id = $1',
      'SELECT count(*) FROM users WHERE id = $1',
      'UPDATE users SET display_name = $2 WHERE id = $1',
      'DELETE FROM users WHERE id = $1',
      'INSERT INTO users (id) VALUES ($1)',
      'SELECT * FROM users WHERE id = $1 OR 1=1',
      'SELECT * FROM users_backup WHERE id = $1',
      'SELECT * FROM users',
    ];

    for (const sql of lookalikes) {
      it(`rejects non-target SQL shape: "${sql}"`, () => {
        expect(
          isDisposableWalletReaderLookup(sql, [readerId1], disposableReaderIds)
        ).toBe(false);
      });
    }

    it('rejects invalid query inputs (null, undefined, non-object, object missing text)', () => {
      expect(isDisposableWalletReaderLookup(null, [readerId1], disposableReaderIds)).toBe(false);
      expect(isDisposableWalletReaderLookup(undefined, [readerId1], disposableReaderIds)).toBe(false);
      expect(isDisposableWalletReaderLookup(123, [readerId1], disposableReaderIds)).toBe(false);
      expect(isDisposableWalletReaderLookup({}, [readerId1], disposableReaderIds)).toBe(false);
      expect(isDisposableWalletReaderLookup({ query: 'SELECT * FROM users WHERE id = $1' }, [readerId1], disposableReaderIds)).toBe(false);
    });
  });
});

describe('countDisposableWalletReaderBatchChecks', () => {
  const sql = 'SELECT id, seed_id, is_test FROM users WHERE id = ANY($1::text[])';
  const readers = Array.from({ length: 100 }, (_, index) => `reader-${index}`);
  const allowed = new Set(readers);

  it('counts one bounded batch of 100 and three fresh waves as 300 checked identities', () => {
    expect(countDisposableWalletReaderBatchChecks(sql, [readers], allowed)).toBe(100);
    const waves = [readers, readers, readers];
    expect(waves.reduce((count, ids) => count + countDisposableWalletReaderBatchChecks({ text: sql }, [ids], allowed), 0))
      .toBe(300);
  });

  it('rejects malformed, mixed-scope, duplicate, unbound and inline-SQL lookalikes', () => {
    const invalid: Array<[unknown, unknown, ReadonlySet<string>]> = [
      [sql, [], allowed], [sql, readers, allowed], [sql, [[]], allowed],
      [sql, [Array.from({ length: 101 }, (_, index) => `reader-${index}`)], allowed],
      [sql, [['reader-1', 'reader-1']], allowed],
      [sql, [['reader-1', 'ballot-voter']], allowed],
      [sql, [['reader-1']], new Set<string>()],
      [sql, [[null]], allowed], [sql, [['']], allowed],
      [sql + ' OR 1=1', [['reader-1']], allowed],
      ["SELECT id, seed_id, is_test FROM users WHERE id = ANY(ARRAY['reader-1'])", [['reader-1']], allowed],
      ['SELECT * FROM users WHERE id = $1', [['reader-1']], allowed],
    ];
    for (const [query, values, set] of invalid) {
      expect(countDisposableWalletReaderBatchChecks(query, values, set)).toBe(0);
    }
  });
});
