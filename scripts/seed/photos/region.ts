// Region / province scoping (owner scope 2026-11-20: launch Region I only, kept parameterised).
// A spot is in scope when its pin falls inside one of the selected COD-AB polygons (the areas
// agent's codab-bundle.ndjson: {lvl, pcode, name, parent, geom}), or — for pins just off a
// generalised coastline — when an on-disk province hint names a selected province.
import fs from 'fs';
import { fold } from './names.js';

type Ring = Array<[number, number]>;
type Poly = Ring[]; // outer ring + holes
export interface Area {
  pcode: string;
  name: string;
  lvl: number;
  parent: string | null;
  polys: Poly[];
  bbox: [number, number, number, number]; // minLng, minLat, maxLng, maxLat
}

function ringContains(ring: Ring, lng: number, lat: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function areaContains(a: Area, lat: number, lng: number): boolean {
  const [x0, y0, x1, y1] = a.bbox;
  if (lng < x0 || lng > x1 || lat < y0 || lat > y1) return false;
  return a.polys.some((p) => ringContains(p[0], lng, lat) && !p.slice(1).some((h) => ringContains(h, lng, lat)));
}

export function toArea(rec: {
  lvl: number;
  pcode: string;
  name: string;
  parent?: string | null;
  geom: string | object;
}): Area {
  const g = (typeof rec.geom === 'string' ? JSON.parse(rec.geom) : rec.geom) as {
    type: string;
    coordinates: number[][][] | number[][][][];
  };
  const polys = (g.type === 'Polygon' ? [g.coordinates] : g.coordinates) as unknown as Poly[];
  let bbox: Area['bbox'] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of polys)
    for (const [x, y] of p[0])
      bbox = [Math.min(bbox[0], x), Math.min(bbox[1], y), Math.max(bbox[2], x), Math.max(bbox[3], y)];
  return { pcode: rec.pcode, name: rec.name, lvl: rec.lvl, parent: rec.parent ?? null, polys, bbox };
}

export interface ScopeSpec {
  /** Region pcode ("0100000000") or name ("Ilocos Region"). */
  region?: string;
  /** Province names or pcodes. */
  provinces?: string[];
}

/**
 * Selected provinces (lvl 2) from the bundle: the region's provinces, plus any listed. Reads the
 * 190 MB bundle line by line but only parses region/province rows.
 */
export function loadScope(bundlePath: string, spec: ScopeSpec): Area[] {
  const want = new Set((spec.provinces ?? []).map((p) => fold(p)));
  const lines = fs.readFileSync(bundlePath, 'utf8').split('\n');
  const regions: Area[] = [];
  const provinces: Array<{ lvl: number; pcode: string; name: string; parent?: string; geom: string }> = [];
  for (const line of lines) {
    const m = /^\{\s*"lvl"\s*:\s*([12])\s*,/.exec(line);
    if (!m) continue;
    const rec = JSON.parse(line);
    if (rec.lvl === 1) regions.push(toArea(rec));
    else provinces.push(rec);
  }
  let regionCode: string | null = null;
  if (spec.region) {
    const r = regions.find((x) => x.pcode === spec.region || fold(x.name) === fold(spec.region!));
    regionCode = r?.pcode ?? (/^\d{10}$/.test(spec.region) ? spec.region : null);
    if (!regionCode) throw new Error(`region not found in bundle: ${spec.region}`);
  }
  const out = provinces
    .filter((p) => (regionCode && p.parent === regionCode) || want.has(fold(p.name)) || want.has(p.pcode))
    .map(toArea);
  if (out.length === 0) throw new Error('scope selects no provinces');
  return out;
}

export function provinceOf(areas: Area[], lat: number, lng: number): Area | null {
  return areas.find((a) => areaContains(a, lat, lng)) ?? null;
}

/** Bbox margin (degrees, ≈ 5 km) for the province-hint fallback. */
export const HINT_MARGIN_DEG = 0.05;

/**
 * In scope by polygon; else when a province hint ("Ilocos Norte;Cagayan") names a selected
 * province AND the pin is within ≈ 5 km of that province's bounding box (coastline slack).
 */
export function inScope(areas: Area[], lat: number, lng: number, provinceHint?: string | null): boolean {
  if (provinceOf(areas, lat, lng)) return true;
  if (!provinceHint) return false;
  const hinted = provinceHint.split(/[;,]/).map((p) => fold(p));
  return areas.some((a) => {
    if (!hinted.includes(fold(a.name))) return false;
    const [x0, y0, x1, y1] = a.bbox;
    const m = HINT_MARGIN_DEG;
    return lng >= x0 - m && lng <= x1 + m && lat >= y0 - m && lat <= y1 + m;
  });
}
