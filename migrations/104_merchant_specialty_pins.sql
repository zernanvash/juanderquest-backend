-- 104: v0.3.10 team review: a merchant pins up to 3 published products as its specialty.
-- specialty_at is the pin time (NULL = not pinned); the public merchant page lists pins first.
ALTER TABLE merchant_products
  ADD COLUMN IF NOT EXISTS specialty_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_merchant_products_specialty
  ON merchant_products(merchant_id, specialty_at)
  WHERE specialty_at IS NOT NULL;
