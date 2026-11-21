#!/usr/bin/env bash
# Plan 116 §4.4: monthly restore drill for the production database v2. Run in WSL.
#   restore-drill-prod.sh [dump]     (default: the newest ~/jdq-backups/prod/jdq-prod-*.dump)
# Restores the dump into the scratch database jdq_r_drill_prod on the REHEARSAL cluster (never on
# jdq-prod-postgres), then checks: checksum, migrations verified + grants (migrate.ts), row counts
# equal to the .counts taken at dump time (when present), area lookup, no NOT VALID constraints.
# The scratch database is dropped afterwards. Passwords are never printed.
# Log: ~/.local/state/juanderquest-prod/restore-drill.log (cron) or stdout.
set -euo pipefail
REH=~/.jdq-secrets/jdq-prod-rehearsal-pg.env
APP="${JDQ_BACKEND_DIR:-$HOME/jdq-deploy/backend}"
DUMP="${1:-$(ls -1t ~/jdq-backups/prod/jdq-prod-*.dump 2>/dev/null | head -n 1)}"
[ -n "$DUMP" ] && [ -f "$DUMP" ] || { echo "$(date -Is) FAILED: no production dump found"; exit 1; }
# shellcheck disable=SC1090
C=$(. "$REH"; printf %s "$PG_CONTAINER"); SU=$(. "$REH"; printf %s "$POSTGRES_SUPERUSER_PASSWORD")
OWNER_URL=$(. "$REH"; printf %s "$JDQ_OWNER_URL" | sed 's#/juanderquest_prod#/jdq_r_drill_prod#')
[ "$C" = jdq-prod-rehearsal-pg ] || { echo 'Refusing: not the rehearsal cluster.' >&2; exit 2; }
S=jdq_r_drill_prod
su() { docker exec -i -e PGPASSWORD="$SU" "$C" psql -h 127.0.0.1 -U postgres -X -v ON_ERROR_STOP=1 "$@"; }
log() { printf '%s [drill] %s\n' "$(date -Is)" "$*"; }
trap 'su -d postgres -q -c "DROP DATABASE IF EXISTS $S WITH (FORCE)" >/dev/null 2>&1 || true' EXIT

log "dump $(basename "$DUMP") ($(du -h "$DUMP" | cut -f1))"
(cd "$(dirname "$DUMP")" && sha256sum -c "$(basename "$DUMP").sha256" >/dev/null) || { log 'FAILED: checksum'; exit 1; }

su -d postgres -q -c "DROP DATABASE IF EXISTS $S WITH (FORCE)" -c "CREATE DATABASE $S OWNER jdq_owner" \
  -c "REVOKE ALL ON DATABASE $S FROM PUBLIC" -c "GRANT CONNECT, TEMPORARY ON DATABASE $S TO jdq_owner, jdq_app, jdq_readonly"
t0=$(date +%s)
docker exec -i -e PGPASSWORD="$SU" "$C" pg_restore -h 127.0.0.1 -U postgres -d "$S" --exit-on-error < "$DUMP"
su -d postgres -q -c "ALTER DATABASE $S SET search_path = \"\$user\", public, extensions"
log "restored in $(( $(date +%s) - t0 ))s"

(cd "$APP" && NODE_ENV=test JDQ_MIGRATE_URL="$OWNER_URL" node node_modules/tsx/dist/cli.mjs scripts/prod-db/migrate.ts 2>&1 \
  | grep -E '^\[migrate\]' | sed 's/^/  /') || { log 'FAILED: migrations/grants'; exit 1; }

COUNTS="SELECT table_name || ' ' || (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name), false, true, '')))[1]::text
          FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name"
got=$(su -d "$S" -tA -c "$COUNTS")
if [ -f "$DUMP.counts" ]; then
  if [ "$got" = "$(cat "$DUMP.counts")" ]; then
    log "row counts identical across $(printf '%s\n' "$got" | wc -l) tables ($(printf '%s\n' "$got" | awk '{s+=$2} END {print s}') rows)"
  else
    log 'FAILED: ROW COUNT MISMATCH'; diff <(cat "$DUMP.counts") <(printf '%s\n' "$got") | head -20; exit 1
  fi
else
  log "no .counts for this dump; $(printf '%s\n' "$got" | wc -l) tables restored"
fi
su -d "$S" -tA -c "SELECT '  users ' || (SELECT count(*) FROM users) || ', published spots ' || (SELECT count(*) FROM spots WHERE status = 'published') || ', area match (Vigan): ' || coalesce((SELECT id FROM admin_areas WHERE level = 'town' AND ST_Covers(geom, ST_SetSRID(ST_MakePoint(120.3869, 17.5747), 4326))), 'NONE') || ', not valid constraints: ' || (SELECT count(*) FROM pg_constraint WHERE NOT convalidated)"
log 'PASS'
