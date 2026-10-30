#!/usr/bin/env bash
# Executes the thesis benchmark against Codex's disposable preview database only.
set -euo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
container='jdq-reliability-pg-20260910'
if [[ "$(docker port "$container" 5432)" != '127.0.0.1:55432' ]]; then
  echo 'The exact loopback reliability PostgreSQL port is unavailable.' >&2; exit 1
fi
database_name="$(docker exec "$container" printenv POSTGRES_DB)"
database_user="$(docker exec "$container" printenv POSTGRES_USER)"
database_password="$(docker exec "$container" printenv POSTGRES_PASSWORD)"
if [[ "$database_name" != 'jdq_reliability_test' || -z "$database_user" || -z "$database_password" ]]; then
  echo 'Reliability PostgreSQL identity did not match the isolated test database.' >&2; exit 1
fi
export DATABASE_URL="$(JDQ_DB_USER="$database_user" JDQ_DB_PASSWORD="$database_password" node -e '
  const url = new URL("postgresql://127.0.0.1:55432/jdq_preview_codex_dev");
  url.username = process.env.JDQ_DB_USER; url.password = process.env.JDQ_DB_PASSWORD; process.stdout.write(url.toString());
')"
unset database_password
export NODE_ENV=development DB_MIGRATION_MODE=verify SEED_DEVELOPMENT_DATA=false ALLOW_IN_MEMORY_FALLBACK=false TRAILS_CUOPT_ENABLED=false
export TRAIL_BENCHMARK_REPORT_PATH="${TRAIL_BENCHMARK_REPORT_PATH:-/mnt/c/Users/HP/Desktop/Code/JuanderQuest/docs/07-testing/trail-engine-benchmark.md}"
cd "$repo_dir"
node node_modules/tsx/dist/cli.mjs scripts/trail-benchmark.ts
