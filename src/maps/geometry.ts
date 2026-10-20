/**
 * Spatial area matching and point-in-polygon assignment for admin_areas.
 * Uses ray-casting algorithm for GeoJSON Polygon and MultiPolygon geometries.
 */

export interface Point {
  lat: number;
  lng: number;
}

export type Ring = [number, number][]; // [lng, lat]

/**
 * Checks whether a 2D point [lng, lat] is inside a polygon ring using ray casting.
 */
export function pointInRing(lng: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];

    const intersect = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Checks whether a point [lng, lat] is inside a GeoJSON Polygon (accounting for outer ring and holes).
 */
export function pointInPolygon(lng: number, lat: number, coordinates: Ring[]): boolean {
  if (!coordinates || coordinates.length === 0) return false;
  // Point must be inside the outer ring (index 0)
  if (!pointInRing(lng, lat, coordinates[0])) return false;
  // Point must NOT be inside any hole (indices 1+)
  for (let i = 1; i < coordinates.length; i++) {
    if (pointInRing(lng, lat, coordinates[i])) {
      return false;
    }
  }
  return true;
}

/**
 * Checks whether a point [lng, lat] is inside a GeoJSON MultiPolygon.
 */
export function pointInMultiPolygon(lng: number, lat: number, coordinates: Ring[][]): boolean {
  if (!coordinates) return false;
  for (const polygon of coordinates) {
    if (pointInPolygon(lng, lat, polygon)) {
      return true;
    }
  }
  return false;
}

/**
 * Computes bounding box [minLng, minLat, maxLng, maxLat] from polygon/multipolygon coordinates.
 */
export function computeBbox(geometry: { type: string; coordinates: any }): [number, number, number, number] {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;

  function traverse(coords: any) {
    if (typeof coords[0] === 'number') {
      const [lng, lat] = coords;
      if (lng < minLng) minLng = lng;
      if (lat < minLat) minLat = lat;
      if (lng > maxLng) maxLng = lng;
      if (lat > maxLat) maxLat = lat;
    } else {
      for (const c of coords) {
        traverse(c);
      }
    }
  }

  traverse(geometry.coordinates);
  return [minLng, minLat, maxLng, maxLat];
}

/**
 * Calculates Haversine distance in meters between two lat/lng points.
 */
export function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000; // meters
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Generates a circular polygon around a label point with radius in meters (default 600m) with N vertices.
 */
export function createCirclePolygon(centerLng: number, centerLat: number, radiusMeters = 600, points = 32): Ring[] {
  const coords: [number, number][] = [];
  const km = radiusMeters / 1000;
  const latR = centerLat * (Math.PI / 180);

  for (let i = 0; i <= points; i++) {
    const angle = (i * 2 * Math.PI) / points;
    const dLat = (km * Math.cos(angle)) / 111.32;
    const dLng = (km * Math.sin(angle)) / (111.32 * Math.cos(latR));
    coords.push([centerLng + dLng, centerLat + dLat]);
  }

  return [coords];
}
