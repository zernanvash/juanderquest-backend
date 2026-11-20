#!/usr/bin/env bash
# Plan 116 §10 gate: backup → restore → compare, on the REHEARSAL cluster only. Run in WSL.
#   scripts/prod-db/restore-drill.sh            (dumps juanderquest_prod, restores into jdq_r_restore)
# The scratch database jdq_r_restore is dropped and recreated each run. Passwords are never printed.
set -euo pipefail
# shellcheck disable=SC1091
source ~/.jdq-secrets/jdq-prod-rehearsal-pg.env
[ "$PG_CONTAINER" = jdq-prod-rehearsal-pg ] && [ "$PG_DB" = juanderquest_prod ] \
  || { echo 'Refusing: not the rehearsal cluster.' >&2; exit 2; }
C=$PG_CONTAINER SRC=$PG_DB DST=jdq_r_restore
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DIR=~/jdq-backups/plan116; mkdir -p "$DIR"
DUMP="$DIR/rehearsal-$SRC-$STAMP.dump"
sup() { docker exec -i -e PGPASSWORD="$POSTGRES_SUPERUSER_PASSWORD" "$C" psql -h 127.0.0.1 -U postgres -X -v ON_ERROR_STOP=1 "$@"; }
log() { printf '[drill %s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
COUNTS="SELECT table_name || ' ' || (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name), false, true, '')))[1]::text
          FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name"

log "dump $SRC"
t0=$(date +%s)
docker exec -e PGPASSWORD="$POSTGRES_SUPERUSER_PASSWORD" "$C" pg_dump -h 127.0.0.1 -U postgres -Fc -Z 6 "$SRC" > "$DUMP"
sha256sum "$DUMP" > "$DUMP.sha256"
log "dump done in $(( $(date +%s) - t0 ))s, $(du -h "$DUMP" | cut -f1)"

log "recreate $DST"
sup -d postgres -q -c "DROP DATABASE IF EXISTS $DST WITH (FORCE)" -c "CREATE DATABASE $DST OWNER jdq_owner"
t0=$(date +%s)
docker exec -i -e PGPASSWORD="$POSTGRES_SUPERUSER_PASSWORD" "$C" pg_restore -h 127.0.0.1 -U postgres -d "$DST" --exit-on-error < "$DUMP"
# Database-level settings are not part of a -Fc dump without --create; copy them (search_path).
sup -d postgres -q -c "ALTER DATABASE $DST SET search_path = \"\$user\", public, extensions"
log "restore done in $(( $(date +%s) - t0 ))s"

sup -d "$SRC" -tA -c "$COUNTS" > /tmp/drill-src.txt
sup -d "$DST" -tA -c "$COUNTS" > /tmp/drill-dst.txt
if diff -q /tmp/drill-src.txt /tmp/drill-dst.txt >/dev/null; then
  log "row counts identical across $(wc -l < /tmp/drill-src.txt) tables ($(awk '{s+=$2} END {print s}' /tmp/drill-src.txt) rows)"
else
  log 'ROW COUNT MISMATCH'; diff /tmp/drill-src.txt /tmp/drill-dst.txt | head -20; exit 1
fi
sup -d "$DST" -tA -c "SELECT 'extensions: ' || string_agg(extname || ' ' || extversion, ', ' ORDER BY extname) FROM pg_extension WHERE extname <> 'plpgsql'"
sup -d "$DST" -tA -c "SELECT 'not valid constraints: ' || count(*) FROM pg_constraint WHERE NOT convalidated"
sup -d "$DST" -tA -c "SELECT 'area match (Vigan): ' || coalesce((SELECT id FROM admin_areas WHERE level = 'town' AND ST_Covers(geom, ST_SetSRID(ST_MakePoint(120.3869, 17.5747), 4326))), 'NONE')"
echo "$DUMP"
