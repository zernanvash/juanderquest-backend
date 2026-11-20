// Plan 116: national-scale read paths for the map and typeahead search.
// Both work from the in-memory catalogue (always present) and use PostgreSQL indexes
// (migration 110: trigram + tsvector) for search when they are available.
import type { Pool } from 'pg';
import type { Spot } from './store.js';

export interface MapQuery {
  bbox: [number, number, number, number];
  zoom: number;
  categories?: string[];
  tier?: string;
}

export interface MapMarker {
  id: string;
  slug: string;
  name: string;
  lat: number;
  lng: number;
  category: string;
  tier: string | null;
  thumb: string | null;
}

export interface MapCluster {
  lat: number;
  lng: number;
  count: number;
  bbox: [number, number, number, number];
}

export const MAP_MARKER_LIMIT = 800; // individual markers per response
const CLUSTER_BELOW_ZOOM = 11;

const tierRank = (s: Spot) => (s.launch_tier === 'featured' ? 0 : s.launch_tier === 'review' ? 2 : 1);

export function mapView(spots: Spot[], q: MapQuery): { markers: MapMarker[]; clusters: MapCluster[]; total: number } {
  const [west, south, east, north] = q.bbox;
  const inView = spots.filter(
    (s) =>
      s.status === 'published' &&
      !s.is_test &&
      s.gps_lat >= south &&
      s.gps_lat <= north &&
      s.gps_lng >= west &&
      s.gps_lng <= east &&
      (!q.categories?.length || q.categories.includes(s.category)) &&
      (!q.tier || s.launch_tier === q.tier),
  );
  const toMarker = (s: Spot): MapMarker => ({
    id: s.id,
    slug: s.slug,
    name: s.name,
    lat: s.gps_lat,
    lng: s.gps_lng,
    category: s.category,
    tier: s.launch_tier ?? null,
    thumb: s.image_url || null,
  });
  if (q.zoom >= CLUSTER_BELOW_ZOOM || inView.length <= MAP_MARKER_LIMIT) {
    const markers = [...inView]
      .sort((a, b) => tierRank(a) - tierRank(b) || a.id.localeCompare(b.id))
      .slice(0, MAP_MARKER_LIMIT)
      .map(toMarker);
    return { markers, clusters: [], total: inView.length };
  }
  // Grid clustering: about four cells across one 256 px tile at this zoom.
  const cell = 360 / 2 ** q.zoom / 4;
  const cells = new Map<string, { sumLat: number; sumLng: number; n: number; b: [number, number, number, number] }>();
  for (const s of inView) {
    const key = `${Math.floor(s.gps_lng / cell)}:${Math.floor(s.gps_lat / cell)}`;
    const c = cells.get(key);
    if (c) {
      c.sumLat += s.gps_lat;
      c.sumLng += s.gps_lng;
      c.n += 1;
      c.b = [Math.min(c.b[0], s.gps_lng), Math.min(c.b[1], s.gps_lat), Math.max(c.b[2], s.gps_lng), Math.max(c.b[3], s.gps_lat)];
    } else {
      cells.set(key, { sumLat: s.gps_lat, sumLng: s.gps_lng, n: 1, b: [s.gps_lng, s.gps_lat, s.gps_lng, s.gps_lat] });
    }
  }
  const clusters: MapCluster[] = [];
  const markers: MapMarker[] = [];
  const singles = new Set<string>();
  for (const [key, c] of cells) {
    if (c.n === 1) singles.add(key);
    else
      clusters.push({
        lat: Number((c.sumLat / c.n).toFixed(5)),
        lng: Number((c.sumLng / c.n).toFixed(5)),
        count: c.n,
        bbox: c.b,
      });
  }
  if (singles.size) {
    for (const s of inView) {
      if (singles.has(`${Math.floor(s.gps_lng / cell)}:${Math.floor(s.gps_lat / cell)}`)) markers.push(toMarker(s));
    }
  }
  clusters.sort((a, b) => b.count - a.count);
  return { markers, clusters, total: inView.length };
}

