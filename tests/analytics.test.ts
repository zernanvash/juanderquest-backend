import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { app } from '../src/app';
describe('first-party web analytics', () => {
  it('accepts a valid consented client event', async () => { const response = await request(app).post('/api/v1/analytics/events').send({ eventType: 'page_view', path: '/explore', sessionId: randomUUID() }); expect(response.status).toBe(202); });
  it('rejects malformed events', async () => { const response = await request(app).post('/api/v1/analytics/events').send({ eventType: 'cta_click', path: 'external', sessionId: 'bad' }); expect(response.status).toBe(422); });
  it('protects reports with admin authentication', async () => { const response = await request(app).get('/api/v1/admin/analytics?days=30'); expect(response.status).toBe(401); });
});
