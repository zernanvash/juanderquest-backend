import request from 'supertest';
import { app } from '../src/app';
import * as routingService from '../src/services/routing.js';

describe('POST /api/v1/routes with via waypoints (Plan 83a)', () => {
  it('forwards via waypoints to calculateRoute', async () => {
    const spy = jest.spyOn(routingService, 'calculateRoute').mockResolvedValueOnce({
      degraded: false,
      navigationMode: 'turn_by_turn',
      summary: {
        distanceKm: 25.5,
        durationSeconds: 1800,
        durationFormatted: '30 mins',
        costing: 'auto',
        hasCrowdDiversion: false,
        engine: 'valhalla',
      },
      coordinates: [
        [16.03, 120.33],
        [16.05, 120.35],
        [16.10, 120.40],
      ],
      maneuvers: [],
    });

    const response = await request(app)
      .post('/api/v1/routes')
      .send({
        start: { lat: 16.03, lng: 120.33 },
        end: { lat: 16.10, lng: 120.40 },
        via: [{ lat: 16.05, lng: 120.35 }],
        costing: 'auto',
        avoid_congested: true,
      });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        startLat: 16.03,
        startLng: 120.33,
        endLat: 16.10,
        endLng: 120.40,
        costing: 'auto',
        avoidCongested: true,
        via: [{ lat: 16.05, lng: 120.35 }],
      }),
    );
    spy.mockRestore();
  });
});
