import type { TrailLegLookup, TrailProblem, TrailSolution } from '../types.js';
import { createLegLookup, evaluateOrder, seededRandom } from './index.js';

export function solveLocal(problem: TrailProblem, matrix?: TrailLegLookup, budgetMs = 150): TrailSolution {
  const started = performance.now();
  const deadline = started + Math.min(150, Math.max(1, budgetMs));
  const legFor = createLegLookup(problem, matrix);
  const allowed = [...new Map(problem.nodes.filter(n => !problem.exclude.includes(n.spotId)).map(node => [node.spotId, node])).values()]
    .sort((a, b) => (b.value / Math.max(1, b.dwellMin)) - (a.value / Math.max(1, a.dwellMin)) || a.spotId.localeCompare(b.spotId));
  if (problem.mustInclude.some(id => !allowed.some(n => n.spotId === id))) return empty(started);
  const targetStops = Math.max(problem.minStops, new Set(problem.mustInclude).size);
  if (targetStops > problem.maxStops || allowed.length < targetStops) return empty(started);

  const rng = seededRandom(problem.seed);
  const evaluate = (ids: string[]) => evaluateOrder(problem, ids, legFor, 'local');
  // Establish feasibility before optimizing. The old constructor scored every
  // partial route with the full minStops requirement, making all early scores
  // -Infinity; stable sorting could then commit to a prefix that could not be
  // extended even though a different minStops subset was feasible.
  const topK = Math.min(allowed.length, Math.max(12, targetStops + problem.mustInclude.length));
  const preferred = allowed.slice(0, topK);
  for (const id of problem.mustInclude) {
    const mandatory = allowed.find(node => node.spotId === id);
    if (mandatory && !preferred.some(node => node.spotId === id)) preferred.push(mandatory);
  }
  const fastDeadline = Math.min(deadline, started + Math.max(1, Math.min(35, (deadline - started) * 0.3)));
  let seed = findFeasibleSeed(problem, preferred, legFor, targetStops, fastDeadline);
  if (!seed && performance.now() < deadline) {
    // Broaden to the complete candidate set before conceding infeasibility.
    seed = findFeasibleSeed(problem, allowed, legFor, targetStops, deadline);
  }
  if (!seed) return empty(started);

  let bestRoute = seed;
  let best = evaluate(bestRoute).solution;
  // Grow only from a fully feasible route, accepting a stop only when the
  // resulting itinerary remains feasible. This also acts as a feasibility
  // repair path if the construction prefix was a poor objective choice.
  let grew = true;
  while (grew && bestRoute.length < problem.maxStops && performance.now() < deadline) {
    grew = false;
    const inRoute = new Set(bestRoute);
    let choice: { route: string[]; solution: TrailSolution } | undefined;
    for (const node of allowed) {
      if (inRoute.has(node.spotId)) continue;
      for (let at = 0; at <= bestRoute.length && performance.now() < deadline; at++) {
        const route = [...bestRoute.slice(0, at), node.spotId, ...bestRoute.slice(at)];
        const candidate = evaluate(route);
        if (candidate.feasible && (!choice || candidate.solution.objective > choice.solution.objective)) {
          choice = { route, solution: candidate.solution };
        }
      }
    }
    if (choice) {
      bestRoute = choice.route;
      best = choice.solution;
      grew = true;
    }
  }

  const maxIterations = 2000;
  for (let iteration = 0; iteration < maxIterations && performance.now() < deadline; iteration++) {
    const route = [...bestRoute];
    const operation = Math.floor(rng() * 4);
    if (operation === 0 && route.length > 1) {
      let a = Math.floor(rng() * route.length), b = Math.floor(rng() * route.length);
      if (a > b) [a, b] = [b, a];
      route.splice(a, b - a + 1, ...route.slice(a, b + 1).reverse());
    } else if (operation === 1 && route.length > 1) {
      const [item] = route.splice(Math.floor(rng() * route.length), 1);
      route.splice(Math.floor(rng() * (route.length + 1)), 0, item);
    } else if (operation === 2 && allowed.length) {
      const inRoute = new Set(route);
      const candidates = allowed.filter(n => !inRoute.has(n.spotId));
      if (candidates.length) {
        const incoming = candidates[Math.floor(rng() * candidates.length)].spotId;
        const removable = route.map((id, i) => ({ id, i })).filter(x => !problem.mustInclude.includes(x.id));
        if (route.length >= problem.maxStops && removable.length) route[removable[Math.floor(rng() * removable.length)].i] = incoming;
        else route.splice(Math.floor(rng() * (route.length + 1)), 0, incoming);
      }
    } else if (route.length > problem.minStops) {
      const removable = route.map((id, i) => ({ id, i })).filter(x => !problem.mustInclude.includes(x.id));
      if (removable.length) route.splice(removable[Math.floor(rng() * removable.length)].i, 1);
    }
    if (new Set(route).size !== route.length || !partialFeasible(problem, route, legFor)) continue;
    const candidate = evaluate(route);
    if (candidate.feasible && candidate.solution.objective > best.objective) { bestRoute = route; best = candidate.solution; }
  }
  best.ms = Number((performance.now() - started).toFixed(3));
  return best;
}

function partialFeasible(problem: TrailProblem, ids: string[], legFor: TrailLegLookup): boolean {
  if (!ids.length || ids.length > problem.maxStops || ids.some(id => problem.exclude.includes(id))) return false;
  const chosen = new Set(ids);
  const category = new Map<string, number>();
  for (const id of ids) {
    const node = problem.nodes.find(n => n.spotId === id)!;
    category.set(node.category, (category.get(node.category) ?? 0) + 1);
    if ((category.get(node.category) ?? 0) > problem.maxPerCategory) return false;
  }
  // A partial route may not have placed every mandatory stop yet. Enforce
  // mandatory membership only for IDs already present; the full evaluator
  // checks the complete required set once a candidate itinerary is formed.
  const partialProblem = problem.mustInclude.every(id => chosen.has(id))
    ? problem
    : { ...problem, mustInclude: problem.mustInclude.filter(id => chosen.has(id)) };
  return evaluateOrder(partialProblem, ids, legFor, 'local', 1).feasible;
}

function findFeasibleSeed(problem: TrailProblem, candidates: TrailProblem['nodes'], legFor: TrailLegLookup, targetStops: number, deadline: number): string[] | undefined {
  const route: string[] = [];
  const selected = new Set<string>();
  const required = new Set(problem.mustInclude);

  function search(): string[] | undefined {
    if (performance.now() >= deadline) return undefined;
    if (route.length === targetStops) return evaluateOrder(problem, route, legFor, 'local').feasible ? [...route] : undefined;
    const missingRequired = [...required].filter(id => !selected.has(id));
    if (route.length + missingRequired.length > targetStops) return undefined;
    for (const node of candidates) {
      if (selected.has(node.spotId)) continue;
      selected.add(node.spotId);
      route.push(node.spotId);
      if (partialFeasible(problem, route, legFor)) {
        const result = search();
        if (result) return result;
      }
      route.pop();
      selected.delete(node.spotId);
      if (performance.now() >= deadline) break;
    }
    return undefined;
  }

  return search();
}

function empty(started: number): TrailSolution {
  return { stops: [], objective: Number.NEGATIVE_INFINITY, totalMin: 0, totalKm: 0, feasible: false, solver: 'local', ms: Number((performance.now() - started).toFixed(3)) };
}
