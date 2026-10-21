-- 060_polygon_amoy_chain_registry.sql
-- Plan 49 Phase 1: Widen chain_id CHECKs to allow Polygon Amoy (80002) alongside Base Sepolia (84532),
-- register 'chain_alert' notification kind, and create chain_contracts, chain_wallets, chain_wallet_audit.

-- 1. Allow Amoy alongside Base Sepolia history (additive).
ALTER TABLE chain_commands DROP CONSTRAINT IF EXISTS chain_commands_chain_id_check;
ALTER TABLE chain_commands ADD CONSTRAINT chain_commands_chain_id_check CHECK (chain_id IN (84532, 80002));

ALTER TABLE chain_transaction_attempts DROP CONSTRAINT IF EXISTS chain_transaction_attempts_chain_id_check;
ALTER TABLE chain_transaction_attempts ADD CONSTRAINT chain_transaction_attempts_chain_id_check CHECK (chain_id IN (84532, 80002));

ALTER TABLE chain_events DROP CONSTRAINT IF EXISTS chain_events_chain_id_check;
ALTER TABLE chain_events ADD CONSTRAINT chain_events_chain_id_check CHECK (chain_id IN (84532, 80002));

ALTER TABLE chain_checkpoints DROP CONSTRAINT IF EXISTS chain_checkpoints_chain_id_check;
ALTER TABLE chain_checkpoints ADD CONSTRAINT chain_checkpoints_chain_id_check CHECK (chain_id IN (84532, 80002));

ALTER TABLE chain_block_headers DROP CONSTRAINT IF EXISTS chain_block_headers_chain_id_check;
ALTER TABLE chain_block_headers ADD CONSTRAINT chain_block_headers_chain_id_check CHECK (chain_id IN (84532, 80002));

-- 2. Notification kind for chain alerts.
ALTER TABLE user_notifications DROP CONSTRAINT IF EXISTS user_notifications_kind_check;
ALTER TABLE user_notifications ADD CONSTRAINT user_notifications_kind_check CHECK (kind IN (
  'quest_funding','sponsorship','quest_reward',
  'follow','cheer','comment','overtaken','weekly_recap','weekly_champion',
  'chain_alert'
));

-- 3. Contract registry.
CREATE TABLE IF NOT EXISTS chain_contracts (
  id TEXT PRIMARY KEY,
  chain_id BIGINT NOT NULL CHECK (chain_id IN (84532, 80002)),
  name TEXT NOT NULL CHECK (name IN ('token','distributor','badge')),
  address TEXT NOT NULL CHECK (address ~ '^0x[0-9a-f]{40}$'),
  deploy_tx TEXT CHECK (deploy_tx IS NULL OR deploy_tx ~ '^0x[0-9a-f]{64}$'),
  deploy_block BIGINT,
  source_commit TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chain_id, address)
);
CREATE UNIQUE INDEX IF NOT EXISTS chain_contracts_one_active ON chain_contracts (chain_id, name) WHERE active;

-- 4. Wallet registry (public addresses only — never keys).
CREATE TABLE IF NOT EXISTS chain_wallets (
  id TEXT PRIMARY KEY,
  chain_id BIGINT NOT NULL CHECK (chain_id IN (84532, 80002)),
  address TEXT NOT NULL CHECK (address ~ '^0x[0-9a-f]{40}$'),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  role TEXT NOT NULL CHECK (role IN ('admin','signer','badge_issuer','recovery_admin','treasury')),
  custody TEXT NOT NULL CHECK (custody IN ('server','personal')),
  owner_name TEXT CHECK (owner_name IS NULL OR length(owner_name) <= 80),
  low_balance_pol NUMERIC(20,6) CHECK (low_balance_pol IS NULL OR low_balance_pol >= 0),
  needs_gas BOOLEAN NOT NULL DEFAULT TRUE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  notes TEXT CHECK (notes IS NULL OR length(notes) <= 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chain_id, address, role)
);

