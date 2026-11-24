import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { env } from '../src/config/env.js';
import { setPool } from '../src/db/pool.js';
import { MIGRATIONS } from '../src/db/migrations.js';
import { spotStore } from '../src/spots/store.js';
import { spotRelocationStore } from '../src/spots/relocations.js';
import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';

const realPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;

realPg('Plan 118 — Destination author, poster-only quests, and relocation requests (real PG)', () => {
  let fixture: TestDbInstance;
  const originalFunding = env.QUEST_FUNDING_ENABLED;

  const authorId = `p118-author-${randomUUID().slice(0, 8)}`;
  const otherId = `p118-other-${randomUUID().slice(0, 8)}`;
  const adminId = `p118-admin-${randomUUID().slice(0, 8)}`;
  const areaAdminId = `p118-area-admin-${randomUUID().slice(0, 8)}`;

  const townAId = `area-town-a-${randomUUID().slice(0, 8)}`;
  const townBId = `area-town-b-${randomUUID().slice(0, 8)}`;

  const authoredSpotId = `spot-p118-auth-${randomUUID().slice(0, 8)}`;
  const authoredSlug = `bolinao-cliff-${randomUUID().slice(0, 6)}`;
  const officialSpotId = `spot-p118-off-${randomUUID().slice(0, 8)}`;
  const officialSlug = `dagupan-plaza-${randomUUID().slice(0, 6)}`;

  const signToken = (id: string, role: string) => jwt.sign({ id, seed_id: id, role, typ: 'session' }, env.JWT_SECRET);

  const authorToken = signToken(authorId, 'user');
  const otherToken = signToken(otherId, 'user');
  const adminToken = signToken(adminId, 'admin');
  const areaAdminToken = signToken(areaAdminId, 'area_admin');

  beforeAll(async () => {
    fixture = await createTestDb();
    setPool(fixture.pool);
    db.usersRepo.setPool(fixture.pool);
    env.QUEST_FUNDING_ENABLED = false;

    await fixture.pool.query(
      `INSERT INTO admin_areas (id, level, name, display_name, label_lat, label_lng, bbox)
       VALUES
         ($1, 'town', 'Bolinao', 'Bolinao, Pangasinan', 16.38, 119.89, ARRAY[119.7, 16.2, 120.0, 16.5]),
         ($2, 'town', 'Dagupan City', 'Dagupan City, Pangasinan', 16.04, 120.33, ARRAY[120.2, 16.0, 120.4, 16.1])`,
      [townAId, townBId],
    );

    await fixture.pool.query(
      `INSERT INTO users (id, seed_id, display_name, email, role, handle, avatar_url, demo_points)
       VALUES
         ($1::text, $1::text, 'Maria Explorer', 'maria@example.test', 'user', 'maria_ph', 'https://example.test/maria.png', 100),
         ($2::text, $2::text, 'Juan Traveler', 'juan@example.test', 'user', 'juan_ph', '', 50),
         ($3::text, $3::text, 'Platform Admin', 'admin@example.test', 'admin', 'admin_ph', '', 0),
         ($4::text, $4::text, 'Dagupan Area Admin', 'area@example.test', 'area_admin', 'dagupan_lgu', '', 0)`,
      [authorId, otherId, adminId, areaAdminId],
    );

    // Area admin is scoped to townB (Dagupan) ONLY, not townA (Bolinao).
    await fixture.pool.query(
      `INSERT INTO admin_area_assignments (id, user_id, area_id, powers, granted_by)
       VALUES ($1, $2, $3, ARRAY['destinations']::text[], $4)`,
      [`assign-${randomUUID().slice(0, 8)}`, areaAdminId, townBId, adminId],
    );

    await fixture.pool.query(
      `INSERT INTO spots (id, slug, name, description, category, subcategory, municipality, address, gps_lat, gps_lng,
         status, is_test, recommendation_suppressed, source_type, source_name, trust_level, created_by, town_area_id)
       VALUES
         ($1, $2, 'Bolinao Sunset Cliff', 'A quiet limestone cliff overlooking the West Philippine Sea.', 'nature_outdoors', 'viewpoint',
          'Bolinao', 'Patar Rd, Bolinao', 16.3200, 119.7850, 'published', false, false, 'community', 'Maria Explorer', 'community', $5, $6),
         ($3, $4, 'Dagupan Heritage Plaza', 'Official town square with historic civic buildings.', 'culture_heritage', 'heritage_site',
          'Dagupan City', 'AB Fernandez Ave, Dagupan City', 16.0433, 120.3333, 'published', false, false, 'lgu', 'Dagupan LGU', 'lgu_verified', NULL, $7)`,
      [authoredSpotId, authoredSlug, officialSpotId, officialSlug, authorId, townAId, townBId],
    );

    await db.hydrateFromPg(fixture.pool);
    await spotStore.hydrateFromPg(fixture.pool);
  }, 60000);

  afterAll(async () => {
    env.QUEST_FUNDING_ENABLED = originalFunding;
    spotRelocationStore.resetMemory();
    setPool(null);
    db.usersRepo.setPool(null);
    if (fixture) await fixture.close();
  });

  it('registers migration 113 directly after 112', () => {
    const idx112 = MIGRATIONS.indexOf('112_perf_hygiene.sql');
    const idx113 = MIGRATIONS.indexOf('113_spot_relocation_requests.sql');
    expect(idx112).toBeGreaterThan(-1);
    expect(idx113).toBe(idx112 + 1);
  });

  it('includes public author on detail and list with no email, and null when no poster', async () => {
    const detail = await request(app).get(`/api/v1/spots/${authoredSlug}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.author).toEqual({
      id: authorId,
      handle: 'maria_ph',
      display_name: 'Maria Explorer',
      avatar_url: 'https://example.test/maria.png',
    });
    expect(detail.body.data.author.email).toBeUndefined();

    const officialDetail = await request(app).get(`/api/v1/spots/${officialSlug}`);
    expect(officialDetail.status).toBe(200);
    expect(officialDetail.body.data.author).toBeNull();

    const list = await request(app).get('/api/v1/spots?limit=50');
    expect(list.status).toBe(200);
    const listedAuthored = list.body.data.find((s: any) => s.id === authoredSpotId);
    const listedOfficial = list.body.data.find((s: any) => s.id === officialSpotId);
    expect(listedAuthored?.author?.handle).toBe('maria_ph');
    expect(listedAuthored?.author?.email).toBeUndefined();
    expect(listedOfficial?.author).toBeNull();
  });

  it('enforces poster-only quest creation and keeps pre-existing quests by other travelers live', async () => {
    const questPayload = (title: string) => ({
      title,
      description: 'Walk along the cliff trail and check in at the scenic viewpoint.',
      category: 'eco',
      reward_points: 75,
      steps: [
        {
          step_order: 1,
          title: 'Arrive',
          description: 'Check in at the viewpoint.',
          checkpoint_type: 'location',
          required: true,
        },
      ],
    });

    // Poster can add a quest to their own destination.
    const posterRes = await request(app)
      .post(`/api/v1/spots/${authoredSpotId}/quests`)
      .set('Authorization', `Bearer ${authorToken}`)
      .send(questPayload('Cliffside Sunrise Walk'));
    expect(posterRes.status).toBe(201);

    // Another traveler gets 403 DESTINATION_OWNER_ONLY.
    const otherRes = await request(app)
      .post(`/api/v1/spots/${authoredSpotId}/quests`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send(questPayload('Unauthorized Quest'));
    expect(otherRes.status).toBe(403);
    expect(otherRes.body.error?.code).toBe('DESTINATION_OWNER_ONLY');

    // Platform admin cannot add a quest to a poster-owned spot.
    const adminOnOwned = await request(app)
      .post(`/api/v1/spots/${authoredSpotId}/quests`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send(questPayload('Admin Override Quest'));
    expect(adminOnOwned.status).toBe(403);
    expect(adminOnOwned.body.error?.code).toBe('DESTINATION_OWNER_ONLY');

    // Platform admin CAN add a quest to a poster-less spot; in-scope area admin CAN too.
    const adminOnOfficial = await request(app)
      .post(`/api/v1/spots/${officialSpotId}/quests`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send(questPayload('Heritage Square Tour'));
    expect(adminOnOfficial.status).toBe(201);

    const areaAdminOnOfficial = await request(app)
      .post(`/api/v1/spots/${officialSpotId}/quests`)
      .set('Authorization', `Bearer ${areaAdminToken}`)
      .send(questPayload('Dagupan Plaza Walk'));
    expect(areaAdminOnOfficial.status).toBe(201);

    // Regular traveler cannot add to a poster-less spot.
    const travelerOnOfficial = await request(app)
      .post(`/api/v1/spots/${officialSpotId}/quests`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send(questPayload('Traveler Plaza Walk'));
    expect(travelerOnOfficial.status).toBe(403);
    expect(travelerOnOfficial.body.error?.code).toBe('DESTINATION_OWNER_ONLY');

    // Existing quest by another traveler still lists and plays (GET /quests/:id).
    const legacyQuestId = `q-legacy-${randomUUID().slice(0, 8)}`;
    await fixture.pool.query(
      `INSERT INTO quests (id, author_id, title, description, category, location_name, gps_lat, gps_lng,
         radius_meters, reward_points, is_active, status, steps, marker_code)
       VALUES ($1, $2, 'Legacy Traveler Quest', 'Added before Plan 118.', 'eco', 'Bolinao Sunset Cliff',
         16.3200, 119.7850, 200, 50, true, 'published', '[{"step_order":1,"title":"Arrive","description":"Arrive","checkpoint_type":"location","required":true}]'::jsonb, 'JDQ-LEG1')`,
      [legacyQuestId, otherId],
    );
    await fixture.pool.query(
      `INSERT INTO reviewed_quest_spot_bindings (id, quest_id, spot_id, status)
       VALUES ($1, $2, $3, 'active')`,
      [randomUUID(), legacyQuestId, authoredSpotId],
    );
    await db.hydrateFromPg(fixture.pool);

    const listQuests = await request(app).get(`/api/v1/spots/${authoredSpotId}/quests`);
    expect(listQuests.status).toBe(200);
    expect(listQuests.body.data.some((q: any) => q.id === legacyQuestId)).toBe(true);

    const questDetail = await request(app).get(`/api/v1/quests/${legacyQuestId}`);
    expect(questDetail.status).toBe(200);
    expect(questDetail.body.data.id).toBe(legacyQuestId);
  });

  it('handles <=200m instant move, >200m pending relocation, supersede, approve, reject, bounds, auth, and area scope', async () => {
    // Non-author gets 403.
    const nonAuthor = await request(app)
      .patch(`/api/v1/spots/${authoredSpotId}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ description: 'Trying to edit someone else spot with enough text.' });
    expect(nonAuthor.status).toBe(403);

    // Out-of-bounds point (outside Philippines) is rejected with 400.
    const outOfBounds = await request(app)
      .patch(`/api/v1/spots/${authoredSpotId}`)
      .set('Authorization', `Bearer ${authorToken}`)
      .send({ gps_lat: 35.6762, gps_lng: 139.6503 });
    expect(outOfBounds.status).toBe(400);

    // ~150 m north (~0.00135 deg lat) saves at once (200).
    const lat150 = 16.32135;
    const lng150 = 119.785;
    const smallMove = await request(app)
      .patch(`/api/v1/spots/${authoredSpotId}`)
      .set('Authorization', `Bearer ${authorToken}`)
      .send({ gps_lat: lat150, gps_lng: lng150, accuracy_m: 9.5 });
    expect(smallMove.status).toBe(200);
    expect(smallMove.body.data.gps_lat).toBeCloseTo(lat150, 5);
    expect(smallMove.body.relocation).toBeUndefined();

    // ~500 m north (~0.0045 deg lat) creates a pending request, keeps coords unchanged, saves other fields, returns 202.
    const lat500 = 16.32585;
    const lng500 = 119.785;
    const bigMove1 = await request(app)
      .patch(`/api/v1/spots/${authoredSpotId}`)
      .set('Authorization', `Bearer ${authorToken}`)
      .send({
        description: 'Updated description saved even when pin move is pending review.',
        gps_lat: lat500,
        gps_lng: lng500,
        accuracy_m: 12.0,
      });
    expect(bigMove1.status).toBe(202);
    expect(bigMove1.body.relocation?.status).toBe('pending');
    expect(bigMove1.body.relocation?.distance_m).toBeGreaterThan(200);
    expect(bigMove1.body.data.gps_lat).toBeCloseTo(lat150, 5);
    expect(bigMove1.body.data.description).toBe('Updated description saved even when pin move is pending review.');
    const firstReqId = bigMove1.body.relocation.id;

    // A second big move (~650 m) cancels the first pending request.
    const lat650 = 16.3272;
    const lng650 = 119.785;
    const bigMove2 = await request(app)
      .patch(`/api/v1/spots/${authoredSpotId}`)
      .set('Authorization', `Bearer ${authorToken}`)
      .send({ gps_lat: lat650, gps_lng: lng650, accuracy_m: 7.2 });
    expect(bigMove2.status).toBe(202);
    const secondReqId = bigMove2.body.relocation.id;
    expect(secondReqId).not.toBe(firstReqId);

    const firstRow = await fixture.pool.query('SELECT status FROM spot_relocation_requests WHERE id = $1', [
      firstReqId,
    ]);
    expect(firstRow.rows[0]?.status).toBe('cancelled');

    // Out-of-scope area admin (Dagupan) does not see Bolinao request and gets 404 on approve/reject.
    const outScopeList = await request(app)
      .get('/api/v1/admin/spots/relocations?status=pending')
      .set('Authorization', `Bearer ${areaAdminToken}`);
    expect(outScopeList.status).toBe(200);
    expect(outScopeList.body.data.some((r: any) => r.id === secondReqId)).toBe(false);

    const outScopeApprove = await request(app)
      .post(`/api/v1/admin/spots/relocations/${secondReqId}/approve`)
      .set('Authorization', `Bearer ${areaAdminToken}`);
    expect(outScopeApprove.status).toBe(404);

    // Platform admin sees it in list and approves -> moves spot and notifies author.
    const adminList = await request(app)
      .get('/api/v1/admin/spots/relocations?status=pending')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(adminList.status).toBe(200);
    const listed = adminList.body.data.find((r: any) => r.id === secondReqId);
    expect(listed).toBeDefined();
    expect(listed.author_handle).toBe('maria_ph');
    expect(listed.accuracy_m).toBeCloseTo(7.2, 1);

    const approveRes = await request(app)
      .post(`/api/v1/admin/spots/relocations/${secondReqId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.data.status).toBe('approved');

    const spotAfterApprove = await request(app).get(`/api/v1/spots/${authoredSlug}`);
    expect(spotAfterApprove.body.data.gps_lat).toBeCloseTo(lat650, 5);

    const approveNotif = await fixture.pool.query(
      `SELECT kind, href FROM user_notifications WHERE user_id = $1 AND event_key = $2`,
      [authorId, `spot_relocation_approved:${secondReqId}`],
    );
    expect(approveNotif.rows).toHaveLength(1);
    expect(approveNotif.rows[0].kind).toBe('spot_moderation');
    expect(approveNotif.rows[0].href).toBe(`/spots/${authoredSlug}`);

    // Create another >200m move and reject it -> coords unchanged, author notified.
    const latReject = 16.332;
    const bigMove3 = await request(app)
      .patch(`/api/v1/spots/${authoredSpotId}`)
      .set('Authorization', `Bearer ${authorToken}`)
      .send({ gps_lat: latReject, gps_lng: lng650 });
    expect(bigMove3.status).toBe(202);
    const thirdReqId = bigMove3.body.relocation.id;

    const rejectRes = await request(app)
      .post(`/api/v1/admin/spots/relocations/${thirdReqId}/reject`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ note: 'Pin lands in the water, please verify.' });
    expect(rejectRes.status).toBe(200);
    expect(rejectRes.body.data.status).toBe('rejected');

    const spotAfterReject = await request(app).get(`/api/v1/spots/${authoredSlug}`);
    expect(spotAfterReject.body.data.gps_lat).toBeCloseTo(lat650, 5);

    const rejectNotif = await fixture.pool.query(
      `SELECT kind, href FROM user_notifications WHERE user_id = $1 AND event_key = $2`,
      [authorId, `spot_relocation_rejected:${thirdReqId}`],
    );
    expect(rejectNotif.rows).toHaveLength(1);
    expect(rejectNotif.rows[0].kind).toBe('spot_moderation');
    expect(rejectNotif.rows[0].href).toBe(`/spots/${authoredSlug}`);
  });

  it('prevents walking a pin with repeated <=200 m moves within 30 days, and resets after 30 days', async () => {
    await fixture.pool.query('DELETE FROM spot_relocation_requests WHERE spot_id = $1', [authoredSpotId]);

    const before = await request(app).get(`/api/v1/spots/${authoredSlug}`);
    const baseLat = Number(before.body.data.gps_lat);
    const baseLng = Number(before.body.data.gps_lng);

    // First 150 m move (~0.00135 deg lat) saves instantly (200) and logs an auto-approved row.
    const move1Lat = Number((baseLat + 0.00135).toFixed(6));
    const move1 = await request(app)
      .patch(`/api/v1/spots/${authoredSpotId}`)
      .set('Authorization', `Bearer ${authorToken}`)
      .send({ gps_lat: move1Lat, gps_lng: baseLng });
    expect(move1.status).toBe(200);
    expect(move1.body.relocation).toBeUndefined();
    expect(move1.body.data.gps_lat).toBeCloseTo(move1Lat, 5);

    const autoRows = await fixture.pool.query(
      `SELECT id, status, reviewed_by, review_note, distance_m
       FROM spot_relocation_requests
       WHERE spot_id = $1 AND status = 'approved'`,
      [authoredSpotId],
    );
    expect(autoRows.rows).toHaveLength(1);
    expect(autoRows.rows[0].reviewed_by).toBeNull();
    expect(autoRows.rows[0].review_note).toBe('auto: within 200 m');
    expect(autoRows.rows[0].distance_m).toBeGreaterThan(100);
    expect(autoRows.rows[0].distance_m).toBeLessThanOrEqual(200);

    // Second 150 m move immediately after pushes 30-day cumulative > 200 m -> pending (202), coords unchanged.
    const move2Lat = Number((move1Lat + 0.00135).toFixed(6));
    const move2 = await request(app)
      .patch(`/api/v1/spots/${authoredSpotId}`)
      .set('Authorization', `Bearer ${authorToken}`)
      .send({ gps_lat: move2Lat, gps_lng: baseLng });
    expect(move2.status).toBe(202);
    expect(move2.body.relocation?.status).toBe('pending');
    expect(move2.body.data.gps_lat).toBeCloseTo(move1Lat, 5);

    // Backdate the first instant move by 31 days and cancel the pending request: next 150 m move saves instantly (200).
    await fixture.pool.query(
      `UPDATE spot_relocation_requests SET created_at = NOW() - INTERVAL '31 days' WHERE id = $1`,
      [autoRows.rows[0].id],
    );
    await fixture.pool.query(
      `UPDATE spot_relocation_requests SET status = 'cancelled' WHERE spot_id = $1 AND status = 'pending'`,
      [authoredSpotId],
    );

    const move3 = await request(app)
      .patch(`/api/v1/spots/${authoredSpotId}`)
      .set('Authorization', `Bearer ${authorToken}`)
      .send({ gps_lat: move2Lat, gps_lng: baseLng });
    expect(move3.status).toBe(200);
    expect(move3.body.relocation).toBeUndefined();
    expect(move3.body.data.gps_lat).toBeCloseTo(move2Lat, 5);
  });
});
