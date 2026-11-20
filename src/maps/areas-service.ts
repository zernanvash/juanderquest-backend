import { Pool } from 'pg';
import { pointInPolygon, pointInMultiPolygon, distanceMeters } from './geometry.js';

export interface AreaRecord {
  id: string;
  psgc_code: number;
  level: 'region' | 'province' | 'town' | 'barangay';
  name: string;
  display_name: string;
  parent_id: string | null;
  osm_relation_id: number | null;
  has_boundary: boolean;
  label_lat: number;
  label_lng: number;
  bbox: [number, number, number, number];
  min_zoom: number;
  shape_file: string | null;
  data_version: string;
  geometry?: any;
}

// In-memory cache of admin areas loaded from database or geojson
let cachedAreas: AreaRecord[] | null = null;

export function setCachedAreas(areas: AreaRecord[]) {
  cachedAreas = areas;
}

export function getCachedAreas(): AreaRecord[] | null {
  return cachedAreas;
}

let cacheLoadedAt = 0;
let cacheLoading: Promise<void> | null = null;
const AREA_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Loads towns/barangays (with stored boundaries, migration 057) into the matcher cache.
 * New spots are assigned at write time, so the cache must come from the database —
 * never from files on disk. Refreshes at most every 10 minutes; failures keep the old cache.
 */
export async function ensureAreaCache(pool: Pick<Pool, 'query'> | null, force = false): Promise<void> {
  if (!pool) return;
  if (!force && cachedAreas && Date.now() - cacheLoadedAt < AREA_CACHE_TTL_MS) return;
  if (cacheLoading) return cacheLoading;
  cacheLoading = (async () => {
    try {
      // Plan 116: with PostGIS geometry (migration 110) matching runs in SQL, so the cache keeps
      // metadata only (about 44k small rows nationally) instead of every boundary polygon.
      const spatial = await hasSpatialAreas(pool, true);
      const { rows } = await pool.query(
        `SELECT id, psgc_code, level, name, display_name, parent_id, osm_relation_id, has_boundary,
                label_lat, label_lng, bbox, min_zoom, shape_file, data_version${spatial ? '' : ', boundary'}
           FROM admin_areas WHERE level IN ('town', 'barangay')`,
      );
      cachedAreas = rows.map((r: any) => ({
        ...r,
        psgc_code: Number(r.psgc_code),
        label_lat: Number(r.label_lat),
        label_lng: Number(r.label_lng),
        bbox: (r.bbox || []).map(Number) as [number, number, number, number],
        geometry: typeof r.boundary === 'string' ? JSON.parse(r.boundary) : (r.boundary ?? undefined),
      }));
      cacheLoadedAt = Date.now();
    } catch (error) {
      console.error(
        '[areas] could not load admin_areas for spot matching:',
        error instanceof Error ? error.message : error,
      );
    } finally {
      cacheLoading = null;
    }
  })();
  return cacheLoading;
}

export interface SpotAreaMatch {
  townAreaId: string | null;
  barangayAreaId: string | null;
  provinceAreaId: string | null;
  regionAreaId: string | null;
}

// Per-pool answer to "does admin_areas have PostGIS geometry?" (false on pg-mem / older schemas).
const spatialAreasByPool = new WeakMap<object, { value: boolean; at: number }>();

export async function hasSpatialAreas(pool: Pick<Pool, 'query'>, refresh = false): Promise<boolean> {
  const cached = spatialAreasByPool.get(pool as object);
  if (cached && !refresh && Date.now() - cached.at < AREA_CACHE_TTL_MS) return cached.value;
  let value = false;
  try {
    const { rows } = await pool.query(
      `SELECT EXISTS (SELECT 1 FROM admin_areas WHERE level = 'town' AND geom IS NOT NULL) AS ok`,
    );
    value = Boolean(rows[0]?.ok);
  } catch {
    value = false;
  }
  spatialAreasByPool.set(pool as object, { value, at: Date.now() });
  return value;
}

const SPATIAL_MATCH_SQL = `
  WITH p AS (SELECT ST_SetSRID(ST_MakePoint($2::float8, $1::float8), 4326) AS g),
  inside AS (
    SELECT a.id, a.parent_id FROM admin_areas a, p
     WHERE a.level = 'town' AND a.geom IS NOT NULL AND ST_Covers(a.geom, p.g) LIMIT 1),
  nearest AS (  -- coastal / offshore points: nearest town polygon within 2 km
    SELECT n.id, n.parent_id FROM (
      SELECT a.id, a.parent_id, a.geom FROM admin_areas a, p
       WHERE a.level = 'town' AND a.geom IS NOT NULL AND NOT EXISTS (SELECT 1 FROM inside)
       ORDER BY a.geom <-> p.g LIMIT 1) n, p
     WHERE ST_DWithin(n.geom::geography, p.g::geography, 2000)),
  town AS (SELECT * FROM inside UNION ALL SELECT * FROM nearest)
  SELECT t.id AS town_id, b.id AS barangay_id, b.covers, b.label_m
    FROM town t
    LEFT JOIN LATERAL (
      SELECT x.id,
             (x.geom IS NOT NULL AND ST_Covers(x.geom, p.g)) AS covers,
             ST_Distance(ST_SetSRID(ST_MakePoint(x.label_lng, x.label_lat), 4326)::geography, p.g::geography) AS label_m
        FROM admin_areas x, p
       WHERE x.level = 'barangay' AND x.parent_id = t.id
       ORDER BY 2 DESC, 3
       LIMIT 1) b ON TRUE`;

