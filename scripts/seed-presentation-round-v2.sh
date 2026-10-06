#!/usr/bin/env bash
set -euo pipefail

# seed-presentation-round-v2.sh
# Idempotent renewal script for JuanChoice presentation demo round 2.
# Preserves round 1 untouched for historical audit fidelity.
# Does NOT write to disk or database in --check mode.
#
# Usage:
#   seed-presentation-round-v2.sh [--check]                         # Read-only dry run (0 disk/DB writes)
#   seed-presentation-round-v2.sh --seed                            # Seed v2 in DB, create campaign-id-v2 (does not activate)
#   seed-presentation-round-v2.sh --activate                        # Deliberate complete operation: seed if needed, then atomically switch allowlist
#   seed-presentation-round-v2.sh --seed --activate                 # Seed v2 and immediately activate

mode=""
activate=false
has_check=false
has_seed=false
opens="${JDQ_PRESENTATION_V2_OPENS:-2026-10-07 12:00:00+08}"
closes="${JDQ_PRESENTATION_V2_CLOSES:-2026-10-09 20:00:00+08}"

for arg in "$@"; do
  case "$arg" in
    --check)
      has_check=true
      ;;
    --seed)
      has_seed=true
      ;;
    --activate|--switch-allowlist)
      activate=true
      ;;
    *)
      echo 'Usage: seed-presentation-round-v2.sh [--check|--seed] [--activate]' >&2
      exit 2
      ;;
  esac
done

if [[ "$has_check" == "true" && "$activate" == "true" ]]; then
  echo "ERROR: Cannot combine --check (read-only dry-run) with --activate (stateful allowlist switch)." >&2
  exit 2
fi

if [[ "$has_check" == "true" && "$has_seed" == "true" ]]; then
  echo "ERROR: Cannot combine --check (read-only dry-run) with --seed (stateful DB seed)." >&2
  exit 2
fi

if [[ "$activate" == "true" ]]; then
  mode="--seed" # Activation requires DB to have round v2 seeded
elif [[ "$has_seed" == "true" ]]; then
  mode="--seed"
else
  mode="--check" # Default to read-only preflight
fi

container="${JDQ_PRESENTATION_CONTAINER:-jdq-presentation-postgres}"
database="${JDQ_PRESENTATION_DB:-juanderquest_presentation}"
script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
config_dir="${JDQ_PRESENTATION_CONFIG_DIR:-$HOME/.config/juanderquest-presentation}"
active_campaign_file="$config_dir/campaign-id"
v2_campaign_file="$config_dir/campaign-id-v2"

