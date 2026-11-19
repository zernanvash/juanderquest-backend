// Plan 116 migrations 110-112 on real PostgreSQL 17 + PostGIS (the production engine).
// Runs only with JDQ_REAL_PG_URL (scripts/prod-db/run-realpg.sh).
import { createTestDb, type TestDbInstance } from '../src/db/testHarness.js';

const realPg = process.env.JDQ_REAL_PG_URL ? describe : describe.skip;

realPg('Plan 116 migrations (real PostgreSQL + PostGIS)', () => {
  let db: TestDbInstance;
  beforeAll(async () => {
    db = await createTestDb();
    const q = (sql: string, params: unknown[] = []) => db.pool.query(sql, params);
    await q(`INSERT INTO admin_areas (id, level, name, display_name, label_lat, label_lng, bbox, parent_id)
             VALUES ('region-ilocos', 'region', 'Ilocos Region', 'Ilocos Region', 16.0, 120.4, '{119.7,15.7,121.0,18.6}', NULL),
                    ('pangasinan', 'province', 'Pangasinan', 'Pangasinan', 15.9, 120.3, '{119.7,15.7,120.9,16.4}', 'region-ilocos'),
                    ('alaminos', 'town', 'Alaminos', 'Alaminos City', 16.15, 119.98, '{119.9,16.0,120.1,16.3}', 'pangasinan')`);
    await q(
      `UPDATE admin_areas SET geom = ST_Multi(ST_MakeEnvelope(119.9, 16.0, 120.1, 16.3, 4326)) WHERE id = 'alaminos'`,
    );
    const spot = (id: string, name: string, lat: number, lng: number) =>
      q(
        `INSERT INTO spots (id, slug, name, description, category, subcategory, municipality, address, gps_lat, gps_lng,
                            source_type, source_name, status, town_area_id, province_area_id)
         VALUES ($1::text, $1::text, $2, '', 'nature_outdoors', 'island', 'Alaminos', '', $3, $4, 'editorial', 'test', 'published', 'alaminos', 'pangasinan')`,
        [id, name, lat, lng],
      );
    await spot('hundred-islands', 'Hundred Islands National Park', 16.198, 119.993);
    await spot('las-pinas-church', 'Las Piñas Church', 16.16, 120.0);
  }, 120000);
  afterAll(async () => db?.close());

  it('accepts the region level and derives geography from gps_lat/gps_lng', async () => {
    const { rows } = await db.pool.query(
      `SELECT round(ST_Distance(geog, ST_SetSRID(ST_MakePoint(119.993, 16.198), 4326)::geography)) AS m FROM spots WHERE id = 'hundred-islands'`,
    );
    expect(Number(rows[0].m)).toBe(0);
    await db.pool.query(`UPDATE spots SET gps_lat = 16.2 WHERE id = 'hundred-islands'`);
    const moved = await db.pool.query(`SELECT ST_Y(geog::geometry) AS lat FROM spots WHERE id = 'hundred-islands'`);
    expect(Number(moved.rows[0].lat)).toBeCloseTo(16.2, 5);
  });

  it('finds spots by accent-insensitive full text and trigram', async () => {
    const fts = await db.pool.query(
      `SELECT id FROM spots WHERE search_tsv @@ plainto_tsquery('simple', f_unaccent('las pinas'))`,
    );
    expect(fts.rows.map((r) => r.id)).toEqual(['las-pinas-church']);
    const trgm = await db.pool.query(
      `SELECT id FROM spots WHERE f_unaccent(lower(name)) % f_unaccent(lower('hundred islnds')) ORDER BY id`,
    );
    expect(trgm.rows.map((r) => r.id)).toContain('hundred-islands');
  });

  it('matches a point to its town polygon with the spatial index', async () => {
    const { rows } = await db.pool.query(
      `SELECT id FROM admin_areas WHERE level = 'town' AND ST_Covers(geom, ST_SetSRID(ST_MakePoint(119.99, 16.19), 4326))`,
    );
    expect(rows.map((r) => r.id)).toEqual(['alaminos']);
  });

  it('keeps OSM / Wikidata references unique', async () => {
    await db.pool.query(
      `UPDATE spots SET external_refs = '{"osm":"node/1","wikidata":"Q1"}' WHERE id = 'hundred-islands'`,
    );
    await expect(
      db.pool.query(`UPDATE spots SET external_refs = '{"osm":"node/1"}' WHERE id = 'las-pinas-church'`),
    ).rejects.toThrow(/uq_spots_osm_ref/);
  });

  it('rejects scraped photos without a commercial-use licence or credit', async () => {
    const insert = (id: string, license: string | null, author: string | null, source = 'commons') =>
      db.pool.query(
        `INSERT INTO spot_assets (id, user_id, storage_provider, object_key, url, mime_type, status, spot_id,
                                  source, source_id, license, author, attribution_url)
         VALUES ($1::text, NULL, 'r2', $1::text, 'https://media.example/' || $1::text, 'image/webp', 'attached', 'hundred-islands',
                 $2, $1::text, $3, $4, 'https://commons.wikimedia.org/wiki/File:' || $1::text)`,
        [id, source, license, author],
      );
    await insert('ok-bysa', 'CC BY-SA 4.0', 'Jane Photographer');
    await insert('ok-cc0', 'CC0', 'Anon');
    await expect(insert('bad-nc', 'CC BY-NC 4.0', 'X')).rejects.toThrow(/chk_spot_assets_third_party_license/);
    await expect(insert('bad-nd', 'CC BY-ND 2.0', 'X')).rejects.toThrow(/chk_spot_assets_third_party_license/);
    await expect(insert('bad-author', 'CC BY 4.0', null)).rejects.toThrow(/chk_spot_assets_third_party_license/);
    await expect(insert('bad-uploader', null, null, 'traveller')).rejects.toThrow(/chk_spot_assets_uploader/);
  });

  it('leaves no NOT VALID constraints behind (112)', async () => {
    const { rows } = await db.pool.query(
      `SELECT count(*)::int AS n FROM pg_constraint WHERE connamespace = current_schema()::regnamespace AND NOT convalidated`,
    );
    expect(rows[0].n).toBe(0);
  });
});
