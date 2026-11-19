-- Plan 110a: Merchant-to-user QA fixes & backend architecture bridges.
-- Strictly additive & idempotent.

-- 1. Narrow redemption uniqueness so sponsor voucher perks never collide with
--    prior Shop purchases, and travelers can re-redeem a voucher once used.
DROP INDEX IF EXISTS uq_redemptions_user_voucher;
CREATE UNIQUE INDEX IF NOT EXISTS uq_redemptions_user_voucher_open
  ON redemptions(user_id, voucher_id)
  WHERE source = 'purchase' AND used_at IS NULL;

-- 2. Preserve countered voucher selection in sponsorship counter-offers.
ALTER TABLE quest_sponsorships
  ADD COLUMN IF NOT EXISTS counter_voucher_id TEXT REFERENCES vouchers(id) ON DELETE RESTRICT;

-- 3. Voucher stock limits, validity windows, and timestamps.
ALTER TABLE vouchers
  ADD COLUMN IF NOT EXISTS stock_limit INTEGER CHECK (stock_limit IS NULL OR stock_limit > 0),
  ADD COLUMN IF NOT EXISTS valid_days INTEGER CHECK (valid_days IS NULL OR (valid_days >= 1 AND valid_days <= 365)),
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE redemptions
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
