import { randomUUID } from 'crypto';
import request from 'supertest';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { spotStore, Spot } from '../src/spots/store.js';

describe('GET /api/v1/users/:handle/spots (Unit)', () => {
  const userId = `traveler-${randomUUID()}`;
  const handle = `traveler_${Date.now()}`;
  const spotIds: string[] = [];

  beforeAll(() => {
    // Seed user in memory
    db.users.push({
      id: userId,
      seed_id: userId,
      display_name: 'Maria Traveler',
      handle,
      email: `${userId}@example.test`,
      role: 'user',
      is_public: true,
      is_test: false,
      demo_points: 100,
      scout_reputation: 50,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as any);

    // Seed 4 spots created by this user:
    // 1. Published genuine spot 1 (older)
    const spot1: Spot = {
      id: `spot-${randomUUID()}`,
      slug: `maria-waterfall-1`,
      name: 'Maria Hidden Falls',
      description: 'A serene waterfall off the tourist trail.',
      category: 'nature_outdoors',
      subcategory: 'waterfall',
      tags: ['nature', 'waterfall'],
      municipality: 'Bolinao',
      address: 'Bolinao, Pangasinan',
      gps_lat: 16.33,
      gps_lng: 119.88,
      price_level: 1,
      hours: { daily: '08:00-17:00' },
      amenities: ['parking'],
      good_for: ['nature'],
      best_time: ['morning'],
      image_url: 'https://images.unsplash.com/photo-1?auto=format',
      source_type: 'community',
      source_name: userId, // Raw user ID to verify it gets replaced with display name
      trust_level: 'community',
      status: 'published',
      created_by: userId,
      is_test: false,
      created_at: new Date(Date.now() - 3600000 * 3).toISOString(),
      updated_at: new Date().toISOString(),
    };
    spotStore.spots.push(spot1);
    spotIds.push(spot1.id);

    // 2. Published genuine spot 2 (newer)
    const spot2: Spot = {
      id: `spot-${randomUUID()}`,
      slug: `maria-cove-2`,
      name: 'Maria Secret Cove',
      description: 'Quiet rocky cove with crystal clear waters.',
      category: 'nature_outdoors',
      subcategory: 'beach',
      tags: ['beach', 'sunset'],
      municipality: 'Dasol',
      address: 'Dasol, Pangasinan',
      gps_lat: 15.9,
      gps_lng: 119.78,
      price_level: 0,
      hours: { daily: '06:00-18:00' },
      amenities: [],
      good_for: ['sunset'],
      best_time: ['afternoon'],
      image_url: 'https://images.unsplash.com/photo-2?auto=format',
      source_type: 'community',
      source_name: 'Maria Traveler',
      trust_level: 'community',
      status: 'published',
      created_by: userId,
      is_test: false,
      created_at: new Date(Date.now() - 3600000 * 2).toISOString(),
      updated_at: new Date().toISOString(),
    };
    spotStore.spots.push(spot2);
    spotIds.push(spot2.id);

    // 3. Unpublished draft spot (must be hidden)
    const draftSpot: Spot = {
      id: `spot-${randomUUID()}`,
      slug: `maria-draft-3`,
      name: 'Maria Draft Spot',
      description: 'Draft destination waiting for details.',
      category: 'eat_drink',
      subcategory: 'cafe',
      tags: [],
      municipality: 'Lingayen',
      address: 'Lingayen',
      gps_lat: 16.02,
      gps_lng: 120.23,
      price_level: 1,
      hours: {},
      amenities: [],
      image_url: '',
      source_type: 'community',
      source_name: 'Maria Traveler',
      trust_level: 'community',
      status: 'needs_review',
      created_by: userId,
      is_test: false,
      created_at: new Date(Date.now() - 3600000 * 1).toISOString(),
      updated_at: new Date().toISOString(),
    };
    spotStore.spots.push(draftSpot);
    spotIds.push(draftSpot.id);

    // 4. Test spot (must be hidden for non-QA)
    const testSpot: Spot = {
      id: `spot-${randomUUID()}`,
      slug: `maria-test-spot-4`,
      name: 'Maria Simulated Test Spot',
      description: 'A test spot for QA verification.',
      category: 'nature_outdoors',
      subcategory: 'beach',
      tags: ['test'],
      municipality: 'Dasol',
      address: 'Dasol',
      gps_lat: 15.91,
      gps_lng: 119.79,
      price_level: 0,
      hours: {},
      amenities: [],
      image_url: '',
      source_type: 'community',
      source_name: 'Maria Traveler',
      trust_level: 'community',
      status: 'published',
      created_by: userId,
      is_test: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    spotStore.spots.push(testSpot);
    spotIds.push(testSpot.id);
  });

  afterAll(() => {
    spotStore.spots = spotStore.spots.filter((s) => !spotIds.includes(s.id));
    db.users = db.users.filter((u) => u.id !== userId);
  });

  it('returns 404 USER_NOT_FOUND for unknown handle', async () => {
    const res = await request(app).get('/api/v1/users/non_existent_user_99999/spots');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('USER_NOT_FOUND');
  });

  it('returns only published non-test spots created by that user, newest first', async () => {
    const res = await request(app).get(`/api/v1/users/${handle}/spots`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const spots = res.body.data.spots;
    expect(Array.isArray(spots)).toBe(true);
    // Should have 2 published spots (draft and test spots excluded)
    expect(spots.length).toBe(2);

    // Newest first: spot2 (cove) then spot1 (falls)
    expect(spots[0].name).toBe('Maria Secret Cove');
    expect(spots[1].name).toBe('Maria Hidden Falls');

    // Never return createdBy or user ID as name / source_name
    expect(spots[1].source_name).toBe('Maria Traveler');
    expect(spots[0].source_name).toBe('Maria Traveler');
    expect(spots[0].name).not.toContain(userId);
    expect(spots[1].name).not.toContain(userId);

    // Public card shape fields
    expect(spots[0].slug).toBe('maria-cove-2');
    expect(spots[0].municipality).toBe('Dasol');
    expect(spots[0].crowd_status).toBeDefined();
    expect(spots[0].saved).toBe(false);
    expect(spots[0].liked).toBe(false);
  });

  it('supports @ prefix in handle lookup', async () => {
    const res = await request(app).get(`/api/v1/users/@${handle}/spots`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.spots.length).toBe(2);
  });

  it('supports pagination with limit and offset', async () => {
    const resPage1 = await request(app).get(`/api/v1/users/${handle}/spots?limit=1&offset=0`);
    expect(resPage1.status).toBe(200);
    expect(resPage1.body.data.spots.length).toBe(1);
    expect(resPage1.body.data.spots[0].name).toBe('Maria Secret Cove');
    expect(resPage1.body.data.next).toBe('1');

    const resPage2 = await request(app).get(`/api/v1/users/${handle}/spots?limit=1&offset=1`);
    expect(resPage2.status).toBe(200);
    expect(resPage2.body.data.spots.length).toBe(1);
    expect(resPage2.body.data.spots[0].name).toBe('Maria Hidden Falls');
    expect(resPage2.body.data.next).toBeNull();
  });
});
