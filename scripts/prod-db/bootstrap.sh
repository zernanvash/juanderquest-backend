#!/usr/bin/env bash
# Plan 116 §4: create a JuanderQuest PostgreSQL cluster as code.
#
#   bootstrap.sh --profile rehearsal   # jdq-prod-rehearsal-pg  127.0.0.1:55461  db juanderquest_prod
#   bootstrap.sh --profile prod        # jdq-prod-postgres      127.0.0.1:55460  db juanderquest_prod  (owner OK first)
#   bootstrap.sh --profile test        # jdq-reliability-pg-116 127.0.0.1:55462  db jdq_reliability_test
#
# Run inside WSL. It never touches an existing container: it refuses if the
# container or volume already exists. Passwords are generated here and written
# only to ~/.jdq-secrets/<container>.env (mode 600); they are never printed.
#
# What it does: pinned PostGIS image, data checksums + builtin C.UTF-8 locale,
# tuned postgresql.prod.conf, no image init scripts (no tiger/topology), the
# extensions schema (postgis, pg_trgm, unaccent, pg_stat_statements), and the
# roles jdq_owner (migrations) / jdq_app (runtime DML) / jdq_readonly.
set -euo pipefail

IMAGE='postgis/postgis:17-3.5-alpine@sha256:894f570c0cf0664ed5576a8fd5d5bfb8fb1b19d592885b686c3a88c8bd90c41f'
PROFILE=''
MEMORY='2g'
while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --memory) MEMORY="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

case "$PROFILE" in
  rehearsal) CONTAINER=jdq-prod-rehearsal-pg; PORT=55461; DB=juanderquest_prod ;;
  prod)      CONTAINER=jdq-prod-postgres;     PORT=55460; DB=juanderquest_prod ;;
  test)      CONTAINER=jdq-reliability-pg-116; PORT=55462; DB=jdq_reliability_test ;;
  *) echo "usage: $0 --profile rehearsal|prod|test [--memory 2g]" >&2; exit 2 ;;
esac
VOLUME="${CONTAINER}-data"
HERE="$(cd "$(dirname "$0")" && pwd)"
STATE="$HOME/jdq-prod-db/$CONTAINER"
SECRETS_DIR="$HOME/.jdq-secrets"
SECRETS="$SECRETS_DIR/$CONTAINER.env"

if [ "$PROFILE" = prod ] && [ "${JDQ_OWNER_APPROVED_PROD_DB:-}" != yes ]; then
  echo "Refusing: creating the production cluster needs the owner's OK (set JDQ_OWNER_APPROVED_PROD_DB=yes)." >&2
  exit 1
fi

free_gb=$(df -BG --output=avail /mnt/g | tail -1 | tr -dc '0-9')
if [ "${free_gb:-0}" -lt 15 ]; then echo "Refusing: G: has ${free_gb} GB free (< 15 GB, INC-2 rule)." >&2; exit 1; fi

if docker container inspect "$CONTAINER" >/dev/null 2>&1; then echo "Refusing: container $CONTAINER already exists." >&2; exit 1; fi
if docker volume inspect "$VOLUME" >/dev/null 2>&1; then echo "Refusing: volume $VOLUME already exists." >&2; exit 1; fi
if [ -e "$SECRETS" ]; then echo "Refusing: $SECRETS already exists (stale secrets from an earlier cluster?)." >&2; exit 1; fi

gen() { head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32; }
SU_PW=$(gen); OWNER_PW=$(gen); APP_PW=$(gen); RO_PW=$(gen)

mkdir -p "$STATE/initdb" && chmod 700 "$STATE"
cp "$HERE/postgresql.prod.conf" "$STATE/jdq.conf"
mkdir -p "$SECRETS_DIR" && chmod 700 "$SECRETS_DIR"
umask 077
cat >"$SECRETS" <<EOF
# $CONTAINER ($PROFILE), created $(date -u +%FT%TZ) by bootstrap.sh. Never commit or print.
PG_CONTAINER=$CONTAINER
PG_PORT=$PORT
PG_DB=$DB
POSTGRES_SUPERUSER_PASSWORD=$SU_PW
JDQ_OWNER_URL=postgres://jdq_owner:$OWNER_PW@127.0.0.1:$PORT/$DB
JDQ_APP_URL=postgres://jdq_app:$APP_PW@127.0.0.1:$PORT/$DB
JDQ_READONLY_URL=postgres://jdq_readonly:$RO_PW@127.0.0.1:$PORT/$DB
EOF
if [ "$PROFILE" = test ]; then
  # Like the older reliability containers, tests connect as the container superuser:
  # the harness creates/drops schemas and economy-restricted-role-realpg creates roles.
  echo "JDQ_REAL_PG_URL=postgres://postgres:$SU_PW@127.0.0.1:$PORT/$DB" >>"$SECRETS"
