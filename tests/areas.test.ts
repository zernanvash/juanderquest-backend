import request from 'supertest';
import { app } from '../src/app.js';
import { pointInPolygon, pointInRing, createCirclePolygon, distanceMeters } from '../src/maps/geometry.js';
import { matchSpotToAreas, AreaRecord } from '../src/maps/areas-service.js';

describe('Admin Areas & Geometry Utilities (Plan 45 Phase 2)', () => {
  describe('Point-in-polygon & Geometry', () => {
    // Square around [120, 16] with side length 0.2
    const squareRing: [number, number][] = [
      [119.9, 15.9],
      [120.1, 15.9],
      [120.1, 16.1],
      [119.9, 16.1],
      [119.9, 15.9],
    ];

    it('identifies points strictly inside a ring', () => {
      expect(pointInRing(120.0, 16.0, squareRing)).toBe(true);
      expect(pointInRing(120.05, 16.05, squareRing)).toBe(true);
    });

    it('identifies points strictly outside a ring', () => {
      expect(pointInRing(120.5, 16.0, squareRing)).toBe(false);
      expect(pointInRing(120.0, 16.5, squareRing)).toBe(false);
      expect(pointInRing(119.5, 15.5, squareRing)).toBe(false);
    });

    it('handles polygon with holes', () => {
      // Outer square [10, 10] to [20, 20], hole from [13, 13] to [17, 17]
      const outer: [number, number][] = [
        [10, 10], [20, 10], [20, 20], [10, 20], [10, 10]
      ];
      const hole: [number, number][] = [
        [13, 13], [17, 13], [17, 17], [13, 17], [13, 13]
      ];

      expect(pointInPolygon(11, 11, [outer, hole])).toBe(true);
      // Point inside the hole should be false
      expect(pointInPolygon(15, 15, [outer, hole])).toBe(false);
      // Point outside outer should be false
      expect(pointInPolygon(25, 25, [outer, hole])).toBe(false);
    });

    it('calculates accurate Haversine distance in meters', () => {
      // Dagupan to Calasiao (~5 km)
      const d = distanceMeters(16.0433, 120.3333, 16.0167, 120.35);
      expect(d).toBeGreaterThan(3000);
      expect(d).toBeLessThan(6000);
    });

    it('creates circular polygon with radius for fallback areas', () => {
      const circle = createCirclePolygon(120.33, 16.04, 600, 16);
      expect(circle).toHaveLength(1);
      expect(circle[0].length).toBe(17); // 16 segments + closing point
      // Center point is inside the circle
      expect(pointInRing(120.33, 16.04, circle[0])).toBe(true);
      // Far point is outside
      expect(pointInRing(120.45, 16.04, circle[0])).toBe(false);
    });
  });

  describe('Area Matching Service', () => {
    const mockAreas: AreaRecord[] = [
      {
        id: 'dagupan',
        psgc_code: 105518000,
        level: 'town',
        name: 'Dagupan City',
        display_name: 'Dagupan City, Pangasinan',
        parent_id: 'pangasinan',
        osm_relation_id: null,
        has_boundary: true,
        label_lat: 16.0433,
        label_lng: 120.3333,
        bbox: [120.3, 16.0, 120.4, 16.1],
        min_zoom: 9,
        shape_file: null,
        data_version: 'test',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [120.3, 16.0],
              [120.4, 16.0],
              [120.4, 16.1],
              [120.3, 16.1],
              [120.3, 16.0],
            ],
          ],
        },
      },
      {
        id: 'dagupan--pantal',
        psgc_code: 105518022,
        level: 'barangay',
        name: 'Pantal',
        display_name: 'Pantal, Dagupan City',
        parent_id: 'dagupan',
        osm_relation_id: null,
        has_boundary: true,
        label_lat: 16.05,
        label_lng: 120.34,
        bbox: [120.33, 16.045, 120.35, 16.055],
        min_zoom: 13,
        shape_file: null,
        data_version: 'test',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [120.33, 16.045],
              [120.35, 16.045],
              [120.35, 16.055],
              [120.33, 16.055],
              [120.33, 16.045],
            ],
          ],
        },
      },
    ];

    it('matches coordinates to town and barangay via point-in-polygon', () => {
      const match = matchSpotToAreas(16.05, 120.34, 'Dagupan City', mockAreas);
      expect(match.townAreaId).toBe('dagupan');
      expect(match.barangayAreaId).toBe('dagupan--pantal');
    });

    it('falls back to town name matching when point is slightly outside town polygon', () => {
      const match = matchSpotToAreas(15.95, 120.25, 'Dagupan City', mockAreas);
      expect(match.townAreaId).toBe('dagupan');
    });

    it('matches nearest centroid for polygon-less barangays within 1.5 km', () => {
      const fallbackAreas: AreaRecord[] = [
        ...mockAreas,
        {
          id: 'dagupan--fallback-bgy',
          psgc_code: 105518999,
          level: 'barangay',
          name: 'Fallback Bgy',
          display_name: 'Fallback Bgy, Dagupan City',
          parent_id: 'dagupan',
          osm_relation_id: null,
          has_boundary: false, // No polygon
          label_lat: 16.08,
          label_lng: 120.38,
          bbox: [120.375, 16.075, 120.385, 16.085],
          min_zoom: 13,
          shape_file: null,
          data_version: 'test',
        },
      ];

      // Point within 500m of Fallback Bgy centroid
      const match = matchSpotToAreas(16.082, 120.382, 'Dagupan City', fallbackAreas);
      expect(match.townAreaId).toBe('dagupan');
      expect(match.barangayAreaId).toBe('dagupan--fallback-bgy');
    });
  });

  describe('HTTP Endpoints /api/v1/areas', () => {
    it('returns public list of areas with Cache-Control headers', async () => {
      const res = await request(app).get('/api/v1/areas?zoom=10');
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toContain('max-age=300');
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('returns 404 for non-existent area', async () => {
      const res = await request(app).get('/api/v1/areas/non-existent-area-id');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('AREA_NOT_FOUND');
    });

    it('returns paginated spots for an area', async () => {
      const res = await request(app).get('/api/v1/areas/dagupan/spots?page=1&limit=5');
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toContain('max-age=300');
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.meta).toBeDefined();
    });
  });
});
