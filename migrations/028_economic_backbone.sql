-- Isolated off-chain economic pilot. No legacy balance conversion, public token,
-- merchant liability, or automatic quest reward is enabled by this migration.
CREATE TABLE economic_assets (
  code TEXT PRIMARY KEY,
  scale INTEGER NOT NULL CHECK (scale BETWEEN 0 AND 18),
  environment TEXT NOT NULL CHECK (environment IN ('simulation', 'live')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO economic_assets (code, scale, environment)
VALUES ('EXPLORER_COIN_SIM', 0, 'simulation');

CREATE TABLE economic_accounts (
  id TEXT PRIMARY KEY,
  asset_code TEXT NOT NULL REFERENCES economic_assets(code) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('issuance', 'traveler', 'retired', 'treasury')),
  user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  balance_minor BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, asset_code),
  CHECK ((kind = 'traveler' AND user_id IS NOT NULL) OR (kind <> 'traveler' AND user_id IS NULL)),
  CHECK (kind = 'issuance' OR balance_minor >= 0)
);

CREATE UNIQUE INDEX economic_traveler_account_unique
  ON economic_accounts(asset_code, user_id) WHERE kind = 'traveler';
CREATE INDEX economic_accounts_user_idx ON economic_accounts(user_id);

INSERT INTO economic_accounts(id, asset_code, kind)
VALUES ('sim:issuance', 'EXPLORER_COIN_SIM', 'issuance'),
       ('sim:retired', 'EXPLORER_COIN_SIM', 'retired'),
       ('sim:treasury', 'EXPLORER_COIN_SIM', 'treasury');

CREATE TABLE economic_transactions (
  id TEXT PRIMARY KEY,
  asset_code TEXT NOT NULL REFERENCES economic_assets(code) ON DELETE RESTRICT,
  business_event TEXT NOT NULL UNIQUE,
  operation TEXT NOT NULL CHECK (operation IN ('reward', 'spend', 'refund', 'transfer')),
  actor_id TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, asset_code)
);

-- A transfer row is a balanced pair by construction. The asset-matched FKs
-- prevent cross-asset movement; there are no freely signed posting rows.
CREATE TABLE economic_transfers (
  transaction_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  asset_code TEXT NOT NULL,
  from_account_id TEXT NOT NULL,
  to_account_id TEXT NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  PRIMARY KEY (transaction_id, sequence),
  FOREIGN KEY (transaction_id, asset_code) REFERENCES economic_transactions(id, asset_code) ON DELETE RESTRICT,
  FOREIGN KEY (from_account_id, asset_code) REFERENCES economic_accounts(id, asset_code) ON DELETE RESTRICT,
  FOREIGN KEY (to_account_id, asset_code) REFERENCES economic_accounts(id, asset_code) ON DELETE RESTRICT,
  CHECK (from_account_id <> to_account_id)
);
CREATE INDEX economic_transfers_from_idx ON economic_transfers(from_account_id);
CREATE INDEX economic_transfers_to_idx ON economic_transfers(to_account_id);

CREATE TABLE economic_commands (
  actor_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  transaction_id TEXT REFERENCES economic_transactions(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_id, operation, idempotency_key)
);

CREATE TABLE reward_pools (
  id TEXT PRIMARY KEY,
  quest_id TEXT NOT NULL REFERENCES quests(id) ON DELETE RESTRICT,
  asset_code TEXT NOT NULL REFERENCES economic_assets(code) ON DELETE RESTRICT,
  scope_key TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  reward_minor BIGINT NOT NULL CHECK (reward_minor > 0),
  reservation_seconds INTEGER NOT NULL CHECK (reservation_seconds BETWEEN 300 AND 604800),
  appeal_seconds INTEGER NOT NULL CHECK (appeal_seconds BETWEEN 0 AND 2592000),
  allocated_minor BIGINT NOT NULL CHECK (allocated_minor >= 0),
  available_minor BIGINT NOT NULL CHECK (available_minor >= 0),
  reserved_minor BIGINT NOT NULL DEFAULT 0 CHECK (reserved_minor >= 0),
  paid_minor BIGINT NOT NULL DEFAULT 0 CHECK (paid_minor >= 0),
  returned_minor BIGINT NOT NULL DEFAULT 0 CHECK (returned_minor >= 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (quest_id, scope_key, policy_version),
  CHECK (allocated_minor = available_minor + reserved_minor + paid_minor + returned_minor)
);
CREATE INDEX reward_pools_quest_idx ON reward_pools(quest_id, status);
CREATE UNIQUE INDEX reward_pools_one_active_quest_idx
  ON reward_pools(quest_id) WHERE status = 'active';

CREATE TABLE reward_reservations (
  id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL REFERENCES reward_pools(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  scope_key TEXT NOT NULL,
  quest_version INTEGER NOT NULL CHECK (quest_version > 0),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'submitted', 'appeal', 'paid', 'released')),
  submission_id TEXT REFERENCES submissions(id) ON DELETE RESTRICT,
  expires_at TIMESTAMPTZ NOT NULL,
  appeal_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (status NOT IN ('submitted', 'appeal') OR submission_id IS NOT NULL)
);
CREATE UNIQUE INDEX reward_reservation_active_scope_idx
  ON reward_reservations(user_id, scope_key)
  WHERE status IN ('reserved', 'submitted', 'appeal');