fi

docker volume create "$VOLUME" >/dev/null
docker run -d --name "$CONTAINER" \
  --restart unless-stopped \
  --memory "$MEMORY" --shm-size 256m \
  -p "127.0.0.1:$PORT:5432" \
  -v "$VOLUME:/var/lib/postgresql/data" \
  -v "$STATE/jdq.conf:/etc/postgresql/jdq.conf:ro" \
  -v "$STATE/initdb:/docker-entrypoint-initdb.d:ro" \
  -e POSTGRES_PASSWORD="$SU_PW" \
  -e POSTGRES_INITDB_ARGS="--data-checksums --encoding=UTF8 --locale-provider=builtin --builtin-locale=C.UTF-8" \
  "$IMAGE" -c config_file=/etc/postgresql/jdq.conf >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1; then break; fi
  sleep 1
done
# The entrypoint restarts postgres once after initdb; wait for the final server.
sleep 3
docker exec "$CONTAINER" pg_isready -U postgres -h 127.0.0.1 >/dev/null

psql_su() { docker exec -i -e PGPASSWORD="$SU_PW" "$CONTAINER" psql -v ON_ERROR_STOP=1 -q -U postgres -h 127.0.0.1 "$@"; }

psql_su -d postgres <<SQL
CREATE ROLE jdq_owner LOGIN PASSWORD '$OWNER_PW';
CREATE ROLE jdq_app LOGIN PASSWORD '$APP_PW';
CREATE ROLE jdq_readonly LOGIN PASSWORD '$RO_PW';
ALTER ROLE jdq_owner SET lock_timeout = '10s';
ALTER ROLE jdq_app SET statement_timeout = '10s';
ALTER ROLE jdq_app SET lock_timeout = '5s';
ALTER ROLE jdq_app SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE jdq_readonly SET default_transaction_read_only = on;
ALTER ROLE jdq_readonly SET statement_timeout = '30s';
CREATE DATABASE $DB OWNER jdq_owner;
REVOKE ALL ON DATABASE $DB FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE $DB TO jdq_owner, jdq_app, jdq_readonly;
SQL

psql_su -d "$DB" <<SQL
-- Extensions live in their own schema so per-test schemas (search_path=<test>,extensions)
-- and production share one install. Migrations only check that they exist.
-- Owned by jdq_owner: a -Fc dump sets the owner right after CREATE SCHEMA, so a plain
-- pg_restore can build the f_unaccent/trigram indexes (PG17 builds them as the table owner)
-- before the GRANTs at the end of the restore.
CREATE SCHEMA extensions AUTHORIZATION jdq_owner;
GRANT USAGE ON SCHEMA extensions TO PUBLIC;
CREATE EXTENSION postgis SCHEMA extensions;
CREATE EXTENSION pg_trgm SCHEMA extensions;
CREATE EXTENSION unaccent SCHEMA extensions;
CREATE EXTENSION pg_stat_statements SCHEMA extensions;
ALTER DATABASE $DB SET search_path = "\$user", public, extensions;

ALTER SCHEMA public OWNER TO jdq_owner;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO jdq_app, jdq_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE jdq_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO jdq_app;
ALTER DEFAULT PRIVILEGES FOR ROLE jdq_owner IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO jdq_app;
ALTER DEFAULT PRIVILEGES FOR ROLE jdq_owner IN SCHEMA public
  GRANT SELECT ON TABLES TO jdq_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE jdq_owner IN SCHEMA public
  GRANT SELECT ON SEQUENCES TO jdq_readonly;
GRANT pg_read_all_stats TO jdq_readonly;
SQL

if [ "$PROFILE" = test ]; then
  # Per-test schemas are created by the harness as the database owner.
  psql_su -d "$DB" -c "GRANT CREATE ON DATABASE $DB TO jdq_owner;"
fi

psql_su -d "$DB" -tA <<'SQL'
SELECT 'server=' || current_setting('server_version') || ' checksums=' || current_setting('data_checksums')
  || ' collation=' || (SELECT datlocprovider::text || ':' || coalesce(datlocale, datcollate) FROM pg_database WHERE datname = current_database())
  || ' shared_buffers=' || current_setting('shared_buffers') || ' jit=' || current_setting('jit');
SELECT 'extensions=' || string_agg(extname || '@' || extversion || '(' || extnamespace::regnamespace || ')', ', ' ORDER BY extname) FROM pg_extension;
SQL
echo "[bootstrap] $CONTAINER ready on 127.0.0.1:$PORT (db $DB). Credentials: $SECRETS"
