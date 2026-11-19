# Production database v2 (Plan 116)

Cluster as code for the national-launch PostgreSQL. Everything here runs inside WSL.

| File | Purpose |
|---|---|
| `bootstrap.sh --profile rehearsal\|prod\|test` | Creates a new cluster: pinned `postgis/postgis:17-3.5-alpine` digest, data checksums, builtin `C.UTF-8` collation, `postgresql.prod.conf`, no image init scripts, `extensions` schema (postgis, pg_trgm, unaccent, pg_stat_statements), roles `jdq_owner` / `jdq_app` / `jdq_readonly`. Refuses if the container, volume or secrets file exists. `prod` also needs `JDQ_OWNER_APPROVED_PROD_DB=yes`. |
| `postgresql.prod.conf` | Settings for a 2 GB container (scale `shared_buffers` 25%, `effective_cache_size` ~70% if the limit changes). |
| `migrate.ts` | Owner-only migration command: `JDQ_MIGRATE_URL=<jdq_owner url> npx tsx scripts/prod-db/migrate.ts`. Applies + verifies migrations and checks that `jdq_app`/`jdq_readonly` have grants on every table. |
| `create-workdb.sh jdq_r_<name>` | Extra isolated database on the **rehearsal** cluster (same shape), for parallel import work. |
| `run-realpg.sh [tests/x.test.ts]` | Jest against the PostGIS test cluster `jdq-reliability-pg-116`. |

| Profile | Container | Port | Database |
|---|---|---|---|
| prod | `jdq-prod-postgres` | 127.0.0.1:55460 | `juanderquest_prod` |
| rehearsal | `jdq-prod-rehearsal-pg` | 127.0.0.1:55461 | `juanderquest_prod` (+ `jdq_r_*` work DBs) |
| test | `jdq-reliability-pg-116` | 127.0.0.1:55462 | `jdq_reliability_test` |

Credentials are written only to `~/.jdq-secrets/<container>.env` (mode 600). Never print or commit them.

## Roles
- `jdq_owner`: owns `public` and every object; used only for migrations.
- `jdq_app`: backend runtime (`DB_MIGRATION_MODE=verify`), DML only; `statement_timeout=10s`, `lock_timeout=5s`, `idle_in_transaction_session_timeout=60s`.
- `jdq_readonly`: `default_transaction_read_only=on`, `statement_timeout=30s` (beta pulse, analytics, checks).
- `postgres`: superuser for bootstrap/ops only.

## Extensions and search_path
Extensions are installed once per database in the `extensions` schema and the database
`search_path` is `"$user", public, extensions`. Migration 110 does not create extensions;
it stops with a clear error if they are missing. Any other PostgreSQL used with this
backend (agent test containers, CI, previews) needs the same: a PostGIS image and
`CREATE EXTENSION postgis, pg_trgm, unaccent` (any schema on the search_path) before migrating.
The Jest harness uses `search_path=<test schema>,extensions`.

## Backups (Plan 116 §4.4)
Nightly `pg_dump -Fc` as `jdq_owner`, restore drill before cutover and monthly.
`archive_mode` is already on with a no-op command; WAL archiving to the off-site target
(decision D9) only needs `archive_command` + a reload.
