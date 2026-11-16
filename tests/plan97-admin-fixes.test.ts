import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import { db } from '../src/db/index.js';
import { setPool } from '../src/db/pool.js';
import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';
import { spotStore } from '../src/spots/store.js';

const realPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;
jest.setTimeout(180_000);

realPg('Plan 97: Quest funding admin inspection & map-pinned cultural quizzes (real PostgreSQL)', () => {
  let fixture: TestDbInstance;
  const adminId = `p97-admin-${randomUUID()}`;
  const travelerId = `p97-user-${randomUUID()}`;

  const token = (id: string, role: string) =>
    jwt.sign({ id, seed_id: id, role, typ: 'session' }, env.JWT_SECRET, { expiresIn: '1h' });
  const as = (id: string, role: string) => ({ Authorization: `Bearer ${token(id, role)}` });

  const prevQuestFunding = env.QUEST_FUNDING_ENABLED;

  beforeAll(async () => {
    fixture = await createTestDb({ poolMax: 10 });
    setPool(fixture.pool);
    db.attachDurabilityPool(fixture.pool);
    db.usersRepo.setPool(fixture.pool);
    await spotStore.hydrateFromPg(fixture.pool);

    await fixture.pool.query(
      `INSERT INTO users(id, seed_id, display_name, email, role, admin_scope, is_test) VALUES
      ($1::text, $1::text, 'Admin 97', $1::text || '@example.test', 'admin', 'platform', FALSE),
      ($2::text, $2::text, 'Traveler 97', $2::text || '@example.test', 'user', NULL, FALSE)`,
      [adminId, travelerId],
    );
  });

  afterAll(async () => {
    Reflect.set(env, 'QUEST_FUNDING_ENABLED', prevQuestFunding);
    await fixture?.close();
  });

  it('allows admin funding inspection endpoints when QUEST_FUNDING_ENABLED is false and reports funding_enabled', async () => {
    Reflect.set(env, 'QUEST_FUNDING_ENABLED', false);

    const fundingRes = await request(app).get('/api/v1/admin/quest-funding').set(as(adminId, 'admin'));
    expect(fundingRes.status).toBe(200);
    expect(fundingRes.body.data.funding_enabled).toBe(false);

    const treasuryRes = await request(app).get('/api/v1/admin/treasury').set(as(adminId, 'admin'));
    expect(treasuryRes.status).toBe(200);
    expect(treasuryRes.body.data.funding_enabled).toBe(false);

    const creditsRes = await request(app).get('/api/v1/admin/merchant-point-credits').set(as(adminId, 'admin'));
    expect(creditsRes.status).toBe(200);
    expect(creditsRes.body.data.funding_enabled).toBe(false);
  });

  it('toggles quest_funding_enabled via PUT /admin/settings and updates runtime flag', async () => {
    Reflect.set(env, 'QUEST_FUNDING_ENABLED', false);
    const getRes = await request(app).get('/api/v1/admin/settings').set(as(adminId, 'admin'));
    expect(getRes.status).toBe(200);
    const revision = getRes.body.data.revision;

    const putRes = await request(app)
      .put('/api/v1/admin/settings')
      .set(as(adminId, 'admin'))
      .send({
        expected_revision: revision,
        changes: { quest_funding_enabled: true },
        reason: 'Enable quest funding for Plan 97 verification.',
      });
    expect(putRes.status).toBe(200);
    expect(putRes.body.data.values.quest_funding_enabled).toBe(true);
    expect(env.QUEST_FUNDING_ENABLED).toBe(true);
  });

  it('creates and publishes a map-pinned cultural quiz without destination_id and checks Haversine against the pin', async () => {
    const pinLat = 16.0431;
    const pinLng = 120.3333;
    const questions = [1, 2, 3, 4, 5].map((ordinal) => ({
      ordinal,
      question_text: `Dagupan Heritage Question ${ordinal}?`,
      explanation: `Explanation for question ${ordinal}.`,
      question_type: 'multiple_choice',
      round: 'main',
      options: [
        { ordinal: 1, option_text: 'Correct answer', is_correct: true },
        { ordinal: 2, option_text: 'Wrong answer A', is_correct: false },
        { ordinal: 3, option_text: 'Wrong answer B', is_correct: false },
        { ordinal: 4, option_text: 'Wrong answer C', is_correct: false },
      ],
    }));

    const createRes = await request(app)
      .post('/api/v1/admin/quizzes')
      .set(as(adminId, 'admin'))
      .send({
        pin: {
          lat: pinLat,
          lng: pinLng,
          name: 'Dagupan City Plaza Marker',
          municipality: 'Dagupan City',
        },
        title: 'Dagupan Plaza Pin Quiz',
        description: 'A map-pinned cultural quiz for Plan 97 testing.',
        language: 'en',
        radius_meters: 200,
        xp_reward: 25,
        questions,
      });

    expect(createRes.status).toBe(201);
    const quizId = createRes.body.data.quiz.id;
    expect(createRes.body.data.quiz.destination_id).toBeTruthy();
    expect(createRes.body.data.version.host_lines).toMatchObject({
      pin_lat: pinLat,
      pin_lng: pinLng,
      location_label: 'Dagupan City Plaza Marker',
    });

    const pubRes = await request(app).post(`/api/v1/admin/quizzes/${quizId}/publish`).set(as(adminId, 'admin'));
    expect(pubRes.status).toBe(200);

    const farStart = await request(app)
      .post(`/api/v1/quizzes/${quizId}/attempts`)
      .set(as(travelerId, 'user'))
      .send({ lat: 16.1, lng: 120.4 });
    expect(farStart.status).toBe(403);

    const nearStart = await request(app)
      .post(`/api/v1/quizzes/${quizId}/attempts`)
      .set(as(travelerId, 'user'))
      .send({ lat: pinLat, lng: pinLng });
    expect(nearStart.status).toBe(201);
  });
});
