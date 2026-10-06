#!/usr/bin/env bash
set -euo pipefail

# drill-presentation-restore.sh
# Non-destructive, fail-closed backup & restore drill for JuanChoice presentation demo.
# Verifies full backup/restore fidelity into a unique, owned drill database
# (juanderquest_presentation_drill_<timestamp>_<random>)
# WITHOUT altering, dropping, or truncating the live juanderquest_presentation database.
#
# Flags:
#   --host-archive=<path>       Use an existing host backup dump instead of generating a new one
#   --keep-drill-db             Do not drop the drill database on exit (retained for inspection)
#   --test-failure-injection    Verify fail-closed single-transaction rollback on mid-stream failure
#   --check                     Perform preflight validation only (dry-run)

container="${JDQ_PRESENTATION_CONTAINER:-jdq-presentation-postgres}"
source_db="${JDQ_PRESENTATION_DB:-juanderquest_presentation}"
custom_host_archive=""
keep_drill_db=false
test_failure_injection=false
check_only=false
created_drill_db=""

for arg in "$@"; do
  case "$arg" in
    --host-archive=*)
      custom_host_archive="${arg#*=}"
      ;;
    --keep-drill-db)
      keep_drill_db=true
      ;;
    --test-failure-injection)
      test_failure_injection=true
      ;;
    --check)
      check_only=true
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

echo "=== JuanChoice Non-Destructive Restore Drill ==="

# 1. Verify container is running
if [[ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null)" != "true" ]]; then
  echo "ERROR: Dedicated presentation database container '$container' is not running." >&2
  exit 1
fi

# 2. Verify source database exists and is dedicated presentation DB
actual_db="$(docker exec "$container" psql -U jdq_presentation -d "$source_db" -tAc 'SELECT current_database()' 2>/dev/null || true)"
if [[ "$actual_db" != "$source_db" ]]; then
  echo "ERROR: Source database '$source_db' is unavailable in container '$container'." >&2
  exit 1
fi

if [[ "$check_only" == "true" ]]; then
  echo "PREFLIGHT_DRILL_CHECK container=$container source_db=$source_db status=ready dry_run=true"
  exit 0
fi

# -------------------------------------------------------------
# Snapshot Capture & Archive Validation
# -------------------------------------------------------------
backup_dir="${JDQ_PRESENTATION_BACKUP_DIR:-$HOME/.config/juanderquest-presentation/backups}"
mkdir -p "$backup_dir"

if [[ -n "$custom_host_archive" ]]; then
  if [[ ! -f "$custom_host_archive" ]]; then
    echo "ERROR: Specified host archive '$custom_host_archive' does not exist." >&2
    exit 1
  fi
  host_archive="$custom_host_archive"
  echo "Using existing host archive: $host_archive"
else
  host_archive="$backup_dir/presentation_drill_$(date +%Y%m%d_%H%M%S).dump"
  echo "Step 1: Capturing snapshot of '$source_db' to host archive '$host_archive'..."
  docker exec "$container" pg_dump -U jdq_presentation -Fc "$source_db" > "$host_archive"
fi

# Validate archive file size > 0
if [[ ! -s "$host_archive" ]]; then
  echo "ERROR: Backup archive '$host_archive' is empty." >&2
  exit 1
fi

archive_sha="$(sha256sum "$host_archive" | cut -d' ' -f1)"
echo "Archive SHA-256: $archive_sha"

echo "Step 2: Validating backup archive format and Table of Contents..."
toc_entries="$(docker exec -i "$container" pg_restore --list < "$host_archive" | wc -l)"
if [[ "$toc_entries" -le 10 ]]; then
  echo "ERROR: Backup archive TOC check failed or had suspiciously few entries ($toc_entries)." >&2
  exit 1
fi
echo "TOC verified ($toc_entries entries found)."

# -------------------------------------------------------------
# Optional Mid-Stream Failure Injection Drill
# -------------------------------------------------------------
if [[ "$test_failure_injection" == "true" ]]; then
  echo "--- Executing Mid-Stream Failure Injection Drill ---"
  
  # Create a truncated copy at 40% length to simulate mid-stream network/disk interruption
  archive_bytes="$(wc -c < "$host_archive")"
  trunc_bytes="$(( archive_bytes * 4 / 10 ))"
  trunc_file="/tmp/truncated_presentation_drill_${RANDOM}.dump"
  head -c "$trunc_bytes" "$host_archive" > "$trunc_file"

  # Provision clean test DB only if absent
  while true; do
    fail_drill_db="juanderquest_presentation_drill_fail_${RANDOM}"
    exists="$(docker exec "$container" psql -U jdq_presentation -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$fail_drill_db'")"
    if [[ "$exists" != "1" ]]; then break; fi
  done
  docker exec "$container" psql -U jdq_presentation -d postgres -c "CREATE DATABASE $fail_drill_db OWNER jdq_presentation;" >/dev/null

  set +e
  restore_output="$(docker exec -i "$container" pg_restore -U jdq_presentation -d "$fail_drill_db" --exit-on-error --single-transaction < "$trunc_file" 2>&1)"
  restore_rc=$?
  set -e

  rm -f "$trunc_file"

  if [[ $restore_rc -eq 0 ]]; then
    echo "ERROR: pg_restore unexpectedly succeeded on a truncated archive!" >&2
    docker exec "$container" psql -U jdq_presentation -d postgres -c "DROP DATABASE IF EXISTS $fail_drill_db;" >/dev/null
    exit 1
  fi

  # Verify single-transaction rollback: table count must be 0
  table_count="$(docker exec "$container" psql -U jdq_presentation -d "$fail_drill_db" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")"
  docker exec "$container" psql -U jdq_presentation -d postgres -c "DROP DATABASE IF EXISTS $fail_drill_db;" >/dev/null

  if [[ "$table_count" != "0" ]]; then
    echo "ERROR: Mid-stream failure left partial tables behind! table_count=$table_count" >&2
    exit 1
  fi

  echo "FAILURE_INJECTION_VERIFIED exit_code=$restore_rc single_transaction_rollback=true public_tables=0"
