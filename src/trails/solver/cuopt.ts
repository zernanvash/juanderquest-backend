import { env } from '../../config/env.js';
import { readNimApiKey, TrailAiError } from '../ai/client.js';
import type { TrailLegLookup, TrailProblem, TrailSolution } from '../types.js';
import { createLegLookup, evaluateOrder } from './index.js';

export const CUOPT_SUBMIT_URL = 'https://optimize.api.nvidia.com/v1/nvidia/cuopt';
export const CUOPT_STATUS_URL = 'https://optimize.api.nvidia.com/v1/status';
const MAX_RUNTIME_MS = 60_000;

type CuoptData = Record<string, unknown>;
export interface CuoptOptions {
  baseUrl?: string;
  statusBaseUrl?: string;
  fetcher?: typeof fetch;
  getApiKey?: () => Promise<string>;
  timeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  allowInsecureLocalhost?: boolean;
}

export class CuoptError extends Error {
  constructor(readonly code: 'CUOPT_DISABLED' | 'CUOPT_UNAVAILABLE' | 'CUOPT_TIMEOUT' | 'CUOPT_MALFORMED' | 'CUOPT_INFEASIBLE') {
    super(code);
  }
}

/** The managed-service envelope and field names follow NVIDIA's cuOpt OpenAPI. */
export function buildCuoptRequest(problem: TrailProblem, matrix?: TrailLegLookup): { action: string; data: CuoptData; parameters: Record<string, never>; client_version: string } {
  const legFor = createLegLookup(problem, matrix);
  const taskNodes = problem.nodes.filter(node => !problem.exclude.includes(node.spotId));
  const ids = taskNodes.map(node => node.spotId);
  if (ids.length < problem.minStops) throw new CuoptError('CUOPT_INFEASIBLE');
  const index = new Map(ids.map((id, i) => [id, i + 1]));
  const count = ids.length + 1; // index 0 is the vehicle's start/depot.
  const travelSeconds = Array.from({ length: count }, (_, from) => Array.from({ length: count }, (_, to) => {
    if (from === to) return 0;
    // No explicit start means the first stop is the itinerary origin; do not
    // invent an extra outbound or return journey.
    if (from === 0 && !problem.startNode || to === 0 && !problem.startNode) return 0;
    const fromId = from === 0 ? (typeof problem.startNode === 'string' ? problem.startNode : undefined) : ids[from - 1];
    const toId = to === 0 ? (typeof problem.startNode === 'string' ? problem.startNode : undefined) : ids[to - 1];
    let minutes: number;
    if (fromId && toId) minutes = legFor(fromId, toId)?.minutes ?? Number.POSITIVE_INFINITY;
    else if (from === 0 && typeof problem.startNode === 'object') {
      const target = problem.nodes[to - 1];
      if (!target) return 0;
      const a = problem.startNode;
      const b = { lat: target.lat, lng: target.lng };
      const radians = (n: number) => n * Math.PI / 180;
      const dLat = radians((b.lat ?? 0) - a.lat), dLng = radians((b.lng ?? 0) - a.lng);
      const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat ?? 0)) * Math.sin(dLng / 2) ** 2;
      const km = 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)) * 1.35;
      minutes = km / (problem.costing === 'pedestrian' ? 4.5 : 35) * 60;
    } else if (to === 0 && typeof problem.startNode === 'object') {
      const source = problem.nodes[from - 1];
      if (!source) return 0;
      const a = { lat: source.lat, lng: source.lng }, b = problem.startNode;
      const radians = (n: number) => n * Math.PI / 180;
      const dLat = radians(b.lat - (a.lat ?? 0)), dLng = radians(b.lng - (a.lng ?? 0));
      const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.lat ?? 0)) * Math.cos(radians(b.lat)) * Math.sin(dLng / 2) ** 2;
      const km = 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)) * 1.35;
      minutes = km / (problem.costing === 'pedestrian' ? 4.5 : 35) * 60;
    } else return 0;
    return Number.isFinite(minutes) ? Math.max(0, Math.round(minutes * 60)) : 2_147_483_647;
  }));
  const taskWindows = taskNodes.map(node => {
    const dayEnd = problem.dayStartMin + problem.budgetMin;
    if (!node.windows.length) return [problem.dayStartMin * 60, dayEnd * 60];
    const start = Math.max(problem.dayStartMin, Math.min(...node.windows.map(window => window[0])));
    const end = Math.min(dayEnd, Math.max(...node.windows.map(window => window[1])));
    return [start * 60, Math.max(start, end) * 60];
  });
  const prizes = taskNodes.map(node => Math.max(0, Math.round(node.value * 10_000)));
  const data: CuoptData = {
    cost_matrix_data: { cost_matrix: { '0': travelSeconds } },
    travel_time_matrix_data: { cost_matrix: { '0': travelSeconds } },
    fleet_data: { vehicle_locations: [[0, 0]], vehicle_ids: ['trail-benchmark-vehicle'], vehicle_time_windows: [[problem.dayStartMin * 60, (problem.dayStartMin + problem.budgetMin) * 60]], skip_first_trips: [!problem.startNode], drop_return_trips: [true], vehicle_max_times: [problem.budgetMin * 60] },
    task_data: { task_locations: ids.map(id => index.get(id)!), service_times: taskNodes.map(node => node.dwellMin * 60), task_time_windows: taskWindows, prizes },
    solver_config: { time_limit: 15, objectives: { travel_time: 0.5, prize: 1 } },
  };
  return { action: 'cuOpt_OptimizedRouting', data, parameters: {}, client_version: 'custom' };
}

