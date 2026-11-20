#!/usr/bin/env bash
# Plan 116 §7: load the PSA/NAMRIA COD-AB geodatabase (HDX cod-ab-phl) into the
# staging schema `areas_src` of a WORK database. Never run against production.
#   usage: scripts/seed/areas/load-codab.sh <secrets-env-file> [gdb-dir]
# The env file must define WORKDB_OWNER_URL. The URL reaches the container through the
# environment only; any echo of it in GDAL errors is masked.
set -euo pipefail
env_file="${1:?secrets env file}"
gdb_dir="${2:-$HOME/jdq-seed/national-116/areas/codab}"
# shellcheck disable=SC1090
source "$env_file"
: "${WORKDB_OWNER_URL:?WORKDB_OWNER_URL missing}"
# Split the URL into libpq variables (GDAL's PG: string does not accept a URI).
pgenv=$(mktemp)
trap 'rm -f "$pgenv"' EXIT
chmod 600 "$pgenv"
WORKDB_OWNER_URL="$WORKDB_OWNER_URL" python3 -I -c '
import os, urllib.parse as u
p = u.urlparse(os.environ["WORKDB_OWNER_URL"])
print("PGHOST=" + (p.hostname or ""))
print("PGPORT=" + str(p.port or 5432))
print("PGUSER=" + u.unquote(p.username or ""))
print("PGPASSWORD=" + u.unquote(p.password or ""))
print("PGDATABASE=" + p.path.lstrip("/"))
' >"$pgenv"
free_g=$(df -BG --output=avail /mnt/g | tail -1 | tr -dc 0-9)
if [ "${free_g:-0}" -lt 15 ]; then
  echo "G: has < 15 GB free; stopping" >&2
  exit 3
fi
GDAL_IMAGE="${GDAL_IMAGE:-ghcr.io/osgeo/gdal:alpine-normal-3.10.3}"
for n in 1 2 3 4; do
  echo "loading phl_admin$n"
  docker run --rm --network host --env-file "$pgenv" -e N="$n" -v "$gdb_dir":/d:ro "$GDAL_IMAGE" \
    sh -c 'ogr2ogr -f PostgreSQL "PG:dbname=$PGDATABASE" /d/phl_admin_boundaries.gdb "phl_admin$N" \
      -nln "areas_src.codab_adm$N" -overwrite -lco GEOMETRY_NAME=geom -lco FID=objectid \
      -lco SPATIAL_INDEX=NONE -nlt PROMOTE_TO_MULTI -t_srs EPSG:4326 --config PG_USE_COPY YES' 2>&1 |
    sed -E 's#(postgres(ql)?://[^:/]+:)[^@]+@#\1***@#g'
done
echo done
