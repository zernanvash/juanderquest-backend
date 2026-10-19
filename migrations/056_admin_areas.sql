-- Migration 056: Admin Areas (Plan 45 clickable places)
-- Supports city/municipality (town) and barangay administrative areas with PSA/NAMRIA PSGC codes,
-- boundary geometry metadata, label points, and spot associations.

CREATE TABLE IF NOT EXISTS admin_areas (
  id TEXT PRIMARY KEY,                                      -- towns: KEEP existing KNOWN_AREAS ids (e.g. 'dagupan'); barangays: '<town-id>--<slug>' e.g. 'dagupan--pantal'
  psgc_code BIGINT UNIQUE,                                  -- PSA/NAMRIA 9/10-digit PSGC code (e.g. 105518000 for Dagupan City, 105518022 for Pantal)
  level TEXT NOT NULL CHECK (level IN ('province','town','barangay')),
  name TEXT NOT NULL,                                       -- 'Pantal'
  display_name TEXT NOT NULL,                               -- 'Pantal, Dagupan City'
  parent_id TEXT REFERENCES admin_areas(id),
  osm_relation_id BIGINT,
  has_boundary BOOLEAN NOT NULL DEFAULT TRUE,
  label_lat DOUBLE PRECISION NOT NULL,
  label_lng DOUBLE PRECISION NOT NULL,
  bbox DOUBLE PRECISION[4] NOT NULL,                        -- [minLng, minLat, maxLng, maxLat]
  min_zoom SMALLINT NOT NULL DEFAULT 9,                     -- town: 9, barangay: 13
  shape_file TEXT,                                          -- relative path of the simplified GeoJSON feature or shape cache
  data_version TEXT NOT NULL DEFAULT '2023-psa-namria',     -- extract/source date
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_areas_parent ON admin_areas (parent_id);
CREATE INDEX IF NOT EXISTS idx_admin_areas_level ON admin_areas (level);
CREATE INDEX IF NOT EXISTS idx_admin_areas_psgc ON admin_areas (psgc_code);

ALTER TABLE spots ADD COLUMN IF NOT EXISTS town_area_id TEXT REFERENCES admin_areas(id);
ALTER TABLE spots ADD COLUMN IF NOT EXISTS barangay_area_id TEXT REFERENCES admin_areas(id);

CREATE INDEX IF NOT EXISTS idx_spots_town_area ON spots (town_area_id) WHERE status = 'published';
CREATE INDEX IF NOT EXISTS idx_spots_barangay_area ON spots (barangay_area_id) WHERE status = 'published';
