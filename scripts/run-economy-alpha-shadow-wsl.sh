#!/usr/bin/env bash
set -euo pipefail

# Bounded, aggregate-only read of the existing local alpha PostgreSQL container.
# Never runs migrations, imports balances or exposes account identifiers.
samples="${1:-2}"
interval_seconds="${2:-3}"
if [[ ! "$samples" =~ ^[1-9][0-9]*$ ]] || (( samples > 12 )) ||
   [[ ! "$interval_seconds" =~ ^[1-9][0-9]*$ ]] || (( interval_seconds > 3600 )); then
  echo 'Usage: run-economy-alpha-shadow-wsl.sh [samples:1-12] [interval_seconds:1-3600]' >&2
  exit 2
fi

container='jdq-alpha-postgres'
database='juanderquest_alpha'
database_user='jdq_alpha'
if [[ "$(docker inspect --format '{{.State.Running}}' "$container")" != 'true' ]]; then
  echo 'ALPHA_CONTAINER_NOT_RUNNING' >&2
  exit 1
fi
identity="$(docker exec "$container" psql -X -qAt -v ON_ERROR_STOP=1 \
  -U "$database_user" -d "$database" -c 'SELECT current_database()')"
if [[ "$identity" != "$database" ]]; then
  echo 'ALPHA_DATABASE_IDENTITY_MISMATCH' >&2
  exit 1
fi

sql=$(cat <<'SQL'
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
WITH snapshot AS (
  SELECT data FROM governance_snapshot WHERE id = 1
), legacy_rows AS (
  SELECT u.id, u.demo_points, s.data -> 'balances' ->> u.id AS snapshot_mjdq
  FROM users u CROSS JOIN snapshot s
), legacy_counts AS (
  SELECT count(*) AS users,
    count(*) FILTER (WHERE snapshot_mjdq IS NULL) AS missing,
    count(*) FILTER (WHERE snapshot_mjdq IS NOT NULL AND
      snapshot_mjdq::numeric = demo_points::numeric * 1000) AS exact,
    count(*) FILTER (WHERE snapshot_mjdq IS NOT NULL AND
      snapshot_mjdq::numeric <> demo_points::numeric * 1000) AS mismatch
  FROM legacy_rows
), group_rows AS (
  SELECT transaction_group_id, sum(amount_mjdq::numeric) AS net
  FROM governance_ledger GROUP BY transaction_group_id
), group_counts AS (
  SELECT count(*) FILTER (WHERE net <> 0) AS unbalanced_groups,
    coalesce(sum(net) FILTER (WHERE net <> 0), 0) AS unbalanced_net
  FROM group_rows
), pilot_rows AS (
  SELECT a.id, a.balance_minor::numeric AS stored,
    coalesce((SELECT sum(t.amount_minor::numeric) FROM economic_transfers t
      WHERE t.to_account_id = a.id), 0) -
    coalesce((SELECT sum(t.amount_minor::numeric) FROM economic_transfers t
      WHERE t.from_account_id = a.id), 0) AS reconstructed
  FROM economic_accounts a WHERE a.asset_code = 'EXPLORER_COIN_SIM'
), canonical AS (
  SELECT jsonb_build_array(
    (SELECT jsonb_agg(jsonb_build_array(id,demo_points,snapshot_mjdq) ORDER BY id)
     FROM legacy_rows),
    (SELECT jsonb_agg(jsonb_build_array(transaction_group_id,net)
      ORDER BY transaction_group_id) FROM group_rows),
    (SELECT jsonb_agg(jsonb_build_array(id,stored,reconstructed) ORDER BY id)
     FROM pilot_rows)
  ) AS data
)
SELECT json_build_object(
  'database', current_database(),
  'migrations', (SELECT count(*) FROM schema_migrations),
  'users', (SELECT users FROM legacy_counts),
  'exact', (SELECT exact FROM legacy_counts),
  'missing', (SELECT missing FROM legacy_counts),
  'mismatch', (SELECT mismatch FROM legacy_counts),
  'unbalanced_groups', (SELECT unbalanced_groups FROM group_counts),
  'unbalanced_net_mjdq', (SELECT unbalanced_net FROM group_counts),
  'pilot_drift', (SELECT count(*) FROM pilot_rows WHERE stored <> reconstructed),
  'canonical_sha256', (SELECT encode(sha256(convert_to(data::text, 'UTF8')), 'hex')
    FROM canonical),
  'cutover_eligible', false
);
COMMIT;
SQL
)

for (( sample=1; sample<=samples; sample++ )); do
  report="$(docker exec "$container" psql -X -qAt -v ON_ERROR_STOP=1 \
    -U "$database_user" -d "$database" -c "$sql")"
  printf 'SHADOW_SAMPLE %d %s\n' "$sample" "$report"
  if (( sample < samples )); then sleep "$interval_seconds"; fi
done
