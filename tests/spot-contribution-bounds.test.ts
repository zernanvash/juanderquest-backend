import request from 'supertest';
import { app } from '../src/app';

describe('Spot contribution coordinate bounds (Philippine-wide)', () => {
  let token: string;

  beforeAll(async () => {
    const login = await request(app).post('/api/v1/auth/demo-login').send({ seed_id: 'user-1' });
    token = login.body.data.token;
  });

  const basePayload = (overrides: Record<string, unknown> = {}) => ({
    name: 'Bounds Test Destination',
    description: 'A destination created to verify coordinate bounds for community contributions.',
    category: 'nature_outdoors',
    subcategory: 'beach',
    tags: [],
    municipality: 'Test Municipality',
    address: 'Test Address, Philippines',
    gps_lat: 14.5995,
    gps_lng: 120.9842,
    price_level: 0,
    hours: {},
    amenities: [],
    image_url: '',
    ...overrides,
  });

  it('accepts a valid non-Pangasinan Philippine coordinate', async () => {
    const res = await request(app)
      .post('/api/v1/spots')
      .set('Authorization', `Bearer ${token}`)
      .send(basePayload());
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBeDefined();
    expect(res.body.data.gps_lat).toBeCloseTo(14.5995, 4);
    expect(res.body.data.gps_lng).toBeCloseTo(120.9842, 4);
  });

  it('serves the created destination on immediate read-after-write', async () => {
    const created = await request(app)
      .post('/api/v1/spots')
      .set('Authorization', `Bearer ${token}`)
      .send(basePayload({ name: 'Read After Write Destination' }));
    expect(created.status).toBe(201);

    const detail = await request(app).get(`/api/v1/spots/${created.body.data.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.name).toBe('Read After Write Destination');
  });

  it.each([
    ['latitude below Philippine territory', { gps_lat: 3.9, gps_lng: 120.98 }],
    ['latitude above Philippine territory', { gps_lat: 21.6, gps_lng: 120.98 }],
    ['longitude west of Philippine territory', { gps_lat: 14.5, gps_lng: 115.9 }],
    ['longitude east of Philippine territory', { gps_lat: 14.5, gps_lng: 127.1 }],
    ['latitude outside legal range', { gps_lat: 91, gps_lng: 120 }],
    ['longitude outside legal range', { gps_lat: 14, gps_lng: 181 }],
  ])('rejects %s', async (_label, coords) => {
    const res = await request(app)
      .post('/api/v1/spots')
      .set('Authorization', `Bearer ${token}`)
      .send(basePayload(coords));
    expect(res.status).toBe(400);
  });

  it('rejects non-finite coordinates serialized through JSON', async () => {
    for (const value of [NaN, Infinity, -Infinity]) {
      const res = await request(app)
        .post('/api/v1/spots')
        .set('Authorization', `Bearer ${token}`)
        .send(basePayload({ gps_lat: value }));
      expect(res.status).toBe(400);
    }
  });

  it('rejects requests with missing required fields', async () => {
    const res = await request(app)
      .post('/api/v1/spots')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Incomplete' });
    expect(res.status).toBe(400);
  });

  it('documents current duplicate/retry semantics: identical posts create distinct spots', async () => {
    const payload = basePayload({ name: 'Retry Semantics Destination' });
    const first = await request(app).post('/api/v1/spots').set('Authorization', `Bearer ${token}`).send(payload);
    const second = await request(app).post('/api/v1/spots').set('Authorization', `Bearer ${token}`).send(payload);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.data.id).not.toBe(first.body.data.id);
  });
});
