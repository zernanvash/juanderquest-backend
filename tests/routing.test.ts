import request from 'supertest';
import { app } from '../src/app.js';
import { decodePolyline6, formatDuration, computeHaversineDistanceKm } from '../src/services/routing.js';

function encodePolyline6(coords: [number, number][]): string {
  let output = '';
  let prevLat = 0;
  let prevLng = 0;

  for (const [lat, lng] of coords) {
    const latInt = Math.round(lat * 1e6);
    const lngInt = Math.round(lng * 1e6);
    let dLat = latInt - prevLat;
    let dLng = lngInt - prevLng;
    prevLat = latInt;
    prevLng = lngInt;

    for (let num of [dLat, dLng]) {
      num = num < 0 ? ~(num << 1) : num << 1;
      while (num >= 0x20) {
        output += String.fromCharCode((0x20 | (num & 0x1f)) + 63);
        num >>= 5;
      }
      output += String.fromCharCode(num + 63);
    }
  }
  return output;
}

describe('Valhalla Routing & Polyline Decoder', () => {
  test('decodes 6-decimal encoded polyline correctly', () => {
    const testPoints: [number, number][] = [
      [16.043312, 120.333345],
      [16.021876, 120.231912],
      [16.386123, 119.782845],
    ];
    const encoded = encodePolyline6(testPoints);
    const decoded = decodePolyline6(encoded);

    expect(decoded.length).toBe(3);
    expect(decoded[0][0]).toBeCloseTo(16.043312, 5);
    expect(decoded[0][1]).toBeCloseTo(120.333345, 5);
    expect(decoded[1][0]).toBeCloseTo(16.021876, 5);
    expect(decoded[1][1]).toBeCloseTo(120.231912, 5);
    expect(decoded[2][0]).toBeCloseTo(16.386123, 5);
    expect(decoded[2][1]).toBeCloseTo(119.782845, 5);
  });

  test('formats travel duration into friendly hours and minutes', () => {
    expect(formatDuration(45)).toBe('1 min');
    expect(formatDuration(1800)).toBe('30 mins');
    expect(formatDuration(3600)).toBe('1 hr');
    expect(formatDuration(5400)).toBe('1 hr 30 mins');
    expect(formatDuration(7200)).toBe('2 hrs');
  });

  test('computes accurate Haversine distance in kilometers', () => {
    // Distance between Dagupan (16.0433, 120.3333) and Lingayen Capitol (16.0218, 120.2319) is ~11.1 km
    const dist = computeHaversineDistanceKm(16.0433, 120.3333, 16.0218, 120.2319);
    expect(dist).toBeGreaterThan(10);
    expect(dist).toBeLessThan(12);
  });

  describe('API Endpoints /api/v1/routes', () => {
    test('GET /api/v1/routes returns route calculation or graceful fallback', async () => {
      const res = await request(app)
        .get('/api/v1/routes')
        .query({
          start_lat: 16.0433,
          start_lng: 120.3333,
          end_lat: 16.0218,
          end_lng: 120.2319,
          costing: 'auto',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.summary.distanceKm).toBeGreaterThan(0);
      expect(res.body.data.coordinates.length).toBeGreaterThanOrEqual(2);
      expect(res.body.data.maneuvers.length).toBeGreaterThan(0);
    });

    test('POST /api/v1/routes handles JSON body payload', async () => {
      const res = await request(app)
        .post('/api/v1/routes')
        .send({
          start: { lat: 16.0433, lng: 120.3333 },
          end: { lat: 16.3861, lng: 119.7828 }, // Patar Beach
          costing: 'auto',
          avoid_congested: true,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.summary.costing).toBe('auto');
      expect(res.body.data.coordinates).toBeDefined();
    });

    test('POST /api/v1/routes validates invalid coordinates with 400', async () => {
      const res = await request(app)
        .post('/api/v1/routes')
        .send({
          start: { lat: 999, lng: 120.3333 }, // Invalid latitude
          end: { lat: 16.3861, lng: 119.7828 },
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_PAYLOAD');
    });
  });
});
