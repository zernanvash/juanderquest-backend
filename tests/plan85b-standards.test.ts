import jwt from 'jsonwebtoken';
import express from 'express';
import request from 'supertest';
import { env } from '../src/config/env.js';
import { signSessionToken, verifySessionToken } from '../src/auth/tokens.js';
import { requestTracingMiddleware } from '../src/middleware/observability.js';
import { log } from '../src/utils/logger.js';
import { createTestDb } from '../src/db/testHarness.js';
import { setPool } from '../src/db/pool.js';
import { db } from '../src/db/index.js';
import { trailsRouter } from '../src/routes/trails.js';
import routesRouter from '../src/routes/routes.js';
import * as routingService from '../src/services/routing.js';

describe('Plan 85b: API standards', () => {
  it('1. GET /trails/:id (unlocked) returns explicit fields with real numbers for km/distance/accuracy', async () => {
    const testDb = await createTestDb();
    setPool(testDb.pool);
    db.usersRepo.setPool(testDb.pool);
    try {
      const userId = '00000000-0000-4000-8000-0000000085b1';
      await testDb.pool.query(
        `INSERT INTO users (id, seed_id, email, display_name, role, is_test, session_epoch) VALUES ($1, $2, 'trail-85b@example.com', 'Trail Tester', 'user', false, 0)`,
        [userId, 'seed_85b_1'],
      );
      const spotId = '00000000-0000-4000-8000-0000000085b2';
      await testDb.pool.query(
        `INSERT INTO spots (id, slug, name, description, category, subcategory, municipality, address, gps_lat, gps_lng, source_type, source_name, status, is_test)
         VALUES ($1, $2, 'Lingayen Spot', 'Test spot.', 'Heritage', 'Museum', 'Lingayen', 'Lingayen, Pangasinan', 16.0218, 120.2319, 'editorial', 'fixture', 'approved', false)`,
        [spotId, 'spot-85b-1'],
      );
      const trailId = '00000000-0000-4000-8000-0000000085b3';
      await testDb.pool.query(
        `INSERT INTO trails (id, slug, title, tagline, tier, theme, municipalities, unlock_rule, total_minutes, total_km, status, source, is_test)
         VALUES ($1, $2, '85b Trail', 'Tagline', 'starter', 'heritage', $3, '{"type":"free"}', 45, 8.74, 'published', 'engine', false)`,
        [trailId, 'trail-85b-1', ['Lingayen']],
      );
      await testDb.pool.query(
        `INSERT INTO trail_stops (trail_id, position, spot_id, arrive_offset_min, dwell_min, leg_minutes, leg_km, narration, checkin_radius_m)
         VALUES ($1, 1, $2, 0, 20, 12, 3.25, 'Look around.', 50)`,
        [trailId, spotId],
      );
      await testDb.pool.query(
        `INSERT INTO trail_unlocks (trail_id, user_id, method, price_points, idempotency_key) VALUES ($1, $2, 'free', 0, 'idem-85b-1')`,
        [trailId, userId],
      );
      await testDb.pool.query(
        `INSERT INTO trail_checkins (trail_id, user_id, position, distance_m, accuracy_m) VALUES ($1, $2, 1, 15, 9)`,
        [trailId, userId],
      );

      const token = signSessionToken({ id: userId, seed_id: 'seed_85b_1', role: 'user', session_epoch: 0 });
      const miniApp = express();
      miniApp.use(express.json());
      miniApp.use('/api/v1', trailsRouter);

      const res = await request(miniApp).get(`/api/v1/trails/${trailId}`).set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(typeof res.body.data.total_km).toBe('number');
      expect(res.body.data.total_km).toBeCloseTo(8.74, 2);
      expect(res.body.data.status).toBeUndefined();
      expect(res.body.data.is_test).toBeUndefined();
      expect(res.body.data.stops).toHaveLength(1);
      expect(typeof res.body.data.stops[0].leg_km).toBe('number');
      expect(res.body.data.stops[0].leg_km).toBeCloseTo(3.25, 2);
      expect(typeof res.body.data.stops[0].distance_m).toBe('number');
      expect(res.body.data.stops[0].distance_m).toBe(15);
      expect(typeof res.body.data.stops[0].accuracy_m).toBe('number');
      expect(res.body.data.stops[0].accuracy_m).toBe(9);
    } finally {
      db.usersRepo.setPool(null);
      setPool(null);
      await testDb.close();
    }
  }, 120_000);

  it('3. GET and POST /routes include snake_case summary and navigation_mode alongside camelCase keys', async () => {
    const spy = jest.spyOn(routingService, 'calculateRoute').mockResolvedValue({
      degraded: false,
      navigationMode: 'turn_by_turn',
      navigation_mode: 'turn_by_turn',
      summary: {
        distanceKm: 12.4,
        distance_km: 12.4,
        durationSeconds: 900,
        duration_seconds: 900,
        durationFormatted: '15 mins',
        duration_formatted: '15 mins',
        costing: 'auto',
        hasCrowdDiversion: false,
        has_crowd_diversion: false,
        engine: 'valhalla',
      },
      coordinates: [
        [16.02, 120.23],
        [16.04, 120.33],
      ],
      maneuvers: [],
    });

    const miniApp = express();
    miniApp.use(express.json());
    miniApp.use('/api/v1', routesRouter);

    const getRes = await request(miniApp).get(
      '/api/v1/routes?start_lat=16.02&start_lng=120.23&end_lat=16.04&end_lng=120.33',
    );
    expect(getRes.status).toBe(200);
    expect(getRes.body.data.navigationMode).toBe('turn_by_turn');
    expect(getRes.body.data.navigation_mode).toBe('turn_by_turn');
    expect(getRes.body.data.summary.distanceKm).toBe(12.4);
    expect(getRes.body.data.summary.distance_km).toBe(12.4);
    expect(getRes.body.data.summary.duration_seconds).toBe(900);
    expect(getRes.body.data.summary.duration_formatted).toBe('15 mins');
    expect(getRes.body.data.summary.has_crowd_diversion).toBe(false);

    const postRes = await request(miniApp)
      .post('/api/v1/routes')
      .send({ start: { lat: 16.02, lng: 120.23 }, end: { lat: 16.04, lng: 120.33 } });
    expect(postRes.status).toBe(200);
    expect(postRes.body.data.navigation_mode).toBe('turn_by_turn');
    expect(postRes.body.data.summary.distance_km).toBe(12.4);

    spy.mockRestore();
  });

  it('4. verifySessionToken rejects tokens missing typ === session', () => {
    const legacyToken = jwt.sign({ id: 'u-1', seed_id: 'seed_1', role: 'user', sep: 0 }, env.JWT_SECRET, {
      algorithm: 'HS256',
      expiresIn: 300,
    });
    expect(verifySessionToken(legacyToken)).toBeNull();

    const validToken = signSessionToken({ id: 'u-1', seed_id: 'seed_1', role: 'user', sep: 0 });
    expect(verifySessionToken(validToken)?.id).toBe('u-1');
  });

  it('5. logger emits JSON lines with level, ISO time, and request_id from x-request-id middleware', async () => {
    const written: string[] = [];
    const spy = jest.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    try {
      const miniApp = express();
      miniApp.use(requestTracingMiddleware);
      miniApp.get('/ping-log', (_req, res) => {
        log.info('test_event', { ok: true });
        res.json({ ok: true });
      });

      const res = await request(miniApp).get('/ping-log').set('x-request-id', 'req-85b-trace');
      expect(res.status).toBe(200);
      expect(res.headers['x-request-id']).toBe('req-85b-trace');
      const parsed = JSON.parse(written[written.length - 1]);
      expect(parsed.level).toBe('info');
      expect(Number.isNaN(Date.parse(parsed.time))).toBe(false);
      expect(parsed.message).toBe('test_event');
      expect(parsed.request_id).toBe('req-85b-trace');
      expect(parsed.ok).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
