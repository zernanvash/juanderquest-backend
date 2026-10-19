import type { TrailLegLookup, TrailProblem, TrailSolution } from '../types.js';
import { createLegLookup, evaluateOrder, seededRandom } from './index.js';

export function solveLocal(problem: TrailProblem, matrix?: TrailLegLookup, budgetMs = 150): TrailSolution {
  const started = performance.now();
  const deadline = started + Math.min(150, Math.max(1, budgetMs));
  const legFor = createLegLookup(problem, matrix);
  const allowed = problem.nodes.filter(n => !problem.exclude.includes(n.spotId));
  if (problem.mustInclude.some(id => !allowed.some(n => n.spotId === id))) return empty(started);
  const rng = seededRandom(problem.seed);
  const evaluate = (ids: string[]) => evaluateOrder(problem, ids, legFor, 'local');
  let current: string[] = [...problem.mustInclude];
  let currentEval = evaluate(current);
  // The mandatory set may itself violate constraints; grow only from valid partial routes.
  if (!currentEval.feasible && current.length >= problem.minStops) return empty(started);
  while (current.length < problem.maxStops) {
  const options = allowed.filter(n => !current.includes(n.spotId)).map(n => {
      let best: { route: string[]; score: number } | undefined;
      for (let at = 0; at <= current.length; at++) {
        if (performance.now() >= deadline) break;
        const route = [...current.slice(0, at), n.spotId, ...current.slice(at)];
        if (partialFeasible(problem, route, legFor)) {
          const evaluated = evaluate(route);
          if (!best || evaluated.solution.objective > best.score) best = { route, score: evaluated.solution.objective };
        }
      }
      return best ? { node: n, ...best } : undefined;
    }).filter((v): v is NonNullable<typeof v> => Boolean(v));
    if (!options.length) break;
    options.sort((a, b) => (b.score - currentEval.solution.objective) / Math.max(b.node.dwellMin, 1) - (a.score - currentEval.solution.objective) / Math.max(a.node.dwellMin, 1));
    const choice = options[0];
    current = choice.route;
    currentEval = evaluate(current);
  }

  let bestRoute = currentEval.feasible ? current : [];
  let best = currentEval.feasible ? currentEval.solution : empty(started);
  const maxIterations = 2000;
  for (let iteration = 0; iteration < maxIterations && performance.now() < deadline; iteration++) {
    const route = bestRoute.length ? [...bestRoute] : [...problem.mustInclude];
    if (!route.length && allowed.length) route.push(allowed[Math.floor(rng() * allowed.length)].spotId);
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
  if (problem.mustInclude.some(id => !chosen.has(id))) return false;
  const category = new Map<string, number>();
  for (const id of ids) {
    const node = problem.nodes.find(n => n.spotId === id)!;
    category.set(node.category, (category.get(node.category) ?? 0) + 1);
    if ((category.get(node.category) ?? 0) > problem.maxPerCategory) return false;
  }
  return evaluateOrder(problem, ids, legFor, 'local', 1).feasible;
}

function empty(started: number): TrailSolution {
  return { stops: [], objective: Number.NEGATIVE_INFINITY, totalMin: 0, totalKm: 0, feasible: false, solver: 'local', ms: Number((performance.now() - started).toFixed(3)) };
}
