import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { setPool } from '../src/db/pool.js';
import { env } from '../src/config/env.js';

describe('Plan 91a: Proximity Quiz Radar & Multi-Quiz Endpoints', () => {
  let testDb: TestDbInstance;

  const adminUserId = 'plan91a-admin-1';
  const travelerUserId = 'plan91a-traveler-1';

  const adminToken = jwt.sign(
    { id: adminUserId, seed_id: 'plan91a-admin-seed', role: 'admin', typ: 'session' },
    env.JWT_SECRET,
  );
  const travelerToken = jwt.sign(
    { id: travelerUserId, seed_id: 'plan91a-traveler-seed', role: 'user', typ: 'session' },
    env.JWT_SECRET,
  );

  const spotMainId = 'plan91a-spot-main';
  const spotApproachId = 'plan91a-spot-approach';
  // Main spot at 16.0200, 120.2300 (Lingayen)
  const mainLat = 16.02;
  const mainLng = 120.23;
  // ~222m north of main spot (0.002 deg lat ~ 222m)
  const approachLat = 16.022;
  const approachLng = 120.23;

  let qHighXpId = '';
  let qLowXpId = '';
  let qCompletedId = '';
  let qDraftId = '';
  let qApproachId = '';

  async function createPublishedQuiz(opts: {
    destinationId: string;
    title: string;
    radiusMeters: number;
    xpReward: number;
    publish?: boolean;
  }): Promise<string> {
    const createRes = await request(app)
      .post('/api/v1/admin/quizzes')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        destination_id: opts.destinationId,
        title: opts.title,
        description: `Description for ${opts.title}`,
        language: 'en',
        radius_meters: opts.radiusMeters,
        xp_reward: opts.xpReward,
        time_limit_minutes: 10,
        cooldown_hours: 24,
        questions: [1, 2, 3, 4, 5].map((ord) => ({
          ordinal: ord,
          question_text: `${opts.title} Q${ord}?`,
          explanation: 'Test explanation',
          options: [
            { ordinal: 1, option_text: 'A', is_correct: true },
            { ordinal: 2, option_text: 'B', is_correct: false },
            { ordinal: 3, option_text: 'C', is_correct: false },
            { ordinal: 4, option_text: 'D', is_correct: false },
          ],
        })),
      });
    expect(createRes.status).toBe(201);
    const quizId = createRes.body.data.quiz.id as string;

    if (opts.publish !== false) {
      const pubRes = await request(app)
        .post(`/api/v1/admin/quizzes/${quizId}/publish`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});
      expect(pubRes.status).toBe(200);
    }

    return quizId;
  }

  beforeAll(async () => {
    testDb = await createTestDb();
    setPool(testDb.pool);
    await db.hydrateFromPg(testDb.pool);

    await testDb.pool.query(
      `INSERT INTO users (id, seed_id, display_name, email, role)
       VALUES
         ($1, 'plan91a-admin-seed', 'Admin 91a', 'admin91a@juanderquest.app', 'admin'),
         ($2, 'plan91a-traveler-seed', 'Traveler 91a', 'traveler91a@juanderquest.app', 'user')
       ON CONFLICT (id) DO NOTHING`,
      [adminUserId, travelerUserId],
    );

    await testDb.pool.query(
      `INSERT INTO spots (
         id, slug, name, description, category, subcategory, municipality, address,
         gps_lat, gps_lng, price_level, source_type, source_name, trust_level, status
       ) VALUES
         ($1, 'plan91a-main', 'Lingayen Capitol', 'Heritage Capitol', 'culture_heritage', 'heritage_site', 'Lingayen', 'Lingayen, Pangasinan', $3, $4, 1, 'lgu', 'LGU', 'lgu_verified', 'published'),
         ($2, 'plan91a-approach', 'Lingayen Park', 'Park nearby', 'nature_parks', 'park', 'Lingayen', 'Lingayen, Pangasinan', $5, $6, 1, 'lgu', 'LGU', 'lgu_verified', 'published')
       ON CONFLICT (id) DO NOTHING`,
      [spotMainId, spotApproachId, mainLat, mainLng, approachLat, approachLng],
    );

    // 3 published quizzes at spotMainId + 1 draft
    qLowXpId = await createPublishedQuiz({
      destinationId: spotMainId,
      title: 'Capitol Basics',
      radiusMeters: 100,
      xpReward: 20,
    });
    qHighXpId = await createPublishedQuiz({
      destinationId: spotMainId,
      title: 'Capitol Deep Dive',
      radiusMeters: 100,
      xpReward: 60,
    });
    qCompletedId = await createPublishedQuiz({
      destinationId: spotMainId,
      title: 'Capitol Completed',
      radiusMeters: 100,
      xpReward: 90,
    });
    qDraftId = await createPublishedQuiz({
      destinationId: spotMainId,
      title: 'Capitol Draft Only',
      radiusMeters: 100,
      xpReward: 100,
      publish: false,
    });

    // 1 published quiz at spotApproachId (~222m away, radius 100m)
    qApproachId = await createPublishedQuiz({
      destinationId: spotApproachId,
      title: 'Park Approaching Quiz',
      radiusMeters: 100,
      xpReward: 40,
    });

    // Mark qCompletedId as completed for travelerUserId via real attempt submission
    const startRes = await request(app)
      .post(`/api/v1/quizzes/${qCompletedId}/attempts`)
      .set('Authorization', `Bearer ${travelerToken}`)
      .send({ lat: mainLat, lng: mainLng });
    expect(startRes.status).toBe(201);
    const attemptId = startRes.body.data.attempt.id as string;
    const questions = startRes.body.data.questions as Array<{
      id: string;
      options: Array<{ id: string; option_text: string }>;
    }>;
    const submitRes = await request(app)
      .put(`/api/v1/quiz-attempts/${attemptId}/submission`)
      .set('Authorization', `Bearer ${travelerToken}`)
      .send({
        answers: questions.map((q) => ({
          question_id: q.id,
          selected_option_id: q.options.find((o) => o.option_text === 'A')!.id,
        })),
      });
    expect(submitRes.status).toBe(200);
    expect(submitRes.body.data.passed).toBe(true);
  });

  afterAll(async () => {
    setPool(null);
    await testDb.close();
  });

  it('sets in_range at the exact radius boundary and respects +50m vs +500m cutoff', async () => {
    // At main spot (0m away, radius 100m -> in_range: true)
    // spotApproachId is ~222m away (radius 100m -> excluded without include_approaching)
    const defaultRes = await request(app).post('/api/v1/quizzes/nearby').send({ lat: mainLat, lng: mainLng });
    expect(defaultRes.status).toBe(200);
    const defaultIds = (defaultRes.body.data as Array<{ quiz_id: string }>).map((q) => q.quiz_id);
    expect(defaultIds).toContain(qHighXpId);
    expect(defaultIds).not.toContain(qApproachId);
    expect(defaultIds).not.toContain(qDraftId);

    // 0.0011 deg lat ~ 122m from main spot:
    // radius_meters=100 -> in_range: false, but <= 100+50 (150m), so included in default!
    const bufferLat = mainLat + 0.0011;
    const bufferRes = await request(app).post('/api/v1/quizzes/nearby').send({ lat: bufferLat, lng: mainLng });
    expect(bufferRes.status).toBe(200);
    const mainFromBuffer = (bufferRes.body.data as Array<any>).find((q) => q.quiz_id === qHighXpId);
    expect(mainFromBuffer).toBeDefined();
    expect(mainFromBuffer.distance_meters).toBeGreaterThan(100);
    expect(mainFromBuffer.in_range).toBe(false);

    // With include_approaching: true at mainLat/mainLng, spotApproachId (~222m <= 100+500) IS returned with in_range: false
    const approachRes = await request(app)
      .post('/api/v1/quizzes/nearby')
      .send({ lat: mainLat, lng: mainLng, include_approaching: true });
    expect(approachRes.status).toBe(200);
    const approachQuiz = (approachRes.body.data as Array<any>).find((q) => q.quiz_id === qApproachId);
    expect(approachQuiz).toBeDefined();
    expect(approachQuiz.in_range).toBe(false);
  });

  it('sorts nearby quizzes: incomplete first, in_range first, distance asc, xp_reward desc', async () => {
    const res = await request(app)
      .post('/api/v1/quizzes/nearby')
      .set('Authorization', `Bearer ${travelerToken}`)
      .send({ lat: mainLat, lng: mainLng, include_approaching: true });

    expect(res.status).toBe(200);
    const ids = (res.body.data as Array<{ quiz_id: string }>).map((q) => q.quiz_id);

    // Expected order:
    // 1. qHighXpId (incomplete, in_range=true, 0m, 60 XP)
    // 2. qLowXpId  (incomplete, in_range=true, 0m, 20 XP)
    // 3. qApproachId (incomplete, in_range=false, ~222m, 40 XP)
    // 4. qCompletedId (is_completed=true, in_range=true, 0m, 90 XP)
    expect(ids.indexOf(qHighXpId)).toBeLessThan(ids.indexOf(qLowXpId));
    expect(ids.indexOf(qLowXpId)).toBeLessThan(ids.indexOf(qApproachId));
    expect(ids.indexOf(qApproachId)).toBeLessThan(ids.indexOf(qCompletedId));
  });

  it('GET /api/v1/spots/:id/quizzes returns published quizzes and includes is_completed when signed in', async () => {
    const guestRes = await request(app).get(`/api/v1/spots/${spotMainId}/quizzes`);
    expect(guestRes.status).toBe(200);
    const guestRows = guestRes.body.data as Array<Record<string, unknown>>;
    expect(guestRows.length).toBe(3);
    expect(guestRows.some((q) => q.quiz_id === qDraftId)).toBe(false);
    expect(guestRows[0]).not.toHaveProperty('is_completed');

    const authRes = await request(app)
      .get(`/api/v1/spots/${spotMainId}/quizzes`)
      .set('Authorization', `Bearer ${travelerToken}`);
    expect(authRes.status).toBe(200);
    const authRows = authRes.body.data as Array<Record<string, unknown>>;
    expect(authRows.length).toBe(3);
    const completedRow = authRows.find((q) => q.quiz_id === qCompletedId);
    const incompleteRow = authRows.find((q) => q.quiz_id === qHighXpId);
    expect(completedRow?.is_completed).toBe(true);
    expect(incompleteRow?.is_completed).toBe(false);
  });
});
