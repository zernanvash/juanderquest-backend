import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { setPool } from '../src/db/pool.js';
import { db } from '../src/db/index.js';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import { spotStore, Spot } from '../src/spots/store.js';

describe('Phase 5: Synthetic QA Data Isolation', () => {
  let testDb: TestDbInstance;

  const genuineUserId = '10101010-1010-1010-1010-101010101010';
  const testUserId = '90909090-9090-9090-9090-909090909090';
  const adminUserId = '80808080-8080-8080-8080-808080808080';

  const tokenUser = jwt.sign(
    { id: genuineUserId, role: 'user' },
    env.JWT_SECRET,
    { expiresIn: '1h' }
  );

  const tokenAdmin = jwt.sign(
    { id: adminUserId, role: 'admin' },
    env.JWT_SECRET,
    { expiresIn: '1h' }
  );

  const genuineSpot: Spot = {
    id: 'spot-genuine-001',
    slug: 'genuine-bolinao-beach',
    name: 'Genuine Bolinao Beach',
    description: 'A genuine scenic beach spot in Bolinao.',
    category: 'nature_outdoors',
    subcategory: 'white_sand_beach',
    tags: ['scenic', 'free'],
    municipality: 'Bolinao',
    address: 'Bolinao, Pangasinan',
    gps_lat: 16.38,
    gps_lng: 119.78,
    price_level: 0,
    hours: {},
    amenities: [],
    image_url: 'https://images.unsplash.com/photo-genuine',
    source_type: 'editorial',
    source_name: 'Editorial',
    trust_level: 'editorial',
    status: 'published',
    crowd_capacity_band: 'medium',
    recommendation_suppressed: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    is_test: false,
  };

  const syntheticTestSpot: Spot = {
    id: 'spot-synthetic-qa-001',
    slug: 'synthetic-qa-test-cove',
    name: 'Synthetic QA Test Cove',
    description: 'A simulated spot used strictly for automated regression testing.',
    category: 'nature_outdoors',
    subcategory: 'cove',
    tags: ['hidden_gem'],
    municipality: 'Alaminos',
    address: 'Alaminos, Pangasinan',
    gps_lat: 16.20,
    gps_lng: 120.01,
    price_level: 0,
    hours: {},
    amenities: [],
    image_url: 'https://images.unsplash.com/photo-test',
    source_type: 'community',
    source_name: 'QA Fixture',
    trust_level: 'community',
    status: 'published',
    crowd_capacity_band: 'medium',
    recommendation_suppressed: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    is_test: true,
  };

  beforeAll(async () => {
    testDb = await createTestDb();
    setPool(testDb.pool);

    // Populate test and genuine users in database
    await testDb.pool.query(`
      INSERT INTO users (id, seed_id, display_name, email, handle, bio, status_text, is_public, role, demo_points, is_test)
      VALUES 
        ('${genuineUserId}', 'seed_genuine_user', 'Real Voyager', 'voyager@test.com', 'real_voyager', 'Genuine travel explorer', 'Exploring Bolinao', true, 'user', 50, false),
        ('${testUserId}', 'seed_synthetic_qa', 'Synthetic QA Bot', 'qabot@test.com', 'qa_bot_explorer', 'Automated QA bot runner', 'Testing pipeline', true, 'user', 10, true),
        ('${adminUserId}', 'seed_qa_admin', 'Admin Reviewer', 'admin@test.com', 'admin_reviewer', 'Platform Admin', 'Reviewing submissions', true, 'admin', 999, false)
      ON CONFLICT (id) DO UPDATE SET
        is_public = EXCLUDED.is_public,
        is_test = EXCLUDED.is_test;
    `);

    // Ensure mock users in Memory fallback also contain test user
    db.users = [
      {
        id: genuineUserId,
        seed_id: 'seed_genuine_user',
        display_name: 'Real Voyager',
        email: 'voyager@test.com',
        avatar_url: '',
        role: 'user',
        demo_points: 50,
        mjdq_balance: 50000,
        jdq_governance_balance: 0,
        scout_reputation: 10,
        is_public: true,
        handle: 'real_voyager',
        bio: 'Genuine travel explorer',
        status_text: 'Exploring Bolinao',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        is_test: false,
      },
      {
        id: testUserId,
        seed_id: 'seed_synthetic_qa',
        display_name: 'Synthetic QA Bot',
        email: 'qabot@test.com',
        avatar_url: '',
        role: 'user',
        demo_points: 10,
        mjdq_balance: 10000,
        jdq_governance_balance: 0,
        scout_reputation: 0,
        is_public: true,
        handle: 'qa_bot_explorer',
        bio: 'Automated QA bot runner',
        status_text: 'Testing pipeline',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        is_test: true,
      },
    ];

    await db.hydrateFromPg(testDb.pool);

    // Seed spotStore
    spotStore.spots = [genuineSpot, syntheticTestSpot];
  });

  afterAll(async () => {
    setPool(null);
    db.usersRepo.setPool(null as any);
    await testDb.close();
  });

  describe('QA Authorization Enforcement', () => {
    it('blocks unauthenticated requests with ?include_test=true with HTTP 403 UNAUTHORIZED_QA_MODE', async () => {
      const resSpots = await request(app).get('/api/v1/spots?include_test=true');
      expect(resSpots.status).toBe(403);
      expect(resSpots.body.success).toBe(false);
      expect(resSpots.body.error.code).toBe('UNAUTHORIZED_QA_MODE');

      const resUsers = await request(app).get('/api/v1/users?include_test=true');
      expect(resUsers.status).toBe(403);
      expect(resUsers.body.success).toBe(false);
      expect(resUsers.body.error.code).toBe('UNAUTHORIZED_QA_MODE');

      const resSearch = await request(app).get('/api/v1/search?q=Cove&include_test=true');
      expect(resSearch.status).toBe(403);
      expect(resSearch.body.success).toBe(false);
      expect(resSearch.body.error.code).toBe('UNAUTHORIZED_QA_MODE');
    });

    it('blocks unauthenticated requests with header x-include-test: true with HTTP 403 UNAUTHORIZED_QA_MODE', async () => {
      const res = await request(app)
        .get('/api/v1/spots')
        .set('x-include-test', 'true');

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('UNAUTHORIZED_QA_MODE');
    });

    it('blocks non-admin authenticated users from using ?include_test=true', async () => {
      const res = await request(app)
        .get('/api/v1/spots?include_test=true')
        .set('Authorization', `Bearer ${tokenUser}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('UNAUTHORIZED_QA_MODE');
    });

    it('R1 regression: blocks unauthenticated requests attempting to bypass with x-qa-auth headers', async () => {
      const res = await request(app)
        .get('/api/v1/spots?include_test=true')
        .set('x-qa-auth', 'juanderquest-qa-authorized');

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('UNAUTHORIZED_QA_MODE');

      const resFeed = await request(app)
        .get('/api/v1/feed?include_test=true')
        .set('x-qa-auth', 'juanderquest-qa-secret');

      expect(resFeed.status).toBe(403);
      expect(resFeed.body.error.code).toBe('UNAUTHORIZED_QA_MODE');
    });
  });

  describe('Clean Public Views (Default Exclusion)', () => {
    it('excludes synthetic test users from public traveler discovery', async () => {
      const res = await request(app).get('/api/v1/users?limit=10');
      expect(res.status).toBe(200);
      const ids = res.body.data.items.map((u: any) => u.id);
      expect(ids).toContain(genuineUserId);
      expect(ids).not.toContain(testUserId);
    });

    it('excludes synthetic test users and spots from default search results', async () => {
      // Search for "bot" which matches the synthetic user
      const resUser = await request(app).get('/api/v1/search?q=bot');
      expect(resUser.status).toBe(200);
      const peopleMatches = resUser.body.data.groups
        .filter((g: any) => g.type === 'people')
        .flatMap((g: any) => g.items);
      const matchedUserIds = peopleMatches.map((p: any) => p.id);
      expect(matchedUserIds).not.toContain(testUserId);

      // Search for "Synthetic" which matches the test spot
      const resSpot = await request(app).get('/api/v1/search?q=Synthetic');
      expect(resSpot.status).toBe(200);
      const placeMatches = resSpot.body.data.groups
        .filter((g: any) => g.type === 'places')
        .flatMap((g: any) => g.items);
      const matchedSpotIds = placeMatches.map((p: any) => p.id);
      expect(matchedSpotIds).not.toContain(syntheticTestSpot.id);
    });

    it('excludes synthetic spots from default spots listing', async () => {
      const res = await request(app).get('/api/v1/spots');
      expect(res.status).toBe(200);
      const spotIds = res.body.data.map((s: any) => s.id);
      expect(spotIds).toContain(genuineSpot.id);
      expect(spotIds).not.toContain(syntheticTestSpot.id);
    });

    it('R4 regression: strictly excludes synthetic spots from default /feed', async () => {
      const res = await request(app).get('/api/v1/feed');
      expect(res.status).toBe(200);
      const feedIds = res.body.data.items.map((s: any) => s.id);
      expect(feedIds).toContain(genuineSpot.id);
      expect(feedIds).not.toContain(syntheticTestSpot.id);
    });

    it('returns 404 for unauthenticated lookup of a synthetic spot or test profile', async () => {
      const resSpot = await request(app).get(`/api/v1/spots/${syntheticTestSpot.slug}`);
      expect(resSpot.status).toBe(404);

      const resUser = await request(app).get(`/api/v1/users/${testUserId}/profile`);
      expect(resUser.status).toBe(404);
    });
  });

  describe('Authorized QA Mode & Indexing Protection', () => {
    it('allows authenticated admin token to query with ?include_test=true', async () => {
      const resUsers = await request(app)
        .get('/api/v1/users?include_test=true')
        .set('Authorization', `Bearer ${tokenAdmin}`);

      expect(resUsers.status).toBe(200);
      const userIds = resUsers.body.data.items.map((u: any) => u.id);
      expect(userIds).toContain(testUserId);

      const resSpots = await request(app)
        .get('/api/v1/spots?include_test=true')
        .set('Authorization', `Bearer ${tokenAdmin}`);

      expect(resSpots.status).toBe(200);
      const spotIds = resSpots.body.data.map((s: any) => s.id);
      expect(spotIds).toContain(syntheticTestSpot.id);

      const resFeed = await request(app)
        .get('/api/v1/feed?include_test=true')
        .set('Authorization', `Bearer ${tokenAdmin}`);

      expect(resFeed.status).toBe(200);
      const feedIds = resFeed.body.data.items.map((s: any) => s.id);
      expect(feedIds).toContain(syntheticTestSpot.id);
    });

    it('attaches X-Robots-Tag: noindex, nofollow on synthetic detail pages in QA mode', async () => {
      const resSpot = await request(app)
        .get(`/api/v1/spots/${syntheticTestSpot.slug}?include_test=true`)
        .set('Authorization', `Bearer ${tokenAdmin}`);

      expect(resSpot.status).toBe(200);
      expect(resSpot.headers['x-robots-tag']).toBe('noindex, nofollow');

      const resUser = await request(app)
        .get(`/api/v1/users/${testUserId}/profile?include_test=true`)
        .set('Authorization', `Bearer ${tokenAdmin}`);

      expect(resUser.status).toBe(200);
      expect(resUser.headers['x-robots-tag']).toBe('noindex, nofollow');
    });
  });

  describe('Crowd Pressure & Trending Signal Isolation', () => {
    it('completely excludes synthetic activity events from crowd pressure scoring', () => {
      // Clear past activity
      spotStore.activityEvents = [];

      // Initial crowd score on genuineSpot
      const initialCrowd = spotStore.crowd(genuineSpot);
      expect(initialCrowd.pressure_score).toBe(0);

      // Record 5 synthetic visits from test user
      const recorded = spotStore.recordActivity(testUserId, genuineSpot.id, 'visit');
      expect(recorded).toBe(true);

      const lastEvent = spotStore.activityEvents[spotStore.activityEvents.length - 1];
      expect(lastEvent.is_test).toBe(true);

      // Crowd score MUST still be 0 because e.is_test is excluded
      const crowdAfterSynthetic = spotStore.crowd(genuineSpot);
      expect(crowdAfterSynthetic.pressure_score).toBe(0);
      expect(crowdAfterSynthetic.crowd_status).toBe('unknown');

      // Now record a genuine visit from real user
      spotStore.recordActivity(genuineUserId, genuineSpot.id, 'visit');
      const genuineEvent = spotStore.activityEvents[spotStore.activityEvents.length - 1];
      expect(genuineEvent.is_test).toBe(false);

      const crowdAfterReal = spotStore.crowd(genuineSpot);
      // Real visit weight is 5
      expect(crowdAfterReal.pressure_score).toBeGreaterThan(0);
    });

    it('excludes test user interactions from spot trend score', () => {
      spotStore.interactions.clear();

      // Test user visits spot
      spotStore.interact(testUserId, genuineSpot.id, 'visit', true);
      // Trend calculation skips users where db.findUserById(userId)?.is_test is true
      const trendSynthetic = spotStore.trend(genuineSpot.id);
      expect(trendSynthetic).toBe(0);

      // Real user visits spot
      spotStore.interact(genuineUserId, genuineSpot.id, 'visit', true);
      const trendReal = spotStore.trend(genuineSpot.id);
      expect(trendReal).toBe(5);
    });
  });
});
