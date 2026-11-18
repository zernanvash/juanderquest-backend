-- Migration 101: rejected merchant applicants may edit and resubmit, or appeal, the same application (owner 2026-11-18).
DO $$ BEGIN
    ALTER TYPE affiliate_application_status ADD VALUE IF NOT EXISTS 'appealed';
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE merchant_affiliate_applications
    ADD COLUMN IF NOT EXISTS resubmission_count INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS previous_rejection_reason TEXT,
    ADD COLUMN IF NOT EXISTS resubmitted_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS appeal_message TEXT,
    ADD COLUMN IF NOT EXISTS appealed_at TIMESTAMPTZ;
