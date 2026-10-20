# Trail Engine admin API (Plan 44, implemented scope)

Base path: `/api/v1`. Every route below is mounted by the backend's `trailsRouter` and guarded at the router level by `authenticateToken` and `requireAdmin`. A valid signed-in administrator is required for **all reads and writes**, including matrix status and solver comparison. A missing/invalid session is rejected by authentication; a non-admin session is rejected by the admin middleware. These routes are operational APIs, not traveler endpoints.

Success responses use `{ "success": true, "data": ... }`. Errors use `{ "success": false, "error": { "code": "...", "message": "..." } }`. Error messages are safe summaries; underlying database/provider details are intentionally not returned.

## Endpoints

| Method and path | Purpose | Success |
|---|---|---|
| `GET /admin/trails/matrix/status` | Counts cached travel-matrix rows grouped by costing, including approximate rows, most recent computation and graph label. | `200`, `data: [{ costing, rows, approximate_count, last_computed, graph_label }, ...]`; an empty matrix is `[]`. |
| `POST /admin/trails/matrix/refresh` | Rebuilds the matrix for the published, non-test spots that have coordinates. Valhalla requests are split into at-most-50×50 batches; failed/missing route cells use explicitly approximate Haversine estimates. | `200`, `data: { costing, requested, exact, approximate, graphLabel }`. |
| `GET /admin/trails` | Lists at most 100 engine-generated trails newest first. Optional `?status=<value>` filters by trail status. | `200`, `data` is an array of trail rows with generation `solver_ms`, `objective`, and `solver` where available. |
| `GET /admin/trails/review` | Lists at most 100 engine-generated trails in `pending_review`, oldest first. | `200`, `data` is an array of trail rows joined with generation solver and AI/fallback metadata (`solver_ms`, `objective`, `solver`, `ai_model`, `ai_used`, `ai_fallback_reason`). |
| `POST /admin/trails/generate` | Generates an engine trail draft and its audit record transactionally. | `201`, `data: { trail, generation, solution }`. The trail includes its generated ID/slug and linked generation ID; `generation` reports solver duration/objective and AI usage/fallback; `solution` includes feasibility, ordered stops and totals. |
| `POST /admin/trails/compare-solvers` | Evaluation-only local-vs-cuOpt comparison on an explicit published public spot set. Persists both results as `kind='benchmark'` in one transaction. | `200`, `data: { local, cuopt }`; each solution reports ordered stops, feasibility, objective, duration/distance, solver and elapsed milliseconds. |
| `POST /admin/trails/:id/review` | Submits an engine draft for review. The only accepted body is `{ "decision": "submit" }`. This is a workflow transition to `pending_review`, not an approval. | `200`, `data` is the updated trail row. |
| `POST /admin/trails/:id/publish` | Publishes an engine trail only if its current status is `pending_review`; records reviewer and publication timestamp. | `200`, `data` is the updated trail row. |
| `POST /admin/trails/:id/reject` | Marks an existing engine trail rejected and records the reviewer. | `200`, `data` is the updated trail row. |
| `POST /admin/trails/:id/retire` | Marks an existing engine trail retired and records the reviewer. | `200`, `data` is the updated trail row. |
| `PATCH /admin/trails/:id` | Edits allowed editorial/economy/availability fields and/or stop narration in one transaction. | `200`, `data` is the updated trail row plus ordered `stops`. |

### Request contracts

`POST /admin/trails/matrix/refresh`

```json
{ "costing": "auto" }
```

`costing` is optional and defaults to `auto`; accepted values are `auto`, `pedestrian`, `bicycle`, and `motorcycle`.

`POST /admin/trails/generate`

```json
{
  "theme": "coastal discoveries",
  "tier": "starter",
  "budgetMin": 240,
  "seed": 44,
  "minStops": 3,
  "maxStops": 6,
  "maxLegMin": 60,
  "maxPerCategory": 2,
  "mustInclude": ["spot-id"],
  "exclude": [],
  "startNode": "spot-id",
  "costing": "auto",
  "constraints": { "themes": ["coastal"], "goodFor": ["families"] }
}
```

All properties are optional. Validation bounds: theme 1–80 characters; tier one of `starter | explorer | signature | legendary`; budget 60–600 minutes; integer seed; min/max stops 2–12 with `minStops <= maxStops`; max leg 15–180 minutes; category maximum 1–12; at most 12 required spots and 100 excluded spots (each ID at most 120 chars); start ID at most 120 chars; costing as above; constraint theme/good-for arrays contain strings up to 80 chars. Solver selection is deliberately not caller-controlled on this generation route: generation uses the local solver and AI is story-only/advisory. A successful result is a draft for admin review; a feasible result is not automatically published.

`POST /admin/trails/compare-solvers`

```json
{
  "spot_ids": ["spot-a", "spot-b", "spot-c"],
  "budget_min": 240,
  "min_stops": 3,
  "max_stops": 6,
  "max_leg_min": 60,
  "max_per_category": 2,
  "must_include": [],
  "exclude": [],
  "start_node": "spot-a",
  "seed": 44,
  "costing": "auto",
  "with_windows": true
}
```

