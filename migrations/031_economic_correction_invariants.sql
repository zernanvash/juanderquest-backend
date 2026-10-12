-- ECONOMY_REAL_PG_CORRECTIONS
-- Corrections are append-only, full inverse movements for a single original
-- cosmetic spend. Partial/multiple refunds require a separately reviewed
-- policy and forward migration; this pilot must never over-refund.
CREATE FUNCTION economic_assert_correction_inverse() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  original_tx economic_transactions%ROWTYPE;
  correcting_tx economic_transactions%ROWTYPE;
  original_transfer economic_transfers%ROWTYPE;
  correcting_transfer economic_transfers%ROWTYPE;
  original_count INTEGER;
  correcting_count INTEGER;
BEGIN
  SELECT * INTO original_tx FROM economic_transactions WHERE id = NEW.original_transaction_id;
  SELECT * INTO correcting_tx FROM economic_transactions WHERE id = NEW.correcting_transaction_id;
  IF original_tx.id IS NULL OR correcting_tx.id IS NULL OR
     original_tx.operation <> 'spend' OR correcting_tx.operation <> 'refund' OR
     original_tx.asset_code <> correcting_tx.asset_code OR
     correcting_tx.business_event <> 'refund:' || original_tx.id OR
     correcting_tx.actor_id <> NEW.actor_id OR
     NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.actor_id AND role = 'admin') THEN
    RAISE EXCEPTION 'ECONOMIC_CORRECTION_SOURCE_INVALID' USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO original_count FROM economic_transfers
    WHERE transaction_id = original_tx.id;
  SELECT count(*) INTO correcting_count FROM economic_transfers
    WHERE transaction_id = correcting_tx.id;
  IF original_count <> 1 OR correcting_count <> 1 THEN
    RAISE EXCEPTION 'ECONOMIC_CORRECTION_TRANSFER_COUNT' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO original_transfer FROM economic_transfers
    WHERE transaction_id = original_tx.id;
  SELECT * INTO correcting_transfer FROM economic_transfers
    WHERE transaction_id = correcting_tx.id;
  IF original_transfer.asset_code <> correcting_transfer.asset_code OR
     original_transfer.from_account_id <> correcting_transfer.to_account_id OR
     original_transfer.to_account_id <> correcting_transfer.from_account_id OR
     original_transfer.amount_minor <> correcting_transfer.amount_minor THEN
    RAISE EXCEPTION 'ECONOMIC_CORRECTION_NOT_EXACT_INVERSE' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER economic_corrections_inverse
  AFTER INSERT ON economic_corrections
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION economic_assert_correction_inverse();
