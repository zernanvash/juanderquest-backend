#!/usr/bin/env bash
# Plan 116 §6.6: p95 latency + payload of the read endpoints on a local preview API. Run in WSL.
#   scripts/prod-db/measure-budgets.sh [base_url]   (default http://127.0.0.1:4130/api/v1)
set -euo pipefail
BASE="${1:-http://127.0.0.1:4130/api/v1}"
case "$BASE" in http://127.0.0.1:*|http://localhost:*) ;; *) echo 'Refusing: loopback only.' >&2; exit 2 ;; esac
N=40
measure() {
  local label=$1 path=$2 times=() size=0 code
  for _ in 1 2 3; do curl -s -o /dev/null "$BASE$path"; done   # warm-up
  for _ in $(seq 1 $N); do
    read -r code t s < <(curl -s -o /dev/null -w '%{http_code} %{time_total} %{size_download}\n' "$BASE$path")
    [ "$code" = 200 ] || { printf '%-44s HTTP %s\n' "$label" "$code"; return; }
    times+=("$t"); size=$s
  done
  printf '%s\n' "${times[@]}" | sort -n | awk -v l="$label" -v s="$size" -v n=$N '
    { a[NR]=$1 } END { p50=a[int(n*0.5)]; p95=a[int(n*0.95)];
      printf "%-44s p50 %6.1f ms   p95 %6.1f ms   %7.1f KB\n", l, p50*1000, p95*1000, s/1024 }'
}
measure 'GET /spots (default page)'               '/spots'
measure 'GET /spots (bbox Dagupan, limit 50)'     '/spots?bbox=120.25,15.95,120.45,16.15&limit=50'
measure 'GET /spots (near Vigan, radius 30)'      '/spots?lat=17.5747&lng=120.3869&radius=30&limit=50'
measure 'GET /spots (area ilocos-norte)'          '/spots?area_id=ilocos-norte&limit=50'
measure 'GET /spots/map (Region I, zoom 7)'       '/spots/map?bbox=119.5,15.3,121.2,18.8&zoom=7'
measure 'GET /spots/map (Region I, zoom 9)'       '/spots/map?bbox=119.5,15.3,121.2,18.8&zoom=9'
measure 'GET /spots/map (Laoag, zoom 13)'         '/spots/map?bbox=120.5,18.15,120.7,18.25&zoom=13'
measure 'GET /spots/search (q=vigan)'             '/spots/search?q=vigan'
measure 'GET /spots/search (q=paoay, typo payoa)' '/spots/search?q=payoa'
measure 'GET /spots/search (q=bangui)'            '/spots/search?q=bangui'
