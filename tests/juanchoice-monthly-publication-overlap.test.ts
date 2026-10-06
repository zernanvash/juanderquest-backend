import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import path from 'path';
import { env } from '../src/config/env.js';
import { setPool } from '../src/db/pool.js';
import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { createMonthlySchedule } from '../src/juanchoice/monthly-service.js';

const realIt = process.env.JDQ_REAL_PG_URL ? it : it.skip;

realIt('serializes admin publication and monthly preparation across OS processes', async () => {
  const fixture: TestDbInstance = await createTestDb();
  const originalFlags = {
    JUANCHOICE_ENABLED: env.JUANCHOICE_ENABLED,
    JUANCHOICE_SCHEDULER_ENABLED: env.JUANCHOICE_SCHEDULER_ENABLED,
    JUANCHOICE_WRITES_ENABLED: env.JUANCHOICE_WRITES_ENABLED,
  };
  setPool(fixture.pool);
  Object.assign(env, { JUANCHOICE_ENABLED: true, JUANCHOICE_SCHEDULER_ENABLED: true, JUANCHOICE_WRITES_ENABLED: false });
  try {
    for (const [id, municipality] of [
      ['monthly-overlap-a', 'Bolinao'], ['monthly-overlap-b', 'Anda'],
      ['monthly-overlap-c', 'Sual'], ['monthly-overlap-d', 'Lingayen'],
    ]) {
      await fixture.pool.query(`INSERT INTO spots(id,slug,name,description,category,subcategory,municipality,address,
        gps_lat,gps_lng,source_type,source_name,is_test)
        VALUES($1,$2,$3,'Overlap fixture','nature_outdoors','coast',$4,$5,16,120,'lgu','Fixture',FALSE)`,
      [id, id, id, municipality, municipality]);
    }
    await createMonthlySchedule({
      schedule_key: 'publication-overlap-monthly', region_key: 'pangasinan', display_region: 'Pangasinan',
      timezone: 'Asia/Manila', enabled: true, effective_period: '2027-02-01', preparation_lead_days: 7,
      minimum_candidates: 2, target_candidates: 4, maximum_candidates: 6,
      themes: [{ name: 'Coastal nature', categories: ['nature_outdoors'] }],
      policy_version: 'juanchoice-monthly-v1', is_test: false,
    });
    const campaignId = randomUUID();
    const actorId = 'monthly-overlap-admin';
    await fixture.pool.query("INSERT INTO users(id,seed_id,display_name,email) VALUES($1,$2,'Overlap Admin','monthly-overlap-admin@example.test')", [actorId, actorId]);
    await fixture.pool.query(`INSERT INTO juanchoice_campaigns(id,slug,region,theme,status,opens_at,closes_at,is_test)
      VALUES($1,'manual-overlap-round','Pangasinan','Nature','draft',
      '2027-01-31T16:00:00Z','2027-02-07T16:00:00Z',FALSE)`, [campaignId]);
    await fixture.pool.query('INSERT INTO juanchoice_candidates(id,campaign_id,spot_id,is_test) VALUES($1,$2,$3,FALSE)',
      [randomUUID(), campaignId, 'monthly-overlap-a']);

    const runWorker = (filename: string, extraEnv: Record<string, string> = {}) => new Promise<any>((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(__dirname, filename)], {
        env: {
          ...process.env,
          JDQ_POOL_OPTIONS: (fixture.pool as any).options.options,
          JDQ_MONTHLY_NOW: '2027-01-28T04:00:00Z',
          ...extraEnv,
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
    const [scheduler, publication] = await Promise.all([
      runWorker('juanchoice-monthly-worker.cjs'),
      runWorker('juanchoice-publication-worker.cjs', { JDQ_CAMPAIGN_ID: campaignId, JDQ_ACTOR_ID: actorId }),
    ]);
    expect(scheduler.failed).toBe(0);
    expect(publication.ok || publication.code === 'REGIONAL_ROUND_OVERLAP').toBe(true);
    const active = await fixture.pool.query("SELECT id FROM juanchoice_campaigns WHERE status IN ('scheduled','voting') AND region='Pangasinan' AND is_test=FALSE");
    expect(active.rowCount).toBe(1);
    expect((await fixture.pool.query(`SELECT COUNT(*)::int AS count FROM juanchoice_campaigns
      WHERE region='Pangasinan' AND is_test=FALSE AND status IN ('scheduled','voting')
      AND opens_at < '2027-02-07T16:00:00Z' AND closes_at > '2027-01-31T16:00:00Z'`)).rows[0].count).toBe(1);
  } finally {
    setPool(null);
    Object.assign(env, originalFlags);
    await fixture.close();
  }
}, 60000);
