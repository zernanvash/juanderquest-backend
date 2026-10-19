#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { env } from '../src/config/env.js';
import { initPostgres, getPool, closePool } from '../src/db/pool.js';
import { computeSpotSignals, loadTrailSignalInputs } from '../src/trails/signals.js';
import { loadTravelTimeLookup } from '../src/trails/matrix.js';
import { solveLocal } from '../src/trails/solver/local.js';
import { solveExact } from '../src/trails/solver/exact.js';
import { createCuoptSolver, cuoptEnabledWithKey } from '../src/trails/solver/cuopt.js';
import { seededRandom } from '../src/trails/solver/index.js';
import { windowsFromBestTime } from '../src/trails/generate.js';
import type { TrailLeg, TrailProblem, TrailSolution } from '../src/trails/types.js';

const CANDIDATE_COUNTS = [15, 30, 60] as const;
const BUDGETS = [240, 480] as const;
const WINDOW_MODES = [false, true] as const;
const RUNS = 30;
type BenchmarkEntry = { seed: number; candidateCount: number; budgetMin: number; withWindows: boolean; solver: 'local'|'exact'|'cuopt'; result: TrailSolution; exactScope?: string };

function assertSafePreview(): void {
  const url = new URL(env.DATABASE_URL);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/jdq_preview_codex_dev') {
    throw new Error('Benchmark refuses any database other than loopback jdq_preview_codex_dev.');
  }
  if (env.DB_MIGRATION_MODE !== 'verify' || env.SEED_DEVELOPMENT_DATA) {
    throw new Error('Benchmark requires DB_MIGRATION_MODE=verify and SEED_DEVELOPMENT_DATA=false.');
  }
}