export interface SearchHit {
  id: string;
  slug: string;
  name: string;
  municipality: string;
  category: string;
  tier: string | null;
  thumb: string | null;
}

export const fold = (v: string) =>
  v
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();

/** In-memory typeahead (pg-mem, no-DB dev, or when the SQL path fails). */
export function searchSpotsInMemory(spots: Spot[], query: string, limit: number): SearchHit[] {
  const q = fold(query);
  const scored: Array<{ s: Spot; score: number }> = [];
  for (const s of spots) {
    if (s.status !== 'published' || s.is_test) continue;
    const name = fold(s.name);
    let score = 0;
    if (name.startsWith(q)) score = 3;
    else if (name.split(/[^a-z0-9]+/).some((w) => w.startsWith(q))) score = 2;
    else if (name.includes(q) || fold(s.municipality).includes(q)) score = 1;
    if (score) scored.push({ s, score: score + (s.launch_tier === 'featured' ? 0.5 : 0) });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name))
    .slice(0, limit)
    .map(({ s }) => toHit(s));
}

const toHit = (s: Spot): SearchHit => ({
  id: s.id,
  slug: s.slug,
  name: s.name,
  municipality: s.municipality,
  category: s.category,
  tier: s.launch_tier ?? null,
  thumb: s.image_url || null,
});

export const SEARCH_WORD_SIMILARITY = 0.45;

const escapeLike = (v: string) => v.replace(/[\\%_]/g, (m) => `\\${m}`);

/**
 * Typeahead: unaccented substring + trigram similarity on PostgreSQL (GIN index from 110),
 * results limited to published, non-test spots that the in-memory catalogue knows.
 */
export async function searchSpots(
  pool: Pick<Pool, 'query'> | null,
  spots: Spot[],
  query: string,
  limit: number,
): Promise<SearchHit[]> {
  if (!pool || !(await supportsTrigram(pool))) {
    return searchSpotsInMemory(spots, query, limit);
  }
  try {
    // Word similarity matches a typed word against the best-matching part of a long name
    // ("vigna" → "Vigan Cathedral" 0.50, "paoya" → "Paoay Church" 0.50); plain similarity
    // compares whole strings and misses those. 0.45 measured on Region I (Plan 116 §6.6).
    const { rows } = await pool.query(
      `SELECT id FROM (
         SELECT id, name, launch_tier, f_unaccent(lower(name)) AS n FROM spots
          WHERE status = 'published' AND NOT is_test) s
        WHERE n LIKE '%' || $2 || '%' ESCAPE '\\'
           OR word_similarity(f_unaccent(lower($1)), n) >= $4
        ORDER BY (n LIKE $2 || '%' ESCAPE '\\') DESC,
                 (n LIKE '%' || $2 || '%' ESCAPE '\\') DESC,
                 word_similarity(f_unaccent(lower($1)), n) DESC,
                 (launch_tier = 'featured') DESC NULLS LAST, name
        LIMIT $3`,
      [query, escapeLike(fold(query)), limit, SEARCH_WORD_SIMILARITY],
    );
    const byId = new Map(spots.map((s) => [s.id, s]));
    return rows.map((r) => byId.get(r.id)).filter((s): s is Spot => Boolean(s)).map(toHit);
  } catch {
    return searchSpotsInMemory(spots, query, limit);
  }
}

const trigramByPool = new WeakMap<object, boolean>();
async function supportsTrigram(pool: Pick<Pool, 'query'>): Promise<boolean> {
  const known = trigramByPool.get(pool as object);
  if (known !== undefined) return known;
  let ok = false;
  try {
    const { rows } = await pool.query(
      `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm')
              AND to_regprocedure('f_unaccent(text)') IS NOT NULL AS ok`,
    );
    ok = Boolean(rows[0]?.ok);
  } catch {
    ok = false;
  }
  trigramByPool.set(pool as object, ok);
  return ok;
}
