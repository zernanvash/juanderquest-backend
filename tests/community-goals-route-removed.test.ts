import request from 'supertest';
import { app } from '../src/app.js';

// Owner 2026-11-16 (endpoints without a screen): the public list duplicated the engagement
// summary's community_goals and had no client. The admin evaluation tool stays.
describe('GET /community-goals is removed', () => {
  it('answers 404', async () => {
    const res = await request(app).get('/api/v1/community-goals');
    expect(res.status).toBe(404);
  });

  it('keeps the admin evaluate-community-goals tool routed (auth required, not 404)', async () => {
    const res = await request(app).post('/api/v1/admin/progression/evaluate-community-goals');
    expect(res.status).toBe(401);
  });
});
