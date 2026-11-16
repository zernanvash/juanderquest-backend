import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import { db } from '../src/db/index.js';
import { setPool } from '../src/db/pool.js';
import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';
import { ensureAreaCache } from '../src/maps/areas-service.js';
import { spotStore } from '../src/spots/store.js';

const realPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;
jest.setTimeout(180_000);

realPg('Plan 97: Quest funding admin inspection & map-pinned cultural quizzes (real PostgreSQL)', () => {
  let fixture: TestDbInstance;
  const adminId = `p97-admin-${randomUUID()}`;
  const areaAdminId = `p97-area-${randomUUID()}`;
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
      ($2::text, $2::text, 'Area Admin 97', $2::text || '@example.test', 'area_admin', NULL, FALSE),
      ($3::text, $3::text, 'Traveler 97', $3::text || '@example.test', 'user', NULL, FALSE)`,
      [adminId, areaAdminId, travelerId],
    );
    await fixture.pool.query(
      `INSERT INTO admin_areas(id, level, name, display_name, parent_id, has_boundary, label_lat, label_lng, bbox, min_zoom)
       VALUES
         ('province:p97-pang', 'province', 'Pangasinan', 'Pangasinan', NULL, TRUE, 16.0, 120.2, ARRAY[119.7, 15.7, 120.9, 16.5]::double precision[], 5),
         ('town:p97-dagupan', 'town', 'Dagupan City', 'Dagupan City, Pangasinan', 'province:p97-pang', TRUE, 16.0431, 120.3333, ARRAY[120.30, 16.01, 120.37, 16.08]::double precision[], 11),
         ('town:p97-bolinao', 'town', 'Bolinao', 'Bolinao, Pangasinan', 'province:p97-pang', TRUE, 16.386, 119.893, ARRAY[119.83, 16.30, 119.95, 16.43]::double precision[], 11)
       ON CONFLICT (id) DO NOTHING`,
    );
    await ensureAreaCache(fixture.pool);
    await fixture.pool.query(
      `INSERT INTO admin_area_assignments(id, user_id, area_id, powers, granted_by)
       VALUES ($1::uuid, $2::text, 'town:p97-dagupan', ARRAY['quests_quizzes']::text[], $3::text)`,
      [randomUUID(), areaAdminId, adminId],
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

  it('blocks POST /merchant/points/purchase with 404 when QUEST_FUNDING_ENABLED is false', async () => {
    Reflect.set(env, 'QUEST_FUNDING_ENABLED', false);
    const res = await request(app)
      .post('/api/v1/merchant/points/purchase')
      .set(as(travelerId, 'user'))
      .send({ package: 500, idempotency_key: randomUUID() });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_AVAILABLE');
  });

  it('creates a non-public pin spot once across repeated saves, hides it from GET /spots, and checks Haversine', async () => {
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
    const pinSpotId = createRes.body.data.quiz.destination_id;
    expect(pinSpotId).toBeTruthy();
    expect(createRes.body.data.version.host_lines).toMatchObject({
      pin_lat: pinLat,
      pin_lng: pinLng,
      location_label: 'Dagupan City Plaza Marker',
    });

    // Saving the same draft twice via PATCH must reuse the same non-public spot and never publish it.
    const countAfterCreate = await fixture.pool.query('SELECT COUNT(*)::int AS cnt FROM spots WHERE id = $1', [pinSpotId]);
    expect(countAfterCreate.rows[0].cnt).toBe(1);

    const patchRes = await request(app)
      .patch(`/api/v1/admin/quizzes/${quizId}`)
      .set(as(adminId, 'admin'))
      .send({
        pin: {
          lat: pinLat + 0.0002,
          lng: pinLng + 0.0002,
          name: 'Dagupan City Plaza Marker Updated',
          municipality: 'Dagupan City',
        },
        title: 'Dagupan Plaza Pin Quiz v2',
        description: 'Updated map-pinned cultural quiz for Plan 97 testing.',
        language: 'en',
        radius_meters: 200,
        xp_reward: 25,
        questions,
      });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.data.quiz.destination_id).toBe(pinSpotId);

    const totalSpotsByName = await fixture.pool.query(
      `SELECT COUNT(*)::int AS cnt FROM spots WHERE subcategory = 'Cultural Quiz Pin'`,
    );
    expect(totalSpotsByName.rows[0].cnt).toBe(1);

    const publicSpotsRes = await request(app).get('/api/v1/spots');
    expect(publicSpotsRes.status).toBe(200);
    const publicIds = (publicSpotsRes.body.data as Array<{ id: string }>).map((s) => s.id);
    expect(publicIds).not.toContain(pinSpotId);

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
      .send({ lat: pinLat + 0.0002, lng: pinLng + 0.0002 });
    expect(nearStart.status).toBe(201);
  });

  it('rejects out-of-area quiz pins with 403 for scoped area admins on POST and PATCH', async () => {
    const questions = [1, 2, 3, 4, 5].map((ordinal) => ({
      ordinal,
      question_text: `Area Scope Question ${ordinal}?`,
      explanation: `Explanation ${ordinal}.`,
      question_type: 'multiple_choice',
      round: 'main',
      options: [
        { ordinal: 1, option_text: 'A', is_correct: true },
        { ordinal: 2, option_text: 'B', is_correct: false },
        { ordinal: 3, option_text: 'C', is_correct: false },
        { ordinal: 4, option_text: 'D', is_correct: false },
      ],
    }));

    const outOfAreaPost = await request(app)
      .post('/api/v1/admin/quizzes')
      .set(as(areaAdminId, 'area_admin'))
      .send({
        pin: { lat: 16.386, lng: 119.893, name: 'Bolinao Pin', municipality: 'Bolinao' },
        title: 'Out of Area Quiz',
        description: 'Should be rejected for Dagupan area admin.',
        questions,
      });
    expect(outOfAreaPost.status).toBe(403);
    expect(outOfAreaPost.body.error.code).toBe('OUT_OF_AREA');

    const inAreaPost = await request(app)
      .post('/api/v1/admin/quizzes')
      .set(as(areaAdminId, 'area_admin'))
      .send({
        pin: { lat: 16.0431, lng: 120.3333, name: 'Dagupan Pin', municipality: 'Dagupan City' },
        title: 'Dagupan Area Quiz',
        description: 'Created within Dagupan area.',
        questions,
      });
    expect(inAreaPost.status).toBe(201);
    const quizId = inAreaPost.body.data.quiz.id;

    const outOfAreaPatch = await request(app)
      .patch(`/api/v1/admin/quizzes/${quizId}`)
      .set(as(areaAdminId, 'area_admin'))
      .send({
        pin: { lat: 16.386, lng: 119.893, name: 'Bolinao Move', municipality: 'Bolinao' },
        title: 'Moved Out of Area',
        description: 'Should also be rejected on PATCH.',
        questions,
      });
    expect(outOfAreaPatch.status).toBe(403);
    expect(outOfAreaPatch.body.error.code).toBe('OUT_OF_AREA');
  });
});