Required: `spot_ids` (3–60 unique string IDs) and integer `budget_min` (60–600). Other fields default to `min_stops=3`, `max_stops=6`, `max_leg_min=60`, `max_per_category=2`, empty include/exclude arrays, `seed=44`, `costing=auto`, and `with_windows=true`. Minimum stops may not exceed maximum. Excluded spots are limited to 60 IDs; required spots to 12. The start node, when supplied, must be a catalog spot. The request is rejected unless cuOpt has been explicitly enabled and the private key is readable. This route calls the optional hosted solver, so it is intended for controlled owner/admin evaluation only.

`PATCH /admin/trails/:id`

At least one recognized property is required. Unknown properties are rejected.

```json
{
  "title": "Updated title",
  "tagline": "Short description",
  "tier": "signature",
  "price_points": 300,
  "available_from": "2026-11-01T00:00:00+08:00",
  "available_until": "2026-11-15T00:00:00+08:00",
  "narration": [{ "position": 1, "text": "Stop-specific narration" }]
}
```

Title is trimmed and 3–80 characters; tagline is trimmed and up to 160; editable tiers are `starter | explorer | signature | legendary`; price is an integer 1–100,000 and is valid only for Signature/Legendary; availability values are timezone-qualified ISO datetimes or `null`; narration contains 1–12 strict `{position: 1..12, text: <=400 chars}` records, each position only once and corresponding to an existing stop. Setting tier maps the unlock rule to free for starter, level 5 for explorer, or points for signature/legendary (defaults 300/500 unless supplied). A `price_points`-only update preserves the current price when tier is unchanged.

### Error codes and status mapping

| HTTP | Codes | Meaning |
|---:|---|---|
| `400` | `VALIDATION_ERROR` | Invalid request schema, unsupported costing, review decision other than `submit`, invalid stop set/start spot, or other request validation failure. |
| `400` | `INVALID_AVAILABILITY` | `available_from` is not earlier than `available_until`. |
| `400` | `PRICE_NOT_ALLOWED` | A price was supplied while the effective tier is not Signature or Legendary. |
| `400` | `DUPLICATE_STOP_POSITION` | Same stop position supplied more than once in narration edits. |
| `400` | `STOP_NOT_FOUND` | Narration references a position not present in that trail. |
| `400` | `SPOT_SET_INVALID`, `START_SPOT_INVALID` | Solver comparison includes a spot that is not eligible public catalog data, or an invalid start spot. |
| `401` / `403` | Authentication/admin middleware response | Missing/invalid authentication or authenticated user is not an administrator. The router-level guard applies to every endpoint here. |
| `404` | `TRAIL_NOT_FOUND` | PATCH target is not an editable engine-generated trail. |
| `404` | `TRAIL_NOT_REVIEWABLE` | Status action target is absent/not engine-generated, or publish was attempted before submission to review. |
| `422` | `NO_FEASIBLE_TRAIL` | Generation could not satisfy the stop, schedule, travel, and diversity constraints after documented relaxations. No partial generation is persisted. |
| `422` | `CUOPT_INFEASIBLE` | cuOpt returned no route meeting submitted constraints. |
| `503` | `DATABASE_UNAVAILABLE` | Trail database pool is unavailable. |
| `503` | `MATRIX_UNAVAILABLE`, `MATRIX_REFRESH_FAILED` | Matrix status read or refresh failed. |
| `503` | `TRAILS_UNAVAILABLE`, `TRAIL_REVIEW_UNAVAILABLE` | Engine trail catalog/review queue read failed. |
| `503` | `GENERATION_FAILED` | Generation failed outside the explicit no-feasible result; transaction is rolled back. |
| `503` | `CUOPT_DISABLED` | cuOpt feature is off, unavailable in test mode, or private key file is not available. |
| `503` | `CUOPT_TIMEOUT`, `CUOPT_UNAVAILABLE`, `CUOPT_MALFORMED` | Hosted comparison timed out, upstream failed, or response contract was invalid. |
| `503` | `SOLVER_COMPARISON_FAILED` | Comparison failed; benchmark rows are transactionally rolled back. |
| `503` | `TRAIL_UPDATE_FAILED` | Trail edit or status change failed; no partial edit is committed. |

## Scope and safety boundary

At this checkpoint the route module contains only admin Trail Engine APIs. It does **not** expose the traveler-facing catalog, unlock, personal-generation, check-in, completion, or reward APIs described as future product scope in Plan 44. Do not infer their availability from the migration's forward-compatible tables. Local deterministic generation is the operational solver. Hosted cuOpt remains disabled by default and only belongs to benchmark/compare paths. See the [Trail Engine operator note](../09-operations/trail-engine-operator-note.md), [schema reference](../05-database/trail-engine-schema.md), and [benchmark](../07-testing/trail-engine-benchmark.md).