-- 5. Audit: registry edits (by an admin user) and on-chain role changes (from the indexer).
CREATE TABLE IF NOT EXISTS chain_wallet_audit (
  id TEXT PRIMARY KEY,
  chain_id BIGINT NOT NULL CHECK (chain_id IN (84532, 80002)),
  source TEXT NOT NULL CHECK (source IN ('registry','onchain')),
  action TEXT NOT NULL,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_address TEXT,
  wallet_address TEXT,
  contract_address TEXT,
  role_hash TEXT,
  tx_hash TEXT,
  block_number BIGINT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chain_id, tx_hash, action, wallet_address, role_hash)
);
CREATE INDEX IF NOT EXISTS chain_wallet_audit_recent ON chain_wallet_audit (chain_id, created_at DESC);

-- 6. Initial Seed for Polygon Amoy (chain_id = 80002)
-- Contracts (lowercase addresses)
INSERT INTO chain_contracts (id, chain_id, name, address, deploy_tx, deploy_block, source_commit, active)
VALUES
  ('amoy-contract-token', 80002, 'token', '0x575c4b5b2e046accb003ba852df185126d6197b9', '0x37d015dd375fd58f40ef6b49b6797d34eef89ec3593ba93cac9aa059dda3cfc9', 50776900, '778052b', TRUE),
  ('amoy-contract-distributor', 80002, 'distributor', '0x3542402bcb93e142437779eeea9e16d7163854ce', '0xcf67d817748287a168dbbffe656b65e84acc5915a1286f48fc479cfb9ddced77', 50776903, '778052b', TRUE),
  ('amoy-contract-badge', 80002, 'badge', '0xc9b1cc4f980edf71daca182944ecb67e494b3e9b', '0x1ff4f5e8f47fa18536f97c4599eeb1c9e8dcae7856b5a37fc680077ecb47fa27', 50776950, '778052b', TRUE)
ON CONFLICT (chain_id, address) DO NOTHING;

-- Wallets (public addresses only — never keys)
INSERT INTO chain_wallets (id, chain_id, address, label, role, custody, owner_name, low_balance_pol, needs_gas, active, notes)
VALUES
  ('amoy-wallet-admin', 80002, '0xccb1462779dc6ccfb2b4e6f9276dacd654d58c34', 'Server admin / deployer', 'admin', 'server', NULL, 2.0, TRUE, TRUE, 'Holds DEFAULT_ADMIN_ROLE on token, distributor, and badge contracts'),
  ('amoy-wallet-signer', 80002, '0x40a479c7de6adadfb2ffdd331890f1e4c01e2e72', 'Server claim signer', 'signer', 'server', NULL, NULL, FALSE, TRUE, 'Signs claim authorizations off-chain; holds SIGNER_ROLE on distributor'),
  ('amoy-wallet-issuer', 80002, '0xcf36b1cd5677788deef68ae0f3879af7755cf2e8', 'Server badge issuer', 'badge_issuer', 'server', NULL, 2.0, TRUE, TRUE, 'Issues soulbound badges; holds ISSUER_ROLE on badge contract'),
  ('amoy-wallet-recovery-owner', 80002, '0xfadd476c10b6a93bc26a226f9b7d8e8c556f9671', 'Owner (recovery admin + treasury)', 'recovery_admin', 'personal', 'Zernan (Owner)', NULL, FALSE, TRUE, 'Primary recovery admin & POL treasury wallet'),
  ('amoy-wallet-treasury', 80002, '0xfadd476c10b6a93bc26a226f9b7d8e8c556f9671', 'POL Treasury', 'treasury', 'personal', 'Zernan (Owner)', NULL, FALSE, TRUE, 'Treasury pool for funding server operations and evaluators'),
  ('amoy-wallet-recovery-team1', 80002, '0x8da921c89b3ff5b2b3a4628dec447785490b8a97', 'Team wallet 1 (recovery admin)', 'recovery_admin', 'personal', 'Team Member', NULL, FALSE, TRUE, 'Multi-sig recovery admin'),
  ('amoy-wallet-recovery-team2', 80002, '0x426ad29d7e73d8a8d694bb5ec7e018d14f2032e9', 'Team wallet 2 (recovery admin)', 'recovery_admin', 'personal', 'Team Member', NULL, FALSE, TRUE, 'Multi-sig recovery admin')
ON CONFLICT (chain_id, address, role) DO NOTHING;
