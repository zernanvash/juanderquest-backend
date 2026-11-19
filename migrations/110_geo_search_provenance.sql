-- Migration 110 (Plan 116): national-scale geography, search and provenance.
-- Additive. Requires PostGIS, pg_trgm and unaccent to be installed beforehand by the
-- superuser (scripts/prod-db/bootstrap.sh puts them in the `extensions` schema and on
-- the database search_path). Replaces void migrations 058/094 (Plan 46).
-- Sections between PGMEM_SKIP markers are PostgreSQL-only; the pg-mem unit-test
-- adapter strips them and keeps the plain columns/tables.

-- PGMEM_SKIP_BEGIN
DO $$
DECLARE missing TEXT;
BEGIN
  SELECT string_agg(name, ', ') INTO missing
    FROM unnest(ARRAY['postgis','pg_trgm','unaccent']) AS name
   WHERE NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = name);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Migration 110 needs extension(s) %. Install them as superuser first (see scripts/prod-db/README.md).', missing;
  END IF;
END $$;

-- Immutable unaccent wrapper usable in generated columns and index expressions. The
-- dictionary is schema-qualified with wherever the extension actually lives.
DO $$
DECLARE nsp TEXT;
BEGIN
  SELECT n.nspname INTO nsp FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'unaccent';
  EXECUTE format(
    'CREATE OR REPLACE FUNCTION f_unaccent(text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS %L',
    format('SELECT %I.unaccent(%L::regdictionary, $1)', nsp, nsp || '.unaccent'));
END $$;
-- PGMEM_SKIP_END

-- ---------------------------------------------------------------- admin areas
-- Region level (the national import adds regions above provinces).
ALTER TABLE admin_areas DROP CONSTRAINT IF EXISTS admin_areas_level_check;
ALTER TABLE admin_areas ADD CONSTRAINT admin_areas_level_check
  CHECK (level IN ('region', 'province', 'town', 'barangay'));
CREATE INDEX IF NOT EXISTS idx_admin_areas_level_zoom ON admin_areas (level, min_zoom);

-- PGMEM_SKIP_BEGIN
ALTER TABLE admin_areas ADD COLUMN IF NOT EXISTS geom geometry(MultiPolygon, 4326);
CREATE INDEX IF NOT EXISTS idx_admin_areas_geom ON admin_areas USING gist (geom);
-- Backfill from the 057 simplified GeoJSON (bare Polygon/MultiPolygon geometries).
UPDATE admin_areas
   SET geom = ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(boundary::text), 4326)), 3))
 WHERE boundary IS NOT NULL AND geom IS NULL;
-- PGMEM_SKIP_END

-- ---------------------------------------------------------------------- spots
ALTER TABLE spots ADD COLUMN IF NOT EXISTS province_area_id TEXT REFERENCES admin_areas(id);
ALTER TABLE spots ADD COLUMN IF NOT EXISTS region_area_id TEXT REFERENCES admin_areas(id);
ALTER TABLE spots ADD COLUMN IF NOT EXISTS launch_tier TEXT;
ALTER TABLE spots DROP CONSTRAINT IF EXISTS chk_spots_launch_tier;
ALTER TABLE spots ADD CONSTRAINT chk_spots_launch_tier
  CHECK (launch_tier IS NULL OR launch_tier IN ('featured', 'standard', 'review'));
ALTER TABLE spots ADD COLUMN IF NOT EXISTS external_refs JSONB NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS idx_spots_keyset ON spots (created_at, id);
CREATE INDEX IF NOT EXISTS idx_spots_province_area ON spots (province_area_id);
CREATE INDEX IF NOT EXISTS idx_spots_region_area ON spots (region_area_id);

-- PGMEM_SKIP_BEGIN
-- Province for existing spots = parent of their town (pg-mem has no UPDATE ... FROM).
UPDATE spots s SET province_area_id = t.parent_id
  FROM admin_areas t
 WHERE t.id = s.town_area_id AND t.level = 'town' AND s.province_area_id IS NULL;

-- Derived point; the application keeps writing gps_lat/gps_lng.
ALTER TABLE spots ADD COLUMN IF NOT EXISTS geog geography(Point, 4326)
  GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(gps_lng, gps_lat), 4326)::geography) STORED;
-- Accent-insensitive search document ("Las Piñas" matches "las pinas").
ALTER TABLE spots ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, f_unaccent(
    coalesce(name, '') || ' ' || coalesce(municipality, '') || ' ' || coalesce(subcategory, '')))) STORED;

CREATE UNIQUE INDEX IF NOT EXISTS uq_spots_osm_ref ON spots ((external_refs->>'osm')) WHERE external_refs ? 'osm';
CREATE UNIQUE INDEX IF NOT EXISTS uq_spots_wikidata_ref ON spots ((external_refs->>'wikidata')) WHERE external_refs ? 'wikidata';
CREATE INDEX IF NOT EXISTS idx_spots_search_tsv ON spots USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS idx_spots_name_trgm ON spots USING gin (f_unaccent(lower(name)) gin_trgm_ops);
-- The public read path: published, non-test rows only (small, hot indexes).
CREATE INDEX IF NOT EXISTS idx_spots_public_geog ON spots USING gist (geog) WHERE status = 'published' AND NOT is_test;
CREATE INDEX IF NOT EXISTS idx_spots_public_area ON spots (province_area_id, category) WHERE status = 'published' AND NOT is_test;
CREATE INDEX IF NOT EXISTS idx_spots_public_tier ON spots (launch_tier, province_area_id) WHERE status = 'published' AND NOT is_test;
-- PGMEM_SKIP_END

-- ------------------------------------------------------ provenance (1:1, cold)
-- Kept beside spots so the hot spots row stays narrow. Shape of field_sources (per field):
--   {"description":{"source":"wikipedia","url":"…","license":"CC BY-SA 4.0","retrieved_at":"…"},
--    "hours":{"source":"scrapling","url":"…","retrieved_at":"…","reviewed":false}}
CREATE TABLE IF NOT EXISTS spot_provenance (
  spot_id TEXT PRIMARY KEY REFERENCES spots(id) ON DELETE CASCADE,
  field_sources JSONB NOT NULL DEFAULT '{}'::jsonb,
  osm_tags JSONB,
  import_confidence REAL CHECK (import_confidence IS NULL OR (import_confidence >= 0 AND import_confidence <= 1)),
  import_wave TEXT,
  seed_run_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS seed_runs (
  id TEXT PRIMARY KEY,
  wave TEXT NOT NULL,
  region_psgc TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('dry-run', 'apply')),
  stats JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_spot_provenance_wave ON spot_provenance (import_wave);
