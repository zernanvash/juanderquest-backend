#!/usr/bin/env bash
# Plan 116 §4.4: nightly logical backup of the production database v2 (jdq-prod-postgres). Run in WSL.
# Cron runs it hourly; it dumps only when the newest nightly dump is older than 20 h, so nights missed
# while the laptop slept are caught up on the next wake. --force dumps regardless of age.
#
# Output (G:, the WSL disk): ~/jdq-backups/prod/jdq-prod-<UTC stamp>.dump (+ .sha256, + .counts with the
# row count of every public table at dump time, used by restore-drill-prod.sh).
# Retention: the newest 7 dumps, plus the newest dump of each of the last 4 ISO weeks.
# Passwords are never printed. Log: ~/.local/state/juanderquest-prod/nightly-backup.log
set -euo pipefail
umask 077
SECRETS=~/.jdq-secrets/jdq-prod-postgres.env
DIR=~/jdq-backups/prod
LOG=~/.local/state/juanderquest-prod/nightly-backup.log
mkdir -p "$DIR" "$(dirname "$LOG")"

if [ "${1:-}" != --force ] && [ -n "$(find "$DIR" -maxdepth 1 -name 'jdq-prod-*.dump' -mmin -1200 | head -n 1)" ]; then
  exit 0
fi
exec >>"$LOG" 2>&1
echo "$(date -Is) start"

free_gb=$(df -BG --output=avail /mnt/g | tail -1 | tr -dc '0-9')
if [ "${free_gb:-0}" -lt 15 ]; then echo "$(date -Is) FAILED: G: has ${free_gb} GB free (< 15 GB)"; exit 1; fi

# shellcheck disable=SC1090
C=$(. "$SECRETS"; printf %s "$PG_CONTAINER"); DB=$(. "$SECRETS"; printf %s "$PG_DB")
SU=$(. "$SECRETS"; printf %s "$POSTGRES_SUPERUSER_PASSWORD")
[ "$C" = jdq-prod-postgres ] && [ "$DB" = juanderquest_prod ] || { echo "$(date -Is) FAILED: unexpected secrets"; exit 1; }

stamp=$(date -u +%Y%m%dT%H%M%SZ)
tmp="$DIR/.jdq-prod-$stamp.dump.part"
out="$DIR/jdq-prod-$stamp.dump"
COUNTS="SELECT table_name || ' ' || (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name), false, true, '')))[1]::text
          FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name"

count_rows() { docker exec -i -e PGPASSWORD="$SU" "$C" psql -h 127.0.0.1 -U postgres -d "$DB" -X -tA -c "$COUNTS"; }
# Counts before and after the dump; when they agree they are exactly what the dump holds, and the
# restore drill compares against them. Otherwise (writes during the dump) no .counts file is kept.
before=$(count_rows)
if ! docker exec -e PGPASSWORD="$SU" "$C" pg_dump -h 127.0.0.1 -U postgres -Fc -Z 6 "$DB" > "$tmp"; then
  rm -f "$tmp"; echo "$(date -Is) FAILED: pg_dump"; exit 1
fi
after=$(count_rows)
mv "$tmp" "$out"
(cd "$DIR" && sha256sum "$(basename "$out")" > "$(basename "$out").sha256")
if [ "$before" = "$after" ]; then
  printf '%s\n' "$after" > "$out.counts"
  note="$(printf '%s\n' "$after" | wc -l) tables counted"
else
  note='rows changed during the dump, no .counts'
fi
echo "$(date -Is) ok $(basename "$out") $(stat -c %s "$out") bytes, $note"

# Retention: keep the newest 7, and the newest dump of each of the last 4 ISO weeks.
keep=$(mktemp)
ls -1t "$DIR"/jdq-prod-*.dump | head -n 7 > "$keep"
for w in 0 1 2 3; do
  wk=$(date -u -d "-$w week" +%G%V)
  for f in $(ls -1t "$DIR"/jdq-prod-*.dump); do
    s=$(basename "$f" .dump); s=${s#jdq-prod-}
    if [ "$(date -u -d "${s:0:8}" +%G%V)" = "$wk" ]; then echo "$f" >> "$keep"; break; fi
  done
done
for f in "$DIR"/jdq-prod-*.dump; do
  if ! grep -qxF "$f" "$keep"; then
    rm -f -- "$f" "$f.sha256" "$f.counts"
    echo "$(date -Is) pruned $(basename "$f")"
  fi
done
rm -f "$keep"
