-- CHAIN_REAL_PG_INDEXER
-- 061_onchain_badge_minting.sql
-- Plan 50: mint earned achievements as soulbound badges on the test chain.
-- Additive: links an outbox command to its achievement award, tracks retries,
-- and records where each transaction was included so the minter can confirm it.

ALTER TABLE chain_commands ADD COLUMN IF NOT EXISTS source_award_id UUID REFERENCES achievement_awards(id) ON DELETE RESTRICT;
ALTER TABLE chain_commands ADD COLUMN IF NOT EXISTS token_uri TEXT;
ALTER TABLE chain_commands ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chain_commands ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE chain_commands ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE UNIQUE INDEX IF NOT EXISTS chain_commands_source_award
  ON chain_commands (chain_id, source_award_id) WHERE source_award_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS chain_commands_due
  ON chain_commands (chain_id, next_attempt_at) WHERE status = 'queued';

-- 'failed' = gave up after repeated reverts; an admin can requeue it.
ALTER TABLE chain_commands DROP CONSTRAINT IF EXISTS chain_commands_status_check;
ALTER TABLE chain_commands ADD CONSTRAINT chain_commands_status_check CHECK (
  status IN ('queued', 'submitted', 'included', 'finalized', 'reverted', 'replaced', 'unknown', 'failed')
);

ALTER TABLE chain_transaction_attempts ADD COLUMN IF NOT EXISTS nonce BIGINT;
ALTER TABLE chain_transaction_attempts ADD COLUMN IF NOT EXISTS block_number BIGINT;
ALTER TABLE chain_transaction_attempts ADD COLUMN IF NOT EXISTS block_hash TEXT;
ALTER TABLE chain_transaction_attempts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
