import request from 'supertest';
import { app } from '../src/app.js';
import { setCachedAreas, AreaRecord } from '../src/maps/areas-service.js';
import { hoursFromOsm, barangayLabel, pickProfile, setRecognizeFetch, NominatimReverse } from '../src/spots/recognize.js';
import { spotStore } from '../src/spots/store.js';

// Plan 66: GET /api/v1/spots/recognize — every suggestion must be accepted by POST /spots.
const CATEGORIES = ['eat_drink', 'nature_outdoors', 'culture_heritage', 'activities_wellness', 'shopping_local', 'stay'];
const GOOD_FOR = ['families', 'solo', 'couples', 'groups', 'seniors_access'];
const BEST_TIME = ['early_morning', 'daytime', 'sunset', 'night', 'weekdays', 'dry_season', 'rainy_season'];
const AMENITIES = ['parking', 'restrooms', 'food_nearby', 'guide_available', 'cottage_rentals', 'boat_service', 'wifi_signal', 'pwd_accessible'];

const square = (lng: number, lat: number, half: number): [number, number][][] =>
  [[[lng - half, lat - half], [lng + half, lat - half], [lng + half, lat + half], [lng - half, lat + half], [lng - half, lat - half]]];
const area = (id: string, level: AreaRecord['level'], name: string, parent: string | null, lng: number, lat: number, half: number): AreaRecord => ({
  id, psgc_code: 1, level, name, display_name: name, parent_id: parent, osm_relation_id: null, has_boundary: true,
  label_lat: lat, label_lng: lng, bbox: [lng - half, lat - half, lng + half, lat + half], min_zoom: 10, shape_file: null, data_version: 'test',
  geometry: { type: 'Polygon', coordinates: square(lng, lat, half) },
});

const PATAR = { lat: 16.3268, lng: 119.7842 };
let calls = 0;
function upstream(body: NominatimReverse | null) {
  calls = 0;
  setRecognizeFetch(async () => { calls += 1; return body ? { ok: true, json: async () => body } : { ok: false, json: async () => ({}) }; });
}
const recognize = (lat: number, lng: number) => request(app).get('/api/v1/spots/recognize').query({ lat, lng });

function expectPostable(data: any) {
  expect(CATEGORIES).toContain(data.suggested_category);
  for (const value of data.suggested_details.good_for) expect(GOOD_FOR).toContain(value);
  for (const value of data.suggested_details.best_time) expect(BEST_TIME).toContain(value);
  for (const value of data.suggested_details.amenities) expect(AMENITIES).toContain(value);
  expect(data.story_starters).toHaveLength(4);
  for (const line of data.story_starters) expect(line.length).toBeGreaterThanOrEqual(45);
  expect(JSON.stringify(data)).not.toMatch(/16\.32|119\.78/); // never echo raw coordinates
}

