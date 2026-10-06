import { env } from '../src/config/env.js';
import { setPool } from '../src/db/pool.js';
import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { createMonthlySchedule, reconcileMonthlySchedulesAt } from '../src/juanchoice/monthly-service.js';
import { getMonthlyOverview } from '../src/juanchoice/monthly-overview.js';

describe('JuanChoice monthly scheduler with isolated database',()=>{
  let fixture:TestDbInstance;
  beforeAll(async()=>{
    fixture=await createTestDb();setPool(fixture.pool);
    (env as any).JUANCHOICE_ENABLED=true;
    (env as any).JUANCHOICE_SCHEDULER_ENABLED=true;
    (env as any).JUANCHOICE_WRITES_ENABLED=false;
    for(const [id,municipality] of [['monthly-a','Bolinao'],['monthly-b','Alaminos'],
      ['monthly-c','Anda'],['monthly-d','Lingayen']]){
      await fixture.pool.query(`INSERT INTO spots(id,slug,name,description,category,subcategory,municipality,address,
        gps_lat,gps_lng,source_type,source_name,is_test) VALUES($1,$2,$3,'Test','nature_outdoors','coast',$4,$5,16,120,'lgu','Test',false)`,[id,id,id,municipality,municipality]);
    }
  },30000);
  afterAll(async()=>{
    setPool(null);if(fixture)await fixture.close();
    (env as any).JUANCHOICE_ENABLED=false;
    (env as any).JUANCHOICE_SCHEDULER_ENABLED=false;
    (env as any).JUANCHOICE_WRITES_ENABLED=false;
  });

  it('prepares the next full month once while ballot writes remain disabled',async()=>{
    const schedule=await createMonthlySchedule({schedule_key:'pangasinan-monthly',region_key:'pangasinan',
      display_region:'Pangasinan',timezone:'Asia/Manila',enabled:true,effective_period:'2026-09-01',
      preparation_lead_days:7,minimum_candidates:2,target_candidates:4,maximum_candidates:6,
      themes:[{name:'Nature and coast',categories:['nature_outdoors']}],policy_version:'juanchoice-monthly-v1',is_test:false});
    const first=await reconcileMonthlySchedulesAt(new Date('2026-09-28T04:00:00Z'));
    expect(first.prepared).toBe(1);
    expect(first.missed).toBe(1);
    const again=await reconcileMonthlySchedulesAt(new Date('2026-09-28T04:00:00Z'));
    expect(again.failed).toBe(0);
    expect(again.prepared).toBe(0);
    const campaigns=await fixture.pool.query("SELECT id,opens_at,closes_at,status FROM juanchoice_campaigns WHERE is_test=FALSE");
    expect(campaigns.rowCount).toBe(1);
    expect(campaigns.rows[0].status).toBe('scheduled');
    expect(new Date(campaigns.rows[0].opens_at).toISOString()).toBe('2026-09-30T16:00:00.000Z');
    expect((await fixture.pool.query('SELECT id FROM juanchoice_candidates WHERE campaign_id=$1',[campaigns.rows[0].id])).rowCount).toBe(4);
    expect((await fixture.pool.query('SELECT id FROM juanchoice_schedule_audit WHERE schedule_id=$1',[schedule.id])).rowCount).toBe(3);
    const preparedPeriod=(await fixture.pool.query(
      "SELECT status,selected_theme FROM juanchoice_schedule_periods WHERE schedule_id=$1 AND period_start='2026-10-01'",
      [schedule.id])).rows[0];
    expect(preparedPeriod).toMatchObject({status:'prepared',selected_theme:'Nature and coast'});
    const overview=await getMonthlyOverview('pangasinan');
    // Overview uses the real DB clock; a 2026-10 round is not "next" after it opens.
    expect(overview.availability.voting_enabled).toBe(false);
    await fixture.pool.query(`INSERT INTO spots(id,slug,name,description,category,subcategory,municipality,address,
      gps_lat,gps_lng,source_type,source_name,is_test) VALUES
      ('monthly-replacement','monthly-replacement','Replacement','Test','nature_outdoors','coast',
       'Sual','Sual',16,120,'lgu','Test',false)`);
    await fixture.pool.query("UPDATE spots SET status='unpublished' WHERE id='monthly-a'");
    const replaced=await reconcileMonthlySchedulesAt(new Date('2026-09-28T04:00:00Z'));
    expect(replaced.failed).toBe(0);
    expect((await fixture.pool.query(`SELECT id FROM juanchoice_candidates
      WHERE campaign_id=$1 AND spot_id='monthly-replacement' AND status='eligible'`,[campaigns.rows[0].id])).rowCount).toBe(1);
    expect((await fixture.pool.query(`SELECT status FROM juanchoice_candidates
      WHERE campaign_id=$1 AND spot_id='monthly-a'`,[campaigns.rows[0].id])).rows[0].status).toBe('suspended');
    await fixture.pool.query("UPDATE spots SET status='unpublished' WHERE id LIKE 'monthly-%'");
    const withdrawn=await reconcileMonthlySchedulesAt(new Date('2026-09-28T04:00:00Z'));
    expect(withdrawn.failed).toBe(0);
    expect((await fixture.pool.query('SELECT status FROM juanchoice_campaigns WHERE id=$1',[campaigns.rows[0].id])).rows[0].status).toBe('cancelled');
    expect((await fixture.pool.query('SELECT status FROM juanchoice_schedule_periods WHERE campaign_id=$1',[campaigns.rows[0].id])).rows[0].status).toBe('cancelled');
  },30000);
});
