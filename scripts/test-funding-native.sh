#!/usr/bin/env bash
# Disposable PostgreSQL + Linux-native source snapshot; no operator DB access.
set -euo pipefail
source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
candidate="$(mktemp -d /tmp/jdq-funding-test.XXXXXX)"
echo "Staging native funding-test source: $candidate"
container="jdq-funding-test-$(date +%s)-$RANDOM"
created=false
cleanup() { if [[ "$created" == true ]]; then docker stop --time 5 "$container" >/dev/null || true; fi; }
trap cleanup EXIT

# Explicit source allowlist avoids copying local .env, uploads or live artifacts.
tar -C "$source_dir" -cf - src tests migrations package.json package-lock.json tsconfig.json jest.config.js |
  tar -C "$candidate" -xf -
lock_hash="$(sha256sum "$candidate/package-lock.json" | cut -d' ' -f1)"
dependency_cache="/tmp/jdq-funding-deps-$lock_hash"
mkdir -p "$dependency_cache"
(
  flock 9
  if [[ ! -f "$dependency_cache/ready" ]]; then
    cp "$candidate/package.json" "$candidate/package-lock.json" "$dependency_cache/"
    (cd "$dependency_cache" && npm ci --ignore-scripts --no-audit --no-fund)
    touch "$dependency_cache/ready"
  fi
) 9>"$dependency_cache/install.lock"
ln -s "$dependency_cache/node_modules" "$candidate/node_modules"

password="$(openssl rand -hex 24)"
docker run --rm -d --name "$container" -e POSTGRES_USER=postgres -e "POSTGRES_PASSWORD=$password" \
  -e POSTGRES_DB=jdq_reliability_test -p 127.0.0.1::5432 postgres:16-alpine >/dev/null
created=true
for attempt in {1..30}; do
  if timeout 10s docker exec "$container" pg_isready -U postgres -d jdq_reliability_test >/dev/null 2>&1; then break; fi
  if [[ "$attempt" == 30 ]]; then echo 'Disposable PostgreSQL did not become ready.' >&2; exit 1; fi
  sleep 1
done
port="$(docker port "$container" 5432/tcp | head -n1 | sed 's/.*://')"
export NODE_ENV=test JWT_SECRET=test-super-secret-jwt-key-for-ci-only ALLOW_IN_MEMORY_FALLBACK=false
export JDQ_REAL_PG_URL="postgres://postgres:$password@127.0.0.1:$port/jdq_reliability_test"
export DATABASE_URL="$JDQ_REAL_PG_URL"
echo "Native test snapshot: $candidate; disposable container: $container"
cd "$candidate"
if [[ "$#" == 0 ]]; then
  set -- tests/funding-plans-realpg.test.ts tests/merchant-points-realpg.test.ts tests/migrations-verify.test.ts
fi
node node_modules/jest/bin/jest.js --runInBand --detectOpenHandles "$@"
