#!/usr/bin/env bash
set -euo pipefail

# Operates only on the dedicated JuanChoice presentation database. Never use
# this script to repair, seed, or reset the public alpha database.
container=jdq-presentation-postgres
volume=jdq_presentation_pg_data
database=juanderquest_presentation
db_user=jdq_presentation
secret_dir="$HOME/.config/juanderquest-presentation"
password_file="$secret_dir/db-password"
jwt_file="$secret_dir/jwt-secret"
campaign_file="$secret_dir/campaign-id"
mode="${1:---check}"

if [[ "$mode" != --check && "$mode" != --provision ]]; then
  echo 'Usage: setup-presentation-db.sh [--check|--provision]' >&2
  exit 2
fi
if [[ -L "$secret_dir" ]]; then
  echo 'Presentation secret directory must not be a symlink.' >&2
  exit 1
fi

container_exists=false
volume_exists=false
if docker container inspect "$container" >/dev/null 2>&1; then container_exists=true; fi
if docker volume inspect "$volume" >/dev/null 2>&1; then volume_exists=true; fi
if docker ps -a --format '{{.Names}} {{.Ports}}' | grep -E '^[^ ]+ .*127\.0\.0\.1:55434->' | grep -v "^$container " >/dev/null; then
  echo 'Presentation port 55434 is assigned to another container.' >&2
  exit 1
fi
if command -v ss >/dev/null && ss -ltn '( sport = :55434 )' | grep -q ':55434'; then
  if [[ "$container_exists" == false ]]; then
    echo 'Presentation port 55434 is already listening; refusing to provision.' >&2
    exit 1
  fi
fi

if [[ "$mode" == --check ]]; then
  echo "PRESENTATION_DB_CHECK container_exists=$container_exists volume_exists=$volume_exists password_file_exists=$([[ -f "$password_file" ]] && echo true || echo false) jwt_file_exists=$([[ -f "$jwt_file" ]] && echo true || echo false) campaign_file_exists=$([[ -f "$campaign_file" ]] && echo true || echo false)"
  exit 0
fi

# Refuse to adopt an existing container/volume: it could contain unrelated data.
if [[ "$container_exists" == true || "$volume_exists" == true ]]; then
  echo 'Presentation container or volume already exists. No provisioning action taken.' >&2
  exit 1
fi
if [[ -e "$password_file" || -e "$jwt_file" || -e "$campaign_file" ]]; then
  echo 'Presentation secret files already exist. No provisioning action taken.' >&2
  exit 1
fi
if ! command -v openssl >/dev/null || ! command -v node >/dev/null; then
  echo 'openssl and Node.js are required to provision private secrets.' >&2
  exit 1
fi

umask 077
mkdir -p "$secret_dir"
chmod 700 "$secret_dir"
openssl rand -hex 32 > "$password_file"
openssl rand -hex 48 > "$jwt_file"
node -p 'require("node:crypto").randomUUID()' > "$campaign_file"
chmod 600 "$password_file" "$jwt_file" "$campaign_file"

export POSTGRES_PASSWORD
POSTGRES_PASSWORD="$(<"$password_file")"
docker volume create "$volume" >/dev/null
docker run -d --name "$container" \
  --publish 127.0.0.1:55434:5432 \
  --volume "$volume:/var/lib/postgresql/data" \
  --env POSTGRES_USER="$db_user" \
  --env POSTGRES_DB="$database" \
  --env POSTGRES_PASSWORD \
  --restart unless-stopped \
  postgres:16-alpine >/dev/null
unset POSTGRES_PASSWORD
echo 'PRESENTATION_DB_PROVISIONED container=jdq-presentation-postgres db=juanderquest_presentation loopback_port=55434. Alpha database untouched.'
