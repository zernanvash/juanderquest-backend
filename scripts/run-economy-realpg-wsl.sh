#!/usr/bin/env bash
# Run the economic pilot acceptance suites against only the disposable reliability DB.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
container='jdq-reliability-pg-20260910'
expected_port='127.0.0.1:55432'

if [[ "$(docker port "$container" 5432)" != "$expected_port" ]]; then
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
cd "$repo_dir"
if [[ "$#" -gt 0 ]]; then
  for test_file in "$@"; do
    if [[ ! "$test_file" =~ ^tests/[a-z0-9-]+\.test\.ts$ ]]; then
      echo 'Only literal backend test paths are accepted.' >&2
      exit 2
    fi
  done
  test_files=("$@")
else
  test_files=(
    tests/harness.test.ts tests/migrations-verify.test.ts tests/economic-backbone.test.ts
    tests/economy-simulation.test.ts tests/economy-admin-response.test.ts
    tests/economy-http-realpg.test.ts tests/economy-ledger-integrity-realpg.test.ts
    tests/economy-restricted-role-realpg.test.ts tests/economy-correction-realpg.test.ts
    tests/economy-canonical-authority-realpg.test.ts
    tests/economic-outbox-realpg.test.ts
    tests/economy-appeal-realpg.test.ts
    tests/economy-refund-realpg.test.ts
    tests/economy-expiry-realpg.test.ts
  )
fi
node ./node_modules/jest/bin/jest.js --detectOpenHandles --runInBand --testTimeout=120000 "${test_files[@]}"
