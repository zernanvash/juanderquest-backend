-- 103: Plan 107: Suki Card, merchant loyalty cards.
-- Shops set a card (N visits -> the shop's own in-kind reward); customers collect one
-- visit per card per Manila day by scanning the counter standee (GPS) or showing a pass.
-- The same counter scanner confirms Shop vouchers and sponsor perks (redemptions.used_at).
-- No mJDQ is created or moved by anything here.

-- Shop location for the geofence, plus an optional link to a destination.
ALTER TABLE merchants
  ADD COLUMN IF NOT EXISTS gps_lat DOUBLE PRECISION NULL,
  ADD COLUMN IF NOT EXISTS gps_lng DOUBLE PRECISION NULL,
  ADD COLUMN IF NOT EXISTS spot_id TEXT NULL REFERENCES spots(id) ON DELETE SET NULL;

UPDATE merchants m
   SET gps_lat = a.gps_lat, gps_lng = a.gps_lng
  FROM merchant_affiliate_applications a
 WHERE a.id = m.source_application_id
   AND m.gps_lat IS NULL
   AND a.gps_lat IS NOT NULL
   AND a.gps_lng IS NOT NULL;

CREATE TABLE IF NOT EXISTS suki_programs (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL UNIQUE REFERENCES merchants(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 3 AND 60),
  reward_kind TEXT NOT NULL DEFAULT 'free_item'
    CHECK (reward_kind IN ('free_item', 'percent_off', 'amount_off', 'promo')),
  reward_value NUMERIC(8, 2) NULL,
  reward_text TEXT NOT NULL CHECK (char_length(reward_text) BETWEEN 3 AND 120),
  visits_required INT NOT NULL DEFAULT 10 CHECK (visits_required BETWEEN 3 AND 20),
  mode TEXT NOT NULL DEFAULT 'standee' CHECK (mode IN ('standee', 'staff_scan')),
  radius_m INT NOT NULL DEFAULT 75 CHECK (radius_m BETWEEN 30 AND 200),
  standee_version INT NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused')),
  paused_by TEXT NULL CHECK (paused_by IN ('merchant', 'admin')),
  pause_reason TEXT NULL,
  is_test BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_suki_reward_value CHECK (
    (reward_kind = 'percent_off' AND reward_value BETWEEN 1 AND 100)
    OR (reward_kind = 'amount_off' AND reward_value BETWEEN 1 AND 5000)
    OR (reward_kind IN ('free_item', 'promo') AND reward_value IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS suki_cards (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES suki_programs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cycle INT NOT NULL DEFAULT 1,
  cycle_required INT NOT NULL,
  visits INT NOT NULL DEFAULT 0 CHECK (visits >= 0),
  total_visits INT NOT NULL DEFAULT 0,
  first_visit_at TIMESTAMPTZ NULL,
  last_visit_at TIMESTAMPTZ NULL,
  is_test BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (program_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_suki_cards_user ON suki_cards(user_id);

CREATE TABLE IF NOT EXISTS suki_visits (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES suki_cards(id) ON DELETE CASCADE,
  program_id TEXT NOT NULL REFERENCES suki_programs(id) ON DELETE CASCADE,
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK (method IN ('standee', 'staff_scan')),
  manila_date DATE NOT NULL,
  lat DOUBLE PRECISION NULL,
  lng DOUBLE PRECISION NULL,
  accuracy_m DOUBLE PRECISION NULL,
  staff_user_id TEXT NULL REFERENCES users(id) ON DELETE SET NULL,
  pass_jti TEXT NULL UNIQUE,
  idempotency_key TEXT NULL,
  flagged_reason TEXT NULL,
  is_test BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (card_id, manila_date),
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_suki_visits_merchant_date ON suki_visits(merchant_id, manila_date);
CREATE INDEX IF NOT EXISTS idx_suki_visits_user_created ON suki_visits(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS suki_rewards (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES suki_cards(id) ON DELETE CASCADE,
  program_id TEXT NOT NULL REFERENCES suki_programs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cycle INT NOT NULL,
  reward_kind TEXT NOT NULL,
  reward_value NUMERIC(8, 2) NULL,
  reward_text TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'claimed')),
  expires_at TIMESTAMPTZ NOT NULL,
  claimed_at TIMESTAMPTZ NULL,
  claimed_by TEXT NULL REFERENCES users(id) ON DELETE SET NULL,
  is_test BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (card_id, cycle)
);
CREATE INDEX IF NOT EXISTS idx_suki_rewards_user ON suki_rewards(user_id, created_at DESC);

-- Counter confirmation for Shop vouchers and sponsor perks.
ALTER TABLE redemptions
  ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS used_by TEXT NULL REFERENCES users(id) ON DELETE SET NULL;

-- Notification kinds: the full 102 list (the last migration to set it) + 'suki_reward'.
ALTER TABLE user_notifications DROP CONSTRAINT IF EXISTS user_notifications_kind_check;
ALTER TABLE user_notifications ADD CONSTRAINT user_notifications_kind_check CHECK (kind IN (
  'quest_funding','sponsorship','quest_reward',
  'follow','cheer','comment','overtaken','weekly_recap','weekly_champion',
  'chain_alert','spot_photo_approved','spot_moderation','nearby_quest','suki_reward'
));

INSERT INTO achievement_definitions (id, track, title, description, badge_icon, category, threshold, criteria_version) VALUES
  ('suki_first_card', 'explorer', 'Suki', 'Complete a Suki Card at one shop.', 'suki_card', 'suki', 1, 'v1'),
  ('suki_three_shops', 'explorer', 'Barangay Regular', 'Be a regular (5+ visits) at 3 shops.', 'suki_regular', 'suki', 3, 'v1'),
  ('suki_three_towns', 'explorer', 'Suki ng Bayan', 'Visit Suki shops in 3 different towns.', 'suki_towns', 'suki', 3, 'v1')
ON CONFLICT (id) DO NOTHING;
