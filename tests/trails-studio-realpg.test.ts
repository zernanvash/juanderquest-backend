import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';
import { setPool } from '../src/db/pool.js';
import { env } from '../src/config/env.js';

const describeRealPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;

describeRealPg('Trail Studio API (isolated real PostgreSQL schema)', () => {
  let fixture: TestDbInstance;
  const adminId = 'trail-studio-admin';
  const trailId = 'trl_studio_fixture';
  const spotId = 'spot-trail-studio-fixture';
  let adminToken: string;

  beforeAll(async () => {
    fixture = await createTestDb();
    setPool(fixture.pool);
    db.usersRepo.setPool(fixture.pool);
    await fixture.pool.query(`INSERT INTO users (id,seed_id,display_name,email,role,is_test)
      VALUES ($1,'trail-studio-admin','Trail Studio Admin','trail-studio-admin@example.test','admin',FALSE)`, [adminId]);
    await fixture.pool.query(`INSERT INTO spots
      (id,slug,name,description,category,subcategory,municipality,address,gps_lat,gps_lng,source_type,source_name,status,is_test)
      VALUES ($1,$2,'Studio Beach','Verified place description.','beach','coast','Bolinao','Bolinao, Pangasinan',16.0,120.0,'editorial','Fixture','published',FALSE)`, [spotId, spotId]);
    await fixture.pool.query(`INSERT INTO trails
      (id,slug,title,tagline,tier,theme,municipalities,unlock_rule,total_minutes,total_km,story,status,source)
      VALUES ($1,$1,'Old Trail Title','Old tagline','starter','beach',ARRAY['Bolinao'],'{"type":"free"}'::jsonb,90,1,
        '{"title":"Old Trail Title","tagline":"Old tagline","intro":"Old intro","stops":[{"spot_id":"spot-trail-studio-fixture","narration":"Old narration"}]}'::jsonb,
        'pending_review','engine')`, [trailId]);
    await fixture.pool.query(`INSERT INTO trail_stops (trail_id,position,spot_id,arrive_offset_min,dwell_min,leg_minutes,leg_km,narration)
      VALUES ($1,1,$2,0,45,0,0,'Old narration')`, [trailId, spotId]);
    adminToken = jwt.sign({ id: adminId, seed_id: 'trail-studio-admin', role: 'admin' }, env.JWT_SECRET);
  }, 120_000);

  afterAll(async () => {
    setPool(null);
    db.usersRepo.setPool(null);
    if (fixture) await fixture.close();
  }, 30_000);

  test('Trail Studio review and edit routes reject unauthenticated requests', async () => {
    expect((await request(app).get('/api/v1/admin/trails/review')).status).toBe(401);
    expect((await request(app).patch(`/api/v1/admin/trails/${trailId}`).send({ title: 'Hijack' })).status).toBe(401);
    expect((await request(app).post('/api/v1/admin/trails/compare-solvers').send({})).status).toBe(401);
  });

  test('compare-solvers is closed unless the evaluation flag and private key are available', async () => {
    const response = await request(app).post('/api/v1/admin/trails/compare-solvers')
      .set('Authorization', `Bearer ${adminToken}`).send({ spot_ids: [spotId, `${spotId}-2`, `${spotId}-3`], budget_min: 240 });
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('CUOPT_DISABLED');
    const rows = await fixture.pool.query("SELECT count(*)::int AS count FROM trail_generations WHERE kind='benchmark'");
    expect(rows.rows[0].count).toBe(0);
  });

  test('admin review queue and PATCH atomically edit story, stop narration, tier, price and availability', async () => {
    const queue = await request(app).get('/api/v1/admin/trails/review').set('Authorization', `Bearer ${adminToken}`);
    expect(queue.status).toBe(200);
    expect(queue.body.data.map((trail: any) => trail.id)).toContain(trailId);
    expect(queue.body.data.find((trail: any) => trail.id === trailId).stops).toEqual([
      expect.objectContaining({ position:1, spot_id:spotId, name:'Studio Beach', approximate:false }),
    ]);

    const availableFrom = '2026-10-20T00:00:00.000Z';
    const availableUntil = '2026-11-03T00:00:00.000Z';
    const response = await request(app).patch(`/api/v1/admin/trails/${trailId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: 'Updated Trail Story', tagline: 'A refreshed route', tier: 'legendary', price_points: 500,
        available_from: availableFrom, available_until: availableUntil,
        narration: [{ position: 1, text: 'A reviewed and accurate narration.' }],
      });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      title: 'Updated Trail Story', tagline: 'A refreshed route', tier: 'legendary',
      unlock_rule: { type: 'points', price_points: 500 },
      story: expect.objectContaining({ title: 'Updated Trail Story', tagline: 'A refreshed route' }),
      stops: [expect.objectContaining({ position: 1, narration: 'A reviewed and accurate narration.' })],
    });
    expect(response.body.data.available_from).toEqual(availableFrom);
    expect(response.body.data.available_until).toEqual(availableUntil);

    const row = await fixture.pool.query(`SELECT t.title,t.tagline,t.tier,t.unlock_rule,t.available_from,t.available_until,t.version,s.narration
      FROM trails t JOIN trail_stops s ON s.trail_id=t.id WHERE t.id=$1`, [trailId]);
    expect(row.rows[0]).toMatchObject({ title: 'Updated Trail Story', tier: 'legendary', narration: 'A reviewed and accurate narration.' });
    expect(Number(row.rows[0].version)).toBe(2);
  });

  test('approximate legs need explicit publish confirmation and generation history is available', async () => {
    const secondSpot = `${spotId}-b`;
    const approximateTrail = 'trl_studio_approximate';
    await fixture.pool.query(`INSERT INTO spots
      (id,slug,name,description,category,subcategory,municipality,address,gps_lat,gps_lng,source_type,source_name,status,is_test)
      VALUES ($1,$1,'Studio Heritage','Second fixture place.','heritage','culture','Bolinao','Bolinao, Pangasinan',16.01,120.01,'editorial','Fixture','published',FALSE)`, [secondSpot]);
    await fixture.pool.query(`INSERT INTO trails
      (id,slug,title,tier,theme,municipalities,unlock_rule,total_minutes,total_km,story,status,source)
      VALUES ($1,$1,'Approximate Trail','starter','mixed',ARRAY['Bolinao'],'{"type":"free"}'::jsonb,90,2,'{}'::jsonb,'pending_review','engine')`, [approximateTrail]);
    await fixture.pool.query(`INSERT INTO trail_stops(trail_id,position,spot_id,arrive_offset_min,dwell_min,leg_minutes,leg_km)
      VALUES($1,1,$2,0,30,0,0),($1,2,$3,45,30,15,2)`, [approximateTrail,spotId,secondSpot]);
    const missingConfirmation = await request(app).post(`/api/v1/admin/trails/${approximateTrail}/publish`).set('Authorization',`Bearer ${adminToken}`).send({});
    expect(missingConfirmation.status).toBe(409);
    expect(missingConfirmation.body.error.code).toBe('APPROXIMATE_LEGS_CONFIRMATION_REQUIRED');
    const confirmed = await request(app).post(`/api/v1/admin/trails/${approximateTrail}/publish`).set('Authorization',`Bearer ${adminToken}`).send({confirm_approximate:true});
    expect(confirmed.status).toBe(200);
    const history = await request(app).get('/api/v1/admin/trails/generations').set('Authorization',`Bearer ${adminToken}`);
    expect(history.status).toBe(200);
    expect(Array.isArray(history.body.data)).toBe(true);
  });

  test('invalid availability and invalid stop edits are rejected without partial writes', async () => {
    const invalidWindow = await request(app).patch(`/api/v1/admin/trails/${trailId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: 'Must Not Commit', available_from: '2026-12-01T00:00:00Z', available_until: '2026-11-01T00:00:00Z' });
    expect(invalidWindow.status).toBe(400);
    expect((await fixture.pool.query('SELECT title FROM trails WHERE id=$1', [trailId])).rows[0].title).toBe('Updated Trail Story');

    const invalidStop = await request(app).patch(`/api/v1/admin/trails/${trailId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: 'Also Must Not Commit', narration: [{ position: 12, text: 'Unknown stop' }] });
    expect(invalidStop.status).toBe(400);
    expect((await fixture.pool.query('SELECT title FROM trails WHERE id=$1', [trailId])).rows[0].title).toBe('Updated Trail Story');
  });
});
