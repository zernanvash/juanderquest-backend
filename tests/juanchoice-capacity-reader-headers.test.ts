import {
  buildReaderAuthHeaders,
  type ReaderAuthHeaders,
} from '../scripts/juanchoice-capacity-reader-headers.js';

describe('juanchoice-capacity-reader-headers', () => {
  const dummyTokens100 = Object.freeze(
    Array.from({ length: 100 }, (_, idx) => `test-token-${idx}-${'x'.repeat(20)}`)
  );

  describe('guest mode', () => {
    it('returns empty headers object regardless of tokens or index', () => {
      const headers1: ReaderAuthHeaders = buildReaderAuthHeaders('guest', 0, dummyTokens100, 100);
      expect(headers1).toEqual({});

      const headers2: ReaderAuthHeaders = buildReaderAuthHeaders('guest', 42, [], 0);
      expect(headers2).toEqual({});

      const headers3: ReaderAuthHeaders = buildReaderAuthHeaders('guest', 999, [], 100);
      expect(headers3).toEqual({});
    });
  });

  describe('wallet_alpha mode', () => {
    it('returns correct Bearer authorization header for all 100 distinct indices', () => {
      for (let i = 0; i < 100; i++) {
        const headers = buildReaderAuthHeaders('wallet_alpha', i, dummyTokens100, 100);
        expect(headers).toEqual({
          Authorization: `Bearer ${dummyTokens100[i]}`,
        });
        // Strict shape check
        expect(Object.keys(headers)).toEqual(['Authorization']);
      }
    });

    it('defaults expectedReaderCount to 100 when omitted', () => {
      const headers = buildReaderAuthHeaders('wallet_alpha', 0, dummyTokens100);
      expect(headers).toEqual({
        Authorization: `Bearer ${dummyTokens100[0]}`,
      });
    });

    it('throws on wrong token count', () => {
      const tokens99 = dummyTokens100.slice(0, 99);
      expect(() => buildReaderAuthHeaders('wallet_alpha', 0, tokens99, 100)).toThrow(
        'INVALID_READER_TOKENS_COUNT'
      );

      const tokens101 = [...dummyTokens100, 'extra-token'];
      expect(() => buildReaderAuthHeaders('wallet_alpha', 0, tokens101, 100)).toThrow(
        'INVALID_READER_TOKENS_COUNT'
      );

      expect(() => buildReaderAuthHeaders('wallet_alpha', 0, [] as unknown as string[], 100)).toThrow(
        'INVALID_READER_TOKENS_COUNT'
      );
    });

    it('throws on wrong expectedReaderCount', () => {
      expect(() => buildReaderAuthHeaders('wallet_alpha', 0, dummyTokens100, 50)).toThrow(
        'INVALID_EXPECTED_READER_COUNT'
      );
      expect(() => buildReaderAuthHeaders('wallet_alpha', 0, dummyTokens100, 101)).toThrow(
        'INVALID_EXPECTED_READER_COUNT'
      );
    });

    it('throws on out-of-range or non-integer reader indices', () => {
      expect(() => buildReaderAuthHeaders('wallet_alpha', -1, dummyTokens100, 100)).toThrow(
        'INVALID_READER_INDEX'
      );
      expect(() => buildReaderAuthHeaders('wallet_alpha', 100, dummyTokens100, 100)).toThrow(
        'INVALID_READER_INDEX'
      );
      expect(() => buildReaderAuthHeaders('wallet_alpha', 105, dummyTokens100, 100)).toThrow(
        'INVALID_READER_INDEX'
      );
      expect(() => buildReaderAuthHeaders('wallet_alpha', 0.5, dummyTokens100, 100)).toThrow(
        'INVALID_READER_INDEX'
      );
      expect(() => buildReaderAuthHeaders('wallet_alpha', NaN, dummyTokens100, 100)).toThrow(
        'INVALID_READER_INDEX'
      );
    });

    it('throws on missing, empty, or whitespace-only token at the requested index', () => {
      const tokensWithEmpty = [...dummyTokens100];
      tokensWithEmpty[5] = '';
      expect(() => buildReaderAuthHeaders('wallet_alpha', 5, tokensWithEmpty, 100)).toThrow(
        'INVALID_READER_TOKEN'
      );

      const tokensWithWhitespace = [...dummyTokens100];
      tokensWithWhitespace[12] = '   ';
      expect(() => buildReaderAuthHeaders('wallet_alpha', 12, tokensWithWhitespace, 100)).toThrow(
        'INVALID_READER_TOKEN'
      );

      const tokensWithUndefined = [...dummyTokens100];
      (tokensWithUndefined as unknown as (string | undefined)[])[20] = undefined;
      expect(() => buildReaderAuthHeaders('wallet_alpha', 20, tokensWithUndefined as unknown as string[], 100)).toThrow(
        'INVALID_READER_TOKEN'
      );
    });

    it('does not embed token content in any thrown error message', () => {
      const sensitiveToken = 'sensitive-super-secret-jwt-token-string';
      const tokens = Array.from({ length: 100 }, (_, i) => (i === 10 ? '   ' : sensitiveToken));

      try {
        buildReaderAuthHeaders('wallet_alpha', 10, tokens, 100);
        throw new Error('Expected function to throw');
      } catch (err: unknown) {
        const error = err as Error;
        expect(error.message).not.toContain(sensitiveToken);
        expect(error.message).toBe('INVALID_READER_TOKEN: Reader token must be a non-empty string');
      }
    });

    it('throws on unrecognized ReaderAuthMode', () => {
      expect(() =>
        buildReaderAuthHeaders('unsupported_mode' as unknown as 'guest', 0, dummyTokens100, 100)
      ).toThrow('INVALID_READER_AUTH_MODE');
    });
  });
});
