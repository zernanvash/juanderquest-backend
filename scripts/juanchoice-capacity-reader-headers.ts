import assert from 'node:assert/strict';
import type { ReaderAuthMode } from './juanchoice-capacity-mode.js';

export type ReaderAuthHeaders = Record<string, string>;

/**
 * Pure, import-safe helper that produces HTTP request headers for capacity readers.
 *
 * Requirements:
 * - Accepts ReaderAuthMode, readerIndex, a readonly token array, and expectedReaderCount.
 * - When mode === 'guest':
 *     Returns an empty header object {} (no Authorization header).
 * - When mode === 'wallet_alpha':
 *     Validates expectedReaderCount === 100.
 *     Validates tokens has exactly 100 elements.
 *     Validates readerIndex is an integer in the range 0..99.
 *     Validates the token at readerIndex is a non-empty string.
 *     Returns { Authorization: `Bearer ${token}` }.
 * - Throws a static error code on malformed input without embedding token text or secrets.
 * - Pure helper: no logs, environment access, database calls, HTTP, or side effects.
 */
export function buildReaderAuthHeaders(
  mode: ReaderAuthMode,
  readerIndex: number,
  tokens: readonly string[],
  expectedReaderCount = 100
): ReaderAuthHeaders {
  if (mode === 'guest') {
    return {};
  }

  assert(
    mode === 'wallet_alpha',
    'INVALID_READER_AUTH_MODE: ReaderAuthMode must be guest or wallet_alpha'
  );

  assert(
    typeof expectedReaderCount === 'number' && expectedReaderCount === 100,
    'INVALID_EXPECTED_READER_COUNT: Expected reader count must be exactly 100'
  );

  assert(
    Array.isArray(tokens) && tokens.length === 100,
    'INVALID_READER_TOKENS_COUNT: Exactly 100 reader tokens are required'
  );

  assert(
    typeof readerIndex === 'number' &&
      Number.isInteger(readerIndex) &&
      readerIndex >= 0 &&
      readerIndex < 100,
    'INVALID_READER_INDEX: Reader index must be an integer between 0 and 99'
  );

  const token = tokens[readerIndex];
  assert(
    typeof token === 'string' && token.trim().length > 0,
    'INVALID_READER_TOKEN: Reader token must be a non-empty string'
  );

  return {
    Authorization: `Bearer ${token}`,
  };
}

/**
 * Pure, import-safe helper that constructs all HTTP request headers for an in-process
 * capacity reader GET request, merging X-Forwarded-For with ReaderAuthHeaders.
 */
export function buildReadRequestHeaders(
  mode: ReaderAuthMode,
  readerIndex: number,
  tokens: readonly string[],
  expectedReaderCount = 100
): Record<string, string> {
  return {
    'X-Forwarded-For': `10.40.1.${readerIndex + 1}`,
    ...buildReaderAuthHeaders(mode, readerIndex, tokens, expectedReaderCount),
  };
}
