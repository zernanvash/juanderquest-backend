import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { setPool } from '../src/db/pool.js';
import { db, QuestRow, SubmissionRow } from '../src/db/index.js';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import { spotStore, Spot } from '../src/spots/store.js';

describe('Phase 0 & 1: QA Visibility & Evaluator Preview Mode', () => {
  let testDb: TestDbInstance;

  const genuineUserId = '11111111-1111-1111-1111-111111111111';
  const qaUserId = '22222222-2222-2222-2222-222222222222';
  const adminUserId = '33333333-3333-3333-3333-333333333333';

  const tokenAdmin = jwt.sign(
    { id: adminUserId, role: 'admin' },
    env.JWT_SECRET,
    { expiresIn: '1h' }
  );

  const tokenQA = jwt.sign(
    { id: qaUserId, role: 'qa' },
    env.JWT_SECRET,
    { expiresIn: '1h' }
  );

  const tokenUser = jwt.sign(
    { id: genuineUserId, role: 'user' },
    env.JWT_SECRET,
    { expiresIn: '1h' }
  );

  const testSpot: Spot = {
    id: 'spot-preview-test-001',
    slug: 'preview-test-cove',
    name: 'Preview Test Cove',
    description: 'A test cove in Alaminos.',
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

  const testQuest: QuestRow = {
    id: 'quest-preview-test-001',
    title: 'Preview Test Quest',
    description: 'Explore the test cove',
    category: 'eco',
    location_name: 'Alaminos Cove',
    gps_lat: 16.20,
    gps_lng: 120.01,
    radius_meters: 100,
    base_reward_php: 50,
    difficulty_factor: 1,
    geo_multiplier: 1,
    reward_points: 50,
    marker_code: 'TEST-PREVIEW-001',
    marker_image_url: '',
    is_active: false,
    is_test: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const testSubmission: SubmissionRow = {
    id: 'sub-preview-test-001',
    user_id: qaUserId,
    quest_id: testQuest.id,
    scanned_marker_code: 'TEST-PREVIEW-001',
    captured_lat: 16.2001,
    captured_lng: 120.0101,
    captured_accuracy: 5,
    status: 'pending',
    rejection_reason: undefined,
    reviewed_by: undefined,
    reviewed_at: undefined,
    idempotency_key: 'idemp-preview-001',
    is_test: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  beforeAll(async () => {
    testDb = await createTestDb();
    setPool(testDb.pool);
    db.usersRepo.setPool(testDb.pool);

    await testDb.pool.query(`
      INSERT INTO users (id, seed_id, display_name, email, handle, bio, status_text, is_public, role, demo_points, is_test)
      VALUES 
        ('${genuineUserId}', 'seed_genuine_voyager', 'Genuine Voyager', 'voyager@preview.com', 'voyager_preview', 'Bio', 'Status', true, 'user', 100, false),
        ('${qaUserId}', 'seed_qa_tester', 'QA Evaluator', 'evaluator@preview.com', 'qa_evaluator', 'Evaluator bio', 'Testing', true, 'qa', 200, true),
        ('${adminUserId}', 'seed_admin_eval', 'Admin Evaluator', 'admin@preview.com', 'admin_eval', 'Admin bio', 'Reviewing', true, 'admin', 500, false)
      ON CONFLICT (id) DO UPDATE SET
        role = EXCLUDED.role,
        is_test = EXCLUDED.is_test;
    `);

    // Insert in-memory representations
    db.users.push({
      id: qaUserId,
      seed_id: 'seed_qa_tester',
      display_name: 'QA Evaluator',
      email: 'evaluator@preview.com',
      avatar_url: '',
      role: 'qa',
      demo_points: 200,
      mjdq_balance: 200000,
      jdq_governance_balance: 20,
      scout_reputation: 10,
      is_public: true,
      is_test: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    db.users.push({
      id: adminUserId,
      seed_id: 'seed_admin_eval',
      display_name: 'Admin Evaluator',
      email: 'admin@preview.com',
      avatar_url: '',
      role: 'admin',
      demo_points: 500,
      mjdq_balance: 500000,
      jdq_governance_balance: 50,
      scout_reputation: 100,
      is_public: true,
      is_test: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    spotStore.spots.push(testSpot);
    db.quests.push(testQuest);
    db.submissions.push(testSubmission);
  });

  afterAll(async () => {
    setPool(null);
    db.usersRepo.setPool(null as any);
    if (testDb) {
      await testDb.close();
    }
  });

  describe('Header-Based QA Authorization', () => {
    it('accepts x-include-test: true header with admin token on GET /spots', async () => {
      const res = await request(app)
        .get('/api/v1/spots')
        .set('Authorization', `Bearer ${tokenAdmin}`)
        .set('x-include-test', 'true');

      expect(res.status).toBe(200);
      const spotIds = res.body.data.map((s: any) => s.id);
      expect(spotIds).toContain(testSpot.id);
    });

    it('accepts x-include-test: true header with QA role token on GET /spots', async () => {
      const res = await request(app)
        .get('/api/v1/spots')
        .set('Authorization', `Bearer ${tokenQA}`)
        .set('x-include-test', 'true');

      expect(res.status).toBe(200);
      const spotIds = res.body.data.map((s: any) => s.id);
      expect(spotIds).toContain(testSpot.id);
    });

    it('accepts x-include-test: true header on GET /search', async () => {
      const res = await request(app)
        .get('/api/v1/search?q=Preview')
        .set('Authorization', `Bearer ${tokenAdmin}`)
        .set('x-include-test', 'true');

      expect(res.status).toBe(200);
      const placeGroup = res.body.data.groups.find((g: any) => g.type === 'places');
      expect(placeGroup).toBeDefined();
      const placeIds = placeGroup.items.map((p: any) => p.id);
      expect(placeIds).toContain(testSpot.id);
    });
  });

  describe('Test Quests & Inactive Submission Coordinates', () => {
    it('returns inactive test quests when QA mode is authorized on GET /quests', async () => {
      const res = await request(app)
        .get('/api/v1/quests')
        .set('Authorization', `Bearer ${tokenAdmin}`)
        .set('x-include-test', 'true');

      expect(res.status).toBe(200);
      const questIds = res.body.data.map((q: any) => q.id);
      expect(questIds).toContain(testQuest.id);
    });

    it('excludes inactive test quests for unauthenticated or public callers', async () => {
      const res = await request(app).get('/api/v1/quests');
      expect(res.status).toBe(200);
      const questIds = res.body.data.map((q: any) => q.id);
      expect(questIds).not.toContain(testQuest.id);
    });

    it('preserves quest coordinates and title for inactive quest submissions in GET /admin/submissions', async () => {
      const res = await request(app)
        .get('/api/v1/admin/submissions')
        .set('Authorization', `Bearer ${tokenAdmin}`);

      expect(res.status).toBe(200);
      const testSub = res.body.data.find((s: any) => s.id === 'sub-preview-test-001');
      expect(testSub).toBeDefined();
      expect(testSub.quest_title).toBe('Preview Test Quest');
      expect(testSub.target_lat).toBe(16.20);
      expect(testSub.target_lng).toBe(120.01);
      expect(testSub.distance_meters).toBeLessThan(100); // 16.2001, 120.0101 is ~15 meters away
    });
  });

  describe('Evaluator Preview Passkey (QA_PREVIEW_TOKEN)', () => {
    it('allows unauthenticated caller with valid x-qa-preview-token to access test spots', async () => {
      const res = await request(app)
        .get('/api/v1/spots?include_test=true')
        .set('x-qa-preview-token', 'juanderquest-test-evaluator-token');

      expect(res.status).toBe(200);
      const spotIds = res.body.data.map((s: any) => s.id);
      expect(spotIds).toContain(testSpot.id);
      expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    });

    it('rejects unauthenticated caller attempting QA mode with invalid passkey', async () => {
      const res = await request(app)
        .get('/api/v1/spots?include_test=true')
        .set('x-qa-preview-token', 'wrong-passkey');

      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe('UNAUTHORIZED_QA_MODE');
    });

    it('rejects regular user attempting QA mode with x-include-test', async () => {
      const res = await request(app)
        .get('/api/v1/spots')
        .set('Authorization', `Bearer ${tokenUser}`)
        .set('x-include-test', 'true');

      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe('UNAUTHORIZED_QA_MODE');
    });
  });

  describe('Phase 5: Public Crawler Leak & SEO Isolation Audit', () => {
    it('guarantees 0% synthetic test data leaked to anonymous crawlers across all endpoints', async () => {
      // 1. GET /spots
      const spotsRes = await request(app).get('/api/v1/spots');
      expect(spotsRes.status).toBe(200);
      expect(spotsRes.headers['x-robots-tag']).toBeUndefined();
      const testSpots = spotsRes.body.data.filter((s: any) => s.is_test === true);
      expect(testSpots.length).toBe(0);

      // 2. GET /feed
      const feedRes = await request(app).get('/api/v1/feed');
      expect(feedRes.status).toBe(200);
      expect(feedRes.headers['x-robots-tag']).toBeUndefined();
      const testFeedItems = feedRes.body.data.items.filter((s: any) => s.is_test === true);
      expect(testFeedItems.length).toBe(0);

      // 3. GET /quests
      const questsRes = await request(app).get('/api/v1/quests');
      expect(questsRes.status).toBe(200);
      expect(questsRes.headers['x-robots-tag']).toBeUndefined();
      const testQuests = questsRes.body.data.filter((q: any) => q.is_test === true);
      expect(testQuests.length).toBe(0);

      // 4. GET /users
      const usersRes = await request(app).get('/api/v1/users');
      expect(usersRes.status).toBe(200);
      expect(usersRes.headers['x-robots-tag']).toBeUndefined();
      const testUsers = usersRes.body.data.items.filter((u: any) => u.is_test === true);
      expect(testUsers.length).toBe(0);

      // 5. GET /search
      const searchRes = await request(app).get('/api/v1/search?q=Preview');
      expect(searchRes.status).toBe(200);
      expect(searchRes.headers['x-robots-tag']).toBeUndefined();
      const placeGroup = searchRes.body.data.groups?.find((g: any) => g.type === 'places');
      const testPlaces = (placeGroup?.items || []).filter((p: any) => p.id === testSpot.id);
      expect(testPlaces.length).toBe(0);
    });

    it('attaches X-Robots-Tag: noindex, nofollow to all authorized preview mode responses', async () => {
      const endpoints = [
        '/api/v1/spots',
        '/api/v1/feed',
        '/api/v1/quests',
        '/api/v1/users',
        '/api/v1/search?q=Preview',
      ];

      for (const endpoint of endpoints) {
        const res = await request(app)
          .get(endpoint)
          .set('Authorization', `Bearer ${tokenQA}`)
          .set('x-include-test', 'true');

        expect(res.status).toBe(200);
        expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
      }
    });
  });
});
