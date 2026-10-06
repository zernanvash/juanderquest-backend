import request from 'supertest';
import { app } from '../src/app';
import { env } from '../src/config/env.js';

describe('Public alpha marketplace safety', () => {
  const originalAvailability = env.MARKETPLACE_ENABLED;

  afterEach(() => {
    Reflect.set(env, 'MARKETPLACE_ENABLED', originalAvailability);
  });

  it('does not advertise prototype merchant offers when the marketplace is disabled', async () => {
    Reflect.set(env, 'MARKETPLACE_ENABLED', false);

    const response = await request(app).get('/api/v1/vouchers');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      data: [],
      meta: { availability: 'under_development' },
    });
  });

  it('blocks voucher redemption before authentication or any mutation', async () => {
    Reflect.set(env, 'MARKETPLACE_ENABLED', false);

    const response = await request(app)
      .post('/api/v1/vouchers/v1/redeem')
      .send({ idempotency_key: 'alpha-marketplace-closed' });

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('FEATURE_UNAVAILABLE');
  });
});

describe('Fast-alpha launcher JuanChoice flag closure', () => {
  it('explicitly sets all JuanChoice write and scheduler flags to false in start-home-alpha.sh', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const scriptPath = path.resolve(__dirname, '../scripts/start-home-alpha.sh');
    const content = fs.readFileSync(scriptPath, 'utf8');

    const expectedFlags = [
      'export JUANCHOICE_WRITES_ENABLED=false',
      'export JUANCHOICE_BATCH_WRITES_ENABLED=false',
      'export JUANCHOICE_PROMOTION_ENABLED=false',
      'export JUANCHOICE_ECONOMY_ENABLED=false',
      'export JUANCHOICE_FINALIZER_WORKER_ENABLED=false',
      'export JUANCHOICE_SCHEDULER_ENABLED=false',
    ];

    for (const flag of expectedFlags) {
      expect(content).toContain(flag);
    }
  });

  it('binds loopback 127.0.0.1 and does not export wildcard 0.0.0.0 in start-home-alpha.sh', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const scriptPath = path.resolve(__dirname, '../scripts/start-home-alpha.sh');
    const content = fs.readFileSync(scriptPath, 'utf8');

    expect(content).toContain('export HOST=127.0.0.1');
    expect(content).not.toContain('export HOST=0.0.0.0');
  });

  it('rejects schedule mutation at the global JuanChoice write guard with 503 WRITES_DISABLED before auth or handler work', async () => {
    const jwt = (await import('jsonwebtoken')).default;
    const originalJuanChoice = env.JUANCHOICE_ENABLED;
    const originalWrites = env.JUANCHOICE_WRITES_ENABLED;
    const originalScheduler = env.JUANCHOICE_SCHEDULER_ENABLED;

    try {
      Reflect.set(env, 'JUANCHOICE_ENABLED', true);
      Reflect.set(env, 'JUANCHOICE_WRITES_ENABLED', false);
      Reflect.set(env, 'JUANCHOICE_SCHEDULER_ENABLED', false);

      const adminToken = jwt.sign({ id: 'alpha-admin-test', role: 'admin' }, env.JWT_SECRET);

      const response = await request(app)
        .post('/api/v1/juanchoice/admin/schedules')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          schedule_key: 'pangasinan-test-schedule',
          region_key: 'pangasinan',
          display_region: 'Pangasinan',
          timezone: 'Asia/Manila',
          enabled: true,
          effective_period: '2026-11-01',
          themes: [{ name: 'Nature', categories: ['nature_outdoors'] }],
        });

      expect(response.status).toBe(503);
      expect(response.body).toEqual({
        success: false,
        error: { code: 'WRITES_DISABLED' },
      });
    } finally {
      Reflect.set(env, 'JUANCHOICE_ENABLED', originalJuanChoice);
      Reflect.set(env, 'JUANCHOICE_WRITES_ENABLED', originalWrites);
      Reflect.set(env, 'JUANCHOICE_SCHEDULER_ENABLED', originalScheduler);
    }
  });
});
