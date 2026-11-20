// Plan 116 destinations: area assignment, purely in SQL so it can be re-run once the national
// admin areas are loaded (`import-destinations.ts --reassign-areas`).
//
//   town      = smallest town polygon that ST_Covers the point; else the nearest town within 2 km
//               (geography distance; coastal / just-offshore points)
//   barangay  = barangay of that town covering the point (optional)
//   province / region = first ancestors of the town with that level
//   area_status:
//     covered | nearest_2km  → matched
//     unmatched              → no town, but areas are loaded there → the spot goes to review
//     no_areas               → no town and no areas loaded there yet → tier capped at 'standard' until re-run
//   "Areas loaded there" = a province polygon covers the point or lies within 2 km, or `areasComplete`
//   (pass --areas-complete once the national import has every town).

export function areaAssignSql(source: string, target: string, areasComplete: boolean): string[] {
  return [
    `DROP TABLE IF EXISTS ${target}`,
    `CREATE TEMP TABLE ${target} ON COMMIT DROP AS
     WITH pts AS (SELECT id, geog FROM ${source} WHERE geog IS NOT NULL)
     SELECT p.id, p.geog, COALESCE(cov.id, near.id) AS town_id,
            CASE WHEN cov.id IS NOT NULL THEN 'covered'
                 WHEN near.id IS NOT NULL THEN 'nearest_2km'
                 WHEN ${areasComplete ? 'true' : 'prov.found'} THEN 'unmatched'
                 ELSE 'no_areas' END AS area_status,
            NULL::text AS barangay_id, NULL::text AS province_id, NULL::text AS region_id
       FROM pts p
       LEFT JOIN LATERAL (
         SELECT a.id FROM admin_areas a
          WHERE a.level = 'town' AND a.geom IS NOT NULL AND ST_Covers(a.geom, p.geog::geometry)
          ORDER BY ST_Area(a.geom), a.id LIMIT 1) cov ON true
       LEFT JOIN LATERAL (
         SELECT a.id FROM admin_areas a
          WHERE cov.id IS NULL AND a.level = 'town' AND a.geom IS NOT NULL
            AND a.geom && ST_Expand(p.geog::geometry, 0.03)
            AND ST_DWithin(a.geom::geography, p.geog, 2000)
          ORDER BY ST_Distance(a.geom::geography, p.geog), a.id LIMIT 1) near ON true
       LEFT JOIN LATERAL (
         SELECT true AS found FROM admin_areas a
          WHERE cov.id IS NULL AND near.id IS NULL AND a.level = 'province' AND a.geom IS NOT NULL
            AND a.geom && ST_Expand(p.geog::geometry, 0.03)
            AND ST_DWithin(a.geom::geography, p.geog, 2000)
          LIMIT 1) prov ON true`,
    `UPDATE ${target} x SET barangay_id = (
       SELECT b.id FROM admin_areas b
        WHERE b.level = 'barangay' AND b.parent_id = x.town_id AND b.geom IS NOT NULL
          AND ST_Covers(b.geom, x.geog::geometry)
        ORDER BY ST_Area(b.geom), b.id LIMIT 1)
      WHERE x.town_id IS NOT NULL`,
    `UPDATE ${target} x SET
       province_id = CASE WHEN p1.level = 'province' THEN p1.id WHEN p2.level = 'province' THEN p2.id END,
       region_id = CASE WHEN p1.level = 'region' THEN p1.id WHEN p2.level = 'region' THEN p2.id
                        WHEN p3.level = 'region' THEN p3.id END
      FROM admin_areas t
      LEFT JOIN admin_areas p1 ON p1.id = t.parent_id
      LEFT JOIN admin_areas p2 ON p2.id = p1.parent_id
      LEFT JOIN admin_areas p3 ON p3.id = p2.parent_id
     WHERE t.id = x.town_id`,
  ];
}

/**
 * Two-digit PSGC region prefix. admin_areas.psgc_code is a BIGINT holding the 10-digit PSGC
 * (RR PPP MM BBB), so the leading zero is lost: Pangasinan 0105500000 is stored as 105500000.
 */
export const PSGC_REGION_PREFIX_SQL = (col: string) => `substr(lpad(${col}::text, 10, '0'), 1, 2)`;

/** `--region` accepts a 10-digit PSGC code (leading zero optional) or the two-digit region prefix. */
export function psgcRegionPrefix(code: string): string {
  const digits = code.replace(/\D/g, '');
  if (!digits || digits.length > 10) throw new Error(`bad PSGC code: ${code}`);
  return digits.length <= 2 ? digits.padStart(2, '0') : digits.padStart(10, '0').slice(0, 2);
}
