// Plan 116 destinations: representative point of an OSM geometry (inside the shape, not a bbox centre).

type Pos = [number, number]; // [lng, lat]
export type Geometry =
  | { type: 'Point'; coordinates: Pos }
  | { type: 'LineString'; coordinates: Pos[] }
  | { type: 'Polygon'; coordinates: Pos[][] }
  | { type: 'MultiPolygon'; coordinates: Pos[][][] };

function ringArea(ring: Pos[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return Math.abs(a / 2);
}

function inRing(p: Pos, ring: Pos[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function inPolygon(p: Pos, polygon: Pos[][]): boolean {
  return inRing(p, polygon[0]) && !polygon.slice(1).some((hole) => inRing(p, hole));
}

function polygonPoint(polygon: Pos[][]): Pos {
  const ring = polygon[0];
  let cx = 0;
  let cy = 0;
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    cx += (ring[j][0] + ring[i][0]) * f;
    cy += (ring[j][1] + ring[i][1]) * f;
    a += f;
  }
  const centroid: Pos = a ? [cx / (3 * a), cy / (3 * a)] : ring[0];
  if (inPolygon(centroid, polygon)) return centroid;
  // Scanline through the centroid latitude: midpoint of the widest inside segment.
  const y = centroid[1];
  const xs: number[] = [];
  for (const r of polygon)
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i];
      const [xj, yj] = r[j];
      if (yi > y !== yj > y) xs.push(((xj - xi) * (y - yi)) / (yj - yi) + xi);
    }
  xs.sort((m, n) => m - n);
  let best: Pos | null = null;
  let width = -1;
  for (let i = 0; i + 1 < xs.length; i += 2)
    if (xs[i + 1] - xs[i] > width) {
      width = xs[i + 1] - xs[i];
      best = [(xs[i] + xs[i + 1]) / 2, y];
    }
  return best ?? ring[0];
}

/** [lng, lat] of a point on the feature: the point itself, the middle vertex of a line, inside a polygon. */
export function representativePoint(g: Geometry): Pos | null {
  if (!g) return null;
  if (g.type === 'Point') return g.coordinates;
  if (g.type === 'LineString') return g.coordinates[Math.floor(g.coordinates.length / 2)] ?? null;
  if (g.type === 'Polygon') return polygonPoint(g.coordinates);
  if (g.type === 'MultiPolygon') {
    const largest = [...g.coordinates].sort((a, b) => ringArea(b[0]) - ringArea(a[0]))[0];
    return largest ? polygonPoint(largest) : null;
  }
  return null;
}