async function main() {
  assertSafePreview();
  await initPostgres();
  const pool = getPool();
  if (!pool) throw new Error('Preview PostgreSQL is unavailable.');
  try {
    const spotInputs = await loadTrailSignalInputs(pool);
    if (spotInputs.length < 3) throw new Error('At least three published non-test spots are required.');
    const signals = new Map(computeSpotSignals(spotInputs).map(signal => [signal.spotId, signal.value]));
    const allLegs = await loadTravelTimeLookup(pool, 'auto');
    const realSpotCount = spotInputs.length;
    const outputs: BenchmarkEntry[] = [];
    const configs = CANDIDATE_COUNTS.flatMap(candidateCount => BUDGETS.flatMap(budgetMin => WINDOW_MODES.map(withWindows => ({ candidateCount, budgetMin, withWindows }))));
    const useCuopt = await cuoptEnabledWithKey();
    const cuopt = useCuopt ? createCuoptSolver() : undefined;

    for (let run = 0; run < RUNS; run++) {
      const seed = 20261020 + run;
      const config = configs[run % configs.length];
      const rng = seededRandom(seed);
      const shuffled = [...spotInputs];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      const nodes: TrailProblem['nodes'] = [];
      for (let i = 0; i < config.candidateCount; i++) {
        const source = shuffled[i % shuffled.length];
        const synthetic = config.candidateCount > realSpotCount;
        const spotId = synthetic ? `${source.spotId}~bench-${i + 1}` : source.spotId;
        const windows = config.withWindows ? windowsFromBestTime(source.bestTime ?? []) : [];
        const lat = source.lat === undefined ? undefined : source.lat + (synthetic ? (rng() - 0.5) * 0.03 : 0);
        const lng = source.lng === undefined ? undefined : source.lng + (synthetic ? (rng() - 0.5) * 0.03 : 0);
        nodes.push({ spotId, title: source.title, municipality: source.municipality, description: source.description,
          lat, lng, value: signals.get(source.spotId) ?? 0.5, dwellMin: 30 + Math.floor(rng() * 31),
          windows, crowdByHour: Array(24).fill(0), category: source.category });
      }
      const problem: TrailProblem = { nodes, dayStartMin: 8 * 60, budgetMin: config.budgetMin, minStops: 3, maxStops: 6,
        maxLegMin: 120, maxPerCategory: 3, mustInclude: [], exclude: [], weights: { crowdPenalty: 0.15, travelPenalty: 0.003 }, seed, costing: 'auto' };
      const nodeById = new Map(nodes.map(node => [node.spotId, node]));
      const leg = (from: string, to: string): TrailLeg | undefined => {
        if (from === to) return { minutes: 0, km: 0, approximate: false };
        const a = nodeById.get(from), b = nodeById.get(to);
        if (!a || !b) return allLegs(from, to);
        if (!from.includes('~bench-') && !to.includes('~bench-')) return allLegs(from, to);
        if (a.lat === undefined || a.lng === undefined || b.lat === undefined || b.lng === undefined) return { minutes: 0, km: 0, approximate: true };
        const radians = (value: number) => value * Math.PI / 180;
        const h = Math.sin(radians(b.lat - a.lat) / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(radians(b.lng - a.lng) / 2) ** 2;
        const km = 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)) * 1.35;
        return { minutes: km / 35 * 60, km, approximate: true };
      };

      const local = solveLocal(problem, leg);
      outputs.push({ ...config, seed, solver: 'local', result: local });
      // Exact is deliberately restricted to a deterministic 10-candidate
      // subset. Its metrics are not presented as comparable to full-size local.
      const exactProblem = { ...problem, nodes: nodes.slice(0, 10), maxStops: Math.min(problem.maxStops, 6), mustInclude: [] };
      const exact = solveExact(exactProblem, leg);
      outputs.push({ ...config, seed, solver: 'exact', exactScope: 'first 10 candidates only', result: exact });
      if (cuopt) {
        const result = await cuopt.solve(problem, leg);
        outputs.push({ ...config, seed, solver: 'cuopt', result });
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const item of outputs) {
        await client.query(`INSERT INTO trail_generations
          (id,kind,requested_by,input,constraints,solver,solver_ms,objective,result,ai_used,ai_fallback_reason)
          VALUES ($1,'benchmark',NULL,$2::jsonb,$3::jsonb,$4,$5,$6,$7::jsonb,FALSE,$8)`, [
          randomUUID(), JSON.stringify({ seed: item.seed, candidates: item.candidateCount, budget_min: item.budgetMin, time_windows: item.withWindows, exact_scope: item.exactScope ?? null }),
          JSON.stringify({ candidate_count: item.candidateCount, budget_min: item.budgetMin, with_windows: item.withWindows }),
          item.solver, Math.max(0, Math.round(item.result.ms)), Number.isFinite(item.result.objective) ? item.result.objective : -1,
          JSON.stringify({ feasible: item.result.feasible, objective: Number.isFinite(item.result.objective) ? item.result.objective : null,
            stops: item.result.stops.map(stop => stop.spotId), stop_count: item.result.stops.length, total_min: item.result.totalMin, total_km: item.result.totalKm,
            exact_scope: item.exactScope ?? null }), useCuopt ? null : item.solver === 'cuopt' ? 'pending_owner_key' : null]);
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }

    const report = renderReport(outputs, { realSpotCount, useCuopt });
    const reportPath = process.env.TRAIL_BENCHMARK_REPORT_PATH ?? resolve(process.cwd(), 'docs', '07-testing', 'trail-engine-benchmark.md');
    await mkdir(resolve(reportPath, '..'), { recursive: true });
    await writeFile(reportPath, report, 'utf8');
    console.log(JSON.stringify({ database: 'jdq_preview_codex_dev', runs: RUNS, rows_written: outputs.length, cuopt_enabled: useCuopt,
      real_published_spots: realSpotCount, report: reportPath, local_exact_mode: !useCuopt }, null, 2));
  } finally { await closePool(); }
}

