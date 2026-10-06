import assert from 'node:assert/strict';
import type { ReaderAuthMode } from './juanchoice-capacity-mode.js';
import {
  buildDisposableWalletReaderIdentities,
} from './juanchoice-capacity-reader-identities.js';
import {
  seedDisposableWalletReaderFixture,
  type SqlQueryable,
} from './juanchoice-capacity-reader-fixture.js';

export interface WalletReaderAssemblyResult {
  readonly seededCount: number;
  readonly tokens: readonly string[];
  readonly readerUserIds: readonly string[];
}

/**
 * Pure fixture assembly seam for capacity rehearsal.
 *
 * For 'wallet_alpha': builds exactly 100 disposable reader identities and seeds them
 * into the passed disposable queryable pool using the supplied JWT secret.
 * Returns the exact count (100) and the in-memory array of signed tokens.
 *
 * For 'guest': performs no database insertions and returns 0 seeded readers and empty tokens.
 *
 * Note: seededCount is sanitized metadata and does not represent auth-path execution evidence.
 */
export async function assembleWalletReaderFixtureForHarness(
  mode: ReaderAuthMode,
  pool: SqlQueryable,
  jwtSecret: string,
  targetReaderCount = 100
): Promise<WalletReaderAssemblyResult> {
  if (mode !== 'wallet_alpha') {
    return {
      seededCount: 0,
      tokens: Object.freeze([]),
      readerUserIds: Object.freeze([]),
    };
  }

  assert(
    typeof targetReaderCount === 'number' && targetReaderCount === 100,
    'Wallet reader fixture assembly requires exactly 100 readers'
  );
  assert(
    typeof jwtSecret === 'string' && jwtSecret.trim().length > 0,
    'jwtSecret must be provided for wallet reader fixture assembly'
  );

  const identities = buildDisposableWalletReaderIdentities(targetReaderCount);
  const seeded = await seedDisposableWalletReaderFixture(pool, identities, jwtSecret);

  return {
    seededCount: identities.length,
    tokens: seeded.tokens,
    readerUserIds: Object.freeze(identities.map((identity) => identity.id)),
  };
}

