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
