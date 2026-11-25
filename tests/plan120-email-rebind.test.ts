import { randomUUID } from 'crypto';
import { Wallet } from 'ethers';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import { db } from '../src/db/index.js';
import { MIGRATIONS } from '../src/db/migrations.js';
import { setPool } from '../src/db/pool.js';
import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';
import { invalidateSessionScopeCache } from '../src/middleware/auth.js';
import { resetRateLimits } from '../src/middleware/rateLimit.js';

const realPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;
jest.setTimeout(180_000);

realPg('Plan 120: Wallet-Gated Email Rebind / Migration (real PostgreSQL)', () => {
  let fixture: TestDbInstance;
  const suffix = randomUUID().slice(0, 8);

  const noWalletId = `p120-nowallet-${suffix}`;
  const boundWalletUserId = `p120-bound-${suffix}`;
  const otherUserId = `p120-other-${suffix}`;
  const walletOnlyUnbindId = `p120-wonly-${suffix}`;
  const googleOnlyUnbindId = `p120-gonly-${suffix}`;
  const unverifiedUnbindId = `p120-unver-${suffix}`;

  const boundWallet = Wallet.createRandom();
  const wrongWallet = Wallet.createRandom();
  const googleOnlyWallet = Wallet.createRandom();
  const walletOnlyWallet = Wallet.createRandom();
  const unverifiedWallet = Wallet.createRandom();

  const token = (id: string, sep = 0) =>
    jwt.sign({ id, seed_id: id, role: 'user', typ: 'session', sep }, env.JWT_SECRET, { expiresIn: '1h' });
  const as = (id: string, sep = 0) => ({ Authorization: `Bearer ${token(id, sep)}` });

  beforeAll(async () => {
    fixture = await createTestDb({ poolMax: 10 });
    setPool(fixture.pool);
    db.attachDurabilityPool(fixture.pool);
    invalidateSessionScopeCache();
    resetRateLimits();

    await fixture.pool.query(
      `INSERT INTO users (
         id, seed_id, display_name, email, handle, role, is_public, is_test, wallet_address, session_epoch
       ) VALUES
         ($1::text, $1::text, 'No Wallet User', $7::text, 'nowallet_' || $13::text, 'user', TRUE, FALSE, NULL, 0),
         ($2::text, $2::text, 'Bound Wallet User', $8::text, 'bound_' || $13::text, 'user', TRUE, FALSE, NULL, 0),
         ($3::text, $3::text, 'Other User', $9::text, 'other_' || $13::text, 'user', TRUE, FALSE, NULL, 0),
         ($4::text, $4::text, 'Wallet Only Unbind', $10::text, 'wonly_' || $13::text, 'user', TRUE, FALSE, $14::text, 0),
         ($5::text, $5::text, 'Google Only Unbind', $11::text, 'gonly_' || $13::text, 'user', TRUE, FALSE, $15::text, 0),
         ($6::text, $6::text, 'Unverified Unbind', $12::text, 'unver_' || $13::text, 'user', TRUE, FALSE, $16::text, 0)`,
      [
        noWalletId,
        boundWalletUserId,
        otherUserId,
        walletOnlyUnbindId,
        googleOnlyUnbindId,
        unverifiedUnbindId,
        `nowallet-${suffix}@example.test`,
        `old-bound-${suffix}@example.test`,
        `taken-${suffix}@example.test`,
        `wonly-${suffix}@example.test`,
        `gonly-${suffix}@example.test`,
        `unver-${suffix}@example.test`,
        suffix,
        walletOnlyWallet.address,
        googleOnlyWallet.address,
        unverifiedWallet.address,
      ],
    );

    // boundWalletUserId: verified email + password + google identity (NO auth_identities 'wallet' row)
    await db.identityService.linkIdentity(boundWalletUserId, 'email', `old-bound-${suffix}@example.test`);
    await db.identityService.linkIdentity(boundWalletUserId, 'google', `google-sub-${suffix}`);
    await db.identityService.recordAccountEmail(boundWalletUserId, `old-bound-${suffix}@example.test`, true);
    await db.identityService.setPassword(boundWalletUserId, 'SecretPass123!');

    // otherUserId: owns taken email
    await db.identityService.linkIdentity(otherUserId, 'email', `taken-${suffix}@example.test`);
    await db.identityService.recordAccountEmail(otherUserId, `taken-${suffix}@example.test`, true);

    // walletOnlyUnbindId: verified email, NO password, NO google
    await db.identityService.recordAccountEmail(walletOnlyUnbindId, `wonly-${suffix}@example.test`, true);

    // googleOnlyUnbindId: verified email + google identity, NO password
    await db.identityService.linkIdentity(googleOnlyUnbindId, 'google', `google-only-sub-${suffix}`);
    await db.identityService.recordAccountEmail(googleOnlyUnbindId, `gonly-${suffix}@example.test`, true);

    // unverifiedUnbindId: unverified email + password
    await db.identityService.recordAccountEmail(unverifiedUnbindId, `unver-${suffix}@example.test`, false);
    await db.identityService.setPassword(unverifiedUnbindId, 'SecretPass123!');
  });

  afterAll(async () => {
    if (fixture) await fixture.close();
  });

  it('registers migration 116 right after 115 and creates auth_email_change_audit', async () => {
    const idx115 = MIGRATIONS.indexOf('115_people_suggestion_dismissals.sql');
    const idx116 = MIGRATIONS.indexOf('116_email_change_audit.sql');
    expect(idx115).toBeGreaterThan(-1);
    expect(idx116).toBe(idx115 + 1);

    const tbl = await fixture.pool.query(`SELECT to_regclass('auth_email_change_audit') AS tbl`);
    expect(tbl.rows[0].tbl).toBe('auth_email_change_audit');
  });

  it('blocks users without users.wallet_address from eligibility, request, and confirm', async () => {
    const elig = await request(app).get('/api/v1/auth/email/change/eligibility').set(as(noWalletId));
    expect(elig.status).toBe(200);
    expect(elig.body.data.eligible).toBe(false);
    expect(elig.body.data.reason).toBe('WALLET_REQUIRED_FOR_EMAIL_CHANGE');

    const reqRes = await request(app)
      .post('/api/v1/auth/email/change/request')
      .set(as(noWalletId))
      .send({ new_email: `new-nw-${suffix}@example.test` });
    expect(reqRes.status).toBe(403);
    expect(reqRes.body.error.code).toBe('WALLET_REQUIRED_FOR_EMAIL_CHANGE');

    const confRes = await request(app)
      .post('/api/v1/auth/email/change/confirm')
      .set(as(noWalletId))
      .send({ challenge_id: 'any', otp_code: '123456', wallet_signature: '0xsig' });
    expect(confRes.status).toBe(403);
    expect(confRes.body.error.code).toBe('WALLET_REQUIRED_FOR_EMAIL_CHANGE');
  });

  it('allows wallet-bound user (no auth_identities wallet row) to migrate email atomically, unlinks Google, rotates session, and enforces cooldown', async () => {
    // Bind wallet via /auth/wallet/bind (does NOT insert auth_identities 'wallet' row)
    const bindRes = await request(app)
      .post('/api/v1/auth/wallet/bind')
      .set(as(boundWalletUserId))
      .send({ address: boundWallet.address, signature: 'test-sig' });
    expect(bindRes.status).toBe(200);

    const elig = await request(app).get('/api/v1/auth/email/change/eligibility').set(as(boundWalletUserId));
    expect(elig.status).toBe(200);
    expect(elig.body.data.eligible).toBe(true);
    expect(elig.body.data.has_google_linked).toBe(true);
    expect(elig.body.data.has_password).toBe(true);

    // Rejects unchanged email (400) and already-in-use email (409)
    const unchanged = await request(app)
      .post('/api/v1/auth/email/change/request')
      .set(as(boundWalletUserId))
      .send({ new_email: `old-bound-${suffix}@example.test` });
    expect(unchanged.status).toBe(400);
    expect(unchanged.body.error.code).toBe('EMAIL_UNCHANGED');

    const duplicate = await request(app)
      .post('/api/v1/auth/email/change/request')
      .set(as(boundWalletUserId))
      .send({ new_email: `taken-${suffix}@example.test` });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('EMAIL_ALREADY_IN_USE');

    // Check mailerService.checkSendAllowance is called and capture OTP from queueAuthEmail
    const allowanceSpy = jest.spyOn(db.mailerService, 'checkSendAllowance');
    let capturedOtp = '';
    const origQueue = db.mailerService.queueAuthEmail.bind(db.mailerService);
    const queueSpy = jest.spyOn(db.mailerService, 'queueAuthEmail').mockImplementation(async (job) => {
      if (job.templateType === 'email_change_otp' && job.code) capturedOtp = job.code;
      return origQueue(job);
    });
    const newEmail = `new-bound-${suffix}@example.test`;
    const reqRes = await request(app)
      .post('/api/v1/auth/email/change/request')
      .set(as(boundWalletUserId))
      .send({ new_email: newEmail });
    expect(reqRes.status).toBe(200);
    expect(allowanceSpy).toHaveBeenCalledWith(newEmail);
    allowanceSpy.mockRestore();
    queueSpy.mockRestore();

    const { challenge_id, siwe_message } = reqRes.body.data;
    expect(challenge_id).toBeTruthy();
    expect(siwe_message).toContain(boundWallet.address);
    expect(siwe_message).toContain(newEmail);
    expect(capturedOtp).toMatch(/^\d{6}$/);

    // Verify exact siwe_message stored in auth_challenges.metadata and email_change_otp queued
    const chalRow = await fixture.pool.query(`SELECT metadata FROM auth_challenges WHERE id = $1`, [challenge_id]);
    expect(chalRow.rows[0].metadata.siwe_message).toBe(siwe_message);

    const outboxOtp = await fixture.pool.query(
      `SELECT recipient_email, template_type, status FROM auth_mail_outbox WHERE recipient_email = $1 ORDER BY created_at DESC LIMIT 1`,
      [newEmail],
    );
    expect(outboxOtp.rows[0].template_type).toBe('email_change_otp');
    const otpCode = capturedOtp;

    // Wrong wallet signature -> 401 INVALID_WALLET_SIGNATURE without mutating DB
    const badSig = await wrongWallet.signMessage(siwe_message);
    const badSigRes = await request(app)
      .post('/api/v1/auth/email/change/confirm')
      .set(as(boundWalletUserId))
      .send({ challenge_id, otp_code: otpCode, wallet_signature: badSig });
    expect(badSigRes.status).toBe(401);
    expect(badSigRes.body.error.code).toBe('INVALID_WALLET_SIGNATURE');

    // Wrong OTP -> 400 without mutating DB
    const validSig = await boundWallet.signMessage(siwe_message);
    const badOtpRes = await request(app)
      .post('/api/v1/auth/email/change/confirm')
      .set(as(boundWalletUserId))
      .send({ challenge_id, otp_code: '000000', wallet_signature: validSig });
    expect(badOtpRes.status).toBe(400);

    // Valid confirm -> updates users, account_emails, auth_identities, unlinks Google, writes audit, bumps epoch
    const confirmRes = await request(app)
      .post('/api/v1/auth/email/change/confirm')
      .set(as(boundWalletUserId))
      .send({ challenge_id, otp_code: otpCode, wallet_signature: validSig });
    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.data.google_unlinked).toBe(true);
    expect(confirmRes.body.data.user.email).toBe(newEmail);
    const freshToken = confirmRes.body.data.token as string;
    expect(freshToken).toBeTruthy();

    // Old token rejected (401), fresh token accepted (200)
    const oldTokenCheck = await request(app).get('/api/v1/auth/email/change/eligibility').set(as(boundWalletUserId, 0));
    expect(oldTokenCheck.status).toBe(401);
    const freshTokenCheck = await request(app)
      .get('/api/v1/auth/email/change/eligibility')
      .set('Authorization', `Bearer ${freshToken}`);
    expect(freshTokenCheck.status).toBe(200);
    expect(freshTokenCheck.body.data.eligible).toBe(false);
    expect(freshTokenCheck.body.data.reason).toBe('EMAIL_CHANGE_COOLDOWN');
    expect(freshTokenCheck.body.data.has_google_linked).toBe(false);

    // Audit row & old-email alert queued
    const auditRes = await fixture.pool.query(
      `SELECT old_email, new_email, google_unlinked FROM auth_email_change_audit WHERE user_id = $1`,
      [boundWalletUserId],
    );
    expect(auditRes.rows[0]).toEqual({
      old_email: `old-bound-${suffix}@example.test`,
      new_email: newEmail,
      google_unlinked: true,
    });

    const alertOutbox = await fixture.pool.query(
      `SELECT template_type FROM auth_mail_outbox WHERE recipient_email = $1 ORDER BY created_at DESC LIMIT 1`,
      [`old-bound-${suffix}@example.test`],
    );
    expect(alertOutbox.rows[0].template_type).toBe('email_changed_alert');

    // Old email login fails, new email login succeeds
    const oldLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: `old-bound-${suffix}@example.test`, password: 'SecretPass123!' });
    expect(oldLogin.status).toBe(401);

    const newLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: newEmail, password: 'SecretPass123!' });
    expect(newLogin.status).toBe(200);

    // Second migration within 24h -> 429 EMAIL_CHANGE_COOLDOWN
    const cooldownReq = await request(app)
      .post('/api/v1/auth/email/change/request')
      .set('Authorization', `Bearer ${freshToken}`)
      .send({ new_email: `another-${suffix}@example.test` });
    expect(cooldownReq.status).toBe(429);
    expect(cooldownReq.body.error.code).toBe('EMAIL_CHANGE_COOLDOWN');
  });

  it('enforces wallet unbind guard: requires verified email + (password OR google)', async () => {
    // Wallet-only (no password, no google) -> 409
    const r1 = await request(app).delete('/api/v1/auth/wallet/unbind').set(as(walletOnlyUnbindId));
    expect(r1.status).toBe(409);
    expect(r1.body.error.code).toBe('OTHER_SIGNIN_REQUIRED_BEFORE_WALLET_UNBIND');

    // Unverified email + password -> 409
    const r2 = await request(app).delete('/api/v1/auth/wallet/unbind').set(as(unverifiedUnbindId));
    expect(r2.status).toBe(409);
    expect(r2.body.error.code).toBe('OTHER_SIGNIN_REQUIRED_BEFORE_WALLET_UNBIND');

    // Verified email + Google-only (no password) -> 200
    const r3 = await request(app).delete('/api/v1/auth/wallet/unbind').set(as(googleOnlyUnbindId));
    expect(r3.status).toBe(200);

    // Verified email + password (boundWalletUserId after migration) -> 200
    const uRow = await fixture.pool.query<{ session_epoch: number }>(`SELECT session_epoch FROM users WHERE id = $1`, [
      boundWalletUserId,
    ]);
    const r4 = await request(app)
      .delete('/api/v1/auth/wallet/unbind')
      .set(as(boundWalletUserId, uRow.rows[0].session_epoch));
    expect(r4.status).toBe(200);
  });
});
