-- Migration 057: store simplified admin-area boundary geometry in the database.
-- 056 kept only bbox/label points and the API re-read shapes from GeoJSON files at runtime,
-- silently drawing a 600 m circle whenever a file was missing (e.g. the province before
-- province.geojson existed, and every area on a host without ~/jdq-maps). Shapes now live
-- with the rows; the import fills this column and /areas/:id/shape serves it.
ALTER TABLE admin_areas ADD COLUMN IF NOT EXISTS boundary JSONB;
