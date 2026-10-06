#!/bin/sh
set -eu

# Local alpha only. Secrets stay in the operator's environment or the local
# PostgreSQL container metadata; never copy them into this repository.
if [ -z "${JDQ_ALPHA_JWT_SECRET:-}" ]; then
  secret_file="${JDQ_ALPHA_JWT_SECRET_FILE:-$HOME/.config/juanderquest-alpha/jwt-secret}"
  if [ -f "$secret_file" ]; then
    JDQ_ALPHA_JWT_SECRET=$(sed -n '1p' "$secret_file")
  fi
fi
if [ -z "${JDQ_ALPHA_JWT_SECRET:-}" ]; then
  echo 'JDQ_ALPHA_JWT_SECRET or a private JWT secret file is required.' >&2
  exit 1
fi

if [ "${#JDQ_ALPHA_JWT_SECRET}" -lt 64 ]; then
  echo 'JDQ_ALPHA_JWT_SECRET must contain at least 64 characters.' >&2
  exit 1
fi

db_password=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' jdq-alpha-postgres |
  sed -n 's/^POSTGRES_PASSWORD=//p')
if [ -z "$db_password" ]; then
  echo 'Cannot read the dedicated jdq-alpha-postgres credentials.' >&2
  exit 1
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$script_dir/.."

# GitHub Releases is the artifact source. Cache its small manifest outside Git
# so /app/version reports the actual APK release, not the backend commit.
manifest_dir="$HOME/.config/juanderquest-alpha"
mkdir -p "$manifest_dir"
manifest_file="$manifest_dir/version.json"
manifest_candidate=$(mktemp "$manifest_dir/version.json.XXXXXX")
if curl --fail --location --silent --show-error --connect-timeout 5 --max-time 15 \
  'https://github.com/zernanvash/juanderquest-mobile/releases/latest/download/version.json' \
  --output "$manifest_candidate" && \
  node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); if (!Number.isSafeInteger(m.versionCode) || m.versionCode < 1 || m.downloadUrl !== "https://github.com/zernanvash/juanderquest-mobile/releases/latest/download/juanderquest-latest.apk") process.exit(1)' "$manifest_candidate"; then
  mv "$manifest_candidate" "$manifest_file"
else
  rm -f "$manifest_candidate"
  echo 'Could not refresh GitHub APK manifest; using last cached version if available.' >&2
fi
if [ -s "$manifest_file" ]; then
  export APP_VERSION_FILE="$manifest_file"
fi

export NODE_ENV=production
export PORT=4000
export HOST=127.0.0.1
export DATABASE_URL="postgres://jdq_alpha:${db_password}@127.0.0.1:55433/juanderquest_alpha"
export JWT_SECRET="$JDQ_ALPHA_JWT_SECRET"
export CORS_ORIGIN='https://juanderquest.app,https://www.juanderquest.app,https://admin.juanderquest.app'
export ALLOW_IN_MEMORY_FALLBACK=false
export SEED_DEVELOPMENT_DATA=false
export ALLOW_DEMO_LOGIN=true
export GUEST_LOGIN_ENABLED=true
export MARKETPLACE_ENABLED=false
export WALLET_AUTH_MODE=signature
export ALLOW_INSECURE_LOCAL_WALLET_AUTH=false
export JUANCHOICE_ENABLED=true
export ALPHA_WALLET_SIMULATION_ENABLED=true
export JUANCHOICE_WRITES_ENABLED=false
export JUANCHOICE_BATCH_WRITES_ENABLED=false
export JUANCHOICE_PROMOTION_ENABLED=false
export JUANCHOICE_ECONOMY_ENABLED=false
export JUANCHOICE_FINALIZER_WORKER_ENABLED=false
export JUANCHOICE_SCHEDULER_ENABLED=false

exec node dist/server.js
