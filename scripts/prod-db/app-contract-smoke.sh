#!/usr/bin/env bash
# Plan 116: call every read endpoint the mobile app (v0.4.0, feat/116-v04-prerelease-fixes) uses,
# with the same parameters it sends, against a local preview API. Run in WSL.
#   scripts/prod-db/app-contract-smoke.sh [base]   (default http://127.0.0.1:4130/api/v1)
set -uo pipefail
B="${1:-http://127.0.0.1:4130/api/v1}"
case "$B" in http://127.0.0.1:*|http://localhost:*) ;; *) echo 'Refusing: loopback only.' >&2; exit 2 ;; esac
fail=0
hit() { # label path [jq-ish grep that must match]
  local out code t
  out=$(curl -s -w '\n%{http_code} %{time_total}' "$B$2"); code=$(tail -1 <<<"$out" | cut -d' ' -f1); t=$(tail -1 <<<"$out" | cut -d' ' -f2)
  local body; body=$(sed '$d' <<<"$out")
  local ok=OK; [ "$code" = 200 ] || ok=FAIL
  if [ $ok = OK ] && [ -n "${3:-}" ] && ! grep -qE "$3" <<<"$body"; then ok="FAIL(no /$3/)"; fi
  [ $ok = OK ] || fail=1
  printf '%-5s %s %6.0f ms %7d B  %s\n' "$ok" "$code" "$(awk "BEGIN{print $t*1000}")" "${#body}" "$1"
}
SLUG=$(curl -s "$B/spots?limit=1&sort=recommended" | grep -o '"slug":"[^"]*"' | head -1 | cut -d'"' -f4)
ID=$(curl -s "$B/spots?limit=1&sort=recommended" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
PHOTO_SPOT=osm-w97333697   # Paoay Church (featured, has catalog photos)
echo "sample spot: $ID ($SLUG)"
hit 'Explore list (app: no limit)'          '/spots'                                   '"next_cursor"'
hit 'Explore search q=paoay'                '/spots?q=paoay'                           'Paoay'
hit 'Explore category'                      '/spots?categories=nature_outdoors'        '"data":\['
hit 'Explore intent'                        '/spots?intent=family'                     '"data":\['
hit 'Trending'                              '/spots/trending'                          '"data":'
hit 'Highlights (hidden gems)'              '/spots/highlights'                        '"data":'
hit 'Spot detail by slug'                   "/spots/$SLUG"                             '"id":'
hit 'Spot detail with catalog photos'       "/spots/$PHOTO_SPOT"                       '"source_name":"Photo: '
hit 'Alternatives'                          "/spots/$SLUG/alternatives"                '"data":'
hit 'Spot quizzes'                          "/spots/$ID/quizzes"                       ''
hit 'Spot quests'                           "/spots/$ID/quests"                        ''
hit 'Spot comments'                         "/spots/$ID/comments"                      ''
hit 'Recognize (Vigan)'                     '/spots/recognize?lat=17.5747&lng=120.3869' 'vigan|Vigan'
hit 'Recognize (Laoag)'                     '/spots/recognize?lat=18.1977&lng=120.5936' 'laoag|Laoag'
hit 'Areas, Region I view, zoom 8'          '/areas?bbox=119.5000,15.3000,121.2000,18.8000&zoom=8' '"data":\['
hit 'Areas, Ilocos Norte view, zoom 11'     '/areas?bbox=120.4000,18.0000,120.9000,18.6000&zoom=11' 'laoag'
hit 'Area shape (Laoag)'                    '/areas/ilocos-norte--laoag/shape'         '"geometry"'
hit 'Area shape (Pangasinan, carried)'      '/areas/pangasinan/shape'                  '"geometry"'
hit 'Area spots (Vigan)'                    '/areas/ilocos-sur--vigan/spots'           ''
hit 'Map markers (new endpoint)'            '/spots/map?bbox=119.5,15.3,121.2,18.8&zoom=8' '"markers"'
P=$(curl -s "$B/spots/$PHOTO_SPOT" | grep -o '/api/v1/uploads/spot-photos/catalog/[^"]*w640.webp' | head -1)
hit 'Catalog photo file (w640)'             "${P#/api/v1}"                             ''
exit $fail
