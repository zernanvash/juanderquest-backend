-- Migration 058: national destination provenance and query indexes (Plan 46).
-- Additive: preserves existing Pangasinan area ids and all spot content.

ALTER TABLE spots ADD COLUMN IF NOT EXISTS external_refs JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE spots ADD COLUMN IF NOT EXISTS field_sources JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE spots ADD COLUMN IF NOT EXISTS import_confidence REAL;
ALTER TABLE spots ADD COLUMN IF NOT EXISTS import_wave TEXT;
ALTER TABLE spots ADD COLUMN IF NOT EXISTS official_website TEXT;
ALTER TABLE spots ADD COLUMN IF NOT EXISTS contact_phone TEXT;
ALTER TABLE spots ADD COLUMN IF NOT EXISTS entrance_fee_text TEXT;
ALTER TABLE spots ADD COLUMN IF NOT EXISTS closure_notice TEXT;

DO $$ BEGIN
  ALTER TABLE spots ADD CONSTRAINT spots_import_confidence_range
    CHECK (import_confidence IS NULL OR (import_confidence >= 0 AND import_confidence <= 1));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_spots_osm_ref
  ON spots ((external_refs->>'osm')) WHERE external_refs ? 'osm';
CREATE UNIQUE INDEX IF NOT EXISTS uq_spots_wikidata_ref
  ON spots ((external_refs->>'wikidata')) WHERE external_refs ? 'wikidata';
-- Install extension objects in a stable schema; test fixtures intentionally use
-- an isolated-schema-only search_path, so the operator class must be qualified.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
CREATE INDEX IF NOT EXISTS idx_spots_name_trgm
  ON spots USING gin (name public.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_spots_published_location_created
  ON spots (gps_lat, gps_lng, created_at DESC, id)
  WHERE status = 'published' AND is_test = FALSE;
CREATE INDEX IF NOT EXISTS idx_spots_status_created
  ON spots (status, created_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_spots_published_area_created
  ON spots (town_area_id, created_at DESC, id)
  WHERE status = 'published' AND is_test = FALSE;

ALTER TABLE spot_assets ADD COLUMN IF NOT EXISTS license TEXT;
ALTER TABLE spot_assets ADD COLUMN IF NOT EXISTS author TEXT;
ALTER TABLE spot_assets ADD COLUMN IF NOT EXISTS attribution_url TEXT;
-- Commons assets are system-imported rather than user-owned. Keep user uploads
-- tied to their account while allowing a null owner for these attributed assets.
ALTER TABLE spot_assets ALTER COLUMN user_id DROP NOT NULL;

CREATE TABLE IF NOT EXISTS seed_runs (
  id TEXT PRIMARY KEY,
  wave TEXT NOT NULL,
  region_psgc TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('dry-run', 'apply')),
  stats JSONB NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ
);

ALTER TABLE admin_areas DROP CONSTRAINT IF EXISTS admin_areas_level_check;
ALTER TABLE admin_areas ADD CONSTRAINT admin_areas_level_check
  CHECK (level IN ('region', 'province', 'town', 'barangay'));
CREATE INDEX IF NOT EXISTS idx_admin_areas_level_min_zoom
  ON admin_areas (level, min_zoom);
CREATE INDEX IF NOT EXISTS idx_admin_areas_level_zoom_bbox
  ON admin_areas (level, min_zoom, (bbox[1]), (bbox[2]), (bbox[3]), (bbox[4]));
