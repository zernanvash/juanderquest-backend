-- Migration 027: Durable Merchant Affiliate Applications and Review
-- Replaces browser-only localStorage applications with durable server records and role-gated admin review.

DO $$ BEGIN
    CREATE TYPE affiliate_application_status AS ENUM ('received', 'in_review', 'approved', 'rejected');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS merchant_affiliate_applications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    business_name VARCHAR(200) NOT NULL,
    category VARCHAR(50) NOT NULL,
    municipality VARCHAR(100) NOT NULL,
    contact_name VARCHAR(100) NOT NULL,
    contact_email VARCHAR(255) NOT NULL,
    contact_phone VARCHAR(50) NOT NULL,
    sponsorship_goals JSONB NOT NULL DEFAULT '[]'::jsonb,
    proposal_details TEXT NOT NULL DEFAULT '',
    status affiliate_application_status NOT NULL DEFAULT 'received',
    reviewer_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    reviewer_notes TEXT,
    reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_affiliate_app_user ON merchant_affiliate_applications (user_id);
CREATE INDEX IF NOT EXISTS idx_affiliate_app_status ON merchant_affiliate_applications (status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_active_affiliate_app ON merchant_affiliate_applications (user_id) 
    WHERE status IN ('received', 'in_review');