# 1. Container and DB verification
if [[ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null)" != "true" ]]; then
  echo "ERROR: Dedicated presentation database container '$container' is not running." >&2
  exit 1
fi

actual_db="$(docker exec "$container" psql -U jdq_presentation -d "$database" -tAc 'SELECT current_database()' 2>/dev/null || true)"
if [[ "$actual_db" != "$database" ]]; then
  echo "ERROR: Refusing to seed non-presentation database '$actual_db'." >&2
  exit 1
fi

# 2. Check mode: Genuinely read-only with ZERO disk or DB writes
if [[ "$mode" == "--check" ]]; then
  if [[ -s "$v2_campaign_file" ]]; then
    campaign_id_v2="$(<"$v2_campaign_file")"
    id_status="persisted"
  else
    if command -v uuidgen >/dev/null 2>&1; then
      campaign_id_v2="$(uuidgen | tr '[:upper:]' '[:lower:]')"
    else
      campaign_id_v2="$(node -e 'console.log(crypto.randomUUID())')"
    fi
    id_status="preview_only_no_disk_mutation"
  fi

  # Verify editorial slate is present in DB without mutating
  slate_count="$(docker exec "$container" psql -U jdq_presentation -d "$database" -tAc "
    SELECT COUNT(*) FROM spots
    WHERE id IN ('spot-cabongaoan-beach', 'spot-cape-bolinao-lighthouse', 'spot-tambobong-beach', 'spot-tondol-beach')
      AND status = 'published' AND is_test = FALSE AND recommendation_suppressed = FALSE;
  ")"

  if [[ "$slate_count" != "4" ]]; then
    echo "ERROR: Reviewed 4-spot editorial slate is incomplete (found $slate_count/4 spots)." >&2
    exit 1
  fi

  active_id="none"
  if [[ -s "$active_campaign_file" ]]; then
    active_id="$(<"$active_campaign_file")"
  fi

  echo "PRESENTATION_ROUND_V2_CHECK db=$database campaign_id=$campaign_id_v2 id_status=$id_status active_allowlist=$active_id opens=\"$opens\" closes=\"$closes\" dry_run=true zero_writes=true"
  exit 0
fi

# 3. Seed mode: Creates campaign-id-v2 on disk if missing
mkdir -p "$config_dir"
if [[ ! -s "$v2_campaign_file" ]]; then
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen | tr '[:upper:]' '[:lower:]' > "$v2_campaign_file"
  else
    node -e "console.log(crypto.randomUUID())" > "$v2_campaign_file"
  fi
fi

campaign_id_v2="$(<"$v2_campaign_file")"
if [[ ! "$campaign_id_v2" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$ ]]; then
  echo "ERROR: Dedicated presentation campaign ID v2 is not a valid UUID: '$campaign_id_v2'" >&2
  exit 1
fi

echo "Seeding presentation round v2 ($campaign_id_v2)..."
docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 \
  -v "campaign_id_v2=$campaign_id_v2" \
  -v "opens=$opens" \
  -v "closes=$closes" \
  -U jdq_presentation -d "$database" < "$script_dir/../seeds/presentation_juanchoice_round_v2.sql" >/dev/null

row="$(docker exec "$container" psql -U jdq_presentation -d "$database" -tAc \
  "SELECT status || '|' || (SELECT COUNT(*) FROM juanchoice_candidates WHERE campaign_id = c.id)
   FROM juanchoice_campaigns c WHERE id = '$campaign_id_v2'")"
echo "PRESENTATION_ROUND_V2_SEEDED db=$database campaign_id=$campaign_id_v2 status_and_candidate_count=$row opens=\"$opens\" closes=\"$closes\""

# 4. Atomic allowlist switch if requested
if [[ "$activate" == "true" ]]; then
  # Verify campaign voting window in database before switching allowlist
  voting_window_status="$(docker exec "$container" psql -U jdq_presentation -d "$database" -tAc "
    SELECT CASE
      WHEN opens_at > clock_timestamp() THEN 'SCHEDULED_FUTURE'
      WHEN closes_at <= clock_timestamp() THEN 'EXPIRED'
      ELSE 'ACTIVE_OPEN'
    END
    FROM juanchoice_campaigns WHERE id = '$campaign_id_v2';
  ")"

  if [[ "$voting_window_status" == "SCHEDULED_FUTURE" ]]; then
    echo "ERROR: Round '$campaign_id_v2' is scheduled for the future (opens_at > now). Immediate activation requires an active voting window (opens_at <= now < closes_at). Result: SCHEDULED_NOT_VOTABLE. Active allowlist was NOT changed. Round remains seeded in database '$database' for audit integrity." >&2
    exit 1
  fi

  if [[ "$voting_window_status" == "EXPIRED" ]]; then
    echo "ERROR: Round '$campaign_id_v2' has expired (closes_at <= now). Refusing activation of expired round. Result: EXPIRED_NOT_VOTABLE. Active allowlist was NOT changed. Round remains in database '$database'." >&2
    exit 1
  fi

  echo "Performing atomic allowlist switch to v2 ($campaign_id_v2)..."
  backup_file="$config_dir/campaign-id.bak.$(date +%s)"
  if [[ -f "$active_campaign_file" ]]; then
    cp "$active_campaign_file" "$backup_file"
  fi

  tmp_file="$config_dir/campaign-id.tmp.$$"
  echo "$campaign_id_v2" > "$tmp_file"
  mv "$tmp_file" "$active_campaign_file"

  # Validate that start-presentation-api preflight accepts new ID AND passes all voting checks in public profile
  if JDQ_PRESENTATION_CONFIG_DIR="$config_dir" JDQ_PRESENTATION_DB="$database" JDQ_PRESENTATION_CONTAINER="$container" \
     JDQ_TEST_HARNESS_SCOPE="${JDQ_TEST_HARNESS_SCOPE:-}" JDQ_ALLOW_PRESENTATION_TEST_DB="${JDQ_ALLOW_PRESENTATION_TEST_DB:-}" \
     bash "$script_dir/start-presentation-api.sh" --profile=public --check-voting >/dev/null 2>&1; then
    echo "ALLOWLIST_SWITCH_SUCCESS active_id=$campaign_id_v2 status=ACTIVE_AND_VOTABLE backup=$backup_file"
  else
    echo "ERROR: start-presentation-api.sh --check-voting failed for new campaign ID; restoring previous allowlist from backup!" >&2
    if [[ -f "$backup_file" ]]; then
      mv "$backup_file" "$active_campaign_file"
    fi
    echo "ALLOWLIST_SWITCH_FAILED. Restored active campaign allowlist to previous ID. Truthful note: Newly seeded round remains in database '$database' for audit integrity (not rolled back from DB)." >&2
    exit 1
  fi
fi