/**
 * Plan 116: assigns town, barangay, province and region for a coordinate. Uses PostGIS
 * (spatial index on admin_areas.geom) when available; otherwise the in-memory matcher
 * (pg-mem, no-DB development). Falls back to the municipality name like the old matcher.
 */
export async function resolveSpotAreas(
  pool: Pick<Pool, 'query'> | null,
  lat: number,
  lng: number,
  municipalityName?: string,
): Promise<SpotAreaMatch> {
  let townId: string | null = null;
  let barangayId: string | null = null;
  if (pool && (await hasSpatialAreas(pool))) {
    const { rows } = await pool.query(SPATIAL_MATCH_SQL, [lat, lng]);
    townId = rows[0]?.town_id ?? null;
    // Same rule as the in-memory matcher: inside the polygon, else label point within 1.5 km.
    barangayId = rows[0]?.barangay_id && (rows[0].covers || Number(rows[0].label_m) <= 1500) ? rows[0].barangay_id : null;
    if (!townId && municipalityName) {
      const norm = municipalityName.toLowerCase().replace(/ city$/, '');
      const byName = await pool.query(
        `SELECT id FROM admin_areas WHERE level = 'town'
            AND (lower(name) = lower($1) OR regexp_replace(lower(name), ' city$', '') = $2 OR id = $2)
          ORDER BY id LIMIT 1`,
        [municipalityName, norm],
      );
      townId = byName.rows[0]?.id ?? null;
    }
  } else {
    await ensureAreaCache(pool);
    const match = matchSpotToAreas(lat, lng, municipalityName);
    townId = match.townAreaId;
    barangayId = match.barangayAreaId;
  }
  const { provinceAreaId, regionAreaId } = await resolveParents(pool, townId);
  return { townAreaId: townId, barangayAreaId: barangayId, provinceAreaId, regionAreaId };
}

async function resolveParents(
  pool: Pick<Pool, 'query'> | null,
  townId: string | null,
): Promise<{ provinceAreaId: string | null; regionAreaId: string | null }> {
  if (!pool || !townId) return { provinceAreaId: null, regionAreaId: null };
  try {
    const { rows } = await pool.query(
      `SELECT p.id AS province_id, p.level AS province_level, r.id AS region_id, r.level AS region_level
         FROM admin_areas t
         LEFT JOIN admin_areas p ON p.id = t.parent_id
         LEFT JOIN admin_areas r ON r.id = p.parent_id
        WHERE t.id = $1`,
      [townId],
    );
    const row = rows[0];
    if (!row) return { provinceAreaId: null, regionAreaId: null };
    // A highly urbanised city may sit directly under a region (PSGC); handle both shapes.
    if (row.province_level === 'region') return { provinceAreaId: null, regionAreaId: row.province_id };
    return {
      provinceAreaId: row.province_level === 'province' ? row.province_id : null,
      regionAreaId: row.region_level === 'region' ? row.region_id : null,
    };
  } catch {
    return { provinceAreaId: null, regionAreaId: null };
  }
}

/**
 * Finds town and barangay area IDs for a given coordinate (in-memory polygons; used by
 * resolveSpotAreas when PostGIS geometry is not available).
 */
export function matchSpotToAreas(
  lat: number,
  lng: number,
  municipalityName?: string,
  areas?: AreaRecord[],
): { townAreaId: string | null; barangayAreaId: string | null } {
  const areaList = areas || cachedAreas || [];
  if (areaList.length === 0) {
    return { townAreaId: null, barangayAreaId: null };
  }

  const towns = areaList.filter((a) => a.level === 'town');
  let matchedTown: AreaRecord | null = null;

  // 1. Try point-in-polygon for towns
  for (const town of towns) {
    if (!town.geometry) continue;
    const isInside =
      town.geometry.type === 'Polygon'
        ? pointInPolygon(lng, lat, town.geometry.coordinates)
        : town.geometry.type === 'MultiPolygon'
          ? pointInMultiPolygon(lng, lat, town.geometry.coordinates)
          : false;

    if (isInside) {
      matchedTown = town;
      break;
    }
  }

  // Fallback to name matching if point-in-polygon misses slightly on the border
  if (!matchedTown && municipalityName) {
    const norm = municipalityName.toLowerCase().replace(/ city$/, '');
    matchedTown =
      towns.find(
        (t) =>
          t.name.toLowerCase() === municipalityName.toLowerCase() ||
          t.name.toLowerCase().replace(/ city$/, '') === norm ||
          t.id === norm,
      ) || null;
  }

  // 2. Try point-in-polygon for barangays within the matched town
  let matchedBarangay: AreaRecord | null = null;
  const barangays = areaList.filter((a) => a.level === 'barangay' && (!matchedTown || a.parent_id === matchedTown.id));

  for (const bgy of barangays) {
    if (bgy.has_boundary && bgy.geometry) {
      const isInside =
        bgy.geometry.type === 'Polygon'
          ? pointInPolygon(lng, lat, bgy.geometry.coordinates)
          : bgy.geometry.type === 'MultiPolygon'
            ? pointInMultiPolygon(lng, lat, bgy.geometry.coordinates)
            : false;
      if (isInside) {
        matchedBarangay = bgy;
        break;
      }
    }
  }

  // 3. Fallback for polygon-less barangays (§4 fallback): nearest label point within 1.5 km
  if (!matchedBarangay && matchedTown) {
    let minDistance = 1500; // 1.5 km max
    for (const bgy of barangays) {
      const dist = distanceMeters(lat, lng, bgy.label_lat, bgy.label_lng);
      if (dist < minDistance) {
        minDistance = dist;
        matchedBarangay = bgy;
      }
    }
  }

  return {
    townAreaId: matchedTown?.id || null,
    barangayAreaId: matchedBarangay?.id || null,
  };
}
