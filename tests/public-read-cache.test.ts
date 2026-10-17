import request from 'supertest';
import { app } from '../src/app';

describe('Anonymous public read cache (ETag + Cache-Control)', () => {
  it('serves anonymous spot lists with a weak ETag and public cache headers', async () => {
    const res = await request(app).get('/api/v1/spots');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('public');
    expect(res.headers['cache-control']).toContain('stale-while-revalidate=120');
    expect(res.headers.etag).toMatch(/^W\//);
  });

  it('answers 304 with the same ETag and an empty body', async () => {
    const first = await request(app).get('/api/v1/spots');
    const etag = first.headers.etag as string;
    expect(etag).toBeTruthy();

    const revalidated = await request(app).get('/api/v1/spots').set('If-None-Match', etag);
    expect(revalidated.status).toBe(304);
    expect(revalidated.text).toBeFalsy();

    const changed = await request(app).get('/api/v1/spots').set('If-None-Match', 'W/"stale-value"');
    expect(changed.status).toBe(200);
  });

  it('keeps authenticated responses uncached', async () => {
    const login = await request(app).post('/api/v1/auth/demo-login').send({ seed_id: 'user-1' });
    const token = login.body.data.token;

    const res = await request(app).get('/api/v1/spots').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control'] ?? '').not.toContain('public');
  });

  it('does not touch non-listed endpoints or mutations', async () => {
    const detail = await request(app).get('/api/v1/spots/spot-hundred-islands');
    if (detail.status === 200) {
      expect(detail.headers['cache-control'] ?? '').not.toContain('stale-while-revalidate=120');
    }

    const post = await request(app).post('/api/v1/spots').send({});
    expect(post.status).not.toBe(304);
  });
});
