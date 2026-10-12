#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
container=jdq-reliability-pg-20260910
[[ "$(docker port "$container" 5432)" == '127.0.0.1:55432' ]] || {
  echo 'Expected disposable reliability PostgreSQL on loopback 55432' >&2
  exit 1
}
[[ "$(docker exec "$container" printenv POSTGRES_DB)" == 'jdq_reliability_test' ]] || {
  echo 'Refusing unexpected PostgreSQL parent database' >&2
  exit 1
}
db_user="$(docker exec "$container" printenv POSTGRES_USER)"
db_password="$(docker exec "$container" printenv POSTGRES_PASSWORD)"
export JDQ_REAL_PG_URL="$(DB_USER="$db_user" DB_PASSWORD="$db_password" node -e 'const u=new URL("postgresql://127.0.0.1:55432/jdq_reliability_test");u.username=process.env.DB_USER;u.password=process.env.DB_PASSWORD;process.stdout.write(u.href)')"
unset db_password
if [[ "$#" -eq 0 ]]; then
  set -- tests/economy-browser-reads-realpg.test.ts
fi
for test_file in "$@"; do
  [[ "$test_file" =~ ^tests/[a-z0-9-]+\.test\.ts$ ]] || {
    echo 'Only explicit backend test file paths are accepted.' >&2
    exit 2
  }
done
exec npm test -- --runInBand "$@"
