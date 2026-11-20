#!/usr/bin/env bash
# Plan 116: serve the region rehearsal on preview slot I (API 127.0.0.1:4130) from a *_dev copy
# restored from the latest rehearsal dump, so juanderquest_prod itself is never touched by a dev server.
#   scripts/prod-db/preview-region.sh            (restore copy + start API in the background)
# Logs: ~/jdq-seed/national-116/rehearsal/preview-api.log ; stop with: kill $(cat ~/jdq-seed/national-116/rehearsal/preview-api.pid)
set -euo pipefail
# shellcheck disable=SC1091
source ~/.jdq-secrets/jdq-prod-rehearsal-pg.env
[ "$PG_CONTAINER" = jdq-prod-rehearsal-pg ] || { echo 'Refusing: not the rehearsal cluster.' >&2; exit 2; }
C=$PG_CONTAINER DB=jdq_preview_r1_dev
DUMP=$(ls -1t ~/jdq-backups/plan116/rehearsal-juanderquest_prod-*.dump | head -1)
REH=~/jdq-seed/national-116/rehearsal
sup() { docker exec -i -e PGPASSWORD="$POSTGRES_SUPERUSER_PASSWORD" "$C" psql -h 127.0.0.1 -U postgres -X -v ON_ERROR_STOP=1 "$@"; }

# Stop an earlier preview only if that pid really is this preview server (pids get reused).
if [ -f "$REH/preview-api.pid" ]; then
  old=$(cat "$REH/preview-api.pid")
  if tr '\0' ' ' < "/proc/$old/cmdline" 2>/dev/null | grep -q 'src/server.ts' \
     && [ "$(readlink "/proc/$old/cwd" 2>/dev/null)" = "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)" ]; then
    kill "$old"; sleep 2
  fi
fi
# Never pkill by pattern: other agents run their own preview servers in this WSL.
sup -d postgres -q -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB OWNER jdq_owner"
docker exec -i -e PGPASSWORD="$POSTGRES_SUPERUSER_PASSWORD" "$C" pg_restore -h 127.0.0.1 -U postgres -d "$DB" --exit-on-error < "$DUMP"
sup -d postgres -q -c "ALTER DATABASE $DB SET search_path = \"\$user\", public, extensions"
echo "restored $(basename "$DUMP") into $DB"

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
[ -f .env.dev ] || cp .env.dev.example .env.dev
APP_URL=$(printf %s "$JDQ_APP_URL" | sed "s#/juanderquest_prod#/$DB#")
JDQ_ENV=dev PORT=4130 HOST=127.0.0.1 DATABASE_URL="$APP_URL" CORS_ORIGIN=http://127.0.0.1:3130 \
  DB_MIGRATION_MODE=verify SEED_DEVELOPMENT_DATA=false ALLOW_IN_MEMORY_FALLBACK=false ALLOW_DEMO_LOGIN=false \
  LOCAL_UPLOAD_DIR="$HOME/jdq-seed/national-116/photos/media" \
  PREVIEW_FOREGROUND="${PREVIEW_FOREGROUND:-}" \
  bash -c 'if [ -n "$PREVIEW_FOREGROUND" ]; then exec node node_modules/tsx/dist/cli.mjs src/server.ts; else exec nohup node node_modules/tsx/dist/cli.mjs src/server.ts; fi' \
  > "$REH/preview-api.log" 2>&1 &
# WSL ends background processes when the launching wsl.exe session exits: for a preview that must
# outlive this script, run it with PREVIEW_FOREGROUND=1 from a long-lived session (the script then
# waits on the server after the health check).
echo $! > "$REH/preview-api.pid"
# Local tsx binary, not npx (npx can stall on a registry lookup); boot from /mnt/c can take minutes.
for _ in $(seq 1 150); do
  if curl -fsS 'http://127.0.0.1:4130/api/v1/spots?limit=1' >/dev/null 2>&1; then
    echo 'API up on 127.0.0.1:4130'
    if [ -n "${PREVIEW_FOREGROUND:-}" ]; then wait "$(cat "$REH/preview-api.pid")"; fi
    exit 0
  fi
  sleep 2
done
echo 'API did not come up; tail of log:'; tail -20 "$REH/preview-api.log"; exit 1
