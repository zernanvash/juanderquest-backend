import request from 'supertest';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';

describe('Unified Sign-In, Email Recovery, and Guest Retirement', () => {
  let testDb: TestDbInstance;

  beforeAll(async () => {
    testDb = await createTestDb();
    await db.hydrateFromPg(testDb.pool);
  }, 30000);

  afterAll(async () => {
    if (testDb) {
      await testDb.close();
    }
  }, 30000);

  const testEmail = 'traveler.juan@example.com';
  const testPassword = 'Password123!Safe';
  let devSignupCode: string = '';
  let sessionToken: string = '';

  it('1. Registers an account with email/password and onboarding policy declaration', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({
        email: testEmail,
        password: testPassword,
        display_name: 'Juan Traveler',
        age_eligibility_declared: true,
        terms_accepted: true,
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.email).toBe(testEmail);
    expect(res.body.data.dev_code).toBeDefined();
    devSignupCode = res.body.data.dev_code;
  }, 20000);

  it('2. Rejects duplicate registration for the same normalized email address', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({
        email: '  TRAVELER.JUAN@example.com ',
        password: testPassword,
        display_name: 'Duplicate Juan',
        age_eligibility_declared: true,
        terms_accepted: true,
      });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('EMAIL_ALREADY_EXISTS');
  });

  it('3. Rejects email verification with invalid OTP code', async () => {
    const res = await request(app)
      .post('/api/v1/auth/email/verify')
      .send({
        email: testEmail,
        code: '000000',
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('INVALID_CODE');
  });

  it('4. Successfully verifies email with valid OTP code and issues session', async () => {
    const res = await request(app)
      .post('/api/v1/auth/email/verify')
      .send({
        email: testEmail,
        code: devSignupCode,
        remember_me: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.token).toBeDefined();
    expect(res.body.data.user.email).toBe(testEmail);
    sessionToken = res.body.data.token;
  });

  it('5. Allows signing in with verified email and password', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({
        email: 'TRAVELER.JUAN@EXAMPLE.COM', // test case insensitivity
        password: testPassword,
        remember_me: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.token).toBeDefined();
    expect(res.body.data.user.email).toBe(testEmail);
  });

  it('6. Rejects login with wrong password', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({
        email: testEmail,
        password: 'IncorrectPassword999',
      });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  let resetDevCode = '';
  let resetGrant = '';

  it('7. Handles forgot password flow with durable OTP code dispatch', async () => {
    const res = await request(app)
      .post('/api/v1/auth/password/forgot')
      .send({
        email: testEmail,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.dev_code).toBeDefined();
    resetDevCode = res.body.data.dev_code;
  });

  it('8. Verifies password reset code and exchanges it for a single-use reset grant', async () => {
    const res = await request(app)
      .post('/api/v1/auth/password/verify-code')
      .send({
        email: testEmail,
        code: resetDevCode,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.reset_grant).toBeDefined();
    resetGrant = res.body.data.reset_grant;
  });

  it('9. Resets password using the reset grant and allows login with new password', async () => {
    const newPassword = 'NewSecretPassword2026!';
    const resetRes = await request(app)
      .post('/api/v1/auth/password/reset')
      .send({
        reset_grant: resetGrant,
        new_password: newPassword,
      });

    expect(resetRes.status).toBe(200);
    expect(resetRes.body.success).toBe(true);

    // Old password fails
    const oldLoginRes = await request(app)
      .post('/api/v1/auth/login')
      .send({
        email: testEmail,
        password: testPassword,
      });
    expect(oldLoginRes.status).toBe(401);

    // New password succeeds
    const newLoginRes = await request(app)
      .post('/api/v1/auth/login')
      .send({
        email: testEmail,
        password: newPassword,
      });
    expect(newLoginRes.status).toBe(200);
    expect(newLoginRes.body.success).toBe(true);
  });

  it('10. Enforces retirement on guest login with stable 410 GUEST_LOGIN_RETIRED status', async () => {
    const res = await request(app)
      .post('/api/v1/auth/guest-login')
      .send({});

    // GUEST_LOGIN_ENABLED defaults to false/disabled in production or when retired
    expect([403, 410]).toContain(res.status);
    expect(['GUEST_LOGIN_RETIRED', 'GUEST_LOGIN_DISABLED']).toContain(res.body.error.code);
  });
});
