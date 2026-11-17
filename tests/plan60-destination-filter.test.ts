import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';
import { setPool } from '../src/db/pool.js';
import { env } from '../src/config/env.js';
import { ensureAreaCache, setCachedAreas } from '../src/maps/areas-service.js';

const realPgDescribe = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;

realPgDescribe('Plan 60 destination auto-filter & moderation (real PostgreSQL)', () => {
  let fixture: TestDbInstance;

  const platformId = 'p60-platform';
  const areaAdminId = 'p60-area-admin';
  const outsiderAdminId = 'p60-outsider-admin';
  const veteranId = 'p60-veteran';
  const veteran2Id = 'p60-veteran-2';
  const veteran3Id = 'p60-veteran-3';
  const newbieId = 'p60-newbie';
  const veteranHeavyId = 'p60-veteran-heavy';

  const token = (id: string, role = 'user') =>
    jwt.sign({ id, seed_id: `${id}-seed`, role, typ: 'session' }, env.JWT_SECRET);

  const validLat = 16.043;
  const validLng = 120.333;

  const baseSpot = (overrides: Record<string, unknown> = {}) => ({
    name: 'Dagupan Sunset Boardwalk',
    description: 'A scenic waterfront walk overlooking the Lingayen Gulf estuary in Dagupan City.',
    category: 'nature_outdoors',
    subcategory: 'park',
    tags: ['sunset', 'walking'],
    municipality: 'Dagupan City',
    address: 'Bonuan Tondaligan, Dagupan City',
    gps_lat: validLat,
    gps_lng: validLng,
    price_level: 0,
    hours: { daily: '06:00-20:00' },
    amenities: ['parking'],
    image_url: '',
    ...overrides,
  });

  beforeAll(async () => {
    fixture = await createTestDb();
    setPool(fixture.pool);

    const oldDate = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    const newDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();

    const users = [
      { id: platformId, handle: 'p60platform', name: 'Platform Admin', role: 'admin', scope: 'developer', createdAt: oldDate },
      { id: areaAdminId, handle: 'p60dagupan', name: 'Dagupan Admin', role: 'area_admin', scope: null, createdAt: oldDate },
      { id: outsiderAdminId, handle: 'p60launion', name: 'La Union Admin', role: 'area_admin', scope: null, createdAt: oldDate },
      { id: veteranId, handle: 'p60veteran', name: 'Veteran Scout', role: 'user', scope: null, createdAt: oldDate },
      { id: veteran2Id, handle: 'p60veteran2', name: 'Veteran Two', role: 'user', scope: null, createdAt: oldDate },
      { id: veteran3Id, handle: 'p60veteran3', name: 'Veteran Three', role: 'user', scope: null, createdAt: oldDate },
      { id: veteranHeavyId, handle: 'p60heavy', name: 'Veteran Heavy', role: 'user', scope: null, createdAt: oldDate },
      { id: newbieId, handle: 'p60newbie', name: 'Newbie Scout', role: 'user', scope: null, createdAt: newDate },
    ];

    for (const u of users) {
      await fixture.pool.query(
        `INSERT INTO users(id, seed_id, display_name, email, handle, role, admin_scope, is_public, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8)
         ON CONFLICT (id) DO NOTHING`,
        [u.id, `${u.id}-seed`, u.name, `${u.id}@test.local`, u.handle, u.role, u.scope, u.createdAt],
      );
      db.users.push({
        id: u.id,
        seed_id: `${u.id}-seed`,
        display_name: u.name,
        email: `${u.id}@test.local`,
        handle: u.handle,
        avatar_url: '',
        role: u.role as any,
        admin_scope: (u.scope as any) ?? null,
        is_public: true,
        is_test: false,
        created_at: u.createdAt,
        updated_at: u.createdAt,
        points_balance: 0,
        stamps_count: 0,
        level: 1,
        title: 'Scout',
        scout_reputation: 0,
      } as any);
    }

    const dagupanBox = {
      type: 'Polygon',
      coordinates: [
        [
          [120.30, 16.01],
          [120.37, 16.01],
          [120.37, 16.08],
          [120.30, 16.08],
          [120.30, 16.01],
        ],
      ],
    };

    await fixture.pool.query(
      `INSERT INTO admin_areas(id, level, name, display_name, parent_id, has_boundary, label_lat, label_lng, bbox, min_zoom, boundary)
       VALUES
         ('p60-pangasinan', 'province', 'Pangasinan', 'Pangasinan', NULL, TRUE, 16.0, 120.3, $1, 5, NULL),
         ('p60-dagupan', 'town', 'Dagupan City', 'Dagupan City', 'p60-pangasinan', TRUE, 16.043, 120.333, $2, 8, $3::jsonb),
         ('p60-la-union', 'province', 'La Union', 'La Union', NULL, TRUE, 16.6, 120.3, $4, 5, NULL)
       ON CONFLICT (id) DO UPDATE SET boundary = EXCLUDED.boundary`,
      [
        [119.8, 15.8, 120.8, 16.4],
        [120.30, 16.01, 120.37, 16.08],
        JSON.stringify(dagupanBox),
        [120.2, 16.4, 120.5, 16.8],
      ],
    );

    await fixture.pool.query(
      `INSERT INTO admin_area_assignments(id, user_id, area_id, powers, granted_by)
       VALUES
         ('p60-grant-dagupan', $1, 'p60-dagupan', ARRAY['destinations']::text[], $3),
         ('p60-grant-outside', $2, 'p60-la-union', ARRAY['destinations']::text[], $3)
       ON CONFLICT (id) DO NOTHING`,
      [areaAdminId, outsiderAdminId, platformId],
    );

    await ensureAreaCache(fixture.pool, true);
    // Admin scope looks users up through db.usersRepo, which needs the pool too.
    db.usersRepo.setPool(fixture.pool);
  });

  afterAll(async () => {
    setCachedAreas([]);
    setPool(null);
    await fixture?.close();
  });

  it('publishes clean spots inside Pangasinan quickly and hides/holds flagged ones on create & edit', async () => {
    const startMs = performance.now();
    const cleanRes = await request(app)
      .post('/api/v1/spots')
      .set('Authorization', `Bearer ${token(veteranId)}`)
      .send(baseSpot());
    const elapsedMs = performance.now() - startMs;
    // Record measured latency in stdout for journal reporting
    console.info(`[Plan 60] Clean POST /spots latency: ${elapsedMs.toFixed(1)} ms`);

    expect(cleanRes.status).toBe(201);
    expect(cleanRes.body.data.status).toBe('published');
    expect(cleanRes.body.data.moderation.reason_codes).toEqual([]);
    expect(elapsedMs).toBeLessThan(1000);

    // Text blocklist holds external link & profanity and isolates from other users
    const blockedRes = await request(app)
      .post('/api/v1/spots')
      .set('Authorization', `Bearer ${token(veteranId)}`)
      .send(
        baseSpot({
          name: 'Spammy Bayfront Grill',
          description: 'Best seafood in town visit https://spam-link.example for promos today.',
          gps_lat: 16.046,
          gps_lng: 120.336,
        }),
      );
    expect(blockedRes.status).toBe(201);
    const heldId = blockedRes.body.data.id;
    expect(blockedRes.body.data.status).toBe('held');
    expect(blockedRes.body.data.moderation_reasons).toContain('TEXT_BLOCKED');

    // Public list & visitor detail cannot see held spot
    const publicList = await request(app).get('/api/v1/spots');
    expect(publicList.body.data.map((s: any) => s.id)).not.toContain(heldId);
    const visitorDetail = await request(app)
      .get(`/api/v1/spots/${heldId}`)
      .set('Authorization', `Bearer ${token(veteran2Id)}`);
    expect(visitorDetail.status).toBe(404);

    // Visitor profile spots does not show held spot; owner profile spots DOES show it with reasons
    const visitorProfile = await request(app)
      .get('/api/v1/users/p60veteran/spots')
      .set('Authorization', `Bearer ${token(veteran2Id)}`);
    expect(visitorProfile.body.data.spots.map((s: any) => s.id)).not.toContain(heldId);

    const ownerProfile = await request(app)
      .get('/api/v1/users/p60veteran/spots')
      .set('Authorization', `Bearer ${token(veteranId)}`);
    const ownerHeld = ownerProfile.body.data.spots.find((s: any) => s.id === heldId);
    expect(ownerHeld).toBeDefined();
    expect(ownerHeld.status).toBe('held');
    expect(ownerHeld.moderation_reasons).toContain('TEXT_BLOCKED');

    // Author fixes text on PATCH /spots/:id -> transitions to published
    const editRes = await request(app)
      .patch(`/api/v1/spots/${heldId}`)
      .set('Authorization', `Bearer ${token(veteranId)}`)
      .send({ description: 'Fresh local grilled seafood right along the Dagupan waterfront promenade.' });
    expect(editRes.status).toBe(200);
    expect(editRes.body.data.status).toBe('published');
    expect(editRes.body.data.moderation.reason_codes).toEqual([]);

    const nowVisible = await request(app).get(`/api/v1/spots/${heldId}`);
    expect(nowVisible.status).toBe(200);
  });

  it('holds points outside Pangasinan boundaries and detects nearby duplicates while rejecting same-author repeats', async () => {
    const outsideRes = await request(app)
      .post('/api/v1/spots')
      .set('Authorization', `Bearer ${token(veteranId)}`)
      .send(
        baseSpot({
          name: 'Outside Pangasinan Spot',
          municipality: 'Dagupan City',
          gps_lat: 16.615,
          gps_lng: 120.319,
        }),
      );
    expect(outsideRes.status).toBe(201);
    expect(outsideRes.body.data.status).toBe('held');
    expect(outsideRes.body.data.moderation_reasons).toContain('OUTSIDE_BOUNDARY');

    // Same author exact repeat within 100m -> 409 reject
    const repeatRes = await request(app)
      .post('/api/v1/spots')
      .set('Authorization', `Bearer ${token(veteranId)}`)
      .send(baseSpot());
    expect(repeatRes.status).toBe(409);
    expect(repeatRes.body.error.code).toBe('DUPLICATE_SPOT');

    // Another user within 100m with similar name -> POSSIBLE_DUPLICATE hold with hint
    const nearDupRes = await request(app)
      .post('/api/v1/spots')
      .set('Authorization', `Bearer ${token(veteran2Id)}`)
      .send(
        baseSpot({
          name: 'Dagupan Sunset Board Walk',
          gps_lat: validLat + 0.0002,
          gps_lng: validLng + 0.0002,
        }),
      );
    expect(nearDupRes.status).toBe(201);
    expect(nearDupRes.body.data.status).toBe('held');
    expect(nearDupRes.body.data.moderation_reasons).toContain('POSSIBLE_DUPLICATE');
    expect(nearDupRes.body.data.duplicate_spot?.name).toBe('Dagupan Sunset Boardwalk');
    expect(nearDupRes.body.data.moderation_messages.join(' ')).toMatch(/Is this the same as Dagupan Sunset Boardwalk\?/i);
  });

  it('enforces daily velocity caps by account age (3/day for <7d accounts, 10/day for older)', async () => {
    for (let i = 1; i <= 3; i++) {
      const ok = await request(app)
        .post('/api/v1/spots')
        .set('Authorization', `Bearer ${token(newbieId)}`)
        .send(
          baseSpot({
            name: `Newbie Spot ${i}`,
            gps_lat: 16.02 + i * 0.005,
            gps_lng: 120.32 + i * 0.005,
          }),
        );
      expect(ok.status).toBe(201);
    }
    const fourth = await request(app)
      .post('/api/v1/spots')
      .set('Authorization', `Bearer ${token(newbieId)}`)
      .send(baseSpot({ name: 'Newbie Spot 4', gps_lat: 16.05, gps_lng: 120.35 }));
    expect(fourth.status).toBe(429);
    expect(fourth.body.error.code).toBe('VELOCITY_LIMIT');
    expect(fourth.body.error.retry_after_seconds).toBeGreaterThan(0);

    // Older account allowed > 3 (up to 10) and blocked on 11th
    for (let i = 1; i <= 10; i++) {
      const ok = await request(app)
        .post('/api/v1/spots')
        .set('Authorization', `Bearer ${token(veteranHeavyId)}`)
        .send(
          baseSpot({
            name: `Heavy Spot ${i}`,
            gps_lat: 16.015 + i * 0.004,
            gps_lng: 120.315 + i * 0.004,
          }),
        );
      expect(ok.status).toBe(201);
    }
    const eleventh = await request(app)
      .post('/api/v1/spots')
      .set('Authorization', `Bearer ${token(veteranHeavyId)}`)
      .send(baseSpot({ name: 'Heavy Spot 11', gps_lat: 16.065, gps_lng: 120.365 }));
    expect(eleventh.status).toBe(429);
    expect(eleventh.body.error.code).toBe('VELOCITY_LIMIT');
  });

  it('weights community reports, auto-hides at 3 eligible reports, notifies author, allows 1 appeal, and lets area admin moderate', async () => {
    const created = await request(app)
      .post('/api/v1/spots')
      .set('Authorization', `Bearer ${token(veteranId)}`)
      .send(
        baseSpot({
          name: 'Calmay River Dock',
          gps_lat: 16.052,
          gps_lng: 120.322,
        }),
      );
    expect(created.status).toBe(201);
    const spotId = created.body.data.id;

    // Ineligible reports: anonymous, newbie (<7d), self-report, repeat report from veteran2
    const anon = await request(app).post(`/api/v1/spots/${spotId}/reports`).send({ reason: 'other', details: 'anon' });
    expect(anon.body.data.weight).toBe(0);

    const young = await request(app)
      .post(`/api/v1/spots/${spotId}/reports`)
      .set('Authorization', `Bearer ${token(newbieId)}`)
      .send({ reason: 'other', details: 'young' });
    expect(young.body.data.weight).toBe(0);

    const selfRep = await request(app)
      .post(`/api/v1/spots/${spotId}/reports`)
      .set('Authorization', `Bearer ${token(veteranId)}`)
      .send({ reason: 'other', details: 'self' });
    expect(selfRep.body.data.weight).toBe(0);

    // 2 eligible reports do not hide yet
    const r1 = await request(app)
      .post(`/api/v1/spots/${spotId}/reports`)
      .set('Authorization', `Bearer ${token(veteran2Id)}`)
      .send({ reason: 'inaccurate_location', details: 'Pin off' });
    expect(r1.body.data.weight).toBe(1);
    expect(r1.body.data.spot_hidden).toBe(false);

    // Repeat by veteran2 has weight 0
    const r1Dup = await request(app)
      .post(`/api/v1/spots/${spotId}/reports`)
      .set('Authorization', `Bearer ${token(veteran2Id)}`)
      .send({ reason: 'spam_or_scam', details: 'Repeat' });
    expect(r1Dup.body.data.weight).toBe(0);

    const r2 = await request(app)
      .post(`/api/v1/spots/${spotId}/reports`)
      .set('Authorization', `Bearer ${token(veteran3Id)}`)
      .send({ reason: 'site_closed_or_hazard', details: 'Closed gate' });
    expect(r2.body.data.weight).toBe(1);
    expect(r2.body.data.spot_hidden).toBe(false);

    // 3rd eligible report triggers hidden_pending_review + author notification
    const r3 = await request(app)
      .post(`/api/v1/spots/${spotId}/reports`)
      .set('Authorization', `Bearer ${token(veteranHeavyId)}`)
      .send({ reason: 'misleading_photo', details: 'Old photo' });
    expect(r3.body.data.weight).toBe(1);
    expect(r3.body.data.spot_hidden).toBe(true);

    const spotRow = await fixture.pool.query('SELECT status FROM spots WHERE id = $1', [spotId]);
    expect(spotRow.rows[0].status).toBe('hidden_pending_review');

    const notifRows = await fixture.pool.query(
      `SELECT kind, title FROM user_notifications WHERE user_id = $1 AND kind = 'spot_moderation'`,
      [veteranId],
    );
    expect(notifRows.rows.length).toBeGreaterThanOrEqual(1);

    // Public catalog no longer lists auto-hidden spot
    const publicList = await request(app).get('/api/v1/spots');
    expect(publicList.body.data.map((s: any) => s.id)).not.toContain(spotId);

    // Author appeals once; second appeal returns 409
    const appeal1 = await request(app)
      .post(`/api/v1/spots/${spotId}/appeal`)
      .set('Authorization', `Bearer ${token(veteranId)}`)
      .send({ note: 'The dock reopened after storm cleanup this morning.' });
    expect(appeal1.status).toBe(201);

    const appeal2 = await request(app)
      .post(`/api/v1/spots/${spotId}/appeal`)
      .set('Authorization', `Bearer ${token(veteranId)}`)
      .send({ note: 'Second attempt should fail.' });
    expect(appeal2.status).toBe(409);

    // Area-scoped moderation queue: outsider sees empty, Dagupan admin sees it
    const outsiderQueue = await request(app)
      .get('/api/v1/admin/spot-moderation?area_id=p60-la-union')
      .set('Authorization', `Bearer ${token(outsiderAdminId, 'area_admin')}`);
    expect(outsiderQueue.status).toBe(200);
    expect(outsiderQueue.body.data.map((s: any) => s.id)).not.toContain(spotId);

    const areaQueue = await request(app)
      .get('/api/v1/admin/spot-moderation?area_id=p60-dagupan')
      .set('Authorization', `Bearer ${token(areaAdminId, 'area_admin')}`);
    expect(areaQueue.status).toBe(200);
    const queued = areaQueue.body.data.find((s: any) => s.id === spotId);
    expect(queued).toBeDefined();
    expect(queued.appeal_submitted).toBe(true);

    // Admin restores via POST /admin/spots/:id/moderate { action: 'publish' }
    const restoreRes = await request(app)
      .post(`/api/v1/admin/spots/${spotId}/moderate`)
      .set('Authorization', `Bearer ${token(areaAdminId, 'area_admin')}`)
      .send({ action: 'publish', note: 'Verified open dock during site check.' });
    expect(restoreRes.status).toBe(200);
    expect(restoreRes.body.data.status).toBe('published');

    const restoredDetail = await request(app).get(`/api/v1/spots/${spotId}`);
    expect(restoredDetail.status).toBe(200);
  });

  it('restores or removes an auto-hidden spot when resolving individual spot reports', async () => {
    const created = await request(app)
      .post('/api/v1/spots')
      .set('Authorization', `Bearer ${token(veteranId)}`)
      .send(
        baseSpot({
          name: 'Lingayen Capitol Baywalk Gazebo',
          gps_lat: 16.054,
          gps_lng: 120.324,
        }),
      );
    expect(created.status).toBe(201);
    const spotId = created.body.data.id;

    const r1 = await request(app)
      .post(`/api/v1/spots/${spotId}/reports`)
      .set('Authorization', `Bearer ${token(veteran2Id)}`)
      .send({ reason: 'site_closed_or_hazard', details: 'Hazard 1' });
    await request(app)
      .post(`/api/v1/spots/${spotId}/reports`)
      .set('Authorization', `Bearer ${token(veteran3Id)}`)
      .send({ reason: 'site_closed_or_hazard', details: 'Hazard 2' });
    const r3 = await request(app)
      .post(`/api/v1/spots/${spotId}/reports`)
      .set('Authorization', `Bearer ${token(veteranHeavyId)}`)
      .send({ reason: 'site_closed_or_hazard', details: 'Hazard 3' });
    expect(r3.body.data.spot_hidden).toBe(true);

    // Dismissing 1 drops pending weight from 3 -> 2 and restores spot
    const dismissRes = await request(app)
      .patch(`/api/v1/admin/spot-reports/${r1.body.data.report_id}`)
      .set('Authorization', `Bearer ${token(areaAdminId, 'area_admin')}`)
      .send({ status: 'dismissed', resolution_note: 'False alarm report dismissed.' });
    expect(dismissRes.status).toBe(200);
    const restoredRow = await fixture.pool.query('SELECT status FROM spots WHERE id = $1', [spotId]);
    expect(restoredRow.rows[0].status).toBe('published');

    // Re-report to auto-hide again, then Mark reviewed -> unpublishes spot
    const r4 = await request(app)
      .post(`/api/v1/spots/${spotId}/reports`)
      .set('Authorization', `Bearer ${token(areaAdminId, 'area_admin')}`)
      .send({ reason: 'site_closed_or_hazard', details: 'Still hazardous' });
    expect(r4.body.data.spot_hidden).toBe(true);

    const reviewRes = await request(app)
      .patch(`/api/v1/admin/spot-reports/${r4.body.data.report_id}`)
      .set('Authorization', `Bearer ${token(platformId, 'admin')}`)
      .send({ status: 'reviewed', resolution_note: 'Confirmed closed hazard; unpublishing spot.' });
    expect(reviewRes.status).toBe(200);
    const unpublishedRow = await fixture.pool.query('SELECT status FROM spots WHERE id = $1', [spotId]);
    expect(unpublishedRow.rows[0].status).toBe('unpublished');
  });
});
