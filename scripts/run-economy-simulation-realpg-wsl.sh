#!/usr/bin/env bash
# Execute fictional economy scenarios only in disposable schemas on the
# loopback reliability PostgreSQL container. Never use alpha/presentation DB.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
container='jdq-reliability-pg-20260910'
if [[ "$(docker port "$container" 5432)" != '127.0.0.1:55432' ]]; then
  echo 'Expected loopback reliability PostgreSQL container is unavailable.' >&2
  exit 1
fi
database_name="$(docker exec "$container" printenv POSTGRES_DB)"
database_user="$(docker exec "$container" printenv POSTGRES_USER)"
database_password="$(docker exec "$container" printenv POSTGRES_PASSWORD)"
if [[ "$database_name" != 'jdq_reliability_test' || -z "$database_user" || -z "$database_password" ]]; then
  echo 'Disposable reliability database identity mismatch.' >&2
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
unset database_password
export NODE_ENV=test
export JDQ_ECONOMY_ACCEPTANCE=true
cd "$repo_dir"
node ./node_modules/typescript/bin/tsc -p tsconfig.simulation.json
exec node dist-simulation/scripts/economy-simulation.js "$@"
