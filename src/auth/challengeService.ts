import type { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { env } from '../config/env.js';
import { hashChallengeCode, verifyChallengeCode, generateNumericOtp } from './crypto.js';

export interface AuthChallengeRow {
  id: string;
  purpose: string;
  target_identifier: string;
  bound_user_id: string | null;
  code_hash: string;
  expires_at: string;
  attempt_count: number;
  max_attempts: number;
  consumed_at: string | null;
  metadata: any;
  created_at: string;
}

export interface CreateChallengeResult {
  challengeId: string;
  code: string;
  expiresAt: Date;
}

export class AuthChallengeService {
  private inMemoryChallenges = new Map<string, {
    id: string;
    purpose: string;
    target: string;
    boundUserId: string | null;
    codeHash: string;
    expiresAt: number;
    attemptCount: number;
    maxAttempts: number;
    consumedAt: number | null;
    metadata: any;
  }>();

  constructor(private pool: Pool | null) {}

  setPool(pool: Pool | null) {
    this.pool = pool;
  }

  /**
   * Creates a single-use purpose-bound challenge (e.g. signup OTP, password reset OTP, wallet challenge).
   */
  async createChallenge(params: {
    purpose: 'signup_verify' | 'password_reset' | 'password_reset_grant' | 'email_change' | 'wallet_login' | 'wallet_bind';
    targetIdentifier: string;
    boundUserId?: string | null;
    ttlSeconds?: number;
    maxAttempts?: number;
    metadata?: any;
    customCode?: string;
  }): Promise<CreateChallengeResult> {
    const ttlSeconds = params.ttlSeconds ?? 600; // 10 minutes default
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const challengeId = randomUUID();
    const code = params.customCode ?? generateNumericOtp();
    const codeHash = hashChallengeCode(code, env.JWT_SECRET);
    const target = params.targetIdentifier.toLowerCase().trim();

    if (this.pool) {
      // Invalidate any active, unconsumed challenges for this same target and purpose
      await this.pool.query(
        `UPDATE auth_challenges 
         SET consumed_at = NOW() 
         WHERE purpose = $1 AND target_identifier = $2 AND consumed_at IS NULL`,
        [params.purpose, target]
      );

      await this.pool.query(
        `INSERT INTO auth_challenges (
          id, purpose, target_identifier, bound_user_id, code_hash,
          expires_at, attempt_count, max_attempts, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8)`,
        [
          challengeId,
          params.purpose,
          target,
          params.boundUserId ?? null,
          codeHash,
          expiresAt.toISOString(),
          params.maxAttempts ?? 5,
          params.metadata ? JSON.stringify(params.metadata) : null,
        ]
      );
    } else {
      // Fallback in-memory
      for (const [key, c] of this.inMemoryChallenges.entries()) {
        if (c.purpose === params.purpose && c.target === target && !c.consumedAt) {
          c.consumedAt = Date.now();
        }
      }
      this.inMemoryChallenges.set(challengeId, {
        id: challengeId,
        purpose: params.purpose,
        target,
        boundUserId: params.boundUserId ?? null,
        codeHash,
        expiresAt: expiresAt.getTime(),
        attemptCount: 0,
        maxAttempts: params.maxAttempts ?? 5,
        consumedAt: null,
        metadata: params.metadata ?? null,
      });
    }

    return { challengeId, code, expiresAt };
  }

  /**
   * Durably verifies and atomically consumes a challenge code.
   */
  async consumeChallenge(params: {
    purpose: string;
    targetIdentifier: string;
    code: string;
    boundUserId?: string | null;
  }): Promise<{ valid: boolean; error?: string; metadata?: any; boundUserId?: string | null }> {
    const target = params.targetIdentifier.toLowerCase().trim();

    if (this.pool) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');

        // Lock the latest active challenge for this purpose and target
        const res = await client.query(
          `SELECT * FROM auth_challenges 
           WHERE purpose = $1 AND target_identifier = $2 AND consumed_at IS NULL 
           ORDER BY created_at DESC 
           LIMIT 1 FOR UPDATE`,
          [params.purpose, target]
        );

        if (res.rowCount === 0) {
          await client.query('ROLLBACK');
          return { valid: false, error: 'CHALLENGE_NOT_FOUND' };
        }

        const row = res.rows[0];

        // Check expiration
        if (new Date(row.expires_at).getTime() <= Date.now()) {
          await client.query(`UPDATE auth_challenges SET consumed_at = NOW() WHERE id = $1`, [row.id]);
          await client.query('COMMIT');
          return { valid: false, error: 'CHALLENGE_EXPIRED' };
        }

        // Check max attempts
        if (row.attempt_count >= row.max_attempts) {
          await client.query(`UPDATE auth_challenges SET consumed_at = NOW() WHERE id = $1`, [row.id]);
          await client.query('COMMIT');
          return { valid: false, error: 'MAX_ATTEMPTS_EXCEEDED' };
        }

        // Check user binding if applicable
        if (params.boundUserId && row.bound_user_id && row.bound_user_id !== params.boundUserId) {
          await client.query('ROLLBACK');
          return { valid: false, error: 'USER_MISMATCH' };
        }

        // Verify code
        const isMatch = verifyChallengeCode(params.code, row.code_hash, env.JWT_SECRET);
        if (!isMatch) {
          await client.query(
            `UPDATE auth_challenges SET attempt_count = attempt_count + 1 WHERE id = $1`,
            [row.id]
          );
          await client.query('COMMIT');
          return { valid: false, error: 'INVALID_CODE' };
        }

        // Atomically consume
        await client.query(
          `UPDATE auth_challenges SET consumed_at = NOW(), attempt_count = attempt_count + 1 WHERE id = $1`,
          [row.id]
        );
        await client.query('COMMIT');

        return {
          valid: true,
          metadata: row.metadata,
          boundUserId: row.bound_user_id,
        };
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } else {
      // In-memory fallback
      let candidate: any = null;
      for (const c of this.inMemoryChallenges.values()) {
        if (c.purpose === params.purpose && c.target === target && !c.consumedAt) {
          candidate = c;
          break;
        }
      }

      if (!candidate) {
        return { valid: false, error: 'CHALLENGE_NOT_FOUND' };
      }

      if (candidate.expiresAt <= Date.now()) {
        candidate.consumedAt = Date.now();
        return { valid: false, error: 'CHALLENGE_EXPIRED' };
      }

      if (candidate.attemptCount >= candidate.maxAttempts) {
        candidate.consumedAt = Date.now();
        return { valid: false, error: 'MAX_ATTEMPTS_EXCEEDED' };
      }

      if (params.boundUserId && candidate.boundUserId && candidate.boundUserId !== params.boundUserId) {
        return { valid: false, error: 'USER_MISMATCH' };
      }

      const isMatch = verifyChallengeCode(params.code, candidate.codeHash, env.JWT_SECRET);
      candidate.attemptCount++;

      if (!isMatch) {
        return { valid: false, error: 'INVALID_CODE' };
      }

      candidate.consumedAt = Date.now();
      return {
        valid: true,
        metadata: candidate.metadata,
        boundUserId: candidate.boundUserId,
      };
    }
  }
}
