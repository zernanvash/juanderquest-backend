-- Free promotional voting. No financial columns or governance-store dependency.
CREATE TABLE IF NOT EXISTS juanchoice_campaigns (
  id UUID PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  region TEXT NOT NULL,
  theme TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','voting','closed','finalized','archived','cancelled')),
  opens_at TIMESTAMPTZ NOT NULL,
  closes_at TIMESTAMPTZ NOT NULL,
  is_test BOOLEAN NOT NULL DEFAULT FALSE,
  policy_version TEXT NOT NULL DEFAULT 'juanchoice-pilot-v1',
  finalized_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (closes_at > opens_at)
);
CREATE INDEX IF NOT EXISTS idx_juanchoice_campaigns_region_window ON juanchoice_campaigns(region, opens_at DESC) WHERE status <> 'draft';

-- A stable lock row serializes publication of overlapping primary regional rounds.
CREATE TABLE IF NOT EXISTS juanchoice_region_locks (
  region TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS juanchoice_candidates (
  id UUID PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES juanchoice_campaigns(id) ON DELETE RESTRICT,
  spot_id TEXT NOT NULL REFERENCES spots(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'eligible' CHECK (status IN ('eligible','suspended')),
  is_test BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_id,id),
  UNIQUE (campaign_id,spot_id)
);
CREATE INDEX IF NOT EXISTS idx_juanchoice_candidates_campaign ON juanchoice_candidates(campaign_id,status);

CREATE TABLE IF NOT EXISTS juanchoice_ballots (
  campaign_id UUID NOT NULL REFERENCES juanchoice_campaigns(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  candidate_id UUID NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  is_test BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (campaign_id,user_id),
  FOREIGN KEY (campaign_id,candidate_id) REFERENCES juanchoice_candidates(campaign_id,id)
);
CREATE INDEX IF NOT EXISTS idx_juanchoice_ballots_candidate ON juanchoice_ballots(campaign_id,candidate_id);

CREATE TABLE IF NOT EXISTS juanchoice_participations (
  campaign_id UUID NOT NULL REFERENCES juanchoice_campaigns(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  civic_xp INTEGER NOT NULL DEFAULT 25 CHECK (civic_xp = 25),
  stamps INTEGER NOT NULL DEFAULT 1 CHECK (stamps = 1),
  is_test BOOLEAN NOT NULL DEFAULT FALSE,
  rewarded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (campaign_id,user_id)
);

CREATE TABLE IF NOT EXISTS juanchoice_receipts (
  campaign_id UUID NOT NULL REFERENCES juanchoice_campaigns(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key UUID NOT NULL,
  request_hash TEXT NOT NULL,
  response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (campaign_id,user_id,idempotency_key)
);

CREATE TABLE IF NOT EXISTS juanchoice_ballot_events (
  id UUID PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES juanchoice_campaigns(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  previous_candidate_id UUID,
  candidate_id UUID NOT NULL,
  version INTEGER NOT NULL,
  idempotency_key UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS juanchoice_results (
  campaign_id UUID PRIMARY KEY REFERENCES juanchoice_campaigns(id) ON DELETE RESTRICT,
  standings JSONB NOT NULL,
  co_winner_ids JSONB NOT NULL,
  valid_ballots INTEGER NOT NULL CHECK (valid_ballots >= 0),
  policy_version TEXT NOT NULL,
  finalized_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS juanchoice_campaign_audit (
  id UUID PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES juanchoice_campaigns(id) ON DELETE RESTRICT,
  actor_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  action TEXT NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
