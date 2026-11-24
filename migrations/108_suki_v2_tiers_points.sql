-- Plan 111: Suki Card v2 — multi-tier reward ladder, Suki Points wallet/ledger, and card skin.
-- Reserved on WORKBOARD as migration 108.

CREATE TABLE IF NOT EXISTS suki_reward_tiers (
  id             TEXT PRIMARY KEY,
  program_id     TEXT NOT NULL REFERENCES suki_programs(id) ON DELETE CASCADE,
  visit_number   INT NOT NULL CHECK (visit_number BETWEEN 1 AND 20),
  reward_kind    TEXT NOT NULL CHECK (reward_kind IN ('free_item','percent_off','amount_off','promo')),
  reward_value   NUMERIC(8,2) NULL,
  reward_text    TEXT NOT NULL CHECK (char_length(reward_text) BETWEEN 3 AND 120),
  icon_key       TEXT NOT NULL DEFAULT 'gift'
                   CHECK (icon_key IN ('gift','coffee','meal','snack','dessert','drink','discount','promo')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (program_id, visit_number),
  CONSTRAINT chk_suki_tier_value CHECK (
    (reward_kind = 'percent_off' AND reward_value BETWEEN 5 AND 50) OR
    (reward_kind = 'amount_off'  AND reward_value BETWEEN 10 AND 500) OR
    (reward_kind IN ('free_item','promo') AND reward_value IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_suki_reward_tiers_program
  ON suki_reward_tiers (program_id, visit_number);

-- PGMEM_SKIP_BEGIN
INSERT INTO suki_reward_tiers (id, program_id, visit_number, reward_kind, reward_value, reward_text, icon_key, created_at, updated_at)
SELECT 'sukitier_' || md5(p.id), p.id, p.visits_required, p.reward_kind, p.reward_value, p.reward_text, 'gift', p.created_at, p.updated_at
FROM suki_programs p
ON CONFLICT (program_id, visit_number) DO NOTHING;
-- PGMEM_SKIP_END

ALTER TABLE suki_programs
  ADD COLUMN IF NOT EXISTS points_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS points_per_visit INT NOT NULL DEFAULT 10 CHECK (points_per_visit BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS pesos_per_point NUMERIC(8,2) NULL CHECK (pesos_per_point IS NULL OR (pesos_per_point BETWEEN 1 AND 1000)),
  ADD COLUMN IF NOT EXISTS max_points_per_visit INT NOT NULL DEFAULT 200 CHECK (max_points_per_visit BETWEEN 1 AND 2000),
  ADD COLUMN IF NOT EXISTS points_expire_days INT NULL CHECK (points_expire_days IS NULL OR (points_expire_days BETWEEN 30 AND 730)),
  ADD COLUMN IF NOT EXISTS skin_key TEXT NOT NULL DEFAULT 'jdq_classic';

ALTER TABLE suki_cards
  ADD COLUMN IF NOT EXISTS points_balance INT NOT NULL DEFAULT 0 CHECK (points_balance >= 0),
  ADD COLUMN IF NOT EXISTS points_lifetime INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cycle_tiers JSONB NULL;

ALTER TABLE suki_rewards
  ADD COLUMN IF NOT EXISTS tier_visit INT NULL,
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'visits' CHECK (source IN ('visits','points')),
  ADD COLUMN IF NOT EXISTS points_cost INT NULL,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT NULL;

ALTER TABLE suki_rewards DROP CONSTRAINT IF EXISTS suki_rewards_card_id_cycle_key;

-- PGMEM_SKIP_BEGIN
UPDATE suki_rewards r
SET tier_visit = c.cycle_required
FROM suki_cards c
WHERE r.card_id = c.id AND r.source = 'visits' AND r.tier_visit IS NULL;
-- PGMEM_SKIP_END

CREATE UNIQUE INDEX IF NOT EXISTS uq_suki_rewards_card_cycle_tier
  ON suki_rewards (card_id, cycle, tier_visit)
  WHERE source = 'visits';

CREATE UNIQUE INDEX IF NOT EXISTS uq_suki_rewards_user_idempotency
  ON suki_rewards (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS suki_point_items (
  id          TEXT PRIMARY KEY,
  program_id  TEXT NOT NULL REFERENCES suki_programs(id) ON DELETE CASCADE,
  title       TEXT NOT NULL CHECK (char_length(title) BETWEEN 3 AND 80),
  points_cost INT NOT NULL CHECK (points_cost BETWEEN 10 AND 100000),
  icon_key    TEXT NOT NULL DEFAULT 'gift'
                CHECK (icon_key IN ('gift','coffee','meal','snack','dessert','drink','discount','promo')),
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_suki_point_items_program
  ON suki_point_items (program_id, sort_order)
  WHERE is_active = TRUE;

CREATE TABLE IF NOT EXISTS suki_point_ledger (
  id             TEXT PRIMARY KEY,
  card_id        TEXT NOT NULL REFERENCES suki_cards(id) ON DELETE CASCADE,
  program_id     TEXT NOT NULL REFERENCES suki_programs(id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta          INT NOT NULL CHECK (delta <> 0),
  reason         TEXT NOT NULL CHECK (reason IN ('visit','spend','redeem','expire','admin_adjust')),
  visit_id       TEXT NULL REFERENCES suki_visits(id) ON DELETE SET NULL,
  reward_id      TEXT NULL REFERENCES suki_rewards(id) ON DELETE SET NULL,
  amount_spent   NUMERIC(10,2) NULL,
  staff_user_id  TEXT NULL REFERENCES users(id) ON DELETE SET NULL,
  is_test        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_suki_point_ledger_card
  ON suki_point_ledger (card_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_suki_point_ledger_visit_reason
  ON suki_point_ledger (visit_id, reason)
  WHERE visit_id IS NOT NULL;
