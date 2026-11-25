-- Migration 116 (Plan 120): durable audit trail and cooldown source for wallet-gated email migrations.
CREATE TABLE IF NOT EXISTS auth_email_change_audit (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  old_email TEXT NOT NULL,
  new_email TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  google_unlinked BOOLEAN NOT NULL DEFAULT FALSE,
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_email_change_audit_user_created
  ON auth_email_change_audit (user_id, created_at DESC);
