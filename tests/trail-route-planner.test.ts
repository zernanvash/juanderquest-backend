import request from 'supertest';
import { app } from '../src/app.js';
import { spotStore } from '../src/spots/store.js';
import { groupDetourAreas, CandidateStop } from '../src/services/trail.js';

describe('Phase 4: Deterministic Trail Corridor Route & Stop Planner Slice', () => {
  test('1. GET /api/v1/trail/service-area returns explicit service area metadata and ODbL license', async () => {
    const res = await request(app).get('/api/v1/trail/service-area');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe('pangasinan-pilot');
    expect(res.body.data.name).toContain('Pangasinan Tourism Corridor');
    expect(res.body.data.license).toContain('OpenStreetMap Contributors');
    expect(res.body.data.supported_modes).toEqual(
      expect.arrayContaining(['auto', 'motorcycle', 'bicycle', 'pedestrian'])
    );
  });

  test('2. Reject invalid trail plan payload with 400', async () => {
    const res = await request(app)
      .post('/api/v1/trail/plan')
      .send({
        start: { lat: 100, lng: 120 }, // invalid lat > 90
        end: { lat: 16.0, lng: 120.0 },
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test('3. Plan corridor route between Dagupan and Alaminos with deterministic stops', async () => {
    // Dagupan City to Alaminos City (Hundred Islands corridor)
    const res = await request(app)
      .post('/api/v1/trail/plan')
      .send({
        start: { lat: 16.0433, lng: 120.3333, name: 'Dagupan City Plaza' },
        end: { lat: 16.1550, lng: 119.9800, name: 'Hundred Islands National Park' },
        costing: 'auto',
        max_stops: 3,
        max_detour_km: 20,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const plan = res.body.data;

    // Verify baseline route is present
    expect(plan.baseline_route).toBeDefined();
    expect(plan.baseline_route.summary).toBeDefined();
    expect(plan.baseline_route.summary.distanceKm).toBeGreaterThan(0);
    expect(Array.isArray(plan.baseline_route.coordinates)).toBe(true);

    // Verify suggested stops
    expect(Array.isArray(plan.suggested_stops)).toBe(true);
    expect(plan.suggested_stops.length).toBeLessThanOrEqual(3);

    // Verify each stop structure, detour math, and truthful labeling
    for (const stop of plan.suggested_stops) {
      expect(stop.spot_id).toBeDefined();
      expect(stop.name).toBeDefined();
      expect(typeof stop.detour_km).toBe('number');
      expect(stop.detour_km).toBeLessThanOrEqual(20);
      expect(Array.isArray(stop.reason_codes)).toBe(true);
      expect(stop.reason_codes.length).toBeGreaterThan(0);
      // Strictly Curated or Suggested, never Trending
      expect(['Curated', 'Suggested']).toContain(stop.recommendation_label);
    }

    // Verify disclaimer
    expect(plan.disclaimer).toContain('Deterministic corridor route');
    expect(plan.disclaimer).toContain('No synthetic AI stops');
  });

  test('4. Respect category preference filter in scoring', async () => {
    const res = await request(app)
      .post('/api/v1/trail/plan')
      .send({
        start: { lat: 16.0433, lng: 120.3333 },
        end: { lat: 16.1550, lng: 119.9800 },
        preferred_categories: ['culture_heritage'],
        max_stops: 2,
        max_detour_km: 30,
      });

    expect(res.status).toBe(200);
    const plan = res.body.data;
    const culturalStop = plan.suggested_stops.find((s: any) => s.category === 'culture_heritage');
    if (culturalStop) {
      expect(culturalStop.reason_codes).toContain('CATEGORY_MATCH');
    }
  });

  test('5. Enforce maximum detour bound strictly', async () => {
    const res = await request(app)
      .post('/api/v1/trail/plan')
      .send({
        start: { lat: 16.0433, lng: 120.3333 },
        end: { lat: 16.0200, lng: 120.2300 }, // short journey (approx 12km)
        max_detour_km: 2, // strictly tiny detour budget
        max_stops: 5,
      });

    expect(res.status).toBe(200);
    const plan = res.body.data;
    for (const stop of plan.suggested_stops) {
      expect(stop.detour_km).toBeLessThanOrEqual(2);
    }
  });

  test('6. Explicitly reports out of primary service area for distant coordinates', async () => {
    const res = await request(app)
      .post('/api/v1/trail/plan')
      .send({
        start: { lat: 14.5995, lng: 120.9842 }, // Manila (outside Pangasinan pilot bbox)
        end: { lat: 16.0433, lng: 120.3333 },
        max_stops: 2,
      });

    expect(res.status).toBe(200);
    expect(res.body.data.is_within_primary_service_area).toBe(false);
  });

  test('Plan 64: detour areas group nearby stops by town and skip the destination town', () => {
    const stop = (id: string, municipality: string, lat: number, lng: number, detour: number, score: number): CandidateStop => ({
      spot_id: id, name: id, category: 'nature_outdoors', municipality, gps_lat: lat, gps_lng: lng, detour_km: detour,
      distance_from_start_km: 10, crowd_status: 'quiet', score, reason_codes: [], recommendation_label: 'Suggested',
    });
    const areas = groupDetourAreas([
      stop('a1', 'Lingayen', 16.02, 120.23, 20, 90), stop('a2', 'Lingayen', 16.03, 120.24, 25, 80),
      stop('b1', 'Dagupan City', 16.04, 120.33, 12, 85),
      stop('c1', 'Baguio', 16.40, 120.59, 2, 120), // destination town: not a detour
      stop('d1', 'Alaminos', 16.16, 119.98, 60, 40), stop('e1', 'Bolinao', 16.38, 119.89, 70, 30),
    ], { lat: 16.4023, lng: 120.596 });
    expect(areas.map((area) => area.municipality)).toEqual(['Lingayen', 'Dagupan City', 'Alaminos']);
    expect(areas[0]).toMatchObject({ spot_count: 2, detour_km: 20, extra_minutes: Math.round((20 / 45) * 60) + 60 });
    expect(areas[0].highlights.map((h) => h.spot_id)).toEqual(['a1', 'a2']);
  });

  test('Plan 64: Manila to Baguio offers Pangasinan detour areas within the scaled budget', async () => {
    const res = await request(app).post('/api/v1/trail/plan').send({
      start: { lat: 14.5995, lng: 120.9842, name: 'Manila' },
      end: { lat: 16.4023, lng: 120.596, name: 'Baguio' },
    });
    expect(res.status).toBe(200);
    const areas = res.body.data.detour_areas as Array<{ municipality: string; detour_km: number; highlights: unknown[] }>;
    expect(areas.length).toBeGreaterThan(0);
    expect(areas.length).toBeLessThanOrEqual(3);
    for (const area of areas) {
      expect(area.detour_km).toBeLessThanOrEqual(80);
      expect(area.highlights.length).toBeGreaterThan(0);
    }
    const ids = new Set(spotStore.spots.filter((spot) => spot.status !== 'published' || spot.is_test).map((spot) => spot.id));
    for (const stop of res.body.data.suggested_stops) expect(ids.has(stop.spot_id)).toBe(false);
  });

  test('Plan 64: an added detour is routed through (via)', async () => {
    const via = { lat: 16.0433, lng: 120.3333 };
    const res = await request(app).post('/api/v1/trail/plan').send({
      start: { lat: 14.5995, lng: 120.9842 }, end: { lat: 16.4023, lng: 120.596 }, via: [via],
    });
    expect(res.status).toBe(200);
    const coords = res.body.data.baseline_route.coordinates as [number, number][];
    const nearest = Math.min(...coords.map(([lat, lng]) => Math.hypot(lat - via.lat, lng - via.lng)));
    expect(nearest).toBeLessThan(0.05);
    const bad = await request(app).post('/api/v1/trail/plan').send({
      start: { lat: 14.5995, lng: 120.9842 }, end: { lat: 16.4023, lng: 120.596 }, via: [via, via, via, via],
    });
    expect(bad.status).toBe(400);
  });

  test('Plan 64: POST /routes routes trail navigation through its stops (via)', async () => {
    const via = [{ lat: 16.2, lng: 119.97 }, { lat: 16.37, lng: 119.88 }];
    const res = await request(app).post('/api/v1/routes').send({ start: { lat: 16.04, lng: 120.33 }, end: { lat: 16.39, lng: 119.9 }, via });
    expect(res.status).toBe(200);
    const coords = res.body.data.coordinates as [number, number][];
    for (const point of via) {
      expect(Math.min(...coords.map(([lat, lng]) => Math.hypot(lat - point.lat, lng - point.lng)))).toBeLessThan(0.05);
    }
    const tooMany = await request(app).post('/api/v1/routes').send({ start: { lat: 16, lng: 120 }, end: { lat: 16.1, lng: 120.1 }, via: Array(11).fill(via[0]) });
    expect(tooMany.status).toBe(400);
  });
});
