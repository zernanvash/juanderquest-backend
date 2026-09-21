import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { setPool } from '../src/db/pool.js';
import { db } from '../src/db/index.js';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import { SubmissionsService } from '../src/services/submissions.js';
import { progressionService } from '../src/progression/service.js';
import { progressionRepo } from '../src/progression/repository.js';
import { randomUUID } from 'crypto';

describe('Phase 1: Progression & Identity Foundation', () => {
  let testDb: TestDbInstance;
  const submissionsService = new SubmissionsService();

  const travelerId = '11111111-1111-1111-1111-111111111111';
  const privateUserId = '33333333-3333-3333-3333-333333333333';
  const testUserId = '99999999-9999-9999-9999-999999999999';
  const adminId = '22222222-2222-2222-2222-222222222222';

  const tokenTraveler = jwt.sign({ id: travelerId, role: 'user' }, env.JWT_SECRET, { expiresIn: '1h' });
  const tokenPrivateUser = jwt.sign({ id: privateUserId, role: 'user' }, env.JWT_SECRET, { expiresIn: '1h' });
  const tokenAdmin = jwt.sign({ id: adminId, role: 'admin' }, env.JWT_SECRET, { expiresIn: '1h' });

  const mappedQuestId = 'q1111111-1111-1111-1111-111111111111';
  const unmappedQuestId = 'q2222222-2222-2222-2222-222222222222';
  const spotId = 'spot-hundred-islands';

  beforeAll(async () => {
    testDb = await createTestDb();
    setPool(testDb.pool);

    // Seed core users
    await testDb.pool.query(`
      INSERT INTO users (id, seed_id, display_name, email, role, is_public, is_test, scout_reputation, demo_points) VALUES
      ('${travelerId}', 'seed-traveler', 'Juan Traveler', 'traveler@jdq.ph', 'user', true, false, 120, 100),
      ('${privateUserId}', 'seed-private', 'Private Explorer', 'private@jdq.ph', 'user', false, false, 80, 50),
      ('${testUserId}', 'seed-test-qa', 'QA Synthetic User', 'qa@jdq.ph', 'user', true, true, 0, 0),
      ('${adminId}', 'seed-admin', 'Admin Evaluator', 'admin@jdq.ph', 'admin', true, false, 500, 0)
      ON CONFLICT (id) DO NOTHING;
    `);

    // Seed quests
    await testDb.pool.query(`
      INSERT INTO quests (id, title, description, category, location_name, gps_lat, gps_lng, radius_meters, reward_points, marker_code, marker_image_url, is_test) VALUES
      ('${mappedQuestId}', 'Hundred Islands Eco Trek', 'Visit islands', 'eco', 'Alaminos City', 16.2063, 119.9706, 150, 50, 'MARKER_HI_01', '', false),
      ('${unmappedQuestId}', 'Bolinao Lighthouse', 'Visit lighthouse', 'cultural', 'Bolinao', 16.3885, 119.9095, 200, 75, 'MARKER_BL_01', '', false)
      ON CONFLICT (id) DO NOTHING;
    `);

    // Seed spot
    await testDb.pool.query(`
      INSERT INTO spots (id, slug, name, description, category, subcategory, tags, municipality, address, gps_lat, gps_lng, price_level, hours, amenities, image_url, source_type, source_name, trust_level, status, quest_id, is_test) VALUES
      ('${spotId}', 'hundred-islands-park', 'Hundred Islands National Park', 'Archipelago', 'nature_outdoors', 'park', '["scenic"]', 'Alaminos City', 'Alaminos City, Pangasinan', 16.2063, 119.9706, 2, '{}', '[]', '', 'lgu', 'Alaminos Tourism', 'lgu_verified', 'published', '${mappedQuestId}', false)
      ON CONFLICT (id) DO NOTHING;
    `);

    // Seed active reviewed binding for mappedQuestId -> spotId
    await testDb.pool.query(`
      INSERT INTO reviewed_quest_spot_bindings (id, quest_id, spot_id, binding_version, status, reviewed_by, is_test) VALUES
      ('${randomUUID()}', '${mappedQuestId}', '${spotId}', 'v1', 'active', '${adminId}', false)
      ON CONFLICT (id) DO NOTHING;
    `);

    // Link spot to coastal collection
    await testDb.pool.query(`
      INSERT INTO curated_collection_spots (collection_id, spot_id, order_index) VALUES
      ('coastal_wonders_trail', '${spotId}', 0)
      ON CONFLICT (collection_id, spot_id) DO NOTHING;
    `);
  });

  afterAll(async () => {
    setPool(null);
    await testDb.close();
  });

  let approvedSubId: string;

  describe('1. Submission Approval Seam & Outbox Invariants', () => {
    it('emits a submission_approved outbox event on first approval for a mapped quest', async () => {
      const subId = randomUUID();
      approvedSubId = subId;
      await testDb.pool.query(`
        INSERT INTO submissions (id, idempotency_key, user_id, quest_id, scanned_marker_code, captured_lat, captured_lng, captured_accuracy, status)
        VALUES ('${subId}', 'idem-appr-1', '${travelerId}', '${mappedQuestId}', 'MARKER_HI_01', 16.2063, 119.9706, 5, 'pending');
      `);

      const reviewRes = await submissionsService.reviewSubmission(subId, 'approve', adminId);
      expect(reviewRes.success).toBe(true);
      expect(reviewRes.statusCode).toBe(200);

      // Verify outbox event was recorded in DB
      const { rows } = await testDb.pool.query(
        'SELECT * FROM outbox_events WHERE event_key = $1',
        [`submission_approval_${subId}`]
      );
      expect(rows.length).toBe(1);
      expect(rows[0].event_type).toBe('submission_approved');
      const payload = typeof rows[0].payload === 'string' ? JSON.parse(rows[0].payload) : rows[0].payload;
      expect(payload.submission_id).toBe(subId);
      expect(payload.spot_id).toBe(spotId);
      expect(payload.binding_version).toBe('v1');
    });

    it('replaying approval idempotently does not emit duplicate outbox event', async () => {
      // Replay approval on the existing approved submission
      const replay = await submissionsService.reviewSubmission(approvedSubId, 'approve', adminId);
      expect(replay.success).toBe(true);
      expect(replay.data?.awarded_points).toBe(0);

      // Count outbox events: strictly 1
      const { rows } = await testDb.pool.query(
        'SELECT COUNT(*) AS count FROM outbox_events WHERE event_key = $1',
        [`submission_approval_${approvedSubId}`]
      );
      expect(Number(rows[0].count)).toBe(1);
    });

    it('rejecting a submission emits no visit or approval outbox event', async () => {
      const subId = randomUUID();
      await testDb.pool.query(`
        INSERT INTO submissions (id, idempotency_key, user_id, quest_id, scanned_marker_code, captured_lat, captured_lng, captured_accuracy, status)
        VALUES ('${subId}', 'idem-reject-1', '${travelerId}', '${mappedQuestId}', 'MARKER_HI_01', 16.2063, 119.9706, 5, 'pending');
      `);

      const reviewRes = await submissionsService.reviewSubmission(subId, 'reject', adminId, 'Blurry photo');
      expect(reviewRes.success).toBe(true);

      const { rows } = await testDb.pool.query(
        'SELECT * FROM outbox_events WHERE event_key LIKE $1',
        [`%${subId}%`]
      );
      expect(rows.length).toBe(0);
    });

    it('unmapped quest approval emits unresolved event and prevents silent visit award', async () => {
      const subId = randomUUID();
      await testDb.pool.query(`
        INSERT INTO submissions (id, idempotency_key, user_id, quest_id, scanned_marker_code, captured_lat, captured_lng, captured_accuracy, status)
        VALUES ('${subId}', 'idem-unmapped-1', '${travelerId}', '${unmappedQuestId}', 'MARKER_BL_01', 16.3885, 119.9095, 5, 'pending');
      `);

      const reviewRes = await submissionsService.reviewSubmission(subId, 'approve', adminId);
      expect(reviewRes.success).toBe(true);

      const { rows } = await testDb.pool.query(
        'SELECT * FROM outbox_events WHERE event_key = $1',
        [`submission_approval_unresolved_${subId}`]
      );
      expect(rows.length).toBe(1);
      expect(rows[0].event_type).toBe('submission_approved_unresolved');
    });
  });

  describe('2. Outbox Processing & Progression Deduplication', () => {
    it('processes outbox event: creates verified_visit, awards 50 Explorer XP and evaluates milestone badge', async () => {
      const workerRes = await progressionService.processOutboxBatch(10, 'test-worker-1');
      expect(workerRes.processed).toBeGreaterThanOrEqual(1);

      // Verify verified_visit created
      const visits = await progressionRepo.getVerifiedVisitsForUser(travelerId);
      expect(visits.length).toBeGreaterThanOrEqual(1);
      expect(visits[0].spot_id).toBe(spotId);
      expect(visits[0].municipality_id).toBe('alaminos_city');

      // Verify progression totals
      const totals = await progressionRepo.getTotalsForUser(travelerId);
      expect(totals?.explorer_xp).toBeGreaterThanOrEqual(50);

      // Verify First Footstep badge awarded
      const awards = await progressionRepo.getAwardsForUser(travelerId);
      const firstFootstep = awards.find((a: any) => a.achievement_id === 'first_footstep');
      expect(firstFootstep).toBeDefined();
    });

    it('rebuilding totals from event rows matches progression_totals exactly', async () => {
      const client = await testDb.pool.connect();
      try {
        const rebuilt = await progressionRepo.rebuildTotalsForUser(travelerId, client);
        const current = await progressionRepo.getTotalsForUser(travelerId);
        expect(rebuilt.explorer_xp).toBe(current?.explorer_xp);
        expect(rebuilt.civic_xp).toBe(current?.civic_xp);
      } finally {
        client.release();
      }
    });

    it('running outbox processor again produces no duplicate visits, events, or awards', async () => {
      const totalsBefore = await progressionRepo.getTotalsForUser(travelerId);
      const visitsBefore = await progressionRepo.getVerifiedVisitsForUser(travelerId);
      const awardsBefore = await progressionRepo.getAwardsForUser(travelerId);

      const workerRes = await progressionService.processOutboxBatch(10, 'test-worker-2');
      expect(workerRes.processed).toBe(0);

      const totalsAfter = await progressionRepo.getTotalsForUser(travelerId);
      const visitsAfter = await progressionRepo.getVerifiedVisitsForUser(travelerId);
      const awardsAfter = await progressionRepo.getAwardsForUser(travelerId);

      expect(totalsAfter?.explorer_xp).toBe(totalsBefore?.explorer_xp);
      expect(visitsAfter.length).toBe(visitsBefore.length);
      expect(awardsAfter.length).toBe(awardsBefore.length);
    });
  });

  describe('3. API Endpoints: Owner Passport & Public Privacy Guard', () => {
    it('GET /api/v1/me/progression returns traveler passport with multi-track levels', async () => {
      const res = await request(app)
        .get('/api/v1/me/progression')
        .set('Authorization', `Bearer ${tokenTraveler}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const data = res.body.data;
      expect(data.user_id).toBe(travelerId);
      expect(data.explorer.level).toBeGreaterThanOrEqual(1);
      expect(data.explorer.title).toBeDefined();
      expect(data.civic.level).toBe(1);
      expect(data.scout.level).toBe(3); // 120 rep => Level 3 Trusted Local
      expect(data.lgu_progress.total).toBe(48);
      expect(data.lgu_progress.explored).toBeGreaterThanOrEqual(1);
      expect(data.recent_visits.length).toBeGreaterThanOrEqual(1);
      expect(data.recent_achievements.length).toBeGreaterThanOrEqual(1);
    });

    it('GET /api/v1/me/visits returns paginated visits', async () => {
      const res = await request(app)
        .get('/api/v1/me/visits')
        .set('Authorization', `Bearer ${tokenTraveler}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data.items)).toBe(true);
      expect(res.body.data.total).toBeGreaterThanOrEqual(1);
    });

    it('GET /api/v1/collections returns curated trails and spot completion', async () => {
      const res = await request(app)
        .get('/api/v1/collections')
        .set('Authorization', `Bearer ${tokenTraveler}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const coastal = res.body.data.items.find((c: any) => c.id === 'coastal_wonders_trail');
      expect(coastal).toBeDefined();
      expect(coastal.total_spots).toBeGreaterThanOrEqual(1);
      expect(coastal.spots[0].is_visited).toBe(true);
    });

    it('GET /api/v1/users/:id/achievements returns public badges for public user', async () => {
      await testDb.pool.query(
        'INSERT INTO user_engagement_preferences(user_id,share_achievements) VALUES($1,TRUE)',
        [travelerId],
      );
      const res = await request(app)
        .get(`/api/v1/users/${travelerId}/achievements`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.user_id).toBe(travelerId);
      expect(Array.isArray(res.body.data.achievements)).toBe(true);
    });

    it('GET /api/v1/users/:id/achievements returns 404 for private user', async () => {
      const res = await request(app)
        .get(`/api/v1/users/${privateUserId}/achievements`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('GET /api/v1/users/:id/achievements returns 404 for synthetic test user to standard caller', async () => {
      const res = await request(app)
        .get(`/api/v1/users/${testUserId}/achievements`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('GET /api/v1/me/progression returns 401 when unauthenticated', async () => {
      const res = await request(app).get('/api/v1/me/progression');
      expect(res.status).toBe(401);
    });

    it('POST /api/v1/admin/progression/process-outbox returns 403 for non-admin', async () => {
      const res = await request(app)
        .post('/api/v1/admin/progression/process-outbox')
        .set('Authorization', `Bearer ${tokenTraveler}`)
        .send({ batch_size: 5 });

      expect(res.status).toBe(403);
    });

    it('POST /api/v1/admin/progression/process-outbox executes successfully for admin', async () => {
      const res = await request(app)
        .post('/api/v1/admin/progression/process-outbox')
        .set('Authorization', `Bearer ${tokenAdmin}`)
        .send({ batch_size: 5 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.processed).toBeDefined();
    });
  });
});
