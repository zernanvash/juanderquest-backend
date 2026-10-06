import request from 'supertest';
import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import { db as domainDb } from '../src/db/index.js';
import { setPool } from '../src/db/pool.js';
import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';

describe('JuanChoice presentation HTTP contracts (Cookies, Exact-Origin CSRF, Writes-Off Rollback)', () => {
  let fixture: TestDbInstance;
  const campaignId = randomUUID();
  let candidateId: string;
  let testUserId: string;

  const originalEnv = {
    NODE_ENV: env.NODE_ENV,
    HOST: env.HOST,
    PORT: env.PORT,
    CORS_ORIGIN: env.CORS_ORIGIN,
    GUEST_LOGIN_ENABLED: env.GUEST_LOGIN_ENABLED,
    JUANCHOICE_ENABLED: env.JUANCHOICE_ENABLED,
    JUANCHOICE_WRITES_ENABLED: env.JUANCHOICE_WRITES_ENABLED,
    JUANCHOICE_PRESENTATION_MODE: env.JUANCHOICE_PRESENTATION_MODE,
    JDQ_PRESENTATION_PROFILE: env.JDQ_PRESENTATION_PROFILE,
    JUANCHOICE_PRESENTATION_CAMPAIGN_ID: env.JUANCHOICE_PRESENTATION_CAMPAIGN_ID,
    JUANCHOICE_PRESENTATION_DB_NAME: env.JUANCHOICE_PRESENTATION_DB_NAME,
    DATABASE_URL: env.DATABASE_URL,
    ALLOW_IN_MEMORY_FALLBACK: env.ALLOW_IN_MEMORY_FALLBACK,
    PROGRESSION_ENABLED: env.PROGRESSION_ENABLED,
  };

  beforeAll(async () => {
    fixture = await createTestDb();
    setPool(fixture.pool);
    domainDb.usersRepo.setPool(fixture.pool);

    const dbRes = await fixture.pool.query('SELECT current_database() AS db');
    const currentDb = dbRes.rows[0].db;

    Object.assign(env, {
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: 4200,
      GUEST_LOGIN_ENABLED: true,
      JUANCHOICE_ENABLED: true,
      JUANCHOICE_WRITES_ENABLED: true,
      JUANCHOICE_PRESENTATION_MODE: true,
      JDQ_PRESENTATION_PROFILE: 'public',
      CORS_ORIGIN: 'https://presentation.juanderquest.app',
      JUANCHOICE_PRESENTATION_CAMPAIGN_ID: campaignId,
      JUANCHOICE_PRESENTATION_DB_NAME: currentDb,
      DATABASE_URL: `postgres://localhost:5432/${currentDb}`,
      ALLOW_IN_MEMORY_FALLBACK: false,
      PROGRESSION_ENABLED: true,
    });

    // Seed spot
    await fixture.pool.query(
      `INSERT INTO spots(id, slug, name, description, category, subcategory, municipality, address, gps_lat, gps_lng, status, is_test, recommendation_suppressed, source_type, source_name)
       VALUES('spot-cabongaoan-beach', 'spot-cabongaoan-beach', 'Cabongaoan Beach', 'Test spot description', 'nature_outdoors', 'beach', 'Burgos', 'Burgos, Pangasinan', 16.0, 120.0, 'published', false, false, 'editorial', 'Editorial')
       ON CONFLICT (id) DO NOTHING`
    );

    // Seed test campaign
    await fixture.pool.query(
      `INSERT INTO juanchoice_campaigns(id, slug, region, theme, status, opens_at, closes_at, is_test, policy_version)
       VALUES($1, 'juanchoice-presentation-demo', 'pangasinan', 'Presentation Demo', 'voting',
              NOW() - INTERVAL '1 hour', NOW() + INTERVAL '1 day', false, 'juanchoice-pilot-v1')`,
      [campaignId]
    );

    candidateId = randomUUID();
    await fixture.pool.query(
      `INSERT INTO juanchoice_candidates(id, campaign_id, spot_id, status, is_test)
       VALUES($1, $2, 'spot-cabongaoan-beach', 'eligible', false)`,
      [candidateId, campaignId]
    );

    testUserId = randomUUID();
    await fixture.pool.query(
      `INSERT INTO users(id, seed_id, display_name, email, role, is_test, created_at)
       VALUES ($1, 'guest-test', 'Guest Test', 'guest-test@example.test', 'user', false, NOW())`,
      [testUserId]
    );
  }, 60000);

  afterAll(async () => {
    if (fixture) {
      setPool(null);
      domainDb.usersRepo.setPool(null);
      Object.assign(env, originalEnv);
      await fixture.close();
    }
  });

  describe('Real Backend Set-Cookie Behavior', () => {
    it('issues jdq_presentation_session cookie with Secure, HttpOnly, SameSite=Lax, and host-only attributes in public profile', async () => {
      env.JDQ_PRESENTATION_PROFILE = 'public';
      env.CORS_ORIGIN = 'https://presentation.juanderquest.app';

      const res = await request(app)
        .post('/api/v1/auth/guest-login')
        .send({ remember_me: true });

      expect(res.status).toBe(200);
      const rawCookies = res.headers['set-cookie'];
      expect(rawCookies).toBeDefined();
      const cookiesList = Array.isArray(rawCookies) ? rawCookies : [rawCookies as string];
      expect(cookiesList.length).toBeGreaterThan(0);

      const sessionCookie = cookiesList.find((c: string) => c.startsWith('jdq_presentation_session='));
      expect(sessionCookie).toBeDefined();

      // Check required security flags
      expect(sessionCookie).toContain('HttpOnly');
      expect(sessionCookie).toContain('SameSite=Lax');
      expect(sessionCookie).toContain('Secure');
      expect(sessionCookie).toContain('Path=/');

      // Host-only: MUST NOT contain Domain attribute
      expect(sessionCookie).not.toContain('Domain=');
      expect(sessionCookie).not.toContain('juanderquest.app');
    });

    it('omits Secure flag on jdq_presentation_session in local profile for HTTP development', async () => {
      env.JDQ_PRESENTATION_PROFILE = 'local';
      env.CORS_ORIGIN = 'http://127.0.0.1:3200';

      const res = await request(app)
        .post('/api/v1/auth/guest-login')
        .send({ remember_me: false });

      expect(res.status).toBe(200);
      const rawCookies = res.headers['set-cookie'];
      const cookiesList = Array.isArray(rawCookies) ? rawCookies : [rawCookies as string];
      const sessionCookie = cookiesList.find((c: string) => c.startsWith('jdq_presentation_session='));
      expect(sessionCookie).toBeDefined();

      expect(sessionCookie).toContain('HttpOnly');
      expect(sessionCookie).toContain('SameSite=Lax');
      expect(sessionCookie).not.toContain('Secure');

      // Reset back to public profile
      env.JDQ_PRESENTATION_PROFILE = 'public';
      env.CORS_ORIGIN = 'https://presentation.juanderquest.app';
    });
  });

  describe('Exact-Origin CSRF Gating for Cookie-Authenticated Mutations', () => {
    let sessionToken: string;

    beforeAll(() => {
      sessionToken = jwt.sign({ id: testUserId, role: 'user' }, env.JWT_SECRET);
    });

    it('accepts ballot mutation when request has exact public Origin header', async () => {
      env.JDQ_PRESENTATION_PROFILE = 'public';
      env.CORS_ORIGIN = 'https://presentation.juanderquest.app';
      env.JUANCHOICE_WRITES_ENABLED = true;

      const res = await request(app)
        .put(`/api/v1/juanchoice/campaigns/${campaignId}/ballot`)
        .set('Cookie', `jdq_presentation_session=${sessionToken}`)
        .set('Origin', 'https://presentation.juanderquest.app')
        .set('Idempotency-Key', randomUUID())
        .send({ candidate_id: candidateId, expected_version: 0 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.ballot.candidate_id).toBe(candidateId);
    });

    it('rejects ballot mutation with 403 INVALID_ORIGIN when Origin is missing', async () => {
      const res = await request(app)
        .put(`/api/v1/juanchoice/campaigns/${campaignId}/ballot`)
        .set('Cookie', `jdq_presentation_session=${sessionToken}`)
        // Origin omitted
        .set('Idempotency-Key', randomUUID())
        .send({ candidate_id: candidateId, expected_version: 1 });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INVALID_ORIGIN');
    });

    it('rejects ballot mutation with 403 INVALID_ORIGIN when Origin is ordinary alpha origin', async () => {
      const res = await request(app)
        .put(`/api/v1/juanchoice/campaigns/${campaignId}/ballot`)
        .set('Cookie', `jdq_presentation_session=${sessionToken}`)
        .set('Origin', 'https://juanderquest.app')
        .set('Idempotency-Key', randomUUID())
        .send({ candidate_id: candidateId, expected_version: 1 });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INVALID_ORIGIN');
    });

    it('rejects ballot mutation with 403 INVALID_ORIGIN when Origin is foreign/attacker domain', async () => {
      const res = await request(app)
        .put(`/api/v1/juanchoice/campaigns/${campaignId}/ballot`)
        .set('Cookie', `jdq_presentation_session=${sessionToken}`)
        .set('Origin', 'https://attacker.example.com')
        .set('Idempotency-Key', randomUUID())
        .send({ candidate_id: candidateId, expected_version: 1 });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INVALID_ORIGIN');
    });

    it('allows Bearer token authentication without Origin header (Flutter/non-browser client)', async () => {
      const res = await request(app)
        .put(`/api/v1/juanchoice/campaigns/${campaignId}/ballot`)
        .set('Authorization', `Bearer ${sessionToken}`)
        // No Cookie, no Origin
        .set('Idempotency-Key', randomUUID())
        .send({ candidate_id: candidateId, expected_version: 1 });

      // Ballot already cast, version conflict or success, but definitely NOT 403 INVALID_ORIGIN
      expect(res.status).not.toBe(403);
    });
  });

  describe('Public Profile Writes-Off Rollback State', () => {
    it('rejects ballot mutations with 503 WRITES_DISABLED while guest read & login remain functional', async () => {
      env.JDQ_PRESENTATION_PROFILE = 'public';
      env.CORS_ORIGIN = 'https://presentation.juanderquest.app';
      env.JUANCHOICE_WRITES_ENABLED = false; // Writes turned off!

      const sessionToken = jwt.sign({ id: testUserId, role: 'user' }, env.JWT_SECRET);

      // 1. Ballot mutation fails with 503 WRITES_DISABLED
      const voteRes = await request(app)
        .put(`/api/v1/juanchoice/campaigns/${campaignId}/ballot`)
        .set('Cookie', `jdq_presentation_session=${sessionToken}`)
        .set('Origin', 'https://presentation.juanderquest.app')
        .set('Idempotency-Key', randomUUID())
        .send({ candidate_id: candidateId, expected_version: 1 });

      expect(voteRes.status).toBe(503);
      expect(voteRes.body.error.code).toBe('WRITES_DISABLED');

      // 2. Guest login remains operational (HTTP 200)
      const guestRes = await request(app)
        .post('/api/v1/auth/guest-login')
        .send({ remember_me: false });

      expect(guestRes.status).toBe(200);
      expect(guestRes.body.data.user).toBeDefined();

      // 3. Campaign overview reading remains operational (HTTP 200)
      const overviewRes = await request(app).get('/api/v1/juanchoice/overview');
      expect(overviewRes.status).toBe(200);
      expect(overviewRes.body.data.current.id).toBe(campaignId);
      expect(overviewRes.body.data.availability.voting_enabled).toBe(false);
      expect(overviewRes.body.data.availability.reason).toBe('WRITES_DISABLED');
    });
  });
});
