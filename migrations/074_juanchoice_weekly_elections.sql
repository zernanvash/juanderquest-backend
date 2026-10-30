-- Plan 65: JuanChoice weekly mayor-style elections (additive).
-- Weekly cadence beside the monthly one, manifesto perks with progressive slots,
-- a #2 Minister, quadratic ballot weight (points), a Sunday blind tally, per-spot
-- election state and a festival calendar. Monthly rounds keep working unchanged.

-- 1. Schedules: allow a weekly cadence (period starts on a Monday) beside monthly.
ALTER TABLE juanchoice_schedules DROP CONSTRAINT IF EXISTS juanchoice_schedules_cadence_check;
ALTER TABLE juanchoice_schedules ADD CONSTRAINT juanchoice_schedules_cadence_check CHECK (cadence IN ('monthly','weekly'));
ALTER TABLE juanchoice_schedules DROP CONSTRAINT IF EXISTS juanchoice_schedules_effective_period_check;
ALTER TABLE juanchoice_schedules ADD CONSTRAINT juanchoice_schedules_effective_period_check CHECK (
  (cadence = 'monthly' AND EXTRACT(DAY FROM effective_period) = 1)
  OR (cadence = 'weekly' AND EXTRACT(ISODOW FROM effective_period) = 1));
ALTER TABLE juanchoice_schedules ADD COLUMN IF NOT EXISTS winner_cooldown_weeks SMALLINT NOT NULL DEFAULT 4
  CHECK (winner_cooldown_weeks BETWEEN 1 AND 52);
ALTER TABLE juanchoice_schedules ADD COLUMN IF NOT EXISTS minister_cooldown_weeks SMALLINT NOT NULL DEFAULT 2
  CHECK (minister_cooldown_weeks BETWEEN 0 AND 52);
ALTER TABLE juanchoice_schedules ADD COLUMN IF NOT EXISTS special_round_interval_weeks SMALLINT NOT NULL DEFAULT 4
  CHECK (special_round_interval_weeks BETWEEN 2 AND 52);

ALTER TABLE juanchoice_schedule_periods DROP CONSTRAINT IF EXISTS juanchoice_schedule_periods_period_start_check;
ALTER TABLE juanchoice_schedule_periods ADD CONSTRAINT juanchoice_schedule_periods_period_start_check CHECK (
  EXTRACT(DAY FROM period_start) = 1 OR EXTRACT(ISODOW FROM period_start) = 1);

-- 2. Campaigns: round tier, festival and the final-hours blind tally (0 = never hidden;
-- weekly rounds set 24, existing monthly rounds keep their visible tally).
ALTER TABLE juanchoice_campaigns ADD COLUMN IF NOT EXISTS round_tier TEXT NOT NULL DEFAULT 'standard'
  CHECK (round_tier IN ('standard','special_festival'));
ALTER TABLE juanchoice_campaigns ADD COLUMN IF NOT EXISTS festival_name TEXT
  CHECK (festival_name IS NULL OR char_length(festival_name) BETWEEN 2 AND 160);
ALTER TABLE juanchoice_campaigns ADD COLUMN IF NOT EXISTS blind_tally_hours SMALLINT NOT NULL DEFAULT 0
  CHECK (blind_tally_hours BETWEEN 0 AND 168);

-- 3. Candidates: the platform manifesto and progressive perk slots.
ALTER TABLE juanchoice_candidates ADD COLUMN IF NOT EXISTS manifesto_perks JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE juanchoice_candidates ADD COLUMN IF NOT EXISTS prior_loss_streak SMALLINT NOT NULL DEFAULT 0
  CHECK (prior_loss_streak BETWEEN 0 AND 10);
ALTER TABLE juanchoice_candidates ADD COLUMN IF NOT EXISTS unlocked_perk_count SMALLINT NOT NULL DEFAULT 2
  CHECK (unlocked_perk_count BETWEEN 1 AND 4);

-- 4. Per-spot election state: cooldowns and progressive perks across rounds.
CREATE TABLE IF NOT EXISTS juanchoice_spot_election_state (
  spot_id TEXT NOT NULL REFERENCES spots(id) ON DELETE CASCADE,
  is_test BOOLEAN NOT NULL DEFAULT FALSE,
  consecutive_losses SMALLINT NOT NULL DEFAULT 0 CHECK (consecutive_losses BETWEEN 0 AND 10),
  last_nominated_at TIMESTAMPTZ,
  last_won_at TIMESTAMPTZ,
  last_minister_at TIMESTAMPTZ,
  total_wins INTEGER NOT NULL DEFAULT 0 CHECK (total_wins >= 0),
  total_minister_terms INTEGER NOT NULL DEFAULT 0 CHECK (total_minister_terms >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (spot_id, is_test)
);

-- 5. Quadratic ballot weight (1..5), bought with points (Plan 65 §9.2).
ALTER TABLE juanchoice_ballots ADD COLUMN IF NOT EXISTS vote_weight SMALLINT NOT NULL DEFAULT 1
  CHECK (vote_weight BETWEEN 1 AND 5);
ALTER TABLE juanchoice_ballots ADD COLUMN IF NOT EXISTS boost_spent_points INTEGER NOT NULL DEFAULT 0
  CHECK (boost_spent_points >= 0);
ALTER TABLE juanchoice_ballot_events ADD COLUMN IF NOT EXISTS previous_weight SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE juanchoice_ballot_events ADD COLUMN IF NOT EXISTS new_weight SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE juanchoice_ballot_events ADD COLUMN IF NOT EXISTS points_delta INTEGER NOT NULL DEFAULT 0;

-- 6. Results: Minister, the reign's active perks and the boost sink totals.
ALTER TABLE juanchoice_results ADD COLUMN IF NOT EXISTS minister_candidate_id UUID;
ALTER TABLE juanchoice_results ADD COLUMN IF NOT EXISTS active_perks JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE juanchoice_results ADD COLUMN IF NOT EXISTS total_weighted_votes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE juanchoice_results ADD COLUMN IF NOT EXISTS total_boost_points INTEGER NOT NULL DEFAULT 0;

-- 7. Festival calendar (seeded empty: dates come from the owner/LGU, never guesses).
CREATE TABLE IF NOT EXISTS juanchoice_festivals (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 2 AND 160),
  municipality TEXT,
  starts_on DATE NOT NULL,
  ends_on DATE NOT NULL,
  boost_multiplier NUMERIC(4,2) NOT NULL DEFAULT 1.5 CHECK (boost_multiplier >= 1 AND boost_multiplier <= 3),
  is_test BOOLEAN NOT NULL DEFAULT FALSE,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (ends_on >= starts_on)
);
CREATE INDEX IF NOT EXISTS idx_juanchoice_festivals_dates ON juanchoice_festivals (is_test, starts_on, ends_on);

-- 8. The weekly cadence replaces monthly preparation. Keep monthly rows as history.
UPDATE juanchoice_schedules SET enabled = FALSE, updated_at = NOW() WHERE cadence = 'monthly' AND enabled = TRUE;
