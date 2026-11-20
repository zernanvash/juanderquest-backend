-- Plan 116 §10/§11: post-import finishing for a launch database. Idempotent; one transaction.
-- 1. Province/region ids for every spot whose town is known (carried spots predate them).
-- 2. Plan 116 §8.2: a featured spot needs a primary photo; demote featured spots without one.
\set ON_ERROR_STOP on
BEGIN;
WITH chain AS (
  SELECT t.id AS town_id,
         CASE WHEN p.level = 'province' THEN p.id END AS province_id,
         CASE WHEN p.level = 'region' THEN p.id WHEN r.level = 'region' THEN r.id END AS region_id
    FROM admin_areas t
    LEFT JOIN admin_areas p ON p.id = t.parent_id
    LEFT JOIN admin_areas r ON r.id = p.parent_id
   WHERE t.level = 'town'),
upd AS (
  UPDATE spots s SET province_area_id = c.province_id, region_area_id = c.region_id
    FROM chain c
   WHERE s.town_area_id = c.town_id
     AND (s.province_area_id IS DISTINCT FROM c.province_id OR s.region_area_id IS DISTINCT FROM c.region_id)
  RETURNING 1)
SELECT count(*) AS spots_area_parents_set FROM upd;

WITH upd AS (
  UPDATE spots s SET launch_tier = 'standard'
   WHERE s.launch_tier = 'featured'
     AND NOT EXISTS (SELECT 1 FROM spot_assets a
                      WHERE a.spot_id = s.id AND a.is_primary AND a.status <> 'deleted')
  RETURNING s.id)
SELECT count(*) AS featured_demoted_no_photo FROM upd;
COMMIT;
ANALYZE spots;
