#!/bin/bash
set -euo pipefail

MAPS_DIR="$HOME/jdq-maps"
INPUT_PBF="$HOME/valhalla-ph/philippines-latest.osm.pbf"
OUTPUT_PMTILES="$MAPS_DIR/philippines.pmtiles"
DATA_DIR="$MAPS_DIR/data"

mkdir -p "$DATA_DIR/sources" "$DATA_DIR/tmp"

echo "=== Building Vector Tiles (PMTiles) via Planetiler ==="
echo "Input PBF: $INPUT_PBF"
echo "Output: $OUTPUT_PMTILES"
echo "Start time: $(date '+%Y-%m-%d %H:%M:%S')"
START_SECS=$(date +%s)

docker run --rm \
  -e JAVA_TOOL_OPTIONS="-Xmx8g" \
  -v "$INPUT_PBF":/input/philippines.osm.pbf:ro \
  -v "$DATA_DIR":/data \
  ghcr.io/onthegomap/planetiler:latest \
  --osm-path=/input/philippines.osm.pbf \
  --download \
  --fetch-wikidata=false \
  --use-wikidata=false \
  --maxzoom=15 \
  --nodemap-type=sparsearray \
  --output=/data/philippines.pmtiles \
  --force

cp "$DATA_DIR/philippines.pmtiles" "$OUTPUT_PMTILES"
rm -rf "$DATA_DIR/tmp"

END_SECS=$(date +%s)
DURATION=$((END_SECS - START_SECS))
SIZE=$(du -h "$OUTPUT_PMTILES" | cut -f1)

echo "=== Vector Tile Build Complete ==="
echo "End time: $(date '+%Y-%m-%d %H:%M:%S')"
echo "Build duration: ${DURATION}s ($((DURATION / 60))m $((DURATION % 60))s)"
echo "PMTiles file size: $SIZE"
