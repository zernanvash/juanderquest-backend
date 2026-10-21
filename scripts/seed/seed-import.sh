#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$repo_root"
: "${DATABASE_URL:?Set DATABASE_URL to your own loopback preview/test database}"
export DB_MIGRATION_MODE=verify
export SEED_DEVELOPMENT_DATA=false
export ALLOW_IN_MEMORY_FALLBACK=false
tsx_bin=${JDQ_TSX_BIN:-"$repo_root/node_modules/.bin/tsx"}
exec "$tsx_bin" scripts/seed/seed-import.ts "$@"
