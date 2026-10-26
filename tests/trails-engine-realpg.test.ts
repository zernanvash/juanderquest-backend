import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDb } from '../src/db/testHarness.js';
import { generateTrail, TrailGenerationError } from '../src/trails/generate.js';
import { applyMigrations, MIGRATIONS } from '../src/db/migrations.js';

const describeRealPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;
const curatedIds = ['coastal_wonders_trail','pangasinan_heritage_trail','pangasinan_eco_escapes','pangasinan_culinary_trail'];

describeRealPg('Plan 44 real PostgreSQL acceptance (isolated reliability schema)', () => {
  let instance: Awaited<ReturnType<typeof createTestDb>>;
  beforeAll(async () => { instance = await createTestDb(); }, 120_000);
  afterAll(async () => { if (instance) await instance.close(); }, 30_000);

  test('055 migrates from the registered 053 baseline, upgrades curated ids and ordered stops idempotently', async () => {
    expect(MIGRATIONS.indexOf('053_plaza_push.sql')).toBeLessThan(MIGRATIONS.indexOf('054_quest_builder.sql'));
    expect(MIGRATIONS.indexOf('054_quest_builder.sql')).toBeLessThan(MIGRATIONS.indexOf('055_trail_engine.sql'));
    expect(MIGRATIONS.indexOf('055_trail_engine.sql')).toBeLessThan(MIGRATIONS.indexOf('056_admin_areas.sql'));
    {
      expect((await instance.pool.query(`SELECT 1 FROM schema_migrations WHERE filename='055_trail_engine.sql'`)).rowCount).toBe(1);
      const { rows: spots } = await instance.pool.query(`SELECT id FROM spots WHERE COALESCE(is_test,FALSE)=FALSE ORDER BY id LIMIT 6`);
      expect(spots.length).toBeGreaterThanOrEqual(4);
      for (let i=0;i<curatedIds.length;i++) {
        await instance.pool.query(`INSERT INTO curated_collections(id,title,description,category,badge_id,is_active)
          VALUES ($1,$2,'Migration fixture description','trail',NULL,TRUE) ON CONFLICT(id) DO UPDATE SET is_active=TRUE`, [curatedIds[i],`Curated ${i+1}`]);
        const count = i===0 ? 3 : 2;
        for (let p=0;p<count;p++) await instance.pool.query(`INSERT INTO curated_collection_spots(collection_id,spot_id,order_index)
          VALUES ($1,$2,$3) ON CONFLICT(collection_id,spot_id) DO UPDATE SET order_index=EXCLUDED.order_index`, [curatedIds[i],spots[(i+p)%spots.length].id,p]);
      }
      const migration = readFileSync(join(process.cwd(),'migrations','055_trail_engine.sql'),'utf8');
      await instance.pool.query(migration);
      const first = await instance.pool.query(`SELECT t.id,t.status,t.tier,t.source,t.total_minutes,t.total_km,
        ts.position,ts.spot_id,ts.dwell_min,ts.arrive_offset_min,ts.leg_minutes,ts.leg_km
        FROM trails t LEFT JOIN trail_stops ts ON ts.trail_id=t.id WHERE t.id=ANY($1::text[]) ORDER BY t.id,ts.position`, [curatedIds]);
      await instance.pool.query(migration);
      const second = await instance.pool.query(`SELECT t.id,t.status,t.tier,t.source,t.total_minutes,t.total_km,
        ts.position,ts.spot_id,ts.dwell_min,ts.arrive_offset_min,ts.leg_minutes,ts.leg_km
        FROM trails t LEFT JOIN trail_stops ts ON ts.trail_id=t.id WHERE t.id=ANY($1::text[]) ORDER BY t.id,ts.position`, [curatedIds]);
      expect(first.rows).toEqual(second.rows);
      expect(new Set(second.rows.map(r=>r.id))).toEqual(new Set(curatedIds));
      for (const id of curatedIds) {
        const route = second.rows.filter(r=>r.id===id);
        expect(route[0]).toMatchObject({status:'published',tier:'starter',source:'curated',position:1,dwell_min:45});
        expect(route.map(r=>Number(r.position))).toEqual(route.map((_r,i)=>i+1));
        expect(Number(route[0].total_minutes)).toBeGreaterThanOrEqual(route.length * 45);
        expect(route.every(r => Number(r.arrive_offset_min) >= 0 && Number(r.leg_minutes) >= 0 && Number(r.leg_km) >= 0)).toBe(true);
        expect(Number(route[0].total_minutes)).not.toBe(1);
        expect(Number(route[0].total_km)).toBeCloseTo(route.reduce((sum, row) => sum + Number(row.leg_km), 0), 1);
      }
    }
  }, 120_000);

  test('applies 055 on boot when the database already has later migrations recorded', async () => {
    const laterFiles = MIGRATIONS.slice(MIGRATIONS.indexOf('055_trail_engine.sql') + 1);
    const { rows: before } = await instance.pool.query(
      `SELECT filename FROM schema_migrations WHERE filename = ANY($1::text[]) ORDER BY filename`, [laterFiles],
    );
    expect(before.map((row) => row.filename)).toEqual([...laterFiles].sort());

    await instance.pool.query(`DROP TABLE trail_checkins, trail_completions, trail_unlocks, travel_time_matrix,
      trail_stops, trails, trail_generations, trend_digests, ai_cache CASCADE`);
    await instance.pool.query(`DELETE FROM schema_migrations WHERE filename='055_trail_engine.sql'`);

    await expect(applyMigrations(instance.pool)).resolves.toBeUndefined();

    const applied = await instance.pool.query(
      `SELECT filename FROM schema_migrations WHERE filename='055_trail_engine.sql'`,
    );
    expect(applied.rowCount).toBe(1);
    const { rows: curated } = await instance.pool.query(
      `SELECT t.id,t.status,t.tier,t.source,ts.position,ts.spot_id FROM trails t
       LEFT JOIN trail_stops ts ON ts.trail_id=t.id
       WHERE t.id=ANY($1::text[]) ORDER BY t.id,ts.position`, [curatedIds],
    );
    expect(new Set(curated.map((row) => row.id))).toEqual(new Set(curatedIds));
    for (const id of curatedIds) {
      const stops = curated.filter((row) => row.id === id);
      expect(stops[0]).toMatchObject({ status: 'published', tier: 'starter', source: 'curated' });
      expect(stops.map((row) => Number(row.position))).toEqual(stops.map((_row, index) => index + 1));
    }
    const { rows: laterAfter } = await instance.pool.query(
      `SELECT filename FROM schema_migrations WHERE filename = ANY($1::text[]) ORDER BY filename`, [laterFiles],
    );
    expect(laterAfter).toEqual(before);
  }, 120_000);

  test('generation has NO_FEASIBLE_TRAIL and a forced mid-write failure leaves all three tables unchanged', async () => {
    {
      const available = ['trail-realpg-a','trail-realpg-b','trail-realpg-c','trail-realpg-d'];
      await instance.pool.query(`INSERT INTO spots
        (id,slug,name,description,category,subcategory,municipality,address,gps_lat,gps_lng,source_type,source_name,status,is_test)
        VALUES ('trail-realpg-a','trail-realpg-a','Trail Test A','A test beach.','beach','coast','Test Town','Test Town',16,120,'editorial','fixture','published',FALSE),
               ('trail-realpg-b','trail-realpg-b','Trail Test B','A test landmark.','heritage','culture','Test Town','Test Town',16.001,120.001,'editorial','fixture','published',FALSE),
               ('trail-realpg-c','trail-realpg-c','Trail Test C','A test food stop.','food','cafe','Test Town','Test Town',16.002,120.002,'editorial','fixture','published',FALSE),
               ('trail-realpg-d','trail-realpg-d','Trail Test D','A test nature stop.','nature','outdoors','Test Town','Test Town',16.003,120.003,'editorial','fixture','published',FALSE)`);
      const { rows: beforeRows } = await instance.pool.query(`SELECT
        (SELECT count(*)::int FROM trails) trails,
        (SELECT count(*)::int FROM trail_stops) stops,
        (SELECT count(*)::int FROM trail_generations) generations`);
      const { rows: spotRows } = await instance.pool.query(`SELECT id FROM spots WHERE status='published' AND COALESCE(is_test,FALSE)=FALSE ORDER BY id`);
      const allSpotIds = spotRows.map(row => String(row.id));
      await expect(generateTrail(instance.pool,{kind:'admin',theme:'impossible',minStops:12,maxStops:12,budgetMin:60,maxLegMin:15,maxPerCategory:1,exclude:allSpotIds})).rejects.toBeInstanceOf(TrailGenerationError);
      const originalConnect=instance.pool.connect.bind(instance.pool);
      const proxyPool={connect:async()=>{
        const client=await originalConnect();
        const query=client.query.bind(client);
        let injected=false;
        return {query:((sql:any,values?:any[])=>{
          if(!injected && typeof sql==='string' && sql.includes('INSERT INTO trail_stops')) { injected=true; return Promise.reject(new Error('injected trail stop failure')); }
          return query(sql,values);
        }) as typeof client.query, release:()=>client.release()};
      }};
      const matrixFetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { sources: unknown[]; targets: unknown[] };
        return new Response(JSON.stringify({ sources_to_targets: body.sources.map((_source, i) => body.targets.map((_target, j) => ({ time: i === j ? 0 : 60, distance: i === j ? 0 : 0.1 }))) }), { status: 200 });
      };
      await expect(generateTrail(proxyPool as any,{kind:'admin',theme:'transaction rollback',minStops:2,maxStops:4,budgetMin:600,maxLegMin:180,maxPerCategory:6,seed:11,matrixFetch,exclude:allSpotIds.filter(id=>!available.includes(id))})).rejects.toThrow('injected trail stop failure');
      const { rows: afterRows } = await instance.pool.query(`SELECT
        (SELECT count(*)::int FROM trails) trails,
        (SELECT count(*)::int FROM trail_stops) stops,
        (SELECT count(*)::int FROM trail_generations) generations`);
      expect(afterRows).toEqual(beforeRows);
    }
  }, 120_000);
});
