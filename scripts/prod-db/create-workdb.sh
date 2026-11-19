#!/usr/bin/env bash
# Plan 116: create an isolated work database on the REHEARSAL cluster only
# (jdq-prod-rehearsal-pg), shaped like the real one: owned by jdq_owner, with the
# extensions schema on its search_path, then migrated with the checked-in migrations.
#   scripts/prod-db/create-workdb.sh jdq_r_areas
# Prints nothing secret; connection URLs are appended to ~/.jdq-secrets/workdb-<name>.env.
set -euo pipefail
NAME="${1:-}"
[[ "$NAME" =~ ^jdq_r_[a-z0-9_]{2,30}$ ]] || { echo 'usage: create-workdb.sh jdq_r_<name>' >&2; exit 2; }
CONTAINER=jdq-prod-rehearsal-pg
SECRETS="$HOME/.jdq-secrets/$CONTAINER.env"
# shellcheck disable=SC1090
. "$SECRETS"
[ "$PG_CONTAINER" = "$CONTAINER" ] || { echo 'not the rehearsal cluster' >&2; exit 1; }
psql_su() { docker exec -i -e PGPASSWORD="$POSTGRES_SUPERUSER_PASSWORD" "$CONTAINER" psql -v ON_ERROR_STOP=1 -q -U postgres -h 127.0.0.1 "$@"; }
if psql_su -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$NAME'" | grep -q 1; then
  echo "$NAME already exists" >&2; exit 1
fi
psql_su -d postgres <<SQL
CREATE DATABASE $NAME OWNER jdq_owner;
REVOKE ALL ON DATABASE $NAME FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE $NAME TO jdq_owner, jdq_app, jdq_readonly;
SQL
psql_su -d "$NAME" <<SQL
CREATE SCHEMA extensions;
GRANT USAGE ON SCHEMA extensions TO PUBLIC;
CREATE EXTENSION postgis SCHEMA extensions;
CREATE EXTENSION pg_trgm SCHEMA extensions;
CREATE EXTENSION unaccent SCHEMA extensions;
ALTER DATABASE $NAME SET search_path = "\$user", public, extensions;
ALTER SCHEMA public OWNER TO jdq_owner;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO jdq_app, jdq_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE jdq_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO jdq_app;
ALTER DEFAULT PRIVILEGES FOR ROLE jdq_owner IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO jdq_app;
ALTER DEFAULT PRIVILEGES FOR ROLE jdq_owner IN SCHEMA public GRANT SELECT ON TABLES TO jdq_readonly;
SQL
OUT="$HOME/.jdq-secrets/workdb-$NAME.env"
umask 077
{
  echo "WORKDB_OWNER_URL=${JDQ_OWNER_URL%/*}/$NAME"
  echo "WORKDB_APP_URL=${JDQ_APP_URL%/*}/$NAME"
  echo "WORKDB_READONLY_URL=${JDQ_READONLY_URL%/*}/$NAME"
} >"$OUT"
echo "[workdb] $NAME created on $CONTAINER; URLs in $OUT"