function renderReport(outputs: BenchmarkEntry[], context: { realSpotCount: number; useCuopt: boolean }): string {
  const localRows = outputs.filter(item => item.solver === 'local');
  const exactRows = outputs.filter(item => item.solver === 'exact');
  const cuoptRows = outputs.filter(item => item.solver === 'cuopt');
  const average = (rows: BenchmarkEntry[], field: 'objective'|'ms'|'stops') => rows.length
    ? (rows.reduce((sum, row) => sum + (field === 'objective' ? (Number.isFinite(row.result.objective) ? row.result.objective : 0) : field === 'ms' ? row.result.ms : row.result.stops.length), 0) / rows.length).toFixed(2)
    : 'pending owner key';
  const feasible = (rows: BenchmarkEntry[]) => rows.length ? `${rows.filter(row => row.result.feasible).length}/${rows.length}` : 'pending owner key';
  const lines = [
    '# Trail Engine Solver Benchmark', '',
    `Run date: ${new Date().toISOString()}`,
    'Database: disposable loopback `jdq_preview_codex_dev`; no production or presentation database was used.',
    'cuOpt schema references: [NVIDIA managed submit OpenAPI](https://docs.api.nvidia.com/nim/reference/nvidia-cuopt-infer), [status-poll OpenAPI](https://docs.api.nvidia.com/nim/reference/nvidia-cuopt-statuspolling), and [cuOpt routing data requirements](https://docs.nvidia.com/cuopt/service/latest/data-requirements.html).',
    `Instances: ${RUNS}; seeds 20261020–20261049; candidate sizes 15/30/60, budgets 240/480 minutes, windows off/on.`,
    `Published real spots available: ${context.realSpotCount}. Candidate sets larger than the available catalog use deterministic repeated catalog entries with explicit benchmark aliases; same-source alias legs use approximate Haversine estimates.`, '',
    'Exact is an oracle over the first 10 candidates only; its objective/feasibility are not directly comparable to the full-size local run. Each reported wall time is solver-reported milliseconds; SQL persistence and NIM/cooling overhead are excluded.', '',
    '| Solver | Instances | Feasible | Mean objective | Mean stops | Mean solver ms |',
    '|---|---:|---:|---:|---:|---:|',
    `| local (full candidate set) | ${localRows.length} | ${feasible(localRows)} | ${average(localRows, 'objective')} | ${average(localRows, 'stops')} | ${average(localRows, 'ms')} |`,
    `| exact (first 10 candidates) | ${exactRows.length} | ${feasible(exactRows)} | ${average(exactRows, 'objective')} | ${average(exactRows, 'stops')} | ${average(exactRows, 'ms')} |`,
    `| cuOpt (full candidate set) | ${cuoptRows.length || 'pending owner key'} | ${feasible(cuoptRows)} | ${average(cuoptRows, 'objective')} | ${average(cuoptRows, 'stops')} | ${average(cuoptRows, 'ms')} |`, '',
    '## Per-run results', '',
    '| Seed | Candidates | Budget min | Windows | Solver | Feasible | Objective | Stops | Wall ms |',
    '|---:|---:|---:|:---:|---|:---:|---:|---:|---:|',
    ...outputs.map(row => `| ${row.seed} | ${row.candidateCount} | ${row.budgetMin} | ${row.withWindows ? 'yes' : 'no'} | ${row.solver} | ${row.result.feasible ? 'yes' : 'no'} | ${Number.isFinite(row.result.objective) ? row.result.objective.toFixed(4) : '—'} | ${row.result.stops.length} | ${row.result.ms.toFixed(2)} |`), '',
    '## Discussion', '',
    'This benchmark compares the deterministic CPU solver with a bounded exact oracle and records reproducible audit rows in `trail_generations(kind=benchmark)`. Exact is intentionally capped at ten candidates to avoid combinatorial growth; interpret it as a sampled quality reference, not an exact optimum for the full candidate set. Local is the operational solver and its 150 ms budget can cap search effort. Windowed cases use destination `best_time` values where available; stops with no recognized time window remain unconstrained.', '',
    localRows.some(row => !row.result.feasible)
      ? `Local feasibility follow-up: ${localRows.filter(row => !row.result.feasible).length}/${localRows.length} full-candidate instances returned no feasible route (seeds ${localRows.filter(row => !row.result.feasible).map(row => row.seed).join(', ')}). Exact results apply only to the smaller first-10-candidate subproblems and do not establish full-catalog feasibility.`
      : `Local feasibility: all ${localRows.length} full-candidate instances returned feasible routes.`, '',
    context.useCuopt ? 'cuOpt was explicitly enabled and the private owner key was available; cuOpt metrics above are from the managed service and were re-scored locally.' : 'cuOpt columns are pending owner key. No hosted NVIDIA cuOpt request was made during this run.', '',
    'All generation rows contain only solver inputs/results and no traveler identity, exact user location, or AI story. These are thesis evaluation records, not published trails.', '',
  ];
  return lines.join('\n');
}

main().catch(async error => { console.error(`Trail benchmark failed: ${error instanceof Error ? error.message : 'unknown error'}`); await closePool(); process.exitCode = 1; });
