-- Migration 037: Unified Sign-in, Identities, Password Credentials, and Durable Scoped Challenges
-- Foundation for email/password authentication, Google & Wallet provider identity linking,
-- password reset recovery grants, revocable auth sessions, and transactional email outbox.

-- 1. Add onboarding policy declaration columns to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS age_eligibility_declared BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS age_declared_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_version VARCHAR(50);
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ;

-- 2. Auth Identities: links multiple providers (wallet, google, email) to a single stable user ID
CREATE TABLE IF NOT EXISTS auth_identities (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider VARCHAR(50) NOT NULL, -- 'email', 'wallet', 'google'
    provider_subject VARCHAR(255) NOT NULL, -- normalized lower email, lowercase 0x wallet address, or Google 'sub'
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_auth_identity_provider_subject UNIQUE (provider, provider_subject)
);

CREATE INDEX IF NOT EXISTS idx_auth_identities_user_id ON auth_identities(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_identities_provider ON auth_identities(provider);

-- 3. Account Emails: verified recovery emails and verification status
CREATE TABLE IF NOT EXISTS account_emails (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    normalized_email VARCHAR(255) NOT NULL,
    is_verified BOOLEAN NOT NULL DEFAULT FALSE,
    verified_at TIMESTAMPTZ,
    is_primary BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_account_email_normalized UNIQUE (normalized_email)
);

CREATE INDEX IF NOT EXISTS idx_account_emails_user_id ON account_emails(user_id);

-- 4. Password Credentials: Argon2id or cryptographically salted hashes for password-enabled accounts
CREATE TABLE IF NOT EXISTS password_credentials (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
    password_hash TEXT NOT NULL,
    algorithm VARCHAR(50) NOT NULL DEFAULT 'scrypt', -- 'scrypt' or 'argon2id'
    salt TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Auth Challenges: Scoped, durable, expiring OTP codes & recovery grants across processes
CREATE TABLE IF NOT EXISTS auth_challenges (
    id TEXT PRIMARY KEY,
    purpose VARCHAR(50) NOT NULL, -- 'signup_verify', 'password_reset', 'email_change', 'wallet_login', 'wallet_bind'
    target_identifier VARCHAR(255) NOT NULL, -- email, address, or grant token
    bound_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL, -- HMAC or hash of the OTP / nonce
    expires_at TIMESTAMPTZ NOT NULL,
    attempt_count INT NOT NULL DEFAULT 0,
    max_attempts INT NOT NULL DEFAULT 5,
    consumed_at TIMESTAMPTZ,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_challenges_target ON auth_challenges(purpose, target_identifier);
CREATE INDEX IF NOT EXISTS idx_auth_challenges_expires ON auth_challenges(expires_at) WHERE consumed_at IS NULL;

-- 6. Auth Sessions: Revocable device session handles & refresh token families
CREATE TABLE IF NOT EXISTS auth_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    refresh_token_hash TEXT NOT NULL UNIQUE,
    user_agent TEXT,
    ip_address VARCHAR(45),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id ON auth_sessions(user_id);

-- 7. Auth Mail Outbox: Durable transactional email delivery queue with redacted payload
CREATE TABLE IF NOT EXISTS auth_mail_outbox (
    id TEXT PRIMARY KEY,
    recipient_email VARCHAR(255) NOT NULL,
    template_type VARCHAR(50) NOT NULL, -- 'signup_otp', 'password_reset_otp', 'password_changed_alert'
    status VARCHAR(50) NOT NULL DEFAULT 'pending', -- 'pending', 'sent', 'failed'
    retry_count INT NOT NULL DEFAULT 0,
    last_error TEXT,
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_mail_outbox_status ON auth_mail_outbox(status) WHERE status = 'pending';
