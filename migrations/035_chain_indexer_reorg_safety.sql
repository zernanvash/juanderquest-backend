-- CHAIN_REAL_PG_INDEXER
-- Local-only Base Sepolia indexing provenance. No signer, relayer or economic
-- transfer is activated by this additive migration.
CREATE TABLE chain_block_headers (
  chain_id BIGINT NOT NULL CHECK (chain_id = 84532),
  block_number BIGINT NOT NULL CHECK (block_number >= 0),
  block_hash TEXT NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  parent_hash TEXT NOT NULL CHECK (parent_hash ~ '^0x[0-9a-f]{64}$'),
  canonical BOOLEAN NOT NULL DEFAULT TRUE,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, block_number, block_hash)
);
CREATE UNIQUE INDEX chain_block_headers_canonical_height
  ON chain_block_headers(chain_id, block_number) WHERE canonical;
CREATE INDEX chain_block_headers_canonical_lookup
  ON chain_block_headers(chain_id, block_number DESC) WHERE canonical;

ALTER TABLE chain_events ADD COLUMN contract_address TEXT;
ALTER TABLE chain_events ADD CONSTRAINT chain_events_contract_address_format
  CHECK (contract_address IS NULL OR contract_address ~ '^0x[0-9a-f]{40}$');
CREATE INDEX chain_events_canonical_entitlement
  ON chain_events(chain_id, event_name, (payload ->> 'entitlement'))
  WHERE canonical;

-- Historical queued commands may lack an immutable expected amount/token ID.
-- They remain unfinalizable until separately reviewed; never infer the
-- expectation from an observed event after the fact.
ALTER TABLE chain_commands ADD COLUMN expected_amount_wei NUMERIC(78,0);
ALTER TABLE chain_commands ADD COLUMN expected_token_id NUMERIC(78,0);
ALTER TABLE chain_commands ADD CONSTRAINT chain_command_expected_value_bounds CHECK (
  (expected_amount_wei IS NULL OR expected_amount_wei > 0) AND
  (expected_token_id IS NULL OR expected_token_id >= 0)
);
ALTER TABLE chain_commands ADD CONSTRAINT chain_command_identity_format CHECK (
  entitlement_id ~* '^0x[0-9a-f]{64}$' AND
  recipient_address ~* '^0x[0-9a-f]{40}$'
);

CREATE FUNCTION guard_chain_command_expectation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF (NEW.operation = 'test_token_claim' AND (NEW.expected_amount_wei IS NULL OR NEW.expected_token_id IS NOT NULL))
       OR (NEW.operation = 'badge_claim' AND (NEW.expected_token_id IS NULL OR NEW.expected_amount_wei IS NOT NULL)) THEN
      RAISE EXCEPTION 'CHAIN_EXPECTATION_REQUIRED';
    END IF;
  ELSIF NEW.chain_id IS DISTINCT FROM OLD.chain_id
      OR NEW.entitlement_id IS DISTINCT FROM OLD.entitlement_id
      OR NEW.operation IS DISTINCT FROM OLD.operation
      OR NEW.recipient_address IS DISTINCT FROM OLD.recipient_address
      OR NEW.expected_amount_wei IS DISTINCT FROM OLD.expected_amount_wei
      OR NEW.expected_token_id IS DISTINCT FROM OLD.expected_token_id THEN
    RAISE EXCEPTION 'CHAIN_EXPECTATION_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER chain_command_expectation_guard
  BEFORE INSERT OR UPDATE ON chain_commands
  FOR EACH ROW EXECUTE FUNCTION guard_chain_command_expectation();
