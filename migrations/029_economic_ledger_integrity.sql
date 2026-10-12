-- ECONOMY_REAL_PG_HARDENING
-- Forward-only integrity layer for the isolated Explorer Coin pilot. Existing
-- drift aborts this migration; it is never repaired or erased automatically.
LOCK TABLE economic_accounts, economic_transfers IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM economic_accounts a
    WHERE a.balance_minor::numeric <>
      COALESCE((SELECT SUM(t.amount_minor::numeric) FROM economic_transfers t WHERE t.to_account_id = a.id), 0) -
      COALESCE((SELECT SUM(t.amount_minor::numeric) FROM economic_transfers t WHERE t.from_account_id = a.id), 0)
  ) THEN
    RAISE EXCEPTION 'ECONOMIC_LEDGER_DRIFT_PREFLIGHT';
  END IF;
END $$;

CREATE TABLE economic_corrections (
  id TEXT PRIMARY KEY,
  original_transaction_id TEXT NOT NULL UNIQUE REFERENCES economic_transactions(id) ON DELETE RESTRICT,
  correcting_transaction_id TEXT NOT NULL UNIQUE REFERENCES economic_transactions(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 10 AND 2000),
  actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (original_transaction_id <> correcting_transaction_id)
);

CREATE FUNCTION economic_reject_history_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ECONOMIC_HISTORY_IMMUTABLE' USING ERRCODE = '23514';
END $$;

CREATE TRIGGER economic_transactions_immutable
  BEFORE UPDATE OR DELETE ON economic_transactions
  FOR EACH ROW EXECUTE FUNCTION economic_reject_history_mutation();
CREATE TRIGGER economic_transfers_immutable
  BEFORE UPDATE OR DELETE ON economic_transfers
  FOR EACH ROW EXECUTE FUNCTION economic_reject_history_mutation();
CREATE TRIGGER economic_corrections_immutable
  BEFORE UPDATE OR DELETE ON economic_corrections
  FOR EACH ROW EXECUTE FUNCTION economic_reject_history_mutation();
CREATE TRIGGER reward_awards_immutable
  BEFORE UPDATE OR DELETE ON reward_awards
  FOR EACH ROW EXECUTE FUNCTION economic_reject_history_mutation();

CREATE FUNCTION economic_reject_account_identity_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ECONOMIC_ACCOUNT_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR
      NEW.asset_code IS DISTINCT FROM OLD.asset_code OR
      NEW.kind IS DISTINCT FROM OLD.kind OR
      NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'ECONOMIC_ACCOUNT_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER economic_accounts_identity_immutable
  BEFORE UPDATE OR DELETE ON economic_accounts
  FOR EACH ROW EXECUTE FUNCTION economic_reject_account_identity_change();

-- Checked at COMMIT: the cached balance is only a projection of immutable
-- transfers. Either a direct account edit or a transfer without its matching
-- account updates aborts the whole transaction.
CREATE FUNCTION economic_assert_account_projection() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  account_id TEXT;
  stored NUMERIC;
  reconstructed NUMERIC;
BEGIN
  IF TG_TABLE_NAME = 'economic_accounts' THEN
    account_id := NEW.id;
  ELSIF TG_OP = 'INSERT' THEN
    account_id := NEW.from_account_id;
  ELSE
    RAISE EXCEPTION 'UNEXPECTED_ECONOMIC_TRIGGER_EVENT';
  END IF;

  SELECT a.balance_minor::numeric,
    COALESCE((SELECT SUM(t.amount_minor::numeric) FROM economic_transfers t WHERE t.to_account_id = a.id), 0) -
    COALESCE((SELECT SUM(t.amount_minor::numeric) FROM economic_transfers t WHERE t.from_account_id = a.id), 0)
    INTO stored, reconstructed
    FROM economic_accounts a WHERE a.id = account_id;
  IF stored IS NULL OR stored <> reconstructed THEN
    RAISE EXCEPTION 'ECONOMIC_ACCOUNT_PROJECTION_DRIFT' USING ERRCODE = '23514';
  END IF;

  IF TG_TABLE_NAME = 'economic_transfers' THEN
    SELECT a.balance_minor::numeric,
      COALESCE((SELECT SUM(t.amount_minor::numeric) FROM economic_transfers t WHERE t.to_account_id = a.id), 0) -
      COALESCE((SELECT SUM(t.amount_minor::numeric) FROM economic_transfers t WHERE t.from_account_id = a.id), 0)
      INTO stored, reconstructed
      FROM economic_accounts a WHERE a.id = NEW.to_account_id;
    IF stored IS NULL OR stored <> reconstructed THEN
      RAISE EXCEPTION 'ECONOMIC_ACCOUNT_PROJECTION_DRIFT' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER economic_accounts_projection
  AFTER INSERT OR UPDATE ON economic_accounts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION economic_assert_account_projection();
CREATE CONSTRAINT TRIGGER economic_transfers_projection
  AFTER INSERT ON economic_transfers
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION economic_assert_account_projection();
