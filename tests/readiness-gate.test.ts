import request from 'supertest';
import { app } from '../src/app';
import { beginServiceShutdown, setServiceReady } from '../src/middleware/readiness';

describe('Readiness gate (boot-time 503 MAINTENANCE)', () => {
  afterEach(() => {
    setServiceReady(true);
  });

  it('serves health endpoints while hydrating but 503s every other API route', async () => {
    setServiceReady(false);

    const health = await request(app).get('/api/v1/health');
    expect(health.status).toBe(200);

    const live = await request(app).get('/api/v1/health/live');
    expect(live.status).toBe(200);

    const spots = await request(app).get('/api/v1/spots');
    expect(spots.status).toBe(503);
    expect(spots.headers['retry-after']).toBe('5');
    expect(spots.body).toEqual({
      success: false,
      error: { code: 'MAINTENANCE', message: 'JuanDerQuest is starting up' },
    });

    const mutation = await request(app).post('/api/v1/spots').send({});
    expect(mutation.status).toBe(503);
    expect(mutation.body.error.code).toBe('MAINTENANCE');
  });

  it('reports restarting while draining and recovers when ready again', async () => {
    beginServiceShutdown();

    const draining = await request(app).get('/api/v1/spots');
    expect(draining.status).toBe(503);
    expect(draining.body.error.message).toBe('JuanDerQuest is restarting');

    setServiceReady(true);
    const recovered = await request(app).get('/api/v1/spots');
    expect(recovered.status).toBe(200);
  });
});
