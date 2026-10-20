# Trail Engine operator note (local/controlled setup)

This is an operational reference, not authorization to enable hosted AI/optimization or deploy the Trail Engine.

## NVIDIA NIM story/trend AI

- The API key is read from the private file `~/.config/juanderquest-alpha/nvidia-api-key`. Keep it outside the repository, never print it, and never place it in `runtime.env` or a committed `.env` file. The application checks that it is a regular non-empty file, restricts permissions/ownership on Unix, and refuses key reads in test mode.
- `NIM_BASE_URL` defaults to `https://integrate.api.nvidia.com/v1`; `NIM_MODEL` defaults to `nvidia/nemotron-3.5-lightning-30b-a3b`. The production NIM client is host-pinned to NVIDIA's integrate endpoint. Do not point production at an arbitrary host.
- NIM is advisory: the deterministic optimizer chooses/order stops. NIM may produce only schema-validated structured trend/preference/story output from allowed facts; it cannot add destinations or decide a route.
- Every output is cached in `ai_cache` by purpose/model/prompt-version/input. TTLs are 7 days for trends, 24 hours for parsed preferences and 30 days for trail stories. A process-local token bucket allows 30 requests/minute. Calls time out after 20 seconds and retry up to twice on 429/5xx.
- Missing/unreadable key, disabled/misconfigured service, rate limit, timeout, upstream failure, invalid JSON/schema, place hallucination or cache failure yields a deterministic fallback and `ai_fallback_reason`; generated trail metadata reports `ai_used=false`. Weekly trend processing is idempotent per Manila week and only creates pending-review candidates; it never publishes them.

## Optional hosted cuOpt benchmark

- `TRAILS_CUOPT_ENABLED` defaults to `false`. Keep it false unless the owner explicitly requests a controlled evaluation.
- cuOpt additionally requires the same private NVIDIA key file. It is never used for traveler requests or standard trail generation; the only application endpoint is admin-only `POST /api/v1/admin/trails/compare-solvers`, and the other entry point is the benchmark script. Calls use NVIDIA's hosted endpoint, asynchronously poll `NVCF-REQID`, stop at 60 seconds, then validate feasibility and re-score with the local objective.
- Hosted cuOpt is evaluation-only under the plan's stated service restrictions. No key is provisioned by this documentation task; benchmark report columns remain `pending owner key` until an authorized run.

The backend's current standard trail generation remains local CPU optimization, with story fallback available. Phase 3 unlock/check-in/economy, Trail Studio UI, traveler web, and mobile are not yet built. Consult [API](../04-api/trail-engine-admin-api.md), [schema](../05-database/trail-engine-schema.md), [benchmark](../07-testing/trail-engine-benchmark.md), and [Plan 44](../../../../implementation_plans/44-ai-optimized-unlockable-trails.md) before operating.
