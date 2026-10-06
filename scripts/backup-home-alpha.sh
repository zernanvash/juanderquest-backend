#!/bin/sh
set -eu

# Pre-start safety checkpoint for the dedicated laptop alpha database.
# The archive never enters Git and is readable only by the WSL operator.
umask 077
backup_dir="$HOME/.local/share/juanderquest-alpha/backups"
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"

backup_file=$(mktemp "$backup_dir/jdq-alpha-prestart-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX.dump")
if ! docker exec jdq-alpha-postgres pg_dump -U jdq_alpha -d juanderquest_alpha -Fc > "$backup_file"; then
  mv "$backup_file" "$backup_file.failed"
  echo 'PostgreSQL backup failed; public alpha was not started.' >&2
  exit 1
fi

if [ ! -s "$backup_file" ] || ! docker exec -i jdq-alpha-postgres pg_restore --list < "$backup_file" > /dev/null; then
  mv "$backup_file" "$backup_file.failed"
  echo 'PostgreSQL backup archive validation failed; public alpha was not started.' >&2
  exit 1
fi

chmod 600 "$backup_file"
printf 'BACKUP_PATH=%s\n' "$backup_file"
