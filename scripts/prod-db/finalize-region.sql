-- Plan 116 §10/§11: post-import finishing for a launch database. Idempotent; one transaction.
-- 1. Province/region ids for every spot whose town is known (carried spots predate them).
-- 2. Plan 116 §8.2: a featured spot needs a primary photo; demote featured spots without one.
-- 3. image_url from the primary catalog photo where empty.
-- 4. Published duplicates: the weaker copy goes to review (nothing merged or deleted).
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

-- 3. Plan 116 §6.3: image_url (old clients, list cards, map thumbs) = primary catalog photo w640,
--    only where a spot has no image yet. Curated image_url values are never overwritten.
WITH upd AS (
  UPDATE spots s SET image_url = coalesce(a.variants ->> 'w640', a.url)
    FROM spot_assets a
   WHERE a.spot_id = s.id AND a.is_primary AND a.status = 'approved'
     AND coalesce(s.image_url, '') = ''
  RETURNING 1)
SELECT count(*) AS image_url_filled_from_primary FROM upd;

-- 4. No place shown twice. The importer never merges two different Wikidata items, and matches
--    existing spots only within 300 m, so a few published duplicates remain (heritage-marker item
--    + building item; big parks whose pins are km apart). Nothing is merged or deleted here: the
--    weaker copy moves to review with import_meta.duplicate_of for the owner's review queue.
CREATE TEMP TABLE pub ON COMMIT DROP AS
SELECT s.id, s.geog, f_unaccent(lower(s.name)) AS n,
       coalesce((p.field_sources -> 'import_meta' ->> 'origin') = 'national-import', false) AS imported, -- no provenance row = carried/curated
       coalesce((p.field_sources -> 'import_meta' ->> 'launch_score')::float8, 0) AS score
  FROM spots s LEFT JOIN spot_provenance p ON p.spot_id = s.id
 WHERE s.status = 'published' AND NOT s.is_test;
CREATE TEMP TABLE dup ON COMMIT DROP AS
SELECT DISTINCT ON (loser) loser, keeper FROM (
  -- imported copy of an existing (carried / editorial / community) spot: same name within 10 km
  SELECT i.id AS loser, e.id AS keeper, 1 AS rule
    FROM pub i JOIN pub e ON i.imported AND NOT e.imported
                         AND ST_DWithin(i.geog, e.geog, 10000) AND similarity(i.n, e.n) >= 0.9
  UNION ALL
  -- two imports of one place: near-identical names within 150 m; keep the higher launch score
  SELECT CASE WHEN (a.score, b.id) > (b.score, a.id) THEN b.id ELSE a.id END,
         CASE WHEN (a.score, b.id) > (b.score, a.id) THEN a.id ELSE b.id END, 2
    FROM pub a JOIN pub b ON a.id < b.id AND a.imported AND b.imported
                         AND ST_DWithin(a.geog, b.geog, 150) AND similarity(a.n, b.n) >= 0.8) x
 ORDER BY loser, rule, keeper;
-- A keeper that is itself a loser stays published only if its own keeper is not (no chains).
DELETE FROM dup d WHERE EXISTS (SELECT 1 FROM dup k WHERE k.loser = d.keeper AND k.keeper = d.loser AND d.loser > d.keeper);
WITH upd AS (
  UPDATE spots s SET status = 'needs_review', launch_tier = 'review'
    FROM dup d WHERE s.id = d.loser
  RETURNING s.id, d.keeper)
, note AS (
  UPDATE spot_provenance p
     SET field_sources = jsonb_set(coalesce(p.field_sources, '{}'), '{import_meta,duplicate_of}', to_jsonb(u.keeper), true),
         updated_at = now()
    FROM upd u WHERE p.spot_id = u.id
  RETURNING 1)
SELECT (SELECT count(*) FROM upd) AS duplicates_sent_to_review, (SELECT count(*) FROM note) AS provenance_noted;
COMMIT;
ANALYZE spots;
