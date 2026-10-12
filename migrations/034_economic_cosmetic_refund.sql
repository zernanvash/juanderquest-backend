-- ECONOMY_REAL_PG_REFUND: admin-only full inverse of one simulated cosmetic
-- spend. It does not promise cash, merchant reimbursement or public refunds.
ALTER TABLE economic_entitlements ADD COLUMN refunded_at TIMESTAMPTZ;
ALTER TABLE economic_entitlements ADD COLUMN refund_transaction_id TEXT
  REFERENCES economic_transactions(id) ON DELETE RESTRICT;
ALTER TABLE economic_entitlements ADD CONSTRAINT economic_entitlement_refund_pair
  CHECK ((refunded_at IS NULL) = (refund_transaction_id IS NULL));
CREATE UNIQUE INDEX economic_entitlement_refund_tx_unique
  ON economic_entitlements(refund_transaction_id) WHERE refund_transaction_id IS NOT NULL;

SELECT set_config('search_path', format('%I, pg_temp', current_schema()), true);

CREATE FUNCTION economic_refund_cosmetic(
  p_original_transaction_id TEXT,
  p_correction_transaction_id TEXT,
  p_correction_id TEXT,
  p_admin_id TEXT,
  p_reason TEXT,
  p_idempotency_key TEXT,
  p_request_hash TEXT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  original_tx economic_transactions%ROWTYPE;
  original_transfer economic_transfers%ROWTYPE;
  entitlement economic_entitlements%ROWTYPE;
BEGIN
  IF p_original_transaction_id IS NULL OR p_correction_transaction_id IS NULL OR
     p_correction_id IS NULL OR p_admin_id IS NULL OR p_reason IS NULL OR
     p_idempotency_key IS NULL OR p_request_hash IS NULL OR
     char_length(trim(p_reason)) NOT BETWEEN 10 AND 2000 OR
     char_length(p_idempotency_key) NOT BETWEEN 1 AND 120 OR
     p_request_hash !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'INVALID_SIMULATED_REFUND' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_admin_id AND role = 'admin') THEN
    RAISE EXCEPTION 'ADMIN_REFUND_REQUIRED' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO original_tx FROM economic_transactions
    WHERE id = p_original_transaction_id FOR UPDATE;
  SELECT * INTO original_transfer FROM economic_transfers
    WHERE transaction_id = p_original_transaction_id AND sequence = 1;
  SELECT * INTO entitlement FROM economic_entitlements
    WHERE transaction_id = p_original_transaction_id FOR UPDATE;
  IF original_tx.id IS NULL OR original_tx.operation <> 'spend' OR
     original_tx.asset_code <> 'EXPLORER_COIN_SIM' OR
     original_transfer.transaction_id IS NULL OR
     original_transfer.asset_code <> 'EXPLORER_COIN_SIM' OR
     original_transfer.to_account_id <> 'sim:retired' OR
     original_transfer.from_account_id <> 'sim:traveler:' || entitlement.user_id OR
     entitlement.id IS NULL OR entitlement.refunded_at IS NOT NULL OR
     EXISTS (SELECT 1 FROM economic_transfers
       WHERE transaction_id = p_original_transaction_id AND sequence <> 1) OR
     EXISTS (SELECT 1 FROM economic_corrections
       WHERE original_transaction_id = p_original_transaction_id) THEN
    RAISE EXCEPTION 'SIMULATED_SPEND_NOT_REFUNDABLE' USING ERRCODE = '23514';
  END IF;

  -- All postings take the same account-row order, including reverse flows.
  PERFORM 1 FROM economic_accounts
    WHERE id IN (original_transfer.to_account_id, original_transfer.from_account_id)
      AND asset_code = 'EXPLORER_COIN_SIM' ORDER BY id FOR UPDATE;

  INSERT INTO economic_transactions
    (id,asset_code,business_event,operation,actor_id,policy_version)
    VALUES (p_correction_transaction_id,'EXPLORER_COIN_SIM',
      'refund:' || p_original_transaction_id,'refund',p_admin_id,'cosmetic-refund-pilot-v1');
  UPDATE economic_accounts SET balance_minor = balance_minor - original_transfer.amount_minor
    WHERE id = original_transfer.to_account_id AND balance_minor >= original_transfer.amount_minor;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'REFUND_SOURCE_INSUFFICIENT' USING ERRCODE = '23514';
  END IF;
  UPDATE economic_accounts SET balance_minor = balance_minor + original_transfer.amount_minor
    WHERE id = original_transfer.from_account_id AND
      balance_minor::numeric + original_transfer.amount_minor::numeric <= 9223372036854775807;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'REFUND_DESTINATION_UNAVAILABLE' USING ERRCODE = '23514';
  END IF;
  INSERT INTO economic_transfers
    (transaction_id,sequence,asset_code,from_account_id,to_account_id,amount_minor)
    VALUES (p_correction_transaction_id,1,'EXPLORER_COIN_SIM',
      original_transfer.to_account_id,original_transfer.from_account_id,
      original_transfer.amount_minor);
  INSERT INTO economic_corrections
    (id,original_transaction_id,correcting_transaction_id,reason,actor_id)
    VALUES (p_correction_id,p_original_transaction_id,p_correction_transaction_id,
      trim(p_reason),p_admin_id);
  UPDATE economic_entitlements SET refunded_at = clock_timestamp(),
    refund_transaction_id = p_correction_transaction_id WHERE id = entitlement.id;
  INSERT INTO economic_outbox(id,transaction_id,event_type,payload)
    VALUES (gen_random_uuid()::text,p_correction_transaction_id,'refund',
      jsonb_build_object('original_transaction_id',p_original_transaction_id,
        'amount_minor',original_transfer.amount_minor::text,'asset','EXPLORER_COIN_SIM'));
  INSERT INTO economic_commands
    (actor_id,operation,idempotency_key,request_hash,transaction_id)
    VALUES (p_admin_id,'refund',p_idempotency_key,p_request_hash,p_correction_transaction_id);
END $$;

REVOKE ALL ON FUNCTION economic_refund_cosmetic(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;
