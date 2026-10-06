import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';

export interface DisposableWalletReaderIdentity {
  readonly id: string;
  readonly seed: string;
  readonly email: string;
  readonly displayName: string;
}

/**
 * Builds disposable wallet reader identities for capacity rehearsal fixtures.
 *
 * Requirements:
 * - Exactly `readerCount` records.
 * - `readerCount` must be a positive safe integer <= 100.
 * - Each record has:
 *   - random UUID id
 *   - unique seed starting with 'wallet:capacity-'
 *   - benign unique example.test email
 *   - display name
 * - Pure helper: no DB connections, no JWT signing, no env mutation, no printing.
 */
export function buildDisposableWalletReaderIdentities(readerCount: number): DisposableWalletReaderIdentity[] {
  assert(
    typeof readerCount === 'number' &&
      Number.isInteger(readerCount) &&
      Number.isSafeInteger(readerCount) &&
      readerCount >= 1 &&
      readerCount <= 100,
    'readerCount must be a positive safe integer no greater than 100'
  );

  return Array.from({ length: readerCount }, (_, index) => {
    const id = randomUUID();
    const uniqueSuffix = randomBytes(12).toString('hex');
    return {
      id,
      seed: `wallet:capacity-${index}-${uniqueSuffix}`,
      email: `${id}@example.test`,
      displayName: `Capacity reader ${index + 1}`,
    };
  });
}
