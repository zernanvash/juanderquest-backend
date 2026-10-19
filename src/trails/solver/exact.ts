import type { TrailLegLookup, TrailProblem, TrailSolution } from '../types.js';
import { createLegLookup, evaluateOrder } from './index.js';

/** Exhaustive oracle for tests only. Refuses instances above ten candidate nodes. */
export function solveExact(problem: TrailProblem, matrix?: TrailLegLookup): TrailSolution {
  if (problem.nodes.length > 10) throw new RangeError('Exact trail solver is test-only and limited to 10 nodes.');
  const started = performance.now();
  const legFor = createLegLookup(problem, matrix);
  const nodes = problem.nodes.filter(n => !problem.exclude.includes(n.spotId));
  let best: TrailSolution = { stops: [], objective: Number.NEGATIVE_INFINITY, totalMin: 0, totalKm: 0, feasible: false, solver: 'exact', ms: 0 };
  const route: string[] = [];
  const mandatory = new Set(problem.mustInclude);
  function visit() {
    if (route.length >= problem.minStops && [...mandatory].every(id => route.includes(id))) {
      const candidate = evaluateOrder(problem, route, legFor, 'exact');
      if (candidate.feasible && candidate.solution.objective > best.objective) best = candidate.solution;
    }
    if (route.length >= problem.maxStops) return;
    for (const node of nodes) {
      if (route.includes(node.spotId)) continue;
      route.push(node.spotId); visit(); route.pop();
    }
  }
  visit();
  best.ms = Number((performance.now() - started).toFixed(3));
  return best;
}
