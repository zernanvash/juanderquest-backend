#!/usr/bin/env bash
set -euo pipefail

mode="${1:---check}"
if [[ "$mode" != --check && "$mode" != --seed ]]; then
  echo 'Usage: seed-presentation-editorial.sh [--check|--seed]' >&2
  exit 2
fi
container=jdq-presentation-postgres
database=juanderquest_presentation
script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if [[ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null)" != true ]]; then
  echo 'Dedicated presentation database is not running.' >&2
  exit 1
fi
actual_db="$(docker exec "$container" psql -U jdq_presentation -d "$database" -tAc 'SELECT current_database()')"
if [[ "$actual_db" != "$database" ]]; then
  echo 'Refusing to seed a non-presentation database.' >&2
  exit 1
fi
for seed_file in alpha_editorial_destinations.sql alpha_additional_editorial_destinations.sql; do
  if [[ ! -f "$script_dir/../seeds/$seed_file" ]]; then
    echo "Reviewed editorial seed missing: $seed_file" >&2
    exit 1
  fi
done
if [[ "$mode" == --check ]]; then
  echo 'PRESENTATION_EDITORIAL_CHECK db=juanderquest_presentation reviewed_seed_files=2 dry_run=true'
  exit 0
fi
for seed_file in alpha_editorial_destinations.sql alpha_additional_editorial_destinations.sql; do
  docker exec -i "$container" psql -v ON_ERROR_STOP=1 -U jdq_presentation -d "$database" < "$script_dir/../seeds/$seed_file" >/dev/null
done
spot_count="$(docker exec "$container" psql -U jdq_presentation -d "$database" -tAc "SELECT COUNT(*) FROM spots WHERE source_type = 'editorial' AND is_test = FALSE")"
echo "PRESENTATION_EDITORIAL_SEEDED db=$database public_editorial_spots=$spot_count"
