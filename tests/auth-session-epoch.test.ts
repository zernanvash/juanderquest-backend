import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { env } from '../src/config/env.js';
import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { resetRateLimits } from '../src/middleware/rateLimit.js';
import { invalidateSessionScopeCache } from '../src/middleware/auth.js';
import { SESSION_TYP } from '../src/auth/tokens.js';

describe('Plan 72 Phase 3: Session Epoch Invalidation & Durable Role Verification', () => {
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
    invalidateSessionScopeCache();
  });

  it('a token issued before a reset gets 401 after it, and the new login works', async () => {
    const email = 'epoch.reset@example.com';
    const oldPassword = 'OldPassword123!';
    const newPassword = 'BrandNewPassword123!';

    // Register user
    const regRes = await request(app)
      .post('/api/v1/auth/register')
      .send({
        email,
        password: oldPassword,
        display_name: 'Epoch Tester',
        age_eligibility_declared: true,
        terms_accepted: true,
      });
    expect(regRes.status).toBe(201);
    const devCode = regRes.body.data.dev_code;

    // Verify email
    await request(app)
      .post('/api/v1/auth/email/verify')
      .send({ email, code: devCode });

    // Login and get Token 1
    const login1 = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: oldPassword });
    expect(login1.status).toBe(200);
    const token1 = login1.body.data.token;

    // Verify Token 1 works on /auth/me
    const me1 = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token1}`);
    expect(me1.status).toBe(200);

    // Request password reset OTP
    const forgotRes = await request(app)
      .post('/api/v1/auth/password/forgot')
      .send({ email });
    expect(forgotRes.status).toBe(200);
    const resetOtp = forgotRes.body.data.dev_code;

    // Verify reset code to get reset grant
    const grantRes = await request(app)
      .post('/api/v1/auth/password/verify-code')
      .send({ email, code: resetOtp });
    expect(grantRes.status).toBe(200);
    const grant = grantRes.body.data.reset_grant;

    // Complete password reset
    const resetRes = await request(app)
      .post('/api/v1/auth/password/reset')
      .send({ reset_grant: grant, new_password: newPassword });
    expect(resetRes.status).toBe(200);

    // Token 1 MUST now get 401 UNAUTHORIZED
    const meAfterReset = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token1}`);
    expect(meAfterReset.status).toBe(401);
    expect(meAfterReset.body.error.code).toBe('UNAUTHORIZED');

    // Logging in with new password works and returns Token 2
    const login2 = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: newPassword });
    expect(login2.status).toBe(200);
    const token2 = login2.body.data.token;

    // Token 2 works on /auth/me
    const me2 = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token2}`);
    expect(me2.status).toBe(200);
  });

  it('revoke-all kills two parallel tokens', async () => {
    const email = 'parallel.sessions@example.com';
    const password = 'ParallelPassword123!';

    const regRes = await request(app)
      .post('/api/v1/auth/register')
      .send({
        email,
        password,
        display_name: 'Parallel User',
        age_eligibility_declared: true,
        terms_accepted: true,
      });
    expect(regRes.status).toBe(201);
    const devCode = regRes.body.data.dev_code;

    await request(app)
      .post('/api/v1/auth/email/verify')
      .send({ email, code: devCode });

    // Session 1 (e.g. mobile)
    const s1 = await request(app).post('/api/v1/auth/login').send({ email, password });
    expect(s1.status).toBe(200);
    const tokenA = s1.body.data.token;

    // Session 2 (e.g. web desktop)
    const s2 = await request(app).post('/api/v1/auth/login').send({ email, password });
    expect(s2.status).toBe(200);
    const tokenB = s2.body.data.token;

    // Both active
    expect((await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${tokenA}`)).status).toBe(200);
    expect((await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${tokenB}`)).status).toBe(200);

    // Call POST /auth/sessions/revoke-all with Token A
    const revokeRes = await request(app)
      .post('/api/v1/auth/sessions/revoke-all')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(revokeRes.status).toBe(200);
    expect(revokeRes.body.success).toBe(true);

    // Both tokens are now dead
    const checkA = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${tokenA}`);
    expect(checkA.status).toBe(401);

    const checkB = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${tokenB}`);
    expect(checkB.status).toBe(401);
  });

  it('an old token without sep works while the epoch is 0', async () => {
    const email = 'legacy.token@example.com';
    const password = 'LegacyPassword123!';

    const regRes = await request(app)
      .post('/api/v1/auth/register')
      .send({
        email,
        password,
        display_name: 'Legacy User',
        age_eligibility_declared: true,
        terms_accepted: true,
      });
    expect(regRes.status).toBe(201);
    const userId = regRes.body.data.user_id;

    // Mint a legacy JWT without sep claim (epoch 0 by default)
    const legacyToken = jwt.sign(
      { id: userId, seed_id: `user-${userId.slice(0, 8)}`, role: 'user', typ: SESSION_TYP },
      env.JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '1h' },
    );

    // Token works while session_epoch is 0
    const check1 = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${legacyToken}`);
    expect(check1.status).toBe(200);

    // Bump epoch in DB
    await db.bumpSessionEpoch(userId);
    invalidateSessionScopeCache(userId);

    // Now legacy token (implicit sep 0) gets 401
    const check2 = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${legacyToken}`);
    expect(check2.status).toBe(401);
  });

  it('a demoted admin no longer sees draft quests', async () => {
    const email = 'admin.demoted@example.com';
    const password = 'AdminPassword123!';

    const regRes = await request(app)
      .post('/api/v1/auth/register')
      .send({
        email,
        password,
        display_name: 'Staff Admin',
        age_eligibility_declared: true,
        terms_accepted: true,
      });
    expect(regRes.status).toBe(201);
    const adminId = regRes.body.data.user_id;

    // Set role to admin in DB
    await testDb.pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [adminId]);
    await db.hydrateFromPg(testDb.pool);

    // Login as admin and receive JWT with role = 'admin'
    const loginRes = await request(app).post('/api/v1/auth/login').send({ email, password });
    expect(loginRes.status).toBe(200);
    const adminToken = loginRes.body.data.token;

    // Create an author user and a draft quest
    const authorId = `author_${Date.now()}`;
    await testDb.pool.query(
      'INSERT INTO users (id, seed_id, display_name, email, role) VALUES ($1, $2, $3, $4, $5)',
      [authorId, authorId, 'Quest Author', `${authorId}@example.com`, 'user']
    );

    const questId = `quest_draft_${Date.now()}`;
    await testDb.pool.query(
      `INSERT INTO quests (id, title, description, category, location_name, gps_lat, gps_lng, radius_meters, reward_points, marker_code, marker_image_url, author_id, status, created_at, updated_at)
       VALUES ($1, 'Top Secret Draft Quest', 'Draft details', 'cultural', 'Lingayen Capitol', 16.0, 120.0, 100, 50, 'MARKER-TOPSECRET', '', $2, 'draft', NOW(), NOW())`,
      [questId, authorId]
    );
    await db.hydrateFromPg(testDb.pool);

    // Active admin CAN view the draft quest
    const viewAsAdmin = await request(app)
      .get(`/api/v1/quests/${questId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(viewAsAdmin.status).toBe(200);
    expect(viewAsAdmin.body.data.id).toBe(questId);

    // DEMOTE admin in database to 'user'
    await testDb.pool.query("UPDATE users SET role = 'user' WHERE id = $1", [adminId]);
    await db.hydrateFromPg(testDb.pool);
    invalidateSessionScopeCache(adminId);

    // Demoted staff with the stale JWT CANNOT view the draft quest anymore (404 NOT_FOUND)
    const viewAsDemoted = await request(app)
      .get(`/api/v1/quests/${questId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(viewAsDemoted.status).toBe(404);
  });

  it('a database outage gives 503', async () => {
    // Generate valid token for a user
    const dummyUserId = 'usr-db-outage-test';
    const token = jwt.sign(
      { id: dummyUserId, seed_id: 'seed-outage', role: 'user', typ: SESSION_TYP, sep: 0 },
      env.JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '1h' },
    );

    // Mock pool to simulate database outage / connection loss
    const origPool = db.usersRepo.getPool();
    const brokenPool: any = {
      query: jest.fn().mockRejectedValue(new Error('connection timeout: database unreachable')),
    };
    db.usersRepo.setPool(brokenPool);

    try {
      invalidateSessionScopeCache();
      const res = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('DATABASE_UNAVAILABLE');
    } finally {
      db.usersRepo.setPool(origPool);
      invalidateSessionScopeCache();
    }
  });
});
