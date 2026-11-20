#!/usr/bin/env bash
# Plan 116 §10: load one region into the REHEARSAL production database (juanderquest_prod on
# jdq-prod-rehearsal-pg :55461), in cutover order. Run in WSL from the backend repo:
#   scripts/prod-db/rehearse-region.sh 0100000000 [steps...]   (steps: areas carry dest photos finalize; default all)
# Refuses any target other than the rehearsal cluster. URLs and passwords are never printed.
set -euo pipefail
export MSYS_NO_PATHCONV=1
REGION="${1:?region PSGC, e.g. 0100000000}"; shift
STEPS="${*:-areas carry dest photos finalize}"
SECRETS=~/.jdq-secrets
# shellcheck disable=SC1091
source "$SECRETS/jdq-prod-rehearsal-pg.env"
# shellcheck disable=SC1091
source "$SECRETS/old-copy.env"
[ "$PG_CONTAINER" = jdq-prod-rehearsal-pg ] && [ "$PG_PORT" = 55461 ] && [ "$PG_DB" = juanderquest_prod ] \
  || { echo 'Refusing: secrets are not for the rehearsal cluster.' >&2; exit 2; }
case "$JDQ_OWNER_URL" in *@127.0.0.1:55461/juanderquest_prod*) ;; *) echo 'Refusing: unexpected owner URL.' >&2; exit 2 ;; esac
SEED=~/jdq-seed/national-116
OUT="$SEED/rehearsal/region-$REGION"
mkdir -p "$OUT"
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
log() { printf '[rehearse %s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
owner_pw() { printf %s "$JDQ_OWNER_URL" | sed -E 's#.*://[^:]+:([^@]+)@.*#\1#'; }
psql_owner() { docker exec -i -e PGPASSWORD="$(owner_pw)" "$PG_CONTAINER" psql -h 127.0.0.1 -U jdq_owner -d "$PG_DB" -X -v ON_ERROR_STOP=1 "$@"; }

for step in $STEPS; do
  case "$step" in
    areas)
      f="$SEED/areas/admin_areas.region$(printf %s "$REGION" | cut -c1-2).copy.gz"
      log "areas: loading $(basename "$f")"
      (cd "$SEED/areas" && sha256sum -c "$(basename "$f").sha256" >/dev/null)
      docker cp scripts/seed/areas/load-areas.sql "$PG_CONTAINER":/tmp/load-areas.sql
      gzip -dc "$f" | psql_owner -f /tmp/load-areas.sql > "$OUT/areas.log" 2>&1
      tail -5 "$OUT/areas.log"
      ;;
    carry)
      log 'carry: dry-run'
      CARRY_SOURCE_URL="$OLD_COPY_READONLY_URL" CARRY_TARGET_URL="$JDQ_OWNER_URL" \
        npx tsx scripts/prod-cutover/carry.ts --dry-run --out "$OUT/carry-dry" > "$OUT/carry-dry.log" 2>&1
      tail -3 "$OUT/carry-dry.log"
      log 'carry: apply'
      CARRY_SOURCE_URL="$OLD_COPY_READONLY_URL" CARRY_TARGET_URL="$JDQ_OWNER_URL" \
        npx tsx scripts/prod-cutover/carry.ts --apply --out "$OUT/carry" > "$OUT/carry.log" 2>&1
      tail -5 "$OUT/carry.log"
      ;;
    dest)
      log 'destinations: dry-run'
      DATABASE_URL="$JDQ_OWNER_URL" npx tsx scripts/seed/destinations/import-destinations.ts \
        --wave "r$REGION-launch" --region "$REGION" --areas-complete --dry-run > "$OUT/dest-dry.log" 2>&1
      tail -4 "$OUT/dest-dry.log"
      log 'destinations: apply'
      DATABASE_URL="$JDQ_OWNER_URL" npx tsx scripts/seed/destinations/import-destinations.ts \
        --wave "r$REGION-launch" --region "$REGION" --areas-complete --apply > "$OUT/dest.log" 2>&1
      tail -6 "$OUT/dest.log"
      ;;
    photos)
      log 'photos: discover'
      DATABASE_URL="$JDQ_OWNER_URL" npx tsx scripts/seed/photos/discover.ts --region "$REGION" > "$OUT/photos-discover.log" 2>&1
      tail -4 "$OUT/photos-discover.log"
      log 'photos: process (local storage)'
      DATABASE_URL="$JDQ_OWNER_URL" npx tsx scripts/seed/photos/process.ts --region "$REGION" --limit 100000 \
        --storage local --processor pillow --apply > "$OUT/photos-process.log" 2>&1
      tail -6 "$OUT/photos-process.log"
      ;;
    finalize)
      log 'finalize: area parents + featured photo rule'
      docker cp scripts/prod-db/finalize-region.sql "$PG_CONTAINER":/tmp/finalize-region.sql
      psql_owner -A -f /tmp/finalize-region.sql 2>&1 | tee "$OUT/finalize.log"
      ;;
    *) echo "unknown step: $step" >&2; exit 2 ;;
  esac
done
log 'done'
