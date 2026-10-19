# Trail Engine Solver Benchmark

Run date: 2026-10-19T23:39:07.372Z
Database: disposable loopback `jdq_preview_codex_dev`; no production or presentation database was used.
cuOpt schema references: [NVIDIA managed submit OpenAPI](https://docs.api.nvidia.com/nim/reference/nvidia-cuopt-infer), [status-poll OpenAPI](https://docs.api.nvidia.com/nim/reference/nvidia-cuopt-statuspolling), and [cuOpt routing data requirements](https://docs.nvidia.com/cuopt/service/latest/data-requirements.html).
Instances: 30; seeds 20261020–20261049; candidate sizes 15/30/60, budgets 240/480 minutes, windows off/on.
Published real spots available: 36. Candidate sets larger than the available catalog use deterministic repeated catalog entries with explicit benchmark aliases; same-source alias legs use approximate Haversine estimates.

Exact is an oracle over the first 10 candidates only; its objective/feasibility are not directly comparable to the full-size local run. Each reported wall time is solver-reported milliseconds; SQL persistence and NIM/cooling overhead are excluded.

| Solver | Instances | Feasible | Mean objective | Mean stops | Mean solver ms |
|---|---:|---:|---:|---:|---:|
| local (full candidate set) | 30 | 30/30 | 1.16 | 4.67 | 43.40 |
| exact (first 10 candidates) | 30 | 30/30 | 1.04 | 4.27 | 1917.22 |
| cuOpt (full candidate set) | pending owner key | pending owner key | pending owner key | pending owner key | pending owner key |

## Per-run results

| Seed | Candidates | Budget min | Windows | Solver | Feasible | Objective | Stops | Wall ms |
|---:|---:|---:|:---:|---|:---:|---:|---:|---:|
| 20261020 | 15 | 240 | no | local | yes | 1.0371 | 4 | 107.23 |
| 20261020 | 15 | 240 | no | exact | yes | 0.7609 | 3 | 1970.03 |
| 20261021 | 15 | 240 | yes | local | yes | 0.5901 | 3 | 55.14 |
| 20261021 | 15 | 240 | yes | exact | yes | 1.1095 | 4 | 2117.58 |
| 20261022 | 15 | 480 | no | local | yes | 1.4259 | 6 | 88.81 |
| 20261022 | 15 | 480 | no | exact | yes | 1.3583 | 6 | 2015.67 |
| 20261023 | 15 | 480 | yes | local | yes | 1.4116 | 6 | 50.69 |
| 20261023 | 15 | 480 | yes | exact | yes | 1.3480 | 6 | 2019.26 |
| 20261024 | 30 | 240 | no | local | yes | 0.6279 | 3 | 26.28 |
| 20261024 | 30 | 240 | no | exact | yes | 0.7962 | 3 | 2004.76 |
| 20261025 | 30 | 240 | yes | local | yes | 1.0716 | 4 | 39.42 |
| 20261025 | 30 | 240 | yes | exact | yes | 0.7466 | 3 | 2014.73 |
| 20261026 | 30 | 480 | no | local | yes | 1.5348 | 6 | 45.48 |
| 20261026 | 30 | 480 | no | exact | yes | 1.4558 | 6 | 1953.27 |
| 20261027 | 30 | 480 | yes | local | yes | 1.5594 | 6 | 45.43 |
| 20261027 | 30 | 480 | yes | exact | yes | 1.3951 | 6 | 1945.37 |
| 20261028 | 60 | 240 | no | local | yes | 1.0699 | 4 | 34.23 |
| 20261028 | 60 | 240 | no | exact | yes | 0.8234 | 3 | 1578.57 |
| 20261029 | 60 | 240 | yes | local | yes | 0.9837 | 4 | 24.22 |
| 20261029 | 60 | 240 | yes | exact | yes | 1.0878 | 4 | 1527.38 |
| 20261030 | 60 | 480 | no | local | yes | 1.7350 | 6 | 44.53 |
| 20261030 | 60 | 480 | no | exact | yes | 1.1928 | 6 | 1580.37 |
| 20261031 | 60 | 480 | yes | local | yes | 1.7624 | 6 | 43.83 |
| 20261031 | 60 | 480 | yes | exact | yes | 1.0546 | 5 | 1561.05 |
| 20261032 | 15 | 240 | no | local | yes | 0.6519 | 3 | 19.30 |
| 20261032 | 15 | 240 | no | exact | yes | 0.7144 | 3 | 1861.12 |
| 20261033 | 15 | 240 | yes | local | yes | 0.9950 | 4 | 23.60 |
| 20261033 | 15 | 240 | yes | exact | yes | 0.7710 | 3 | 1952.19 |
| 20261034 | 15 | 480 | no | local | yes | 1.4585 | 6 | 42.10 |
| 20261034 | 15 | 480 | no | exact | yes | 1.2632 | 6 | 2362.68 |
| 20261035 | 15 | 480 | yes | local | yes | 0.8720 | 5 | 32.52 |
| 20261035 | 15 | 480 | yes | exact | yes | 1.1161 | 5 | 1875.57 |
| 20261036 | 30 | 240 | no | local | yes | 0.9488 | 4 | 24.92 |
| 20261036 | 30 | 240 | no | exact | yes | 0.7960 | 3 | 1901.51 |
| 20261037 | 30 | 240 | yes | local | yes | 0.5310 | 3 | 20.50 |
| 20261037 | 30 | 240 | yes | exact | yes | 0.8588 | 3 | 1908.61 |
| 20261038 | 30 | 480 | no | local | yes | 1.5497 | 6 | 47.26 |
| 20261038 | 30 | 480 | no | exact | yes | 1.6715 | 6 | 2076.16 |
| 20261039 | 30 | 480 | yes | local | yes | 1.7076 | 6 | 150.00 |
| 20261039 | 30 | 480 | yes | exact | yes | 1.0450 | 4 | 2116.30 |
| 20261040 | 60 | 240 | no | local | yes | 1.0571 | 4 | 35.14 |
| 20261040 | 60 | 240 | no | exact | yes | 0.7469 | 3 | 1620.04 |
| 20261041 | 60 | 240 | yes | local | yes | 0.5246 | 3 | 19.98 |
| 20261041 | 60 | 240 | yes | exact | yes | 0.9673 | 4 | 1722.97 |
| 20261042 | 60 | 480 | no | local | yes | 1.6226 | 6 | 43.52 |
| 20261042 | 60 | 480 | no | exact | yes | 1.0882 | 5 | 1610.78 |
| 20261043 | 60 | 480 | yes | local | yes | 1.7257 | 6 | 45.52 |
| 20261043 | 60 | 480 | yes | exact | yes | 1.3022 | 6 | 1565.80 |
| 20261044 | 15 | 240 | no | local | yes | 0.6838 | 3 | 24.00 |
| 20261044 | 15 | 240 | no | exact | yes | 0.8352 | 3 | 1893.04 |
| 20261045 | 15 | 240 | yes | local | yes | 1.0795 | 4 | 26.34 |
| 20261045 | 15 | 240 | yes | exact | yes | 0.7898 | 3 | 1972.08 |
| 20261046 | 15 | 480 | no | local | yes | 1.3991 | 6 | 41.42 |
| 20261046 | 15 | 480 | no | exact | yes | 1.2284 | 5 | 1994.97 |
| 20261047 | 15 | 480 | yes | local | yes | 1.3960 | 6 | 49.47 |
| 20261047 | 15 | 480 | yes | exact | yes | 1.1452 | 5 | 2414.20 |
| 20261048 | 30 | 240 | no | local | yes | 1.0648 | 4 | 27.14 |
| 20261048 | 30 | 240 | no | exact | yes | 0.7761 | 3 | 1950.99 |
| 20261049 | 30 | 240 | yes | local | yes | 0.6284 | 3 | 24.11 |
| 20261049 | 30 | 240 | yes | exact | yes | 0.8285 | 3 | 2429.62 |

## Discussion

This benchmark compares the deterministic CPU solver with a bounded exact oracle and records reproducible audit rows in `trail_generations(kind=benchmark)`. Exact is intentionally capped at ten candidates to avoid combinatorial growth; interpret it as a sampled quality reference, not an exact optimum for the full candidate set. Local is the operational solver and its 150 ms budget can cap search effort. Windowed cases use destination `best_time` values where available; stops with no recognized time window remain unconstrained.

Local feasibility: all 30 full-candidate instances returned feasible routes.

cuOpt columns are pending owner key. No hosted NVIDIA cuOpt request was made during this run.

All generation rows contain only solver inputs/results and no traveler identity, exact user location, or AI story. These are thesis evaluation records, not published trails.
