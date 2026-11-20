#!/usr/bin/env bash
# Plan 116: run backend Jest against the disposable PostGIS test cluster
# (jdq-reliability-pg-116, created by bootstrap.sh --profile test). Run in WSL.
#   scripts/prod-db/run-realpg.sh                      # whole suite
#   scripts/prod-db/run-realpg.sh tests/foo.test.ts    # selected files
set -euo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
secrets="$HOME/.jdq-secrets/jdq-reliability-pg-116.env"
[ -f "$secrets" ] || { echo "Missing $secrets; run scripts/prod-db/bootstrap.sh --profile test" >&2; exit 1; }
# shellcheck disable=SC1090
. "$secrets"
[ "${PG_DB:-}" = jdq_reliability_test ] || { echo 'Secrets are not for the test cluster.' >&2; exit 1; }
export JDQ_REAL_PG_URL DATABASE_URL="$JDQ_REAL_PG_URL" NODE_ENV=test JDQ_REAL_PG_DOCKER_CONTAINER="$PG_CONTAINER"
unset POSTGRES_SUPERUSER_PASSWORD JDQ_OWNER_URL JDQ_APP_URL JDQ_READONLY_URL
# WSL cannot read the Windows gitdir in a Windows worktree's .git file.
if [[ -f "$repo_dir/.git" ]]; then
  export GIT_DIR="/mnt/c/Users/HP/Desktop/Code/JuanderQuest/backend/.git/worktrees/$(basename "$repo_dir")"
  export GIT_WORK_TREE="$repo_dir"
fi
cd "$repo_dir"
for arg in "$@"; do
  [[ "$arg" =~ ^(tests/[A-Za-z0-9._-]+\.test\.ts|--testNamePattern=[A-Za-z0-9_\ -]+)$ ]] || { echo "Rejected argument: $arg" >&2; exit 2; }
done
exec npx jest --runInBand "$@"
