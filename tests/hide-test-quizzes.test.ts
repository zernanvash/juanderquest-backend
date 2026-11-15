import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { setPool } from '../src/db/pool.js';
import { env } from '../src/config/env.js';

// Owner 2026-11-15: test quizzes (is_test) are hidden from travelers; only test accounts see them.
describe('Test quizzes are visible only to test accounts', () => {
  let testDb: TestDbInstance;
  const realUser = 'hide-tq-real-user';
  const testUser = 'hide-tq-test-user';
  const spotId = 'hide-tq-spot';
  const realQuiz = 'hide-tq-real-quiz';
  const testQuiz = 'hide-tq-test-quiz';
  const lat = 16.3204;
  const lng = 119.7847;
  const token = (id: string) => jwt.sign({ id, seed_id: id, role: 'user', typ: 'session' }, env.JWT_SECRET);

  beforeAll(async () => {
    testDb = await createTestDb();
    setPool(testDb.pool);
    await db.hydrateFromPg(testDb.pool);
    await testDb.pool.query(
      `INSERT INTO users (id, seed_id, display_name, email, role, is_test) VALUES
         ($1::text, $1::text, 'Real Traveler', 'real-tq@example.test', 'user', FALSE),
         ($2::text, $2::text, 'Test Traveler', 'test-tq@example.test', 'user', TRUE)`,
      [realUser, testUser],
    );
    await testDb.pool.query(
      `INSERT INTO spots (id, slug, name, description, category, subcategory, municipality, address,
         gps_lat, gps_lng, source_type, source_name, status)
       VALUES ($1, $1, 'Quiz Beach', 'A beach with quizzes.', 'nature_outdoors', 'beach', 'Bolinao',
         'Bolinao, Pangasinan', $2, $3, 'lgu', 'Fixture', 'published')`,
      [spotId, lat, lng],
    );
    for (const [id, isTest, title] of [
      [realQuiz, false, 'Real quiz'],
      [testQuiz, true, 'Test quiz'],
    ] as const) {
      await testDb.pool.query(
        `INSERT INTO cultural_quizzes (id, destination_id, reward_scope_id, status, current_version, is_test)
         VALUES ($1, $2, gen_random_uuid(), 'published', 1, $3)`,
        [id, spotId, isTest],
      );
      await testDb.pool.query(
        `INSERT INTO cultural_quiz_versions (id, quiz_id, version, title, description, published_at)
         VALUES ($1 || '-v1', $1, 1, $2, 'Fixture quiz.', NOW())`,
        [id, title],
      );
    }
  });

  afterAll(async () => {
    setPool(null);
    await testDb.close();
  });

  const nearbyIds = async (auth?: string) => {
    const req = request(app).post('/api/v1/quizzes/nearby');
    if (auth) req.set('Authorization', `Bearer ${auth}`);
    const res = await req.send({ lat, lng });
    expect(res.status).toBe(200);
    return res.body.data.map((q: { quiz_id: string }) => q.quiz_id).sort();
  };

  const spotIds = async (auth?: string) => {
    const req = request(app).get(`/api/v1/spots/${spotId}/quizzes`);
    if (auth) req.set('Authorization', `Bearer ${auth}`);
    const res = await req;
    expect(res.status).toBe(200);
    return res.body.data.map((q: { quiz_id: string }) => q.quiz_id).sort();
  };

  it('lists only real quizzes for signed-out visitors and real travelers', async () => {
    expect(await nearbyIds()).toEqual([realQuiz]);
    expect(await nearbyIds(token(realUser))).toEqual([realQuiz]);
    expect(await spotIds()).toEqual([realQuiz]);
    expect(await spotIds(token(realUser))).toEqual([realQuiz]);
  });

  it('lists only test quizzes for test accounts', async () => {
    expect(await nearbyIds(token(testUser))).toEqual([testQuiz]);
    expect(await spotIds(token(testUser))).toEqual([testQuiz]);
  });

  it('hides quiz detail across the test boundary', async () => {
    expect((await request(app).get(`/api/v1/quizzes/${testQuiz}`)).status).toBe(404);
    expect(
      (
        await request(app)
          .get(`/api/v1/quizzes/${testQuiz}`)
          .set('Authorization', `Bearer ${token(realUser)}`)
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .get(`/api/v1/quizzes/${realQuiz}`)
          .set('Authorization', `Bearer ${token(testUser)}`)
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .get(`/api/v1/quizzes/${testQuiz}`)
          .set('Authorization', `Bearer ${token(testUser)}`)
      ).status,
    ).toBe(200);
  });

  it('refuses to start a test quiz for a real traveler', async () => {
    const res = await request(app)
      .post(`/api/v1/quizzes/${testQuiz}/attempts`)
      .set('Authorization', `Bearer ${token(realUser)}`)
      .send({ lat, lng });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
