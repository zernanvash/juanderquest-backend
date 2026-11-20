-- Plan 116 §7: build the national area bundle from the COD-AB staging tables (load-codab.sh).
-- Runs in a WORK database only (schema areas_src). Output table areas_src.feature_bundle, one row per
-- COD-AB adm2/adm3/adm4 feature, with two geometries:
--   geom      matching-grade: ST_SimplifyPreserveTopology at ~3 m (adm3/adm4) or ~10 m (adm2)
--   boundary  display-grade:  ~20 m / ~50 m / ~200 m (barangay / town / province)
-- Per-feature simplification keeps each polygon's topology; neighbours may drift apart by at most
-- the tolerance (<= 3 m for geom). ST_CoverageSimplify (edge-shared) was tried first and was too
-- slow on the full-resolution national coverage (> 14 min for 88 adm2 polygons alone).
\set ON_ERROR_STOP on
\timing on

DROP TABLE IF EXISTS areas_src.feature_bundle;
CREATE TABLE areas_src.feature_bundle (
  lvl smallint NOT NULL,
  pcode text PRIMARY KEY,           -- 10-digit form of the COD-AB pcode
  name text NOT NULL,
  parent text NOT NULL,             -- 10-digit form of the parent pcode
  geom geometry(MultiPolygon, 4326) NOT NULL,
  boundary geometry(MultiPolygon, 4326) NOT NULL
);

CREATE OR REPLACE FUNCTION pg_temp.expand(p text) RETURNS text LANGUAGE sql IMMUTABLE AS
  $$ SELECT rpad(substr(p, 3), 10, '0') $$;
CREATE OR REPLACE FUNCTION pg_temp.clean(g geometry) RETURNS geometry LANGUAGE sql IMMUTABLE AS
  $$ SELECT ST_Multi(ST_CollectionExtract(ST_MakeValid(g), 3)) $$;

-- adm2: provinces, NCR districts, SGA, City of Isabela 
INSERT INTO areas_src.feature_bundle
SELECT 2, pg_temp.expand(adm2_pcode), adm2_name, pg_temp.expand(adm1_pcode),
       pg_temp.clean(ST_SimplifyPreserveTopology(geom, 0.0001)),
       pg_temp.clean(ST_SimplifyPreserveTopology(geom, 0.002))
  FROM areas_src.codab_adm2;

-- adm3: cities / municipalities
INSERT INTO areas_src.feature_bundle
SELECT 3, pg_temp.expand(adm3_pcode), adm3_name, pg_temp.expand(adm2_pcode),
       pg_temp.clean(ST_SimplifyPreserveTopology(geom, 0.00003)),
       pg_temp.clean(ST_SimplifyPreserveTopology(geom, 0.0005))
  FROM areas_src.codab_adm3;

-- adm4: barangays
INSERT INTO areas_src.feature_bundle
SELECT 4, pg_temp.expand(adm4_pcode), adm4_name, pg_temp.expand(adm3_pcode),
       pg_temp.clean(ST_SimplifyPreserveTopology(geom, 0.00003)),
       pg_temp.clean(ST_SimplifyPreserveTopology(geom, 0.0002))
  FROM areas_src.codab_adm4;

SELECT lvl, count(*), sum(ST_NPoints(geom)) AS geom_pts, pg_size_pretty(sum(ST_MemSize(geom))) AS geom_size,
       sum(ST_NPoints(boundary)) AS boundary_pts, pg_size_pretty(sum(length(ST_AsGeoJSON(boundary, 5)))::bigint) AS boundary_json,
       count(*) FILTER (WHERE ST_IsEmpty(geom) OR ST_IsEmpty(boundary)) AS empty
  FROM areas_src.feature_bundle GROUP BY lvl ORDER BY lvl;

-- Export: one JSON object per line (lib.ts SourceFeature). Unaligned output, not COPY, so JSON
-- backslashes are not doubled.
\timing off
\pset format unaligned
\pset tuples_only on
\o /work/codab-bundle.ndjson
SELECT json_build_object('lvl', lvl, 'pcode', pcode, 'name', name, 'parent', parent,
                         'geom', ST_AsGeoJSON(geom, 6), 'boundary', ST_AsGeoJSON(boundary, 5))
  FROM areas_src.feature_bundle ORDER BY lvl, pcode;
\o
