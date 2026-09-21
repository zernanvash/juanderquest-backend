-- Phase 6: partnership and economy guardrails.
-- These tables record approved capacity and offers; they do not issue points or alter governance.
CREATE TABLE IF NOT EXISTS juanchoice_promotion_budgets (
  id UUID PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES juanchoice_campaigns(id) ON DELETE RESTRICT,
  unit TEXT NOT NULL DEFAULT 'mjdq' CHECK (unit = 'mjdq'),
  authorized_budget_mjdq BIGINT NOT NULL CHECK (authorized_budget_mjdq >= 0),
  reserved_mjdq BIGINT NOT NULL DEFAULT 0 CHECK (reserved_mjdq >= 0),
  spent_mjdq BIGINT NOT NULL DEFAULT 0 CHECK (spent_mjdq >= 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','exhausted','cancelled')),
  approval_reference TEXT,
  is_test BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (reserved_mjdq + spent_mjdq <= authorized_budget_mjdq)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_juanchoice_budget_campaign_scope ON juanchoice_promotion_budgets(campaign_id, is_test);

CREATE TABLE IF NOT EXISTS juanchoice_merchant_offers (
  id UUID PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES juanchoice_campaigns(id) ON DELETE RESTRICT,
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
  voucher_id TEXT NOT NULL REFERENCES vouchers(id) ON DELETE RESTRICT,
  terms_snapshot JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','suspended','expired')),
  partner_consent_at TIMESTAMPTZ,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  is_test BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (ends_at > starts_at),
  CHECK ((status = 'approved' AND partner_consent_at IS NOT NULL) OR status <> 'approved')
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_juanchoice_offer_campaign_voucher ON juanchoice_merchant_offers(campaign_id, voucher_id, is_test);
CREATE INDEX IF NOT EXISTS idx_juanchoice_offer_active ON juanchoice_merchant_offers(campaign_id, status, starts_at, ends_at, is_test);

CREATE TABLE IF NOT EXISTS lgu_operator_scopes (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  municipality_id VARCHAR(50) NOT NULL REFERENCES municipalities(id) ON DELETE RESTRICT,
  permission TEXT NOT NULL CHECK (permission IN ('nominate','moderate','read_analytics')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  granted_by TEXT REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, municipality_id, permission)
);
CREATE INDEX IF NOT EXISTS idx_lgu_operator_scopes_municipality ON lgu_operator_scopes(municipality_id, permission, is_active);
