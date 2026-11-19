// Plan 116: the pg-mem side of migrations 110-112 (PGMEM_SKIP sections stripped) must
// apply on a minimal schema, so in-memory unit tests keep the new plain columns/tables.
// Real-PostgreSQL behaviour is covered by plan116-migrations-realpg.test.ts.
import { readFileSync } from 'fs';
import { join } from 'path';
import { newDb } from 'pg-mem';

const strip = (file: string) =>
  readFileSync(join(__dirname, '..', 'migrations', file), 'utf8').replace(
    /--\s*PGMEM_SKIP_BEGIN[\s\S]*?--\s*PGMEM_SKIP_END/g,
    '',
  );

describe('Plan 116 migrations on pg-mem', () => {
  it('applies the plain sections of 110, 111 and 112', () => {
    const db = newDb();
    db.public.none(`
      CREATE TABLE users (id TEXT PRIMARY KEY, favorite_spot_id TEXT);
      CREATE TABLE admin_areas (id TEXT PRIMARY KEY, level TEXT NOT NULL CHECK (level IN ('province','town','barangay')),
        parent_id TEXT, min_zoom SMALLINT NOT NULL DEFAULT 9);
      CREATE TABLE spots (id TEXT PRIMARY KEY, name TEXT, status TEXT, is_test BOOLEAN NOT NULL DEFAULT FALSE,
        town_area_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
      CREATE TABLE spot_assets (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), spot_id TEXT);
      CREATE TABLE push_deliveries (id TEXT PRIMARY KEY, notification_id TEXT);
      CREATE TABLE merchants (id TEXT PRIMARY KEY, spot_id TEXT);
      CREATE TABLE spot_photo_submissions (id TEXT PRIMARY KEY, spot_id TEXT, asset_id TEXT);
      CREATE TABLE spot_reports (id TEXT PRIMARY KEY, user_id TEXT);
      CREATE TABLE avatar_reports (id TEXT PRIMARY KEY, user_id TEXT, reporter_id TEXT);
      CREATE TABLE bug_reports (id TEXT PRIMARY KEY, user_id TEXT);
      CREATE TABLE economic_activity_scopes (id TEXT PRIMARY KEY, destination_spot_id TEXT);
      CREATE TABLE juanchoice_supporter_quest_claims (id TEXT PRIMARY KEY, spot_id TEXT, quest_id TEXT);
      CREATE TABLE trails (id TEXT PRIMARY KEY, generation_id TEXT);
      CREATE TABLE trail_checkins (id TEXT PRIMARY KEY, trail_id TEXT, position INT);
      CREATE TABLE suki_visits (id TEXT PRIMARY KEY, program_id TEXT);
      CREATE TABLE suki_rewards (id TEXT PRIMARY KEY, program_id TEXT);
      CREATE TABLE verified_visits (id TEXT PRIMARY KEY, binding_id TEXT);
      CREATE TABLE question_of_the_day (id TEXT PRIMARY KEY, question_id TEXT);
      CREATE TABLE quest_sponsorships (id TEXT PRIMARY KEY, voucher_id TEXT);
      CREATE TABLE quest_funding_contributions (id TEXT PRIMARY KEY, sponsorship_id TEXT);
    `);
    for (const file of ['110_geo_search_provenance.sql', '111_spot_photo_licensing.sql', '112_perf_hygiene.sql']) {
      db.public.none(strip(file));
    }
    // The 'region' level is checked on real PostgreSQL: pg-mem auto-names inline CHECKs
    // (admin_areas_constraint_1), so the named DROP/ADD cannot replace it here.
    db.public.none(`INSERT INTO spots (id, name, status) VALUES ('s0', 'Hundred Islands', 'published')`);
    db.public.none(`INSERT INTO spot_provenance (spot_id, import_confidence) VALUES ('s0', 0.9)`);
    expect(() => db.public.none(`INSERT INTO spot_provenance (spot_id) VALUES ('missing')`)).toThrow();
    db.public.none(`INSERT INTO spot_assets (id, user_id, spot_id, source, source_id, license, author, attribution_url)
                    VALUES ('a1', NULL, NULL, 'commons', 'File:A.jpg', 'CC BY-SA 4.0', 'Someone', 'https://commons.wikimedia.org/wiki/File:A.jpg')`);
    expect(() => db.public.none(`INSERT INTO spot_assets (id, user_id) VALUES ('a2', NULL)`)).toThrow();
    db.public.none(`UPDATE spots SET launch_tier = 'featured', external_refs = '{"wikidata":"Q1"}' WHERE id = 's0'`);
    expect(() => db.public.none(`UPDATE spots SET launch_tier = 'gold'`)).toThrow();
    expect(() => db.public.none(`INSERT INTO spots (id, launch_tier) VALUES ('s1', 'gold')`)).toThrow();
  });
});
