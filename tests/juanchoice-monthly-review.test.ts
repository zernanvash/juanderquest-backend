import { env } from '../src/config/env.js';
import { setPool } from '../src/db/pool.js';
import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { createMonthlySchedule, reconcileMonthlySchedulesAt } from '../src/juanchoice/monthly-service.js';

describe('monthly scheduler review regressions', () => {
  let fixture: TestDbInstance;
  const now = new Date('2027-01-28T04:00:00Z');
  const originalFlags = {
    JUANCHOICE_ENABLED: env.JUANCHOICE_ENABLED,
    JUANCHOICE_SCHEDULER_ENABLED: env.JUANCHOICE_SCHEDULER_ENABLED,
    JUANCHOICE_WRITES_ENABLED: env.JUANCHOICE_WRITES_ENABLED,
  };
  beforeEach(async () => {
    fixture = await createTestDb();
    setPool(fixture.pool);
    Object.assign(env, { JUANCHOICE_ENABLED: true, JUANCHOICE_SCHEDULER_ENABLED: true, JUANCHOICE_WRITES_ENABLED: false });
    for (const isTest of [false, true]) {
      for (let index = 0; index < 4; index++) {
        const id = `${isTest ? 'test' : 'real'}-review-${index}`;
        await fixture.pool.query(`INSERT INTO spots(id,slug,name,description,category,subcategory,municipality,address,
          gps_lat,gps_lng,source_type,source_name,is_test)
          VALUES($1,$2,$3,'Review fixture','nature_outdoors','coast',$4,$5,16,120,'lgu','Fixture',$6)`,
        [id, id, id, ['Bolinao','Anda','Sual','Lingayen'][index], ['Bolinao','Anda','Sual','Lingayen'][index], isTest]);
      }
    }
  }, 30000);
  afterEach(async () => {
    setPool(null);
    if (fixture) await fixture.close();
    Object.assign(env, originalFlags);
  });

  const create = (isTest: boolean) => createMonthlySchedule({
    schedule_key: 'review-monthly', region_key: 'pangasinan', display_region: 'Pangasinan',
    timezone: 'Asia/Manila', enabled: true, effective_period: '2027-02-01', preparation_lead_days: 7,
    minimum_candidates: 2, target_candidates: 4, maximum_candidates: 6,
    themes: [{ name: 'Coastal nature', categories: ['nature_outdoors'] }],
    policy_version: 'juanchoice-monthly-v1', is_test: isTest,
  });

  it('prepares real and synthetic schedules with the same key and month independently', async () => {
    await create(false); await create(true);
    const outcome = await reconcileMonthlySchedulesAt(now);
    expect(outcome.failed).toBe(0);
    expect(outcome.prepared).toBe(2);
    const campaigns = (await fixture.pool.query('SELECT slug,is_test FROM juanchoice_campaigns')).rows;
    expect(new Set(campaigns.map(row => row.slug)).size).toBe(2);
    expect(campaigns.map(row => row.is_test).sort()).toEqual([false, true]);
  });

  it('withdraws a candidate whose destination scope changes before opening', async () => {
    await create(false);
    expect((await reconcileMonthlySchedulesAt(now)).prepared).toBe(1);
    await fixture.pool.query("UPDATE spots SET is_test=TRUE WHERE id='real-review-0'");
    expect((await reconcileMonthlySchedulesAt(now)).failed).toBe(0);
    const row = (await fixture.pool.query("SELECT status FROM juanchoice_candidates WHERE spot_id='real-review-0'")).rows[0];
    expect(row.status).toBe('suspended');
  });

  it('does not re-edit candidates or audit an already cancelled campaign', async () => {
    await create(false);
    expect((await reconcileMonthlySchedulesAt(now)).prepared).toBe(1);
    await fixture.pool.query("UPDATE juanchoice_campaigns SET status='cancelled'");
    await fixture.pool.query("UPDATE spots SET status='unpublished' WHERE is_test=FALSE");
    const before = (await fixture.pool.query('SELECT id FROM juanchoice_schedule_audit')).rowCount;
    expect((await reconcileMonthlySchedulesAt(now)).failed).toBe(0);
    expect((await fixture.pool.query("SELECT id FROM juanchoice_candidates WHERE status='suspended'")).rowCount).toBe(0);
    expect((await fixture.pool.query('SELECT id FROM juanchoice_schedule_audit')).rowCount).toBe(before);
  });
});
