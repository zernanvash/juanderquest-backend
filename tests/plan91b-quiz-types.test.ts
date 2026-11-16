import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { app } from '../src/app.js';
import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { setPool } from '../src/db/pool.js';
import { db } from '../src/db/index.js';
import { env } from '../src/config/env.js';

describe('Plan 91b: Quiz Question Types, Validation, Shuffle & Grading (Real PG)', () => {
  let testDb: TestDbInstance;
  const adminId = `admin-91b-${randomUUID().slice(0, 8)}`;
  const travelerId = `traveler-91b-${randomUUID().slice(0, 8)}`;
  const adminToken = jwt.sign(
    { id: adminId, seed_id: 'plan91b-admin-seed', role: 'admin', typ: 'session' },
    env.JWT_SECRET,
  );
  const travelerToken = jwt.sign(
    { id: travelerId, seed_id: 'plan91b-traveler-seed', role: 'user', typ: 'session' },
    env.JWT_SECRET,
  );
  const spotId = `spot-91b-${randomUUID().slice(0, 8)}`;
  const spotPhotoUrl = 'https://juanderquest.app/media/spot-91b-real.jpg';
  const spotLat = 16.0209;
  const spotLng = 120.2317;

  beforeAll(async () => {
    testDb = await createTestDb();
    setPool(testDb.pool);
    await db.hydrateFromPg(testDb.pool);

    await testDb.pool.query(
      `INSERT INTO users (id, seed_id, display_name, email, role)
       VALUES ($1, 'plan91b-admin-seed', 'Admin 91b', 'admin91b@example.com', 'admin'),
              ($2, 'plan91b-traveler-seed', 'Traveler 91b', 'traveler91b@example.com', 'user')
       ON CONFLICT (id) DO NOTHING`,
      [adminId, travelerId],
    );

    await testDb.pool.query(
      `INSERT INTO spots (id, slug, name, description, category, subcategory, municipality, address, gps_lat, gps_lng, price_level, image_url, source_type, source_name, trust_level, status)
       VALUES ($1, $2, 'Capitol 91b Spot', 'Test spot for 91b', 'culture_heritage', 'heritage_site', 'Lingayen', 'Lingayen, Pangasinan', $3, $4, 1, '', 'lgu', 'LGU', 'lgu_verified', 'published')`,
      [spotId, spotId, spotLat, spotLng],
    );

    await testDb.pool.query(
      `INSERT INTO spot_assets (id, user_id, storage_provider, object_key, url, mime_type, status, spot_id)
       VALUES ($1, $2, 'local', '91b/real.jpg', $3, 'image/jpeg', 'attached', $4)`,
      [randomUUID(), adminId, spotPhotoUrl, spotId],
    );
  }, 30000);

  afterAll(async () => {
    setPool(null);
    await testDb.close();
  });

  function buildMixedQuestions(overrides?: Partial<Record<number, any>>) {
    const base = [
      {
        ordinal: 1,
        question_type: 'multiple_choice',
        question_text: 'MC Question 1',
        explanation: 'MC explanation',
        options: [
          { ordinal: 1, option_text: 'MC A', is_correct: true },
          { ordinal: 2, option_text: 'MC B', is_correct: false },
          { ordinal: 3, option_text: 'MC C', is_correct: false },
          { ordinal: 4, option_text: 'MC D', is_correct: false },
        ],
      },
      {
        ordinal: 2,
        question_type: 'true_false',
        question_text: 'TF Question 2',
        explanation: 'TF explanation',
        options: [
          { ordinal: 1, option_text: 'Fact', is_correct: true },
          { ordinal: 2, option_text: 'Myth', is_correct: false },
        ],
      },
      {
        ordinal: 3,
        question_type: 'photo_clue',
        media_url: spotPhotoUrl,
        question_text: 'Photo Clue Question 3',
        explanation: 'Photo explanation',
        options: [
          { ordinal: 1, option_text: 'Photo A', is_correct: false },
          { ordinal: 2, option_text: 'Photo B', is_correct: true },
          { ordinal: 3, option_text: 'Photo C', is_correct: false },
          { ordinal: 4, option_text: 'Photo D', is_correct: false },
        ],
      },
      {
        ordinal: 4,
        question_type: 'sequence_order',
        question_text: 'Sequence Order Question 4',
        explanation: 'Sequence explanation',
        options: [
          { ordinal: 1, option_text: 'First Event', is_correct: false },
          { ordinal: 2, option_text: 'Second Event', is_correct: false },
          { ordinal: 3, option_text: 'Third Event', is_correct: false },
        ],
      },
      {
        ordinal: 5,
        question_type: 'multiple_choice',
        question_text: 'MC Question 5',
        explanation: 'MC5 explanation',
        options: [
          { ordinal: 1, option_text: 'MC5 A', is_correct: false },
          { ordinal: 2, option_text: 'MC5 B', is_correct: false },
          { ordinal: 3, option_text: 'MC5 C', is_correct: true },
          { ordinal: 4, option_text: 'MC5 D', is_correct: false },
        ],
      },
    ];
    if (overrides) {
      for (const [idx, patch] of Object.entries(overrides)) {
        base[Number(idx)] = { ...base[Number(idx)], ...patch };
      }
    }
    return base;
  }

  it('migration 086 preserves existing quizzes with default question_type', async () => {
    const legacyQuizId = randomUUID();
    const legacyVerId = randomUUID();
    const legacyScopeId = randomUUID();
    const legacyQId = randomUUID();

    await testDb.pool.query(
      `INSERT INTO cultural_quizzes (id, destination_id, reward_scope_id, status, current_version)
       VALUES ($1, $2, $3, 'published', 1)`,
      [legacyQuizId, spotId, legacyScopeId],
    );
    await testDb.pool.query(
      `INSERT INTO cultural_quiz_versions (id, quiz_id, version, title, description, language, radius_meters, xp_reward, time_limit_minutes, cooldown_hours)
       VALUES ($1, $2, 1, 'Legacy Quiz', 'Legacy quiz compatibility check', 'en', 250, 25, 10, 24)`,
      [legacyVerId, legacyQuizId],
    );
    await testDb.pool.query(
      `INSERT INTO cultural_quiz_questions (id, version_id, ordinal, question_text, explanation)
       VALUES ($1, $2, 1, 'Legacy Question', 'Legacy Exp')`,
      [legacyQId, legacyVerId],
    );
    const { rows } = await testDb.pool.query(
      `SELECT question_type, media_url FROM cultural_quiz_questions WHERE id = $1`,
      [legacyQId],
    );
    expect(rows[0].question_type).toBe('multiple_choice');
    expect(rows[0].media_url).toBeNull();
  });

  it('accepts a photo_clue that uses a relative uploads path, as live spot photos are stored', async () => {
    const relativePhoto = '/api/v1/uploads/spot-photos/catalog-91b-relative.jpg';
    await testDb.pool.query(
      `INSERT INTO spot_assets (id, user_id, storage_provider, object_key, url, mime_type, status, spot_id)
       VALUES ($1, $2, 'local', 'catalog-91b-relative.jpg', $3, 'image/jpeg', 'attached', $4)`,
      [randomUUID(), adminId, relativePhoto, spotId],
    );
    const created = await request(app)
      .post('/api/v1/admin/quizzes')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        destination_id: spotId,
        title: 'Relative Photo Quiz',
        description: 'Photo clue using a stored relative spot photo path',
        questions: buildMixedQuestions({ 2: { media_url: relativePhoto } }),
      });
    expect(created.status).toBe(201);
  });

  it('validates per-type rules and photo_clue spot photo ownership on create and update', async () => {
    // Reject non-spot photo_clue URL on create
    const badPhoto = await request(app)
      .post('/api/v1/admin/quizzes')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        destination_id: spotId,
        title: 'Bad Photo Quiz',
        description: 'Testing photo_clue spot ownership validation',
        questions: buildMixedQuestions({
          2: { media_url: 'https://evil.example.com/not-a-spot-photo.jpg' },
        }),
      });
    expect(badPhoto.status).toBe(400);
    expect(badPhoto.body.error.code).toBe('INVALID_PHOTO_CLUE');

    // Reject true_false with 3 options
    const badTf = await request(app)
      .post('/api/v1/admin/quizzes')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        destination_id: spotId,
        title: 'Bad TF Quiz',
        description: 'Testing true_false 2 option constraint',
        questions: buildMixedQuestions({
          1: {
            options: [
              { ordinal: 1, option_text: 'Fact', is_correct: true },
              { ordinal: 2, option_text: 'Myth', is_correct: false },
              { ordinal: 3, option_text: 'Extra', is_correct: false },
            ],
          },
        }),
      });
    expect(badTf.status).toBe(400);

    // Valid create with all 4 types
    const created = await request(app).post('/api/v1/admin/quizzes').set('Authorization', `Bearer ${adminToken}`).send({
      destination_id: spotId,
      title: 'Mixed 91b Quiz',
      description: 'All four Plan 91b question types in one quiz',
      questions: buildMixedQuestions(),
    });
    expect(created.status).toBe(201);
    const quizId = created.body.data.quiz.id;

    // Reject invalid photo_clue on updateQuizDraft
    const badUpdate = await request(app)
      .patch(`/api/v1/admin/quizzes/${quizId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        destination_id: spotId,
        title: 'Mixed 91b Quiz Updated',
        description: 'Updated description for draft validation',
        questions: buildMixedQuestions({
          2: { media_url: 'https://other.example.com/bad.jpg' },
        }),
      });
    expect(badUpdate.status).toBe(400);
  });

  it('keeps sequence_order shuffle deterministic on resume without ordinal, enforces 50/50 rules, rejects malformed answers, and grades sequence right/wrong', async () => {
    const created = await request(app).post('/api/v1/admin/quizzes').set('Authorization', `Bearer ${adminToken}`).send({
      destination_id: spotId,
      title: 'Playable Mixed Quiz',
      description: 'Quiz for attempt, shuffle, lifeline, and grading verification',
      questions: buildMixedQuestions(),
    });
    expect(created.status).toBe(201);
    const quizId = created.body.data.quiz.id;

    const pub = await request(app)
      .post(`/api/v1/admin/quizzes/${quizId}/publish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(pub.status).toBe(200);

    // Start attempt
    const startRes = await request(app)
      .post(`/api/v1/quizzes/${quizId}/attempts`)
      .set('Authorization', `Bearer ${travelerToken}`)
      .send({ lat: spotLat, lng: spotLng });
    expect(startRes.status).toBe(201);
    const attemptId = startRes.body.data.attempt.id;
    const startQuestions = startRes.body.data.questions;
    const seqStart = startQuestions[3];
    expect(seqStart.question_type).toBe('sequence_order');
    for (const opt of seqStart.options) {
      expect(opt.ordinal).toBeUndefined();
      expect(opt.is_correct).toBeUndefined();
    }

    // Resume via GET /quiz-attempts/:id -> identical shuffle order, still no ordinal
    const resumeRes = await request(app)
      .get(`/api/v1/quiz-attempts/${attemptId}`)
      .set('Authorization', `Bearer ${travelerToken}`);
    expect(resumeRes.status).toBe(200);
    const seqResume = resumeRes.body.data.questions[3];
    expect(seqResume.options.map((o: any) => o.id)).toEqual(seqStart.options.map((o: any) => o.id));
    for (const opt of seqResume.options) {
      expect(opt.ordinal).toBeUndefined();
    }

    // 50/50 refused on true_false and sequence_order with 400
    const tfLifeline = await request(app)
      .post(`/api/v1/quizzes/${quizId}/attempts/${attemptId}/lifeline`)
      .set('Authorization', `Bearer ${travelerToken}`)
      .send({ lifeline: 'fifty_fifty', question_id: startQuestions[1].id });
    expect(tfLifeline.status).toBe(400);
    expect(tfLifeline.body.error.code).toBe('LIFELINE_NOT_AVAILABLE');

    const seqLifeline = await request(app)
      .post(`/api/v1/quizzes/${quizId}/attempts/${attemptId}/lifeline`)
      .set('Authorization', `Bearer ${travelerToken}`)
      .send({ lifeline: 'fifty_fifty', question_id: seqStart.id });
    expect(seqLifeline.status).toBe(400);
    expect(seqLifeline.body.error.code).toBe('LIFELINE_NOT_AVAILABLE');

    // Malformed answer: selected_option_id sent for sequence_order -> 400
    const wrongPayload = await request(app)
      .put(`/api/v1/quiz-attempts/${attemptId}/submission`)
      .set('Authorization', `Bearer ${travelerToken}`)
      .send({
        answers: [
          { question_id: startQuestions[0].id, selected_option_id: startQuestions[0].options[0].id },
          { question_id: startQuestions[1].id, selected_option_id: startQuestions[1].options[0].id },
          { question_id: startQuestions[2].id, selected_option_id: startQuestions[2].options[1].id },
          { question_id: seqStart.id, selected_option_id: seqStart.options[0].id },
          { question_id: startQuestions[4].id, selected_option_id: startQuestions[4].options[2].id },
        ],
      });
    expect(wrongPayload.status).toBe(400);

    // Duplicate option IDs in sequence_order -> 400
    const dupSeq = await request(app)
      .put(`/api/v1/quiz-attempts/${attemptId}/submission`)
      .set('Authorization', `Bearer ${travelerToken}`)
      .send({
        answers: [
          { question_id: startQuestions[0].id, selected_option_id: startQuestions[0].options[0].id },
          { question_id: startQuestions[1].id, selected_option_id: startQuestions[1].options[0].id },
          { question_id: startQuestions[2].id, selected_option_id: startQuestions[2].options[1].id },
          {
            question_id: seqStart.id,
            ordered_option_ids: [seqStart.options[0].id, seqStart.options[0].id, seqStart.options[1].id],
          },
          { question_id: startQuestions[4].id, selected_option_id: startQuestions[4].options[2].id },
        ],
      });
    expect(dupSeq.status).toBe(400);

    // Submit with exact correct sequence order -> 5/5 passed
    const firstId = seqStart.options.find((o: any) => o.option_text === 'First Event').id;
    const secondId = seqStart.options.find((o: any) => o.option_text === 'Second Event').id;
    const thirdId = seqStart.options.find((o: any) => o.option_text === 'Third Event').id;

    const passRes = await request(app)
      .put(`/api/v1/quiz-attempts/${attemptId}/submission`)
      .set('Authorization', `Bearer ${travelerToken}`)
      .send({
        answers: [
          { question_id: startQuestions[0].id, selected_option_id: startQuestions[0].options[0].id },
          { question_id: startQuestions[1].id, selected_option_id: startQuestions[1].options[0].id },
          { question_id: startQuestions[2].id, selected_option_id: startQuestions[2].options[1].id },
          { question_id: seqStart.id, ordered_option_ids: [firstId, secondId, thirdId] },
          { question_id: startQuestions[4].id, selected_option_id: startQuestions[4].options[2].id },
        ],
      });
    expect(passRes.status).toBe(200);
    expect(passRes.body.data.score).toBe(5);
    expect(passRes.body.data.passed).toBe(true);
    expect(passRes.body.data.breakdown[3].is_correct).toBe(true);
    expect(passRes.body.data.breakdown[3].correct_order.map((o: any) => o.option_text)).toEqual([
      'First Event',
      'Second Event',
      'Third Event',
    ]);

    // Wrong sequence order in another attempt -> sequence graded false
    const start2 = await request(app)
      .post(`/api/v1/quizzes/${quizId}/attempts`)
      .set('Authorization', `Bearer ${travelerToken}`)
      .send({ lat: spotLat, lng: spotLng });
    expect(start2.status).toBe(201);
    const q2 = start2.body.data.questions;
    const seq2 = q2[3];
    const f2 = seq2.options.find((o: any) => o.option_text === 'First Event').id;
    const s2 = seq2.options.find((o: any) => o.option_text === 'Second Event').id;
    const t2 = seq2.options.find((o: any) => o.option_text === 'Third Event').id;

    const wrongSeqRes = await request(app)
      .put(`/api/v1/quiz-attempts/${start2.body.data.attempt.id}/submission`)
      .set('Authorization', `Bearer ${travelerToken}`)
      .send({
        answers: [
          { question_id: q2[0].id, selected_option_id: q2[0].options[0].id },
          { question_id: q2[1].id, selected_option_id: q2[1].options[0].id },
          { question_id: q2[2].id, selected_option_id: q2[2].options[1].id },
          { question_id: seq2.id, ordered_option_ids: [t2, s2, f2] },
          { question_id: q2[4].id, selected_option_id: q2[4].options[2].id },
        ],
      });
    expect(wrongSeqRes.status).toBe(200);
    expect(wrongSeqRes.body.data.score).toBe(4);
    expect(wrongSeqRes.body.data.breakdown[3].is_correct).toBe(false);
    expect(wrongSeqRes.body.data.breakdown[3].correct_order.map((o: any) => o.option_text)).toEqual([
      'First Event',
      'Second Event',
      'Third Event',
    ]);
  });
});
