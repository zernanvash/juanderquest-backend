import request from 'supertest';
import { app } from '../src/app.js';
import { spotStore } from '../src/spots/store.js';

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
});
