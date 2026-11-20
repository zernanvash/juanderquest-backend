-- Plan 116 §7: checks after import-areas.ts --apply (run with psql against the WORK database).
-- Needs /work/pangasinan-old.ndjson and /work/old-spots.ndjson (exports of jdq_old_copy).
\set ON_ERROR_STOP on
\pset pager off

\echo '== counts per level'
SELECT level, count(*), count(*) FILTER (WHERE geom IS NULL) AS no_geom, count(psgc_code) AS with_psgc,
       min(min_zoom), max(min_zoom)
  FROM admin_areas GROUP BY level ORDER BY array_position(ARRAY['region','province','town','barangay'], level);

\echo '== parent chain (expect 0 rows)'
SELECT c.level, p.level AS parent_level, count(*)
  FROM admin_areas c LEFT JOIN admin_areas p ON p.id = c.parent_id
 WHERE NOT ((c.level = 'region' AND c.parent_id IS NULL)
         OR (c.level = 'province' AND p.level = 'region')
         OR (c.level = 'town' AND p.level IN ('province', 'region'))
         OR (c.level = 'barangay' AND p.level = 'town'))
 GROUP BY 1, 2;

\echo '== geometry validity (expect 0)'
SELECT count(*) AS invalid_or_not_multipolygon FROM admin_areas
 WHERE geom IS NOT NULL AND (NOT ST_IsValid(geom) OR GeometryType(geom) <> 'MULTIPOLYGON' OR ST_SRID(geom) <> 4326);

\echo '== preserved Pangasinan rows (expect 1413 present, 0 changed)'
CREATE TEMP TABLE old_rows (j jsonb);
\copy old_rows FROM '/work/pangasinan-old.ndjson'
SELECT count(*) AS old_rows,
       count(a.id) AS present,
       count(*) FILTER (WHERE a.id IS NOT NULL AND (
         a.name IS DISTINCT FROM o.j->>'name' OR a.display_name IS DISTINCT FROM o.j->>'display_name'
         OR a.level IS DISTINCT FROM o.j->>'level' OR a.psgc_code::text IS DISTINCT FROM o.j->>'psgc_code'
         OR a.label_lat IS DISTINCT FROM (o.j->>'label_lat')::float8 OR a.label_lng IS DISTINCT FROM (o.j->>'label_lng')::float8
         OR a.boundary IS DISTINCT FROM o.j->'boundary'
         OR (a.parent_id IS DISTINCT FROM o.j->>'parent_id' AND a.id <> 'pangasinan'))) AS changed,
       count(*) FILTER (WHERE a.geom IS NULL) AS without_geom
  FROM old_rows o LEFT JOIN admin_areas a ON a.id = o.j->>'id';
SELECT id, parent_id FROM admin_areas WHERE id = 'pangasinan';

\echo '== EXPLAIN ANALYZE point-in-town (Dagupan city hall area)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT id FROM admin_areas
 WHERE level = 'town' AND ST_Covers(geom, ST_SetSRID(ST_MakePoint(120.3409, 16.0433), 4326));

\echo '== 100 random points inside random towns: per-lookup timing'
CREATE TEMP TABLE pts AS
SELECT t.id AS expected, (ST_Dump(ST_GeneratePoints(t.geom, 1, 116))).geom AS g
  FROM (SELECT id, geom FROM admin_areas WHERE level = 'town' AND geom IS NOT NULL ORDER BY md5(id) LIMIT 100) t;
CREATE TEMP TABLE timings (expected text, found text, ms float8);
DO $$
DECLARE r record; t0 timestamptz; f text;
BEGIN
  FOR r IN SELECT * FROM pts LOOP
    t0 := clock_timestamp();
    SELECT id INTO f FROM admin_areas WHERE level = 'town' AND ST_Covers(geom, r.g) LIMIT 1;
    INSERT INTO timings VALUES (r.expected, f, extract(epoch FROM clock_timestamp() - t0) * 1000);
  END LOOP;
END $$;
SELECT count(*) AS points, count(*) FILTER (WHERE found = expected) AS found_expected,
       round(avg(ms)::numeric, 2) AS avg_ms, round(percentile_cont(0.95) WITHIN GROUP (ORDER BY ms)::numeric, 2) AS p95_ms,
       round(max(ms)::numeric, 2) AS max_ms
  FROM timings;

\echo '== old spots: centroid inside current town_area_id?'
CREATE TEMP TABLE old_spots (j jsonb);
\copy old_spots FROM '/work/old-spots.ndjson'
WITH s AS (
  SELECT j->>'id' AS id, j->>'name' AS name, j->>'town_area_id' AS town,
         ST_SetSRID(ST_MakePoint((j->>'gps_lng')::float8, (j->>'gps_lat')::float8), 4326) AS g
    FROM old_spots)
SELECT count(*) AS spots,
       count(*) FILTER (WHERE s.town IS NULL) AS no_town,
       count(*) FILTER (WHERE ST_Covers(t.geom, s.g)) AS inside_town,
       count(*) FILTER (WHERE s.town IS NOT NULL AND NOT coalesce(ST_Covers(t.geom, s.g), false)) AS mismatches
  FROM s LEFT JOIN admin_areas t ON t.id = s.town;
WITH s AS (
  SELECT j->>'id' AS id, j->>'name' AS name, j->>'town_area_id' AS town,
         ST_SetSRID(ST_MakePoint((j->>'gps_lng')::float8, (j->>'gps_lat')::float8), 4326) AS g
    FROM old_spots)
SELECT s.name, s.town AS current_town,
       (SELECT id FROM admin_areas a WHERE a.level = 'town' AND ST_Covers(a.geom, s.g) LIMIT 1) AS covering_town,
       round(ST_Distance(t.geom::geography, s.g::geography)::numeric) AS metres_outside
  FROM s LEFT JOIN admin_areas t ON t.id = s.town
 WHERE s.town IS NOT NULL AND NOT coalesce(ST_Covers(t.geom, s.g), false)
 ORDER BY 1;

\echo '== stored sizes'
SELECT pg_size_pretty(pg_total_relation_size('admin_areas')) AS admin_areas_total,
       pg_size_pretty(pg_relation_size('idx_admin_areas_geom')) AS gist_index,
       pg_size_pretty(sum(pg_column_size(geom))::bigint) AS geom_stored,
       pg_size_pretty(sum(pg_column_size(boundary))::bigint) AS boundary_stored,
       pg_size_pretty(sum(length(boundary::text))::bigint) AS boundary_json_text
  FROM admin_areas;
SELECT level, pg_size_pretty(sum(pg_column_size(geom))::bigint) AS geom, pg_size_pretty(sum(pg_column_size(boundary))::bigint) AS boundary,
       round(avg(ST_NPoints(geom))) AS avg_pts
  FROM admin_areas GROUP BY level ORDER BY 1;

\echo '== latest seed_runs'
SELECT mode, count(*), sum((stats->>'changed')::int) AS changed, max(finished_at)
  FROM seed_runs WHERE wave = 'areas-116' GROUP BY mode, date_trunc('minute', started_at) ORDER BY max(finished_at) DESC LIMIT 6;
