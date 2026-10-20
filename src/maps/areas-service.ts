import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { pointInPolygon, pointInMultiPolygon, computeBbox, distanceMeters, Ring } from './geometry.js';

export interface AreaRecord {
  id: string;
  psgc_code: number;
  level: 'province' | 'town' | 'barangay';
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
      const { rows } = await pool.query(
        `SELECT id, psgc_code, level, name, display_name, parent_id, osm_relation_id, has_boundary,
                label_lat, label_lng, bbox, min_zoom, shape_file, data_version, boundary
           FROM admin_areas WHERE level IN ('town', 'barangay')`
      );
      cachedAreas = rows.map((r: any) => ({
        ...r,
        psgc_code: Number(r.psgc_code),
        label_lat: Number(r.label_lat),
        label_lng: Number(r.label_lng),
        bbox: (r.bbox || []).map(Number) as [number, number, number, number],
        geometry: typeof r.boundary === 'string' ? JSON.parse(r.boundary) : r.boundary ?? undefined,
      }));
      cacheLoadedAt = Date.now();
    } catch (error) {
      console.error('[areas] could not load admin_areas for spot matching:', error instanceof Error ? error.message : error);
    } finally {
      cacheLoading = null;
    }
  })();
  return cacheLoading;
}

/**
 * Finds town and barangay area IDs for a given coordinate.
 */
export function matchSpotToAreas(
  lat: number,
  lng: number,
  municipalityName?: string,
  areas?: AreaRecord[]
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
          t.id === norm
      ) || null;
  }

  // 2. Try point-in-polygon for barangays within the matched town
  let matchedBarangay: AreaRecord | null = null;
  const barangays = areaList.filter(
    (a) => a.level === 'barangay' && (!matchedTown || a.parent_id === matchedTown.id)
  );

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
