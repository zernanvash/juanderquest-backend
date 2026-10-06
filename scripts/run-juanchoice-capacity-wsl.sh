#!/usr/bin/env bash
# Run the compiled, disposable JuanChoice capacity preflight inside WSL so
# Node and PostgreSQL share one OS. Never targets the laptop alpha database.
set -euo pipefail

duration_ms="${1:-30000}"
pool_max="${2:-5}"
ballot_mode="${3:-sequential}"
client_mode="${4:-inprocess}"
reader_auth_mode="${5:-guest}"
if ! [[ "$duration_ms" =~ ^[0-9]+$ ]] || (( duration_ms < 30000 || duration_ms > 600000 )); then
  echo 'Duration must be 30000–600000 ms.' >&2
  exit 1
fi
if ! [[ "$pool_max" =~ ^[0-9]+$ ]] || (( pool_max < 1 || pool_max > 50 )); then
  echo 'Pool size must be 1–50.' >&2
  exit 1
fi
if [[ "$ballot_mode" != 'batch' && "$ballot_mode" != 'sequential' ]]; then
  echo 'Ballot mode must be "batch" or "sequential".' >&2
  exit 1
fi
if [[ "$client_mode" != 'inprocess' && "$client_mode" != 'child_process' ]]; then
  echo 'Client mode must be "inprocess" or "child_process".' >&2
  exit 1
fi
if [[ "$reader_auth_mode" != 'guest' && "$reader_auth_mode" != 'wallet_alpha' ]]; then
  echo 'Reader auth mode must be "guest" or "wallet_alpha".' >&2
  exit 1
fi

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
container='jdq-reliability-pg-20260910'
if [[ "$(docker port "$container" 5432)" != '127.0.0.1:55432' ]]; then
  echo 'The exact loopback reliability PostgreSQL port is unavailable.' >&2
  exit 1
fi
database_name="$(docker exec "$container" printenv POSTGRES_DB)"
database_user="$(docker exec "$container" printenv POSTGRES_USER)"
database_password="$(docker exec "$container" printenv POSTGRES_PASSWORD)"
if [[ "$database_name" != 'jdq_reliability_test' || -z "$database_user" || -z "$database_password" ]]; then
  echo 'Reliability PostgreSQL identity did not match the isolated test database.' >&2
  exit 1
fi
# Verify compiled artifacts exist
capacity_rehearsal_js="$repo_dir/.local/capacity-build/scripts/juanchoice-capacity-rehearsal.js"
capacity_child_client_js="$repo_dir/.local/capacity-build/scripts/juanchoice-capacity-child-client.js"
capacity_segments_js="$repo_dir/.local/capacity-build/scripts/juanchoice-capacity-segments.js"
capacity_mode_js="$repo_dir/.local/capacity-build/scripts/juanchoice-capacity-mode.js"
capacity_probe_js="$repo_dir/.local/capacity-build/scripts/juanchoice-pool-acquisition-probe.js"

if [[ ! -f "$capacity_rehearsal_js" ||
      ! -f "$capacity_child_client_js" ||
      ! -f "$capacity_segments_js" ||
      ! -f "$capacity_mode_js" ||
      ! -f "$capacity_probe_js" ]]; then
  echo 'Compiled capacity harness scripts are missing. Rebuild with "tsc -p tsconfig.capacity.json --noEmit false --outDir .local/capacity-build".' >&2
  exit 1
fi

# Fail closed if any relevant TypeScript source file is newer than the compiled main harness
newest_source="$(find "$repo_dir/src" -type f -name '*.ts' -newer "$capacity_rehearsal_js" -print -quit)"
if [[ -n "$newest_source" ]]; then
  echo "Compiled capacity harness is stale; source file $newest_source is newer than compiled script. Rebuild with \"tsc -p tsconfig.capacity.json --noEmit false --outDir .local/capacity-build\"." >&2
  exit 1
fi

newest_script="$(find "$repo_dir/scripts" -maxdepth 1 -type f \( -name 'juanchoice-capacity-*.ts' -o -name 'juanchoice-pool-acquisition-probe.ts' \) | while read -r script_file; do
  if [[ "$script_file" -nt "$capacity_rehearsal_js" ]]; then
    echo "$script_file"
    break
  fi
done)"
if [[ -n "$newest_script" ]]; then
  echo "Compiled capacity harness is stale; script source $newest_script is newer than compiled script. Rebuild with \"tsc -p tsconfig.capacity.json --noEmit false --outDir .local/capacity-build\"." >&2
  exit 1
fi

# Compare copied migrations 020-023 with source migrations byte-for-byte
for mig in 020_juanchoice_monthly_schedules.sql \
           021_juanchoice_unverified_offer_quarantine.sql \
           022_juanchoice_unfunded_budget_quarantine.sql \
           023_juanchoice_promotion_assessments.sql; do
  src_mig="$repo_dir/migrations/$mig"
  build_mig="$repo_dir/.local/capacity-build/migrations/$mig"
  if [[ ! -f "$build_mig" ]]; then
    echo "Copied migration $mig is missing in .local/capacity-build/migrations/. Copy source migrations before running." >&2
    exit 1
  fi
  if ! cmp -s "$src_mig" "$build_mig"; then
    echo "Copied migration $mig in .local/capacity-build/migrations/ does not match source byte-for-byte. Re-copy source migrations before running." >&2
    exit 1
  fi
done


report_dir="$repo_dir/.local/capacity-reports"
mkdir -p "$report_dir"
timestamp="$(date -u +'%Y%m%dT%H%M%SZ')"
report_file="$(mktemp "$report_dir/capacity-${timestamp}-XXXXXXXX.log")"
report_real="$(realpath "$report_file")"
report_dir_real="$(realpath "$report_dir")"
if [[ "$report_real" != "$report_dir_real/"* ]]; then
  echo 'Reserved capacity report path resolved outside .local/capacity-reports.' >&2
  exit 1
fi

export JDQ_REAL_PG_URL="$(
  JDQ_DB_USER="$database_user" JDQ_DB_PASSWORD="$database_password" node -e '
    const url = new URL("postgresql://127.0.0.1:55432/jdq_reliability_test");
    url.username = process.env.JDQ_DB_USER;
    url.password = process.env.JDQ_DB_PASSWORD;
    process.stdout.write(url.toString());
  '
)"
export NODE_ENV=test
export JDQ_CAPACITY_DURATION_MS="$duration_ms"
export JDQ_CAPACITY_POOL_MAX="$pool_max"
export JDQ_CAPACITY_BALLOT_MODE="$ballot_mode"
export JDQ_CAPACITY_CLIENT_MODE="$client_mode"
export JDQ_CAPACITY_READER_AUTH="$reader_auth_mode"
export NODE_PATH="$repo_dir/node_modules"
unset database_password
cd "$repo_dir"
set +e
node "$repo_dir/.local/capacity-build/scripts/juanchoice-capacity-rehearsal.js" | tee "$report_file"
pipeline_status=("${PIPESTATUS[@]}")
set -e

harness_exit="${pipeline_status[0]:-1}"
tee_exit="${pipeline_status[1]:-0}"

echo "CAPACITY_REPORT_FILE $report_file"

if [[ "$harness_exit" -ne 0 ]]; then
  exit "$harness_exit"
fi

if [[ "$tee_exit" -ne 0 ]]; then
  exit "$tee_exit"
fi
