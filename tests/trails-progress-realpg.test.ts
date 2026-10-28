import request from 'supertest';
import jwt from 'jsonwebtoken';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';
import { setPool } from '../src/db/pool.js';
import { db } from '../src/db/index.js';
import { checkinTrailStop, TrailProgressError, unlockTrail } from '../src/trails/progress.js';

const describeRealPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;

function startUnlockWorker(schema: string, userId: string, trailId: string, key: string) {
  const worker = path.resolve(process.cwd(), 'tests/helpers/trail-unlock-worker.cjs');
  return new Promise<{ code: number; result: any; output: string }>((resolve) => {
    const child = spawn(process.execPath, [worker, schema, userId, trailId, key], { env: process.env, cwd: process.cwd() });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    child.on('close', code => {
      let result = null;
      try { result = JSON.parse(output); } catch {}
      resolve({ code: code ?? 0, result, output });
    });
  });
}

describeRealPg('Trail unlock, location check-in, and completion (isolated real PostgreSQL)', () => {
  let fixture: TestDbInstance;
  let schema: string;
  const userId = 'trail-progress-user';
  const otherId = 'trail-progress-poor';
  const trailId = 'trail-progress-route';
  const lockedId = 'trail-progress-locked';
  let token: string;

  beforeAll(async () => {
    fixture = await createTestDb();
    setPool(fixture.pool);
    db.usersRepo.setPool(fixture.pool);
    schema = String((await fixture.pool.query('SELECT current_schema()')).rows[0].current_schema);
    await fixture.pool.query(`INSERT INTO users(id,seed_id,display_name,email,role,demo_points,is_test)
      VALUES($1::text,$1::text,'Trail Pilot','trail-pilot@example.test','user',1000,FALSE),
            ($2::text,$2::text,'Low Balance','trail-low@example.test','user',100,FALSE)`, [userId,otherId]);
    await fixture.pool.query(`INSERT INTO spots(id,slug,name,description,category,subcategory,municipality,address,gps_lat,gps_lng,source_type,source_name,status,is_test)
      VALUES ('trail-progress-spot-a','trail-progress-spot-a','Trail Checkpoint A','A real test checkpoint.','beach','coast','Bolinao','Bolinao, Pangasinan',16.0,120.0,'editorial','Trail test','published',FALSE),
             ('trail-progress-spot-b','trail-progress-spot-b','Trail Checkpoint B','Another real test checkpoint.','heritage','culture','Bolinao','Bolinao, Pangasinan',16.001,120.001,'editorial','Trail test','published',FALSE)`);
    await fixture.pool.query(`INSERT INTO trails(id,slug,title,tagline,tier,theme,municipalities,unlock_rule,costing,total_minutes,total_km,story,status,source,is_test)
      VALUES ($1,$1,'Test Signature Route','Two stops','signature','mixed',ARRAY['Bolinao'],'{"type":"points","price_points":300}'::jsonb,
        'auto',90,2,'{"title":"Test Signature Route","intro":"A test route","stops":[{"spot_id":"trail-progress-spot-a","narration":"First"},{"spot_id":"trail-progress-spot-b","narration":"Second"}]}'::jsonb,'published','engine',FALSE),
        ($2,$2,'Locked Detail Route','Do not reveal stops','starter','mixed',ARRAY['Bolinao'],'{"type":"free"}'::jsonb,
        'auto',90,2,'{"title":"Locked Detail Route"}'::jsonb,'published','engine',FALSE)`, [trailId,lockedId]);
    await fixture.pool.query(`INSERT INTO trail_stops(trail_id,position,spot_id,arrive_offset_min,dwell_min,leg_minutes,leg_km,narration)
      VALUES ($1,1,'trail-progress-spot-a',0,45,0,0,'First stop private narration'),
             ($1,2,'trail-progress-spot-b',45,45,10,1,'Second stop private narration'),
             ($2,1,'trail-progress-spot-a',0,45,0,0,'Must not leak'),
             ($2,2,'trail-progress-spot-b',45,45,10,1,'Must not leak either')`, [trailId,lockedId]);
    token = jwt.sign({ id:userId,seed_id:userId,role:'user' },env.JWT_SECRET,{ expiresIn:'1h' });
  }, 120_000);

  afterAll(async () => {
    setPool(null);
    db.usersRepo.setPool(null);
    if(fixture) await fixture.close();
  }, 30_000);

  test('paid unlock from two OS processes charges once; replay is stable and locked detail is redacted', async () => {
    const [one,two]=await Promise.all([
      startUnlockWorker(schema,userId,trailId,'trail-unlock-process-a'),
      startUnlockWorker(schema,userId,trailId,'trail-unlock-process-b'),
    ]);
    expect(one.code).toBe(0);
    expect(two.code).toBe(0);
    expect(one.result?.success).toBe(true);
    expect(two.result?.success).toBe(true);
    expect([one.result.result.already_unlocked,two.result.result.already_unlocked].sort()).toEqual([false,true]);
    expect(Number((await fixture.pool.query('SELECT demo_points FROM users WHERE id=$1',[userId])).rows[0].demo_points)).toBe(700);
    expect((await fixture.pool.query(`SELECT trail_id FROM trail_unlocks WHERE trail_id=$1 AND user_id=$2`,[trailId,userId])).rowCount).toBe(1);
    const debit=await fixture.pool.query(`SELECT COUNT(*)::int AS rows,SUM(amount_mjdq)::bigint AS net FROM governance_ledger WHERE type='trail_unlock_debit' AND reference_id=$1`,[trailId]);
    expect(debit.rows[0]).toMatchObject({rows:2,net:'0'});

    const before=await request(app).get(`/api/v1/trails/${lockedId}`);
    expect(before.status).toBe(200);
    const serialized=JSON.stringify(before.body.data);
    expect(serialized).not.toContain('spot_id');
    expect(serialized).not.toContain('gps_lat');
    expect(serialized).not.toContain('Must not leak');
    expect(before.body.data).toMatchObject({id:lockedId,is_unlocked:false,stop_count:2});
    // Plan 64: the locked modal may show what the trail offers (names, one line), never the order or map.
    expect(before.body.data.preview.map((stop: any) => stop.name)).toEqual(['Trail Checkpoint A','Trail Checkpoint B']);
    expect(before.body.data.preview[0]).toMatchObject({municipality:'Bolinao',blurb:'A real test checkpoint.'});
    expect(serialized).not.toContain('position');
    expect(serialized).not.toContain('"lat"');

    const detail=await request(app).get(`/api/v1/trails/${trailId}`).set('Authorization',`Bearer ${token}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.stops).toHaveLength(2);
    expect(detail.body.data.stops[0]).toMatchObject({spot_id:'trail-progress-spot-a',lat:16,lng:120});
    const replay=await unlockTrail(fixture.pool,userId,trailId,'trail-unlock-process-a');
    expect(replay.replayed).toBe(true);
    expect(Number((await fixture.pool.query('SELECT demo_points FROM users WHERE id=$1',[userId])).rows[0].demo_points)).toBe(700);
  }, 30_000);

  test('Plan 64: trails near a destination list those passing through it first, without stop details', async () => {
    const near=await request(app).get('/api/v1/trails/near').query({lat:16.0005,lng:120.0005,spot_id:'trail-progress-spot-b',radius_km:5});
    expect(near.status).toBe(200);
    const ids=near.body.data.items.map((item: any) => item.id);
    expect(ids).toEqual(expect.arrayContaining([trailId,lockedId]));
    expect(near.body.data.items[0]).toMatchObject({passes_here:true});
    expect(JSON.stringify(near.body.data)).not.toContain('spot_id');
    const far=await request(app).get('/api/v1/trails/near').query({lat:14.6,lng:120.98,radius_km:5});
    expect(far.status).toBe(200);
    expect(far.body.data.items).toHaveLength(0);
    expect((await request(app).get('/api/v1/trails/near').query({lat:'x'})).status).toBe(400);
  }, 30_000);

  test('check-in validates radius and accuracy then completes and pays exactly once with a Plaza event', async () => {
    await expect(checkinTrailStop(fixture.pool,userId,trailId,1,{lat:16.01,lng:120,accuracy_m:5}))
      .rejects.toMatchObject({code:'TOO_FAR_FROM_STOP'});
    await expect(checkinTrailStop(fixture.pool,userId,trailId,1,{lat:16,lng:120,accuracy_m:101}))
      .rejects.toMatchObject({code:'LOCATION_ACCURACY_TOO_LOW'});
    const first=await checkinTrailStop(fixture.pool,userId,trailId,1,{lat:16,lng:120,accuracy_m:8});
    expect(first.completion).toBeNull();
    const last=await checkinTrailStop(fixture.pool,userId,trailId,2,{lat:16.001,lng:120.001,accuracy_m:6});
    expect(last.completion).toMatchObject({trail_id:trailId,reward_points:200});
    expect(last.progress.every(stop=>stop.checked_in)).toBe(true);
    const again=await checkinTrailStop(fixture.pool,userId,trailId,2,{lat:16.001,lng:120.001,accuracy_m:6});
    expect(again.completion).toBeNull();
    expect(again.verified_at).toEqual(last.verified_at);
    const user=await fixture.pool.query('SELECT demo_points FROM users WHERE id=$1',[userId]);
    expect(Number(user.rows[0].demo_points)).toBe(900);
    expect((await fixture.pool.query('SELECT trail_id FROM trail_completions WHERE trail_id=$1 AND user_id=$2',[trailId,userId])).rowCount).toBe(1);
    expect((await fixture.pool.query(`SELECT id FROM governance_ledger WHERE type='trail_reward_credit' AND reference_id=$1`,[trailId])).rowCount).toBe(2);
    expect((await fixture.pool.query(`SELECT event_key FROM social_activities WHERE event_key=$1`,[`trail_completed:${userId}:${trailId}`])).rowCount).toBe(1);
  }, 30_000);

  test('insufficient balance and admin-only route boundaries fail closed without partial ledger writes', async () => {
    await fixture.pool.query(`INSERT INTO trails(id,slug,title,tier,theme,municipalities,unlock_rule,total_minutes,total_km,story,status,source,is_test)
      VALUES ('trail-poor-balance','trail-poor-balance','Priced Route','signature','mixed',ARRAY['Bolinao'],'{"type":"points","price_points":300}'::jsonb,60,0,'{}'::jsonb,'published','engine',FALSE)`);
    await expect(unlockTrail(fixture.pool,otherId,'trail-poor-balance','poor-balance-key'))
      .rejects.toMatchObject({code:'INSUFFICIENT_POINTS'});
    expect((await fixture.pool.query('SELECT 1 FROM trail_unlocks WHERE trail_id=$1',[ 'trail-poor-balance' ])).rowCount).toBe(0);
    expect((await fixture.pool.query(`SELECT 1 FROM governance_ledger WHERE reference_id='trail-poor-balance' AND type='trail_unlock_debit'`)).rowCount).toBe(0);
    expect((await request(app).post(`/api/v1/trails/${trailId}/unlock`).set('Idempotency-Key','missing-auth-key').send({})).status).toBe(401);
    expect((await request(app).get('/api/v1/admin/trails/review')).status).toBe(401);
  }, 30_000);
});
