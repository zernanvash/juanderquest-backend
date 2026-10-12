#!/usr/bin/env bash
# Local-only API for one marked, disposable economy browser fixture.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
database_name="${1:-}"
fixture_marker="${2:-}"
benchmark_mode="${3:-}"
if [[ ! "$database_name" =~ ^jdq_economy_lab_[a-f0-9]{12}_dev$ ]] ||
   [[ ! "$fixture_marker" =~ ^[0-9a-fA-F-]{36}$ ]] ||
   [[ -n "$benchmark_mode" && "$benchmark_mode" != '--benchmark' ]]; then
  echo 'Usage: bash scripts/start-economy-browser-api.sh <exact-lab-database> <exact-marker-uuid> [--benchmark]' >&2
  exit 2
fi
if [[ "$(docker port jdq-reliability-pg-20260910 5432)" != '127.0.0.1:55432' ]] ||
   [[ "$(docker exec jdq-reliability-pg-20260910 printenv POSTGRES_DB)" != 'jdq_reliability_test' ]]; then
  echo 'Reliability PostgreSQL identity mismatch.' >&2
  exit 1
fi
if [[ -f /mnt/c/Users/HP/.cloudflared/config.yml ]] &&
   grep -Eq 'service:[[:space:]]*https?://(127\.0\.0\.1|localhost):(3300|4300)([[:space:]]|/|$)' /mnt/c/Users/HP/.cloudflared/config.yml; then
  echo 'A public tunnel targets a lab port. Refusing to launch.' >&2
  exit 1
fi

cd "$repo_dir"
node scripts/economy-browser-fixture.mjs --check "$database_name" "$fixture_marker" >/dev/null
if [[ "$benchmark_mode" == '--benchmark' ]]; then
  fixture_profile="$(docker exec jdq-reliability-pg-20260910 psql -U "$(docker exec jdq-reliability-pg-20260910 printenv POSTGRES_USER)" -d "$database_name" -Atqc "SELECT fixture_version FROM economy_browser_lab_marker WHERE id = '$fixture_marker'" 2>/dev/null)"
  if [[ "$fixture_profile" != 'browser-lab-bench-v2' ]]; then
    echo 'Benchmark tracing requires an exact marked benchmark-v2 fixture.' >&2
    exit 1
  fi
  export ECONOMY_BENCH_TRACE=true
fi
database_password="$(docker exec jdq-reliability-pg-20260910 printenv POSTGRES_PASSWORD)"
export DATABASE_URL="$(
  JDQ_DB_OWNER_PASSWORD="$database_password" JDQ_DB_NAME="$database_name" JDQ_DB_MARKER="$fixture_marker" node -e '
    const { createHmac } = require("crypto");
    const suffix = process.env.JDQ_DB_NAME.match(/jdq_economy_lab_([a-f0-9]{12})_dev/)[1];
    const u = new URL(`postgresql://127.0.0.1:55432/${process.env.JDQ_DB_NAME}`);
    u.username = `jdq_econ_lab_${suffix}_app`;
    u.password = createHmac("sha256", process.env.JDQ_DB_OWNER_PASSWORD)
      .update(`economy-browser-lab:${process.env.JDQ_DB_MARKER}`).digest("hex");
    process.stdout.write(u.toString());
  '
)"
unset database_password
export JDQ_ENV=dev NODE_ENV=development HOST=127.0.0.1 PORT=4300
export DB_MIGRATION_MODE=verify ALLOW_IN_MEMORY_FALLBACK=false SEED_DEVELOPMENT_DATA=false
export CORS_ORIGIN=http://127.0.0.1:3300,http://127.0.0.1:5175
export WALLET_AUTH_MODE=local ALLOW_INSECURE_LOCAL_WALLET_AUTH=true ALLOW_DEMO_LOGIN=true
export GUEST_LOGIN_ENABLED=true JUANCHOICE_WRITES_ENABLED=false JUANCHOICE_ECONOMY_ENABLED=false
echo "ECONOMY_LAB_API_START database=$database_name host=127.0.0.1 port=4300"
exec node dist/server.js
