import { randomUUID } from 'crypto';
import request from 'supertest';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import { setPool } from '../src/db/pool.js';
import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { createMonthlySchedule } from '../src/juanchoice/monthly-service.js';
import { getMonthlyOverview } from '../src/juanchoice/monthly-overview.js';
import { monthlyWindow } from '../src/juanchoice/monthly-policy.js';

describe('JuanChoice monthly overview',()=>{
  let fixture:TestDbInstance;
  const campaignId=randomUUID();
  const candidateId=randomUUID();
  beforeAll(async()=>{
    fixture=await createTestDb();setPool(fixture.pool);
    (env as any).JUANCHOICE_ENABLED=true;
    (env as any).JUANCHOICE_WRITES_ENABLED=false;
  });
  afterAll(async()=>{
    setPool(null);await fixture.close();
    (env as any).JUANCHOICE_ENABLED=false;
    (env as any).JUANCHOICE_WRITES_ENABLED=false;
  });

  it('returns a truthful first-round notice without writing a schedule',async()=>{
    const response=await request(app).get('/api/v1/juanchoice/overview');
    expect(response.status).toBe(200);
    expect(response.body.data.next).toBeNull();
    expect(response.body.data.previous).toBeNull();
    expect((await fixture.pool.query('SELECT id FROM juanchoice_schedules')).rowCount).toBe(0);
  });

  it('keeps a single previous result snapshot with no active or future date fabricated',async()=>{
    const schedule=await createMonthlySchedule({schedule_key:'pangasinan-monthly',region_key:'pangasinan',
      display_region:'Pangasinan',timezone:'Asia/Manila',enabled:false,effective_period:'2025-01-01',
      preparation_lead_days:7,minimum_candidates:2,target_candidates:4,maximum_candidates:6,
      themes:[{name:'Nature and coast',categories:['nature_outdoors']}],policy_version:'juanchoice-monthly-v1',is_test:false});
    const window=monthlyWindow('2025-01-01','Asia/Manila');
    await fixture.pool.query(`INSERT INTO spots(id,slug,name,description,category,subcategory,municipality,address,
      gps_lat,gps_lng,source_type,source_name,is_test) VALUES
      ('monthly-spot','monthly-spot','Month winner','Test','nature_outdoors','coast','Bolinao','Bolinao',16,120,'lgu','Test',false)`);
    await fixture.pool.query(`INSERT INTO juanchoice_campaigns(id,slug,region,theme,status,opens_at,closes_at,is_test)
      VALUES($1,'monthly-jan-2025','Pangasinan','Nature and coast','finalized',$2,$3,false)`,
      [campaignId,window.opensAt,window.closesAt]);
    await fixture.pool.query(`INSERT INTO juanchoice_candidates(id,campaign_id,spot_id,is_test) VALUES($1,$2,'monthly-spot',false)`,
      [candidateId,campaignId]);
    await fixture.pool.query(`INSERT INTO juanchoice_schedule_periods(id,schedule_id,period_start,opens_at,closes_at,campaign_id,status)
      VALUES($1,$2,'2025-01-01',$3,$4,$5,'prepared')`,[randomUUID(),schedule.id,window.opensAt,window.closesAt,campaignId]);
    await fixture.pool.query(`INSERT INTO juanchoice_results(campaign_id,standings,co_winner_ids,valid_ballots,policy_version)
      VALUES($1,$2::jsonb,$3::jsonb,2,'juanchoice-pilot-v1')`,
      [campaignId,JSON.stringify([{candidate_id:candidateId,spot_id:'monthly-spot',spot_name:'Month winner',votes:2}]),JSON.stringify([candidateId])]);
    const overview=await getMonthlyOverview('pangasinan');
    expect(overview.current).toBeNull();
    expect(overview.next).toBeNull();
    expect(overview.previous?.campaign_id).toBe(campaignId);
    expect(overview.previous?.valid_ballots).toBe(2);
    expect(overview.availability.voting_enabled).toBe(false);
    expect(overview.availability.reason).toBe('SCHEDULE_PAUSED');
    await fixture.pool.query('UPDATE juanchoice_schedules SET enabled=TRUE WHERE id=$1',[schedule.id]);
    (env as any).JUANCHOICE_ENABLED=false;
    expect((await getMonthlyOverview('pangasinan')).availability.reason).toBe('FEATURE_DISABLED');
    (env as any).JUANCHOICE_ENABLED=true;
    expect((await fixture.pool.query('SELECT id FROM juanchoice_schedule_periods')).rowCount).toBe(1);
  });

  it('does not expose the test schedule through the real overview',async()=>{
    await createMonthlySchedule({schedule_key:'pangasinan-monthly',region_key:'pangasinan',display_region:'Pangasinan',
      timezone:'Asia/Manila',enabled:false,effective_period:'2026-10-01',preparation_lead_days:7,
      minimum_candidates:2,target_candidates:4,maximum_candidates:6,
      themes:[{name:'Nature and coast',categories:['nature_outdoors']}],policy_version:'juanchoice-monthly-v1',is_test:true});
    const publicResult=await getMonthlyOverview('pangasinan');
    expect(publicResult.previous?.campaign_id).toBe(campaignId);
    const testResult=await getMonthlyOverview('pangasinan',true);
    expect(testResult.previous).toBeNull();
    const forbidden=await request(app).get('/api/v1/juanchoice/overview?scope=test');
    expect(forbidden.status).toBe(403);
  });
});
