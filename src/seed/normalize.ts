export type ImportCategory = 'nature_outdoors' | 'culture_heritage' | 'activities_wellness' | 'eat_drink' | 'shopping_local' | 'stay';

export interface SeedPhoto {
  title: string;
  thumbnail_url: string;
  author: string;
  license: string;
  attribution_url: string;
}

export interface DestinationCandidate {
  external_refs: Record<string, string>;
  name: string;
  description: string;
  category: ImportCategory;
  subcategory: string;
  tags: string[];
  municipality: string;
  address: string;
  gps_lat: number;
  gps_lng: number;
  hours: Record<string, string>;
  official_website?: string;
  wikipedia?: string;
  photo?: SeedPhoto;
  field_sources: Record<string, unknown>;
  import_confidence: number;
  import_wave: string;
  review_only?: boolean;
}

type Feature = { type: 'Feature'; id?: string | number; properties?: Record<string, any>; geometry?: any };

const STRONG: Record<string, Set<string>> = {
  tourism: new Set(['attraction', 'viewpoint', 'museum', 'theme_park', 'zoo', 'aquarium', 'gallery']),
  natural: new Set(['beach', 'waterfall', 'peak', 'hot_spring', 'cave_entrance', 'spring', 'volcano']),
  historic: new Set(['monument', 'memorial', 'ruins', 'castle', 'fort', 'archaeological_site', 'heritage']),
  leisure: new Set(['park', 'nature_reserve', 'garden', 'beach_resort']),
};
const GENERIC = new Set(['beach', 'church', 'park', 'waterfall', 'museum', 'viewpoint', 'attraction', 'resort', 'plaza']);

function pointInRing(x: number, y: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (((yi > y) !== (yj > y)) && x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-12) + xi) inside = !inside;
  }
  return inside;
}

function interiorPoint(ring: number[][], holes: number[][][] = []): [number, number] | null {
  const points = ring.slice(0, -1);
  const area = points.reduce((sum, p, i) => {
    const next = points[(i + 1) % points.length];
    return sum + p[0] * next[1] - next[0] * p[1];
  }, 0) / 2;
  if (Math.abs(area) > 1e-12) {
    let x = 0, y = 0;
    for (let i = 0; i < points.length; i++) {
      const p = points[i], next = points[(i + 1) % points.length], cross = p[0] * next[1] - next[0] * p[1];
      x += (p[0] + next[0]) * cross; y += (p[1] + next[1]) * cross;
    }
    const centroid: [number, number] = [x / (6 * area), y / (6 * area)];
    if (pointInRing(centroid[0], centroid[1], ring) && !holes.some(hole => pointInRing(centroid[0], centroid[1], hole))) return centroid;
  }
  const ys = points.map(p => p[1]).sort((a, b) => a - b);
  const minScanY = ys[0], maxScanY = ys[ys.length - 1];
  for (let yi = 1; yi < ys.length; yi++) {
    const y = (ys[yi - 1] + ys[yi]) / 2;
    if (y <= minScanY + 1e-12 || y >= maxScanY - 1e-12) continue;
    const intersections: number[] = [];
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const [x1, y1] = points[j], [x2, y2] = points[i];
      if ((y1 > y) !== (y2 > y)) intersections.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1));
    }
    intersections.sort((a, b) => a - b);
    for (let i = 0; i + 1 < intersections.length; i += 2) {
      const candidate: [number, number] = [(intersections[i] + intersections[i + 1]) / 2, y];
      if (pointInRing(candidate[0], candidate[1], ring) && !holes.some(hole => pointInRing(candidate[0], candidate[1], hole))) return candidate;
    }
  }
  // A valid polygon has non-zero interior. Search the outer bbox grid rather than
  // returning a point that might land inside a hole for narrow/concave shapes.
  const xs = points.map(p => p[0]), minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...points.map(p => p[1])), maxY = Math.max(...points.map(p => p[1]));
  for (let yi = 1; yi < 20; yi++) for (let xi = 1; xi < 20; xi++) {
    const candidate: [number, number] = [minX + (maxX - minX) * xi / 20, minY + (maxY - minY) * yi / 20];
    if (pointInRing(candidate[0], candidate[1], ring) && !holes.some(hole => pointInRing(candidate[0], candidate[1], hole))) return candidate;
  }
  return null;
}

export function representativePoint(geometry: any): [number, number] | null {
  if (!geometry) return null;
  if (geometry.type === 'Point' && Array.isArray(geometry.coordinates)) return geometry.coordinates as [number, number];
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
  let largest: number[][][] | undefined;
  for (const polygon of polygons) {
    const outer = polygon?.[0];
    if (Array.isArray(outer) && (!largest || Math.abs(ringArea(outer)) > Math.abs(ringArea(largest[0])))) largest = polygon;
  }
  return largest ? interiorPoint(largest[0], largest.slice(1)) : null;
}

function ringArea(ring: number[][]): number {
  return ring.slice(0, -1).reduce((sum, point, i, points) => {
    const next = points[(i + 1) % points.length];
    return sum + point[0] * next[1] - next[0] * point[1];
  }, 0) / 2;
}

