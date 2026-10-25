import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import { createTestDb } from '../src/db/testHarness.js';
import { setPool } from '../src/db/pool.js';
import { db } from '../src/db/index.js';

const describeRealPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;

describeRealPg('Personal trail generation (isolated real PostgreSQL)', () => {
  let fixture: Awaited<ReturnType<typeof createTestDb>>;
  let token: string;
  let validatorToken: string;
  let poorToken: string;
  const userId = 'trail-personal-user';

  beforeAll(async () => {
    fixture = await createTestDb();
    setPool(fixture.pool);
    db.usersRepo.setPool(fixture.pool);
    await fixture.pool.query(`INSERT INTO users(id,seed_id,display_name,email,role,demo_points,is_test)
      VALUES($1::text,$1::text,'Personal Trail Pilot','personal-trail@example.test','user',1000,FALSE)`, [userId]);
    await fixture.pool.query(`INSERT INTO users(id,seed_id,display_name,email,role,demo_points,is_test)
      VALUES('trail-personal-validator','trail-personal-validator','Validation Pilot','personal-validator@example.test','user',1000,FALSE)`);
    await fixture.pool.query(`INSERT INTO users(id,seed_id,display_name,email,role,demo_points,is_test)
      VALUES('trail-personal-poor','trail-personal-poor','Low Balance Pilot','personal-poor@example.test','user',50,FALSE)`);
    await fixture.pool.query(`INSERT INTO trail_generations(id,kind,requested_by,input,constraints,solver,solver_ms,objective,result)
      VALUES('trail-personal-prior','personal','trail-personal-poor','{}'::jsonb,'{}'::jsonb,'local',0,0,'{}'::jsonb)`);
    await fixture.pool.query(`INSERT INTO spots(id,slug,name,description,category,subcategory,municipality,address,gps_lat,gps_lng,source_type,source_name,status,is_test)
      VALUES ('personal-a','personal-a','Personal Beach A','A peaceful beach for an easy coastal stop.','beach','coast','Bolinao','Bolinao, Pangasinan',16.0,120.0,'editorial','Trail test','published',FALSE),
             ('personal-b','personal-b','Personal Heritage B','A quiet historic landmark to explore.','heritage','culture','Bolinao','Bolinao, Pangasinan',16.001,120.001,'editorial','Trail test','published',FALSE),
             ('personal-c','personal-c','Personal Cafe C','A family cafe and local food stop.','food','cafe','Bolinao','Bolinao, Pangasinan',16.002,120.002,'editorial','Trail test','published',FALSE)`);
    token = jwt.sign({ id:userId,seed_id:userId,role:'user' },env.JWT_SECRET,{ expiresIn:'1h' });
    validatorToken = jwt.sign({ id:'trail-personal-validator',seed_id:'trail-personal-validator',role:'user' },env.JWT_SECRET,{ expiresIn:'1h' });
    poorToken = jwt.sign({ id:'trail-personal-poor',seed_id:'trail-personal-poor',role:'user' },env.JWT_SECRET,{ expiresIn:'1h' });
  }, 120_000);

  afterAll(async () => {
    setPool(null);
    db.usersRepo.setPool(null);
    if (fixture) await fixture.close();
  }, 30_000);

  test('creates private owner trail and atomically charges only after the weekly free allowance', async () => {
    const first = await request(app).post('/api/v1/trails/personal').set('Authorization',`Bearer ${token}`)
      .set('Idempotency-Key','personal-free-generation-1').send({ themes:['beach','heritage'], municipalities:['Bolinao'], budget_min:240, pace:'relaxed' });
    expect(first.status).toBe(201);
    expect(first.body.data.trail).toMatchObject({ tier:'personal',status:'published',source:'personal',owner_user_id:userId });
    expect(first.body.data.charged_points).toBe(0);
    expect(first.body.data.free_generation_remaining).toBe(0);
    expect(first.body.data.solution.stops.length).toBeGreaterThanOrEqual(2);
    const selectedMunicipalities = await fixture.pool.query(`SELECT DISTINCT p.municipality FROM trail_stops s JOIN spots p ON p.id=s.spot_id WHERE s.trail_id=$1`, [first.body.data.trail.id]);
    expect(selectedMunicipalities.rows.every((row: any) => row.municipality === 'Bolinao')).toBe(true);
    const catalog = await request(app).get('/api/v1/trails').set('Authorization',`Bearer ${token}`);
    expect(catalog.body.data.personal_generation).toMatchObject({free_remaining:0,price_points:100});
    expect(catalog.body.data.items.find((trail: any) => trail.id === first.body.data.trail.id).is_unlocked).toBe(true);

    const replay = await request(app).post('/api/v1/trails/personal').set('Authorization',`Bearer ${token}`)
      .set('Idempotency-Key','personal-free-generation-1').send({ themes:['beach','heritage'], municipalities:['Bolinao'], budget_min:240, pace:'relaxed' });
    expect(replay.status).toBe(201);
    expect(replay.body.data.replayed).toBe(true);
    expect(replay.body.data.trail.id).toBe(first.body.data.trail.id);

    const second = await request(app).post('/api/v1/trails/personal').set('Authorization',`Bearer ${token}`)
      .set('Idempotency-Key','personal-paid-generation-2').send({ themes:['beach'], municipalities:['Bolinao'], budget_min:240 });
    expect(second.status).toBe(201);
    expect(second.body.data.charged_points).toBe(100);
    expect(Number((await fixture.pool.query('SELECT demo_points FROM users WHERE id=$1',[userId])).rows[0].demo_points)).toBe(900);
    expect((await fixture.pool.query(`SELECT COUNT(*)::int AS count FROM governance_ledger WHERE type='trail_unlock_debit' AND reference_type='personal_generation'`,[])).rows[0].count).toBe(2);
  }, 45_000);

  test('insufficient points rolls back the generated private trail and all debit ledger entries', async () => {
    const response = await request(app).post('/api/v1/trails/personal').set('Authorization',`Bearer ${poorToken}`)
      .set('Idempotency-Key','personal-insufficient-points-1').send({ themes:['beach'], municipalities:['Bolinao'], budget_min:240 });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('INSUFFICIENT_POINTS');
    expect((await fixture.pool.query("SELECT 1 FROM trails WHERE owner_user_id='trail-personal-poor'")).rowCount).toBe(0);
    expect((await fixture.pool.query("SELECT 1 FROM governance_ledger WHERE reference_type='personal_generation' AND actor_id='trail-personal-poor'")).rowCount).toBe(0);
  }, 45_000);

  test('validates input and does not allow anonymous generation', async () => {
    expect((await request(app).post('/api/v1/trails/personal').send({ themes:['beach'] })).status).toBe(401);
    const invalid = await request(app).post('/api/v1/trails/personal').set('Authorization',`Bearer ${validatorToken}`)
      .set('Idempotency-Key','personal-invalid-1').send({ text:'x'.repeat(301) });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('VALIDATION_ERROR');
  });
});
