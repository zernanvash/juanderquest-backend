// Plan 116 §6: national-scale read paths (bounded ranking, map clusters, typeahead, paging).
import request from 'supertest';
import { app } from '../src/app';
import { SpotStore, type Spot } from '../src/spots/store.js';
import { rankExploreSpotsPage, RANK_CANDIDATE_CAP, CACHED_HEAD } from '../src/spots/recommender.js';
import { mapView, searchSpotsInMemory, MAP_MARKER_LIMIT } from '../src/spots/national.js';

const base = new Date('2026-11-01T00:00:00Z').toISOString();

function syntheticSpot(i: number, overrides: Partial<Spot> = {}): Spot {
  // Spread over the Philippines (lat 5..19, lng 117..126) deterministically.
  const lat = 5 + ((i * 7919) % 14000) / 1000;
  const lng = 117 + ((i * 104729) % 9000) / 1000;
  return {
    id: `syn-${i}`,
    slug: `syn-${i}`,
    name: `Synthetic Place ${i}`,
    description: 'Synthetic national-scale fixture.',
    category: i % 3 === 0 ? 'nature_outdoors' : i % 3 === 1 ? 'culture_heritage' : 'activities_wellness',
    subcategory: 'beach',
    tags: ['scenic'],
    municipality: `Town ${i % 200}`,
    address: '',
    gps_lat: lat,
    gps_lng: lng,
    price_level: 0,
    hours: {},
    amenities: [],
    image_url: '',
    source_type: 'open_data',
    source_name: 'OpenStreetMap contributors',
    trust_level: 'open_data',
    status: 'published',
    created_at: base,
    updated_at: base,
    launch_tier: i % 10 === 0 ? 'featured' : 'standard',
    province_area_id: `prov-${i % 80}`,
    ...overrides,
  };
}

function nationalStore(n: number): SpotStore {
  const store = new SpotStore();
  store.spots = Array.from({ length: n }, (_, i) => syntheticSpot(i));
  return store;
}

describe('Plan 116 bounded Explore ranking', () => {
  it('returns one page plus the full match count and keeps paging consistent', () => {
    const store = nationalStore(RANK_CANDIDATE_CAP + 1000);
    const first = rankExploreSpotsPage(store, { userId: 'anon-a', actorId: 'anon-a', limit: 50, offset: 0 });
    expect(first.items).toHaveLength(50);
    expect(first.total).toBe(RANK_CANDIDATE_CAP + 1000);
    const second = rankExploreSpotsPage(store, { userId: 'anon-a', actorId: 'anon-a', limit: 50, offset: 50 });
    expect(second.items).toHaveLength(50);
    const ids = new Set([...first.items, ...second.items].map((s) => s.id));
    expect(ids.size).toBe(100);
  });

  it('never returns more than the cached head when no limit is given', () => {
    const store = nationalStore(1500);
    const page = rankExploreSpotsPage(store, { userId: 'anon-b', actorId: 'anon-b' });
    expect(page.items.length).toBe(CACHED_HEAD);
    expect(page.total).toBe(1500);
  });

  it('applies bbox, area and tier filters before ranking', () => {
    const store = nationalStore(3000);
    const bbox: [number, number, number, number] = [120, 14, 121.5, 16];
    const inBox = rankExploreSpotsPage(store, { userId: 'anon-c', actorId: 'anon-c', bbox, limit: 100 });
    expect(inBox.total).toBeGreaterThan(0);
    for (const s of inBox.items) {
      expect(s.gps_lat).toBeGreaterThanOrEqual(14);
      expect(s.gps_lng).toBeLessThanOrEqual(121.5);
    }
    const area = rankExploreSpotsPage(store, { userId: 'anon-c', actorId: 'anon-c', areaId: 'prov-7', limit: 100 });
    expect(area.items.every((s) => s.province_area_id === 'prov-7')).toBe(true);
    const featured = rankExploreSpotsPage(store, { userId: 'anon-c', actorId: 'anon-c', tier: 'featured', limit: 100 });
    expect(featured.total).toBe(300);
    expect(featured.items.every((s) => s.launch_tier === 'featured')).toBe(true);
  });

  it('ranks the nearest candidates when a location is given on a huge catalogue', () => {
    const store = nationalStore(RANK_CANDIDATE_CAP * 3);
    const page = rankExploreSpotsPage(store, {
      userId: 'anon-d',
      actorId: 'anon-d',
      lat: 16.0,
      lng: 120.3,
      sort: 'nearest',
      limit: 5,
    });
    expect(page.items).toHaveLength(5);
    expect(page.items[0].distance_km).toBeLessThan(50);
  });

  it('ranks 15,000 spots fast enough for a request', () => {
    const store = nationalStore(15000);
    const started = Date.now();
    rankExploreSpotsPage(store, { userId: 'anon-e', actorId: 'anon-e', limit: 50 });
    expect(Date.now() - started).toBeLessThan(1500); // generous for CI; measured separately on rehearsal
  });
});

