-- Funded Eco-Quest accounting and merchant sponsorship. All balances and
-- movements remain off-chain prototype demo points; this does not touch the
-- separate Explorer Coin pilot or introduce real-money obligations.

ALTER TABLE merchants
  ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS merchants_funding_scope_idx ON merchants(is_test, status);
ALTER TABLE quests ADD COLUMN IF NOT EXISTS funding_required BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS points_accounts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('merchant','quest_budget','quest_hold','treasury','issuance')),
  merchant_id TEXT REFERENCES merchants(id) ON DELETE RESTRICT,
  plan_id TEXT,
  balance_points BIGINT NOT NULL DEFAULT 0,
  is_test BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (kind = 'issuance' OR balance_points >= 0),
  CHECK ((kind = 'merchant') = (merchant_id IS NOT NULL)),
  CHECK ((kind IN ('quest_budget','quest_hold')) = (plan_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS points_accounts_merchant_uq
  ON points_accounts(merchant_id) WHERE kind = 'merchant';
CREATE INDEX IF NOT EXISTS points_accounts_plan_idx ON points_accounts(plan_id) WHERE plan_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS merchant_point_credits (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
  source TEXT NOT NULL CHECK (source IN ('simulated_purchase','admin_grant','voucher_income','admin_correction')),
  points BIGINT NOT NULL CHECK (points <> 0),
  reference TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  ledger_group_id TEXT NOT NULL,
  reverses_credit_id TEXT REFERENCES merchant_point_credits(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (merchant_id, idempotency_key),
  CHECK ((source = 'admin_correction' AND points < 0 AND reverses_credit_id IS NOT NULL)
      OR (source <> 'admin_correction' AND points > 0 AND reverses_credit_id IS NULL))
);
CREATE INDEX IF NOT EXISTS merchant_point_credits_window_idx
  ON merchant_point_credits(merchant_id, source, created_at DESC);
CREATE INDEX IF NOT EXISTS merchant_point_credits_reverse_idx
  ON merchant_point_credits(reverses_credit_id) WHERE reverses_credit_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS quest_funding_plans (
  id TEXT PRIMARY KEY,
  quest_id TEXT NOT NULL REFERENCES quests(id) ON DELETE RESTRICT,
  quest_version INTEGER NOT NULL CHECK (quest_version > 0),
  round_number INTEGER NOT NULL CHECK (round_number > 0),
  mode TEXT NOT NULL CHECK (mode IN ('window','budget')),
  status TEXT NOT NULL CHECK (status IN ('draft','pending_sponsors','scheduled','active','closing','closed','expired','cancelled')),
  reward_points INTEGER NOT NULL CHECK (reward_points IN (50,75,100)),
  fee_bps INTEGER NOT NULL CHECK (fee_bps BETWEEN 0 AND 1000),
  fee_points INTEGER NOT NULL CHECK (fee_points >= 0),
  hold_ttl_hours INTEGER NOT NULL DEFAULT 48 CHECK (hold_ttl_hours BETWEEN 1 AND 168),
  sponsorship_deadline_days INTEGER NOT NULL DEFAULT 7 CHECK (sponsorship_deadline_days BETWEEN 1 AND 30),
  planned_completions INTEGER NOT NULL CHECK (planned_completions BETWEEN 1 AND 10000),
  target_points BIGINT NOT NULL CHECK (target_points > 0),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  sponsorship_deadline TIMESTAMPTZ,
  close_reason TEXT CHECK (close_reason IN ('window_ended','budget_exhausted','author_closed','admin_closed')),
  activated_at TIMESTAMPTZ,
  closing_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  is_test BOOLEAN NOT NULL DEFAULT FALSE,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (ends_at > starts_at),
  UNIQUE (quest_id, round_number)
);
CREATE UNIQUE INDEX IF NOT EXISTS quest_funding_one_open_plan
  ON quest_funding_plans(quest_id)
  WHERE status IN ('draft','pending_sponsors','scheduled','active','closing');
CREATE INDEX IF NOT EXISTS quest_funding_due_idx
  ON quest_funding_plans(status, starts_at, ends_at, sponsorship_deadline);
CREATE INDEX IF NOT EXISTS quest_funding_author_idx
  ON quest_funding_plans(created_by, updated_at DESC);

ALTER TABLE points_accounts
  ADD CONSTRAINT points_accounts_plan_fk
  FOREIGN KEY (plan_id) REFERENCES quest_funding_plans(id) ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS quest_funding_contributions (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES quest_funding_plans(id) ON DELETE RESTRICT,
  funder_kind TEXT NOT NULL CHECK (funder_kind IN ('author','merchant')),
  funder_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  merchant_id TEXT REFERENCES merchants(id) ON DELETE RESTRICT,
  sponsorship_id TEXT,
  is_test BOOLEAN NOT NULL DEFAULT FALSE,
  committed_points BIGINT NOT NULL CHECK (committed_points >= 0),
  remaining_points BIGINT NOT NULL CHECK (remaining_points >= 0),
  held_points BIGINT NOT NULL DEFAULT 0 CHECK (held_points >= 0),
  paid_reward_points BIGINT NOT NULL DEFAULT 0 CHECK (paid_reward_points >= 0),
  paid_fee_points BIGINT NOT NULL DEFAULT 0 CHECK (paid_fee_points >= 0),
  refunded_points BIGINT NOT NULL DEFAULT 0 CHECK (refunded_points >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (committed_points = remaining_points + held_points + paid_reward_points + paid_fee_points + refunded_points),
  CHECK ((funder_kind = 'author' AND funder_user_id IS NOT NULL AND merchant_id IS NULL)
      OR (funder_kind = 'merchant' AND merchant_id IS NOT NULL AND funder_user_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS quest_funding_one_author_contribution
  ON quest_funding_contributions(plan_id, funder_user_id) WHERE funder_kind = 'author';
CREATE UNIQUE INDEX IF NOT EXISTS quest_funding_one_merchant_contribution
  ON quest_funding_contributions(plan_id, merchant_id) WHERE funder_kind = 'merchant';
CREATE INDEX IF NOT EXISTS quest_funding_contributions_plan_idx
  ON quest_funding_contributions(plan_id, created_at, id);
CREATE INDEX IF NOT EXISTS quest_funding_contributions_merchant_idx
  ON quest_funding_contributions(merchant_id, created_at DESC) WHERE merchant_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS quest_funding_holds (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES quest_funding_plans(id) ON DELETE RESTRICT,
  attempt_id TEXT NOT NULL UNIQUE REFERENCES quest_attempts(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reward_points INTEGER NOT NULL CHECK (reward_points IN (50,75,100)),
  fee_points INTEGER NOT NULL CHECK (fee_points >= 0),
  status TEXT NOT NULL CHECK (status IN ('held','paid','released')),
  expires_at TIMESTAMPTZ NOT NULL,
  submission_id TEXT REFERENCES submissions(id) ON DELETE RESTRICT,
  settled_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  release_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS quest_funding_one_live_hold
  ON quest_funding_holds(plan_id, user_id) WHERE status = 'held';
CREATE INDEX IF NOT EXISTS quest_funding_hold_expiry
  ON quest_funding_holds(expires_at) WHERE status = 'held';
CREATE INDEX IF NOT EXISTS quest_funding_hold_user_idx
  ON quest_funding_holds(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS quest_funding_hold_allocations (
  hold_id TEXT NOT NULL REFERENCES quest_funding_holds(id) ON DELETE RESTRICT,
  contribution_id TEXT NOT NULL REFERENCES quest_funding_contributions(id) ON DELETE RESTRICT,
  reward_part INTEGER NOT NULL CHECK (reward_part >= 0),
  fee_part INTEGER NOT NULL CHECK (fee_part >= 0),
  PRIMARY KEY (hold_id, contribution_id)
);
CREATE INDEX IF NOT EXISTS quest_funding_allocation_contribution_idx
  ON quest_funding_hold_allocations(contribution_id);

CREATE TABLE IF NOT EXISTS quest_sponsorships (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES quest_funding_plans(id) ON DELETE RESTRICT,
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
  requested_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('requested','countered','accepted','declined','withdrawn','expired')),
  points BIGINT NOT NULL DEFAULT 0 CHECK (points >= 0),
  voucher_id TEXT REFERENCES vouchers(id) ON DELETE RESTRICT,
  voucher_qty INTEGER NOT NULL DEFAULT 0 CHECK (voucher_qty >= 0),
  promo BOOLEAN NOT NULL DEFAULT FALSE,
  message TEXT CHECK (char_length(message) <= 500),
  counter_points BIGINT CHECK (counter_points IS NULL OR counter_points >= 0),
  counter_voucher_qty INTEGER CHECK (counter_voucher_qty IS NULL OR counter_voucher_qty >= 0),
  counter_promo BOOLEAN,
  counter_message TEXT CHECK (counter_message IS NULL OR char_length(counter_message) <= 500),
  responded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  responded_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  terms_version INTEGER NOT NULL DEFAULT 1 CHECK (terms_version > 0),
  is_test BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (points > 0 OR voucher_qty > 0 OR promo),
  CHECK ((voucher_id IS NULL) = (voucher_qty = 0))
);
CREATE UNIQUE INDEX IF NOT EXISTS quest_sponsorship_one_open_per_merchant
  ON quest_sponsorships(plan_id, merchant_id)
  WHERE status IN ('requested','countered','accepted');
CREATE INDEX IF NOT EXISTS quest_sponsorship_merchant_inbox_idx
  ON quest_sponsorships(merchant_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS quest_sponsorship_plan_idx
  ON quest_sponsorships(plan_id, status, created_at);

ALTER TABLE quest_funding_contributions
  ADD CONSTRAINT quest_funding_contribution_sponsorship_fk
  FOREIGN KEY (sponsorship_id) REFERENCES quest_sponsorships(id) ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS quest_voucher_perks (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES quest_funding_plans(id) ON DELETE RESTRICT,
  sponsorship_id TEXT NOT NULL UNIQUE REFERENCES quest_sponsorships(id) ON DELETE RESTRICT,
  voucher_id TEXT NOT NULL REFERENCES vouchers(id) ON DELETE RESTRICT,
  total_qty INTEGER NOT NULL CHECK (total_qty > 0),
  granted_qty INTEGER NOT NULL DEFAULT 0 CHECK (granted_qty >= 0 AND granted_qty <= total_qty)
);
CREATE INDEX IF NOT EXISTS quest_voucher_perks_plan_idx ON quest_voucher_perks(plan_id);

ALTER TABLE redemptions
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'purchase'
    CHECK (source IN ('purchase','quest_sponsor_perk')),
  ADD COLUMN IF NOT EXISTS hold_id TEXT REFERENCES quest_funding_holds(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX IF NOT EXISTS redemptions_one_perk_per_hold
  ON redemptions(hold_id, voucher_id) WHERE source = 'quest_sponsor_perk';
CREATE INDEX IF NOT EXISTS redemptions_hold_idx ON redemptions(hold_id) WHERE hold_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS quest_funding_commands (
  actor_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (actor_id, operation, idempotency_key)
);
CREATE INDEX IF NOT EXISTS quest_funding_commands_created_idx ON quest_funding_commands(created_at);

INSERT INTO points_accounts(id, kind)
VALUES ('treasury','treasury'), ('merchant_issuance','issuance')
ON CONFLICT (id) DO NOTHING;
INSERT INTO points_accounts(id, kind, is_test)
VALUES ('treasury:test','treasury',TRUE), ('merchant_issuance:test','issuance',TRUE)
ON CONFLICT (id) DO NOTHING;
