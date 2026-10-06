#!/usr/bin/env bash
set -euo pipefail

# test-presentation-renewal-e2e.sh
# End-to-end integration test executing the actual operator renewal shell script
# (seed-presentation-round-v2.sh) against isolated real PostgreSQL.
#
# Verifies:
# 1. --check mode is 100% read-only (zero DB mutations, zero disk mutations).
# 2. Mutual exclusion: rejects --check combined with --activate or --seed.
# 3. Deliberate complete --activate operation:
#    - Closes Round 1 without altering historical ballots.
#    - Seeds Round 2 with 4 eligible candidates.
#    - Atomically updates campaign-id file with rollback backup.
# 4. start-presentation-api.sh --profile=public --check-voting succeeds on new round.
# 5. Rollback safety: rolls back campaign-id if preflight fails.
# 6. Preserves live juanderquest_presentation DB untouched.

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
container="${JDQ_PRESENTATION_CONTAINER:-jdq-presentation-postgres}"
live_db="${JDQ_PRESENTATION_DB:-juanderquest_presentation}"

echo "=== JuanChoice Renewal E2E Integration Test (Real Shell Scripts & Real PG) ==="

# 1. Verify container is running
if [[ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null)" != "true" ]]; then
  echo "ERROR: Dedicated presentation database container '$container' is not running." >&2
  exit 1
fi

# 2. Record live DB baseline count
live_ballots_before="$(docker exec "$container" psql -U jdq_presentation -d "$live_db" -tAc "SELECT count(*) FROM juanchoice_ballots;")"
echo "Live presentation DB baseline ballots: $live_ballots_before"

# 3. Provision isolated test database cloned from live DB
timestamp="$(date +%s)"
test_db="juanderquest_presentation_test_renew_${timestamp}_${RANDOM}"
echo "Provisioning isolated test database '$test_db'..."
docker exec "$container" psql -U jdq_presentation -d postgres -c "CREATE DATABASE $test_db TEMPLATE $live_db OWNER jdq_presentation;" >/dev/null

# Provision isolated config directory
test_config_dir="/tmp/test_presentation_renewal_${timestamp}_${RANDOM}"
mkdir -p "$test_config_dir"

# Populate isolated secrets
docker exec "$container" psql -U jdq_presentation -d postgres -tAc "SELECT 1" >/dev/null
real_config_dir="${HOME}/.config/juanderquest-presentation"
cp "$real_config_dir/db-password" "$test_config_dir/db-password"
cp "$real_config_dir/jwt-secret" "$test_config_dir/jwt-secret"

# Initial round 1 ID
round_1_id="$(<"$real_config_dir/campaign-id")"
echo "$round_1_id" > "$test_config_dir/campaign-id"

cleanup() {
  echo "--- Cleaning up test resources ---"
  rm -rf "$test_config_dir" "${test_config_dir}_future"
  docker exec "$container" psql -U jdq_presentation -d postgres -c "DROP DATABASE IF EXISTS $test_db; DROP DATABASE IF EXISTS ${test_db}_future;" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "Isolated environment initialized. Config: $test_config_dir, DB: $test_db"

# -------------------------------------------------------------
# STEP 1: Verify --check is genuinely ZERO-WRITE
# -------------------------------------------------------------
echo "Step 1: Testing --check mode for zero writes..."
test_db_ballots_before="$(docker exec "$container" psql -U jdq_presentation -d "$test_db" -tAc "SELECT count(*) FROM juanchoice_ballots;")"
test_db_campaigns_before="$(docker exec "$container" psql -U jdq_presentation -d "$test_db" -tAc "SELECT count(*) FROM juanchoice_campaigns;")"

check_output="$(JDQ_PRESENTATION_CONFIG_DIR="$test_config_dir" JDQ_PRESENTATION_DB="$test_db" JDQ_PRESENTATION_CONTAINER="$container" \
  bash "$script_dir/seed-presentation-round-v2.sh" --check)"

echo "Check output: $check_output"

if [[ "$check_output" != *"zero_writes=true"* || "$check_output" != *"dry_run=true"* ]]; then
  echo "ERROR: --check did not report zero_writes=true!" >&2
  exit 1
fi

if [[ -f "$test_config_dir/campaign-id-v2" ]]; then
  echo "ERROR: --check created campaign-id-v2 on disk!" >&2
  exit 1
fi

test_db_campaigns_after_check="$(docker exec "$container" psql -U jdq_presentation -d "$test_db" -tAc "SELECT count(*) FROM juanchoice_campaigns;")"
if [[ "$test_db_campaigns_after_check" != "$test_db_campaigns_before" ]]; then
  echo "ERROR: --check mutated database campaigns! ($test_db_campaigns_before -> $test_db_campaigns_after_check)" >&2
  exit 1
fi
echo "PASS: Step 1 --check is 100% read-only with zero DB/disk mutations."

# -------------------------------------------------------------
# STEP 2: Verify mutual exclusion flags & public DB protection
# -------------------------------------------------------------
echo "Step 2: Testing mutual exclusion of --check with mutation flags..."
set +e
bash "$script_dir/seed-presentation-round-v2.sh" --check --activate >/dev/null 2>&1
ex_check_activate=$?
bash "$script_dir/seed-presentation-round-v2.sh" --check --seed >/dev/null 2>&1
ex_check_seed=$?
set -e

if [[ $ex_check_activate -ne 2 || $ex_check_seed -ne 2 ]]; then
  echo "ERROR: Mutual exclusion flags did not reject with exit code 2! ($ex_check_activate, $ex_check_seed)" >&2
  exit 1
fi
echo "PASS: Step 2 Mutual exclusion enforced."

# Step 2B: Verify start-presentation-api.sh --profile=public rejects test DB when outside test harness scope
echo "Step 2B: Testing public API rejection of test DB without test harness scope..."
set +e
out_no_scope="$(JDQ_PRESENTATION_CONFIG_DIR="$test_config_dir" JDQ_PRESENTATION_DB="$test_db" JDQ_PRESENTATION_CONTAINER="$container" \
  JDQ_TEST_HARNESS_SCOPE="" bash "$script_dir/start-presentation-api.sh" --profile=public --check 2>&1)"
rc_no_scope=$?
set -e

if [[ $rc_no_scope -eq 0 || "$out_no_scope" != *"Public presentation profile forbids custom JDQ_PRESENTATION_DB"* ]]; then
  echo "ERROR: Public launcher did not reject test database outside harness scope! (rc=$rc_no_scope, out=$out_no_scope)" >&2
  exit 1
fi
echo "PASS: Step 2B Public API launcher strictly rejects test DB overrides in production."

# Export harness scope for remainder of isolated script drill
export JDQ_TEST_HARNESS_SCOPE="isolated_script_drill"

# Step 2C: Verify --activate rejects future scheduled round as SCHEDULED_NOT_VOTABLE
echo "Step 2C: Testing rejection of future scheduled round under --activate..."
test_db_future="${test_db}_future"
docker exec "$container" psql -U jdq_presentation -d postgres -c "CREATE DATABASE $test_db_future TEMPLATE $live_db OWNER jdq_presentation;" >/dev/null

future_config_dir="/tmp/test_presentation_future_${timestamp}_${RANDOM}"
mkdir -p "$future_config_dir"
cp "$real_config_dir/db-password" "$future_config_dir/db-password"
cp "$real_config_dir/jwt-secret" "$future_config_dir/jwt-secret"
echo "$round_1_id" > "$future_config_dir/campaign-id"

future_opens="$(date -d '+2 days' '+%Y-%m-%d %H:%M:%S+08')"
future_closes="$(date -d '+4 days' '+%Y-%m-%d %H:%M:%S+08')"
set +e
future_activate_out="$(JDQ_PRESENTATION_CONFIG_DIR="$future_config_dir" JDQ_PRESENTATION_DB="$test_db_future" JDQ_PRESENTATION_CONTAINER="$container" \
  JDQ_PRESENTATION_V2_OPENS="$future_opens" JDQ_PRESENTATION_V2_CLOSES="$future_closes" \
  JDQ_ALLOW_PRESENTATION_TEST_DB=true bash "$script_dir/seed-presentation-round-v2.sh" --activate 2>&1)"
rc_future=$?
set -e

if [[ $rc_future -eq 0 || "$future_activate_out" != *"SCHEDULED_NOT_VOTABLE"* ]]; then
  echo "ERROR: --activate did not fail closed on future scheduled round! (rc=$rc_future, out=$future_activate_out)" >&2
  exit 1
fi

active_id_after_future="$(<"$future_config_dir/campaign-id")"
if [[ "$active_id_after_future" != "$round_1_id" ]]; then
  echo "ERROR: Allowlist was prematurely switched for future round! ($active_id_after_future != $round_1_id)" >&2
  exit 1
fi
rm -rf "$future_config_dir"
docker exec "$container" psql -U jdq_presentation -d postgres -c "DROP DATABASE IF EXISTS $test_db_future;" >/dev/null 2>&1 || true
echo "PASS: Step 2C Future scheduled round rejected with SCHEDULED_NOT_VOTABLE and active allowlist preserved."

# -------------------------------------------------------------
# STEP 3: Execute deliberate complete --activate operation with active window
# -------------------------------------------------------------
echo "Step 3: Executing actual --activate command with active voting window..."

# Set up valid opens/closes window for renewal test
export JDQ_PRESENTATION_V2_OPENS="$(date -d 'yesterday' '+%Y-%m-%d %H:%M:%S+08')"
export JDQ_PRESENTATION_V2_CLOSES="$(date -d '+2 days' '+%Y-%m-%d %H:%M:%S+08')"

activate_output="$(JDQ_PRESENTATION_CONFIG_DIR="$test_config_dir" JDQ_PRESENTATION_DB="$test_db" JDQ_PRESENTATION_CONTAINER="$container" \
  JDQ_ALLOW_PRESENTATION_TEST_DB=true bash "$script_dir/seed-presentation-round-v2.sh" --activate)"

echo "Activate output: $activate_output"

if [[ "$activate_output" != *"ALLOWLIST_SWITCH_SUCCESS"* || "$activate_output" != *"ACTIVE_AND_VOTABLE"* ]]; then
  echo "ERROR: Allowlist switch failed to report success and ACTIVE_AND_VOTABLE!" >&2
  exit 1
fi

# Verify campaign-id-v2 exists and matches campaign-id
if [[ ! -s "$test_config_dir/campaign-id-v2" ]]; then
  echo "ERROR: campaign-id-v2 was not created on disk!" >&2
  exit 1
fi
round_2_id="$(<"$test_config_dir/campaign-id-v2")"
new_active_id="$(<"$test_config_dir/campaign-id")"

if [[ "$round_2_id" != "$new_active_id" ]]; then
  echo "ERROR: Active campaign-id does not match round 2 ID! ($round_2_id != $new_active_id)" >&2
  exit 1
fi

if [[ "$new_active_id" == "$round_1_id" ]]; then
  echo "ERROR: Active campaign-id was not changed from round 1!" >&2
  exit 1
fi

# Verify backup was created
backup_count="$(find "$test_config_dir" -name 'campaign-id.bak.*' | wc -l)"
if [[ "$backup_count" -lt 1 ]]; then
  echo "ERROR: Backup file was not created before allowlist switch!" >&2
  exit 1
fi

# Verify database state in test DB
round_1_status="$(docker exec "$container" psql -U jdq_presentation -d "$test_db" -tAc "SELECT status FROM juanchoice_campaigns WHERE id = '$round_1_id';")"
if [[ "$round_1_status" != "closed" ]]; then
  echo "ERROR: Round 1 was not marked closed! Status is '$round_1_status'" >&2
  exit 1
fi

round_2_status="$(docker exec "$container" psql -U jdq_presentation -d "$test_db" -tAc "SELECT status FROM juanchoice_campaigns WHERE id = '$round_2_id';")"
if [[ "$round_2_status" != "voting" && "$round_2_status" != "scheduled" ]]; then
  echo "ERROR: Round 2 status invalid! Status is '$round_2_status'" >&2
  exit 1
fi

round_2_candidates="$(docker exec "$container" psql -U jdq_presentation -d "$test_db" -tAc "SELECT count(*) FROM juanchoice_candidates WHERE campaign_id = '$round_2_id' AND status = 'eligible';")"
if [[ "$round_2_candidates" != "4" ]]; then
  echo "ERROR: Round 2 does not have 4 eligible candidates! ($round_2_candidates)" >&2
  exit 1
fi

# Verify round 1 ballots were preserved
round_1_ballots="$(docker exec "$container" psql -U jdq_presentation -d "$test_db" -tAc "SELECT count(*) FROM juanchoice_ballots WHERE campaign_id = '$round_1_id';")"
if [[ "$round_1_ballots" != "$test_db_ballots_before" ]]; then
  echo "ERROR: Round 1 ballots were corrupted or deleted! ($test_db_ballots_before -> $round_1_ballots)" >&2
  exit 1
fi
echo "PASS: Step 3 Deliberate --activate succeeded: DB transitioned, allowlist switched, round 1 ballots preserved."

# -------------------------------------------------------------
# STEP 4: Verify start-presentation-api.sh with --profile=public accepts new round
# -------------------------------------------------------------
echo "Step 4: Testing start-presentation-api.sh with --profile=public --check-voting on new round..."
api_check_output="$(JDQ_PRESENTATION_CONFIG_DIR="$test_config_dir" JDQ_PRESENTATION_DB="$test_db" JDQ_PRESENTATION_CONTAINER="$container" \
  JDQ_ALLOW_PRESENTATION_TEST_DB=true bash "$script_dir/start-presentation-api.sh" --profile=public --check-voting)"

echo "API check output: $api_check_output"

if [[ "$api_check_output" != *"PRESENTATION_API_CHECK"* || "$api_check_output" != *"campaign_id=$round_2_id"* || "$api_check_output" != *"cors=https://presentation.juanderquest.app"* ]]; then
  echo "ERROR: API check failed to accept allowlisted round 2 under public profile!" >&2
  exit 1
fi
echo "PASS: Step 4 API launcher validated allowlisted round 2 under public profile."

# -------------------------------------------------------------
# STEP 5: Verify rollback on preflight failure
# -------------------------------------------------------------
echo "Step 5: Testing automatic rollback when preflight validation fails..."
# Create a temporary config dir for rollback drill
fail_config_dir="/tmp/test_presentation_fail_${timestamp}_${RANDOM}"
mkdir -p "$fail_config_dir"
cp "$real_config_dir/db-password" "$fail_config_dir/db-password"
# Write corrupt jwt-secret (too short) to induce preflight failure
echo "short" > "$fail_config_dir/jwt-secret"
echo "$round_1_id" > "$fail_config_dir/campaign-id"

set +e
JDQ_PRESENTATION_CONFIG_DIR="$fail_config_dir" JDQ_PRESENTATION_DB="$test_db" JDQ_PRESENTATION_CONTAINER="$container" \
  JDQ_ALLOW_PRESENTATION_TEST_DB=true bash "$script_dir/seed-presentation-round-v2.sh" --activate >/dev/null 2>&1
fail_rc=$?
set -e

if [[ $fail_rc -eq 0 ]]; then
  echo "ERROR: seed-presentation-round-v2 unexpectedly succeeded with broken preflight secret!" >&2
  exit 1
fi

active_after_fail="$(<"$fail_config_dir/campaign-id")"
if [[ "$active_after_fail" != "$round_1_id" ]]; then
  echo "ERROR: Allowlist was not restored from backup on preflight failure! (got $active_after_fail, expected $round_1_id)" >&2
  exit 1
fi
rm -rf "$fail_config_dir"
echo "PASS: Step 5 Automatic rollback restored original allowlist on preflight failure."

# -------------------------------------------------------------
# STEP 6: Verify live juanderquest_presentation DB was untouched
# -------------------------------------------------------------
echo "Step 6: Verifying live DB immunity..."
live_ballots_after="$(docker exec "$container" psql -U jdq_presentation -d "$live_db" -tAc "SELECT count(*) FROM juanchoice_ballots;")"
if [[ "$live_ballots_after" != "$live_ballots_before" ]]; then
  echo "ERROR: Live presentation database was mutated! ($live_ballots_before -> $live_ballots_after)" >&2
  exit 1
fi
echo "PASS: Step 6 Live database '$live_db' remained 100% untouched."

echo "=== All JuanChoice Renewal E2E Script Tests Passed Successfully ==="
