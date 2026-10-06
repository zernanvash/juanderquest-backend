#!/usr/bin/env bash
set -euo pipefail

mode="--check"
profile=""
profile_explicit=false

for arg in "$@"; do
  case "$arg" in
    --check|--migrate|--start|--check-voting|--start-voting)
      mode="$arg"
      ;;
    --profile=public|--public)
      profile="public"
      profile_explicit=true
      ;;
    --profile=local|--local)
      profile="local"
      profile_explicit=true
      ;;
    *)
      echo "Usage: start-presentation-api.sh [--check|--migrate|--start|--check-voting|--start-voting] --profile=local|public" >&2
      exit 2
      ;;
  esac
done

if [[ "$profile_explicit" != "true" ]]; then
  echo "ERROR: Explicit presentation profile is required on command line. Pass --profile=public or --profile=local." >&2
  exit 2
fi

if [[ "$profile" != "public" && "$profile" != "local" ]]; then
  echo "ERROR: Invalid presentation profile: '$profile'. Must be 'public' or 'local'." >&2
  exit 2
fi

container="${JDQ_PRESENTATION_CONTAINER:-jdq-presentation-postgres}"
database="${JDQ_PRESENTATION_DB:-juanderquest_presentation}"
secret_dir="${JDQ_PRESENTATION_CONFIG_DIR:-$HOME/.config/juanderquest-presentation}"
port="${PORT:-4200}"
db_port="${JDQ_PRESENTATION_DB_PORT:-55434}"
script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$script_dir/.."

if [[ "$profile" == "public" && "${JDQ_TEST_HARNESS_SCOPE:-}" != "isolated_script_drill" ]]; then
  if [[ -n "${JDQ_PRESENTATION_DB:-}" && "$database" != "juanderquest_presentation" ]]; then
    echo "ERROR: Public presentation profile forbids custom JDQ_PRESENTATION_DB ('$database'). Must use canonical 'juanderquest_presentation'." >&2
    exit 1
  fi
  if [[ -n "${JDQ_PRESENTATION_CONTAINER:-}" && "$container" != "jdq-presentation-postgres" ]]; then
    echo "ERROR: Public presentation profile forbids custom JDQ_PRESENTATION_CONTAINER ('$container'). Must use canonical 'jdq-presentation-postgres'." >&2
    exit 1
  fi
  if [[ -n "${JDQ_PRESENTATION_CONFIG_DIR:-}" && "$secret_dir" != "$HOME/.config/juanderquest-presentation" ]]; then
    echo "ERROR: Public presentation profile forbids custom JDQ_PRESENTATION_CONFIG_DIR ('$secret_dir'). Must use canonical '$HOME/.config/juanderquest-presentation'." >&2
    exit 1
  fi
  if [[ -n "${PORT:-}" && "$port" != "4200" ]]; then
    echo "ERROR: Public presentation profile forbids custom PORT ('$port'). Must use canonical '4200'." >&2
    exit 1
  fi
  if [[ -n "${JDQ_PRESENTATION_DB_PORT:-}" && "$db_port" != "55434" ]]; then
    echo "ERROR: Public presentation profile forbids custom JDQ_PRESENTATION_DB_PORT ('$db_port'). Must use canonical '55434'." >&2
    exit 1
  fi
  if [[ "${JDQ_ALLOW_PRESENTATION_TEST_DB:-}" == "true" ]]; then
    echo "ERROR: Public presentation profile forbids JDQ_ALLOW_PRESENTATION_TEST_DB=true outside isolated test harness." >&2
    exit 1
  fi
fi

if [[ -L "$secret_dir" ]]; then
  echo 'Presentation secret directory must not be a symlink.' >&2
  exit 1
fi
for secret_name in db-password jwt-secret campaign-id; do
  if [[ ! -s "$secret_dir/$secret_name" ]]; then
    echo "Missing private presentation secret: $secret_name in $secret_dir" >&2
    exit 1
  fi
