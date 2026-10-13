-- Migration 042: Merchant Affiliation Lifecycle and Dedicated Merchant Dashboard Workspace
-- Adds support for:
--   1. 'needs_changes' status on affiliate_application_status enum
--   2. merchant_affiliate_drafts table for cross-device draft persistence
--   3. Extended merchant_affiliate_applications metadata (version, address, coordinates, declaration, applicant_feedback)
--   4. merchant_application_audits table for immutable review history
--   5. Extended merchants table (status, is_published, category, municipality, contact, media, source_application_id)
--   6. merchant_memberships table for owner association without altering user role
--   7. merchant_products table for informational catalog items

-- 1. Extend affiliate_application_status enum if 'needs_changes' is missing
DO $$ BEGIN
    ALTER TYPE affiliate_application_status ADD VALUE IF NOT EXISTS 'needs_changes';
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- 2. Create private per-user draft storage table
CREATE TABLE IF NOT EXISTS merchant_affiliate_drafts (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    draft_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    current_step INT NOT NULL DEFAULT 1,
    revision INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Extend merchant_affiliate_applications with structured fields
ALTER TABLE merchant_affiliate_applications 
    ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS business_address TEXT DEFAULT '',
    ADD COLUMN IF NOT EXISTS business_province VARCHAR(100) DEFAULT 'Pangasinan',
    ADD COLUMN IF NOT EXISTS gps_lat DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS gps_lng DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS preferred_contact_method VARCHAR(20) DEFAULT 'email',
    ADD COLUMN IF NOT EXISTS applicant_feedback TEXT,
    ADD COLUMN IF NOT EXISTS declaration_version VARCHAR(20) DEFAULT '1.0';

-- 4. Create immutable review audit ledger
CREATE TABLE IF NOT EXISTS merchant_application_audits (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL REFERENCES merchant_affiliate_applications(id) ON DELETE CASCADE,
    actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    from_status VARCHAR(50) NOT NULL,
    to_status VARCHAR(50) NOT NULL,
    revision INT NOT NULL DEFAULT 1,
    notes TEXT,
    applicant_feedback TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_merchant_app_audits_app ON merchant_application_audits(application_id);
CREATE INDEX IF NOT EXISTS idx_merchant_app_audits_created ON merchant_application_audits(created_at);

-- 5. Extend merchants table
ALTER TABLE merchants
    ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active',
    ADD COLUMN IF NOT EXISTS is_published BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS category VARCHAR(50),
    ADD COLUMN IF NOT EXISTS municipality VARCHAR(100),
    ADD COLUMN IF NOT EXISTS contact_email VARCHAR(255),
    ADD COLUMN IF NOT EXISTS contact_phone VARCHAR(50),
    ADD COLUMN IF NOT EXISTS logo_url TEXT,
    ADD COLUMN IF NOT EXISTS banner_url TEXT,
    ADD COLUMN IF NOT EXISTS source_application_id TEXT UNIQUE REFERENCES merchant_affiliate_applications(id) ON DELETE SET NULL;

-- 6. Create merchant memberships (Role: 'owner', 'staff' reserved)
CREATE TABLE IF NOT EXISTS merchant_memberships (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL DEFAULT 'owner',
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(merchant_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_merchant_memberships_user ON merchant_memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_merchant_memberships_merchant ON merchant_memberships(merchant_id);

-- 7. Create informational merchant products
CREATE TABLE IF NOT EXISTS merchant_products (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    name VARCHAR(200) NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    price NUMERIC(10,2),
    currency VARCHAR(10) NOT NULL DEFAULT 'PHP',
    image_url TEXT,
    is_published BOOLEAN NOT NULL DEFAULT TRUE,
    is_archived BOOLEAN NOT NULL DEFAULT FALSE,
    display_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_merchant_products_merchant ON merchant_products(merchant_id);
CREATE INDEX IF NOT EXISTS idx_merchant_products_active ON merchant_products(merchant_id, is_archived, is_published);
