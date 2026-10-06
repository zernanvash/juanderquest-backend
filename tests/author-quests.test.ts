import request from 'supertest';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { spotStore } from '../src/spots/store.js';
import jwt from 'jsonwebtoken';
import { env } from '../src/config/env.js';

describe('Destination-Author Quests System', () => {
  const authorUserId = '11111111-1111-1111-1111-111111111111'; // Juan Dela Cruz
  const otherUserId = '22222222-2222-2222-2222-222222222222'; // Maria Santos

  const authorToken = jwt.sign(
    { id: authorUserId, seed_id: 'demo-user-1', role: 'user' },
    env.JWT_SECRET
  );

  const otherUserToken = jwt.sign(
    { id: otherUserId, seed_id: 'demo-admin-1', role: 'user' },
    env.JWT_SECRET
  );

  const testSpotId = `spot-author-test-${Date.now()}`;
  const testSpotSlug = `author-test-spot-${Date.now()}`;

  beforeAll(() => {
    // Register a spot authored by Juan Dela Cruz
    spotStore.spots.push({
      id: testSpotId,
      slug: testSpotSlug,
      name: 'Author Test Destination',
      description: 'A destination created by an active scout for quest testing.',
      category: 'nature_outdoors',
      subcategory: 'beach',
      tags: ['beach', 'scenic'],
      municipality: 'Bolinao',
      address: 'Patar Beach Road, Bolinao',
      gps_lat: 16.3204,
      gps_lng: 119.7847,
      price_level: 1,
      hours: { daily: '06:00-18:00' },
      amenities: ['parking'],
      image_url: 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e',
      source_type: 'community',
      source_name: 'Juan Dela Cruz',
      trust_level: 'community',
      status: 'published',
      created_by: authorUserId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  });

  afterAll(() => {
    spotStore.spots = spotStore.spots.filter((s) => s.id !== testSpotId);
  });

  it('rejects unauthenticated requests to create a quest for a destination', async () => {
    const res = await request(app)
      .post(`/api/v1/spots/${testSpotId}/quests`)
      .send({
        title: 'Unauthenticated Trail Quest',
        description: 'Should fail because request has no auth token.',
        category: 'eco',
      });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('rejects a non-author user with 403 FORBIDDEN_NOT_DESTINATION_AUTHOR', async () => {
    const res = await request(app)
      .post(`/api/v1/spots/${testSpotId}/quests`)
      .set('Authorization', `Bearer ${otherUserToken}`)
      .send({
        title: 'Hijacked Quest by Non-Author',
        description: 'Trying to add a quest to someone else destination without authorization.',
        category: 'eco',
        radius_meters: 200,
        reward_points: 75,
      });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('FORBIDDEN_NOT_DESTINATION_AUTHOR');
  });

  it('allows the original destination scout author to create an official quest', async () => {
    const res = await request(app)
      .post(`/api/v1/spots/${testSpotId}/quests`)
      .set('Authorization', `Bearer ${authorToken}`)
      .send({
        title: 'Sunset Beacon Exploration Trail',
        description: 'Explore the western rocks at low tide and verify your position at the marker.',
        category: 'eco',
        radius_meters: 200,
        reward_points: 75,
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.title).toBe('Sunset Beacon Exploration Trail');
    expect(res.body.data.reward_points).toBe(75);
    expect(res.body.data.location_name).toBe('Author Test Destination');
    expect(res.body.data.marker_code).toMatch(/^JDQ-[A-Z0-9]{8}$/);

    // Verify spot now has quest_id attached
    const updatedSpot = spotStore.spots.find((s) => s.id === testSpotId);
    expect(updatedSpot?.quest_id).toBe(res.body.data.id);
  });

  it('lists active quests for the spot via GET /spots/:id/quests without leaking marker code', async () => {
    const res = await request(app).get(`/api/v1/spots/${testSpotId}/quests`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);

    const created = res.body.data.find(
      (q: any) => q.title === 'Sunset Beacon Exploration Trail'
    );
    expect(created).toBeDefined();
    expect(created.marker_code).toBeUndefined(); // list must not leak markers
    expect(created.reward_points).toBe(75);
  });
});
