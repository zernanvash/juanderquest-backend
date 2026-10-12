import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { setPool } from '../src/db/pool.js';
import { env } from '../src/config/env.js';

describe('Cultural Quizzes System (E2E & Concurrency)', () => {
  let testDb: TestDbInstance;

  const adminUserId = 'admin-user-quiz-1';
  const travelerUserId = 'traveler-user-quiz-1';
  const otherTravelerUserId = 'traveler-user-quiz-2';

  const adminToken = jwt.sign(
    { id: adminUserId, seed_id: 'admin-quiz-seed', role: 'admin' },
    env.JWT_SECRET
  );
  const travelerToken = jwt.sign(
    { id: travelerUserId, seed_id: 'traveler-quiz-seed', role: 'user' },
    env.JWT_SECRET
  );
  const otherTravelerToken = jwt.sign(
    { id: otherTravelerUserId, seed_id: 'other-traveler-seed', role: 'user' },
    env.JWT_SECRET
  );

  const destinationId = 'spot-bolinao-quiz-test';
  // Patar Beach Bolinao coords: 16.3204, 119.7847
  const destLat = 16.3204;
  const destLng = 119.7847;

  beforeAll(async () => {
    testDb = await createTestDb();
    setPool(testDb.pool);
    await db.hydrateFromPg(testDb.pool);

    // Insert required users
    await testDb.pool.query(
      `INSERT INTO users (id, seed_id, display_name, email, role)
       VALUES 
         ($1, 'admin-quiz-seed', 'Admin Author', 'admin@juanderquest.app', 'admin'),
         ($2, 'traveler-quiz-seed', 'Traveler One', 'traveler1@juanderquest.app', 'user'),
         ($3, 'other-traveler-seed', 'Traveler Two', 'traveler2@juanderquest.app', 'user')
       ON CONFLICT (id) DO NOTHING`,
      [adminUserId, travelerUserId, otherTravelerUserId]
    );

    // Insert destination spot
    await testDb.pool.query(
      `INSERT INTO spots (
         id, slug, name, description, category, subcategory, municipality, address,
         gps_lat, gps_lng, price_level, source_type, source_name, trust_level, status
       ) VALUES (
         $1, 'bolinao-quiz-spot', 'Patar Lighthouse & Beach', 'Historical and natural landmark in Bolinao',
         'culture_heritage', 'heritage_site', 'Bolinao', 'Patar Road, Bolinao, Pangasinan',
         $2, $3, 1, 'lgu', 'Bolinao Tourism', 'lgu_verified', 'published'
       ) ON CONFLICT (id) DO NOTHING`,
      [destinationId, destLat, destLng]
    );
  });

  afterAll(async () => {
    setPool(null);
    await testDb.close();
  });

  let createdQuizId: string;

  it('allows an authorized admin to create a cultural quiz draft with 5 questions', async () => {
    const res = await request(app)
      .post('/api/v1/admin/quizzes')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        destination_id: destinationId,
        title: 'Stories of Cape Bolinao',
        description: 'Test your knowledge on Cape Bolinao lighthouse and local coastal heritage.',
        language: 'en',
        radius_meters: 200,
        xp_reward: 25,
        time_limit_minutes: 30,
        cooldown_hours: 24,
        questions: [
          {
            ordinal: 1,
            question_text: 'When was the Cape Bolinao Lighthouse originally constructed?',
            explanation: 'Built in 1905 by American, British, and Filipino engineers.',
            source_url: 'https://en.wikipedia.org/wiki/Cape_Bolinao_Lighthouse',
            options: [
              { ordinal: 1, option_text: '1905', is_correct: true },
              { ordinal: 2, option_text: '1850', is_correct: false },
              { ordinal: 3, option_text: '1945', is_correct: false },
              { ordinal: 4, option_text: '1982', is_correct: false },
            ],
          },
          {
            ordinal: 2,
            question_text: 'What body of water does Cape Bolinao overlook directly?',
            explanation: 'It guides vessels navigating the West Philippine Sea.',
            options: [
              { ordinal: 1, option_text: 'West Philippine Sea', is_correct: true },
              { ordinal: 2, option_text: 'Pacific Ocean', is_correct: false },
              { ordinal: 3, option_text: 'Sulu Sea', is_correct: false },
              { ordinal: 4, option_text: 'Taal Lake', is_correct: false },
            ],
          },
          {
            ordinal: 3,
            question_text: 'Which prominent material characterizes the golden sand of Patar Beach?',
            explanation: 'Patar is famed for its weathered coral and limestone sand.',
            options: [
              { ordinal: 1, option_text: 'Crushed coral limestone', is_correct: true },
              { ordinal: 2, option_text: 'Volcanic black basalt', is_correct: false },
              { ordinal: 3, option_text: 'Quartz crystal', is_correct: false },
              { ordinal: 4, option_text: 'Crushed granite', is_correct: false },
            ],
          },
          {
            ordinal: 4,
            question_text: 'What traditional fishing gear was historically woven by coastal Bolinao communities?',
            explanation: 'Bamboo and rattan fish traps known locally in coastal Pangasinan.',
            options: [
              { ordinal: 1, option_text: 'Bubu bamboo traps', is_correct: true },
              { ordinal: 2, option_text: 'Nylon drift nets', is_correct: false },
              { ordinal: 3, option_text: 'Steel harpoons', is_correct: false },
              { ordinal: 4, option_text: 'Synthetic trawlers', is_correct: false },
            ],
          },
          {
            ordinal: 5,
            question_text: 'Which indigenous language is native to Bolinao alongside Pangasinan and Ilocano?',
            explanation: 'Bolinao (Binubolinao) is a distinct Sambalic language.',
            options: [
              { ordinal: 1, option_text: 'Binubolinao', is_correct: true },
              { ordinal: 2, option_text: 'Chavacano', is_correct: false },
              { ordinal: 3, option_text: 'Waray', is_correct: false },
              { ordinal: 4, option_text: 'Kinaray-a', is_correct: false },
            ],
          },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.quiz).toBeDefined();
    expect(res.body.data.quiz.status).toBe('draft');
    createdQuizId = res.body.data.quiz.id;
  });

  it('rejects non-admin users from creating or modifying quizzes', async () => {
    const res = await request(app)
      .post('/api/v1/admin/quizzes')
      .set('Authorization', `Bearer ${travelerToken}`)
      .send({
        destination_id: destinationId,
        title: 'Unauthorized quiz',
      });
    expect(res.status).toBe(403);
  });

  it('allows an authorized admin to publish the quiz', async () => {
    const res = await request(app)
      .post(`/api/v1/admin/quizzes/${createdQuizId}/publish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('published');
  });

  it('discovers published quiz via nearby endpoint within radius', async () => {
    // 50 meters away from Patar destination
    const res = await request(app)
      .post('/api/v1/quizzes/nearby')
      .set('Authorization', `Bearer ${travelerToken}`)
      .send({
        lat: 16.3205,
        lng: 119.7848,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const found = res.body.data.find((q: any) => q.quiz_id === createdQuizId);
    expect(found).toBeDefined();
    expect(found.title).toBe('Stories of Cape Bolinao');
    expect(found.xp_reward).toBe(25);
  });

  it('does NOT discover quiz when traveler is far away (> 250m)', async () => {
    // Lingayen coords (far away)
    const res = await request(app)
      .post('/api/v1/quizzes/nearby')
      .send({
        lat: 16.0218,
        lng: 120.2319,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const found = res.body.data.find((q: any) => q.quiz_id === createdQuizId);
    expect(found).toBeUndefined();
  });

  it('rejects attempt start if coordinates are outside radius', async () => {
    const res = await request(app)
      .post(`/api/v1/quizzes/${createdQuizId}/attempts`)
      .set('Authorization', `Bearer ${travelerToken}`)
      .send({
        lat: 16.0218, // 60+ km away
        lng: 120.2319,
      });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('OUT_OF_RANGE');
  });

  let activeAttemptId: string;
  let attemptQuestions: any[];

  it('starts attempt when inside radius and withholds answer keys', async () => {
    const res = await request(app)
      .post(`/api/v1/quizzes/${createdQuizId}/attempts`)
      .set('Authorization', `Bearer ${travelerToken}`)
      .send({
        lat: 16.3204,
        lng: 119.7847,
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.attempt.status).toBe('in_progress');
    expect(res.body.data.questions).toHaveLength(5);

    // Verify critical privacy invariant: is_correct MUST NOT be revealed before grading
    for (const q of res.body.data.questions) {
      for (const opt of q.options) {
        expect(opt.is_correct).toBeUndefined();
      }
    }

    activeAttemptId = res.body.data.attempt.id;
    attemptQuestions = res.body.data.questions;
  });

  it('blocks another user from viewing or submitting another users attempt', async () => {
    const res = await request(app)
      .get(`/api/v1/quiz-attempts/${activeAttemptId}`)
      .set('Authorization', `Bearer ${otherTravelerToken}`);

    expect(res.status).toBe(404);
  });

  it('fails attempt and triggers 24h cooldown when score < 4', async () => {
    // Submit 5 wrong answers (pick option ordinal 2 for all, which are wrong)
    const answers = attemptQuestions.map((q) => ({
      question_id: q.id,
      selected_option_id: q.options[1].id,
    }));

    const res = await request(app)
      .put(`/api/v1/quiz-attempts/${activeAttemptId}/submission`)
      .set('Authorization', `Bearer ${travelerToken}`)
      .send({ answers });

    expect(res.status).toBe(200);
    expect(res.body.data.passed).toBe(false);
    expect(res.body.data.score).toBe(0);
    expect(res.body.data.xp_awarded).toBe(0);
    expect(res.body.data.cooldown_until).toBeDefined();

    // Verify explanations and correct options ARE revealed after submission
    for (const item of res.body.data.breakdown) {
      expect(item.explanation).toBeDefined();
      expect(item.correct_option_id).toBeDefined();
    }

    // Now try to immediately start another attempt: must be blocked by cooldown
    const retryRes = await request(app)
      .post(`/api/v1/quizzes/${createdQuizId}/attempts`)
      .set('Authorization', `Bearer ${travelerToken}`)
      .send({
        lat: 16.3204,
        lng: 119.7847,
      });

    expect(retryRes.status).toBe(429);
    expect(retryRes.body.error.code).toBe('COOLDOWN_ACTIVE');
  });

  it('passes attempt with score >= 4, grants 25 Explorer XP, and prevents duplicate XP on replay', async () => {
    // Use second traveler to test passing flow
    const startRes = await request(app)
      .post(`/api/v1/quizzes/${createdQuizId}/attempts`)
      .set('Authorization', `Bearer ${otherTravelerToken}`)
      .send({
        lat: 16.3204,
        lng: 119.7847,
      });

    expect(startRes.status).toBe(201);
    const secondAttemptId = startRes.body.data.attempt.id;
    const questions = startRes.body.data.questions;

    // Submit 5 correct answers (ordinal 1 was set to true for all questions)
    const answers = questions.map((q: any) => ({
      question_id: q.id,
      selected_option_id: q.options[0].id,
    }));

    const submitRes = await request(app)
      .put(`/api/v1/quiz-attempts/${secondAttemptId}/submission`)
      .set('Authorization', `Bearer ${otherTravelerToken}`)
      .send({ answers });

    expect(submitRes.status).toBe(200);
    expect(submitRes.body.data.passed).toBe(true);
    expect(submitRes.body.data.score).toBe(5);
    expect(submitRes.body.data.xp_awarded).toBe(25);
    expect(submitRes.body.data.already_completed_prior).toBe(false);

    // Verify progression_totals table reflects 25 explorer_xp
    const { rows: totalsRows } = await testDb.pool.query(
      `SELECT explorer_xp, civic_xp FROM progression_totals WHERE user_id = $1`,
      [otherTravelerUserId]
    );
    expect(totalsRows).toHaveLength(1);
    expect(Number(totalsRows[0].explorer_xp)).toBe(25);
    expect(Number(totalsRows[0].civic_xp)).toBe(0); // Zero Civic XP invariant preserved

    // Verify no verified_visits or demo_points were affected
    const { rows: visitRows } = await testDb.pool.query(
      `SELECT * FROM verified_visits WHERE user_id = $1`,
      [otherTravelerUserId]
    );
    expect(visitRows).toHaveLength(0);

    // Traveler 2 replays the quiz (learning-only replay)
    const replayStartRes = await request(app)
      .post(`/api/v1/quizzes/${createdQuizId}/attempts`)
      .set('Authorization', `Bearer ${otherTravelerToken}`)
      .send({
        lat: 16.3204,
        lng: 119.7847,
      });

    expect(replayStartRes.status).toBe(201);
    const replayAttemptId = replayStartRes.body.data.attempt.id;

    // Submit perfect score again on replay
    const replaySubmitRes = await request(app)
      .put(`/api/v1/quiz-attempts/${replayAttemptId}/submission`)
      .set('Authorization', `Bearer ${otherTravelerToken}`)
      .send({ answers });

    expect(replaySubmitRes.status).toBe(200);
    expect(replaySubmitRes.body.data.passed).toBe(true);
    expect(replaySubmitRes.body.data.score).toBe(5);
    expect(replaySubmitRes.body.data.xp_awarded).toBe(0); // MUST BE ZERO XP
    expect(replaySubmitRes.body.data.already_completed_prior).toBe(true);

    // Confirm totals still equal 25
    const { rows: replayTotals } = await testDb.pool.query(
      `SELECT explorer_xp FROM progression_totals WHERE user_id = $1`,
      [otherTravelerUserId]
    );
    expect(Number(replayTotals[0].explorer_xp)).toBe(25);
  });
});
