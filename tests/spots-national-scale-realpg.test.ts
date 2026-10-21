import { createTestDb } from '../src/db/testHarness';
import { applyMigrations } from '../src/db/pool';
import { listSpotsPage } from '../src/spots/query';

const realPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;

realPg('national destination scale (disposable real PostgreSQL only)', () => {
  it('applies provenance migration and serves a bounded 50k viewport with keyset pagination', async () => {
    const fixture = await createTestDb({ poolMax: 5 });
    try {
      const migration = await fixture.pool.query("SELECT 1 FROM schema_migrations WHERE filename='058_destination_provenance.sql'");
      expect(migration.rowCount).toBe(1);
      // Re-run only this additive migration in the isolated schema to exercise
      // its SQL-level idempotency, not merely the migration-ledger skip path.
      await fixture.pool.query("DELETE FROM schema_migrations WHERE filename='058_destination_provenance.sql'");
      await applyMigrations(fixture.pool);
      const reapplied = await fixture.pool.query("SELECT 1 FROM schema_migrations WHERE filename='058_destination_provenance.sql'");
      expect(reapplied.rowCount).toBe(1);
      await fixture.pool.query(`INSERT INTO spots
        (id,slug,name,description,category,subcategory,municipality,address,gps_lat,gps_lng,source_type,source_name,status,is_test,created_at)
        SELECT 'national-load-'||g, 'national-load-'||g, 'Synthetic load destination '||g, '', 'nature_outdoors','park','Load fixture','',
          15.5 + ((g % 100) * 0.001), 120.0 + ((g % 200) * 0.001), 'open_data','load-test','published',TRUE,
          NOW() - g * INTERVAL '1 second'
        FROM generate_series(1, 50000) AS g`);
      if (process.env.JDQ_SPOTS_EXPLAIN === 'true') {
        const plan = await fixture.pool.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT TEXT)
          SELECT s.id FROM spots s WHERE s.status='published'
            AND s.gps_lng BETWEEN 119 AND 122 AND s.gps_lat BETWEEN 15 AND 17
          ORDER BY s.created_at DESC,s.id DESC LIMIT 51`);
        console.log(`SPOTS_50K_EXPLAIN=${plan.rows.map((row) => row['QUERY PLAN']).join(' | ')}`);
      }
      const options = { bbox: [119, 15, 122, 17] as [number, number, number, number], allowTest: true, sort: 'newest' as const, limit: 50 };
      const durations: number[] = [];
      let first = await listSpotsPage(fixture.pool, options);
      expect(first.items).toHaveLength(50);
      expect(first.hasMore).toBe(true);
      expect(first.items.every((spot) => spot.is_test)).toBe(true);
      expect(first.items.every((spot) => !('field_sources' in spot))).toBe(true);
      const second = await listSpotsPage(fixture.pool, { ...options, cursor: first.nextCursor || undefined });
      expect(second.items).toHaveLength(50);
      expect(second.items.some((spot) => first.items.some((prior) => prior.id === spot.id))).toBe(false);
      for (let i = 0; i < 10; i++) {
        const start = performance.now();
        first = await listSpotsPage(fixture.pool, options);
        durations.push(performance.now() - start);
      }
      durations.sort((a, b) => a - b);
      const p95 = durations[Math.ceil(durations.length * 0.95) - 1];
      console.log(`SPOTS_50K_VIEWPORT_P95_MS=${p95.toFixed(2)}`);
      expect(p95).toBeLessThanOrEqual(200);
    } finally {
      await fixture.close();
    }
  }, 180_000);
});
