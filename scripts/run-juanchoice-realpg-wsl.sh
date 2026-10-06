#!/usr/bin/env bash
# Run an explicitly named Jest suite against the isolated WSL reliability DB.
set -euo pipefail

mode="${1:-}"
case "$mode" in
  upgrade) suite='tests/juanchoice-monthly-upgrade.test.ts' ;;
  retention) suite='tests/juanchoice-retention.test.ts' ;;
  pilot) suite='tests/juanchoice-pilot.test.ts' ;;
  promotion) suite='tests/juanchoice-promotion-assessments.test.ts' ;;
  lifecycle) suite='tests/juanchoice-monthly-lifecycle-realpg.test.ts' ;;
  *) echo 'Choose upgrade, retention, pilot, promotion, or lifecycle.' >&2; exit 1 ;;
esac

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

export JDQ_REAL_PG_URL="$(
  JDQ_DB_USER="$database_user" JDQ_DB_PASSWORD="$database_password" node -e '
    const url = new URL("postgresql://127.0.0.1:55432/jdq_reliability_test");
    url.username = process.env.JDQ_DB_USER;
    url.password = process.env.JDQ_DB_PASSWORD;
    process.stdout.write(url.toString());
  '
)"
export NODE_ENV=test
unset database_password
cd "$repo_dir"
if [[ -n "${2:-}" ]]; then
  node ./node_modules/jest/bin/jest.js --detectOpenHandles --runInBand "$suite" --testNamePattern "$2"
else
  node ./node_modules/jest/bin/jest.js --detectOpenHandles --runInBand "$suite"
fi
