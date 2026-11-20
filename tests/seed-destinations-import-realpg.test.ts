import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';
import { runImport, type ImportOptions } from '../scripts/seed/destinations/import-destinations.js';
import type { CatalogueRow } from '../scripts/seed/destinations/lib/catalogue.js';

// Plan 116 destinations importer against real PostgreSQL + PostGIS (scripts/prod-db/run-realpg.sh).
const realPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;

const row = (o: Partial<CatalogueRow> & { id: string; name: string; lat: number; lng: number }): CatalogueRow => ({
  slug_base: o.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  refs: { osm: `node/${o.id.replace(/\D/g, '')}` },
  description: '',
  category: 'nature_outdoors',
  subcategory: 'beach',
  tags: ['beach'],
  source_name: 'OpenStreetMap',
  source_url: 'https://www.openstreetmap.org/node/1',
  hints: { island_group: 'luzon', island_group_source: 'coordinates' },
  confidence: 0.85,
  confidence_reasons: [],
  computed_tier: 'featured',
  tier_reasons: [],
  launch_score: 1,
  heritage: [],
  photo_candidates: [],
  field_sources: { name: { source: 'openstreetmap' }, photo_candidates: [] },
  osm_tags: { natural: 'beach' },
  inputs: ['osm-candidates'],
  ...o,
});

