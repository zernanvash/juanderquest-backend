-- Plan 116 §7: load admin_areas.national.copy.gz (export-areas.sh) into a database that has
-- migrations 056, 057 and 110 applied. One transaction; upsert by id, parents first.
-- Rows that already exist with the same id (e.g. carried-over Pangasinan rows) are updated to the
-- exported values; no other admin_areas row is touched or deleted.
--
--   gzip -dc admin_areas.national.copy.gz | psql "$TARGET_URL" -X -v ON_ERROR_STOP=1 -f load-areas.sql
--
-- (psql reads the COPY data from its standard input: `\copy ... FROM pstdin`.)
\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE load_areas (LIKE admin_areas INCLUDING DEFAULTS) ON COMMIT DROP;
\copy load_areas (id, psgc_code, level, name, display_name, parent_id, osm_relation_id, has_boundary, label_lat, label_lng, bbox, min_zoom, shape_file, data_version, updated_at, boundary, geom) FROM pstdin
SELECT level, count(*) FROM load_areas GROUP BY level ORDER BY 1;
DO $$
DECLARE lvl text; n int;
BEGIN
  FOREACH lvl IN ARRAY ARRAY['region', 'province', 'town', 'barangay'] LOOP
    INSERT INTO admin_areas AS a (id, psgc_code, level, name, display_name, parent_id, osm_relation_id, has_boundary,
                                  label_lat, label_lng, bbox, min_zoom, shape_file, data_version, updated_at, boundary, geom)
    SELECT id, psgc_code, level, name, display_name, parent_id, osm_relation_id, has_boundary,
           label_lat, label_lng, bbox, min_zoom, shape_file, data_version, updated_at, boundary, geom
      FROM load_areas WHERE level = lvl
    ON CONFLICT (id) DO UPDATE SET
      psgc_code = EXCLUDED.psgc_code, level = EXCLUDED.level, name = EXCLUDED.name, display_name = EXCLUDED.display_name,
      parent_id = EXCLUDED.parent_id, has_boundary = EXCLUDED.has_boundary, label_lat = EXCLUDED.label_lat,
      label_lng = EXCLUDED.label_lng, bbox = EXCLUDED.bbox, min_zoom = EXCLUDED.min_zoom,
      shape_file = EXCLUDED.shape_file, data_version = EXCLUDED.data_version, updated_at = EXCLUDED.updated_at,
      boundary = EXCLUDED.boundary, geom = EXCLUDED.geom
    WHERE (a.psgc_code, a.name, a.display_name, a.parent_id, a.has_boundary, a.label_lat, a.label_lng, a.bbox,
           a.min_zoom, a.shape_file, a.data_version, a.boundary, ST_AsEWKB(a.geom))
          IS DISTINCT FROM
          (EXCLUDED.psgc_code, EXCLUDED.name, EXCLUDED.display_name, EXCLUDED.parent_id, EXCLUDED.has_boundary,
           EXCLUDED.label_lat, EXCLUDED.label_lng, EXCLUDED.bbox, EXCLUDED.min_zoom, EXCLUDED.shape_file,
           EXCLUDED.data_version, EXCLUDED.boundary, ST_AsEWKB(EXCLUDED.geom));
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE NOTICE '% rows inserted or changed: %', lvl, n;
  END LOOP;
END $$;
COMMIT;
ANALYZE admin_areas;