describe('Plan 116 map view', () => {
  const spots = Array.from({ length: 5000 }, (_, i) => syntheticSpot(i));
  const ph: [number, number, number, number] = [116, 4, 127, 21];

  it('clusters at low zoom and returns markers at street zoom', () => {
    const low = mapView(spots, { bbox: ph, zoom: 6 });
    expect(low.total).toBe(5000);
    expect(low.clusters.length).toBeGreaterThan(0);
    expect(low.clusters.reduce((n, c) => n + c.count, 0) + low.markers.length).toBe(5000);
    const high = mapView(spots, { bbox: [120.2, 16.0, 120.4, 16.2], zoom: 14 });
    expect(high.clusters).toHaveLength(0);
    expect(high.markers.length).toBeLessThanOrEqual(MAP_MARKER_LIMIT);
  });

  it('excludes unpublished and test spots', () => {
    const view = mapView(
      [syntheticSpot(1, { status: 'needs_review' }), syntheticSpot(2, { is_test: true }), syntheticSpot(3)],
      { bbox: ph, zoom: 14 },
    );
    expect(view.markers.map((m) => m.id)).toEqual(['syn-3']);
  });
});

describe('Plan 116 typeahead (in-memory path)', () => {
  it('matches without accents and ranks prefixes first', () => {
    const spots = [
      syntheticSpot(1, { name: 'Las Piñas Bamboo Organ', municipality: 'Las Piñas' }),
      syntheticSpot(2, { name: 'Old Las Pinas Bridge' }),
      syntheticSpot(3, { name: 'Hundred Islands' }),
    ];
    const hits = searchSpotsInMemory(spots, 'las pinas', 10);
    expect(hits.map((h) => h.id)).toEqual(['syn-1', 'syn-2']);
  });
});

describe('Plan 116 GET /spots contract', () => {
  it('caps unpaged responses and exposes total + an opaque cursor', async () => {
    const res = await request(app).get('/api/v1/spots');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeLessThanOrEqual(50);
    expect(typeof res.body.meta.total).toBe('number');
    expect(res.body.meta.count).toBe(res.body.data.length);
    const small = await request(app).get('/api/v1/spots?limit=2');
    expect(small.body.data.length).toBeLessThanOrEqual(2);
    if (small.body.meta.total > 2) {
      expect(typeof small.body.meta.next_cursor).toBe('string');
      const next = await request(app).get(`/api/v1/spots?limit=2&cursor=${small.body.meta.next_cursor}`);
      expect(next.status).toBe(200);
      const overlap = next.body.data.filter((s: Spot) => small.body.data.some((x: Spot) => x.id === s.id));
      expect(overlap).toHaveLength(0);
    }
  });

  it('rejects malformed bbox, tier and cursor values', async () => {
    expect((await request(app).get('/api/v1/spots?bbox=1,2,3')).status).toBe(400);
    expect((await request(app).get('/api/v1/spots?bbox=121,15,120,16')).status).toBe(400);
    expect((await request(app).get('/api/v1/spots?tier=gold')).status).toBe(400);
    expect((await request(app).get('/api/v1/spots?cursor=not-a-cursor')).status).toBe(400);
  });

  it('serves the map and search endpoints', async () => {
    const map = await request(app).get('/api/v1/spots/map?bbox=119,15,121,17&zoom=9');
    expect(map.status).toBe(200);
    expect(Array.isArray(map.body.data.markers)).toBe(true);
    expect(Array.isArray(map.body.data.clusters)).toBe(true);
    expect((await request(app).get('/api/v1/spots/map?zoom=9')).status).toBe(400);
    const search = await request(app).get('/api/v1/spots/search?q=ba');
    expect(search.status).toBe(200);
    expect(Array.isArray(search.body.data)).toBe(true);
    expect((await request(app).get('/api/v1/spots/search?q=a')).status).toBe(400);
  });

  it('never leaks generated database columns into spot payloads', async () => {
    const res = await request(app).get('/api/v1/spots?limit=5');
    for (const s of res.body.data) {
      expect(s).not.toHaveProperty('geog');
      expect(s).not.toHaveProperty('search_tsv');
    }
  });
});
