import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import { createTestDb } from '../src/db/testHarness.js';
import { setPool } from '../src/db/pool.js';
import { db } from '../src/db/index.js';
import { createPersonalTrail, PersonalTrailError } from '../src/trails/personal.js';
import { fundingCommand } from '../src/funding/transaction.js';

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
    await fixture.pool.query(`INSERT INTO users(id,seed_id,display_name,email,role,demo_points,is_test)
      VALUES('trail-personal-transfer','trail-personal-transfer','Transfer Pilot','personal-transfer@example.test','user',100,FALSE)`);
    await fixture.pool.query(`INSERT INTO trail_generations(id,kind,requested_by,input,constraints,solver,solver_ms,objective,result)
      VALUES('trail-personal-prior','personal','trail-personal-poor','{}'::jsonb,'{}'::jsonb,'local',0,0,'{}'::jsonb)`);
    await fixture.pool.query(`INSERT INTO spots(id,slug,name,description,category,subcategory,municipality,address,gps_lat,gps_lng,source_type,source_name,status,is_test)
      VALUES ('personal-a','personal-a','Personal Beach A','A peaceful beach for an easy coastal stop.','beach','coast','Bolinao','Bolinao, Pangasinan',16.0,120.0,'editorial','Trail test','published',FALSE),
             ('personal-b','personal-b','Personal Heritage B','A quiet historic landmark to explore.','heritage','culture','Bolinao','Bolinao, Pangasinan',16.001,120.001,'editorial','Trail test','published',FALSE),
             ('personal-c','personal-c','Personal Cafe C','A family cafe and local food stop.','food','cafe','Bolinao','Bolinao, Pangasinan',16.002,120.002,'editorial','Trail test','published',FALSE)`);
    await fixture.pool.query(`INSERT INTO travel_time_matrix(costing,from_spot,to_spot,seconds,meters,approximate,graph_label)
      SELECT 'auto',from_spot.id,to_spot.id,CASE WHEN from_spot.id=to_spot.id THEN 0 ELSE 60 END,
        CASE WHEN from_spot.id=to_spot.id THEN 0 ELSE 100 END,FALSE,'personal-test'
      FROM (SELECT id FROM spots WHERE municipality='Bolinao' AND status='published' AND COALESCE(is_test,FALSE)=FALSE AND gps_lat IS NOT NULL AND gps_lng IS NOT NULL) from_spot
      CROSS JOIN (SELECT id FROM spots WHERE municipality='Bolinao' AND status='published' AND COALESCE(is_test,FALSE)=FALSE AND gps_lat IS NOT NULL AND gps_lng IS NOT NULL) to_spot
      ON CONFLICT DO NOTHING`);
    token = jwt.sign({ id:userId,seed_id:userId,role:'user' },env.JWT_SECRET,{ expiresIn:'1h' });
    validatorToken = jwt.sign({ id:'trail-personal-validator',seed_id:'trail-personal-validator',role:'user' },env.JWT_SECRET,{ expiresIn:'1h' });
    poorToken = jwt.sign({ id:'trail-personal-poor',seed_id:'trail-personal-poor',role:'user' },env.JWT_SECRET,{ expiresIn:'1h' });
  }, 120_000);

  afterAll(async () => {
    setPool(null);
    db.usersRepo.setPool(null);
    if (fixture) await fixture.close();
  }, 30_000);

  async function setPersonalGenerationEnabled(enabled: boolean) {
    await fixture.pool.query(`INSERT INTO system_settings_document(id,values,revision) VALUES(1,$1::jsonb,1)
      ON CONFLICT(id) DO UPDATE SET values=system_settings_document.values || EXCLUDED.values, revision=system_settings_document.revision+1`,
      [JSON.stringify({trail_personal_generation_enabled:enabled})]);
  }

  test('tailored generation switched off by an admin stops before preference, story, matrix, charge or trail work', async () => {
    await setPersonalGenerationEnabled(false);
    const beforeGenerations = await fixture.pool.query("SELECT COUNT(*)::int AS count FROM trail_generations WHERE kind='personal' AND requested_by=$1", [userId]);
    const beforeLedger = await fixture.pool.query("SELECT COUNT(*)::int AS count FROM governance_ledger WHERE actor_id=$1 AND reference_type='personal_generation'", [userId]);
    const storyWriter = jest.fn();
    await expect(createPersonalTrail(fixture.pool,userId,'personal-disabled-generation-1',{text:'a relaxed beach trip'}, {storyWriter})).rejects.toMatchObject({
      code:'PERSONAL_TRAILS_DISABLED', status:404,
    } satisfies Partial<PersonalTrailError>);
    expect(storyWriter).not.toHaveBeenCalled();

    // Keep this API probe on its own actor: the personal-generation limiter is
    // intentionally shared across tests for a given traveler, and the existing
    // paid-generation test uses all three hourly slots for its free/replay/paid path.
    const catalog = await request(app).get('/api/v1/trails').set('Authorization',`Bearer ${validatorToken}`);
    expect(catalog.status).toBe(200);
    expect(catalog.body.data.personal_generation).toBeNull();
    const response = await request(app).post('/api/v1/trails/personal').set('Authorization',`Bearer ${validatorToken}`)
      .set('Idempotency-Key','personal-disabled-api-1').send({text:'a relaxed beach trip'});
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('PERSONAL_TRAILS_DISABLED');
    expect((await fixture.pool.query("SELECT COUNT(*)::int AS count FROM trail_generations WHERE kind='personal' AND requested_by=$1", [userId])).rows[0].count).toBe(beforeGenerations.rows[0].count);
    expect((await fixture.pool.query("SELECT COUNT(*)::int AS count FROM governance_ledger WHERE actor_id=$1 AND reference_type='personal_generation'", [userId])).rows[0].count).toBe(beforeLedger.rows[0].count);
    await setPersonalGenerationEnabled(true);
  },45_000);

  test('creates a private owner trail and atomically charges 150 points for every tailored trail (no free allowance)', async () => {
    await setPersonalGenerationEnabled(true);
    const first = await request(app).post('/api/v1/trails/personal').set('Authorization',`Bearer ${token}`)
      .set('Idempotency-Key','personal-free-generation-1').send({ themes:['beach','heritage'], municipalities:['Bolinao'], budget_min:240, pace:'relaxed' });
    expect(first.status).toBe(201);
    expect(first.body.data.trail).toMatchObject({ tier:'personal',status:'published',source:'personal',owner_user_id:userId });
    expect(first.body.data.charged_points).toBe(150);
    // Traveler requests never wait on NIM: the template story is used directly.
    expect(first.body.data.trail.title).toMatch(/^Your .* trail/);
    expect(first.body.data.free_generation_remaining).toBe(0);
    expect(first.body.data.solution.stops.length).toBeGreaterThanOrEqual(2);
    const selectedMunicipalities = await fixture.pool.query(`SELECT DISTINCT p.municipality FROM trail_stops s JOIN spots p ON p.id=s.spot_id WHERE s.trail_id=$1`, [first.body.data.trail.id]);
    expect(selectedMunicipalities.rows.every((row: any) => row.municipality === 'Bolinao')).toBe(true);
    const catalog = await request(app).get('/api/v1/trails').set('Authorization',`Bearer ${token}`);
    expect(catalog.body.data.personal_generation).toMatchObject({free_remaining:0,price_points:150});
    expect(catalog.body.data.items.find((trail: any) => trail.id === first.body.data.trail.id).is_unlocked).toBe(true);

    const replay = await request(app).post('/api/v1/trails/personal').set('Authorization',`Bearer ${token}`)
      .set('Idempotency-Key','personal-free-generation-1').send({ themes:['beach','heritage'], municipalities:['Bolinao'], budget_min:240, pace:'relaxed' });
    expect(replay.status).toBe(201);
    expect(replay.body.data.replayed).toBe(true);
    expect(replay.body.data.trail.id).toBe(first.body.data.trail.id);

    const second = await request(app).post('/api/v1/trails/personal').set('Authorization',`Bearer ${token}`)
      .set('Idempotency-Key','personal-paid-generation-2').send({ themes:['beach'], municipalities:['Bolinao'], budget_min:240 });
    expect(second.status).toBe(201);
    expect(second.body.data.charged_points).toBe(150);
    // 1,000 - 150 (first) - 150 (second); the idempotent replay is not charged again.
    expect(Number((await fixture.pool.query('SELECT demo_points FROM users WHERE id=$1',[userId])).rows[0].demo_points)).toBe(700);
    const ledgerPair = await fixture.pool.query(`SELECT COUNT(*)::int AS rows,
      COUNT(*) FILTER (WHERE account=$1 AND amount_mjdq<0)::int AS traveler_debits,
      SUM(amount_mjdq)::bigint AS balanced
      FROM governance_ledger WHERE type='trail_generation_debit' AND reference_type='personal_generation' AND reference_id=$2`,
      [userId, second.body.data.trail.id]);
    expect(Number(ledgerPair.rows[0].rows)).toBe(2);
    expect(Number(ledgerPair.rows[0].traveler_debits)).toBe(1);
    expect(BigInt(ledgerPair.rows[0].balanced)).toBe(0n);
  }, 45_000);

  test('insufficient points rolls back the generated private trail and all debit ledger entries', async () => {
    await setPersonalGenerationEnabled(true);
    const response = await request(app).post('/api/v1/trails/personal').set('Authorization',`Bearer ${poorToken}`)
      .set('Idempotency-Key','personal-insufficient-points-1').send({ themes:['beach'], municipalities:['Bolinao'], budget_min:240 });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('INSUFFICIENT_POINTS');
    expect((await fixture.pool.query("SELECT 1 FROM trails WHERE owner_user_id='trail-personal-poor'")).rowCount).toBe(0);
    expect((await fixture.pool.query("SELECT 1 FROM governance_ledger WHERE reference_type='personal_generation' AND actor_id='trail-personal-poor'")).rowCount).toBe(0);
  }, 45_000);

  test('another traveler transfer proceeds while personal generation is waiting on its matrix provider', async () => {
    await setPersonalGenerationEnabled(true);
    await fixture.pool.query(`DELETE FROM travel_time_matrix WHERE from_spot IN (SELECT id FROM spots WHERE municipality='Bolinao')
      OR to_spot IN (SELECT id FROM spots WHERE municipality='Bolinao')`);
    await fixture.pool.query(`INSERT INTO points_accounts(id,kind,is_test,balance_points)
      VALUES('personal-transfer-sink','treasury',FALSE,0) ON CONFLICT(id) DO NOTHING`);
    let enterMatrix!: () => void;
    let releaseMatrix!: () => void;
    const matrixStarted = new Promise<void>(resolve => { enterMatrix = resolve; });
    const matrixGate = new Promise<void>(resolve => { releaseMatrix = resolve; });
    const generation = createPersonalTrail(fixture.pool, userId, 'personal-slow-matrix-1', {
      themes:['beach','heritage'], municipalities:['Bolinao'], budget_min:240,
    }, { matrixFetch: async (_input, init) => {
      enterMatrix();
      await matrixGate;
      const body = JSON.parse(String(init?.body)) as { sources: unknown[]; targets: unknown[] };
      return new Response(JSON.stringify({ sources_to_targets: body.sources.map((_source, i) => body.targets.map((_target, j) => ({
        time: i === j ? 0 : 60, distance: i === j ? 0 : 0.1,
      }))) }), { status:200 });
    } });
    try {
      await matrixStarted;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const transferCompleted = await Promise.race([
        fundingCommand(fixture.pool, 'trail-personal-transfer', 'review_lock_probe', 'review-lock-probe-1', {}, async tx => {
          await tx.transfer({ from:{id:'trail-personal-transfer',kind:'traveler',userId:'trail-personal-transfer'},
            to:{id:'personal-transfer-sink',kind:'treasury'}, points:1, type:'review_probe', referenceType:'test',
            referenceId:'personal-generation-lock-probe', actorId:'trail-personal-transfer' });
          return { transferred:true };
        }).then(() => true),
        new Promise<boolean>(resolve => { timeout = setTimeout(() => resolve(false), 1500); }),
      ]);
      if (timeout) clearTimeout(timeout);
      expect(transferCompleted).toBe(true);
    } finally {
      releaseMatrix();
    }
    const result = await generation;
    expect(result.trail.owner_user_id).toBe(userId);
  }, 45_000);

  test('validates input and does not allow anonymous generation', async () => {
    await setPersonalGenerationEnabled(true);
    expect((await request(app).post('/api/v1/trails/personal').send({ themes:['beach'] })).status).toBe(401);
    const unscoped = await request(app).post('/api/v1/trails/personal').set('Authorization',`Bearer ${validatorToken}`)
      .set('Idempotency-Key','personal-missing-area-1').send({ themes:['beach'] });
    expect(unscoped.status).toBe(400);
    expect(unscoped.body.error.code).toBe('AREA_REQUIRED');
    const invalid = await request(app).post('/api/v1/trails/personal').set('Authorization',`Bearer ${validatorToken}`)
      .set('Idempotency-Key','personal-invalid-1').send({ text:'x'.repeat(301) });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('VALIDATION_ERROR');
  });
});
