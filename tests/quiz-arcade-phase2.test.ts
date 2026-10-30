import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { setPool } from '../src/db/pool.js';
import { env } from '../src/config/env.js';

describe('Cultural Quiz Arcade Phase 2 (Data Model, Lifelines & Scoring)', () => {
  let testDb: TestDbInstance;

  const adminUserId = 'admin-quiz-arcade-phase2';
  const travelerUserId = 'traveler-quiz-arcade-phase2';

  const adminToken = jwt.sign(
    { id: adminUserId, seed_id: 'admin-quiz-seed', role: 'admin' },
    env.JWT_SECRET
  );
  const travelerToken = jwt.sign(
    { id: travelerUserId, seed_id: 'traveler-quiz-seed', role: 'user' },
    env.JWT_SECRET
  );

  const destinationId = 'spot-bolinao-quiz-test-p2';
  const destLat = 16.3204;
  const destLng = 119.7847;

  let createdQuizId: string;
  let attemptId: string;
  let questions: any[] = [];

  beforeAll(async () => {
    testDb = await createTestDb();
    setPool(testDb.pool);
    await db.hydrateFromPg(testDb.pool);

    await testDb.pool.query(
      `INSERT INTO users (id, seed_id, display_name, email, role)
       VALUES 
         ($1, 'admin-quiz-seed', 'Admin Author', 'admin-p2@juanderquest.app', 'admin'),
         ($2, 'traveler-quiz-seed', 'Traveler One', 'traveler-p2@juanderquest.app', 'user')
       ON CONFLICT (id) DO NOTHING`,
      [adminUserId, travelerUserId]
    );

    await testDb.pool.query(
      `INSERT INTO spots (
         id, slug, name, description, category, subcategory, municipality, address,
         gps_lat, gps_lng, price_level, source_type, source_name, trust_level, status
       ) VALUES (
         $1, 'bolinao-quiz-arcade-spot', 'Cape Bolinao Lighthouse Arcade', 'Heritage lighthouse at Cape Bolinao.',
         'culture_heritage', 'heritage_site', 'Bolinao', 'Patar, Bolinao, Pangasinan',
         $2, $3, 1, 'lgu', 'Bolinao Tourism', 'lgu_verified', 'published'
       ) ON CONFLICT (id) DO NOTHING`,
      [destinationId, destLat, destLng]
    );
  });

  afterAll(async () => {
    setPool(null);
    await testDb.close();
  });

  it('allows an authorized admin to author a quiz draft with arcade host lines, theme, and diverse question types', async () => {
    const payload = {
      destination_id: destinationId,
      title: 'Cape Bolinao Arcade Odyssey',
      description: 'Journey through the historic maritime heritage of Cape Bolinao.',
      language: 'en',
      radius_meters: 500,
      xp_reward: 50,
      time_limit_minutes: 20,
      cooldown_hours: 12,
      theme: 'crt',
      host_lines: {
        intro: 'Welcome, young voyager, to the legendary Cape Bolinao beacon challenge!',
        cheer: 'Spectacular cultural deduction!',
        roast: 'The coastal fog seems to have clouded your judgement!',
      },
      questions: [
        {
          ordinal: 1,
          question_type: 'multiple_choice',
          question_text: 'In what decade was Cape Bolinao Lighthouse first lit?',
          explanation: 'It was built in 1905 by American and Filipino engineers.',
          hint: 'Think early 20th century right after the Spanish era.',
          round: 'main',
          options: [
            { ordinal: 1, option_text: '1880s', is_correct: false },
            { ordinal: 2, option_text: '1900s', is_correct: true },
            { ordinal: 3, option_text: '1930s', is_correct: false },
            { ordinal: 4, option_text: '1950s', is_correct: false },
          ],
        },
        {
          ordinal: 2,
          question_type: 'true_false',
          question_text: 'Cape Bolinao Lighthouse is the second highest lighthouse in the Philippines.',
          explanation: 'It is the second tallest in the country, after Cape Bojeador in Ilocos Norte.',
          hint: 'Only one other historic lighthouse stands taller.',
          round: 'main',
          options: [
            { ordinal: 1, option_text: 'True', is_correct: true },
            { ordinal: 2, option_text: 'False', is_correct: false },
            { ordinal: 3, option_text: 'Neither', is_correct: false },
            { ordinal: 4, option_text: 'Not a lighthouse', is_correct: false },
          ],
        },
        {
          ordinal: 3,
          question_type: 'picture',
          media_url: 'https://juanderquest.app/photos/bolinao-lighthouse.jpg',
          question_text: 'Which architectural style characterizes the beacon tower seen in this photo?',
          explanation: 'The tower exhibits American architectural brickwork and colonial maritime engineering.',
          hint: 'Notice the historic masonry and observation deck.',
          round: 'special',
          options: [
            { ordinal: 1, option_text: 'American Colonial Masonry', is_correct: true },
            { ordinal: 2, option_text: 'Spanish Baroque', is_correct: false },
            { ordinal: 3, option_text: 'Modernist Brutalism', is_correct: false },
            { ordinal: 4, option_text: 'Gothic Revival', is_correct: false },
          ],
        },
        {
          ordinal: 4,
          question_type: 'order',
          question_text: 'Order the chronological steps in navigating to Cape Bolinao from Dagupan.',
          explanation: 'Pass Lingayen, then Alaminos, then arrive at Bolinao.',
          hint: 'Travel West along the coastline.',
          round: 'special',
          answer_payload: { order: ['opt_dagupan', 'opt_lingayen', 'opt_alaminos', 'opt_bolinao'] },
          options: [
            { ordinal: 1, option_text: 'Depart Dagupan', is_correct: true },
            { ordinal: 2, option_text: 'Cross Lingayen Gulf Capital', is_correct: false },
            { ordinal: 3, option_text: 'Pass Alaminos City', is_correct: false },
            { ordinal: 4, option_text: 'Arrive at Cape Bolinao', is_correct: false },
          ],
        },
        {
          ordinal: 5,
          question_type: 'map_drop',
          question_text: 'Drop a pin on the location of Cape Bolinao Lighthouse overlooking the West Philippine Sea.',
          explanation: 'Located on Punta Piedra Point in Patar, Bolinao.',
          hint: 'It guards the westernmost tip of the Pangasinan peninsula.',
          round: 'lightning',
          answer_payload: { lat: 16.3204, lng: 119.7847, radius_km: 10 },
          options: [
            { ordinal: 1, option_text: 'Punta Piedra Point', is_correct: true },
            { ordinal: 2, option_text: 'Hundred Islands', is_correct: false },
            { ordinal: 3, option_text: 'Tambobong Beach', is_correct: false },
            { ordinal: 4, option_text: 'San Fabian Coast', is_correct: false },
          ],
        },
      ],
    };

    const res = await request(app)
      .post('/api/v1/admin/quizzes')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(payload);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.quiz.id).toBeDefined();
    createdQuizId = res.body.data.quiz.id;

    // Publish the quiz
    const pubRes = await request(app)
      .post(`/api/v1/admin/quizzes/${createdQuizId}/publish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(pubRes.status).toBe(200);
    expect(pubRes.body.data.status).toBe('published');
  });

  it('GET /api/v1/quizzes/:id returns host lines and theme for arcade presentation', async () => {
    const res = await request(app).get(`/api/v1/quizzes/${createdQuizId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.theme).toBe('crt');
    expect(res.body.data.host_lines).toBeDefined();
    expect(res.body.data.host_lines.intro).toContain('Cape Bolinao');
  });

  it('starts an attempt and strictly withholds answer keys, hints, and answer_payload', async () => {
    const res = await request(app)
      .post(`/api/v1/quizzes/${createdQuizId}/attempts`)
      .set('Authorization', `Bearer ${travelerToken}`)
      .send({ lat: destLat, lng: destLng });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    attemptId = res.body.data.attempt.id;
    questions = res.body.data.questions;
    expect(questions.length).toBe(5);

    for (const q of questions) {
      expect(q.answer_payload).toBeUndefined();
      expect(q.hint).toBeUndefined();
      expect(q.question_type).toBeDefined();
      expect(q.round).toBeDefined();
      for (const opt of q.options) {
        expect(opt.is_correct).toBeUndefined();
      }
    }
  });

  it('rejects lifelines on a question outside the attempt without using them up', async () => {
    const res = await request(app)
      .post(`/api/v1/quizzes/${createdQuizId}/attempts/${attemptId}/lifeline`)
      .set('Authorization', `Bearer ${travelerToken}`)
      .send({ lifeline: 'ask_local', question_id: 'question-from-another-quiz' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('INVALID_QUESTION_ID');

    const wrongQuiz = await request(app)
      .post(`/api/v1/quizzes/another-quiz/attempts/${attemptId}/lifeline`)
      .set('Authorization', `Bearer ${travelerToken}`)
      .send({ lifeline: 'ask_local', question_id: questions[0].id });
    expect(wrongQuiz.status).toBe(404);
  });

  it('refuses 50/50 on a two-option question so it cannot reveal the answer', async () => {
    const res = await request(app)
      .post(`/api/v1/quizzes/${createdQuizId}/attempts/${attemptId}/lifeline`)
      .set('Authorization', `Bearer ${travelerToken}`)
      .send({ lifeline: 'fifty_fifty', question_id: questions[1].id });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('LIFELINE_NOT_AVAILABLE');
  });

  it('allows the traveler to use 50/50 lifeline to eliminate 2 incorrect options', async () => {
    const q1 = questions[0];
    const res = await request(app)
      .post(`/api/v1/quizzes/${createdQuizId}/attempts/${attemptId}/lifeline`)
      .set('Authorization', `Bearer ${travelerToken}`)
      .send({ lifeline: 'fifty_fifty', question_id: q1.id });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.lifeline).toBe('fifty_fifty');
    expect(res.body.data.eliminated_option_ids.length).toBe(2);
    expect(res.body.data.remaining_lifelines).not.toContain('fifty_fifty');
  });

  it('rejects using the same lifeline twice in one attempt', async () => {
    const q1 = questions[0];
    const res = await request(app)
      .post(`/api/v1/quizzes/${createdQuizId}/attempts/${attemptId}/lifeline`)
      .set('Authorization', `Bearer ${travelerToken}`)
      .send({ lifeline: 'fifty_fifty', question_id: q1.id });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('LIFELINE_ALREADY_USED');
  });

  it('allows the traveler to use Ask a Local lifeline to reveal the question hint', async () => {
    const q1 = questions[0];
    const res = await request(app)
      .post(`/api/v1/quizzes/${createdQuizId}/attempts/${attemptId}/lifeline`)
      .set('Authorization', `Bearer ${travelerToken}`)
      .send({ lifeline: 'ask_local', question_id: q1.id });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.lifeline).toBe('ask_local');
    expect(res.body.data.hint).toContain('early 20th century');
    expect(res.body.data.remaining_lifelines).not.toContain('ask_local');
  });

  it('allows the traveler to use Skip lifeline on question 3', async () => {
    const q3 = questions[2];
    const res = await request(app)
      .post(`/api/v1/quizzes/${createdQuizId}/attempts/${attemptId}/lifeline`)
      .set('Authorization', `Bearer ${travelerToken}`)
      .send({ lifeline: 'skip', question_id: q3.id });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.lifeline).toBe('skip');
    expect(res.body.data.skipped).toBe(true);
  });

  it('grades attempt with new question types, handles skipped question, and records style_score', async () => {
    // Answer Q1 correctly
    const q1 = questions[0];
    const q1Correct = q1.options.find((o: any) => o.ordinal === 2);

    // Answer Q2 correctly (True)
    const q2 = questions[1];
    const q2Correct = q2.options.find((o: any) => o.ordinal === 1);

    // Q3 was skipped
    const q3 = questions[2];

    // Q4 order question
    const q4 = questions[3];

    // Q5 map drop
    const q5 = questions[4];

    const submissionPayload = {
      answers: [
        { question_id: q1.id, selected_option_id: q1Correct.id },
        { question_id: q2.id, selected_option_id: q2Correct.id },
        { question_id: q3.id, skipped: true },
        {
          question_id: q4.id,
          selected_order: ['opt_dagupan', 'opt_lingayen', 'opt_alaminos', 'opt_bolinao'],
        },
        {
          question_id: q5.id,
          selected_location: { lat: 16.3204, lng: 119.7847 },
        },
      ],
      style_score: 850,
      streak_max: 5,
    };

    // Skipping more than the one question the Skip lifeline allows is refused, and the attempt stays open.
    const twoSkips = await request(app)
      .put(`/api/v1/quiz-attempts/${attemptId}/submission`)
      .set('Authorization', `Bearer ${travelerToken}`)
      .send({ ...submissionPayload, answers: submissionPayload.answers.map((a, i) => (i < 2 ? { question_id: a.question_id, skipped: true } : a)) });
    expect(twoSkips.status).toBe(400);
    expect(twoSkips.body.error.message).toContain('INVALID_SKIP');

    const res = await request(app)
      .put(`/api/v1/quiz-attempts/${attemptId}/submission`)
      .set('Authorization', `Bearer ${travelerToken}`)
      .send(submissionPayload);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.passed).toBe(true);
    // The skipped question earns no point: 4 of 5 still passes.
    expect(res.body.data.score).toBe(4);
    expect(res.body.data.breakdown[2].is_correct).toBe(false);
    expect(res.body.data.attempt.style_score).toBe(850);
    expect(res.body.data.attempt.streak_max).toBe(5);
    expect(res.body.data.attempt.lifelines_used).toEqual(
      expect.arrayContaining(['fifty_fifty', 'ask_local', 'skip'])
    );
  });
});