function categoryFor(tags: Record<string, any>): { category: ImportCategory; subcategory: string } | null {
  if (tags.natural || tags.boundary === 'protected_area' || tags.leisure === 'nature_reserve' || tags.leisure === 'garden' || tags.leisure === 'park') {
    return { category: 'nature_outdoors', subcategory: tags.natural || tags.leisure || 'nature_site' };
  }
  if (tags.historic || tags.amenity === 'place_of_worship' || tags.tourism === 'museum' || tags.tourism === 'gallery') {
    return { category: 'culture_heritage', subcategory: tags.historic || (tags.amenity === 'place_of_worship' ? 'place_of_worship' : tags.tourism) };
  }
  if (tags.tourism === 'hotel' || tags.tourism === 'hostel' || tags.tourism === 'guest_house' || tags.tourism === 'camp_site') return { category: 'stay', subcategory: tags.tourism };
  if (tags.shop) return { category: 'shopping_local', subcategory: tags.shop };
  if (tags.amenity === 'restaurant' || tags.amenity === 'cafe' || tags.amenity === 'fast_food' || tags.amenity === 'bar') return { category: 'eat_drink', subcategory: tags.amenity };
  if (tags.leisure || tags.tourism === 'viewpoint' || tags.tourism === 'attraction') return { category: 'activities_wellness', subcategory: tags.leisure || tags.tourism };
  return null;
}

export function normalizeOsmFeature(feature: Feature, wave: string): DestinationCandidate | null {
  const tags = feature.properties || {};
    const name = String(tags.name || tags['name:en'] || '').trim();
  if (!name || name.length > 200) return null;
  const normalized = categoryFor(tags);
  if (!normalized) return null;
  if (tags.amenity === 'place_of_worship' && !tags.heritage && !tags.wikidata && !tags.tourism) return null;
  const coordinates = representativePoint(feature.geometry);
  if (!coordinates || !coordinates.every(Number.isFinite)) return null;
  const [gps_lng, gps_lat] = coordinates;
  if (gps_lat < -90 || gps_lat > 90 || gps_lng < -180 || gps_lng > 180) return null;
  const featureRef = String(tags['@id'] || feature.id || '');
  const typeAndId = featureRef.match(/^(node|way|relation)\/(\d+)$/) ||
    (tags['@type'] && /^\d+$/.test(featureRef) ? [null, String(tags['@type']), featureRef] : null) ||
    (featureRef.match(/^([nwa])(\d+)$/) ? (() => {
      const prefix = featureRef[0], id = BigInt(featureRef.slice(1));
      if (prefix === 'a') return id % 2n === 0n ? [null, 'way', String(id / 2n)] : [null, 'relation', String((id - 1n) / 2n)];
      return [null, prefix === 'n' ? 'node' : 'way', String(id)];
    })() : null);
  if (!typeAndId) return null;
  const osmRef = `${typeAndId[1]}/${typeAndId[2]}`;
  const strong = Object.entries(STRONG).some(([key, values]) => values.has(String(tags[key] || '')));
  const hasHoursOrSite = Boolean(tags.opening_hours || tags.website || tags['contact:website']);
  const generic = GENERIC.has(name.toLowerCase());
  const confidence = Math.max(0, Math.min(1, (tags.wikidata ? 0.4 : 0) + (strong ? 0.1 : 0) + (hasHoursOrSite ? 0.1 : 0) - (generic ? 0.3 : 0)));
  const sourceUrl = `https://www.openstreetmap.org/${osmRef}`;
  return {
    external_refs: { osm: osmRef, ...(tags.wikidata ? { wikidata: String(tags.wikidata) } : {}) },
    name,
    description: '',
    category: normalized.category,
    subcategory: normalized.subcategory,
    tags: [],
    municipality: String(tags['addr:city'] || tags['addr:municipality'] || tags['is_in:city'] || '').trim(),
    address: String(tags['addr:full'] || '').trim(),
    gps_lat,
    gps_lng,
    hours: tags.opening_hours ? { source_text: String(tags.opening_hours) } : {},
    official_website: safeWebUrl(tags.website || tags['contact:website']),
    wikipedia: tags.wikipedia || undefined,
    field_sources: {
      name: { source: 'openstreetmap', url: sourceUrl },
      category: { source: 'openstreetmap', url: sourceUrl },
      coordinates: { source: 'openstreetmap', url: sourceUrl },
      osm_tags: tags,
      ...(tags.opening_hours ? { hours: { source: 'openstreetmap', url: sourceUrl, retrieved_at: new Date().toISOString(), reviewed: true } } : {}),
      ...(safeWebUrl(tags.website || tags['contact:website']) ? { official_website: { source: 'openstreetmap', url: sourceUrl, retrieved_at: new Date().toISOString(), reviewed: true } } : {}),
    },
    import_confidence: confidence,
    import_wave: wave,
    review_only: Boolean(generic),
  };
}

function safeWebUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim().includes('://') ? value.trim() : `https://${value.trim()}`);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : undefined;
  } catch { return undefined; }
}

export function isAutoPublishCandidate(candidate: DestinationCandidate): boolean {
  // A Commons photo is preferred but not a publication prerequisite: Plan 46
  // explicitly uses the category illustration when no suitable free photo is
  // available. The confidence threshold remains the publishing gate.
  // Scraped facts are always review-only even when the destination itself has
  // enough independent open-data evidence to meet the confidence threshold.
  return candidate.import_confidence >= 0.6 && !candidate.review_only && !candidate.field_sources.scraped_pending;
}
