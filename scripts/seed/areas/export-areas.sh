#!/usr/bin/env bash
# Plan 116 §7: export the imported admin_areas rows from a WORK database to a gzip'd COPY file
# that load-areas.sql loads into another database (same schema, migrations 056/057/110).
#   scripts/seed/areas/export-areas.sh <secrets-env-file> [out.copy.gz]
set -euo pipefail
env_file="${1:?secrets env file}"
out="${2:-$HOME/jdq-seed/national-116/areas/admin_areas.national.copy.gz}"
# shellcheck disable=SC1090
source "$env_file"
: "${WORKDB_OWNER_URL:?WORKDB_OWNER_URL missing}"
cols='id, psgc_code, level, name, display_name, parent_id, osm_relation_id, has_boundary, label_lat, label_lng, bbox, min_zoom, shape_file, data_version, updated_at, boundary, geom'
docker run --rm -i --network host -e PGURL="$WORKDB_OWNER_URL" postgis/postgis:17-3.5-alpine \
  sh -c "psql \"\$PGURL\" -X -v ON_ERROR_STOP=1 -c \"\\copy (SELECT $cols FROM admin_areas ORDER BY array_position(ARRAY['region','province','town','barangay'], level), id) TO STDOUT\"" |
  gzip -9 >"$out.tmp"
mv "$out.tmp" "$out"
rows=$(gzip -dc "$out" | wc -l)
echo "wrote $out ($rows rows, $(du -h "$out" | cut -f1))"
sha256sum "$out" >"$out.sha256"
