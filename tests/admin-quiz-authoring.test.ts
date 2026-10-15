import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { setPool } from '../src/db/pool.js';
import { env } from '../src/config/env.js';

const buildQuestions = () =>
  Array.from({ length: 5 }, (_, index) => ({
    ordinal: index + 1,
    question_text: `Question ${index + 1}?`,
    explanation: `Explanation ${index + 1}`,
    source_url: 'https://example.com/source',
    options: [
      { ordinal: 1, option_text: 'Option A', is_correct: true },
      { ordinal: 2, option_text: 'Option B', is_correct: false },
      { ordinal: 3, option_text: 'Option C', is_correct: false },
      { ordinal: 4, option_text: 'Option D', is_correct: false },
    ],
  }));

const buildDraftPayload = (destinationId: string, title: string) => ({
  destination_id: destinationId,
  title,
  description: 'A test cultural quiz draft for admin authoring acceptance.',
  language: 'en',
  radius_meters: 250,
  xp_reward: 25,
  time_limit_minutes: 30,
  cooldown_hours: 24,
  questions: buildQuestions(),
});

describe('Admin quiz authoring: detail, draft update, immutable published versions', () => {
  let testDb: TestDbInstance;

  const adminUserId = 'admin-quiz-authoring-1';
  const travelerUserId = 'traveler-quiz-authoring-1';

  const adminToken = jwt.sign({ id: adminUserId, seed_id: 'admin-quiz-authoring-seed', role: 'admin' }, env.JWT_SECRET);
  const travelerToken = jwt.sign({ id: travelerUserId, seed_id: 'traveler-quiz-authoring-seed', role: 'user' }, env.JWT_SECRET);

  const destinationId = 'spot-authoring-quiz-test';

  beforeAll(async () => {
    testDb = await createTestDb();
    setPool(testDb.pool);
    await db.hydrateFromPg(testDb.pool);

    await testDb.pool.query(
      `INSERT INTO users (id, seed_id, display_name, email, role)
       VALUES
         ($1, 'admin-quiz-authoring-seed', 'Admin Author', 'authoring-admin@juanderquest.app', 'admin'),
         ($2, 'traveler-quiz-authoring-seed', 'Traveler One', 'authoring-traveler@juanderquest.app', 'user')
       ON CONFLICT (id) DO NOTHING`,
      [adminUserId, travelerUserId]
    );

    await testDb.pool.query(
      `INSERT INTO spots (
         id, slug, name, description, category, subcategory, municipality, address,
         gps_lat, gps_lng, price_level, source_type, source_name, trust_level, status
       ) VALUES (
         $1, 'authoring-quiz-spot', 'Authoring Test Beach', 'Beach used for authoring tests',
         'nature_outdoors', 'beach', 'Bolinao', 'Test Road, Bolinao, Pangasinan',
         16.32, 119.78, 1, 'lgu', 'Bolinao Tourism', 'lgu_verified', 'published'
       ) ON CONFLICT (id) DO NOTHING`,
      [destinationId]
    );
  });

  afterAll(async () => {
    setPool(null);
    await testDb.close();
  });

  let quizId = '';

  it('creates a draft and returns it in admin detail with correctness metadata', async () => {
    const created = await request(app)
      .post('/api/v1/admin/quizzes')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(buildDraftPayload(destinationId, 'Authoring Draft One'));
    expect(created.status).toBe(201);
    quizId = created.body.data.quiz.id;
    expect(quizId).toBeTruthy();

    const detail = await request(app)
      .get(`/api/v1/admin/quizzes/${quizId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.quiz.status).toBe('draft');
    expect(detail.body.data.version.version).toBe(1);
    expect(detail.body.data.version.published_at).toBeNull();
    expect(detail.body.data.destination.id).toBe(destinationId);
    expect(detail.body.data.questions).toHaveLength(5);
    for (const question of detail.body.data.questions) {
      expect(question.options).toHaveLength(4);
      expect(question.options.filter((option: { is_correct: boolean }) => option.is_correct)).toHaveLength(1);
    }
  });

  it('updates an unpublished draft in place without creating a new version', async () => {
    const updated = await request(app)
      .patch(`/api/v1/admin/quizzes/${quizId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send(buildDraftPayload(destinationId, 'Authoring Draft One (revised)'));
    expect(updated.status).toBe(200);
    expect(updated.body.data.version.title).toBe('Authoring Draft One (revised)');
    expect(updated.body.data.version.version).toBe(1);
    expect(updated.body.data.questions).toHaveLength(5);
  });

  it('rejects malformed question sets on update', async () => {
    const payload = buildDraftPayload(destinationId, 'Authoring Draft Two');
    payload.questions = payload.questions.slice(0, 4) as typeof payload.questions;
    const response = await request(app)
      .patch(`/api/v1/admin/quizzes/${quizId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send(payload);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('refuses to edit a published version and keeps the published content intact', async () => {
    const published = await request(app)
      .post(`/api/v1/admin/quizzes/${quizId}/publish`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(published.status).toBe(200);
    expect(published.body.data.status).toBe('published');

    const attempt = await request(app)
      .patch(`/api/v1/admin/quizzes/${quizId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send(buildDraftPayload(destinationId, 'Should Not Apply'));
    expect(attempt.status).toBe(409);
    expect(attempt.body.error.code).toBe('QUIZ_IMMUTABLE');

    const detail = await request(app)
      .get(`/api/v1/admin/quizzes/${quizId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(detail.body.data.quiz.status).toBe('published');
    expect(detail.body.data.version.title).toBe('Authoring Draft One (revised)');
    expect(detail.body.data.version.published_at).not.toBeNull();
  });

  it('enforces administrator authorization and returns 404 for unknown quizzes', async () => {
    const deniedDetail = await request(app)
      .get(`/api/v1/admin/quizzes/${quizId}`)
      .set('Authorization', `Bearer ${travelerToken}`);
    expect(deniedDetail.status).toBe(403);

    const deniedUpdate = await request(app)
      .patch(`/api/v1/admin/quizzes/${quizId}`)
      .set('Authorization', `Bearer ${travelerToken}`)
      .send(buildDraftPayload(destinationId, 'Denied'));
    expect(deniedUpdate.status).toBe(403);

    const missing = await request(app)
      .get('/api/v1/admin/quizzes/does-not-exist')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('QUIZ_NOT_FOUND');
  });
});
