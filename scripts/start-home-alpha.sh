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

# Temporary server deployment: Prefer locally built APK manifest when present
if [ -f "$script_dir/../downloads/version.json" ]; then
  export APP_VERSION_FILE="$script_dir/../downloads/version.json"
else
  # Fallback to GitHub Releases artifact source
  manifest_dir="$HOME/.config/juanderquest-alpha"
  mkdir -p "$manifest_dir"
  manifest_file="$manifest_dir/version.json"
  manifest_candidate=$(mktemp "$manifest_dir/version.json.XXXXXX")
  if curl --fail --location --silent --show-error --connect-timeout 5 --max-time 15 \
    'https://github.com/zernanvash/juanderquest-mobile/releases/latest/download/version.json' \
    --output "$manifest_candidate" && \
    node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const validUrl = typeof m.downloadUrl === "string" && (m.downloadUrl === "https://github.com/zernanvash/juanderquest-mobile/releases/latest/download/juanderquest-latest.apk" || /^https:\/\/github\.com\/zernanvash\/juanderquest-mobile\/releases\/download\/android-v[0-9.]+\+[0-9.]+\/juanderquest-latest\.apk$/.test(m.downloadUrl)); if (!Number.isSafeInteger(m.versionCode) || m.versionCode < 1 || !validUrl) process.exit(1)' "$manifest_candidate"; then
    mv "$manifest_candidate" "$manifest_file"
  else
    rm -f "$manifest_candidate"
    echo 'Could not refresh GitHub APK manifest; using last cached version if available.' >&2
  fi
  if [ -s "$manifest_file" ]; then
    export APP_VERSION_FILE="$manifest_file"
  fi
fi

export NODE_ENV=production
export PORT=4000
export HOST=127.0.0.1
export DATABASE_URL="postgres://jdq_alpha:${db_password}@127.0.0.1:55433/juanderquest_alpha"
export JWT_SECRET="$JDQ_ALPHA_JWT_SECRET"
export CORS_ORIGIN='https://juanderquest.app,https://www.juanderquest.app,https://admin.juanderquest.app'
export ALLOW_IN_MEMORY_FALLBACK=false
export SEED_DEVELOPMENT_DATA=false
# Off by default (2026-10-17 incident). Enable only for a presentation via the
# runtime overrides file below; production never issues admin demo sessions.
export ALLOW_DEMO_LOGIN=false
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

# Optional non-secret runtime overrides (release runbook Part B.3), e.g. after the
# Valhalla Philippines rebuild. The file is parsed, never executed, and only the
# allow-listed keys below are applied. Secrets never belong in this file.
overrides="${JDQ_ALPHA_RUNTIME_ENV:-$HOME/.config/juanderquest-alpha/runtime.env}"
if [ -f "$overrides" ]; then
  while IFS='=' read -r key value || [ -n "$key" ]; do
    key=$(printf '%s' "$key" | tr -d '\r[:space:]')
    value=$(printf '%s' "$value" | tr -d '\r')
    case "$key" in
      ''|'#'*) continue ;;
      ALLOW_DEMO_LOGIN|VALHALLA_URL|VALHALLA_COVERAGE_BBOX|VALHALLA_COVERAGE_LABEL|QUEST_FUNDING_ENABLED)
        export "$key=$value"
        echo "[start] runtime override applied: $key" >&2 ;;
      *)
        echo "[start] ignoring non-allow-listed runtime override: $key" >&2 ;;
    esac
  done < "$overrides"
fi

exec node dist/server.js