export function isCuoptEnabled(): boolean {
  return env.TRAILS_CUOPT_ENABLED && env.NODE_ENV !== 'test';
}

export function createCuoptSolver(options: CuoptOptions = {}) {
  const fetcher = options.fetcher ?? fetch;
  const getApiKey = options.getApiKey ?? readNimApiKey;
  const timeoutMs = Math.min(MAX_RUNTIME_MS, Math.max(1, options.timeoutMs ?? MAX_RUNTIME_MS));
  const pollIntervalMs = Math.max(10, options.pollIntervalMs ?? 500);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const submitUrl = options.baseUrl ?? CUOPT_SUBMIT_URL;
  const statusUrl = options.statusBaseUrl ?? CUOPT_STATUS_URL;

  async function solve(problem: TrailProblem, matrix?: TrailLegLookup): Promise<TrailSolution> {
    if (!options.getApiKey && !isCuoptEnabled()) throw new CuoptError('CUOPT_DISABLED');
    let key: string;
    try { key = await getApiKey(); }
    catch (error) {
      if (error instanceof TrailAiError) throw new CuoptError('CUOPT_DISABLED');
      throw new CuoptError('CUOPT_DISABLED');
    }
    if (!key) throw new CuoptError('CUOPT_DISABLED');
    validateEndpoint(submitUrl, options.allowInsecureLocalhost);
    validateEndpoint(statusUrl, options.allowInsecureLocalhost);
    const startedAt = now();
    const deadline = startedAt + timeoutMs;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    const headers = { authorization: `Bearer ${key}`, accept: 'application/json', 'content-type': 'application/json' };
    try {
      const response = await fetcher(submitUrl, { method: 'POST', headers, body: JSON.stringify(buildCuoptRequest(problem, matrix)), signal: controller.signal });
      if (!response.ok && response.status !== 202) throw new CuoptError('CUOPT_UNAVAILABLE');
      let body = await safeJson(response);
      if (response.status === 202) {
        const requestId = response.headers.get('NVCF-REQID') ?? bodyRequestId(body);
        if (!requestId || requestId.length > 36 || !/^[A-Za-z0-9-]+$/.test(requestId)) throw new CuoptError('CUOPT_MALFORMED');
        const pollEndpoint = `${statusUrl.replace(/\/$/, '')}/${encodeURIComponent(requestId)}`;
        let ready = false;
        while (now() < deadline) {
          await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - now())));
          const polled = await fetcher(pollEndpoint, { method: 'GET', headers: { ...headers, 'NVCF-REQID': requestId }, signal: controller.signal });
          if (polled.status === 202) continue;
          if (!polled.ok) throw new CuoptError('CUOPT_UNAVAILABLE');
          body = await safeJson(polled);
          ready = true;
          break;
        }
        if (!ready) throw new CuoptError('CUOPT_TIMEOUT');
      }
      const route = extractRoute(body, idsFor(problem));
      if (!route) throw new CuoptError('CUOPT_INFEASIBLE');
      const checked = evaluateOrder(problem, route, createLegLookup(problem, matrix), 'local');
      return { ...checked.solution, solver: 'cuopt', ms: Math.max(0, Number((now() - startedAt).toFixed(3))) };
    } catch (error) {
      if (error instanceof CuoptError) throw error;
      if (controller.signal.aborted) throw new CuoptError('CUOPT_TIMEOUT');
      throw new CuoptError('CUOPT_UNAVAILABLE');
    } finally { clearTimeout(timeout); }
  }
  return { solve };
}

