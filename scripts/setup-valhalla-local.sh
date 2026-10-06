#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="$BACKEND_DIR/.local/valhalla"
SOURCE_PBF="$DATA_DIR/philippines-latest.osm.pbf"
PBF="$DATA_DIR/pangasinan.osm.pbf"
IMAGE="ghcr.io/gis-ops/docker-valhalla/valhalla:latest"
CONTAINER="juanderquest_valhalla_local"

mkdir -p "$DATA_DIR"

if [[ ! -s "$SOURCE_PBF" && ! -s "$PBF" ]]; then
  echo "Downloading the Philippines OpenStreetMap extract..."
  wget -c -O "$SOURCE_PBF" https://download.geofabrik.de/asia/philippines-latest.osm.pbf
fi

if [[ ! -s "$PBF" ]]; then
  echo "Extracting the Pangasinan routing region..."
  docker run --rm \
    -v "$DATA_DIR:/data" \
    debian:bookworm-slim \
    bash -lc "apt-get update >/dev/null && apt-get install -y --no-install-recommends osmium-tool >/dev/null && osmium extract --bbox 119.6,15.5,121.1,16.6 /data/philippines-latest.osm.pbf --output /data/pangasinan.osm.pbf --overwrite"

  rm -f "$SOURCE_PBF"
fi

if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
  docker start "$CONTAINER" >/dev/null
else
  docker run -d \
    --name "$CONTAINER" \
    --restart unless-stopped \
    -p 127.0.0.1:8002:8002 \
    -v "$DATA_DIR:/custom_files" \
    -e build_elevation=False \
    -e build_admins=True \
    -e build_time_zones=False \
    "$IMAGE" >/dev/null
fi

echo "Valhalla is starting at http://127.0.0.1:8002. Initial graph generation can take several minutes."

for attempt in $(seq 1 60); do
  if curl --fail --silent http://127.0.0.1:8002/status >/dev/null 2>&1; then
    echo "Valhalla is ready."
    exit 0
  fi
  sleep 3
done

echo "Valhalla did not become ready within 180 seconds. Inspect it with:" >&2
echo "  docker logs --tail 200 $CONTAINER" >&2
exit 1