done
db_password="$(<"$secret_dir/db-password")"
jwt_secret="$(<"$secret_dir/jwt-secret")"
campaign_id="$(<"$secret_dir/campaign-id")"
if [[ ! "$db_password" =~ ^[a-f0-9]{64}$ || ${#jwt_secret} -lt 64 || ! "$campaign_id" =~ ^[a-f0-9-]{36}$ ]]; then
  echo 'Presentation secret format is invalid.' >&2
  exit 1
fi
if ! docker container inspect "$container" >/dev/null 2>&1; then
  echo "Dedicated presentation container '$container' does not exist." >&2
  exit 1
fi
if [[ "$(docker inspect -f '{{.State.Running}}' "$container")" != true ]]; then
  echo "Dedicated presentation container '$container' is not running." >&2
  exit 1
fi
published="$(docker inspect -f '{{json .NetworkSettings.Ports}}' "$container")"
if [[ "$published" != *'"HostIp":"127.0.0.1","HostPort":"'"$db_port"'"'* ]]; then
  echo "Dedicated presentation database is not bound to 127.0.0.1:$db_port." >&2
  exit 1
fi
actual_db="$(docker exec "$container" psql -U jdq_presentation -d "$database" -tAc 'SELECT current_database()')"
if [[ "$actual_db" != "$database" ]]; then
  echo "Connected database identity is not $database (got $actual_db)." >&2
  exit 1
fi

export NODE_ENV=production
export PORT="$port" HOST=127.0.0.1
export DATABASE_URL="postgres://jdq_presentation:${db_password}@127.0.0.1:${db_port}/${database}"
export JWT_SECRET="$jwt_secret"
export JDQ_PRESENTATION_PROFILE="$profile"
if [[ "$profile" == "public" ]]; then
  export CORS_ORIGIN='https://presentation.juanderquest.app'
elif [[ "$profile" == "local" ]]; then
  export CORS_ORIGIN='http://127.0.0.1:3200'
fi
export ALLOW_IN_MEMORY_FALLBACK=false SEED_DEVELOPMENT_DATA=false
export WALLET_AUTH_MODE=signature ALLOW_INSECURE_LOCAL_WALLET_AUTH=false
export ALLOW_DEMO_LOGIN=false GUEST_LOGIN_ENABLED=true
export MARKETPLACE_ENABLED=false ALPHA_WALLET_SIMULATION_ENABLED=true
export JUANCHOICE_ENABLED=true JUANCHOICE_PRESENTATION_MODE=true
export JUANCHOICE_PRESENTATION_CAMPAIGN_ID="$campaign_id"
export JUANCHOICE_PRESENTATION_DB_NAME="$database"
export JUANCHOICE_WRITES_ENABLED=false JUANCHOICE_BATCH_WRITES_ENABLED=false
export JUANCHOICE_PROMOTION_ENABLED=false JUANCHOICE_ECONOMY_ENABLED=false
export JUANCHOICE_FINALIZER_WORKER_ENABLED=false JUANCHOICE_SCHEDULER_ENABLED=false
export PROGRESSION_ENABLED=true PROGRESSION_EMIT_OUTBOX_ENABLED=true
export PROGRESSION_OUTBOX_WORKER_ENABLED=false

if [[ "$mode" == --migrate ]]; then
  if [[ ! -f dist/db/pool.js ]]; then
    echo 'Backend build is missing; run npm run build first.' >&2
    exit 1
  fi
  node -e 'require("./dist/db/pool.js").initPostgres().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1) })'
  echo 'PRESENTATION_DB_MIGRATED. Verify with --check before startup.'
  exit 0
fi

if ! docker exec "$container" psql -U jdq_presentation -d "$database" -tAc "SELECT 1 FROM information_schema.tables WHERE table_name = 'schema_migrations'" | grep -qx 1; then
  echo 'Presentation schema migrations are not installed; use --migrate.' >&2
  exit 1
fi
actual_migrations="$(docker exec "$container" psql -U jdq_presentation -d "$database" -tAc 'SELECT filename FROM schema_migrations ORDER BY filename')"
expected_migrations="$(find migrations -maxdepth 1 -type f -name '[0-9][0-9][0-9]_*.sql' -printf '%f\n' | sort)"
if [[ "$actual_migrations" != "$expected_migrations" ]]; then
  echo 'Presentation migration ledger differs from the current backend migrations.' >&2
  exit 1
fi
if [[ "$mode" == --check-voting || "$mode" == --start-voting ]]; then
  eligible_campaigns="$(docker exec "$container" psql -U jdq_presentation -d "$database" -tAc \
    "SELECT COUNT(*) FROM juanchoice_campaigns c WHERE c.id='$campaign_id'
       AND c.status IN ('scheduled','voting') AND c.is_test=FALSE
       AND c.opens_at <= clock_timestamp() AND c.closes_at > clock_timestamp()
       AND c.series_key IS NULL AND c.round_number IS NULL AND c.counts_for_streak=FALSE
       AND NOT EXISTS (SELECT 1 FROM juanchoice_schedule_periods WHERE campaign_id=c.id)
       AND (SELECT COUNT(*) FROM juanchoice_candidates n JOIN spots s ON s.id=n.spot_id
            WHERE n.campaign_id=c.id AND n.status='eligible' AND n.is_test=FALSE
              AND s.is_test=FALSE AND s.status='published' AND s.recommendation_suppressed=FALSE)=4")"
  if [[ "$eligible_campaigns" != 1 ]]; then
    echo 'Presentation voting preflight failed: allowlisted open round and four safe candidates required.' >&2
    exit 1
  fi
  if [[ "$mode" == --start-voting && "${JDQ_PRESENTATION_VOTING_ACK:-}" != 'I_UNDERSTAND_DEMO_ONLY' ]]; then
    echo 'Explicit JDQ_PRESENTATION_VOTING_ACK=I_UNDERSTAND_DEMO_ONLY is required.' >&2
    exit 1
  fi
fi
if [[ "$mode" == --start-voting ]]; then
  export JUANCHOICE_WRITES_ENABLED=true
fi
echo "PRESENTATION_API_CHECK db=$database profile=$profile migrations=$(printf '%s\n' "$actual_migrations" | wc -l) host=127.0.0.1 port=$port writes=$JUANCHOICE_WRITES_ENABLED cors=$CORS_ORIGIN campaign_id=$campaign_id cookie_secure=$([[ "$profile" == "public" ]] && echo true || echo false)"
if [[ "$mode" == --check ]]; then exit 0; fi
if [[ "$mode" == --check-voting ]]; then exit 0; fi
if [[ ! -f dist/server.js ]]; then
  echo 'Backend build is missing; run npm run build first.' >&2
  exit 1
fi
if command -v ss >/dev/null && ss -ltn "( sport = :$port )" | grep -q ":$port"; then
  echo "Port $port is already listening; identify the owner before starting." >&2
  exit 1
fi
exec node dist/server.js
