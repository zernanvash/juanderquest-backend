-- Migration 043: Bounded administrator settings and audit
-- One explicit settings document with optimistic revision and an append-only
-- audit trail. Only allowlisted, low-risk keys may be stored here; secrets,
-- deployment configuration and credentials are never editable in the browser.

CREATE TABLE IF NOT EXISTS system_settings_document (
    id SMALLINT PRIMARY KEY CHECK (id = 1),
    values JSONB NOT NULL DEFAULT '{}'::jsonb,
    revision BIGINT NOT NULL DEFAULT 0,
    updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO system_settings_document (id, values, revision)
VALUES (1, '{}'::jsonb, 0)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS system_settings_audit (
    id UUID PRIMARY KEY,
    actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    changed_keys JSONB NOT NULL,
    before_values JSONB NOT NULL,
    after_values JSONB NOT NULL,
    reason TEXT,
    request_id TEXT,
    revision BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_system_settings_audit_created
    ON system_settings_audit(created_at DESC);
