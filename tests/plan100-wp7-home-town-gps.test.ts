import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import { db } from '../src/db/index.js';
import { setPool } from '../src/db/pool.js';
import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';
import { ensureAreaCache } from '../src/maps/areas-service.js';
import { recordHomeTownSighting } from '../src/social/homeTown.js';

const realPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;
jest.setTimeout(180_000);

realPg('Plan 100 WP-7: home town from GPS (real PostgreSQL)', () => {
  let fixture: TestDbInstance;
  const userId = `wp7-user-${randomUUID().slice(0, 8)}`;

  const auth = () => ({
    Authorization: `Bearer ${jwt.sign({ id: userId, seed_id: userId, role: 'user', typ: 'session' }, env.JWT_SECRET, { expiresIn: '1h' })}`,
  });

  beforeAll(async () => {
    fixture = await createTestDb({ poolMax: 10 });
    setPool(fixture.pool);
    db.attachDurabilityPool(fixture.pool);
    db.usersRepo.setPool(fixture.pool);

    await fixture.pool.query(
      `INSERT INTO users(id, seed_id, display_name, email, role, is_test)
       VALUES ($1::text, $1::text, 'WP7 Traveler', $1::text || '@example.test', 'user', FALSE)`,
      [userId],
    );

    const dagupanPoly = JSON.stringify({
      type: 'Polygon',
      coordinates: [
        [
          [120.3, 16.01],
          [120.37, 16.01],
          [120.37, 16.08],
          [120.3, 16.08],
          [120.3, 16.01],
        ],
      ],
    });
    const bolinaoPoly = JSON.stringify({
      type: 'Polygon',
      coordinates: [
        [
          [119.83, 16.3],
          [119.95, 16.3],
          [119.95, 16.43],
          [119.83, 16.43],
          [119.83, 16.3],
        ],
      ],
    });
    await fixture.pool.query(
      `INSERT INTO admin_areas(id, level, name, display_name, parent_id, has_boundary, label_lat, label_lng, bbox, min_zoom, boundary)
       VALUES
         ('province:wp7-pang', 'province', 'Pangasinan', 'Pangasinan', NULL, TRUE, 16.0, 120.2, ARRAY[119.7, 15.7, 120.9, 16.5]::double precision[], 5, NULL),
         ('town:wp7-dagupan', 'town', 'Dagupan City', 'Dagupan City, Pangasinan', 'province:wp7-pang', TRUE, 16.0431, 120.3333, ARRAY[120.30, 16.01, 120.37, 16.08]::double precision[], 11, $1::jsonb),
         ('town:wp7-bolinao', 'town', 'Bolinao', 'Bolinao, Pangasinan', 'province:wp7-pang', TRUE, 16.386, 119.893, ARRAY[119.83, 16.30, 119.95, 16.43]::double precision[], 11, $2::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [dagupanPoly, bolinaoPoly],
    );
    await ensureAreaCache(fixture.pool, true);
  });

  afterAll(async () => {
    setPool(null);
    await fixture?.close();
  });

  it('ignores mocked, inaccurate (>100m), and out-of-province sightings', async () => {
    const mocked = await request(app)
      .post('/api/v1/me/home-town/sighting')
      .set(auth())
      .send({ lat: 16.0431, lng: 120.3333, accuracy: 15, is_mocked: true });
    expect(mocked.status).toBe(200);
    expect(mocked.body.data.accepted).toBe(false);
    expect(mocked.body.data.ignored_reason).toBe('mocked_location');

    const inaccurate = await request(app)
      .post('/api/v1/me/home-town/sighting')
      .set(auth())
      .send({ lat: 16.0431, lng: 120.3333, accuracy: 120, is_mocked: false });
    expect(inaccurate.status).toBe(200);
    expect(inaccurate.body.data.accepted).toBe(false);
    expect(inaccurate.body.data.ignored_reason).toBe('low_accuracy');

    const outside = await request(app)
      .post('/api/v1/me/home-town/sighting')
      .set(auth())
      .send({ lat: 14.5995, lng: 120.9842, accuracy: 15, is_mocked: false });
    expect(outside.status).toBe(200);
    expect(outside.body.data.accepted).toBe(false);
    expect(outside.body.data.ignored_reason).toBe('outside_pangasinan');
  });

  it('dedupes per town per day, rejects teleports (>150 km/h), decides at 5 days, and switches on majority', async () => {
    const base = new Date('2026-11-01T08:00:00.000Z');
    const day = (offsetDays: number, extraMs = 0) => new Date(base.getTime() + offsetDays * 86_400_000 + extraMs);

    // Day 0 in Dagupan
    const d0 = await recordHomeTownSighting(userId, {
      lat: 16.0431,
      lng: 120.3333,
      accuracy: 12,
      is_mocked: false,
      now: day(0),
    });
    expect(d0.accepted).toBe(true);
    expect(d0.state.days_progress.current_days).toBe(1);
    expect(d0.state.home_municipality).toBeNull();

    // Same day in Dagupan -> deduped
    const d0Dup = await recordHomeTownSighting(userId, {
      lat: 16.0435,
      lng: 120.3335,
      accuracy: 12,
      is_mocked: false,
      now: day(0, 45 * 60_000),
    });
    expect(d0Dup.accepted).toBe(false);
    expect(d0Dup.ignored_reason).toBe('already_recorded_today');

    // 10 minutes later in Bolinao (~60 km away => ~360 km/h) -> teleport rejected
    const teleport = await recordHomeTownSighting(userId, {
      lat: 16.386,
      lng: 119.893,
      accuracy: 12,
      is_mocked: false,
      now: day(0, 10 * 60_000),
    });
    expect(teleport.accepted).toBe(false);
    expect(teleport.ignored_reason).toBe('teleport_detected');

    // Days 1..4 in Dagupan -> 5 distinct days decides Dagupan City
    for (let i = 1; i <= 4; i++) {
      const res = await recordHomeTownSighting(userId, {
        lat: 16.0431,
        lng: 120.3333,
        accuracy: 12,
        is_mocked: false,
        now: day(i),
      });
      expect(res.accepted).toBe(true);
    }
    const decided = await recordHomeTownSighting(userId, {
      lat: 16.0431,
      lng: 120.3333,
      accuracy: 12,
      is_mocked: false,
      now: day(4, 30 * 60_000),
    });
    expect(decided.state.days_progress.current_days).toBe(5);
    expect(decided.state.home_municipality).toBe('Dagupan City');
    expect(decided.state.home_town_source).toBe('gps');

    // Days 5..10 in Bolinao (6 distinct days > 5 days in Dagupan) -> switches to Bolinao
    for (let i = 5; i <= 10; i++) {
      const res = await recordHomeTownSighting(userId, {
        lat: 16.386,
        lng: 119.893,
        accuracy: 12,
        is_mocked: false,
        now: day(i),
      });
      expect(res.accepted).toBe(true);
    }
    const afterSwitch = await request(app).get('/api/v1/me/home-town').set(auth());
    expect(afterSwitch.status).toBe(200);
    expect(afterSwitch.body.data.home_municipality).toBe('Bolinao');
    expect(afterSwitch.body.data.home_town_source).toBe('gps');
    expect(afterSwitch.body.data.days_progress.current_days).toBe(6);
  });

  it('stops sightings and allows manual PUT when home_town_gps is turned off', async () => {
    const offRes = await request(app).put('/api/v1/me/home-town/gps').set(auth()).send({ enabled: false });
    expect(offRes.status).toBe(200);
    expect(offRes.body.data.home_town_gps).toBe(false);

    const ignored = await request(app)
      .post('/api/v1/me/home-town/sighting')
      .set(auth())
      .send({ lat: 16.0431, lng: 120.3333, accuracy: 12, is_mocked: false });
    expect(ignored.status).toBe(200);
    expect(ignored.body.data.accepted).toBe(false);
    expect(ignored.body.data.ignored_reason).toBe('gps_disabled');

    const manual = await request(app).put('/api/v1/me/home-town').set(auth()).send({ municipality: 'Alaminos City' });
    expect(manual.status).toBe(200);
    expect(manual.body.data.home_municipality).toBe('Alaminos City');
    expect(manual.body.data.home_town_source).toBe('manual');
  });
});
