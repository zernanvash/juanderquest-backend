import type { Pool, PoolClient } from 'pg';
import { env } from '../config/env.js';
import type { TrailCosting, TrailLeg, TrailLegLookup } from './types.js';

export interface MatrixPoint { id: string; lat: number; lng: number }
export type MatrixFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export interface MatrixRefreshResult { costing: TrailCosting; requested: number; exact: number; approximate: number; graphLabel: string }

function asPoint(r: { id: unknown; gps_lat: unknown; gps_lng: unknown }): MatrixPoint {
  return { id: String(r.id), lat: Number(r.gps_lat), lng: Number(r.gps_lng) };
}

export async function loadMatrixPoints(pool: Pool | PoolClient): Promise<MatrixPoint[]> {
  const { rows } = await pool.query(`SELECT id,gps_lat,gps_lng FROM spots WHERE status='published' AND COALESCE(is_test,FALSE)=FALSE AND gps_lat IS NOT NULL AND gps_lng IS NOT NULL ORDER BY id`);
  return rows.map(asPoint);
}

export async function refreshTravelTimeMatrix(
  pool: Pool | PoolClient,
  costing: TrailCosting = 'auto',
  options: { points?: MatrixPoint[]; fetchImpl?: MatrixFetch; baseUrl?: string; graphLabel?: string; timeoutMs?: number } = {},
): Promise<MatrixRefreshResult> {
  const points = options.points ?? await loadMatrixPoints(pool);
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = (options.baseUrl ?? env.VALHALLA_URL).replace(/\/$/, '');
  const graphLabel = options.graphLabel ?? env.VALHALLA_COVERAGE_LABEL;
  const entries: Array<{ from: string; to: string; leg: TrailLeg }> = [];
  for (let sourceAt = 0; sourceAt < points.length; sourceAt += 50) {
    const sources = points.slice(sourceAt, sourceAt + 50);
    for (let targetAt = 0; targetAt < points.length; targetAt += 50) {
      const targets = points.slice(targetAt, targetAt + 50);
      let cells: unknown[][] | undefined;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
        try {
          const response = await fetchImpl(`${baseUrl}/sources_to_targets`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
            body: JSON.stringify({ sources: sources.map(p => ({ lat: p.lat, lon: p.lng })), targets: targets.map(p => ({ lat: p.lat, lon: p.lng })), costing: valhallaCosting(costing) }),
          });
          if (!response.ok) throw new Error(`Valhalla matrix returned ${response.status}`);
          const body = await response.json() as { sources_to_targets?: unknown[][] };
          cells = body.sources_to_targets;
        } finally { clearTimeout(timeout); }
      } catch { cells = undefined; }
      for (let i = 0; i < sources.length; i++) for (let j = 0; j < targets.length; j++) {
        const source = sources[i], target = targets[j];
        if (source.id === target.id) { entries.push({ from: source.id, to: target.id, leg: { minutes: 0, km: 0, approximate: false } }); continue; }
        const cell = cells?.[i]?.[j] as { time?: number; distance?: number; error?: unknown } | undefined;
        const usable = cell && Number.isFinite(cell.time) && Number.isFinite(cell.distance) && cell.time! >= 0 && cell.distance! >= 0;
        const leg = usable ? { minutes: cell!.time! / 60, km: cell!.distance!, approximate: false } : fallbackLeg(source, target, costing);
        entries.push({ from: source.id, to: target.id, leg });
      }
    }
  }
  const client = 'connect' in pool ? await (pool as Pool).connect() : pool as PoolClient;
  const ownsClient = client !== pool;
  let exact = 0, approximate = 0;
  try {
    await client.query('BEGIN');
    for (const item of entries) {
      const leg = item.leg;
      await client.query(`INSERT INTO travel_time_matrix (costing,from_spot,to_spot,seconds,meters,approximate,graph_label,computed_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,clock_timestamp())
        ON CONFLICT (costing,from_spot,to_spot) DO UPDATE SET seconds=EXCLUDED.seconds,meters=EXCLUDED.meters,approximate=EXCLUDED.approximate,graph_label=EXCLUDED.graph_label,computed_at=EXCLUDED.computed_at`,
      [costing, item.from, item.to, Math.round(leg.minutes * 60), Math.round(leg.km * 1000), leg.approximate, graphLabel]);
      if (leg.approximate) approximate++; else exact++;
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { if (ownsClient) client.release(); }
  return { costing, requested: entries.length, exact, approximate, graphLabel };
}

export async function readTravelTimeMatrixStatus(pool: Pool | PoolClient) {
  const { rows } = await pool.query(`SELECT costing,COUNT(*)::int AS rows,
    COUNT(*) FILTER (WHERE approximate)::int AS approximate_count, MAX(computed_at) AS last_computed,
    (array_agg(graph_label ORDER BY computed_at DESC))[1] AS graph_label
    FROM travel_time_matrix GROUP BY costing ORDER BY costing`);
  return rows;
}

export async function loadTravelTimeLookup(pool: Pool | PoolClient, costing: TrailCosting): Promise<TrailLegLookup> {
  const { rows } = await pool.query('SELECT from_spot,to_spot,seconds,meters,approximate FROM travel_time_matrix WHERE costing=$1', [costing]);
  const map = new Map<string, TrailLeg>();
  for (const r of rows) map.set(`${r.from_spot}\u0000${r.to_spot}`, { minutes: Number(r.seconds) / 60, km: Number(r.meters) / 1000, approximate: Boolean(r.approximate) });
  return (from, to) => map.get(`${from}\u0000${to}`);
}

function valhallaCosting(costing: TrailCosting) { return costing === 'auto' ? 'auto' : costing; }
function fallbackLeg(a: MatrixPoint, b: MatrixPoint, costing: TrailCosting): TrailLeg {
  const radians = (n: number) => n * Math.PI / 180;
  const h = Math.sin(radians(b.lat - a.lat) / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(radians(b.lng - a.lng) / 2) ** 2;
  const km = 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)) * 1.35;
  const speed = costing === 'pedestrian' ? 4.5 : 35;
  return { minutes: km / speed * 60, km, approximate: true };
}
