-- Migration 010: Ensure strictly one redemption per user per voucher
-- Preflight: Read-only duplicate check. Aborts if duplicates exist without deleting any historical records.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM redemptions r1
        JOIN redemptions r2 ON r1.user_id = r2.user_id 
                           AND r1.voucher_id = r2.voucher_id 
                           AND r1.id <> r2.id
        LIMIT 1
    ) THEN
        RAISE EXCEPTION 'Migration 010 aborted: Duplicate user-voucher redemptions exist. Manual reconciliation required before applying unique constraint.';
    END IF;
END $$;

-- Unique constraint ensuring at most one redemption per voucher per user
CREATE UNIQUE INDEX IF NOT EXISTS uq_redemptions_user_voucher ON redemptions(user_id, voucher_id);
