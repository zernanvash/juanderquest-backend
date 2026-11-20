#!/usr/bin/env bash
# Plan 116 §7: run import-areas.ts against a WORK database (run in WSL).
#   scripts/seed/areas/run-import.sh ~/.jdq-secrets/workdb-jdq_r_areas.env --region all [--apply]
# The env file must define WORKDB_OWNER_URL; it becomes DATABASE_URL and is never printed.
set -euo pipefail
env_file="${1:?secrets env file}"
shift
# shellcheck disable=SC1090
source "$env_file"
: "${WORKDB_OWNER_URL:?WORKDB_OWNER_URL missing}"
case "$WORKDB_OWNER_URL" in
  *:55433/*) echo 'Refusing: that is the live production port.' >&2; exit 2 ;;
esac
export DATABASE_URL="$WORKDB_OWNER_URL"
unset WORKDB_OWNER_URL WORKDB_APP_URL WORKDB_READONLY_URL
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$repo_dir"
exec npx tsx scripts/seed/areas/import-areas.ts "$@"
