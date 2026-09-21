import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { spawn } from 'child_process';
import path from 'path';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import { setPool } from '../src/db/pool.js';
import { db as domainDb } from '../src/db/index.js';
import { createTestDb, TestDbInstance } from '../src/db/testHarness.js';
import { castBallot, cancelCampaign, claimSupporterQuest, finalizeCampaign, getSupporterQuest, publishCampaign } from '../src/juanchoice/service.js';

describe('JuanChoice Phase 2 pilot', () => {
  let db: TestDbInstance;
  const user = 'jc-user';
  const young = 'jc-young';
  const admin = 'jc-admin';
  const campaign = randomUUID();
  const secondCampaign = randomUUID();
  const first = randomUUID();
  const second = randomUUID();
  const foreign = randomUUID();

  beforeAll(async () => {
    db = await createTestDb(); setPool(db.pool); domainDb.usersRepo.setPool(db.pool);
    (env as any).JUANCHOICE_ENABLED = true;
    (env as any).JUANCHOICE_WRITES_ENABLED = true;
    (env as any).PROGRESSION_ENABLED = true;
    await db.pool.query(`INSERT INTO users(id,seed_id,display_name,email,created_at,is_test) VALUES
      ($1,$2,'Voter','jc-voter@example.test',NOW() - INTERVAL '4 days',false),
      ($3,$4,'New voter','jc-new@example.test',NOW(),false)`, [user,user,young,young]);
    await db.pool.query("INSERT INTO users(id,seed_id,display_name,email,role) VALUES($1,$2,'Moderator','jc-admin@example.test','admin')",[admin,admin]);
    for (const [id,slug] of [['jc-spot-1','jc-spot-1'],['jc-spot-2','jc-spot-2']]) {
      await db.pool.query(`INSERT INTO spots(id,slug,name,description,category,subcategory,municipality,address,gps_lat,gps_lng,source_type,source_name,is_test)
        VALUES($1,$2,$3,'Test spot','nature','beach','Bolinao','Bolinao',16,120,'lgu','Test LGU',false)`, [id,slug,slug]);
    }
    for (const [id,slug] of [[campaign,'jc-round-one'],[secondCampaign,'jc-round-two']]) {
      await db.pool.query(`INSERT INTO juanchoice_campaigns(id,slug,region,theme,status,opens_at,closes_at)
        VALUES($1,$2,'Pangasinan','Beaches','voting',NOW() - INTERVAL '1 day',NOW() + INTERVAL '1 day')`, [id,slug]);
    }
    for (const [id,cid,spot] of [[first,campaign,'jc-spot-1'],[second,campaign,'jc-spot-2'],[foreign,secondCampaign,'jc-spot-2']]) {
      await db.pool.query('INSERT INTO juanchoice_candidates(id,campaign_id,spot_id) VALUES($1,$2,$3)', [id,cid,spot]);
    }
  }, 30_000);
  afterAll(async () => {
    setPool(null); domainDb.usersRepo.setPool(null); await db.close();
    (env as any).JUANCHOICE_ENABLED = false;
    (env as any).JUANCHOICE_WRITES_ENABLED = false;
  });

  it('awards once, changes ballot once, and replays exact receipt after close', async () => {
    const key = randomUUID();
    const initial = await castBallot({ campaignId:campaign,userId:user,candidateId:first,expectedVersion:0,idempotencyKey:key });
    expect(initial.ballot.version).toBe(1);
    expect(initial.participation).toEqual({ civic_xp:25,stamps:1,token_grant_mjdq:'0' });
    const edited = await castBallot({ campaignId:campaign,userId:user,candidateId:second,expectedVersion:1,idempotencyKey:randomUUID() });
    expect(edited.ballot.version).toBe(2);
    const totals = (await db.pool.query('SELECT civic_xp,civic_stamps FROM progression_totals WHERE user_id=$1',[user])).rows[0];
    expect(Number(totals.civic_xp)).toBe(25);
    expect(Number(totals.civic_stamps)).toBe(1);
    expect((await db.pool.query('SELECT * FROM juanchoice_participations WHERE user_id=$1',[user])).rowCount).toBe(1);
    expect((await db.pool.query('SELECT * FROM progression_events WHERE user_id=$1',[user])).rowCount).toBe(2);
    expect(Number((await db.pool.query('SELECT demo_points FROM users WHERE id=$1',[user])).rows[0].demo_points)).toBe(0);
    await db.pool.query("UPDATE juanchoice_campaigns SET status='closed', closes_at=NOW() - INTERVAL '1 minute' WHERE id=$1",[campaign]);
    const replay = await castBallot({ campaignId:campaign,userId:user,candidateId:first,expectedVersion:0,idempotencyKey:key });
    expect(replay.replayed).toBe(true);
    await expect(castBallot({ campaignId:campaign,userId:user,candidateId:second,expectedVersion:0,idempotencyKey:key }))
      .rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
    await expect(castBallot({ campaignId:campaign,userId:user,candidateId:first,expectedVersion:2,idempotencyKey:randomUUID() }))
      .rejects.toMatchObject({code:'ROUND_CLOSED'});
  });

  it('rejects cross-campaign candidate and ineligible new account', async () => {
    await expect(castBallot({campaignId:secondCampaign,userId:user,candidateId:first,expectedVersion:0,idempotencyKey:randomUUID()}))
      .rejects.toMatchObject({code:'INVALID_CANDIDATE'});
    await expect(castBallot({campaignId:secondCampaign,userId:young,candidateId:foreign,expectedVersion:0,idempotencyKey:randomUUID()}))
      .rejects.toMatchObject({code:'NOT_ELIGIBLE'});
  });

  it('finalizes a durable result once, preserving zero-vote outcome', async () => {
    await db.pool.query("UPDATE juanchoice_campaigns SET status='closed', closes_at=NOW() - INTERVAL '1 minute' WHERE id=$1",[secondCampaign]);
    const result = await finalizeCampaign(secondCampaign);
    expect(result.valid_ballots).toBe(0);
    expect(result.co_winner_ids).toEqual([]);
    const replay = await finalizeCampaign(secondCampaign);
    expect(replay.finalized_at).toEqual(result.finalized_at);
    expect((await db.pool.query('SELECT * FROM juanchoice_results WHERE campaign_id=$1',[secondCampaign])).rowCount).toBe(1);
  });

  it('keeps private ballot off public standings and requires a bearer token for /me', async () => {
    const standings = await request(app).get(`/api/v1/juanchoice/campaigns/${campaign}/standings`);
    expect(standings.status).toBe(200);
    expect(JSON.stringify(standings.body)).not.toContain(user);
    expect((await request(app).get(`/api/v1/juanchoice/campaigns/${campaign}/me`)).status).toBe(401);
    const token = jwt.sign({id:user,role:'user'},env.JWT_SECRET);
    const mine = await request(app).get(`/api/v1/juanchoice/campaigns/${campaign}/me`).set('Authorization',`Bearer ${token}`);
    expect(mine.status).toBe(200);
    expect(mine.body.data.ballot.version).toBe(2);
  });

  it('quarantines synthetic campaigns from public discovery', async () => {
    const synthetic = randomUUID();
    await db.pool.query("INSERT INTO juanchoice_campaigns(id,slug,region,theme,status,opens_at,closes_at,is_test) VALUES($1,'jc-qa','Pangasinan','QA','scheduled',NOW(),NOW() + INTERVAL '1 day',true)",[synthetic]);
    const list = await request(app).get('/api/v1/juanchoice/campaigns');
    expect(list.status).toBe(200);
    expect(list.body.data.items.some((row: any) => row.id === synthetic)).toBe(false);
    expect((await request(app).get(`/api/v1/juanchoice/campaigns/${synthetic}`)).status).toBe(404);
    const token = jwt.sign({id:user,role:'user'},env.JWT_SECRET);
    expect((await request(app).get(`/api/v1/juanchoice/campaigns/${synthetic}/me`).set('Authorization',`Bearer ${token}`)).status).toBe(404);
  });

  it('preserves co-winners without choosing an arbitrary destination', async () => {
    const tieCampaign = randomUUID(); const a = randomUUID(); const b = randomUUID();
    await db.pool.query("INSERT INTO juanchoice_campaigns(id,slug,region,theme,status,opens_at,closes_at) VALUES($1,'jc-tie','Pangasinan','Tie','closed',NOW() - INTERVAL '2 days',NOW() - INTERVAL '1 day')",[tieCampaign]);
    await db.pool.query('INSERT INTO juanchoice_candidates(id,campaign_id,spot_id) VALUES($1,$2,$3),($4,$2,$5)',[a,tieCampaign,'jc-spot-1',b,'jc-spot-2']);
    await db.pool.query('INSERT INTO juanchoice_ballots(campaign_id,user_id,candidate_id) VALUES($1,$2,$3),($1,$4,$5)',[tieCampaign,user,a,young,b]);
    const result = await finalizeCampaign(tieCampaign);
    expect(result.valid_ballots).toBe(2);
    expect(result.co_winner_ids).toEqual(expect.arrayContaining([a,b]));
    expect(result.co_winner_ids).toHaveLength(2);
  });

  it('blocks overlapping primary regional publication and audits cancellation', async () => {
    const overlapping = randomUUID();
    await db.pool.query("INSERT INTO juanchoice_campaigns(id,slug,region,theme,status,opens_at,closes_at) VALUES($1,'jc-overlap','Pangasinan','Overlap','draft',NOW() - INTERVAL '1 hour',NOW() + INTERVAL '1 day')",[overlapping]);
    await db.pool.query('INSERT INTO juanchoice_candidates(id,campaign_id,spot_id) VALUES($1,$2,$3)',[randomUUID(),overlapping,'jc-spot-1']);
    await expect(publishCampaign(overlapping,user)).rejects.toMatchObject({code:'REGIONAL_ROUND_OVERLAP'});
    const cancelled = await cancelCampaign(overlapping,user,'Round replaced after review');
    expect(cancelled.status).toBe('cancelled');
    expect((await db.pool.query("SELECT * FROM juanchoice_campaign_audit WHERE campaign_id=$1 AND action='cancelled'",[overlapping])).rowCount).toBe(1);
  });

  it('exposes private admin drafts and moderates candidates with an audit reason', async () => {
    const draft = randomUUID(), nominee = randomUUID();
    await db.pool.query("INSERT INTO juanchoice_campaigns(id,slug,region,theme,status,opens_at,closes_at) VALUES($1,'jc-admin-draft','Pangasinan','Admin','draft',NOW(),NOW() + INTERVAL '1 day')",[draft]);
    await db.pool.query('INSERT INTO juanchoice_candidates(id,campaign_id,spot_id) VALUES($1,$2,$3)',[nominee,draft,'jc-spot-1']);
    const guest = await request(app).get('/api/v1/juanchoice/admin/campaigns');
    expect(guest.status).toBe(401);
    const token=jwt.sign({id:admin,role:'admin'},env.JWT_SECRET);
    const list=await request(app).get('/api/v1/juanchoice/admin/campaigns').set('Authorization',`Bearer ${token}`);
    expect(list.status).toBe(200);
    expect(list.body.data.items.some((item:any)=>item.id===draft)).toBe(true);
    const review=await request(app).patch(`/api/v1/juanchoice/admin/campaigns/${draft}/candidates/${nominee}`)
      .set('Authorization',`Bearer ${token}`).send({status:'suspended',reason:'Capacity review is incomplete'});
    expect(review.status).toBe(200);
    const detail=await request(app).get(`/api/v1/juanchoice/admin/campaigns/${draft}`).set('Authorization',`Bearer ${token}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.campaign.ballot_count).toBe(0);
    expect(detail.body.data.candidates[0].status).toBe('suspended');
    expect(detail.body.data.audit[0].reason).toBe('Capacity review is incomplete');
  });

  it('promotes only a current finalized and still-safe public winner when the flag is on', async () => {
    const featuredCampaign=randomUUID(), featuredCandidate=randomUUID();
    await db.pool.query("INSERT INTO juanchoice_campaigns(id,slug,region,theme,status,opens_at,closes_at) VALUES($1,'jc-featured','Pangasinan','Hidden Gems','finalized',NOW() - INTERVAL '8 days',NOW() - INTERVAL '1 day')",[featuredCampaign]);
    await db.pool.query('INSERT INTO juanchoice_candidates(id,campaign_id,spot_id) VALUES($1,$2,$3)',[featuredCandidate,featuredCampaign,'jc-spot-1']);
    await db.pool.query('INSERT INTO juanchoice_results(campaign_id,standings,co_winner_ids,valid_ballots,policy_version) VALUES($1,$2::jsonb,$3::jsonb,5,$4)',
      [featuredCampaign,JSON.stringify([{candidate_id:featuredCandidate,spot_id:'jc-spot-1',votes:5}]),JSON.stringify([featuredCandidate]),'juanchoice-pilot-v1']);
    expect((await request(app).get('/api/v1/juanchoice/spotlight')).body.data).toBeNull();
    (env as any).JUANCHOICE_PROMOTION_ENABLED=true;
    try {
      const live=await request(app).get('/api/v1/juanchoice/spotlight');
      expect(live.status).toBe(200);
      expect(live.body.data.kind).toBe('juanchoice_spotlight');
      expect(live.body.data.winners.map((winner:any)=>winner.spot_id)).toEqual(['jc-spot-1']);
      await db.pool.query("UPDATE spots SET recommendation_suppressed=TRUE WHERE id='jc-spot-1'");
      expect((await request(app).get('/api/v1/juanchoice/spotlight')).body.data).toBeNull();
    } finally {
      await db.pool.query("UPDATE spots SET recommendation_suppressed=FALSE WHERE id='jc-spot-1'");
      (env as any).JUANCHOICE_PROMOTION_ENABLED=false;
    }
  });

  it('keeps the visit quest dormant without a reviewed binding and rewards any verified visitor once', async()=>{
    const visitCampaign=randomUUID(), candidate=randomUUID(), binding=randomUUID();
    const questId='jc-supporter-quest';
    await db.pool.query("INSERT INTO juanchoice_campaigns(id,slug,region,theme,status,opens_at,closes_at,finalized_at) VALUES($1,'jc-supporter','Pangasinan','Visit Winner','finalized',NOW()-INTERVAL '8 days',NOW()-INTERVAL '2 hours',NOW())",[visitCampaign]);
    await db.pool.query('INSERT INTO juanchoice_candidates(id,campaign_id,spot_id) VALUES($1,$2,$3)',[candidate,visitCampaign,'jc-spot-1']);
    await db.pool.query("INSERT INTO juanchoice_results(campaign_id,standings,co_winner_ids,valid_ballots,policy_version,finalized_at) VALUES($1,$2::jsonb,$3::jsonb,2,$4,NOW())",
      [visitCampaign,JSON.stringify([{candidate_id:candidate,spot_id:'jc-spot-1',votes:2}]),JSON.stringify([candidate]),'juanchoice-pilot-v1']);
    expect(await getSupporterQuest(young)).toBeNull();
    await db.pool.query(`INSERT INTO quests(id,title,description,category,location_name,gps_lat,gps_lng,radius_meters,reward_points,marker_code,marker_image_url)
      VALUES($1,'Supporter visit','Visit the community-selected destination','eco','Bolinao',16,120,100,0,'jc-supporter-marker','https://example.test/marker.png')`,[questId]);
    await db.pool.query("INSERT INTO reviewed_quest_spot_bindings(id,quest_id,spot_id,binding_version,status,is_test) VALUES($1,$2,$3,$4,'active',false)",[binding,questId,'jc-spot-1','supporter-v1']);
    const available=await getSupporterQuest(young);
    expect(available).toMatchObject({campaign_id:visitCampaign,spot_id:'jc-spot-1',quest_id:questId,explorer_xp:300,claimed:false});
    await expect(claimSupporterQuest(visitCampaign,young)).rejects.toMatchObject({code:'VERIFIED_VISIT_REQUIRED'});
    const submission='jc-supporter-submission', visit=randomUUID();
    await db.pool.query(`INSERT INTO submissions(id,idempotency_key,user_id,quest_id,scanned_marker_code,captured_lat,captured_lng,captured_accuracy,status,reviewed_at)
      VALUES($1,$2,$3,$4,'jc-supporter-marker',16,120,5,'approved',NOW())`,[submission,randomUUID(),young,questId]);
    await db.pool.query(`INSERT INTO verified_visits(id,user_id,spot_id,binding_id,source_submission_id,occurred_at,verified_at,evidence_version,is_test)
      VALUES($1,$2,$3,$4,$5,NOW(),NOW(),'supporter-v1',false)`,[visit,young,'jc-spot-1',binding,submission]);
    const claimed=await claimSupporterQuest(visitCampaign,young);
    expect(claimed.replayed).toBe(false);
    expect((await claimSupporterQuest(visitCampaign,young)).replayed).toBe(true);
    expect(Number((await db.pool.query('SELECT explorer_xp FROM progression_totals WHERE user_id=$1',[young])).rows[0].explorer_xp)).toBe(300);
    expect((await db.pool.query('SELECT * FROM juanchoice_ballots WHERE campaign_id=$1 AND user_id=$2',[visitCampaign,young])).rowCount).toBe(0);
    const token=jwt.sign({id:young,role:'user'},env.JWT_SECRET);
    const api=await request(app).get('/api/v1/juanchoice/supporter-quest').set('Authorization',`Bearer ${token}`);
    expect(api.status).toBe(200); expect(api.body.data.claimed).toBe(true);
  });

  const realIt = process.env.JDQ_REAL_PG_URL ? it : it.skip;
  realIt('serializes simultaneous first ballots on real PostgreSQL', async () => {
    const contender = 'jc-concurrent';
    const raceCampaign = randomUUID();
    const raceCandidate = randomUUID();
    await db.pool.query("INSERT INTO users(id,seed_id,display_name,email,created_at) VALUES($1,$2,'Concurrent','jc-concurrent@example.test',NOW() - INTERVAL '4 days')",[contender,contender]);
    await db.pool.query("INSERT INTO juanchoice_campaigns(id,slug,region,theme,status,opens_at,closes_at) VALUES($1,'jc-race','Pangasinan','Race','voting',NOW() - INTERVAL '1 day',NOW() + INTERVAL '1 day')",[raceCampaign]);
    await db.pool.query('INSERT INTO juanchoice_candidates(id,campaign_id,spot_id) VALUES($1,$2,$3)',[raceCandidate,raceCampaign,'jc-spot-1']);
    const pair = await Promise.allSettled([0,1].map(() => castBallot({
      campaignId:raceCampaign,userId:contender,candidateId:raceCandidate,expectedVersion:0,idempotencyKey:randomUUID(),
    })));
    expect(pair.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(pair.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect((await db.pool.query('SELECT * FROM juanchoice_participations WHERE campaign_id=$1',[raceCampaign])).rowCount).toBe(1);
    expect(Number((await db.pool.query('SELECT civic_xp FROM progression_totals WHERE user_id=$1',[contender])).rows[0].civic_xp)).toBe(25);
  });

  realIt('rechecks the deadline after waiting on a campaign lock', async () => {
    const closeCampaign = randomUUID(); const closeCandidate = randomUUID();
    await db.pool.query("INSERT INTO juanchoice_campaigns(id,slug,region,theme,status,opens_at,closes_at) VALUES($1,'jc-close-lock','Pangasinan','Lock','voting',NOW() - INTERVAL '1 day',NOW() + INTERVAL '1 day')",[closeCampaign]);
    await db.pool.query('INSERT INTO juanchoice_candidates(id,campaign_id,spot_id) VALUES($1,$2,$3)',[closeCandidate,closeCampaign,'jc-spot-1']);
    const blocker = await db.pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM juanchoice_campaigns WHERE id=$1 FOR UPDATE',[closeCampaign]);
      const attempting = castBallot({campaignId:closeCampaign,userId:user,candidateId:closeCandidate,expectedVersion:0,idempotencyKey:randomUUID()});
      await new Promise(resolve => setTimeout(resolve,100));
      await blocker.query("UPDATE juanchoice_campaigns SET status='closed',closes_at=NOW() - INTERVAL '1 second' WHERE id=$1",[closeCampaign]);
      await blocker.query('COMMIT');
      await expect(attempting).rejects.toMatchObject({code:'ROUND_CLOSED'});
      expect((await db.pool.query('SELECT * FROM juanchoice_ballots WHERE campaign_id=$1',[closeCampaign])).rowCount).toBe(0);
    } finally {
      await blocker.query('ROLLBACK'); blocker.release();
    }
  });

  realIt('deduplicates simultaneous first ballots across separate OS processes', async () => {
    const multiCampaign = randomUUID(); const candidateId = randomUUID(); const actor = 'jc-multiprocess';
    await db.pool.query("INSERT INTO users(id,seed_id,display_name,email,created_at) VALUES($1,$2,'Multi','jc-multiprocess@example.test',NOW() - INTERVAL '4 days')",[actor,actor]);
    await db.pool.query("INSERT INTO juanchoice_campaigns(id,slug,region,theme,status,opens_at,closes_at) VALUES($1,'jc-multiprocess','Pangasinan','Multi','voting',NOW() - INTERVAL '1 day',NOW() + INTERVAL '1 day')",[multiCampaign]);
    await db.pool.query('INSERT INTO juanchoice_candidates(id,campaign_id,spot_id) VALUES($1,$2,$3)',[candidateId,multiCampaign,'jc-spot-1']);
    const runWorker = (key: string) => new Promise<any>((resolve,reject) => {
      const child = spawn(process.execPath,[path.join(__dirname,'juanchoice-ballot-worker.cjs')],{
        env: { ...process.env,
          JDQ_POOL_OPTIONS: (db.pool as any).options.options,
          JDQ_BALLOT_INPUT: JSON.stringify({campaignId:multiCampaign,userId:actor,candidateId,expectedVersion:0,idempotencyKey:key}),
        }, stdio:['ignore','pipe','pipe'],
      });
      let stdout=''; let stderr='';
      child.stdout.on('data',chunk => { stdout += String(chunk); });
      child.stderr.on('data',chunk => { stderr += String(chunk); });
      child.on('error',reject);
      child.on('exit',code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
    });
    const results = await Promise.all([runWorker(randomUUID()),runWorker(randomUUID())]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => result.code === 'VERSION_CONFLICT')).toHaveLength(1);
    expect((await db.pool.query('SELECT * FROM juanchoice_participations WHERE campaign_id=$1',[multiCampaign])).rowCount).toBe(1);
    expect(Number((await db.pool.query('SELECT civic_xp FROM progression_totals WHERE user_id=$1',[actor])).rows[0].civic_xp)).toBe(25);
  });
});
