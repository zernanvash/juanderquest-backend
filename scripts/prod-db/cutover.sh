#!/usr/bin/env bash
# Plan 116 §11: build the production database v2 from the VETTED rehearsal database, then top it up
# with what changed on the live (alpha) database since the rehearsal carry. Run in WSL.
#
#   cutover.sh --target sim  <phase>...   # scratch DB jdq_r_cutover on the rehearsal cluster
#   cutover.sh --target prod <phase>...   # jdq-prod-postgres / juanderquest_prod (needs JDQ_OWNER_APPROVED_CUTOVER=yes)
#
# Phases, in order:
#   snapshot  pg_dump of the live jdq-alpha-postgres (read-only) -> restored as jdq_old_final on the
#             rehearsal cluster (the carry source). Run it again after the write freeze.
#   load      recreate the (empty) target DB and restore the vetted rehearsal dump into it
#   delta     carry rows created/changed on live since the rehearsal snapshot (--delta-since)
#   accounts  owner D2: remove fixture accounts, zero everyone, invalidate old sessions
#   finalize  area parents, featured-photo rule, image_url fill, duplicate review
#   verify    migrations verified + grants (migrate.ts), schema owner, row counts, area match
#   drill     dump the target and restore it into a scratch DB on the same cluster; counts must match
# Never touches jdq-alpha-postgres except pg_dump. Passwords are never printed.
set -euo pipefail
export MSYS_NO_PATHCONV=1
TARGET=''
if [ "${1:-}" = --target ]; then TARGET="$2"; shift 2; fi
PHASES="$*"
[ -n "$PHASES" ] || { echo 'usage: cutover.sh --target sim|prod <phase>...' >&2; exit 2; }
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
SECRETS=~/.jdq-secrets
REH_ENV="$SECRETS/jdq-prod-rehearsal-pg.env"
OLD_DB=jdq_old_final
# The rehearsal carry read a live dump taken at this time (jdq-alpha-plan116-phase0-20261119T164302Z).
DELTA_SINCE="${DELTA_SINCE:-2026-11-19T16:43:02Z}"
BK=~/jdq-backups/plan116; mkdir -p "$BK"
log() { printf '[cutover %s %s] %s\n' "$TARGET" "$(date -u +%H:%M:%SZ)" "$*"; }
pw() { printf %s "$1" | sed -E 's#.*://[^:]+:([^@]+)@.*#\1#'; }

# --- the rehearsal cluster (carry source + sim target) ---
# shellcheck disable=SC1090
REH_SU=$(. "$REH_ENV"; printf %s "$POSTGRES_SUPERUSER_PASSWORD")
REH_OWNER_URL=$(. "$REH_ENV"; printf %s "$JDQ_OWNER_URL")
REH_RO_URL=$(. "$REH_ENV"; printf %s "$JDQ_READONLY_URL")
reh_su() { docker exec -i -e PGPASSWORD="$REH_SU" jdq-prod-rehearsal-pg psql -h 127.0.0.1 -U postgres -X -v ON_ERROR_STOP=1 "$@"; }
OLD_RO_URL=$(printf %s "$REH_RO_URL" | sed "s#/juanderquest_prod#/$OLD_DB#")

# --- the target ---
case "$TARGET" in
  sim)
    C=jdq-prod-rehearsal-pg; DB=jdq_r_cutover; SU="$REH_SU"
    OWNER_URL=$(printf %s "$REH_OWNER_URL" | sed "s#/juanderquest_prod#/$DB#")
    ;;
  prod)
    [ "${JDQ_OWNER_APPROVED_CUTOVER:-}" = yes ] || { echo 'Refusing: prod needs JDQ_OWNER_APPROVED_CUTOVER=yes (owner OK).' >&2; exit 1; }
    PROD_ENV="$SECRETS/jdq-prod-postgres.env"
    [ -f "$PROD_ENV" ] || { echo 'Refusing: no jdq-prod-postgres secrets (run bootstrap.sh --profile prod first).' >&2; exit 1; }
    C=$(. "$PROD_ENV"; printf %s "$PG_CONTAINER"); DB=$(. "$PROD_ENV"; printf %s "$PG_DB")
    [ "$C" = jdq-prod-postgres ] && [ "$DB" = juanderquest_prod ] || { echo 'Refusing: unexpected prod secrets.' >&2; exit 1; }
    SU=$(. "$PROD_ENV"; printf %s "$POSTGRES_SUPERUSER_PASSWORD")
    OWNER_URL=$(. "$PROD_ENV"; printf %s "$JDQ_OWNER_URL")
    ;;
  *) echo 'usage: cutover.sh --target sim|prod <phase>...' >&2; exit 2 ;;
