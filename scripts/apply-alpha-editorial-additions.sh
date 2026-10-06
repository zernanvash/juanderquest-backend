#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
seed_file="$script_dir/../seeds/alpha_additional_editorial_destinations.sql"
backup_dir="$HOME/.local/share/juanderquest-alpha/backups"

if ! docker ps --format '{{.Names}}' | grep -Fxq 'jdq-alpha-postgres'; then
  echo 'Dedicated jdq-alpha-postgres container is not running; refusing to seed.' >&2
  exit 1
fi
if [ ! -f "$seed_file" ]; then
  echo 'Editorial seed SQL is missing.' >&2
  exit 1
fi

mkdir -p "$backup_dir"
backup_file="$backup_dir/jdq-alpha-before-editorial-additions-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker exec jdq-alpha-postgres pg_dump -U jdq_alpha -d juanderquest_alpha -Fc > "$backup_file"
docker exec -i jdq-alpha-postgres pg_restore -l < "$backup_file" >/dev/null
echo "Verified pre-seed backup: $backup_file"

docker exec -i jdq-alpha-postgres psql -X -v ON_ERROR_STOP=1 -U jdq_alpha -d juanderquest_alpha < "$seed_file"
docker exec jdq-alpha-postgres psql -X -At -U jdq_alpha -d juanderquest_alpha -c "SELECT count(*) FROM spots WHERE is_test = FALSE;"
