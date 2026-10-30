import request from 'supertest';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { resetRateLimits } from '../src/middleware/rateLimit.js';

describe('Plan 72 Phase 2: Google Sign-In Squatted Account Pre-takeover Prevention', () => {
  let testDb: TestDbInstance;

  beforeAll(async () => {
    testDb = await createTestDb();
    await db.hydrateFromPg(testDb.pool);
  }, 90000);

  afterAll(async () => {
    if (testDb) {
      await testDb.close();
    }
  }, 90000);

  beforeEach(() => {
    resetRateLimits();
  });

  it('removes squatted password when Google signs in to an unverified email account', async () => {
    const email = 'squat.victim@example.com';
    const password = 'AttackerPassword123!';

    // 1. Attacker registers victim's email with password P
    const regRes = await request(app)
      .post('/api/v1/auth/register')
      .send({
        email,
        password,
        display_name: 'Squat Target',
        age_eligibility_declared: true,
        terms_accepted: true,
      });

    expect(regRes.status).toBe(201);
    expect(regRes.body.success).toBe(true);
    const userId = regRes.body.data.user_id;

    // Verify account exists and password works initially
    const loginBefore = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password });
    expect(loginBefore.status).toBe(200);

    // 2. Real user signs in with Google using dev_google credential
    const googleRes = await request(app)
      .post('/api/v1/auth/google')
      .send({
        credential: `dev_google:${email}:Real Victim`,
      });

    expect(googleRes.status).toBe(200);
    expect(googleRes.body.success).toBe(true);
    expect(googleRes.body.data.user.id).toBe(userId);

    // 3. Attacker's password P must now be REMOVED / FAIL
    const loginAfter = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password });

    expect(loginAfter.status).toBe(401);
    expect(loginAfter.body.error.code).toBe('INVALID_CREDENTIALS');

    // Email is now verified in account_emails
    const emailRow = await db.identityService.findAccountEmail(email);
    expect(emailRow?.is_verified).toBe(true);
  });

  it('preserves existing password when Google signs in to an already verified email account', async () => {
    const email = 'legit.user@example.com';
    const password = 'UserLegitPassword123!';

    // 1. Register legit user
    const regRes = await request(app)
      .post('/api/v1/auth/register')
      .send({
        email,
        password,
        display_name: 'Legit User',
        age_eligibility_declared: true,
        terms_accepted: true,
      });

    expect(regRes.status).toBe(201);
    const devCode = regRes.body.data.dev_code;
    const userId = regRes.body.data.user_id;

    // 2. Legit user verifies their email with the code
    const verifyRes = await request(app)
      .post('/api/v1/auth/email/verify')
      .send({ email, code: devCode });
    expect(verifyRes.status).toBe(200);

    // Verify email is verified in DB
    const emailRowBefore = await db.identityService.findAccountEmail(email);
    expect(emailRowBefore?.is_verified).toBe(true);

    // 3. User later signs in with Google using the same verified email
    const googleRes = await request(app)
      .post('/api/v1/auth/google')
      .send({
        credential: `dev_google:${email}:Legit User Google`,
      });

    expect(googleRes.status).toBe(200);
    expect(googleRes.body.success).toBe(true);
    expect(googleRes.body.data.user.id).toBe(userId);

    // 4. Legit password MUST STILL WORK
    const loginAfter = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password });

    expect(loginAfter.status).toBe(200);
    expect(loginAfter.body.success).toBe(true);
    expect(loginAfter.body.data.user.id).toBe(userId);
  });
});
