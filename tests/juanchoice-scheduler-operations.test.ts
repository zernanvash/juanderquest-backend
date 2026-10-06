import { env } from '../src/config/env.js';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { app } from '../src/app.js';
import { db as domainDb } from '../src/db/index.js';
import { setPool } from '../src/db/pool.js';
import { createTestDb } from '../src/db/testHarness.js';
import { getJuanChoiceSchedulerStatus, initJuanChoiceScheduler, stopJuanChoiceScheduler } from '../src/jobs/juanchoice-scheduler.js';
import { createMonthlySchedule } from '../src/juanchoice/monthly-service.js';
import { localMonth, nextMonth } from '../src/juanchoice/monthly-policy.js';

async function eventually<T>(read: () => Promise<T>, ready: (value: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (ready(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  throw new Error('SCHEDULER_REHEARSAL_TIMEOUT');
}

describe('JuanChoice autonomous scheduler operating rehearsal', () => {
  it('recovers after a database outage and remains idempotent across worker restart with writes disabled', async () => {
    const fixture = await createTestDb();
    const original = {
      JUANCHOICE_ENABLED: env.JUANCHOICE_ENABLED,
      JUANCHOICE_SCHEDULER_ENABLED: env.JUANCHOICE_SCHEDULER_ENABLED,
      JUANCHOICE_WRITES_ENABLED: env.JUANCHOICE_WRITES_ENABLED,
      JUANCHOICE_SCHEDULER_INTERVAL_MS: env.JUANCHOICE_SCHEDULER_INTERVAL_MS,
    };
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      setPool(fixture.pool);
      domainDb.usersRepo.setPool(fixture.pool);
      Object.assign(env, {
        JUANCHOICE_ENABLED: true,
        JUANCHOICE_SCHEDULER_ENABLED: true,
        JUANCHOICE_WRITES_ENABLED: false,
        JUANCHOICE_SCHEDULER_INTERVAL_MS: 50,
      });
      const period = localMonth(new Date(), 'Asia/Manila');
      await fixture.pool.query(`INSERT INTO users(id,seed_id,display_name,email,role) VALUES
        ('scheduler-admin','scheduler-admin','Scheduler Admin','scheduler-admin@example.test','admin'),
        ('scheduler-user','scheduler-user','Scheduler User','scheduler-user@example.test','user')`);
      const adminToken = jwt.sign({id:'scheduler-admin',role:'admin'},env.JWT_SECRET);
      const userToken = jwt.sign({id:'scheduler-user',role:'user'},env.JWT_SECRET);
      const endpoint = '/api/v1/juanchoice/admin/scheduler';
      expect((await request(app).get(endpoint)).status).toBe(401);
      expect((await request(app).get(endpoint).set('Authorization',`Bearer ${userToken}`)).status).toBe(403);
      const schedule = await createMonthlySchedule({
        schedule_key: 'scheduler-operations-rehearsal', region_key: 'pangasinan',
        display_region: 'Pangasinan', timezone: 'Asia/Manila', enabled: true,
        effective_period: period, preparation_lead_days: 28,
        minimum_candidates: 2, target_candidates: 4, maximum_candidates: 6,
        themes: [{ name: 'Nature and coast', categories: ['nature_outdoors'] }],
        policy_version: 'juanchoice-monthly-v1', is_test: false,
      });

      // This is the worker's actual timer path, not the deterministic service seam.
      setPool(null);
      initJuanChoiceScheduler();
      await eventually(async () => log.mock.calls.length, count => count > 0);
      expect(getJuanChoiceSchedulerStatus()).toMatchObject({active:true,consecutive_failures:1});
      setPool(fixture.pool);
      const current = await eventually(async () => (await fixture.pool.query(
        'SELECT status FROM juanchoice_schedule_periods WHERE schedule_id=$1 AND period_start=$2',
        [schedule.id, period]
      )).rows[0] as { status: string } | undefined, row => row?.status === 'missed');
      expect(current?.status).toBe('missed');
      await eventually(async () => getJuanChoiceSchedulerStatus(), value => value.consecutive_failures === 0 && Boolean(value.last_success_at));
      const status = await request(app).get(endpoint).set('Authorization',`Bearer ${adminToken}`);
      expect(status.status).toBe(200);
      expect(status.headers['cache-control']).toBe('private, no-store');
      expect(status.headers['x-robots-tag']).toBe('noindex, nofollow');
      expect(status.body.data).toMatchObject({
        configured_enabled:true, active:true, consecutive_failures:0,
        last_summary:expect.objectContaining({schedules:1,failed:0}),
      });
      expect(status.body.data.last_attempt_at).toEqual(expect.any(String));
      expect(status.body.data.instance_id).toEqual(expect.any(String));
      expect(status.body.data.last_success_at).toEqual(expect.any(String));
      expect(status.body.data.last_failure_at).toEqual(expect.any(String));
      await stopJuanChoiceScheduler();

      const before = (await fixture.pool.query(
        'SELECT COUNT(*)::int AS count FROM juanchoice_schedule_audit WHERE schedule_id=$1 AND action=$2',
        [schedule.id, 'missed']
      )).rows[0].count;
      expect(before).toBe(1);
      initJuanChoiceScheduler();
      await eventually(async () => (await fixture.pool.query(
        'SELECT COUNT(*)::int AS count FROM juanchoice_schedule_periods WHERE schedule_id=$1 AND period_start=$2',
        [schedule.id, nextMonth(period)]
      )).rows[0].count as number, count => count === 1);
      await stopJuanChoiceScheduler();

      const audit = (await fixture.pool.query(
        'SELECT COUNT(*)::int AS count FROM juanchoice_schedule_audit WHERE schedule_id=$1 AND action=$2',
        [schedule.id, 'missed']
      )).rows[0].count;
      const ballotCount = (await fixture.pool.query('SELECT COUNT(*)::int AS count FROM juanchoice_ballots')).rows[0].count;
      const rewardCount = (await fixture.pool.query(
        "SELECT COUNT(*)::int AS count FROM progression_events WHERE source_type='juanchoice_participation'"
      )).rows[0].count;
      expect(audit).toBe(1);
      expect(ballotCount).toBe(0);
      expect(rewardCount).toBe(0);
      expect(log.mock.calls.some(call => String(call[1]).includes('DATABASE_OUTAGE'))).toBe(true);
    } finally {
      await stopJuanChoiceScheduler();
      setPool(null);
      domainDb.usersRepo.setPool(null);
      Object.assign(env, original);
      log.mockRestore();
      await fixture.close();
    }
  }, 30_000);
});
