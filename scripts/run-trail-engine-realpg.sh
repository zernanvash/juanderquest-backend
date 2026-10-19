#!/usr/bin/env bash
# Runs the complete backend Jest suite against only the disposable reliability DB.
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
export JDQ_REAL_PG_URL="$(JDQ_DB_USER="$database_user" JDQ_DB_PASSWORD="$database_password" node -e '
  const url = new URL("postgresql://127.0.0.1:55432/jdq_reliability_test");
  url.username = process.env.JDQ_DB_USER; url.password = process.env.JDQ_DB_PASSWORD; process.stdout.write(url.toString());
')"
export DATABASE_URL="$JDQ_REAL_PG_URL"
# WSL cannot parse the Windows absolute gitdir stored in a Windows worktree's
# .git file. Set equivalent Linux paths only for that worktree; native WSL
# clones should use their own local .git directory.
if [[ -f "$repo_dir/.git" ]]; then
  export GIT_DIR='/mnt/c/Users/HP/Desktop/Code/JuanderQuest/backend/.git/worktrees/codex-trail-engine-backend'
  export GIT_WORK_TREE="$repo_dir"
else
  unset GIT_DIR GIT_WORK_TREE
fi
unset database_password
export NODE_ENV=test
cd "$repo_dir"
if [[ "$#" -gt 0 ]]; then
  test_files=()
  test_pattern=''
  for arg in "$@"; do
    if [[ "$arg" =~ ^tests/[a-z0-9-]+\.test\.ts$ ]]; then test_files+=("$arg")
    elif [[ "$arg" =~ ^--testNamePattern=[A-Za-z0-9_\ -]+$ ]]; then test_pattern="$arg"
    else echo 'Only literal backend test paths and a plain testNamePattern are accepted.' >&2; exit 2; fi
  done
  if [[ -n "$test_pattern" ]]; then npx jest --runInBand "${test_files[@]}" "$test_pattern"
  else npx jest --runInBand "${test_files[@]}"; fi
else
  npx jest --runInBand
fi
