#!/bin/sh
set -eu

# Local alpha only: runs the merchant affiliation reconciliation report
# (log-only, never mutates). Mirrors the environment extraction used by
# start-home-alpha.sh; secrets stay in the operator's environment.
if [ -z "${JDQ_ALPHA_JWT_SECRET:-}" ]; then
  secret_file="${JDQ_ALPHA_JWT_SECRET_FILE:-$HOME/.config/juanderquest-alpha/jwt-secret}"
  if [ -f "$secret_file" ]; then
    JDQ_ALPHA_JWT_SECRET=$(sed -n '1p' "$secret_file")
  fi
fi

db_password=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' jdq-alpha-postgres |
  sed -n 's/^POSTGRES_PASSWORD=//p')
if [ -z "$db_password" ]; then
  echo 'Cannot read the dedicated jdq-alpha-postgres credentials.' >&2
  exit 1
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$script_dir/.."

export NODE_ENV=production
export DATABASE_URL="postgres://jdq_alpha:${db_password}@127.0.0.1:55433/juanderquest_alpha"
export JWT_SECRET="${JDQ_ALPHA_JWT_SECRET:-reconcile-only-placeholder-secret-placeholder-secret-placeholder}"
export CORS_ORIGIN='https://juanderquest.app'

exec npx tsx scripts/reconcile-merchants.ts
