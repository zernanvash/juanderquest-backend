import type { TrailLeg, TrailLegLookup, TrailProblem, TrailSolution } from '../types.js';

export function haversineLeg(a: { lat?: number; lng?: number }, b: { lat?: number; lng?: number }, costing = 'auto'): TrailLeg {
  if (a.lat === undefined || a.lng === undefined || b.lat === undefined || b.lng === undefined) return { minutes: 0, km: 0, approximate: true };
  const rad = (v: number) => v * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  const km = 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)) * 1.35;
  const speed = costing === 'pedestrian' ? 4.5 : 35;
  return { minutes: km / speed * 60, km, approximate: true };
}

export function createLegLookup(problem: TrailProblem, matrix?: TrailLegLookup): TrailLegLookup {
  const nodes = new Map(problem.nodes.map(n => [n.spotId, n]));
  return (from, to) => {
    if (from === to) return { minutes: 0, km: 0, approximate: false };
    const known = matrix?.(from, to);
    if (known) return known;
    return haversineLeg(nodes.get(from) ?? (typeof problem.startNode === 'object' ? problem.startNode : {}), nodes.get(to) ?? {}, problem.costing);
  };
}

export interface Evaluation { solution: TrailSolution; feasible: boolean }

const nodeMapCache = new WeakMap<TrailProblem, Map<string, TrailProblem['nodes'][number]>>();

export function evaluateOrder(problem: TrailProblem, order: string[], legFor: TrailLegLookup, solver: 'local' | 'exact' = 'local', minStopsOverride?: number): Evaluation {
  let byId = nodeMapCache.get(problem);
  if (!byId) { byId = new Map(problem.nodes.map(n => [n.spotId, n])); nodeMapCache.set(problem, byId); }
  const selected = order.map(id => byId.get(id)).filter((n): n is NonNullable<typeof n> => Boolean(n));
  const ids = selected.map(n => n.spotId);
  let feasible = ids.length >= (minStopsOverride ?? problem.minStops) && ids.length <= problem.maxStops && new Set(ids).size === ids.length;
  const must = new Set(problem.mustInclude);
  if ([...must].some(id => !ids.includes(id)) || ids.some(id => problem.exclude.includes(id))) feasible = false;
  const categoryCounts = new Map<string, number>();
  let elapsed = 0, km = 0, objective = 0;
  const stops: TrailSolution['stops'] = [];
  let prior = typeof problem.startNode === 'string' ? problem.startNode : undefined;
  for (let i = 0; i < selected.length; i++) {
    const node = selected[i];
    const leg = prior ? legFor(prior, node.spotId) : (typeof problem.startNode === 'object' ? haversineLeg(problem.startNode, node, problem.costing) : { minutes: 0, km: 0, approximate: false });
    if (!leg || leg.minutes > problem.maxLegMin) feasible = false;
    elapsed += leg?.minutes ?? Number.POSITIVE_INFINITY; km += leg?.km ?? 0;
    const arrival = problem.dayStartMin + elapsed;
    if (node.windows.length && !node.windows.some(([start, end]) => arrival >= start && arrival <= end)) feasible = false;
    const categoryCount = (categoryCounts.get(node.category) ?? 0) + 1;
    categoryCounts.set(node.category, categoryCount);
    if (categoryCount > problem.maxPerCategory) feasible = false;
    const hour = Math.max(0, Math.min(23, Math.floor(((arrival % 1440) + 1440) % 1440 / 60)));
    const crowd = node.crowdByHour[hour] ?? 0;
    objective += node.value - problem.weights.crowdPenalty * crowd - problem.weights.travelPenalty * (leg?.minutes ?? 0);
    stops.push({ spotId: node.spotId, arriveMin: Math.round(arrival), departMin: Math.round(arrival + node.dwellMin) });
    elapsed += node.dwellMin;
    prior = node.spotId;
  }
  if (elapsed > problem.budgetMin) feasible = false;
  if (stops.length && stops[0].arriveMin < problem.dayStartMin) feasible = false;
  return { feasible, solution: { stops, objective: feasible ? objective : Number.NEGATIVE_INFINITY, totalMin: Math.round(elapsed), totalKm: Number(km.toFixed(2)), feasible, solver, ms: 0 } };
}

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 0x100000000; };
}
