# Trail Engine Solver Benchmark

Run date: 2026-10-19T17:35:39.575Z
Database: disposable loopback `jdq_preview_codex_dev`; no production or presentation database was used.
cuOpt schema references: [NVIDIA managed submit OpenAPI](https://docs.api.nvidia.com/nim/reference/nvidia-cuopt-infer), [status-poll OpenAPI](https://docs.api.nvidia.com/nim/reference/nvidia-cuopt-statuspolling), and [cuOpt routing data requirements](https://docs.nvidia.com/cuopt/service/latest/data-requirements.html).
Instances: 30; seeds 20261020–20261049; candidate sizes 15/30/60, budgets 240/480 minutes, windows off/on.
Published real spots available: 36. Candidate sets larger than the available catalog use deterministic repeated catalog entries with explicit benchmark aliases; same-source alias legs use approximate Haversine estimates.

Exact is an oracle over the first 10 candidates only; its objective/feasibility are not directly comparable to the full-size local run. Each reported wall time is solver-reported milliseconds; SQL persistence and NIM/cooling overhead are excluded.

| Solver | Instances | Feasible | Mean objective | Mean stops | Mean solver ms |
|---|---:|---:|---:|---:|---:|
| local (full candidate set) | 30 | 27/30 | 0.99 | 4.10 | 41.21 |
| exact (first 10 candidates) | 30 | 30/30 | 1.04 | 4.27 | 1962.69 |
| cuOpt (full candidate set) | pending owner key | pending owner key | pending owner key | pending owner key | pending owner key |

## Per-run results

| Seed | Candidates | Budget min | Windows | Solver | Feasible | Objective | Stops | Wall ms |
|---:|---:|---:|:---:|---|:---:|---:|---:|---:|
| 20261020 | 15 | 240 | no | local | yes | 0.6765 | 3 | 67.99 |
| 20261020 | 15 | 240 | no | exact | yes | 0.7609 | 3 | 1986.79 |
| 20261021 | 15 | 240 | yes | local | yes | 0.6074 | 3 | 61.37 |
| 20261021 | 15 | 240 | yes | exact | yes | 1.1095 | 4 | 2239.84 |
| 20261022 | 15 | 480 | no | local | yes | 1.4615 | 6 | 102.94 |
| 20261022 | 15 | 480 | no | exact | yes | 1.3583 | 6 | 2046.36 |
| 20261023 | 15 | 480 | yes | local | yes | 1.3803 | 6 | 72.36 |
| 20261023 | 15 | 480 | yes | exact | yes | 1.3480 | 6 | 2000.42 |
| 20261024 | 30 | 240 | no | local | no | — | 0 | 17.37 |
| 20261024 | 30 | 240 | no | exact | yes | 0.7962 | 3 | 2029.77 |
| 20261025 | 30 | 240 | yes | local | yes | 0.6314 | 3 | 33.76 |
| 20261025 | 30 | 240 | yes | exact | yes | 0.7466 | 3 | 1941.00 |
| 20261026 | 30 | 480 | no | local | yes | 1.5930 | 6 | 51.32 |
| 20261026 | 30 | 480 | no | exact | yes | 1.4558 | 6 | 2070.56 |
| 20261027 | 30 | 480 | yes | local | yes | 1.6022 | 6 | 62.62 |
| 20261027 | 30 | 480 | yes | exact | yes | 1.3951 | 6 | 1952.60 |
| 20261028 | 60 | 240 | no | local | no | — | 0 | 18.83 |
| 20261028 | 60 | 240 | no | exact | yes | 0.8234 | 3 | 1560.73 |
| 20261029 | 60 | 240 | yes | local | yes | 1.1198 | 4 | 33.13 |
| 20261029 | 60 | 240 | yes | exact | yes | 1.0878 | 4 | 1578.11 |
| 20261030 | 60 | 480 | no | local | yes | 1.6734 | 6 | 59.05 |
| 20261030 | 60 | 480 | no | exact | yes | 1.1928 | 6 | 1819.00 |
| 20261031 | 60 | 480 | yes | local | yes | 1.7735 | 6 | 55.41 |
| 20261031 | 60 | 480 | yes | exact | yes | 1.0546 | 5 | 1586.84 |
| 20261032 | 15 | 240 | no | local | no | — | 0 | 12.44 |
| 20261032 | 15 | 240 | no | exact | yes | 0.7144 | 3 | 1973.31 |
| 20261033 | 15 | 240 | yes | local | yes | 0.6374 | 3 | 26.66 |
| 20261033 | 15 | 240 | yes | exact | yes | 0.7710 | 3 | 2372.57 |
| 20261034 | 15 | 480 | no | local | yes | 1.4972 | 6 | 53.72 |
| 20261034 | 15 | 480 | no | exact | yes | 1.2632 | 6 | 1950.32 |
| 20261035 | 15 | 480 | yes | local | yes | 1.4343 | 6 | 36.09 |
| 20261035 | 15 | 480 | yes | exact | yes | 1.1161 | 5 | 1892.87 |
| 20261036 | 30 | 240 | no | local | yes | 0.6067 | 3 | 24.38 |
| 20261036 | 30 | 240 | no | exact | yes | 0.7960 | 3 | 1922.73 |
| 20261037 | 30 | 240 | yes | local | yes | 0.7586 | 3 | 21.01 |
| 20261037 | 30 | 240 | yes | exact | yes | 0.8588 | 3 | 2069.15 |
| 20261038 | 30 | 480 | no | local | yes | 1.6715 | 6 | 48.64 |
| 20261038 | 30 | 480 | no | exact | yes | 1.6715 | 6 | 2225.36 |
| 20261039 | 30 | 480 | yes | local | yes | 1.5477 | 6 | 67.73 |
| 20261039 | 30 | 480 | yes | exact | yes | 1.0450 | 4 | 2210.21 |
| 20261040 | 60 | 240 | no | local | yes | 0.6593 | 3 | 22.16 |
| 20261040 | 60 | 240 | no | exact | yes | 0.7469 | 3 | 1556.86 |
| 20261041 | 60 | 240 | yes | local | yes | 0.6828 | 3 | 22.02 |
| 20261041 | 60 | 240 | yes | exact | yes | 0.9673 | 4 | 1568.34 |
| 20261042 | 60 | 480 | no | local | yes | 1.4647 | 6 | 42.10 |
| 20261042 | 60 | 480 | no | exact | yes | 1.0882 | 5 | 1568.43 |
| 20261043 | 60 | 480 | yes | local | yes | 1.4233 | 6 | 40.04 |
| 20261043 | 60 | 480 | yes | exact | yes | 1.3022 | 6 | 1625.21 |
| 20261044 | 15 | 240 | no | local | yes | 0.7852 | 3 | 23.16 |
| 20261044 | 15 | 240 | no | exact | yes | 0.8352 | 3 | 2058.86 |
| 20261045 | 15 | 240 | yes | local | yes | 0.6327 | 3 | 19.59 |
| 20261045 | 15 | 240 | yes | exact | yes | 0.7898 | 3 | 1929.68 |
| 20261046 | 15 | 480 | no | local | yes | 1.3991 | 6 | 38.07 |
| 20261046 | 15 | 480 | no | exact | yes | 1.2284 | 5 | 1962.46 |
| 20261047 | 15 | 480 | yes | local | yes | 0.8650 | 5 | 30.16 |
| 20261047 | 15 | 480 | yes | exact | yes | 1.1452 | 5 | 1936.32 |
| 20261048 | 30 | 240 | no | local | yes | 0.6738 | 3 | 22.99 |
| 20261048 | 30 | 240 | no | exact | yes | 0.7761 | 3 | 3112.68 |
| 20261049 | 30 | 240 | yes | local | yes | 0.5373 | 3 | 49.23 |
| 20261049 | 30 | 240 | yes | exact | yes | 0.8285 | 3 | 2133.28 |

## Discussion

Command: `bash scripts/run-trail-benchmark-preview.sh` from the Plan 44 backend checkout in WSL. The run inserted 60 `trail_generations` rows in one transaction and did not create or publish trail catalog entries.

This benchmark compares the deterministic CPU solver with a bounded exact oracle and records reproducible audit rows in `trail_generations(kind=benchmark)`. Exact is intentionally capped to the first ten candidates to avoid combinatorial growth; interpret it as a sampled quality reference, not an exact optimum for the full candidate set. Its objective and feasibility are therefore not directly comparable with the full-size local route. Local is the operational solver and its 150 ms budget can cap search effort. Windowed cases use destination `best_time` values where available; stops with no recognized time window remain unconstrained.

The local solver found feasible routes for 27/30 full candidate instances. Seeds `20261024`, `20261028`, and `20261032` (all 240-minute budget cases) returned no feasible route, while their separate first-10-node exact subproblems were feasible. This is a useful quality finding: the exact result proves feasibility only for its smaller subset, but the local misses warrant a follow-up solver-quality investigation before this benchmark is used to claim robust coverage.

cuOpt columns are pending owner key. No hosted NVIDIA cuOpt request was made during this run.

All generation rows contain only solver inputs/results and no traveler identity, exact user location, or AI story. These are thesis evaluation records, not published trails.
