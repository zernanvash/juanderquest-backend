import { spawn } from 'child_process';
import path from 'path';
import { env } from '../src/config/env.js';
import { setPool } from '../src/db/pool.js';
import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { createMonthlySchedule } from '../src/juanchoice/monthly-service.js';

const realIt = process.env.JDQ_REAL_PG_URL ? it : it.skip;

describe('JuanChoice monthly preparation across OS processes', () => {
  let fixture: TestDbInstance;
  const originalFlags = {
    JUANCHOICE_ENABLED: env.JUANCHOICE_ENABLED,
    JUANCHOICE_SCHEDULER_ENABLED: env.JUANCHOICE_SCHEDULER_ENABLED,
    JUANCHOICE_WRITES_ENABLED: env.JUANCHOICE_WRITES_ENABLED,
  };

  beforeAll(async () => {
    if (!process.env.JDQ_REAL_PG_URL) return;
    fixture = await createTestDb();
    setPool(fixture.pool);
    Object.assign(env, { JUANCHOICE_ENABLED: true, JUANCHOICE_SCHEDULER_ENABLED: true, JUANCHOICE_WRITES_ENABLED: false });
    for (const [id, municipality] of [
      ['monthly-race-a', 'Bolinao'], ['monthly-race-b', 'Anda'],
      ['monthly-race-c', 'Sual'], ['monthly-race-d', 'Lingayen'],
    ]) {
      await fixture.pool.query(`INSERT INTO spots(id,slug,name,description,category,subcategory,municipality,address,
        gps_lat,gps_lng,source_type,source_name,is_test)
        VALUES($1,$2,$3,'Concurrency fixture','nature_outdoors','coast',$4,$5,16,120,'lgu','Fixture',FALSE)`,
      [id, id, id, municipality, municipality]);
    }
    await createMonthlySchedule({
      schedule_key: 'multiprocess-monthly', region_key: 'pangasinan', display_region: 'Pangasinan',
      timezone: 'Asia/Manila', enabled: true, effective_period: '2027-02-01', preparation_lead_days: 7,
      minimum_candidates: 2, target_candidates: 4, maximum_candidates: 6,
      themes: [{ name: 'Coastal nature', categories: ['nature_outdoors'] }],
      policy_version: 'juanchoice-monthly-v1', is_test: false,
    });
  }, 30000);

  afterAll(async () => {
    setPool(null);
    if (fixture) await fixture.close();
    Object.assign(env, originalFlags);
  });

  realIt('prepares one campaign, roster and audit event despite two simultaneous workers', async () => {
    const runWorker = () => new Promise<{ prepared: number; failed: number }>((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(__dirname, 'juanchoice-monthly-worker.cjs')], {
        env: {
          ...process.env,
          JDQ_POOL_OPTIONS: (fixture.pool as any).options.options,
          JDQ_MONTHLY_NOW: '2027-01-28T04:00:00Z',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += String(chunk); });
      child.stderr.on('data', chunk => { stderr += String(chunk); });
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
    });

    const results = await Promise.all([runWorker(), runWorker()]);
    expect(results.every(result => result.failed === 0)).toBe(true);
    expect(results.reduce((sum, result) => sum + result.prepared, 0)).toBe(1);
    const periods = await fixture.pool.query("SELECT id,campaign_id,status FROM juanchoice_schedule_periods WHERE period_start='2027-02-01'");
    expect(periods.rowCount).toBe(1);
    expect(periods.rows[0].status).toBe('prepared');
    const campaignId = periods.rows[0].campaign_id;
    expect((await fixture.pool.query('SELECT id FROM juanchoice_campaigns WHERE id=$1', [campaignId])).rowCount).toBe(1);
    expect((await fixture.pool.query('SELECT id FROM juanchoice_candidates WHERE campaign_id=$1', [campaignId])).rowCount).toBe(4);
    expect((await fixture.pool.query("SELECT id FROM juanchoice_schedule_audit WHERE period_id=$1 AND action='prepared'", [periods.rows[0].id])).rowCount).toBe(1);
  }, 30000);
});