fi

# -------------------------------------------------------------
# Primary Non-Destructive Restore Drill
# -------------------------------------------------------------

# Generate unique owned drill database without speculative DROP
while true; do
  timestamp="$(date +%s)"
  drill_db="juanderquest_presentation_drill_${timestamp}_${RANDOM}"
  exists="$(docker exec "$container" psql -U jdq_presentation -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$drill_db'")"
  if [[ "$exists" != "1" ]]; then break; fi
done

echo "Step 3: Provisioning isolated drill database '$drill_db'..."
docker exec "$container" psql -U jdq_presentation -d postgres -c "CREATE DATABASE $drill_db OWNER jdq_presentation;" >/dev/null
created_drill_db="$drill_db"

echo "Step 4: Executing fail-closed single-transaction restore into '$drill_db'..."
set +e
restore_err="$(docker exec -i "$container" pg_restore -U jdq_presentation -d "$drill_db" --exit-on-error --single-transaction < "$host_archive" 2>&1)"
restore_rc=$?
set -e

if [[ $restore_rc -ne 0 ]]; then
  echo "ERROR: Fail-closed restore failed with exit code $restore_rc!" >&2
  echo "pg_restore stderr:" >&2
  echo "$restore_err" >&2
  echo "NOTE: Drill database '$drill_db' preserved intact for forensic analysis." >&2
  exit 1
fi

echo "Step 5: Executing deep verification between '$source_db' and '$drill_db'..."

# A. Migration ledger check
source_migrations="$(docker exec "$container" psql -U jdq_presentation -d "$source_db" -tAc "SELECT filename FROM schema_migrations ORDER BY filename")"
drill_migrations="$(docker exec "$container" psql -U jdq_presentation -d "$drill_db" -tAc "SELECT filename FROM schema_migrations ORDER BY filename")"

