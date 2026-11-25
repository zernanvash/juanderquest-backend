import type { Pool } from 'pg';
import { randomUUID } from 'crypto';
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
  private inMemoryEmailChangeAudit: Array<{
    id: string;
    user_id: string;
    old_email: string;
    new_email: string;
    wallet_address: string;
    google_unlinked: boolean;
    ip_address: string | null;
    created_at: string;
  }> = [];

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
    const cleanSubject =
      provider === 'wallet'
        ? subject.toLowerCase().trim()
        : provider === 'email'
          ? this.normalizeEmail(subject)
          : subject.trim();
    if (this.pool) {
      const res = await this.pool.query('SELECT * FROM auth_identities WHERE provider = $1 AND provider_subject = $2', [
        provider,
        cleanSubject,
      ]);
      return res.rows[0] ?? null;
    }
    const found = this.inMemoryIdentities.find((i) => i.provider === provider && i.provider_subject === cleanSubject);
    return found ?? null;
  }

  /**
   * Links a provider to an existing user account.
   */
  async linkIdentity(
    userId: string,
    provider: 'email' | 'wallet' | 'google',
    subject: string,
  ): Promise<AuthIdentityRow> {
    const cleanSubject =
      provider === 'wallet'
        ? subject.toLowerCase().trim()
        : provider === 'email'
          ? this.normalizeEmail(subject)
          : subject.trim();
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
        [id, userId, provider, cleanSubject],
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
  async linkGoogleToAccount(
    userId: string,
    googleSubject: string,
    normalizedEmail: string,
    removePasswordIfUnverified: boolean,
  ): Promise<void> {
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
          [randomUUID(), userId, cleanSubject],
        );
        await client.query(
          `UPDATE account_emails 
           SET is_verified = TRUE, verified_at = NOW(), updated_at = NOW() 
           WHERE normalized_email = $1`,
          [cleanEmail],
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
        [randomUUID(), userId, hash, salt],
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
      const res = await this.pool.query('SELECT password_hash, salt FROM password_credentials WHERE user_id = $1', [
        userId,
      ]);
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
        [id, userId, rawEmail.trim(), normalized, isVerified, isVerified ? now : null],
      );
      return res.rows[0];
    }

    const existing = this.inMemoryEmails.find((e) => e.normalized_email === normalized);
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
      const res = await this.pool.query('SELECT * FROM account_emails WHERE normalized_email = $1', [normalized]);
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
        [clean],
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
      const res = await this.pool.query('SELECT * FROM auth_identities WHERE user_id = $1 ORDER BY created_at ASC', [
        userId,
      ]);
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

  async hasGoogleIdentity(userId: string): Promise<boolean> {
    if (this.pool) {
      const res = await this.pool.query(`SELECT 1 FROM auth_identities WHERE user_id = $1 AND provider = 'google'`, [
        userId,
      ]);
      return (res.rowCount ?? 0) > 0;
    }
    return this.inMemoryIdentities.some((i) => i.user_id === userId && i.provider === 'google');
  }

  async hasVerifiedPrimaryEmail(userId: string, fallbackEmail?: string | null): Promise<boolean> {
    if (this.pool) {
      const res = await this.pool.query<{ is_primary: boolean; is_verified: boolean }>(
        `SELECT is_primary, is_verified FROM account_emails WHERE user_id = $1`,
        [userId],
      );
      if (res.rows.length > 0) {
        return res.rows.some((r) => r.is_primary && r.is_verified);
      }
      return Boolean(fallbackEmail && !this.isPlaceholderEmail(fallbackEmail));
    }
    const rows = this.inMemoryEmails.filter((e) => e.user_id === userId);
    if (rows.length > 0) {
      return rows.some((e) => e.is_primary && e.is_verified);
    }
    return Boolean(fallbackEmail && !this.isPlaceholderEmail(fallbackEmail));
  }

  async isEmailClaimedByAnotherUser(userId: string, rawEmail: string): Promise<boolean> {
    const normalized = this.normalizeEmail(rawEmail);
    if (this.pool) {
      const uRes = await this.pool.query(`SELECT 1 FROM users WHERE LOWER(email) = $1 AND id <> $2 LIMIT 1`, [
        normalized,
        userId,
      ]);
      if ((uRes.rowCount ?? 0) > 0) return true;

      const eRes = await this.pool.query(
        `SELECT 1 FROM account_emails WHERE normalized_email = $1 AND user_id <> $2 LIMIT 1`,
        [normalized, userId],
      );
      if ((eRes.rowCount ?? 0) > 0) return true;

      const iRes = await this.pool.query(
        `SELECT 1 FROM auth_identities WHERE provider = 'email' AND provider_subject = $1 AND user_id <> $2 LIMIT 1`,
        [normalized, userId],
      );
      return (iRes.rowCount ?? 0) > 0;
    }

    if (this.inMemoryEmails.some((e) => e.normalized_email === normalized && e.user_id !== userId)) return true;
    if (
      this.inMemoryIdentities.some(
        (i) => i.provider === 'email' && i.provider_subject === normalized && i.user_id !== userId,
      )
    ) {
      return true;
    }
    return false;
  }

  async getLastEmailChangeAt(userId: string): Promise<Date | null> {
    if (this.pool) {
      const res = await this.pool.query<{ created_at: Date | string }>(
        `SELECT created_at FROM auth_email_change_audit WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [userId],
      );
      if (res.rowCount === 0) return null;
      return new Date(res.rows[0].created_at);
    }
    const rows = this.inMemoryEmailChangeAudit
      .filter((r) => r.user_id === userId)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    return rows.length ? new Date(rows[0].created_at) : null;
  }

  async migrateEmailTransaction(params: {
    userId: string;
    newEmail: string;
    walletAddress: string;
    ipAddress?: string | null;
  }): Promise<{ oldEmail: string; newEmail: string; googleUnlinked: boolean }> {
    const normalizedNewEmail = this.normalizeEmail(params.newEmail);
    const cleanNewEmail = params.newEmail.trim();

    if (this.pool) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');

        const userRes = await client.query<{
          id: string;
          email: string | null;
          wallet_address: string | null;
          session_epoch: number;
        }>(`SELECT id, email, wallet_address, session_epoch FROM users WHERE id = $1 FOR UPDATE`, [params.userId]);

        if (userRes.rowCount === 0) {
          const err = new Error('USER_NOT_FOUND');
          (err as any).code = 'USER_NOT_FOUND';
          throw err;
        }

        const userRow = userRes.rows[0];
        if (
          !userRow.wallet_address ||
          userRow.wallet_address.trim().toLowerCase() !== params.walletAddress.trim().toLowerCase()
        ) {
          const err = new Error('WALLET_REQUIRED_FOR_EMAIL_CHANGE');
          (err as any).code = 'WALLET_REQUIRED_FOR_EMAIL_CHANGE';
          throw err;
        }

        const conflictUser = await client.query(`SELECT 1 FROM users WHERE LOWER(email) = $1 AND id <> $2 LIMIT 1`, [
          normalizedNewEmail,
          params.userId,
        ]);
        const conflictEmail = await client.query(
          `SELECT 1 FROM account_emails WHERE normalized_email = $1 AND user_id <> $2 LIMIT 1`,
          [normalizedNewEmail, params.userId],
        );
        const conflictIdentity = await client.query(
          `SELECT 1 FROM auth_identities WHERE provider = 'email' AND provider_subject = $1 AND user_id <> $2 LIMIT 1`,
          [normalizedNewEmail, params.userId],
        );
        if (
          (conflictUser.rowCount ?? 0) > 0 ||
          (conflictEmail.rowCount ?? 0) > 0 ||
          (conflictIdentity.rowCount ?? 0) > 0
        ) {
          const err = new Error('EMAIL_ALREADY_IN_USE');
          (err as any).code = 'EMAIL_ALREADY_IN_USE';
          throw err;
        }

        const oldEmail = (userRow.email ?? '').trim();

        await client.query(`UPDATE users SET email = $1, updated_at = NOW() WHERE id = $2`, [
          normalizedNewEmail,
          params.userId,
        ]);

        await client.query(`DELETE FROM account_emails WHERE user_id = $1`, [params.userId]);
        await client.query(
          `INSERT INTO account_emails (
             id, user_id, email, normalized_email, is_verified, verified_at, is_primary, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, TRUE, NOW(), TRUE, NOW(), NOW())`,
          [randomUUID(), params.userId, cleanNewEmail, normalizedNewEmail],
        );

        await client.query(`DELETE FROM auth_identities WHERE user_id = $1 AND provider = 'email'`, [params.userId]);
        await client.query(
          `INSERT INTO auth_identities (id, user_id, provider, provider_subject, created_at, updated_at)
           VALUES ($1, $2, 'email', $3, NOW(), NOW())`,
          [randomUUID(), params.userId, normalizedNewEmail],
        );

        const googleDel = await client.query(`DELETE FROM auth_identities WHERE user_id = $1 AND provider = 'google'`, [
          params.userId,
        ]);
        const googleUnlinked = (googleDel.rowCount ?? 0) > 0;

        await client.query(
          `INSERT INTO auth_email_change_audit (
             id, user_id, old_email, new_email, wallet_address, google_unlinked, ip_address, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
          [
            randomUUID(),
            params.userId,
            oldEmail,
            normalizedNewEmail,
            userRow.wallet_address,
            googleUnlinked,
            params.ipAddress ?? null,
          ],
        );

        await client.query('COMMIT');
        return { oldEmail, newEmail: normalizedNewEmail, googleUnlinked };
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }

    // In-memory fallback
    if (await this.isEmailClaimedByAnotherUser(params.userId, normalizedNewEmail)) {
      const err = new Error('EMAIL_ALREADY_IN_USE');
      (err as any).code = 'EMAIL_ALREADY_IN_USE';
      throw err;
    }

    const prevPrimary = this.inMemoryEmails.find((e) => e.user_id === params.userId && e.is_primary);
    const oldEmail = prevPrimary?.email ?? '';
    this.inMemoryEmails = this.inMemoryEmails.filter((e) => e.user_id !== params.userId);
    const now = new Date().toISOString();
    this.inMemoryEmails.push({
      id: randomUUID(),
      user_id: params.userId,
      email: cleanNewEmail,
      normalized_email: normalizedNewEmail,
      is_verified: true,
      verified_at: now,
      is_primary: true,
      created_at: now,
      updated_at: now,
    });

    const hadGoogle = this.inMemoryIdentities.some((i) => i.user_id === params.userId && i.provider === 'google');
    this.inMemoryIdentities = this.inMemoryIdentities.filter(
      (i) => !(i.user_id === params.userId && (i.provider === 'email' || i.provider === 'google')),
    );
    this.inMemoryIdentities.push({
      id: randomUUID(),
      user_id: params.userId,
      provider: 'email',
      provider_subject: normalizedNewEmail,
      created_at: now,
      updated_at: now,
    });
    this.inMemoryEmailChangeAudit.push({
      id: randomUUID(),
      user_id: params.userId,
      old_email: oldEmail,
      new_email: normalizedNewEmail,
      wallet_address: params.walletAddress,
      google_unlinked: hadGoogle,
      ip_address: params.ipAddress ?? null,
      created_at: now,
    });

    return { oldEmail, newEmail: normalizedNewEmail, googleUnlinked: hadGoogle };
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
        [termsVersion, userId],
      );
    }
  }
}
