import type { Pool, PoolClient } from 'pg';
import { env } from '../config/env.js';
import type { TrailCosting, TrailLeg, TrailLegLookup } from './types.js';

export const MAX_TRAIL_MATRIX_NODES = 60;
export const TRAIL_MATRIX_TTL_DAYS = 90;

export interface MatrixPoint { id: string; lat: number; lng: number }
export type MatrixFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export interface MatrixRefreshResult {
  costing: TrailCosting;
  requested: number;
  exact: number;
  approximate: number;
  graphLabel: string;
  nodes: number;
}
export interface MatrixEnsureResult extends MatrixRefreshResult { lookup: TrailLegLookup }
type MatrixEntry = { from: string; to: string; leg: TrailLeg };

function asPoint(r: { id: unknown; gps_lat: unknown; gps_lng: unknown }): MatrixPoint {
  return { id: String(r.id), lat: Number(r.gps_lat), lng: Number(r.gps_lng) };
}

/** Curated refresh is intentionally bounded to published curated-trail stops. */
export async function loadCuratedTrailMatrixPoints(pool: Pool | PoolClient): Promise<MatrixPoint[]> {
  const { rows } = await pool.query(`
    SELECT DISTINCT s.id,s.gps_lat,s.gps_lng
    FROM trails t JOIN trail_stops ts ON ts.trail_id=t.id JOIN spots s ON s.id=ts.spot_id
    WHERE t.source='curated' AND t.status='published' AND t.is_test=FALSE
      AND s.status='published' AND COALESCE(s.is_test,FALSE)=FALSE
      AND s.gps_lat IS NOT NULL AND s.gps_lng IS NOT NULL
    ORDER BY s.id
    LIMIT ${MAX_TRAIL_MATRIX_NODES + 1}
  `);
  const points = rows.map(asPoint);
  assertBounded(points);
  return points;
}

/**
 * Admin refresh can only refresh a curated set. Callers may provide the exact
 * curated point set; the default queries curated trail stops, never all spots.
 */
export async function refreshTravelTimeMatrix(
  pool: Pool | PoolClient,
  costing: TrailCosting = 'auto',
  options: { points?: MatrixPoint[]; fetchImpl?: MatrixFetch; baseUrl?: string; graphLabel?: string; timeoutMs?: number } = {},
): Promise<MatrixRefreshResult> {
  const points = uniquePoints(options.points ?? await loadCuratedTrailMatrixPoints(pool));
  assertBounded(points);
  const entries = await fetchEntries(points, costing, options);
  await persistEntries(pool, costing, entries, options.graphLabel ?? env.VALHALLA_COVERAGE_LABEL);
  return summarize(costing, entries, options.graphLabel ?? env.VALHALLA_COVERAGE_LABEL, points.length);
}

/** Ensure only this generation's selected candidate matrix is fresh, at most 60² pairs. */
export async function ensureTravelTimeMatrix(
  pool: Pool | PoolClient,
  costing: TrailCosting,
  selectedPoints: MatrixPoint[],
  options: { fetchImpl?: MatrixFetch; baseUrl?: string; graphLabel?: string; timeoutMs?: number; now?: Date } = {},
): Promise<MatrixEnsureResult> {
  const points = uniquePoints(selectedPoints);
  assertBounded(points);
  if (!points.length) return { ...summarize(costing, [], options.graphLabel ?? env.VALHALLA_COVERAGE_LABEL, 0), lookup: () => undefined };

  const ids = points.map(point => point.id);
  const cached = await pool.query(`
    SELECT from_spot,to_spot,seconds,meters,approximate
    FROM travel_time_matrix
    WHERE costing=$1 AND from_spot=ANY($2::text[]) AND to_spot=ANY($2::text[])
      AND computed_at >= $3::timestamptz - INTERVAL '${TRAIL_MATRIX_TTL_DAYS} days'
  `, [costing, ids, options.now ?? new Date()]);
  const legs = new Map<string, TrailLeg>();
  for (const row of cached.rows) legs.set(pairKey(String(row.from_spot), String(row.to_spot)), {
    minutes: Number(row.seconds) / 60,
    km: Number(row.meters) / 1000,
    approximate: Boolean(row.approximate),
  });

  const missing: MatrixEntry[] = [];
  for (const from of points) for (const to of points) {
    if (!legs.has(pairKey(from.id, to.id))) missing.push({ from: from.id, to: to.id, leg: { minutes: 0, km: 0, approximate: false } });
  }
  if (missing.length) {
    const fetched = await fetchEntries(points, costing, options);
    const missingKeys = new Set(missing.map(item => pairKey(item.from, item.to)));
    const missingEntries = fetched.filter(item => missingKeys.has(pairKey(item.from, item.to)));
    await persistEntries(pool, costing, missingEntries, options.graphLabel ?? env.VALHALLA_COVERAGE_LABEL);
    for (const item of missingEntries) legs.set(pairKey(item.from, item.to), item.leg);
  }

  const entries = [...legs].map(([key, leg]) => {
    const [from, to] = key.split('\u0000');
    return { from, to, leg };
  });
  return {
    ...summarize(costing, entries, options.graphLabel ?? env.VALHALLA_COVERAGE_LABEL, points.length),
    lookup: (from, to) => legs.get(pairKey(from, to)),
  };
}

