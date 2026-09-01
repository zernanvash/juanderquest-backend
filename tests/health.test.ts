import express from 'express';
import request from 'supertest';
import { createHealthRouter } from '../src/routes/health.js';
import type { ReadinessProbes } from '../src/services/health.js';

const healthy = async () => undefined;
const unavailable = async () => {
  throw new Error('unavailable');
};

function healthApp(probes: ReadinessProbes) {
  const app = express();
  app.use('/api/v1', createHealthRouter(probes));
  return app;
}

describe('liveness and readiness endpoints', () => {
  it('keeps the legacy health endpoint and liveness endpoint compatible', async () => {
    const probes = { postgres: unavailable, valhalla: unavailable, storage: unavailable };
    const app = healthApp(probes);

    const [legacy, live] = await Promise.all([
      request(app).get('/api/v1/health'),
      request(app).get('/api/v1/health/live'),
    ]);

    expect(legacy.status).toBe(200);
    expect(live.status).toBe(200);
    expect(legacy.body.status).toBe('ok');
    expect(live.body.status).toBe('ok');
  });

  it('fails readiness when the required PostgreSQL dependency is unavailable', async () => {
    const app = healthApp({ postgres: unavailable, valhalla: healthy, storage: healthy });
    const response = await request(app).get('/api/v1/health/ready');

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      status: 'not_ready',
      ready: false,
      degraded: true,
      dependencies: {
        postgres: { status: 'down', required: true },
        valhalla: { status: 'up', required: false },
        storage: { status: 'up', required: false },
      },
    });
  });

  it('stays ready but reports optional Valhalla and storage degradation', async () => {
    const app = healthApp({ postgres: healthy, valhalla: unavailable, storage: unavailable });
    const response = await request(app).get('/api/v1/health/ready');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'degraded',
      ready: true,
      degraded: true,
      dependencies: {
        postgres: { status: 'up', required: true },
        valhalla: { status: 'degraded', required: false },
        storage: { status: 'degraded', required: false },
      },
    });
  });

  it('reports fully ready only when all dependencies are available', async () => {
    const app = healthApp({ postgres: healthy, valhalla: healthy, storage: healthy });
    const response = await request(app).get('/api/v1/health/ready');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ready');
    expect(response.body.ready).toBe(true);
    expect(response.body.degraded).toBe(false);
  });
});