if [[ "$source_migrations" != "$drill_migrations" ]]; then
  echo "ERROR: Migration ledger mismatch between source and restored drill database!" >&2
  exit 1
fi

# B. Core tables & metrics check
query="SELECT json_build_object(
  'campaigns', (SELECT COUNT(*) FROM juanchoice_campaigns),
  'candidates', (SELECT COUNT(*) FROM juanchoice_candidates),
  'ballots', (SELECT COUNT(*) FROM juanchoice_ballots),
  'ballot_events', (SELECT COUNT(*) FROM juanchoice_ballot_events),
  'participations', (SELECT COUNT(*) FROM juanchoice_participations),
  'receipts', (SELECT COUNT(*) FROM juanchoice_receipts),
  'users', (SELECT COUNT(*) FROM users),
  'spots', (SELECT COUNT(*) FROM spots),
  'progression_totals', (SELECT COUNT(*) FROM progression_totals),
  'progression_events', (SELECT COUNT(*) FROM progression_events),
  'total_civic_xp', COALESCE((SELECT SUM(civic_xp) FROM progression_totals), 0),
  'total_civic_stamps', COALESCE((SELECT SUM(civic_stamps) FROM progression_totals), 0)
)::text;"

source_metrics="$(docker exec "$container" psql -U jdq_presentation -d "$source_db" -tAc "$query")"
drill_metrics="$(docker exec "$container" psql -U jdq_presentation -d "$drill_db" -tAc "$query")"

echo "Source metrics: $source_metrics"
echo "Drill metrics:  $drill_metrics"

if [[ "$source_metrics" != "$drill_metrics" ]]; then
  echo "ERROR: Table metric mismatch between source and drill database!" >&2
  exit 1
fi

# C. Ballot event IDs and candidates audit check
source_ballot_events="$(docker exec "$container" psql -U jdq_presentation -d "$source_db" -tAc "SELECT id, campaign_id, user_id, candidate_id, version, idempotency_key FROM juanchoice_ballot_events ORDER BY id")"
drill_ballot_events="$(docker exec "$container" psql -U jdq_presentation -d "$drill_db" -tAc "SELECT id, campaign_id, user_id, candidate_id, version, idempotency_key FROM juanchoice_ballot_events ORDER BY id")"

if [[ "$source_ballot_events" != "$drill_ballot_events" ]]; then
  echo "ERROR: Ballot event audit trail mismatch between source and drill database!" >&2
  exit 1
fi

# D. Constraints and foreign keys check
source_constraints="$(docker exec "$container" psql -U jdq_presentation -d "$source_db" -tAc "SELECT conname, contype FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY conname")"
drill_constraints="$(docker exec "$container" psql -U jdq_presentation -d "$drill_db" -tAc "SELECT conname, contype FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY conname")"

if [[ "$source_constraints" != "$drill_constraints" ]]; then
  echo "ERROR: Constraint schema mismatch between source and drill database!" >&2
  exit 1
fi

echo "Step 6: Cleanup..."
if [[ "$keep_drill_db" == "true" ]]; then
  echo "Flag --keep-drill-db specified: Preserving '$created_drill_db' for operator inspection."
else
  if [[ -n "${created_drill_db:-}" ]]; then
    docker exec "$container" psql -U jdq_presentation -d postgres -c "DROP DATABASE IF EXISTS $created_drill_db;" >/dev/null
    echo "Temporary drill database '$created_drill_db' dropped cleanly."
  fi
fi

echo "RESTORE_DRILL_VERIFIED: Migration ledger (schema_migrations), 12 core entity counts and sums, ballot events audit rows, and table constraints match 100%."
echo "Archive SHA-256: $archive_sha"
echo "Zero data in '$source_db' was altered."
