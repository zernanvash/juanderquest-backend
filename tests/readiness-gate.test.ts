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

  it('reports not-ready on /health/ready while booting or draining, so monitors never see a false ready', async () => {
    setServiceReady(false);
    const booting = await request(app).get('/api/v1/health/ready');
    expect(booting.status).toBe(503);
    expect(booting.body).toMatchObject({ status: 'starting', ready: false });
    expect(booting.headers['retry-after']).toBe('5');
    const alias = await request(app).get('/api/v1/ready');
    expect(alias.status).toBe(503);

    beginServiceShutdown();
    const draining = await request(app).get('/api/v1/health/ready');
    expect(draining.status).toBe(503);
    expect(draining.body.status).toBe('restarting');

    // Liveness stays 200 throughout so the process is never killed for restarting.
    const live = await request(app).get('/api/v1/health/live');
    expect(live.status).toBe(200);
  });
});