describe('GET /api/v1/spots/recognize (Plan 66)', () => {
  beforeAll(() => {
    setCachedAreas([
      area('town-bolinao', 'town', 'Bolinao', 'prov-pangasinan', 119.80, 16.33, 0.08),
      area('bgy-patar', 'barangay', 'Patar', 'town-bolinao', 119.785, 16.327, 0.01),
    ]);
  });
  afterAll(() => { setRecognizeFetch(null); setCachedAreas([]); });

  it('recognizes a named beach with PSGC town/barangay and postable suggestions', async () => {
    upstream({ name: 'Patar White Beach', category: 'natural', type: 'beach', address: { road: 'Patar Road', village: 'Patar', town: 'Bolinao', state: 'Pangasinan' }, extratags: {}, namedetails: { name: 'Patar White Beach' } });
    const res = await recognize(PATAR.lat, PATAR.lng);
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data).toMatchObject({ recognized: true, source: 'osm', place_name: 'Patar White Beach', municipality: 'Bolinao', barangay: 'Brgy. Patar',
      province: 'Pangasinan', road: 'Patar Road', outside_pangasinan: false, suggested_category: 'nature_outdoors', suggested_subcategory: 'beach' });
    expect(data.formatted_address).toBe('Patar Road, Brgy. Patar, Bolinao, Pangasinan');
    expect(data.name_suggestions[0]).toBe('Patar White Beach');
    expect(data.story_starters[0]).toContain('Brgy. Patar, Bolinao');
    expect(data.suggested_details.daily_hours).toBe('06:00 AM - 06:00 PM');
    expectPostable(data);
  });

  it('maps a restaurant with OSM opening hours, wheelchair access and phone', async () => {
    upstream({ name: 'Sungayan Grill', category: 'amenity', type: 'restaurant', address: { road: 'Rizal St', town: 'Bolinao', state: 'Pangasinan' },
      extratags: { opening_hours: 'Mo-Su 09:00-21:00', wheelchair: 'yes', phone: '+63 912 345 6789' } });
    const data = (await recognize(16.3301, 119.8001)).body.data;
    expect(data).toMatchObject({ place_name: 'Sungayan Grill', suggested_category: 'eat_drink', suggested_subcategory: 'restaurant' });
    expect(data.suggested_details.daily_hours).toBe('09:00 AM - 09:00 PM');
    expect(data.suggested_details.amenities).toContain('pwd_accessible');
    expect(data.suggested_details.contact_number).toBe('+63 912 345 6789');
    expectPostable(data);
  });

  it('uses name keywords when tags are generic, and drops names that are just the road', async () => {
    upstream({ name: 'Bolinao Falls 1', category: 'leisure', type: 'unknown_thing', address: { town: 'Bolinao', state: 'Pangasinan' } });
    const falls = (await recognize(16.3402, 119.8102)).body.data;
    expect(falls).toMatchObject({ suggested_category: 'nature_outdoors', suggested_subcategory: 'waterfall' });
    upstream({ name: 'Rizal Street', category: 'highway', type: 'residential', address: { road: 'Rizal Street', town: 'Bolinao', state: 'Pangasinan' } });
    const road = (await recognize(16.3403, 119.8103)).body.data;
    expect(road.place_name).toBeNull();
    expect(road.name_suggestions.length).toBeGreaterThan(0);
    expectPostable(road);
  });

  it('does not name a spot after a non-destination POI (found by the real-data probe)', async () => {
    upstream({ name: 'Mercury Drug', category: 'shop', type: 'chemist', address: { road: 'Milo St', town: 'Bolinao', state: 'Pangasinan' } });
    const data = (await recognize(16.3404, 119.8104)).body.data;
    expect(data.place_name).toBeNull();
    expect(data.name_suggestions).not.toContain('Mercury Drug');
    expect(data.story_starters[1]).toBe('Easy to find near Mercury Drug; ask locals for directions if you get lost.');
    expect(data.story_starters.join(' ')).not.toMatch(/relaxing views/);
    expectPostable(data);
  });

  it('falls back to PSGC areas when Nominatim fails, without hanging', async () => {
    upstream(null);
    const res = await recognize(16.3269, 119.7843);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ recognized: true, source: 'areas', municipality: 'Bolinao', barangay: 'Brgy. Patar', place_name: null });
    expectPostable(res.body.data);
  });

  it('caches by ~22 m grid so panning nearby does not call upstream again', async () => {
    upstream({ name: 'Sunset Point', category: 'tourism', type: 'viewpoint', address: { town: 'Bolinao', state: 'Pangasinan' } });
    await recognize(16.3501, 119.8201);
    await recognize(16.35011, 119.82012);
    expect(calls).toBe(1);
  });

  it('warns about published spots within 80 m and ignores QA spots', async () => {
    upstream(null);
    const base = { description: 'x', category: 'nature_outdoors', subcategory: 'beach', tags: [], municipality: 'Bolinao', address: 'x', price_level: 0, hours: {},
      amenities: [], image_url: '', source_type: 'community', source_name: 'test', trust_level: 'community', created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    const near = { ...base, id: 'dup-near', slug: 'dup-near', name: 'Patar Rock Formation', gps_lat: 16.3602, gps_lng: 119.8301, status: 'published' };
    const qa = { ...near, id: 'dup-qa', slug: 'dup-qa', name: 'QA Spot', is_test: true };
    const far = { ...near, id: 'dup-far', slug: 'dup-far', name: 'Far Spot', gps_lat: 16.3614 };
    spotStore.spots.push(near as any, qa as any, far as any);
    try {
      const data = (await recognize(16.3605, 119.8301)).body.data;
      expect(data.nearby_duplicates).toEqual([{ id: 'dup-near', slug: 'dup-near', name: 'Patar Rock Formation', category: 'nature_outdoors', municipality: 'Bolinao', distance_meters: 33 }]);
    } finally {
      spotStore.spots = spotStore.spots.filter(spot => !spot.id.startsWith('dup-'));
    }
  });

  it('rejects coordinates outside the Philippines and is never read as a spot slug', async () => {
    expect((await recognize(35.68, 139.69)).status).toBe(400);
    const res = await request(app).get('/api/v1/spots/recognize');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('recognize helpers', () => {
  it('formats OSM hours and barangay labels', () => {
    expect(hoursFromOsm('08:00-17:00')).toBe('08:00 AM - 05:00 PM');
    expect(hoursFromOsm('Mo-Fr 07:30-19:00')).toBe('07:30 AM - 07:00 PM');
    expect(hoursFromOsm('24/7')).toBe('Open 24 hours');
    expect(hoursFromOsm('Mo-Fr 08:00-12:00; Sa 09:00-11:00')).toBeNull();
    expect(barangayLabel('Patar')).toBe('Brgy. Patar');
    expect(barangayLabel('Poblacion')).toBe('Poblacion');
    expect(barangayLabel('Barangay Germinal')).toBe('Brgy. Germinal');
  });

  it('maps OSM tags across categories', () => {
    expect(pickProfile({ class: 'amenity', type: 'place_of_worship' }, null).subcategory).toBe('church');
    expect(pickProfile({ class: 'tourism', type: 'hotel' }, null)).toMatchObject({ category: 'stay', subcategory: 'hotel' });
    expect(pickProfile({ class: 'amenity', type: 'marketplace' }, null)).toMatchObject({ category: 'shopping_local', subcategory: 'market' });
    expect(pickProfile({ class: 'historic', type: 'monument' }, null).subcategory).toBe('heritage_site');
    expect(pickProfile({ class: 'leisure', type: 'water_park' }, null).category).toBe('activities_wellness');
    expect(pickProfile(null, 'Kape ni Juan Coffee').subcategory).toBe('cafe');
  });
});
