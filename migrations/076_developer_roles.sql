-- Developer role (owner 2026-10-29): developers are admins with admin_scope='developer'. They pass every
-- admin check, count as JuanChoice platform staff, and are the only accounts that may change other
-- accounts' roles. Nobody is granted here; the first developer is granted by the deploy step.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_admin_scope_check;
ALTER TABLE users ADD CONSTRAINT users_admin_scope_check CHECK (admin_scope IS NULL OR admin_scope IN ('platform', 'area', 'developer'));

-- Every role change, who made it and why.
CREATE TABLE IF NOT EXISTS user_role_audit (
  id UUID PRIMARY KEY,
  actor_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  old_role TEXT NOT NULL,
  new_role TEXT NOT NULL,
  old_scope TEXT,
  new_scope TEXT,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_role_audit_created ON user_role_audit(created_at DESC);
