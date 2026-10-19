#!/bin/bash
set -euo pipefail

MAPS_DIR="$HOME/jdq-maps"
INPUT_PBF="$HOME/valhalla-ph/philippines-latest.osm.pbf"
BOUNDARIES_PBF="$MAPS_DIR/admin-boundaries.osm.pbf"
BOUNDARIES_GEOJSON="$MAPS_DIR/admin-boundaries.geojson"
AREAS_DIR="$MAPS_DIR/areas"

mkdir -p "$AREAS_DIR"

echo "=== 1. Extracting administrative boundaries from Philippines OSM ==="
if [ ! -f "$BOUNDARIES_PBF" ]; then
  docker run --rm \
    -v "$(dirname "$INPUT_PBF")":/input:ro \
    -v "$MAPS_DIR":/output \
    stefda/osmium-tool:latest \
    osmium tags-filter /input/philippines-latest.osm.pbf r/boundary=administrative -o /output/admin-boundaries.osm.pbf --overwrite
fi

echo "=== 2. Exporting boundaries to GeoJSON ==="
if [ ! -f "$BOUNDARIES_GEOJSON" ]; then
  docker run --rm \
    -v "$MAPS_DIR":/data \
    stefda/osmium-tool:latest \
    osmium export /data/admin-boundaries.osm.pbf -o /data/admin-boundaries.geojson --overwrite
fi

echo "=== 3. Running mapshaper to filter & simplify Pangasinan LGUs and Barangays ==="
# Pangasinan bounding box: ~ [119.7, 15.6, 120.9, 16.4]
npx mapshaper "$BOUNDARIES_GEOJSON" \
  -filter 'admin_level == "6" || admin_level == "7"' \
  -filter 'bbox[0] >= 119.5 && bbox[1] >= 15.5 && bbox[2] <= 121.1 && bbox[3] <= 16.5' \
  -simplify 5% keep-shapes \
  -o "$AREAS_DIR/towns.geojson" force

npx mapshaper "$BOUNDARIES_GEOJSON" \
  -filter 'admin_level == "10"' \
  -filter 'bbox[0] >= 119.5 && bbox[1] >= 15.5 && bbox[2] <= 121.1 && bbox[3] <= 16.5' \
  -simplify 5% keep-shapes \
  -o "$AREAS_DIR/barangays.geojson" force

echo "=== Done extracting boundaries ==="