esac
case "$OWNER_URL" in *@127.0.0.1:55433/*|*/juanderquest_alpha*) echo 'Refusing: target is the live alpha DB.' >&2; exit 2 ;; esac
su() { docker exec -i -e PGPASSWORD="$SU" "$C" psql -h 127.0.0.1 -U postgres -X -v ON_ERROR_STOP=1 "$@"; }
owner_sql() { docker exec -i -e PGPASSWORD="$(pw "$OWNER_URL")" "$C" psql -h 127.0.0.1 -U jdq_owner -d "$DB" -X -v ON_ERROR_STOP=1 "$@"; }
COUNTS="SELECT table_name || ' ' || (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name), false, true, '')))[1]::text
          FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name"

for phase in $PHASES; do
  case "$phase" in
    snapshot)
      free_gb=$(df -BG --output=avail /mnt/g | tail -1 | tr -dc '0-9')
      [ "${free_gb:-0}" -ge 15 ] || { echo "Refusing: G: has ${free_gb} GB free (< 15 GB)." >&2; exit 1; }
      f="$BK/alpha-final-$(date -u +%Y%m%dT%H%M%SZ).dump"
      log "snapshot: pg_dump live jdq-alpha-postgres -> $(basename "$f")"
      docker exec jdq-alpha-postgres sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h 127.0.0.1 -U "$POSTGRES_USER" -Fc -Z 6 "$POSTGRES_DB"' > "$f"
      sha256sum "$f" > "$f.sha256"
      log "snapshot: $(du -h "$f" | cut -f1); restoring as $OLD_DB on the rehearsal cluster"
      reh_su -d postgres -q -c "DROP DATABASE IF EXISTS $OLD_DB WITH (FORCE)" -c "CREATE DATABASE $OLD_DB OWNER jdq_owner" \
        -c "REVOKE ALL ON DATABASE $OLD_DB FROM PUBLIC" -c "GRANT CONNECT ON DATABASE $OLD_DB TO jdq_owner, jdq_readonly"
      reh_su -d "$OLD_DB" -q -c "ALTER SCHEMA public OWNER TO jdq_owner"
      docker exec -i -e PGPASSWORD="$(pw "$REH_OWNER_URL")" jdq-prod-rehearsal-pg \
        pg_restore -h 127.0.0.1 -U jdq_owner -d "$OLD_DB" --no-owner --no-privileges --exit-on-error < "$f"
      reh_su -d "$OLD_DB" -q -c "GRANT USAGE ON SCHEMA public TO jdq_readonly" -c "GRANT SELECT ON ALL TABLES IN SCHEMA public TO jdq_readonly"
      reh_su -d "$OLD_DB" -tA -c "SELECT 'live snapshot: ' || (SELECT count(*) FROM users) || ' users, ' || (SELECT count(*) FROM spots) || ' spots, newest user ' || coalesce((SELECT max(created_at)::text FROM users), '-')"
      echo "$f" > "$BK/alpha-final.latest"
      ;;
    load)
      dump="${REHEARSAL_DUMP:-$(ls -t "$BK"/rehearsal-juanderquest_prod-*.dump | head -1)}"
      (cd "$(dirname "$dump")" && sha256sum -c "$(basename "$dump").sha256" >/dev/null) || { echo "Refusing: checksum of $dump" >&2; exit 1; }
      n=$(su -d postgres -tAc "SELECT count(*) FROM pg_database WHERE datname = '$DB'")
      if [ "$n" = 1 ]; then
        t=$(su -d "$DB" -tAc "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'")
        [ "$t" = 0 ] || [ "${LOAD_REPLACE:-}" = yes ] || { echo "Refusing: $DB already has $t tables (set LOAD_REPLACE=yes to rebuild)." >&2; exit 1; }
      fi
      log "load: recreate empty $DB, restore $(basename "$dump")"
      su -d postgres -q -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB OWNER jdq_owner" \
        -c "REVOKE ALL ON DATABASE $DB FROM PUBLIC" -c "GRANT CONNECT, TEMPORARY ON DATABASE $DB TO jdq_owner, jdq_app, jdq_readonly"
      docker exec -i -e PGPASSWORD="$SU" "$C" pg_restore -h 127.0.0.1 -U postgres -d "$DB" --exit-on-error < "$dump"
      su -d postgres -q -c "ALTER DATABASE $DB SET search_path = \"\$user\", public, extensions"
      su -d "$DB" -tA -c "SELECT 'loaded: ' || (SELECT count(*) FROM spots WHERE status='published') || ' published spots, ' || (SELECT count(*) FROM users) || ' users, schema owner ' || (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='public')"
      ;;
    delta)
      log "delta: carry changes on live since $DELTA_SINCE"
      out="$HOME/jdq-seed/national-116/cutover/$TARGET-delta-$(date -u +%H%M%S)"; mkdir -p "$out"
      CARRY_SOURCE_URL="$OLD_RO_URL" CARRY_TARGET_URL="$OWNER_URL" node node_modules/tsx/dist/cli.mjs \
        scripts/prod-cutover/carry.ts --apply --delta-since "$DELTA_SINCE" --out "$out" > "$out/carry.log" 2>&1 \
        || { tail -20 "$out/carry.log"; exit 1; }
      grep -E "inserted=[1-9]|updated=[1-9]|fkDropped=[1-9]|outside" "$out/carry.log" | sed 's/^/  /' || true
      tail -2 "$out/carry.log"
      ;;
    accounts)
      log 'accounts: remove fixtures, zero everyone, invalidate sessions'
      docker cp scripts/prod-db/launch-accounts.sql "$C":/tmp/launch-accounts.sql
      owner_sql -A -f /tmp/launch-accounts.sql | grep -vE '^(BEGIN|COMMIT|\(1 row\))$'
      ;;
    finalize)
      log 'finalize'
      docker cp scripts/prod-db/finalize-region.sql "$C":/tmp/finalize-region.sql
      owner_sql -A -f /tmp/finalize-region.sql | grep -vE '^(BEGIN|COMMIT)$' | tail -12
      ;;
    verify)
      log 'verify: migrations + grants'
      NODE_ENV=test JDQ_MIGRATE_URL="$OWNER_URL" node node_modules/tsx/dist/cli.mjs scripts/prod-db/migrate.ts 2>&1 \
        | grep -vE '^\{"level":"(debug|info)"' | tail -4
      su -d "$DB" -tA -c "SELECT 'published spots ' || (SELECT count(*) FROM spots WHERE status='published' AND NOT coalesce(is_test,false)) || ', featured ' || (SELECT count(*) FROM spots WHERE status='published' AND launch_tier='featured') || ', users ' || (SELECT count(*) FROM users) || ', users nonzero ' || (SELECT count(*) FROM users WHERE demo_points<>0 OR scout_reputation<>0) || ', trails ' || (SELECT count(*) FROM trails WHERE status='published') || ', juanchoice schedules ' || (SELECT count(*) FROM juanchoice_schedules WHERE enabled) || ', catalog photos ' || (SELECT count(*) FROM spot_assets WHERE status='approved' AND source IS NOT NULL)"
      su -d "$DB" -tA -c "SELECT 'area match (Vigan): ' || coalesce((SELECT id FROM admin_areas WHERE level = 'town' AND ST_Covers(geom, ST_SetSRID(ST_MakePoint(120.3869, 17.5747), 4326))), 'NONE')"
      su -d "$DB" -tA -c "SELECT 'not valid constraints: ' || count(*) FROM pg_constraint WHERE NOT convalidated"
      ;;
    drill)
      f="$BK/$TARGET-$DB-$(date -u +%Y%m%dT%H%M%SZ).dump"
      log "drill: dump $DB -> $(basename "$f")"
      docker exec -e PGPASSWORD="$SU" "$C" pg_dump -h 127.0.0.1 -U postgres -Fc -Z 6 "$DB" > "$f"
      sha256sum "$f" > "$f.sha256"
      S=jdq_restore_drill
      su -d postgres -q -c "DROP DATABASE IF EXISTS $S WITH (FORCE)" -c "CREATE DATABASE $S OWNER jdq_owner"
      docker exec -i -e PGPASSWORD="$SU" "$C" pg_restore -h 127.0.0.1 -U postgres -d "$S" --exit-on-error < "$f"
      su -d "$DB" -tA -c "$COUNTS" > /tmp/cut-src.txt
      su -d "$S" -tA -c "$COUNTS" > /tmp/cut-dst.txt
      if diff -q /tmp/cut-src.txt /tmp/cut-dst.txt >/dev/null; then
        log "drill: row counts identical across $(wc -l < /tmp/cut-src.txt) tables ($(awk '{s+=$2} END {print s}' /tmp/cut-src.txt) rows)"
      else
        log 'drill: ROW COUNT MISMATCH'; diff /tmp/cut-src.txt /tmp/cut-dst.txt | head; exit 1
      fi
      su -d postgres -q -c "DROP DATABASE $S WITH (FORCE)"
      echo "  backup kept: $f"
      ;;
    *) echo "unknown phase: $phase" >&2; exit 2 ;;
  esac
done
log done
