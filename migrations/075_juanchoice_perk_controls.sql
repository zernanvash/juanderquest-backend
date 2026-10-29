-- JuanChoice perk controls for JuanderQuest platform staff only.
-- users.admin_scope marks platform staff among admins. NULL means "not platform" (area or future
-- scoped admins); existing admins are NOT granted, so grants are explicit (see the deploy notes).
ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_scope TEXT;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_admin_scope_check;
ALTER TABLE users ADD CONSTRAINT users_admin_scope_check CHECK (admin_scope IS NULL OR admin_scope IN ('platform', 'area'));

-- Per perk type: on/off and value overrides (NULL keeps the catalog value). Applies to live perks
-- at read time and to manifestos of rounds prepared afterwards.
CREATE TABLE IF NOT EXISTS juanchoice_perk_settings (
  perk_key TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  standard_value NUMERIC(8,4),
  festival_value NUMERIC(8,4),
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Pause one live perk of one reigning destination (campaign + candidate + perk key).
CREATE TABLE IF NOT EXISTS juanchoice_perk_suspensions (
  id UUID PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES juanchoice_campaigns(id) ON DELETE CASCADE,
  candidate_id UUID NOT NULL,
  perk_key TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  reason TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lifted_by TEXT,
  lifted_reason TEXT,
  lifted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_juanchoice_perk_suspensions_campaign ON juanchoice_perk_suspensions (campaign_id, active);

-- Every control action, with its reason and before/after state.
CREATE TABLE IF NOT EXISTS juanchoice_perk_control_audit (
  id UUID PRIMARY KEY,
  action TEXT NOT NULL,
  target JSONB NOT NULL DEFAULT '{}'::jsonb,
  before_state JSONB,
  after_state JSONB,
  reason TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_juanchoice_perk_control_audit_created ON juanchoice_perk_control_audit (created_at DESC);
