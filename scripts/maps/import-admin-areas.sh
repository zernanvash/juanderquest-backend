#!/bin/sh
set -eu

# Like backfill-plaza-activities.sh and reconcile-alpha-merchants.sh,
# this verifies the ledger before any work.
# Operators must supply the target DATABASE_URL explicitly after taking a backup.
# No container introspection, secret printing, or implicit alpha target.
if [ -z "${DATABASE_URL:-}" ]; then
  echo 'DATABASE_URL must explicitly name the backed-up target database.' >&2
  exit 2
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$script_dir/../.."

export DB_MIGRATION_MODE=verify
export SEED_DEVELOPMENT_DATA=false
export ALLOW_IN_MEMORY_FALLBACK=false
export JWT_SECRET="${JWT_SECRET:-admin-areas-import-placeholder-secret}"
export CORS_ORIGIN="${CORS_ORIGIN:-http://127.0.0.1:3110}"

exec npx tsx scripts/maps/import-admin-areas.ts "$@"
