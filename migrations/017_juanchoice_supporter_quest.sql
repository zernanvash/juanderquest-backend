-- A finalized JuanChoice winner may expose one time-bounded physical visit
-- quest only when an administrator has created an active reviewed quest/spot
-- binding. Ballot choice is intentionally absent: every traveler is eligible.
CREATE TABLE IF NOT EXISTS juanchoice_supporter_quest_claims (
  id UUID PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES juanchoice_campaigns(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  spot_id TEXT NOT NULL REFERENCES spots(id) ON DELETE RESTRICT,
  quest_id TEXT NOT NULL REFERENCES quests(id) ON DELETE RESTRICT,
  binding_id UUID NOT NULL REFERENCES reviewed_quest_spot_bindings(id) ON DELETE RESTRICT,
  verified_visit_id UUID NOT NULL REFERENCES verified_visits(id) ON DELETE RESTRICT,
  progression_event_id UUID NOT NULL REFERENCES progression_events(id) ON DELETE RESTRICT,
  explorer_xp INTEGER NOT NULL DEFAULT 300 CHECK (explorer_xp = 300),
  rule_version TEXT NOT NULL DEFAULT 'juanchoice-supporter-v1',
  is_test BOOLEAN NOT NULL DEFAULT FALSE,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_id, user_id),
  UNIQUE (campaign_id, verified_visit_id)
);
CREATE INDEX IF NOT EXISTS idx_juanchoice_supporter_claims_user
  ON juanchoice_supporter_quest_claims(user_id, claimed_at DESC);
