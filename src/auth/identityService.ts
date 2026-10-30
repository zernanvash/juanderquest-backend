import type { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { UserRow } from '../db/index.js';
import { hashPassword, verifyPassword } from './crypto.js';

export interface AuthIdentityRow {
  id: string;
  user_id: string;
  provider: 'email' | 'wallet' | 'google';
  provider_subject: string;
  created_at: string;
  updated_at: string;
}

export interface AccountEmailRow {
  id: string;
  user_id: string;
  email: string;
  normalized_email: string;
  is_verified: boolean;
  verified_at: string | null;
  is_primary: boolean;
  created_at: string;
  updated_at: string;
}

export class UnifiedIdentityService {
  private inMemoryIdentities: AuthIdentityRow[] = [];
  private inMemoryEmails: AccountEmailRow[] = [];
  private inMemoryPasswords = new Map<string, { hash: string; salt: string; algorithm: string }>();

  constructor(private pool: Pool | null) {}

  setPool(pool: Pool | null) {
    this.pool = pool;
  }

  normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  /**
   * Finds an existing auth identity by provider and subject.
   */
  async findIdentity(provider: 'email' | 'wallet' | 'google', subject: string): Promise<AuthIdentityRow | null> {
    const cleanSubject = provider === 'wallet' ? subject.toLowerCase().trim() : provider === 'email' ? this.normalizeEmail(subject) : subject.trim();
    if (this.pool) {
      const res = await this.pool.query(
        'SELECT * FROM auth_identities WHERE provider = $1 AND provider_subject = $2',
        [provider, cleanSubject]
      );
      return res.rows[0] ?? null;
    }
    const found = this.inMemoryIdentities.find(
      (i) => i.provider === provider && i.provider_subject === cleanSubject
    );
    return found ?? null;
  }

  /**
   * Links a provider to an existing user account.
   */
  async linkIdentity(userId: string, provider: 'email' | 'wallet' | 'google', subject: string): Promise<AuthIdentityRow> {
    const cleanSubject = provider === 'wallet' ? subject.toLowerCase().trim() : provider === 'email' ? this.normalizeEmail(subject) : subject.trim();
    const existing = await this.findIdentity(provider, cleanSubject);
    if (existing) {
      if (existing.user_id === userId) {
        return existing;
      }
      const err = new Error('IDENTITY_ALREADY_BOUND');
      (err as any).code = 'IDENTITY_ALREADY_BOUND';
      throw err;
    }

    const id = randomUUID();
    const now = new Date().toISOString();

    if (this.pool) {
      const res = await this.pool.query(
        `INSERT INTO auth_identities (id, user_id, provider, provider_subject, created_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())
         RETURNING *`,
        [id, userId, provider, cleanSubject]
      );
      return res.rows[0];
    }

    const row: AuthIdentityRow = {
      id,
      user_id: userId,
      provider,
      provider_subject: cleanSubject,
      created_at: now,
      updated_at: now,
    };
    this.inMemoryIdentities.push(row);
    return row;
  }

  /**
   * Links a Google OAuth identity to an existing email account.
   * If the email is unverified, any existing password credential is deleted in the same transaction
   * to prevent squatted password backdoor retainment (Plan 72 Phase 2).
   */
  async linkGoogleToAccount(userId: string, googleSubject: string, normalizedEmail: string, removePasswordIfUnverified: boolean): Promise<void> {
    const cleanEmail = this.normalizeEmail(normalizedEmail);
    const cleanSubject = googleSubject.trim();
    if (this.pool) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        if (removePasswordIfUnverified) {
          await client.query('DELETE FROM password_credentials WHERE user_id = $1', [userId]);
        }
        await client.query(
          `INSERT INTO auth_identities (id, user_id, provider, provider_subject, created_at, updated_at)
           VALUES ($1, $2, 'google', $3, NOW(), NOW())
           ON CONFLICT (provider, provider_subject) DO NOTHING`,
          [randomUUID(), userId, cleanSubject]
        );
        await client.query(
          `UPDATE account_emails 
           SET is_verified = TRUE, verified_at = NOW(), updated_at = NOW() 
           WHERE normalized_email = $1`,
          [cleanEmail]
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } else {
      if (removePasswordIfUnverified) {
        this.inMemoryPasswords.delete(userId);
      }
      await this.linkIdentity(userId, 'google', cleanSubject);
      await this.markEmailVerified(cleanEmail);
    }
  }

  /**
   * Sets or updates a password credential for a user.
   */
  async setPassword(userId: string, plainTextPassword: string): Promise<void> {
    const { hash, salt } = await hashPassword(plainTextPassword);
    if (this.pool) {
      await this.pool.query(
        `INSERT INTO password_credentials (id, user_id, password_hash, salt, algorithm, updated_at)
         VALUES ($1, $2, $3, $4, 'scrypt', NOW())
         ON CONFLICT (user_id) DO UPDATE
         SET password_hash = EXCLUDED.password_hash,
             salt = EXCLUDED.salt,
             updated_at = NOW()`,
        [randomUUID(), userId, hash, salt]
      );
    } else {
      this.inMemoryPasswords.set(userId, { hash, salt, algorithm: 'scrypt' });
    }
  }

  /**
   * Removes any password credential for a user.
   */
  async removePassword(userId: string): Promise<void> {
    if (this.pool) {
      await this.pool.query('DELETE FROM password_credentials WHERE user_id = $1', [userId]);
    } else {
      this.inMemoryPasswords.delete(userId);
    }
  }

  /**
   * Verifies password for a user.
   */
  async verifyUserPassword(userId: string, plainTextPassword: string): Promise<boolean> {
    if (this.pool) {
      const res = await this.pool.query(
        'SELECT password_hash, salt FROM password_credentials WHERE user_id = $1',
        [userId]
      );
      if (res.rowCount === 0) return false;
      const { password_hash, salt } = res.rows[0];
      return verifyPassword(plainTextPassword, salt, password_hash);
    }
    const cred = this.inMemoryPasswords.get(userId);
    if (!cred) return false;
    return verifyPassword(plainTextPassword, cred.salt, cred.hash);
  }

  /**
   * Registers or updates an account email record.
   */
  async recordAccountEmail(userId: string, rawEmail: string, isVerified = false): Promise<AccountEmailRow> {
    const normalized = this.normalizeEmail(rawEmail);
    const id = randomUUID();
    const now = new Date().toISOString();

    if (this.pool) {
      const res = await this.pool.query(
        `INSERT INTO account_emails (
          id, user_id, email, normalized_email, is_verified, verified_at, is_primary, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, TRUE, NOW(), NOW())
        ON CONFLICT (normalized_email) DO UPDATE
        SET is_verified = EXCLUDED.is_verified,
            verified_at = EXCLUDED.verified_at,
            updated_at = NOW()
        RETURNING *`,
        [id, userId, rawEmail.trim(), normalized, isVerified, isVerified ? now : null]
      );
      return res.rows[0];
    }

    let existing = this.inMemoryEmails.find((e) => e.normalized_email === normalized);
    if (existing) {
      existing.is_verified = isVerified;
      existing.verified_at = isVerified ? now : null;
      existing.updated_at = now;
      return existing;
    }

    const row: AccountEmailRow = {
      id,
      user_id: userId,
      email: rawEmail.trim(),
      normalized_email: normalized,
      is_verified: isVerified,
      verified_at: isVerified ? now : null,
      is_primary: true,
      created_at: now,
      updated_at: now,
    };
    this.inMemoryEmails.push(row);
    return row;
  }

  /**
   * Finds an account email.
   */
  async findAccountEmail(rawEmail: string): Promise<AccountEmailRow | null> {
    const normalized = this.normalizeEmail(rawEmail);
    if (this.pool) {
      const res = await this.pool.query(
        'SELECT * FROM account_emails WHERE normalized_email = $1',
        [normalized]
      );
      return res.rows[0] ?? null;
    }
    return this.inMemoryEmails.find((e) => e.normalized_email === normalized) ?? null;
  }

  /**
   * Marks an account email as verified.
   */
  async markEmailVerified(normalizedEmail: string): Promise<void> {
    const clean = this.normalizeEmail(normalizedEmail);
    if (this.pool) {
      await this.pool.query(
        `UPDATE account_emails 
         SET is_verified = TRUE, verified_at = NOW(), updated_at = NOW() 
         WHERE normalized_email = $1`,
        [clean]
      );
    } else {
      const found = this.inMemoryEmails.find((e) => e.normalized_email === clean);
      if (found) {
        found.is_verified = true;
        found.verified_at = new Date().toISOString();
      }
    }
  }

  /**
   * Lists all identities bound to a user.
   */
  async listUserIdentities(userId: string): Promise<AuthIdentityRow[]> {
    if (this.pool) {
      const res = await this.pool.query(
        'SELECT * FROM auth_identities WHERE user_id = $1 ORDER BY created_at ASC',
        [userId]
      );
      return res.rows;
    }
    return this.inMemoryIdentities.filter((i) => i.user_id === userId);
  }

  /** Placeholder addresses minted for wallet-only and guest accounts are not real, recoverable emails. */
  isPlaceholderEmail(email: string | null | undefined): boolean {
    return !email || /@(wallet\.juanderquest\.local|guest\.invalid)$/i.test(email.trim());
  }

  async hasPasswordCredential(userId: string): Promise<boolean> {
    if (this.pool) {
      const res = await this.pool.query('SELECT 1 FROM password_credentials WHERE user_id = $1', [userId]);
      return (res.rowCount ?? 0) > 0;
    }
    return this.inMemoryPasswords.has(userId);
  }

  /**
   * Plan 67: an account is complete when it has a real email and a way to sign in
   * without the wallet (a password, or a linked Google identity).
   */
  async hasCompletedCredentials(userId: string, email: string | null | undefined): Promise<boolean> {
    if (this.isPlaceholderEmail(email)) return false;
    if (await this.hasPasswordCredential(userId)) return true;
    return (await this.listUserIdentities(userId)).some((identity) => identity.provider === 'google');
  }

  /**
   * Updates user age eligibility and terms acceptance declaration.
   */
  async declareOnboardingPolicy(userId: string, termsVersion = '1.0.0'): Promise<void> {
    if (this.pool) {
      await this.pool.query(
        `UPDATE users 
         SET age_eligibility_declared = TRUE,
             age_declared_at = NOW(),
             terms_accepted_version = $1,
             terms_accepted_at = NOW(),
             updated_at = NOW()
         WHERE id = $2`,
        [termsVersion, userId]
      );
    }
  }
}
