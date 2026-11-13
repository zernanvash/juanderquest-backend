import { calculateRoute, routeTimeoutMs } from '../src/services/routing.js';
import { spotStore, type Spot } from '../src/spots/store.js';
import { log } from '../src/utils/logger.js';

function makeSpot(id: string, lat: number, lng: number): Spot {
  return {
    id,
    slug: id,
    name: id,
    municipality: 'Dagupan',
    gps_lat: lat,
    gps_lng: lng,
  } as Spot;
}

function makeValhallaOkBody() {
  return {
    trip: {
      summary: { length: 144.39, time: 7200 },
      legs: [
        {
          // Two-point valid polyline6 around Dagupan
          shape: 'w~hbB_b`_V??',
          maneuvers: [{ instruction: 'Drive north', length: 1, time: 60 }],
        },
      ],
    },
  };
}

describe('Plan 86a: trail route fallback fixes', () => {
  const originalSpots = spotStore.spots;

  afterEach(() => {
    spotStore.spots = originalSpots;
    jest.restoreAllMocks();
  });

  it('skips avoid box for a busy spot at a via point, keeps one for a busy spot away from route', async () => {
    const busyAtVia = makeSpot('busy-via', 16.05, 120.48);
    const busyAway = makeSpot('busy-away', 15.95, 120.2);
    spotStore.spots = [busyAtVia, busyAway];
    jest.spyOn(spotStore, 'crowd').mockReturnValue({ crowd_status: 'estimated_busy' } as any);

    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => makeValhallaOkBody(),
    } as Response);

    const res = await calculateRoute({
      startLat: 16.02,
      startLng: 120.23,
      endLat: 16.38,
      endLng: 119.89,
      via: [{ lat: 16.05, lng: 120.48 }],
      avoidCongested: true,
    });

    expect(res.degraded).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const sentBody = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body));
    expect(sentBody.avoid_polygons).toHaveLength(1);
    // Remaining box belongs to busyAway (15.95, 120.2)
    const ring = sentBody.avoid_polygons[0][0];
    expect(ring[0][0]).toBeCloseTo(120.2 - 0.0045, 4);
    expect(ring[0][1]).toBeCloseTo(15.95 - 0.0045, 4);
  });

  it('retries once without avoid_polygons on Valhalla 400 and returns normal route', async () => {
    spotStore.spots = [makeSpot('busy-away', 15.95, 120.2)];
    jest.spyOn(spotStore, 'crowd').mockReturnValue({ crowd_status: 'estimated_busy' } as any);

    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ error_code: 442, error: 'No path could be found' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => makeValhallaOkBody(),
      } as Response);

    const res = await calculateRoute({
      startLat: 16.02,
      startLng: 120.23,
      endLat: 16.38,
      endLng: 119.89,
      via: [{ lat: 16.05, lng: 120.48 }],
      avoidCongested: true,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body));
    const secondBody = JSON.parse(String(fetchSpy.mock.calls[1][1]?.body));
    expect(firstBody.avoid_polygons).toBeDefined();
    expect(secondBody.avoid_polygons).toBeUndefined();
    expect(res.degraded).toBe(false);
    expect(res.summary.hasCrowdDiversion).toBe(false);
    expect(res.summary.has_crowd_diversion).toBe(false);
  });

  it('returns no_route without retry when Valhalla answers 400 and no boxes were sent', async () => {
    spotStore.spots = [];
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error_code: 442 }),
    } as Response);

    const res = await calculateRoute({
      startLat: 16.02,
      startLng: 120.23,
      endLat: 16.38,
      endLng: 119.89,
      avoidCongested: false,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(res.degraded).toBe(true);
    expect(res.warning?.code).toBe('STRAIGHT_LINE_FALLBACK');
    expect(res.warning?.reason).toBe('no_route');
  });

  it('classifies aborted fetch as timeout and 500 as engine_error', async () => {
    spotStore.spots = [];
    const timeoutErr = new Error('The operation was aborted due to timeout');
    timeoutErr.name = 'TimeoutError';
    jest.spyOn(global, 'fetch').mockRejectedValueOnce(timeoutErr);

    const timeoutRes = await calculateRoute({
      startLat: 16.02,
      startLng: 120.23,
      endLat: 16.38,
      endLng: 119.89,
      avoidCongested: false,
    });
    expect(timeoutRes.degraded).toBe(true);
    expect(timeoutRes.warning?.reason).toBe('timeout');

    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 500,
    } as Response);

    const errRes = await calculateRoute({
      startLat: 16.02,
      startLng: 120.23,
      endLat: 16.38,
      endLng: 119.89,
      avoidCongested: false,
    });
    expect(errRes.degraded).toBe(true);
    expect(errRes.warning?.reason).toBe('engine_error');
  });

  it('scales routeTimeoutMs between 4000 and 12000 by distance and stops', () => {
    expect(routeTimeoutMs(5, 0)).toBe(4000);
    expect(routeTimeoutMs(300, 4)).toBe(12000);
    const mid = routeTimeoutMs(150, 2);
    expect(mid).toBeGreaterThan(4000);
    expect(mid).toBeLessThan(12000);
  });

  it('emits structured log without lat/lng coordinates', async () => {
    spotStore.spots = [];
    const infoSpy = jest.spyOn(log, 'info').mockImplementation(() => {});
    const warnSpy = jest.spyOn(log, 'warn').mockImplementation(() => {});
    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => makeValhallaOkBody(),
    } as Response);

    await calculateRoute({
      startLat: 16.02,
      startLng: 120.23,
      endLat: 16.38,
      endLng: 119.89,
      avoidCongested: false,
    });

    const call = infoSpy.mock.calls[0] ?? warnSpy.mock.calls[0];
    expect(call).toBeDefined();
    const meta = (call[1] ?? {}) as Record<string, unknown>;
    const serialized = JSON.stringify(meta);
    expect(serialized).not.toMatch(/"lat"|"lng"|"startLat"|"startLng"|"userId"|"user_id"/);
    expect(meta).toEqual(
      expect.objectContaining({
        costing: 'auto',
        via_count: 0,
        avoid_boxes: 0,
        retried_without_boxes: false,
        valhalla_status: 200,
      }),
    );
  });
});