realPg('national destinations import (real PG)', () => {
  let db: TestDbInstance;
  const opts = (rows: CatalogueRow[], apply: boolean): ImportOptions => ({
    wave: 'test-wave',
    apply,
    reassignOnly: false,
    areasComplete: false,
    rows,
  });
  const rows = [
    row({ id: 'osm-n9001', name: 'Testa White Beach', lat: 16.0005, lng: 120.0005 }), // near the protected spot
    row({ id: 'osm-n9002', name: 'Inside Town Falls', lat: 16.02, lng: 120.02, subcategory: 'waterfall' }),
    row({ id: 'osm-n9003', name: 'Far Away Peak', lat: 9.5, lng: 125.5, computed_tier: 'review', confidence: 0.1 }),
    row({ id: 'wd-q9004', name: 'Wikidata Only Park', lat: 9.6, lng: 125.6, refs: { wikidata: 'Q9004' } }),
  ];

  beforeAll(async () => {
    db = await createTestDb({ poolMax: 2 });
    const square = (x: number, y: number, d: number) =>
      JSON.stringify({
        type: 'Polygon',
        coordinates: [
          [
            [x, y],
            [x + d, y],
            [x + d, y + d],
            [x, y + d],
            [x, y],
          ],
        ],
      });
    await db.pool.query(
      `INSERT INTO admin_areas (id, psgc_code, level, name, display_name, parent_id, min_zoom, label_lat, label_lng, bbox, geom) VALUES
         ('testprov', 199000000, 'province', 'Testprov', 'Testprov', NULL, 7, 0, 0, '{0,0,0,0}', ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326))),
         ('testtown', 199001000, 'town', 'Testtown', 'Testtown', 'testprov', 9, 0, 0, '{0,0,0,0}', ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($2), 4326)))`,
      [square(119.9, 15.9, 0.3), square(119.95, 15.95, 0.1)],
    );
    await db.pool.query(
      `INSERT INTO spots (id, slug, name, description, category, subcategory, municipality, address, gps_lat, gps_lng,
                          source_type, source_name, trust_level, status)
       VALUES ('spot-testa', 'testa-beach', 'Testa Beach', 'Editorial text', 'nature_outdoors', 'beach', 'Testtown', '',
               16.0, 120.0, 'editorial', 'JuanderQuest', 'editorial', 'published')`,
    );
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  it('dry-run changes nothing but records a seed run', async () => {
    const client = await db.pool.connect();
    try {
      const stats = await runImport(client, opts(rows, false));
      expect(stats.inserted).toBe(3);
      expect(stats.merged_into_existing.map((m) => m.spot_id)).toEqual(['spot-testa']);
      const { rows: n } = await client.query(
        `SELECT count(*)::int n FROM spots WHERE id LIKE 'osm-n9%' OR id LIKE 'wd-q9%'`,
      );
      expect(n[0].n).toBe(0);
      const { rows: runs } = await client.query(`SELECT mode FROM seed_runs`);
      expect(runs).toEqual([{ mode: 'dry-run' }]);
    } finally {
      client.release();
    }
  }, 120_000);

  it('applies, protects existing spots, assigns areas and tiers, and is idempotent', async () => {
    const client = await db.pool.connect();
    try {
      const first = await runImport(client, opts(rows, true));
      expect(first.inserted).toBe(3);
      expect(first.existing_refs_merged).toBe(1);
      const { rows: spots } = await client.query(
        `SELECT id, name, description, status, launch_tier, town_area_id, province_area_id, external_refs, source_type
           FROM spots WHERE id IN ('spot-testa', 'osm-n9002', 'osm-n9003', 'wd-q9004') ORDER BY id`,
      );
      const by = Object.fromEntries(spots.map((s) => [s.id, s]));
      expect(by['spot-testa']).toMatchObject({
        name: 'Testa Beach',
        description: 'Editorial text',
        source_type: 'editorial',
        launch_tier: null,
        external_refs: { osm: 'node/9001' },
      });
      expect(by['osm-n9002']).toMatchObject({
        status: 'published',
        launch_tier: 'featured',
        town_area_id: 'testtown',
        province_area_id: 'testprov',
        source_type: 'open_data',
      });
      expect(by['osm-n9003']).toMatchObject({ status: 'needs_review', launch_tier: 'review', town_area_id: null });
      // No areas loaded there yet: featured is capped at standard until --reassign-areas.
      expect(by['wd-q9004']).toMatchObject({
        status: 'published',
        launch_tier: 'standard',
        external_refs: { wikidata: 'Q9004' },
      });

      const second = await runImport(client, opts(rows, true));
      expect(second).toMatchObject({
        inserted: 0,
        updated_imported: 0,
        existing_refs_merged: 0,
        provenance_changed: 0,
        area_changes: 0,
        tier_changes: 0,
      });
      expect(second.matched_by_ref.osm).toBe(3);
    } finally {
      client.release();
    }
  }, 120_000);

  it('does not overwrite reviewed imported spots, and reassigns areas later', async () => {
    const client = await db.pool.connect();
    try {
      await client.query(`UPDATE spots SET name = 'Admin Fixed', reviewed_at = now() WHERE id = 'osm-n9002'`);
      await runImport(client, opts(rows, true));
      const { rows: r } = await client.query(`SELECT name FROM spots WHERE id = 'osm-n9002'`);
      expect(r[0].name).toBe('Admin Fixed');

      const square = JSON.stringify({
        type: 'Polygon',
        coordinates: [
          [
            [125.5, 9.5],
            [125.7, 9.5],
            [125.7, 9.7],
            [125.5, 9.7],
            [125.5, 9.5],
          ],
        ],
      });
      await client.query(
        `INSERT INTO admin_areas (id, psgc_code, level, name, display_name, parent_id, min_zoom, label_lat, label_lng, bbox, geom)
         VALUES ('farprov', 1699000000, 'province', 'Farprov', 'Farprov', NULL, 7, 0, 0, '{0,0,0,0}', ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326))),
                ('fartown', 1699001000, 'town', 'Fartown', 'Fartown', 'farprov', 9, 0, 0, '{0,0,0,0}', ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)))`,
        [square],
      );
      const re = await runImport(client, { ...opts([], true), reassignOnly: true });
      expect(re.area_changes).toBe(2);
      const { rows: w } = await client.query(
        `SELECT launch_tier, town_area_id, municipality FROM spots WHERE id = 'wd-q9004'`,
      );
      expect(w[0]).toEqual({ launch_tier: 'featured', town_area_id: 'fartown', municipality: 'Fartown' });
    } finally {
      client.release();
    }
  }, 120_000);
});
