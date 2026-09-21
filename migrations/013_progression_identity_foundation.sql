-- Migration 013: Progression and Identity Foundation
-- Implements trusted verified visits, append-only progression events, rebuildable totals,
-- curated collections, achievement definitions/awards, and transactional outbox events.

-- 0. Add scout_reputation column to users if not present (defaults to 0 for unverified accounts)
ALTER TABLE users ADD COLUMN IF NOT EXISTS scout_reputation INT NOT NULL DEFAULT 0 CHECK (scout_reputation >= 0);

-- 1. Canonical Municipalities Registry (48 LGUs: 4 cities + 44 municipalities)
CREATE TABLE IF NOT EXISTS municipalities (
  id VARCHAR(50) PRIMARY KEY,
  name VARCHAR(100) UNIQUE NOT NULL,
  province VARCHAR(50) NOT NULL DEFAULT 'Pangasinan',
  type VARCHAR(20) NOT NULL CHECK (type IN ('city', 'municipality')),
  district INT NOT NULL DEFAULT 1 CHECK (district BETWEEN 1 AND 6),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Reviewed Quest-to-Spot Bindings
-- Resolves the 1:many / 0:many quest-to-spot seam. Unmapped/ambiguous quests do NOT silently convert to visits.
-- Allows multiple historical deprecated bindings, but strictly ONE active binding per quest.
CREATE TABLE IF NOT EXISTS reviewed_quest_spot_bindings (
  id UUID PRIMARY KEY,
  quest_id TEXT NOT NULL REFERENCES quests(id) ON DELETE CASCADE,
  spot_id TEXT NOT NULL REFERENCES spots(id) ON DELETE RESTRICT,
  binding_version VARCHAR(50) NOT NULL DEFAULT 'v1',
  status VARCHAR(30) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deprecated', 'ambiguous')),
  reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  notes TEXT,
  is_test BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_active_quest_binding ON reviewed_quest_spot_bindings (quest_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_bindings_quest ON reviewed_quest_spot_bindings(quest_id);
CREATE INDEX IF NOT EXISTS idx_bindings_spot ON reviewed_quest_spot_bindings(spot_id);

-- 3. Verified Visits
-- Records verified destination presence proven by reviewed submission. Raw GPS coordinates remain restricted in submissions table.
CREATE TABLE IF NOT EXISTS verified_visits (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  spot_id TEXT NOT NULL REFERENCES spots(id) ON DELETE RESTRICT,
  binding_id UUID REFERENCES reviewed_quest_spot_bindings(id),
  municipality_id VARCHAR(50) REFERENCES municipalities(id),
  source_submission_id TEXT UNIQUE NOT NULL REFERENCES submissions(id) ON DELETE RESTRICT,
  occurred_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  evidence_version VARCHAR(50) NOT NULL DEFAULT 'v1',
  is_test BOOLEAN NOT NULL DEFAULT FALSE,
  revoked_at TIMESTAMPTZ,
  revocation_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE verified_visits ADD COLUMN IF NOT EXISTS binding_id UUID REFERENCES reviewed_quest_spot_bindings(id);
CREATE INDEX IF NOT EXISTS idx_verified_visits_user ON verified_visits(user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_verified_visits_spot ON verified_visits(spot_id);
CREATE INDEX IF NOT EXISTS idx_verified_visits_is_test ON verified_visits(is_test);

-- 4. Progression Events
-- Append-only ledger of reputational progression deltas across Explorer, Civic, and Scout tracks.
-- Logical proof award uniqueness is independent of rule_version to prevent duplicate grants on version bumps.
CREATE TABLE IF NOT EXISTS progression_events (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  track VARCHAR(30) NOT NULL CHECK (track IN ('explorer', 'civic', 'scout')),
  delta BIGINT NOT NULL,
  source_type VARCHAR(50) NOT NULL,
  source_id TEXT NOT NULL,
  award_kind VARCHAR(50) NOT NULL DEFAULT 'xp',
  rule_version VARCHAR(50) NOT NULL,
  earned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_test BOOLEAN NOT NULL DEFAULT FALSE,
  reversal_of UUID REFERENCES progression_events(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_progression_events_source UNIQUE (user_id, source_type, source_id, award_kind)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_progression_events_reversal_unique ON progression_events (reversal_of) WHERE reversal_of IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_progression_events_user ON progression_events(user_id, earned_at DESC);
CREATE INDEX IF NOT EXISTS idx_progression_events_track ON progression_events(track);

-- 5. Progression Totals
-- Rebuildable materialized projection of traveler reputation scores bounded by JavaScript safe integer limits.
CREATE TABLE IF NOT EXISTS progression_totals (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  explorer_xp BIGINT NOT NULL DEFAULT 0 CHECK (explorer_xp BETWEEN 0 AND 9007199254740991),
  civic_xp BIGINT NOT NULL DEFAULT 0 CHECK (civic_xp BETWEEN 0 AND 9007199254740991),
  civic_stamps INT NOT NULL DEFAULT 0 CHECK (civic_stamps BETWEEN 0 AND 9007199254740991),
  last_event_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. Achievement Definitions
CREATE TABLE IF NOT EXISTS achievement_definitions (
  id VARCHAR(100) PRIMARY KEY,
  track VARCHAR(30) NOT NULL CHECK (track IN ('explorer', 'civic', 'scout')),
  title VARCHAR(200) NOT NULL,
  description TEXT NOT NULL,
  badge_icon TEXT NOT NULL,
  category VARCHAR(50) NOT NULL DEFAULT 'milestone',
  threshold INT NOT NULL DEFAULT 1,
  criteria_version VARCHAR(50) NOT NULL DEFAULT 'v1',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 7. Achievement Awards
-- Durable awards earned by travelers. Persists immutable criteria snapshot to prevent definition mutations from altering historical awards.
CREATE TABLE IF NOT EXISTS achievement_awards (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  achievement_id VARCHAR(100) NOT NULL REFERENCES achievement_definitions(id) ON DELETE RESTRICT,
  season VARCHAR(50) NOT NULL DEFAULT 'all_time',
  source_evidence_id TEXT,
  evidence_version VARCHAR(50) NOT NULL DEFAULT 'v1',
  criteria_version VARCHAR(50) NOT NULL DEFAULT 'v1',
  criteria_snapshot JSONB NOT NULL DEFAULT '{}',
  awarded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  revocation_reason TEXT,
  is_test BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_achievement_awards_user_season UNIQUE (user_id, achievement_id, season)
);
ALTER TABLE achievement_awards ADD COLUMN IF NOT EXISTS evidence_version VARCHAR(50) NOT NULL DEFAULT 'v1';
ALTER TABLE achievement_awards ADD COLUMN IF NOT EXISTS criteria_version VARCHAR(50) NOT NULL DEFAULT 'v1';
ALTER TABLE achievement_awards ADD COLUMN IF NOT EXISTS criteria_snapshot JSONB NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_achievement_awards_user ON achievement_awards(user_id, awarded_at DESC);

-- 8. Curated Collections & Trails
CREATE TABLE IF NOT EXISTS curated_collections (
  id VARCHAR(100) PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  description TEXT NOT NULL,
  category VARCHAR(50) NOT NULL,
  badge_id VARCHAR(100) REFERENCES achievement_definitions(id),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS curated_collection_spots (
  collection_id VARCHAR(100) NOT NULL REFERENCES curated_collections(id) ON DELETE CASCADE,
  spot_id TEXT NOT NULL REFERENCES spots(id) ON DELETE CASCADE,
  order_index INT NOT NULL DEFAULT 0,
  PRIMARY KEY (collection_id, spot_id)
);

-- 9. Transactional Outbox Events
-- Durable async messaging pattern. Events are created inside the source business transaction.
CREATE TABLE IF NOT EXISTS outbox_events (
  id UUID PRIMARY KEY,
  event_key VARCHAR(200) UNIQUE NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  payload JSONB NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'dead_letter')),
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  lease_owner VARCHAR(255),
  claim_token UUID,
  lease_expires_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS claim_token UUID;
CREATE INDEX IF NOT EXISTS idx_outbox_status_next ON outbox_events(status, next_attempt_at);

-- 10. Canonical Pangasinan LGUs Seed Data (48 LGUs: 4 cities + 44 municipalities)
INSERT INTO municipalities (id, name, type, district) VALUES
-- Cities
('alaminos_city', 'Alaminos City', 'city', 1),
('dagupan_city', 'Dagupan City', 'city', 4),
('san_carlos_city', 'San Carlos City', 'city', 3),
('urdaneta_city', 'Urdaneta City', 'city', 5),
-- District 1
('agno', 'Agno', 'municipality', 1),
('anda', 'Anda', 'municipality', 1),
('bani', 'Bani', 'municipality', 1),
('bolinao', 'Bolinao', 'municipality', 1),
('burgos', 'Burgos', 'municipality', 1),
('dasol', 'Dasol', 'municipality', 1),
('infanta', 'Infanta', 'municipality', 1),
('mabini', 'Mabini', 'municipality', 1),
('sual', 'Sual', 'municipality', 1),
-- District 2
('aguilar', 'Aguilar', 'municipality', 2),
('basista', 'Basista', 'municipality', 2),
('binmaley', 'Binmaley', 'municipality', 2),
('bugallon', 'Bugallon', 'municipality', 2),
('labrador', 'Labrador', 'municipality', 2),
('lingayen', 'Lingayen', 'municipality', 2),
('mangatarem', 'Mangatarem', 'municipality', 2),
('urbiztondo', 'Urbiztondo', 'municipality', 2),
-- District 3
('bayambang', 'Bayambang', 'municipality', 3),
('calasiao', 'Calasiao', 'municipality', 3),
('malasiqui', 'Malasiqui', 'municipality', 3),
('mapandan', 'Mapandan', 'municipality', 3),
('santa_barbara', 'Santa Barbara', 'municipality', 3),
-- District 4
('manaoag', 'Manaoag', 'municipality', 4),
('mangaldan', 'Mangaldan', 'municipality', 4),
('san_fabian', 'San Fabian', 'municipality', 4),
('san_jacinto', 'San Jacinto', 'municipality', 4),
-- District 5
('alcala', 'Alcala', 'municipality', 5),
('bautista', 'Bautista', 'municipality', 5),
('binalonan', 'Binalonan', 'municipality', 5),
('laoac', 'Laoac', 'municipality', 5),
('pozorrubio', 'Pozorrubio', 'municipality', 5),
('santo_tomas', 'Santo Tomas', 'municipality', 5),
('sison', 'Sison', 'municipality', 5),
('villasis', 'Villasis', 'municipality', 5),
-- District 6
('asingan', 'Asingan', 'municipality', 6),
('balungao', 'Balungao', 'municipality', 6),
('natividad', 'Natividad', 'municipality', 6),
('rosales', 'Rosales', 'municipality', 6),
('san_manuel', 'San Manuel', 'municipality', 6),
('san_nicolas', 'San Nicolas', 'municipality', 6),
('san_quintin', 'San Quintin', 'municipality', 6),
('santa_maria', 'Santa Maria', 'municipality', 6),
('tayug', 'Tayug', 'municipality', 6),
('umingan', 'Umingan', 'municipality', 6)
ON CONFLICT (id) DO NOTHING;

-- 11. Initial Core Achievements
INSERT INTO achievement_definitions (id, track, title, description, badge_icon, category, threshold, criteria_version) VALUES
('first_footstep', 'explorer', 'First Footstep', 'Verified your first physical destination visit in Pangasinan.', 'compass', 'milestone', 1, 'v1'),
('pangasinan_pioneer', 'explorer', 'Pangasinan Pioneer', 'Explored 5 unique destinations across Pangasinan.', 'map_pin', 'milestone', 5, 'v1'),
('coastal_conqueror', 'explorer', 'Coastal Conqueror', 'Completed the Coastal Wonders Trail.', 'waves', 'trail', 3, 'v1'),
('heritage_seeker', 'explorer', 'Heritage Seeker', 'Completed the Pangasinan Heritage Trail.', 'landmark', 'trail', 3, 'v1'),
('civic_first_voice', 'civic', 'First Voice', 'Participated in your first community voting round.', 'ballot_box', 'civic', 1, 'v1'),
('civic_faithful_voter', 'civic', 'Faithful Voter', 'Participated in 3 community voting rounds.', 'how_to_vote', 'civic', 3, 'v1')
ON CONFLICT (id) DO NOTHING;

-- 12. Initial Curated Collections
INSERT INTO curated_collections (id, title, description, category, badge_id) VALUES
('coastal_wonders_trail', 'Coastal Wonders Trail', 'Experience the scenic coasts of Western Pangasinan from Alaminos to Bolinao and Dasol.', 'trail', 'coastal_conqueror'),
('pangasinan_heritage_trail', 'Pangasinan Heritage Trail', 'Explore the sacred pilgrimage, colonial history, and provincial legacy.', 'trail', 'heritage_seeker')
ON CONFLICT (id) DO NOTHING;
