-- Monthly scheduling is opt-in. This migration creates no active schedule or campaign.
CREATE TABLE IF NOT EXISTS juanchoice_schedules (
  id UUID PRIMARY KEY,
  schedule_key TEXT NOT NULL,
  region_key TEXT NOT NULL,
  display_region TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Manila',
  cadence TEXT NOT NULL DEFAULT 'monthly' CHECK (cadence = 'monthly'),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  effective_period DATE NOT NULL,
  preparation_lead_days INTEGER NOT NULL DEFAULT 7 CHECK (preparation_lead_days BETWEEN 1 AND 28),
  minimum_candidates INTEGER NOT NULL DEFAULT 2,
  target_candidates INTEGER NOT NULL DEFAULT 4,
  maximum_candidates INTEGER NOT NULL DEFAULT 6,
  themes JSONB NOT NULL,
  policy_version TEXT NOT NULL DEFAULT 'juanchoice-monthly-v1',
  is_test BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (schedule_key, is_test),
  CHECK (minimum_candidates BETWEEN 2 AND 6 AND target_candidates BETWEEN minimum_candidates AND maximum_candidates AND maximum_candidates <= 6),
  CHECK (EXTRACT(DAY FROM effective_period) = 1),
  CHECK (jsonb_typeof(themes) = 'array')
);

CREATE INDEX IF NOT EXISTS idx_juanchoice_schedules_due
  ON juanchoice_schedules(enabled, is_test, region_key);

CREATE TABLE IF NOT EXISTS juanchoice_schedule_periods (
  id UUID PRIMARY KEY,
  schedule_id UUID NOT NULL REFERENCES juanchoice_schedules(id) ON DELETE RESTRICT,
  period_start DATE NOT NULL,
  opens_at TIMESTAMPTZ NOT NULL,
  closes_at TIMESTAMPTZ NOT NULL,
  campaign_id UUID UNIQUE REFERENCES juanchoice_campaigns(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','prepared','postponed','missed','cancelled')),
  selected_theme TEXT,
  policy_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  selection_seed TEXT,
  reason_code TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_attempt_at TIMESTAMPTZ,
  prepared_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (schedule_id, period_start),
  CHECK (closes_at > opens_at),
  CHECK (EXTRACT(DAY FROM period_start) = 1),
  CHECK ((status IN ('prepared','cancelled') AND campaign_id IS NOT NULL) OR (status NOT IN ('prepared','cancelled') AND campaign_id IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_juanchoice_periods_due
  ON juanchoice_schedule_periods(status, opens_at, schedule_id);
CREATE INDEX IF NOT EXISTS idx_juanchoice_periods_recent
  ON juanchoice_schedule_periods(schedule_id, period_start DESC);

CREATE TABLE IF NOT EXISTS juanchoice_schedule_audit (
  id UUID PRIMARY KEY,
  schedule_id UUID NOT NULL REFERENCES juanchoice_schedules(id) ON DELETE RESTRICT,
  period_id UUID REFERENCES juanchoice_schedule_periods(id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('system','admin')),
  actor_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  action TEXT NOT NULL,
  reason_code TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((actor_kind = 'system' AND actor_id IS NULL) OR (actor_kind = 'admin' AND actor_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_juanchoice_schedule_audit_period
  ON juanchoice_schedule_audit(period_id, created_at DESC);
