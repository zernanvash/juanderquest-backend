import { performance } from 'node:perf_hooks';
import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';
import type { Pool, PoolClient } from 'pg';
import { generateTrail } from '../src/trails/generate.js';
import type { MatrixFetch } from '../src/trails/matrix.js';
import { loadTrailSignalInputs } from '../src/trails/signals.js';

const describeRealPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;
const SPOT_COUNT = 50_000;

describeRealPg('Trail Engine national bounded generation (isolated real PostgreSQL)', () => {
  let fixture: TestDbInstance;

  beforeAll(async () => {
    fixture = await createTestDb({ poolMax: 8 });
    await fixture.pool.query(`INSERT INTO admin_areas
      (id,level,name,display_name,label_lat,label_lng,bbox,has_boundary)
      VALUES ('trail-national-province','province','National Test Province','National Test Province',16,120,ARRAY[119,15,121,17],FALSE)`);
    await fixture.pool.query(`INSERT INTO admin_areas
      (id,level,name,display_name,parent_id,label_lat,label_lng,bbox,has_boundary)
      VALUES ('trail-national-town','town','National Test Town','National Test Town, National Test Province',
        'trail-national-province',16,120,ARRAY[119,15,121,17],FALSE)`);
    await fixture.pool.query(`INSERT INTO spots
      (id,slug,name,description,category,subcategory,municipality,address,gps_lat,gps_lng,source_type,source_name,status,is_test,town_area_id)
      SELECT 'national-spot-'||i,'national-spot-'||i,'National Place '||i,
        'A well-described public destination with a verified location and visitor information.',
        'category-'||i,
        (ARRAY['coast','culture','culinary','outdoors'])[(i-1)%4+1],
        'National Test Town','National Test Town, National Test Province',
        16.0+(i%1000)*0.00001,120.0+(i%1000)*0.00001,'editorial','Synthetic scale fixture','published',FALSE,
        'trail-national-town'
      FROM generate_series(1,$1::int) i`, [SPOT_COUNT]);
  }, 120_000);

  afterAll(async () => { if (fixture) await fixture.close(); }, 30_000);

  test('50,000 in-area spots produce at most 60 candidate nodes and 3,600 directed matrix pairs', async () => {
    const fixtureCount = await fixture.pool.query(`SELECT COUNT(*)::int AS count FROM spots
      WHERE town_area_id='trail-national-town' AND status='published' AND COALESCE(is_test,FALSE)=FALSE
        AND gps_lat IS NOT NULL AND gps_lng IS NOT NULL`);
    expect(fixtureCount.rows[0].count).toBe(SPOT_COUNT);
    const descendants = await fixture.pool.query(`WITH RECURSIVE scope(id) AS (
      SELECT id FROM admin_areas WHERE id='trail-national-town'
      UNION ALL SELECT child.id FROM admin_areas child JOIN scope parent ON child.parent_id=parent.id
    ) SELECT COUNT(*)::int AS count FROM spots WHERE town_area_id IN (SELECT id FROM scope)`);
    expect(descendants.rows[0].count).toBe(SPOT_COUNT);
    const scopedInputs = await loadTrailSignalInputs(fixture.pool, undefined, { areaId: 'trail-national-town' });
    expect(scopedInputs).toHaveLength(SPOT_COUNT);
    const transactionClient = await fixture.pool.connect();
    try {
      await transactionClient.query('BEGIN');
      const transactionInputs = await loadTrailSignalInputs(transactionClient, undefined, { areaId: 'trail-national-town' });
      expect(transactionInputs).toHaveLength(SPOT_COUNT);
    } finally {
      await transactionClient.query('ROLLBACK');
      transactionClient.release();
    }
    let observedMatrixNodes = 0;
    const matrixFetch: MatrixFetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { sources: unknown[]; targets: unknown[] };
      observedMatrixNodes = body.sources.length;
      return new Response(JSON.stringify({
        sources_to_targets: body.sources.map((_source, from) => body.targets.map((_target, to) => ({
          time: from === to ? 0 : 60,
          distance: from === to ? 0 : 0.1,
        }))),
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const queryDurations: Array<{ ms: number; sql: string }> = [];
    const stages: Record<string, number> = {};
    // Generation uses both pool.query and independent checked-out clients.
    // Bind calls to the real target to avoid counting pool-internal queries twice.
    function instrument<T extends Pool | PoolClient>(connection: T): T {
      return new Proxy(connection, {
        get(target, property) {
          if (property === 'query') return async (...args: unknown[]) => {
            const queryStartedAt = performance.now();
            try { return await (target.query as (...queryArgs: unknown[]) => Promise<unknown>)(...args); }
            finally { queryDurations.push({ ms: performance.now() - queryStartedAt, sql: String(args[0]).replace(/\s+/g, ' ').trim().slice(0, 120) }); }
          };
          if (property === 'connect') return async () => instrument(await (target as Pool).connect());
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    }
    const instrumentedPool = instrument(fixture.pool);
    const startedAt = performance.now();
    const generated = await generateTrail(instrumentedPool, {
      kind: 'admin', areaId: 'trail-national-town', theme: 'National Scale', seed: 20261025,
      budgetMin: 240, minStops: 3, maxStops: 6, maxLegMin: 60, maxPerCategory: 2,
      matrixFetch,
    }, { onTiming: (stage, ms) => { stages[stage] = (stages[stage] ?? 0) + ms; } });
    const elapsedMs = performance.now() - startedAt;
    const persisted = await fixture.pool.query(`SELECT input FROM trail_generations WHERE id=$1`, [generated.generation.id]);
    const input = persisted.rows[0].input as { area_id: string; candidate_count: number; matrix_pairs: number };

    const sqlMs = queryDurations.reduce((sum, query) => sum + query.ms, 0);
    console.info(`[trail-national-scale] generation_ms=${elapsedMs.toFixed(1)} sql_ms=${sqlMs.toFixed(1)} stages_ms=${JSON.stringify(stages)} candidates=${input.candidate_count} matrix_nodes=${observedMatrixNodes} matrix_pairs=${input.matrix_pairs} query_top=${JSON.stringify(queryDurations.sort((a, b) => b.ms - a.ms).slice(0, 6))}`);
    expect(queryDurations.some(query => query.sql.startsWith('WITH RECURSIVE area_scope'))).toBe(true);
    expect(queryDurations.some(query => query.sql.startsWith('INSERT INTO travel_time_matrix'))).toBe(true);
    expect(input.area_id).toBe('trail-national-town');
    expect(input.candidate_count).toBeLessThanOrEqual(60);
    expect(input.matrix_pairs).toBeLessThanOrEqual(60 * 60);
    expect(observedMatrixNodes).toBeLessThanOrEqual(60);
    expect(input.matrix_pairs).toBe(observedMatrixNodes * observedMatrixNodes);
    expect(generated.solution.feasible).toBe(true);
    expect(generated.solution.stops.length).toBeGreaterThanOrEqual(3);
    // Owner 2026-10-28: generation is admin/weekly only (personal trails off), so 5 s on the shared laptop.
    expect(elapsedMs).toBeLessThan(5_000);
  }, 120_000);
});
