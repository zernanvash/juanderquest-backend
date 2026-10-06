#!/usr/bin/env bash
set -euo pipefail

mode="${1:---check}"
if [[ "$mode" != --check && "$mode" != --seed ]]; then
  echo 'Usage: seed-presentation-round.sh [--check|--seed]' >&2
  exit 2
fi
container=jdq-presentation-postgres
database=juanderquest_presentation
script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
campaign_file="$HOME/.config/juanderquest-presentation/campaign-id"
if [[ -L "$HOME/.config/juanderquest-presentation" || ! -s "$campaign_file" ]]; then
  echo 'Dedicated presentation campaign ID file is missing or unsafe.' >&2
  exit 1
fi
campaign_id="$(<"$campaign_file")"
if [[ ! "$campaign_id" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$ ]]; then
  echo 'Dedicated presentation campaign ID is not a UUID.' >&2
  exit 1
fi
if [[ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null)" != true ]]; then
  echo 'Dedicated presentation database is not running.' >&2
  exit 1
fi
actual_db="$(docker exec "$container" psql -U jdq_presentation -d "$database" -tAc 'SELECT current_database()')"
if [[ "$actual_db" != "$database" ]]; then
  echo 'Refusing to seed a non-presentation database.' >&2
  exit 1
fi
if [[ "$mode" == --check ]]; then
  echo 'PRESENTATION_ROUND_CHECK db=juanderquest_presentation slate=4 explicit_window=true dry_run=true'
  exit 0
fi
docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -v "campaign_id=$campaign_id" \
  -U jdq_presentation -d "$database" < "$script_dir/../seeds/presentation_juanchoice_round.sql" >/dev/null
row="$(docker exec "$container" psql -U jdq_presentation -d "$database" -tAc \
  "SELECT status || '|' || (SELECT COUNT(*) FROM juanchoice_candidates WHERE campaign_id = c.id)
   FROM juanchoice_campaigns c WHERE id = '$campaign_id'")"
echo "PRESENTATION_ROUND_SEEDED db=$database status_and_candidate_count=$row"
