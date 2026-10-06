-- Phase 6 safety retrofit: a free-text admin reference is not funded capacity.
-- Preserve zero-movement legacy rows as drafts; abort instead of hiding any
-- existing reservation/spend that would require financial reconciliation.
ALTER TABLE juanchoice_promotion_budgets
  RENAME COLUMN approval_reference TO request_reference;

ALTER TABLE juanchoice_promotion_budgets
  ADD COLUMN IF NOT EXISTS quarantined_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS quarantine_reason TEXT;

UPDATE juanchoice_promotion_budgets
SET status = 'draft',
    quarantined_at = NOW(),
    quarantine_reason = 'UNVERIFIED_LEGACY_FUNDING'
WHERE status = 'approved' AND reserved_mjdq = 0 AND spent_mjdq = 0;

-- Transactional migration fails if any historical movement remains; a
-- reviewed finance reconciliation is required before applying it.
ALTER TABLE juanchoice_promotion_budgets
  ADD CONSTRAINT chk_juanchoice_budget_funding_gate
  CHECK (status IN ('draft','cancelled') AND reserved_mjdq = 0 AND spent_mjdq = 0);