export async function readTravelTimeMatrixStatus(pool: Pool | PoolClient) {
  const { rows } = await pool.query(`SELECT costing,COUNT(*)::int AS rows,
    COUNT(*) FILTER (WHERE approximate)::int AS approximate_count, MAX(computed_at) AS last_computed,
    (array_agg(graph_label ORDER BY computed_at DESC))[1] AS graph_label
    FROM travel_time_matrix GROUP BY costing ORDER BY costing`);
  return rows;
}

/** Benchmark-only unrestricted cache read. User-facing generation uses ensureTravelTimeMatrix. */
export async function loadTravelTimeLookup(pool: Pool | PoolClient, costing: TrailCosting, points?: MatrixPoint[]): Promise<TrailLegLookup> {
  if (points) {
    const ids = uniquePoints(points).map(point => point.id);
    if (!ids.length) return () => undefined;
    const { rows } = await pool.query(`SELECT from_spot,to_spot,seconds,meters,approximate FROM travel_time_matrix
      WHERE costing=$1 AND from_spot=ANY($2::text[]) AND to_spot=ANY($2::text[])`, [costing, ids]);
    return lookupFromRows(rows);
  }
  const { rows } = await pool.query('SELECT from_spot,to_spot,seconds,meters,approximate FROM travel_time_matrix WHERE costing=$1', [costing]);
  return lookupFromRows(rows);
}

function lookupFromRows(rows: Array<Record<string, unknown>>): TrailLegLookup {
  const map = new Map<string, TrailLeg>();
  for (const row of rows) map.set(pairKey(String(row.from_spot), String(row.to_spot)), {
    minutes: Number(row.seconds) / 60,
    km: Number(row.meters) / 1000,
    approximate: Boolean(row.approximate),
  });
  return (from, to) => map.get(pairKey(from, to));
}

async function fetchEntries(
  points: MatrixPoint[],
  costing: TrailCosting,
  options: { fetchImpl?: MatrixFetch; baseUrl?: string; timeoutMs?: number },
): Promise<MatrixEntry[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = (options.baseUrl ?? env.VALHALLA_URL).replace(/\/$/, '');
  let cells: unknown[][] | undefined;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
    timeout.unref?.();
    try {
      const response = await fetchImpl(`${baseUrl}/sources_to_targets`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({
          sources: points.map(point => ({ lat: point.lat, lon: point.lng })),
          targets: points.map(point => ({ lat: point.lat, lon: point.lng })),
          costing: valhallaCosting(costing),
        }),
      });
      if (!response.ok) throw new Error(`Valhalla matrix returned ${response.status}`);
      const body = await response.json() as { sources_to_targets?: unknown[][] };
      cells = body.sources_to_targets;
    } finally { clearTimeout(timeout); }
  } catch { cells = undefined; }

  const entries: MatrixEntry[] = [];
  for (let i = 0; i < points.length; i++) for (let j = 0; j < points.length; j++) {
    const source = points[i], target = points[j];
    const cell = cells?.[i]?.[j] as { time?: number; distance?: number; error?: unknown } | undefined;
    const usable = source.id === target.id || (cell && Number.isFinite(cell.time) && Number.isFinite(cell.distance) && cell.time! >= 0 && cell.distance! >= 0);
    const leg = source.id === target.id
      ? { minutes: 0, km: 0, approximate: false }
      : usable
        ? { minutes: cell!.time! / 60, km: cell!.distance!, approximate: false }
        : fallbackLeg(source, target, costing);
    entries.push({ from: source.id, to: target.id, leg });
  }
  return entries;
}

