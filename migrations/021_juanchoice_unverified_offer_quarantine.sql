-- Phase 6 safety retrofit: an admin-supplied boolean is not merchant consent.
-- Preserve legacy rows for audit but prevent any offer from being approved or
-- publicly advertised until a separately reviewed merchant-verification flow
-- and agreement evidence model are implemented.
ALTER TABLE juanchoice_merchant_offers
  ADD COLUMN IF NOT EXISTS quarantined_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS quarantine_reason TEXT;

UPDATE juanchoice_merchant_offers
SET status = 'suspended',
    quarantined_at = NOW(),
    quarantine_reason = 'UNVERIFIED_LEGACY_CONSENT'
WHERE status = 'approved';

ALTER TABLE juanchoice_merchant_offers
  ADD CONSTRAINT chk_juanchoice_offers_consent_gate CHECK (status <> 'approved');
