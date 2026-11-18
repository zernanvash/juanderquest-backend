-- Owner 2026-11-18: "build the give mjdq feature in dashboard (for beta testing, simulated points for now)
-- but still reflects as transactions so its on the blockchain".
-- A platform admin grants simulated mJDQ to a traveler. The grant moves through the normal points ledger
-- (issuance -> traveler) and is anchored on Polygon Amoy: one 0-value transaction from the server issuer
-- to itself whose data is the grant's fingerprint (no names, emails or reasons go on-chain).

CREATE TABLE IF NOT EXISTS admin_point_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  points INTEGER NOT NULL CHECK (points BETWEEN 1 AND 10000),
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 200),
  admin_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  ledger_group_id TEXT NOT NULL,
  balance_after INTEGER NOT NULL,
  anchor_hash TEXT NOT NULL UNIQUE CHECK (anchor_hash ~ '^0x[0-9a-f]{64}$'),
  chain_command_id TEXT NULL REFERENCES chain_commands(id) ON DELETE RESTRICT,
  is_test BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (admin_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS admin_point_grants_created_idx ON admin_point_grants (created_at DESC);
CREATE INDEX IF NOT EXISTS admin_point_grants_user_idx ON admin_point_grants (user_id, created_at DESC);

-- The anchor rides the existing chain outbox (same issuer key, one transaction in flight).
ALTER TABLE chain_commands DROP CONSTRAINT IF EXISTS chain_commands_operation_check;
ALTER TABLE chain_commands ADD CONSTRAINT chain_commands_operation_check
  CHECK (operation IN ('badge_claim', 'test_token_claim', 'points_anchor'));