function validateEndpoint(value: string, allowInsecureLocalhost = false): void {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(allowInsecureLocalhost && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)))) {
    throw new CuoptError('CUOPT_DISABLED');
  }
  if (!allowInsecureLocalhost && url.hostname !== 'optimize.api.nvidia.com') throw new CuoptError('CUOPT_DISABLED');
}

function idsFor(problem: TrailProblem): string[] { return problem.nodes.map(node => node.spotId); }

async function safeJson(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { throw new CuoptError('CUOPT_MALFORMED'); }
}

function bodyRequestId(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const obj = body as Record<string, unknown>;
  return typeof obj.requestId === 'string' ? obj.requestId : typeof obj.request_id === 'string' ? obj.request_id : undefined;
}

function extractRoute(body: unknown, ids: string[]): string[] | undefined {
  if (!body || typeof body !== 'object') throw new CuoptError('CUOPT_MALFORMED');
  const envelope = body as Record<string, any>;
  const response = envelope.response ?? envelope;
  const result = response.solver_response ?? response;
  if (result.status !== undefined && result.status !== 0) throw new CuoptError('CUOPT_INFEASIBLE');
  const vehicleData = result.vehicle_data;
  if (!vehicleData || typeof vehicleData !== 'object') throw new CuoptError('CUOPT_MALFORMED');
  const routes = Object.values(vehicleData) as Array<Record<string, unknown>>;
  const routeData = routes.find(vehicle => Array.isArray(vehicle.route) || Array.isArray(vehicle.task_id));
  if (!routeData) throw new CuoptError('CUOPT_MALFORMED');
  // `route` is the matrix-node index sequence; task_id is a display label and
  // can use a different zero-based namespace, so only use it when route is absent.
  const raw: unknown = Array.isArray(routeData.route) ? routeData.route : routeData.task_id;
  if (!Array.isArray(raw)) throw new CuoptError('CUOPT_MALFORMED');
  const route = raw.map((item: unknown): string | undefined => {
    if (typeof item === 'number' && Number.isInteger(item)) return item > 0 && item <= ids.length ? ids[item - 1] : undefined;
    if (typeof item === 'string') {
      const id = /^\d+$/.test(item) ? Number(item) : Number.NaN;
      return Number.isInteger(id) ? (id > 0 && id <= ids.length ? ids[id - 1] : undefined) : ids.includes(item) ? item : undefined;
    }
    return undefined;
  }).filter((id: string | undefined): id is string => Boolean(id));
  if (new Set(route).size !== route.length) throw new CuoptError('CUOPT_MALFORMED');
  return route.length ? route : undefined;
}

export async function cuoptEnabledWithKey(): Promise<boolean> {
  if (!env.TRAILS_CUOPT_ENABLED || env.NODE_ENV === 'test') return false;
  try { return Boolean(await readNimApiKey()); } catch { return false; }
}
