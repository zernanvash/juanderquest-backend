#!/bin/sh
set -eu

input=${JDQ_OSM_PBF:-$HOME/valhalla-ph/philippines-latest.osm.pbf}
output=${JDQ_SEED_DIR:-$HOME/jdq-seed}
if [ ! -f "$input" ]; then echo "OSM PBF not found: $input" >&2; exit 2; fi
mkdir -p "$output"
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$script_dir/../.."
input_dir=$(CDPATH= cd -- "$(dirname -- "$input")" && pwd)
input_name=$(basename -- "$input")

# Plain tag filtering only. Referenced nodes are retained so ways and relations
# can be converted to actual geometries; raw inputs and outputs stay outside Git.
docker run --rm \
  -v "$input_dir:/input:ro" -v "$output:/output" \
  stefda/osmium-tool:latest \
  osmium tags-filter "/input/$input_name" \
    nwr/tourism=attraction,viewpoint,museum,theme_park,zoo,aquarium,gallery \
    nwr/natural=beach,waterfall,peak,hot_spring,cave_entrance,spring,volcano \
    nwr/historic=monument,memorial,ruins,castle,fort,archaeological_site,heritage \
    nwr/leisure=park,nature_reserve,garden,beach_resort \
    nwr/boundary=protected_area,national_park \
    nwr/amenity=place_of_worship \
    -o /output/destinations.osm.pbf --overwrite

docker run --rm -v "$output:/data" stefda/osmium-tool:latest \
  osmium export /data/destinations.osm.pbf --add-unique-id=type_id -f geojsonseq -o /data/destinations.geojsonseq --overwrite

tsx_bin=${JDQ_TSX_BIN:-"$script_dir/../../node_modules/.bin/tsx"}
"$tsx_bin" "$script_dir/extract-osm-to-candidates.ts" \
  --input "$output/destinations.geojsonseq" --output "$output/osm-candidates.jsonl" --wave national-preview

du -sh "$output/destinations.osm.pbf" "$output/destinations.geojsonseq" "$output/osm-candidates.jsonl"
