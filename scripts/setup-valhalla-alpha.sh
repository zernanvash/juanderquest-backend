#!/usr/bin/env bash
# ==============================================================================
# JuanDerQuest — Option B Valhalla Routing Engine Alpha Setup (Azure VM)
# 
# Slices Pangasinan + Region 1 bounding box from OpenStreetMap and spins up
# a high-performance, lightweight Valhalla routing microservice in Docker.
# ==============================================================================

set -euo pipefail

VALHALLA_DIR="/home/azureuser/valhalla/custom_files"
PANGASINAN_BBOX="119.6,15.5,121.1,16.6" # min_lon, min_lat, max_lon, max_lat

echo "=========================================================="
echo "🚀 JuanDerQuest Valhalla Routing Engine Alpha Setup"
echo "=========================================================="

# 1. Ensure Docker is active
if ! command -v docker &> /dev/null; then
  echo "📦 Installing Docker..."
  sudo apt-get update
  sudo apt-get install -y docker.io docker-compose
  sudo usermod -aG docker "$USER"
fi

# 2. Prepare Directory
echo "📁 Preparing working directory: $VALHALLA_DIR"
mkdir -p "$VALHALLA_DIR"
cd "$VALHALLA_DIR"

# 3. Download Philippines OSM Extract if not present
if [ ! -f "pangasinan.osm.pbf" ]; then
  if [ ! -f "philippines-latest.osm.pbf" ]; then
    echo "⬇️ Downloading Philippines OpenStreetMap dataset from Geofabrik (~280MB)..."
    wget -c -O philippines-latest.osm.pbf https://download.geofabrik.de/asia/philippines-latest.osm.pbf
  fi

  echo "✂️ Slicing Pangasinan / Central-Northern Luzon bounding box ($PANGASINAN_BBOX)..."
  # Use osmium inside a quick docker container to slice without needing host dependencies
  docker run --rm \
    -v "$VALHALLA_DIR:/data" \
    stefda/osmium-tool \
    extract -b "$PANGASINAN_BBOX" /data/philippines-latest.osm.pbf -o /data/pangasinan.osm.pbf --overwrite

  echo "🧹 Cleaning up full country PBF to save disk space..."
  rm -f philippines-latest.osm.pbf
fi

echo "✅ Bounding box extract ready: $(ls -lh pangasinan.osm.pbf | awk '{print $5}')"

# 4. Stop existing Valhalla container if running
if docker ps -a --format '{{.Names}}' | grep -Eq "^juanderquest_valhalla$"; then
  echo "🛑 Stopping existing Valhalla container..."
  docker stop juanderquest_valhalla || true
  docker rm juanderquest_valhalla || true
fi

# 5. Run Valhalla Docker Container
echo "🏗️ Starting Valhalla container (gisops/valhalla:latest)..."
docker run -d \
  --name juanderquest_valhalla \
  --restart unless-stopped \
  -p 127.0.0.1:8002:8002 \
  -v "$VALHALLA_DIR:/custom_files" \
  -e build_elevation=False \
  -e build_admins=True \
  -e build_time_zones=False \
  gisops/valhalla:latest

echo "⏳ Waiting for Valhalla tile build & daemon initialization..."
sleep 15

# 6. Test Route Query
echo "🧪 Testing route query between Dagupan and Lingayen Capitol..."
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:8002/status" || true)

if [ "$STATUS" = "200" ]; then
  echo "🎉 SUCCESS: Valhalla routing engine is active and healthy on http://127.0.0.1:8002!"
  curl -s "http://127.0.0.1:8002/route" --data '{"locations":[{"lat":16.0433,"lon":120.3333},{"lat":16.0218,"lon":120.2319}],"costing":"auto"}' | head -c 200
  echo ""
else
  echo "⚠️ Container started. Tiles may still be indexing. Check logs with: docker logs -f juanderquest_valhalla"
fi
