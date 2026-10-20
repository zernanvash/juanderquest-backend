# Trail Engine schema — migration 055

Migration: [`migrations/055_trail_engine.sql`](../../migrations/055_trail_engine.sql), registered as `055_trail_engine.sql` in the backend migration runner. It is additive: it creates Trail Engine tables and copies the existing curated trail records; it does not remove or rewrite the source collection tables. Apply only through the reviewed migration runner and only after the required backup/rehearsal gate. Production application is outside this implementation task.

## Tables and constraints

| Table | Purpose and important constraints |
|---|---|
| `trail_generations` | Audit/evaluation output. `kind` is `weekly_batch | admin | personal | benchmark`; `solver` is `local | cuopt | exact`; nonnegative `solver_ms`; JSONB `input`, `constraints`, `result`; optional request user, AI model, `ai_used`, `ai_fallback_reason`; timestamp. |
| `trails` | Trail catalog and generated trail metadata. Text primary key, unique slug; title length 3–80, tagline ≤160; tier `starter | explorer | signature | legendary | personal`; status `draft | pending_review | published | retired | rejected`; source `curated | engine | personal`; costing `auto | pedestrian | bicycle | motorcycle`; nonnegative distance and positive duration; JSONB unlock rule/story; municipalities text array; optional generation/reviewer/availability; version and `is_test`. Checks require personal tier iff owner is present and personal tier iff source is personal. Partial indexes support public catalog and owner queries. |
| `trail_stops` | Ordered stop per trail. Composite primary key `(trail_id, position)`, unique spot per trail, position 1–12, spot FK restricts deletion, nonnegative arrival offset, dwell 10–240 minutes, narration ≤400 chars, check-in radius 30–500 m (default 100). Trail deletion cascades to stops. |
| `trail_unlocks` | One user unlock per trail, composite primary key; method `free | level | badge | points | owner`; nonnegative point price; optional ledger group; globally unique idempotency key; timestamp. |
| `trail_checkins` | One recorded check-in per user/trail/position; links to a real stop using `(trail_id, position)` FK; stores verified time, distance and optional accuracy. |
| `trail_completions` | Once-per-trail/user completion (composite primary key), trail version, reward points, optional ledger group and completion time. The table is schema groundwork; check-in/completion routes are not yet implemented. |
| `travel_time_matrix` | Directed leg cache keyed by costing/from/to; nonnegative integer seconds/meters, approximate flag, graph label and computation timestamp; spot FKs; index by costing and newest computation. |
| `trend_digests` | One weekly aggregate digest per `week_id` primary key; JSONB signals and digest, model/use metadata, timestamp. |
| `ai_cache` | Cached structured response keyed by SHA-256 cache key; purpose, JSONB response, created and expiry times. Expiry is enforced when reading, with TTL selected by AI purpose in application code. |

## Curated-trail upgrade

The migration idempotently copies the four known active curated trails when they are active and have `category='trail'`: `coastal_wonders_trail`, `pangasinan_heritage_trail`, `pangasinan_eco_escapes`, and `pangasinan_culinary_trail`. The copied `trails.id` is the original collection ID, preserving existing completion/activity identifiers. Rows are starter-tier, curated-source, free-unlock, published, non-test records. `ON CONFLICT (id) DO NOTHING` protects reruns. Stops are copied from `curated_collection_spots` ordered by `order_index` then `spot_id`, numbered from 1; initial dwell is 45 minutes and offsets/legs are placeholders at zero. The source collections and their existing badge/API behavior remain intact. Matrix refresh/recomputation is separate from the migration.

## Deliberate non-changes and current implementation status

- Migration 055 does not modify pre-existing migrations or widen the governance-ledger type check; current engine generation does not debit or award balances.
- Unlock, check-in, completion, personal trails, economy settlement and associated Plaza completion producer are **not implemented yet** (Plan 44 Phase 3; waiting for Plan 43 integration for shared location verification).
- Admin web Trail Studio (§8), traveler web hub (§7), and Flutter screens are **not implemented**. The backend admin endpoints exist, but no UI should be assumed.
- See the [Trail Engine admin API reference](../04-api/trail-engine-admin-api.md), [operator note](../09-operations/trail-engine-operator-note.md), and the [Plan 44 implementation plan in the workspace](../../../../implementation_plans/44-ai-optimized-unlockable-trails.md).