CREATE UNIQUE INDEX reward_reservation_submission_idx
  ON reward_reservations(submission_id) WHERE submission_id IS NOT NULL;
CREATE INDEX reward_reservations_expiry_idx
  ON reward_reservations(expires_at) WHERE status = 'reserved';

CREATE TABLE reward_awards (
  id TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL UNIQUE REFERENCES reward_reservations(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  scope_key TEXT NOT NULL,
  transaction_id TEXT NOT NULL UNIQUE REFERENCES economic_transactions(id) ON DELETE RESTRICT,
  awarded_minor BIGINT NOT NULL CHECK (awarded_minor > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, scope_key)
);
CREATE INDEX reward_awards_user_idx ON reward_awards(user_id, created_at);

CREATE TABLE economic_outbox (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL UNIQUE REFERENCES economic_transactions(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE economic_cosmetics (
  id TEXT PRIMARY KEY,
  asset_code TEXT NOT NULL REFERENCES economic_assets(code) ON DELETE RESTRICT,
  cost_minor BIGINT NOT NULL CHECK (cost_minor > 0),
  active BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE economic_entitlements (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  cosmetic_id TEXT NOT NULL REFERENCES economic_cosmetics(id) ON DELETE RESTRICT,
  transaction_id TEXT NOT NULL UNIQUE REFERENCES economic_transactions(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, cosmetic_id)
);
CREATE INDEX economic_entitlements_user_idx ON economic_entitlements(user_id);

-- Dormant Base Sepolia projection. Chain state is never inferred from a queued
-- command; canonical receipts/events are recorded separately after indexing.
CREATE TABLE chain_commands (
  id TEXT PRIMARY KEY,
  chain_id BIGINT NOT NULL CHECK (chain_id = 84532),
  entitlement_id TEXT NOT NULL UNIQUE,
  operation TEXT NOT NULL CHECK (operation IN ('badge_claim', 'test_token_claim')),
  recipient_address TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'submitted', 'included', 'finalized', 'reverted', 'replaced', 'unknown')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE chain_transaction_attempts (
  id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL REFERENCES chain_commands(id) ON DELETE RESTRICT,
  chain_id BIGINT NOT NULL CHECK (chain_id = 84532),
  tx_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('submitted', 'included', 'reverted', 'replaced', 'unknown')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chain_id, tx_hash)
);
CREATE INDEX chain_transaction_attempts_command_idx ON chain_transaction_attempts(command_id);

CREATE TABLE chain_events (
  id TEXT PRIMARY KEY,
  chain_id BIGINT NOT NULL CHECK (chain_id = 84532),
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL CHECK (log_index >= 0),
  block_number BIGINT NOT NULL CHECK (block_number >= 0),
  block_hash TEXT NOT NULL,
  event_name TEXT NOT NULL,
  payload JSONB NOT NULL,
  canonical BOOLEAN NOT NULL DEFAULT false,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chain_id, block_hash, tx_hash, log_index)
);
CREATE UNIQUE INDEX chain_events_one_canonical_log_idx
  ON chain_events(chain_id, tx_hash, log_index) WHERE canonical = true;
CREATE INDEX chain_events_block_idx ON chain_events(chain_id, block_number);

CREATE TABLE chain_checkpoints (
  chain_id BIGINT PRIMARY KEY CHECK (chain_id = 84532),
  block_number BIGINT NOT NULL CHECK (block_number >= 0),
  block_hash TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
