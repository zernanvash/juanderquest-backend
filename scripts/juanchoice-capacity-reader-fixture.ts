import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import type { DisposableWalletReaderIdentity } from './juanchoice-capacity-reader-identities.js';

export interface SqlQueryable {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

export interface SeededWalletReaderFixture {
  readonly tokens: readonly string[];
}

/**
 * Seeds disposable wallet reader identities into a caller-supplied disposable database pool
 * and signs authentication tokens using a caller-supplied test JWT secret.
 *
 * Requirements:
 * - Explicit disposable query interface only (no global pool or production connection).
 * - Exact 1:1 mapping for input records from buildDisposableWalletReaderIdentities.
 * - Inserts users with matching id, seed_id, display_name, email, is_test=false, and a benign creation timestamp.
 * - Signs tokens with payload { id, seed_id, role: 'user' } using testJwtSecret.
 * - Token ordering strictly matches input ordering.
 * - Propagates database query and signing errors without exposing tokens or identities in errors.
 * - Free of logging, process.env mutation, and HTTP calls.
 */
export async function seedDisposableWalletReaderFixture(
  pool: SqlQueryable,
  identities: readonly DisposableWalletReaderIdentity[],
  testJwtSecret: string
): Promise<SeededWalletReaderFixture> {
  assert(pool && typeof pool.query === 'function', 'A valid disposable query interface must be provided');
  assert(Array.isArray(identities), 'identities must be an array');
  assert(
    identities.length >= 1 && identities.length <= 100,
    'identities must contain between 1 and 100 records'
  );
  assert(
    typeof testJwtSecret === 'string' && testJwtSecret.trim().length > 0,
    'testJwtSecret must be a non-empty string'
  );

  const createdAt = new Date(Date.now() - 4 * 86_400_000);
  const insertQuery = `
    INSERT INTO users (id, seed_id, display_name, email, created_at, is_test)
    VALUES ($1, $2, $3, $4, $5, false)
  `.trim();

  const tokens: string[] = [];

  for (let i = 0; i < identities.length; i++) {
    const identity = identities[i];
    assert(identity && typeof identity === 'object', 'Each identity must be a valid object');
    assert(typeof identity.id === 'string' && identity.id.length > 0, 'identity.id must be a non-empty string');
    assert(typeof identity.seed === 'string' && identity.seed.length > 0, 'identity.seed must be a non-empty string');
    assert(typeof identity.displayName === 'string' && identity.displayName.length > 0, 'identity.displayName must be a non-empty string');
    assert(typeof identity.email === 'string' && identity.email.length > 0, 'identity.email must be a non-empty string');

    try {
      await pool.query(insertQuery, [
        identity.id,
        identity.seed,
        identity.displayName,
        identity.email,
        createdAt,
      ]);
    } catch (_err: unknown) {
      throw new Error(`Failed to insert disposable wallet reader at index ${i}`);
    }

    try {
      const token = jwt.sign(
        {
          id: identity.id,
          seed_id: identity.seed,
          role: 'user',
        },
        testJwtSecret
      );
      tokens.push(token);
    } catch (_err: unknown) {
      throw new Error(`Failed to sign token for disposable wallet reader at index ${i}`);
    }
  }

  return {
    tokens: Object.freeze(tokens),
  };
}
