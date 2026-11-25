-- Migration 117 (Plan 122a): enforce 1-to-1 merchants.spot_id uniqueness (column already added in 103_suki_cards)
-- and create merchant_spot_claim_requests for claiming existing non-authored destinations.

-- Keep existing non-duplicate merchants.spot_id links as-is.
-- If multiple merchants share the same spot_id, keep the oldest merchant's link and clear the rest.
-- PGMEM_SKIP_BEGIN
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY spot_id ORDER BY created_at ASC, id ASC) AS rn
  FROM merchants
  WHERE spot_id IS NOT NULL
)
UPDATE merchants m
SET spot_id = NULL
FROM ranked r
WHERE m.id = r.id AND r.rn > 1;
-- PGMEM_SKIP_END

CREATE UNIQUE INDEX IF NOT EXISTS uq_merchants_spot_id
  ON merchants (spot_id)
  WHERE spot_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS merchant_spot_claim_requests (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  spot_id TEXT NOT NULL REFERENCES spots(id) ON DELETE CASCADE,
  requested_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note TEXT NOT NULL CHECK (char_length(note) BETWEEN 10 AND 500),
  proof_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  review_note TEXT CHECK (review_note IS NULL OR char_length(review_note) BETWEEN 3 AND 300),
  is_test BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Prevent duplicate pending claims for the same merchant.
CREATE UNIQUE INDEX IF NOT EXISTS uq_merchant_spot_claims_pending_merchant
  ON merchant_spot_claim_requests (merchant_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_merchant_spot_claims_status_created
  ON merchant_spot_claim_requests (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_merchant_spot_claims_spot_status
  ON merchant_spot_claim_requests (spot_id, status);