async function persistEntries(pool: Pool | PoolClient, costing: TrailCosting, entries: MatrixEntry[], graphLabel: string): Promise<void> {
  if (!entries.length) return;
  // pg.PoolClient also has connect(), but it is already checked out; use the
  // release() capability to distinguish it from the owning Pool.
  const ownsClient = typeof (pool as Pool).connect === 'function' && typeof (pool as PoolClient).release !== 'function';
  const client = ownsClient ? await (pool as Pool).connect() : pool as PoolClient;
  try {
    if (ownsClient) await client.query('BEGIN');
    await client.query(`
      INSERT INTO travel_time_matrix (costing,from_spot,to_spot,seconds,meters,approximate,graph_label,computed_at)
      SELECT $1,from_spot,to_spot,seconds,meters,approximate,$7,$8
      FROM UNNEST($2::text[],$3::text[],$4::integer[],$5::integer[],$6::boolean[])
        AS rows(from_spot,to_spot,seconds,meters,approximate)
      ON CONFLICT (costing,from_spot,to_spot) DO UPDATE SET seconds=EXCLUDED.seconds,meters=EXCLUDED.meters,
        approximate=EXCLUDED.approximate,graph_label=EXCLUDED.graph_label,computed_at=EXCLUDED.computed_at
    `, [costing, entries.map(item => item.from), entries.map(item => item.to),
      entries.map(item => Math.round(item.leg.minutes * 60)), entries.map(item => Math.round(item.leg.km * 1000)),
      entries.map(item => item.leg.approximate), graphLabel, new Date()]);
    if (ownsClient) await client.query('COMMIT');
  } catch (error) {
    if (ownsClient) await client.query('ROLLBACK');
    throw error;
  } finally { if (ownsClient) client.release(); }
}

function summarize(costing: TrailCosting, entries: MatrixEntry[], graphLabel: string, nodes: number): MatrixRefreshResult {
  const approximate = entries.filter(item => item.leg.approximate).length;
  return { costing, requested: entries.length, exact: entries.length - approximate, approximate, graphLabel, nodes };
}

function uniquePoints(points: MatrixPoint[]): MatrixPoint[] {
  const unique = [...new Map(points.map(point => [point.id, point])).values()];
  for (const point of unique) {
    if (!point.id || !Number.isFinite(point.lat) || !Number.isFinite(point.lng) || Math.abs(point.lat) > 90 || Math.abs(point.lng) > 180) {
      throw new Error('Matrix points require unique IDs and valid coordinates.');
    }
  }
  return unique;
}

function assertBounded(points: MatrixPoint[]): void {
  if (points.length > MAX_TRAIL_MATRIX_NODES) throw new Error(`Trail matrix is limited to ${MAX_TRAIL_MATRIX_NODES} candidate nodes.`);
}

function pairKey(from: string, to: string) { return `${from}\u0000${to}`; }
function valhallaCosting(costing: TrailCosting) { return costing === 'auto' ? 'auto' : costing; }
function fallbackLeg(a: MatrixPoint, b: MatrixPoint, costing: TrailCosting): TrailLeg {
  const radians = (n: number) => n * Math.PI / 180;
  const h = Math.sin(radians(b.lat - a.lat) / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(radians(b.lng - a.lng) / 2) ** 2;
  const km = 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)) * 1.35;
  const speed = costing === 'pedestrian' ? 4.5 : 35;
  return { minutes: km / speed * 60, km, approximate: true };
}
